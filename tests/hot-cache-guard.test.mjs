/**
 * Tests for the deterministic hot-cache freshness guard:
 *   - src/helpers/hot-staleness.mjs  (pure logic — the bulk of coverage)
 *   - hooks/hot-cache-update-prompt.mjs  (end-to-end via spawnSync)
 *
 * The pure layer is tested directly (fast, no fs). The hook is smoke-tested
 * as a subprocess feeding a synthetic transcript JSONL + a temp router
 * config via OBSIDIAN_ROUTER_CONFIG, mirroring tests/vault-link-linter.test.mjs.
 *
 * Tool-input schemas used below match the REAL MCP inputSchemas in
 * src/index.mjs (verified): move_file `{from,to}`, execute_template
 * `{name,createFile,targetPath}`, delete_file `{path,confirm}`,
 * set_frontmatter `{path,key,value}`, merge_frontmatter `{path,values}`,
 * write_file/patch_file/append_to_file `{path,vault}`.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  isTrackedWriteTool,
  isBuiltinWriteTool,
  extractWriteToolUses,
  extractToolResultOutcomes,
  targetsFromToolUse,
  pathKind,
  findStaleVaults,
} from '../src/helpers/hot-staleness.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HOOK_PATH = path.resolve(__dirname, '..', 'hooks', 'hot-cache-update-prompt.mjs');

// ---------------------------------------------------------------------------
// Helpers for building synthetic transcripts
// ---------------------------------------------------------------------------

// Ids are UNIQUE per call. A real transcript pairs a `tool_result` to its
// `tool_use` by id; the fixtures used to stamp every block with the literal
// `'x'`, which cannot express "this call failed and that one did not" and would
// have let one result speak for the whole file.
let toolUseSeq = 0;
function nextToolUseId() {
  toolUseSeq += 1;
  return `toolu_fixture_${toolUseSeq}`;
}

/**
 * A `tool_use` block AND the `tool_result` that answers it — the shape a real
 * transcript has, keys copied from a measured one: the request is a chunk of an
 * `assistant` entry (`{type,id,name,input}`), the answer a chunk of a `user`
 * entry (`{tool_use_id,type,content,is_error}`).
 *
 * The default is a SUCCESS, because that is what "the session wrote this note"
 * has always meant in these tests. `{ isError: true }` makes the call fail;
 * `{ result: 'none' }` emits the request alone, the in-flight/truncated case.
 * Returns the two lines already joined, so every `jsonl(...)`/`run([...])` call
 * site keeps working unchanged.
 */
function toolUseLine(name, input, { isError = false, result = 'present' } = {}) {
  const id = nextToolUseId();
  const use = JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  });
  if (result === 'none') return use;
  return use + '\n' + toolResultLine(id, { isError });
}

/** The answering half on its own — for pairing a result to an id built by hand. */
function toolResultLine(toolUseId, { isError = false, content = 'ok' } = {}) {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ tool_use_id: toolUseId, type: 'tool_result', content, is_error: isError }],
    },
  });
}

/** A tracked write the vault REFUSED (409, offline vault, denied path). */
function failedToolUseLine(name, input) {
  return toolUseLine(name, input, { isError: true });
}

/** A tracked write whose result never reached the transcript (in flight / truncated). */
function unansweredToolUseLine(name, input) {
  return toolUseLine(name, input, { result: 'none' });
}

function textLine(text) {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
}
function jsonl(...lines) {
  return lines.join('\n') + '\n';
}

const CTX = {
  vaultRoots: ['/vaults/A', '/vaults/B'],
  slugToRoot: (s) => ({ a: '/vaults/A', b: '/vaults/B' })[String(s).toLowerCase()] || null,
  defaultRoot: '/vaults/A',
  isWin: false,
};

// ---------------------------------------------------------------------------
// isTrackedWriteTool / isBuiltinWriteTool
// ---------------------------------------------------------------------------

describe('isTrackedWriteTool', () => {
  test('built-in write tools', () => {
    for (const n of ['Write', 'Edit', 'MultiEdit']) assert.equal(isTrackedWriteTool(n), true, n);
    assert.equal(isBuiltinWriteTool('Edit'), true);
  });
  test('tracked local MCP tools (note-body writers + execute_template)', () => {
    for (const v of ['write_file', 'patch_file', 'append_to_file', 'execute_template']) {
      assert.equal(isTrackedWriteTool('mcp__obsidian-router__' + v), true, v);
    }
  });
  test('MCPHub-namespaced tracked tools (hyphen before verb)', () => {
    assert.equal(isTrackedWriteTool('mcp__5f30__obsidian-router-Tribu-write_file'), true);
  });
  test('NON-tracked writes (move/delete/frontmatter) are excluded by design', () => {
    for (const v of ['move_file', 'delete_file', 'set_frontmatter', 'merge_frontmatter']) {
      assert.equal(isTrackedWriteTool('mcp__obsidian-router__' + v), false, v);
    }
  });
  test('read/search tools are rejected', () => {
    for (const n of ['Read', 'Bash', 'Grep', 'mcp__obsidian-router__search', 'mcp__obsidian-router__get_file']) {
      assert.equal(isTrackedWriteTool(n), false, n);
    }
  });
  test('garbage input', () => {
    assert.equal(isTrackedWriteTool(null), false);
    assert.equal(isTrackedWriteTool(''), false);
    assert.equal(isTrackedWriteTool(42), false);
  });
});

// ---------------------------------------------------------------------------
// pathKind
// ---------------------------------------------------------------------------

describe('pathKind', () => {
  test('content / hot / other', () => {
    assert.equal(pathKind('wiki/a/b.md'), 'content');
    assert.equal(pathKind('wiki-meta/hot.md'), 'hot');
    assert.equal(pathKind('wiki-meta/index.md'), 'other');
    assert.equal(pathKind('wiki-meta/log.md'), 'other');
    assert.equal(pathKind('README.md'), 'other');
    assert.equal(pathKind(''), 'other');
  });
  test('normalizes backslashes and leading ./ or /', () => {
    assert.equal(pathKind('wiki\\a\\b.md'), 'content');
    assert.equal(pathKind('./wiki/a.md'), 'content');
    assert.equal(pathKind('/wiki-meta/hot.md'), 'hot');
  });
});

// ---------------------------------------------------------------------------
// targetsFromToolUse
// ---------------------------------------------------------------------------

describe('targetsFromToolUse', () => {
  test('built-in carries absolute file_path', () => {
    const t = targetsFromToolUse({ toolName: 'Edit', input: { file_path: 'C:/x/y.md' } });
    assert.deepEqual(t.absolutePaths, ['C:/x/y.md']);
    assert.deepEqual(t.relPaths, []);
  });
  test('write_file carries relative path + vault slug', () => {
    const t = targetsFromToolUse({ toolName: 'mcp__obsidian-router__write_file', input: { path: 'wiki/a.md', vault: 'smile' } });
    assert.deepEqual(t.relPaths, ['wiki/a.md']);
    assert.equal(t.vaultSlug, 'smile');
  });
  test('execute_template with createFile:true counts targetPath (not name)', () => {
    const t = targetsFromToolUse({
      toolName: 'mcp__obsidian-router__execute_template',
      input: { name: 'Templates/Daily.md', createFile: true, targetPath: 'wiki/journal/2026.md', vault: 'a' },
    });
    assert.deepEqual(t.relPaths, ['wiki/journal/2026.md']);
    assert.equal(t.vaultSlug, 'a');
  });
  test('execute_template with createFile:false writes nothing → no paths', () => {
    const t = targetsFromToolUse({
      toolName: 'mcp__obsidian-router__execute_template',
      input: { name: 'wiki/Templates/T.md', createFile: false },
    });
    assert.deepEqual(t.relPaths, []);
  });

  // THE FIXTURE ABOVE COULD NOT SEE THE BUG IT IS NAMED FOR. It passes no
  // `targetPath`, so it returns `[]` for ANY gate — verified by mutation:
  // replacing the shared `writeTargets` call with an inline
  // `inp.createFile !== undefined` (i.e. the wrong gate, the class of copy this
  // module had) left the whole file green. The gate has to be `=== true`, which
  // is what the handler and the bridge both use (`body.createFile === true`);
  // anything looser and the freshness guard disagrees with the code that does
  // the writing. These are the shapes that discriminate.
  test('execute_template: the gate is `=== true`, not "createFile was mentioned"', () => {
    const rel = (createFile) => targetsFromToolUse({
      toolName: 'mcp__obsidian-router__execute_template',
      input: { name: 'Templates/T.md', targetPath: 'wiki/never-written.md', ...(createFile === undefined ? {} : { createFile }) },
    }).relPaths;
    assert.deepEqual(rel(true), ['wiki/never-written.md']);
    for (const loose of [false, 'true', 'false', 1, 0, undefined, null, {}]) {
      assert.deepEqual(rel(loose), [],
        `createFile: ${JSON.stringify(loose)} is not the handler's gate, so nothing is written`);
    }
  });

  // THE COPY THAT NOBODY RE-READ. This module carried its own inline spelling of
  // the `createFile === true` gate — the very rule `src/helpers/write-targets.mjs`
  // was extracted to own — and had never heard of `write_bundle`. So a bundle
  // writing twelve notes under `wiki/` produced ZERO targets and the freshness
  // guard saw an idle session: the turn ended with `hot.md` describing a vault
  // state that no longer existed, for exactly the tool that writes the most
  // files at once.
  test('write_bundle enumerates its content steps (the copy that ignored it)', () => {
    const t = targetsFromToolUse({
      toolName: 'mcp__obsidian-router__write_bundle',
      input: {
        vault: 'smile',
        steps: [
          { op: 'write', path: 'wiki/a.md', content: 'x' },
          { op: 'append', path: 'wiki/b.md', content: 'y' },
          { op: 'patch', path: 'wiki/c.md', targetType: 'heading', content: 'z' },
        ],
      },
    });
    assert.deepEqual(t.relPaths, ['wiki/a.md', 'wiki/b.md', 'wiki/c.md']);
    assert.equal(t.vaultSlug, 'smile');
    // …and the transcript scanner has to SEE the call in the first place.
    assert.equal(isTrackedWriteTool('mcp__obsidian-router__write_bundle'), true);
    assert.equal(isTrackedWriteTool('mcp__plugin_obsidian-router_router__write_bundle'), true);
  });

  test('write_bundle keeps this guard\'s own exclusions, per step', () => {
    // The tracked-set policy is stated ONCE. A bundle's `set_frontmatter`,
    // `merge_frontmatter` and `delete` steps are the low-level equivalents of
    // tools this guard deliberately does not track (a metadata toggle or a
    // delete adds no recent fact worth a hot entry), and a `patch` targeting
    // frontmatter is the same case as `patch_file` + `targetType:'frontmatter'`.
    // If this ever diverges from the single-file rules, the primitive and the
    // wrapper disagree about the same edit.
    const t = targetsFromToolUse({
      toolName: 'mcp__obsidian-router__write_bundle',
      input: {
        steps: [
          { op: 'write', path: 'wiki/kept.md' },
          { op: 'set_frontmatter', path: 'wiki/meta-only.md', key: 'k', value: 'v' },
          { op: 'merge_frontmatter', path: 'wiki/meta-too.md', values: {} },
          { op: 'delete', path: 'wiki/gone.md', confirm: true },
          { op: 'patch', path: 'wiki/fm.md', targetType: 'frontmatter', content: 'x' },
        ],
      },
    });
    assert.deepEqual(t.relPaths, ['wiki/kept.md']);
  });

  test('a RECOVERY replay is not a bundle apply — the handler\'s definition, not truthiness', () => {
    // `normalizeRecoverArg` reads `"false"`, `"0"`, `"no"` and `"off"` as an
    // ORDINARY bundle (the field is a boolean|operationId union and a real MCP
    // client was observed sending the string `"true"`). Delegating to
    // `writeTargets` is what buys this agreement for free; a hand-rolled
    // `if (input.recover)` here would have classified those four as recoveries
    // and let their real writes end the turn unnoticed.
    const targets = (recover) => targetsFromToolUse({
      toolName: 'mcp__obsidian-router__write_bundle',
      input: { recover, steps: [{ op: 'write', path: 'wiki/a.md' }] },
    }).relPaths;
    assert.deepEqual(targets(true), []);
    assert.deepEqual(targets('resume-op-1'), []);
    for (const falsy of ['false', '0', 'no', 'off', '', undefined]) {
      assert.deepEqual(targets(falsy), ['wiki/a.md'], `recover: ${JSON.stringify(falsy)} is an ordinary bundle`);
    }
  });
});

// ---------------------------------------------------------------------------
// extractWriteToolUses
// ---------------------------------------------------------------------------

describe('extractWriteToolUses', () => {
  test('returns only tracked tool_use blocks', () => {
    const t = jsonl(
      textLine('some prose'),
      toolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/a.md', vault: 'a' }),
      toolUseLine('mcp__obsidian-router__search', { query: 'x' }),
      toolUseLine('mcp__obsidian-router__move_file', { from: 'wiki/a.md', to: 'wiki/b.md', vault: 'a' }),
      toolUseLine('Read', { file_path: '/x' }),
      toolUseLine('Edit', { file_path: '/vaults/A/wiki/b.md' }),
    );
    const got = extractWriteToolUses(t);
    // write_file + Edit are tracked; search/move_file/Read are not.
    assert.equal(got.length, 2);
    assert.equal(got[0].toolName, 'mcp__obsidian-router__write_file');
    assert.equal(got[1].toolName, 'Edit');
  });
  test('skips malformed lines, tolerates empty', () => {
    assert.deepEqual(extractWriteToolUses(''), []);
    const t = 'not json\n' + toolUseLine('Write', { file_path: '/vaults/A/wiki/x.md' }) + '\n{bad';
    assert.equal(extractWriteToolUses(t).length, 1);
  });

  // ---- outcome pairing --------------------------------------------------
  // A request is not an effect. Everything below is the fix for the original
  // blind spot: the classifier read the assistant's `tool_use` blocks and never
  // asked whether the call came back.

  test('a write the vault REFUSED is not an applied write', () => {
    const t = jsonl(failedToolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/a.md', vault: 'a' }));
    assert.deepEqual(extractWriteToolUses(t), []);
  });

  test('a write with NO tool_result is not an applied write (absent ≠ success)', () => {
    const t = jsonl(unansweredToolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/a.md', vault: 'a' }));
    assert.deepEqual(extractWriteToolUses(t), []);
  });

  test('the pairing is BY ID — one failure does not condemn its neighbours', () => {
    // Every fixture block used to carry the id `'x'`. If the pairing regressed
    // to "any result in the file", or to "the last result wins", this mixed
    // transcript would return 0 or 3 instead of the two that landed.
    const t = jsonl(
      toolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/ok-1.md', vault: 'a' }),
      failedToolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/refused.md', vault: 'a' }),
      toolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/ok-2.md', vault: 'a' }),
    );
    assert.deepEqual(extractWriteToolUses(t).map((u) => u.input.path), ['wiki/ok-1.md', 'wiki/ok-2.md']);
  });

  test('extractToolResultOutcomes reads the measured shape, is_error and all', () => {
    const t = jsonl(
      toolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/a.md' }),          // → toolu_fixture_N
      failedToolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/b.md' }),    // → toolu_fixture_N+1
      unansweredToolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/c.md' }),// → toolu_fixture_N+2
    );
    // Read the ids back out of the fixture rather than guessing the counter.
    const ids = [...t.matchAll(/"id":"(toolu_fixture_\d+)"/g)].map((m) => m[1]);
    assert.equal(ids.length, 3);
    const outcomes = extractToolResultOutcomes(t);
    assert.equal(outcomes.get(ids[0]), 'ok');
    assert.equal(outcomes.get(ids[1]), 'error');
    assert.equal(outcomes.has(ids[2]), false, 'an unanswered call has no entry at all');
  });

  test('the MCP spelling `isError` is honoured too', () => {
    const t = jsonl(
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_camel', name: 'mcp__obsidian-router__write_file', input: { path: 'wiki/a.md' } }] },
      }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ tool_use_id: 'toolu_camel', type: 'tool_result', content: 'boom', isError: true }] },
      }),
    );
    assert.equal(extractToolResultOutcomes(t).get('toolu_camel'), 'error');
    assert.deepEqual(extractWriteToolUses(t), []);
  });

  test('a result with no is_error field at all is a success', () => {
    const t = jsonl(
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bare', name: 'mcp__obsidian-router__write_file', input: { path: 'wiki/a.md' } }] },
      }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ tool_use_id: 'toolu_bare', type: 'tool_result', content: 'done' }] },
      }),
    );
    assert.equal(extractToolResultOutcomes(t).get('toolu_bare'), 'ok');
    assert.equal(extractWriteToolUses(t).length, 1);
  });
});

// ---------------------------------------------------------------------------
// findStaleVaults — the core decision
// ---------------------------------------------------------------------------

describe('findStaleVaults', () => {
  test('content write without hot refresh → stale', () => {
    const t = jsonl(toolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/a.md', vault: 'a' }));
    const { stale } = findStaleVaults(t, CTX);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].vaultRoot, '/vaults/A');
  });

  test('content write WITH hot refresh (same vault) → not stale', () => {
    const t = jsonl(
      toolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/a.md', vault: 'a' }),
      toolUseLine('mcp__obsidian-router__write_file', { path: 'wiki-meta/hot.md', vault: 'a' }),
    );
    assert.equal(findStaleVaults(t, CTX).stale.length, 0);
  });

  test('ordering: a content write AFTER the latest hot refresh → stale (codex P1)', () => {
    // content(0) → hot(1) → content(2): an early refresh must NOT excuse the
    // later note. The most recent content write is more recent than the hot.
    const t = jsonl(
      toolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/a.md', vault: 'a' }),
      toolUseLine('mcp__obsidian-router__write_file', { path: 'wiki-meta/hot.md', vault: 'a' }),
      toolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/b.md', vault: 'a' }),
    );
    const { stale } = findStaleVaults(t, CTX);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].vaultRoot, '/vaults/A');
  });

  test('ordering: hot refresh AFTER the latest content write clears the vault', () => {
    const t = jsonl(
      toolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/a.md', vault: 'a' }),
      toolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/b.md', vault: 'a' }),
      toolUseLine('mcp__obsidian-router__write_file', { path: 'wiki-meta/hot.md', vault: 'a' }),
    );
    assert.equal(findStaleVaults(t, CTX).stale.length, 0);
  });

  test('only scaffold writes (index/log) → not stale', () => {
    const t = jsonl(
      toolUseLine('mcp__obsidian-router__patch_file', { path: 'wiki-meta/index.md', vault: 'a' }),
      toolUseLine('mcp__obsidian-router__append_to_file', { path: 'wiki-meta/log.md', vault: 'a' }),
    );
    assert.equal(findStaleVaults(t, CTX).stale.length, 0);
  });

  test('per-vault: A refreshed, B not → only B stale', () => {
    const t = jsonl(
      toolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/a.md', vault: 'a' }),
      toolUseLine('mcp__obsidian-router__write_file', { path: 'wiki-meta/hot.md', vault: 'a' }),
      toolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/b.md', vault: 'b' }),
    );
    const { stale } = findStaleVaults(t, CTX);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].vaultRoot, '/vaults/B');
  });

  test('unresolvable vault (unknown slug) → skipped, never stale', () => {
    const t = jsonl(toolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/a.md', vault: 'zzz-unknown' }));
    assert.equal(findStaleVaults(t, CTX).stale.length, 0);
  });

  test('slug given but unresolved does NOT fall back to defaultRoot', () => {
    // Regression: a write with an explicit-but-unknown vault must be skipped,
    // not silently attributed to the default vault.
    const t = jsonl(toolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/a.md', vault: 'ghost' }));
    const { byVault } = findStaleVaults(t, CTX);
    assert.equal(byVault.size, 0);
  });

  test('MCP write with NO vault uses defaultRoot', () => {
    const t = jsonl(toolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/a.md' }));
    const { stale } = findStaleVaults(t, CTX);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].vaultRoot, '/vaults/A');
  });

  test('built-in Edit under a known vault root → content', () => {
    const t = jsonl(toolUseLine('Edit', { file_path: '/vaults/B/wiki/note.md' }));
    const { stale } = findStaleVaults(t, CTX);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].vaultRoot, '/vaults/B');
  });

  test('built-in Edit OUTSIDE any vault root (repo file) → skipped', () => {
    const t = jsonl(toolUseLine('Edit', { file_path: '/repo/src/index.mjs' }));
    assert.equal(findStaleVaults(t, CTX).stale.length, 0);
  });

  test('built-in Edit on hot.md satisfies the content from MCP (same vault)', () => {
    const t = jsonl(
      toolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/a.md', vault: 'a' }),
      toolUseLine('Edit', { file_path: '/vaults/A/wiki-meta/hot.md' }),
    );
    assert.equal(findStaleVaults(t, CTX).stale.length, 0);
  });

  test('execute_template (createFile:true) writing a wiki/ note → stale', () => {
    const t = jsonl(toolUseLine('mcp__obsidian-router__execute_template', {
      name: 'Templates/Daily.md', createFile: true, targetPath: 'wiki/journal/x.md', vault: 'a',
    }));
    assert.equal(findStaleVaults(t, CTX).stale.length, 1);
  });

  test('execute_template (createFile:false) → no write → not stale', () => {
    const t = jsonl(toolUseLine('mcp__obsidian-router__execute_template', {
      name: 'wiki/Templates/T.md', createFile: false, vault: 'a',
    }));
    assert.equal(findStaleVaults(t, CTX).stale.length, 0);
  });

  test('move_file is NOT tracked → never stale (rename adds no recent fact)', () => {
    const t = jsonl(toolUseLine('mcp__obsidian-router__move_file', { from: 'wiki/a.md', to: 'wiki/b.md', vault: 'a' }));
    assert.equal(findStaleVaults(t, CTX).stale.length, 0);
  });

  test('delete_file is NOT tracked → never stale (and avoids a misleading "you wrote" message)', () => {
    const t = jsonl(toolUseLine('mcp__obsidian-router__delete_file', { path: 'wiki/a.md', confirm: true, vault: 'a' }));
    assert.equal(findStaleVaults(t, CTX).stale.length, 0);
  });

  test('set_frontmatter / merge_frontmatter on a wiki/ note are NOT tracked → not stale', () => {
    const t = jsonl(
      toolUseLine('mcp__obsidian-router__set_frontmatter', { path: 'wiki/a.md', key: 'status', value: 'done', vault: 'a' }),
      toolUseLine('mcp__obsidian-router__merge_frontmatter', { path: 'wiki/b.md', values: { tags: ['x'] }, vault: 'a' }),
    );
    assert.equal(findStaleVaults(t, CTX).stale.length, 0);
  });

  test('patch_file targetType:frontmatter on a wiki/ note → NOT content (consistent with set_frontmatter)', () => {
    const t = jsonl(toolUseLine('mcp__obsidian-router__patch_file', {
      path: 'wiki/a.md', targetType: 'frontmatter', operation: 'replace', target: 'status', content: 'done', vault: 'a',
    }));
    assert.equal(findStaleVaults(t, CTX).stale.length, 0);
  });

  test('patch_file targetType:heading on a wiki/ note IS content → stale', () => {
    const t = jsonl(toolUseLine('mcp__obsidian-router__patch_file', {
      path: 'wiki/a.md', targetType: 'heading', operation: 'append', target: 'Section', content: 'x', vault: 'a',
    }));
    assert.equal(findStaleVaults(t, CTX).stale.length, 1);
  });

  test('Windows case-insensitive root matching', () => {
    const winCtx = { vaultRoots: ['C:\\VAULTS\\X'], slugToRoot: () => null, defaultRoot: null, isWin: true };
    const t = jsonl(toolUseLine('Edit', { file_path: 'C:/VAULTS/X/wiki/a.md' }));
    assert.equal(findStaleVaults(t, winCtx).stale.length, 1);
  });

  test('empty transcript → not stale', () => {
    assert.equal(findStaleVaults('', CTX).stale.length, 0);
  });

  // -------------------------------------------------------------------------
  // Outcome awareness — THE BLIND SPOT (found 2026-09-07 by codex review).
  //
  // The classifier read the assistant's REQUESTS and never asked whether the
  // call came back. So a hot.md write that FAILED — a concurrency 409, an
  // offline vault, a refused path — cleared the vault exactly like one that
  // succeeded, and the turn ended clean while the cache had not moved. A false
  // assurance is worse at that instant than no guard at all.
  // -------------------------------------------------------------------------

  test('note written, then the hot refresh FAILS → still stale (the blind spot)', () => {
    const t = jsonl(
      toolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/a.md', vault: 'a' }),
      failedToolUseLine('mcp__obsidian-router__write_file', { path: 'wiki-meta/hot.md', vault: 'a' }),
    );
    const { stale } = findStaleVaults(t, CTX);
    assert.equal(stale.length, 1, 'a refused hot.md write must not whitewash the session');
    assert.equal(stale[0].vaultRoot, '/vaults/A');
  });

  test('note written, then the hot refresh SUCCEEDS → not stale (non-regression)', () => {
    const t = jsonl(
      toolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/a.md', vault: 'a' }),
      toolUseLine('mcp__obsidian-router__write_file', { path: 'wiki-meta/hot.md', vault: 'a' }),
    );
    assert.equal(findStaleVaults(t, CTX).stale.length, 0);
  });

  test('a FAILED hot refresh, then a successful retry → not stale', () => {
    // The realistic recovery: the 409 is retried in the same turn and lands.
    const t = jsonl(
      toolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/a.md', vault: 'a' }),
      failedToolUseLine('mcp__obsidian-router__write_file', { path: 'wiki-meta/hot.md', vault: 'a' }),
      toolUseLine('mcp__obsidian-router__write_file', { path: 'wiki-meta/hot.md', vault: 'a' }),
    );
    assert.equal(findStaleVaults(t, CTX).stale.length, 0);
  });

  test('the correction cuts BOTH ways: a note write that FAILED does not make a vault stale', () => {
    // The mirror-image defect the fix must not introduce. Nothing was written,
    // so there is nothing for hot.md to be behind.
    const t = jsonl(failedToolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/a.md', vault: 'a' }));
    const { stale, byVault } = findStaleVaults(t, CTX);
    assert.equal(stale.length, 0);
    assert.equal(byVault.size, 0, 'a refused write does not even count as touching the vault');
  });

  test('a note write with NO tool_result does not make a vault stale (absent ≠ success)', () => {
    const t = jsonl(unansweredToolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/a.md', vault: 'a' }));
    assert.equal(findStaleVaults(t, CTX).stale.length, 0);
  });

  test('a hot refresh with NO tool_result does not clear the vault (absent ≠ success)', () => {
    // The other half of the same rule, and the reason it is stated symmetrically:
    // an unseen hot write is not a hot write.
    const t = jsonl(
      toolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/a.md', vault: 'a' }),
      unansweredToolUseLine('mcp__obsidian-router__write_file', { path: 'wiki-meta/hot.md', vault: 'a' }),
    );
    const { stale } = findStaleVaults(t, CTX);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].vaultRoot, '/vaults/A');
  });

  test('a transcript with NO tool_result AT ALL → fail-open, nothing stale', () => {
    // Another host's transcript format, or a half-flushed file. Counting the
    // unresolved note writes here (the asymmetric "block when in doubt" rule)
    // would block every turn that touched a vault on a file we could not read.
    const t = jsonl(
      unansweredToolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/a.md', vault: 'a' }),
      unansweredToolUseLine('mcp__obsidian-router__patch_file', { path: 'wiki/b.md', targetType: 'heading', target: 'S', content: 'x', vault: 'b' }),
      unansweredToolUseLine('Edit', { file_path: '/vaults/B/wiki/c.md' }),
    );
    const { stale, byVault } = findStaleVaults(t, CTX);
    assert.equal(stale.length, 0);
    assert.equal(byVault.size, 0);
  });

  test('ordering survives: only APPLIED writes are indexed', () => {
    // hot(ok) → note(FAILED) → nothing else. If the refused note kept its slot
    // in the sequence it would land after the hot refresh and re-stale the
    // vault, which is the ordering rule firing on a write that never happened.
    const t = jsonl(
      toolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/a.md', vault: 'a' }),
      toolUseLine('mcp__obsidian-router__write_file', { path: 'wiki-meta/hot.md', vault: 'a' }),
      failedToolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/b.md', vault: 'a' }),
    );
    assert.equal(findStaleVaults(t, CTX).stale.length, 0);
  });

  test('per-vault: A\'s hot refresh failed, B\'s landed → only A stale', () => {
    const t = jsonl(
      toolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/a.md', vault: 'a' }),
      failedToolUseLine('mcp__obsidian-router__write_file', { path: 'wiki-meta/hot.md', vault: 'a' }),
      toolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/b.md', vault: 'b' }),
      toolUseLine('mcp__obsidian-router__write_file', { path: 'wiki-meta/hot.md', vault: 'b' }),
    );
    const { stale } = findStaleVaults(t, CTX);
    assert.deepEqual(stale.map((s) => s.vaultRoot), ['/vaults/A']);
  });

  test('write_bundle: a refused bundle writes none of its notes', () => {
    // The tool that writes the most files at once, and the one whose failure
    // used to look identical to twelve successful notes.
    const applied = jsonl(toolUseLine('mcp__obsidian-router__write_bundle', {
      vault: 'a', steps: [{ op: 'write', path: 'wiki/a.md' }, { op: 'write', path: 'wiki/b.md' }],
    }));
    assert.equal(findStaleVaults(applied, CTX).stale.length, 1);
    const refused = jsonl(failedToolUseLine('mcp__obsidian-router__write_bundle', {
      vault: 'a', steps: [{ op: 'write', path: 'wiki/a.md' }, { op: 'write', path: 'wiki/b.md' }],
    }));
    assert.equal(findStaleVaults(refused, CTX).stale.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Hook end-to-end (subprocess)
// ---------------------------------------------------------------------------

describe('hot-cache-update-prompt hook (subprocess)', () => {
  let workDir, vaultPath, configPath, transcriptPath, projectDir;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-guard-'));
    vaultPath = path.join(workDir, 'fake-vault');
    fs.mkdirSync(path.join(vaultPath, 'wiki'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'wiki-meta'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, 'wiki-meta', 'index.md'), '# index');

    configPath = path.join(workDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ portRegistry: { [vaultPath]: 27132 } }, null, 2));

    transcriptPath = path.join(workDir, 'transcript.jsonl');
    projectDir = path.join(workDir, 'proj'); // a non-vault cwd
    fs.mkdirSync(projectDir, { recursive: true });
  });

  after(() => fs.rmSync(workDir, { recursive: true, force: true }));

  function run(transcriptLines, { stopHookActive = false, env = {} } = {}) {
    fs.writeFileSync(transcriptPath, transcriptLines.join('\n') + '\n');
    const stdin = JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcriptPath, stop_hook_active: stopHookActive });
    const cleanEnv = { ...process.env };
    delete cleanEnv.OBSIDIAN_ROUTER_DEFAULT_VAULT;
    delete cleanEnv.OBSIDIAN_ROUTER_NO_HOT_CACHE_GUARD;
    return spawnSync(process.execPath, [HOOK_PATH], {
      input: stdin,
      encoding: 'utf8',
      env: { ...cleanEnv, OBSIDIAN_ROUTER_CONFIG: configPath, CLAUDE_PROJECT_DIR: projectDir, ...env },
    });
  }

  test('blocks (exit 2) when wiki/ note written but hot.md not refreshed', () => {
    const r = run([toolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/note.md', vault: 'fake-vault' })]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /hot\.md/);
    assert.match(r.stderr, /fake-vault/);
  });

  test('passes (exit 0) when hot.md refreshed in same session', () => {
    const r = run([
      toolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/note.md', vault: 'fake-vault' }),
      toolUseLine('mcp__obsidian-router__write_file', { path: 'wiki-meta/hot.md', vault: 'fake-vault' }),
    ]);
    assert.equal(r.status, 0, r.stderr);
  });

  test('BLOCKS (exit 2) when the hot.md refresh itself failed', () => {
    // End-to-end proof of the blind spot: before the outcome pairing this exact
    // transcript exited 0 — the guard certified a refresh that the vault had
    // refused.
    const r = run([
      toolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/note.md', vault: 'fake-vault' }),
      failedToolUseLine('mcp__obsidian-router__write_file', { path: 'wiki-meta/hot.md', vault: 'fake-vault' }),
    ]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /fake-vault/);
  });

  test('passes (exit 0) when the wiki/ NOTE write is the one that failed', () => {
    const r = run([failedToolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/note.md', vault: 'fake-vault' })]);
    assert.equal(r.status, 0, r.stderr);
  });

  test('passes (exit 0) on a transcript with no tool_result at all (fail-open)', () => {
    const r = run([unansweredToolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/note.md', vault: 'fake-vault' })]);
    assert.equal(r.status, 0, r.stderr);
  });

  test('passes (exit 0) when only scaffolds touched', () => {
    const r = run([toolUseLine('mcp__obsidian-router__patch_file', { path: 'wiki-meta/index.md', vault: 'fake-vault' })]);
    assert.equal(r.status, 0, r.stderr);
  });

  test('passes (exit 0) on a delete_file of a wiki/ note (not tracked)', () => {
    const r = run([toolUseLine('mcp__obsidian-router__delete_file', { path: 'wiki/note.md', confirm: true, vault: 'fake-vault' })]);
    assert.equal(r.status, 0, r.stderr);
  });

  test('opt-out env → exit 0 even with stale content', () => {
    const r = run([toolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/note.md', vault: 'fake-vault' })], {
      env: { OBSIDIAN_ROUTER_NO_HOT_CACHE_GUARD: 'true' },
    });
    assert.equal(r.status, 0, r.stderr);
  });

  test('recursion guard (stop_hook_active) → exit 0', () => {
    const r = run([toolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/note.md', vault: 'fake-vault' })], {
      stopHookActive: true,
    });
    assert.equal(r.status, 0, r.stderr);
  });

  test('no transcript path → exit 0 (fail-open)', () => {
    const stdin = JSON.stringify({ hook_event_name: 'Stop' });
    const cleanEnv = { ...process.env };
    delete cleanEnv.OBSIDIAN_ROUTER_DEFAULT_VAULT;
    const r = spawnSync(process.execPath, [HOOK_PATH], {
      input: stdin,
      encoding: 'utf8',
      env: { ...cleanEnv, OBSIDIAN_ROUTER_CONFIG: configPath, CLAUDE_PROJECT_DIR: projectDir },
    });
    assert.equal(r.status, 0, r.stderr);
  });
});
