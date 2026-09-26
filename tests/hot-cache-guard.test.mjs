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
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  isTrackedWriteTool,
  isBuiltinWriteTool,
  extractWriteToolUses,
  extractToolResultOutcomes,
  resultAppliedWrite,
  targetsFromToolUse,
  pathKind,
  findStaleVaults,
  classifyToolUse,
  currentRunTranscript,
  parseVaultEditInvocations,
} from '../src/helpers/hot-staleness.mjs';
import { homeSafeEnv } from './_home-safe-spawn.mjs';

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
function toolUseLine(name, input, { isError = false, result = 'present', report } = {}) {
  const id = nextToolUseId();
  const use = useLine(id, name, input);
  if (result === 'none') return use;
  return use + '\n' + resultLine(id, { isError, ...(report === undefined ? {} : { report }) });
}

/** The request half on its own, with an id chosen by the caller. */
function useLine(toolUseId, name, input) {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name, input }] },
  });
}

/**
 * The answering half on its own. `content` is an ARRAY of text blocks holding
 * the JSON the tool returned — the shape MEASURED for a successful router write
 * (222 of them across ten transcripts). It matters: `write_bundle` reports a
 * mid-bundle failure INSIDE this payload, not through `is_error`.
 */
function resultLine(toolUseId, { isError = false, report = { ok: true, outcome: 'applied' } } = {}) {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{
        tool_use_id: toolUseId,
        type: 'tool_result',
        content: [{ type: 'text', text: typeof report === 'string' ? report : JSON.stringify(report, null, 2) }],
        is_error: isError,
      }],
    },
  });
}

/**
 * A bundle whose report says every step applied. `statuses` overrides the
 * per-step verdict — `ok: true` does NOT imply every step wrote, because a
 * `patch` that found its target already satisfied is reported `skipped` while
 * the bundle still finishes `applied`.
 */
function appliedBundleLine(steps, vault = 'a', statuses = null) {
  const stepResults = steps.map((s, index) => ({
    index, op: s.op, path: s.path, status: statuses ? statuses[index] : 'ok',
  }));
  return toolUseLine('mcp__obsidian-router__write_bundle', { vault, steps },
    { report: {
      vault, operationId: 'op', ok: true, outcome: 'applied',
      applied: stepResults.filter((s) => s.status === 'ok').length,
      total: steps.length,
      steps: stepResults,
    } });
}

/**
 * A bundle that failed mid-way and rolled back. `is_error` is FALSE — the
 * dispatcher never marks a RETURNED value as an error — and the failure lives
 * only in `ok: false`. This is the fixture the outcome pairing could not see.
 */
function rolledBackBundleLine(steps, vault = 'a', outcome = 'rolled-back') {
  return toolUseLine('mcp__obsidian-router__write_bundle', { vault, steps },
    { report: { vault, operationId: 'op', ok: false, outcome, applied: 1, total: steps.length,
      failedStep: { index: 1, op: 'write', path: steps[steps.length - 1]?.path }, error: 'HTTP 409' } });
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

/**
 * The run-start marker, keys copied from a measured transcript: Claude Code
 * records each SessionStart hook it ran as an `attachment` whose `hookName`
 * spells the source (`SessionStart:startup` / `resume` / `clear` / `compact`).
 * `type` is `hook_success` for a synchronous hook, `async_hook_response` for an
 * async one.
 */
function sessionStartLine(source, { type = 'hook_success' } = {}) {
  return JSON.stringify({
    type: 'attachment',
    attachment: {
      type, hookName: `SessionStart:${source}`, hookEvent: 'SessionStart',
      toolUseID: `ss_${source}_${nextToolUseId()}`, content: '',
    },
  });
}

/**
 * Stamp a `uuid` on every JSON line of a fixture (a `toolUseLine` is two lines:
 * each gets its own suffix). Real entries carry one, and Claude Code can append
 * a second copy of old entries with the SAME uuids.
 */
function withUuid(lines, uuid) {
  return lines.split('\n').map((l, k) => JSON.stringify({ ...JSON.parse(l), uuid: `${uuid}-${k}` })).join('\n');
}

/**
 * A `Bash` call and its answer. The result content is a bare STRING, which is
 * the shape measured for Bash results (the router's own tools answer with an
 * array of text blocks). `output` is what the command printed. Real vault-edit
 * calls are piped through `tail`, so `is_error` stays false even on a refusal.
 */
function bashLine(command, output, { isError = false } = {}) {
  const id = nextToolUseId();
  return useLine(id, 'Bash', { command, description: 'fixture' }) + '\n' + JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: output, is_error: isError }] },
  });
}

/** A vault-edit command in the shape measured on real transcripts. */
function vaultEditCommand(vault, relPath, { dryRun = false } = {}) {
  return `cd "I:/repo" && node scripts/vault-edit.mjs --vault "${vault}" --path "${relPath}" `
    + `--spec "C:/tmp/spec.json"${dryRun ? ' --dry-run' : ''} 2>&1 | tail -4`;
}
// The script's last lines on a write, copied from a real run (tail -2).
const VE_WROTE = '3276 → 3519 caractères, précondition 163433d43598…\nécrit — casMode: atomic';

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

  test('the pairing is BY ID, not by position', () => {
    // THE PREVIOUS VERSION OF THIS TEST DID NOT TEST ITS OWN NAME (codex, round
    // 1, finding 4). It emitted every result immediately after its own request,
    // so an implementation pairing the Nth request with the Nth result passed it
    // without ever comparing an id. This fixture separates the two orders: the
    // results arrive SHUFFLED, an unrelated result for a tool that was never
    // requested sits in the middle, and an UNANSWERED request sits between two
    // answered ones. Positional pairing gets a different answer here.
    const t = jsonl(
      useLine('u_one', 'mcp__obsidian-router__write_file', { path: 'wiki/ok-1.md', vault: 'a' }),
      useLine('u_two', 'mcp__obsidian-router__write_file', { path: 'wiki/never-answered.md', vault: 'a' }),
      useLine('u_three', 'mcp__obsidian-router__write_file', { path: 'wiki/refused.md', vault: 'a' }),
      useLine('u_four', 'mcp__obsidian-router__write_file', { path: 'wiki/ok-2.md', vault: 'a' }),
      resultLine('u_three', { isError: true }),   // out of order, and an error
      resultLine('u_stranger'),                   // answers nothing in this transcript
      resultLine('u_four'),
      resultLine('u_one'),
    );
    assert.deepEqual(
      extractWriteToolUses(t).map((u) => u.input.path),
      ['wiki/ok-1.md', 'wiki/ok-2.md'],
      'only the two ids with a non-error result of their own may survive',
    );
    // Positional pairing would have matched u_one↔error and u_two↔stranger.
    assert.deepEqual(extractWriteToolUses(t).map((u) => u.id), ['u_one', 'u_four']);
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
    assert.equal(outcomes.get(ids[0]).isError, false);
    assert.equal(outcomes.get(ids[1]).isError, true);
    assert.equal(outcomes.has(ids[2]), false, 'an unanswered call has no entry at all');
  });

  test('the MCP spelling `isError` is honoured too', () => {
    const t = jsonl(
      useLine('toolu_camel', 'mcp__obsidian-router__write_file', { path: 'wiki/a.md' }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ tool_use_id: 'toolu_camel', type: 'tool_result', content: 'boom', isError: true }] },
      }),
    );
    assert.equal(extractToolResultOutcomes(t).get('toolu_camel').isError, true);
    assert.deepEqual(extractWriteToolUses(t), []);
  });

  test('a result with no is_error field at all is a success', () => {
    const t = jsonl(
      useLine('toolu_bare', 'mcp__obsidian-router__write_file', { path: 'wiki/a.md' }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ tool_use_id: 'toolu_bare', type: 'tool_result', content: 'done' }] },
      }),
    );
    assert.equal(extractToolResultOutcomes(t).get('toolu_bare').isError, false);
    assert.equal(extractWriteToolUses(t).length, 1);
  });

  test('a result payload is read from BOTH measured containers (array of blocks, bare string)', () => {
    // Success arrives as an array of text blocks, failure as a bare string.
    // `write_bundle`'s verdict lives inside that payload, so reading only one
    // container would silently mean "no report" for the other.
    const asArray = jsonl(
      useLine('u_arr', 'mcp__obsidian-router__write_bundle', { vault: 'a', steps: [{ op: 'write', path: 'wiki/a.md' }] }),
      resultLine('u_arr', { report: { ok: true, outcome: 'applied' } }),
    );
    assert.equal(extractWriteToolUses(asArray).length, 1);
    assert.equal(extractToolResultOutcomes(asArray).get('u_arr').text.includes('"ok": true'), true);

    const asString = jsonl(
      useLine('u_str', 'mcp__obsidian-router__write_bundle', { vault: 'a', steps: [{ op: 'write', path: 'wiki/a.md' }] }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ tool_use_id: 'u_str', type: 'tool_result', content: '{"ok":true,"outcome":"applied"}', is_error: false }] },
      }),
    );
    assert.equal(extractWriteToolUses(asString).length, 1);
  });
});

// ---------------------------------------------------------------------------
// resultAppliedWrite — the tool that reports failure WITHOUT is_error
// ---------------------------------------------------------------------------

describe('resultAppliedWrite (write_bundle reports failure in its RESULT)', () => {
  const bundle = 'mcp__obsidian-router__write_bundle';

  test('the throw path: is_error decides for every ordinary tool', () => {
    assert.equal(resultAppliedWrite('mcp__obsidian-router__write_file', { isError: false, text: 'anything' }), true);
    assert.equal(resultAppliedWrite('mcp__obsidian-router__write_file', { isError: true, text: 'Error: ...' }), false);
    assert.equal(resultAppliedWrite('mcp__obsidian-router__write_file', undefined), false);
  });

  test('a bundle counts ONLY when its own report says ok:true', () => {
    assert.equal(resultAppliedWrite(bundle, { isError: false, text: '{"ok":true,"outcome":"applied"}' }), true);
    for (const outcome of ['rolled-back', 'rolled-back-unverified', 'rolled-back-partial']) {
      assert.equal(
        resultAppliedWrite(bundle, { isError: false, text: JSON.stringify({ ok: false, outcome }) }),
        false,
        `${outcome} is not an applied write`,
      );
    }
  });

  test('a preview writes nothing, and its report carries no ok field', () => {
    // `writeTargets` gates on `recover` but NOT on `preview`, so a preview used
    // to enumerate targets and mark a vault stale for files it only described.
    // Asking "did it apply?" closes that without a second gate.
    const previewReport = { vault: 'a', preview: true, steps: [], targets: ['wiki/a.md'], approvedPlanSha256: 'x' };
    assert.equal(resultAppliedWrite(bundle, { isError: false, text: JSON.stringify(previewReport) }), false);
  });

  test('an unreadable or truncated bundle report is not a proven write', () => {
    for (const text of ['', 'not json', '{"ok":true', 'Ready to run 3 step(s)']) {
      assert.equal(resultAppliedWrite(bundle, { isError: false, text }), false, JSON.stringify(text));
    }
  });

  test('ok must be the boolean true, not merely truthy', () => {
    for (const ok of ['true', 1, 'yes', {}]) {
      assert.equal(resultAppliedWrite(bundle, { isError: false, text: JSON.stringify({ ok }) }), false, JSON.stringify(ok));
    }
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

  test('write_bundle: a bundle refused BEFORE the first write writes none of its notes', () => {
    // A refusal in pre-flight throws, so it arrives as is_error — the ordinary
    // path. The interesting case is the next test.
    const applied = jsonl(appliedBundleLine([{ op: 'write', path: 'wiki/a.md' }, { op: 'write', path: 'wiki/b.md' }]));
    assert.equal(findStaleVaults(applied, CTX).stale.length, 1);
    const refused = jsonl(failedToolUseLine('mcp__obsidian-router__write_bundle', {
      vault: 'a', steps: [{ op: 'write', path: 'wiki/a.md' }, { op: 'write', path: 'wiki/b.md' }],
    }));
    assert.equal(findStaleVaults(refused, CTX).stale.length, 0);
  });

  // -------------------------------------------------------------------------
  // codex round 1, finding A — the blind spot was only half closed.
  //
  // `write_bundle` reports a mid-bundle failure by RETURNING `ok:false`, and the
  // dispatcher never marks a returned value as an error. So a rolled-back hot
  // refresh reached the transcript as `is_error: false` and cleared the vault:
  // the original defect, still open for the tool that writes the most files.
  // -------------------------------------------------------------------------

  test('a ROLLED-BACK bundle does not clear the vault, though is_error is false', () => {
    const t = jsonl(
      toolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/a.md', vault: 'a' }),
      rolledBackBundleLine([{ op: 'write', path: 'wiki-meta/hot.md' }]),
    );
    const { stale } = findStaleVaults(t, CTX);
    assert.equal(stale.length, 1, 'a rolled-back hot refresh is not a refresh');
    assert.equal(stale[0].vaultRoot, '/vaults/A');
  });

  test('a ROLLED-BACK bundle does not make a vault stale either (same symmetric rule)', () => {
    const t = jsonl(rolledBackBundleLine([{ op: 'write', path: 'wiki/a.md' }, { op: 'write', path: 'wiki/b.md' }]));
    const { stale, byVault } = findStaleVaults(t, CTX);
    assert.equal(stale.length, 0);
    assert.equal(byVault.size, 0);
  });

  test('every non-applied outcome is treated alike, including rolled-back-partial', () => {
    // KNOWN LIMIT, asserted so it is a decision and not an accident: a partial
    // rollback leaves some files dirty, and counting the call as nothing can
    // MISS such a note. That is the fail-open direction, chosen deliberately —
    // never the direction that falsely certifies a refresh.
    for (const outcome of ['rolled-back', 'rolled-back-unverified', 'rolled-back-partial']) {
      const t = jsonl(rolledBackBundleLine([{ op: 'write', path: 'wiki/a.md' }], 'a', outcome));
      assert.equal(findStaleVaults(t, CTX).byVault.size, 0, outcome);
    }
  });

  test('a preview bundle writes nothing, so it cannot make a vault stale', () => {
    const t = jsonl(toolUseLine('mcp__obsidian-router__write_bundle',
      { vault: 'a', preview: true, steps: [{ op: 'write', path: 'wiki/a.md' }] },
      { report: { vault: 'a', preview: true, targets: ['wiki/a.md'], approvedPlanSha256: 'x' } }));
    assert.equal(findStaleVaults(t, CTX).byVault.size, 0);
  });

  // -------------------------------------------------------------------------
  // codex round 1, finding B — every target needs its OWN ordering position.
  //
  // A bundle writes several files in ONE tool_use. Sharing one index made
  // lastContent === lastHot, which the strict `>` reads as fresh, so a bundle
  // that refreshed hot and THEN wrote a note came out clean — in the very tool
  // documented as writing "the note, an index, the journal, hot.md" together.
  // -------------------------------------------------------------------------

  test('inside ONE bundle: hot refreshed, then a note written → stale', () => {
    const t = jsonl(appliedBundleLine([
      { op: 'write', path: 'wiki-meta/hot.md' },
      { op: 'write', path: 'wiki/new-note.md' },
    ]));
    const { stale, byVault } = findStaleVaults(t, CTX);
    assert.equal(stale.length, 1, 'the note follows the refresh, so the cache is behind');
    assert.deepEqual(byVault.get('/vaults/A'), { lastContent: 1, lastHot: 0 });
  });

  test('inside ONE bundle: note written, then hot refreshed → not stale', () => {
    const t = jsonl(appliedBundleLine([
      { op: 'write', path: 'wiki/new-note.md' },
      { op: 'write', path: 'wiki-meta/hot.md' },
    ]));
    const { stale, byVault } = findStaleVaults(t, CTX);
    assert.equal(stale.length, 0);
    assert.deepEqual(byVault.get('/vaults/A'), { lastContent: 0, lastHot: 1 });
  });

  // -------------------------------------------------------------------------
  // codex round 2 — `ok: true` does not mean every step WROTE.
  //
  // `RESULT_SKIP_PROBES` in the producer has exactly one entry: a `patch` whose
  // target already satisfied it reports `status: 'skipped'`, and the bundle
  // still finishes `ok: true, outcome: 'applied'`. `patch` is a tracked content
  // op here, so reading only the call-level flag credited a no-op as a write —
  // the same "a request is not an effect" defect, one level further down.
  // -------------------------------------------------------------------------

  test('a SKIPPED hot.md patch inside an applied bundle does not clear the vault', () => {
    const t = jsonl(appliedBundleLine(
      [{ op: 'write', path: 'wiki/a.md' }, { op: 'patch', path: 'wiki-meta/hot.md', targetType: 'heading', target: 'Hot', content: 'x' }],
      'a',
      ['ok', 'skipped'], // the patch changed nothing
    ));
    const { stale } = findStaleVaults(t, CTX);
    assert.equal(stale.length, 1, 'a no-op patch on hot.md is not a refresh');
    assert.equal(stale[0].vaultRoot, '/vaults/A');
  });

  test('a SKIPPED note patch inside an applied bundle does not make the vault stale', () => {
    // The other side of the same rule: nothing was written, so nothing is owed.
    const t = jsonl(appliedBundleLine(
      [{ op: 'patch', path: 'wiki/a.md', targetType: 'heading', target: 'S', content: 'x' }],
      'a',
      ['skipped'],
    ));
    const { stale, byVault } = findStaleVaults(t, CTX);
    assert.equal(stale.length, 0);
    assert.equal(byVault.size, 0);
  });

  test('a FAILED or NOT-RUN step inside an otherwise-applied bundle writes nothing', () => {
    for (const status of ['failed', 'not-run']) {
      const t = jsonl(appliedBundleLine([{ op: 'write', path: 'wiki/a.md' }], 'a', [status]));
      assert.equal(findStaleVaults(t, CTX).byVault.size, 0, status);
    }
  });

  test('per-step filtering keeps ORDER — a skipped first step does not reorder the rest', () => {
    // The step filter feeds the per-target ordering, so dropping a step must
    // shift positions without swapping them.
    const t = jsonl(appliedBundleLine(
      [
        { op: 'patch', path: 'wiki/skipped.md', targetType: 'heading', target: 'S', content: 'x' },
        { op: 'write', path: 'wiki-meta/hot.md' },
        { op: 'write', path: 'wiki/written-after.md' },
      ],
      'a',
      ['skipped', 'ok', 'ok'],
    ));
    const { stale, byVault } = findStaleVaults(t, CTX);
    assert.deepEqual(byVault.get('/vaults/A'), { lastContent: 1, lastHot: 0 });
    assert.equal(stale.length, 1, 'the note still follows the refresh once the skip is dropped');
  });

  test('an applied bundle whose report carries no steps array counts nothing', () => {
    // A report present but unreadable at the step level cannot prove which files
    // moved — the same rule as a missing result.
    const t = jsonl(toolUseLine('mcp__obsidian-router__write_bundle',
      { vault: 'a', steps: [{ op: 'write', path: 'wiki/a.md' }] },
      { report: { vault: 'a', ok: true, outcome: 'applied' } }));
    assert.equal(findStaleVaults(t, CTX).byVault.size, 0);
  });

  test('the two orders are DISTINGUISHABLE — no shared index can collapse them', () => {
    const positions = (steps) => findStaleVaults(jsonl(appliedBundleLine(steps)), CTX).byVault.get('/vaults/A');
    const hotFirst = positions([{ op: 'write', path: 'wiki-meta/hot.md' }, { op: 'write', path: 'wiki/n.md' }]);
    const noteFirst = positions([{ op: 'write', path: 'wiki/n.md' }, { op: 'write', path: 'wiki-meta/hot.md' }]);
    assert.notDeepEqual(hotFirst, noteFirst);
    assert.notEqual(hotFirst.lastContent, hotFirst.lastHot, 'a target never shares a position with another');
  });
});

// ---------------------------------------------------------------------------
// Defect A — the run bound (a resumed session's transcript holds several runs)
// ---------------------------------------------------------------------------

describe('currentRunTranscript — only the current run is judged (defect A)', () => {
  const W = 'mcp__obsidian-router__write_file';
  const staleOfRun = (t) => findStaleVaults(currentRunTranscript(t), CTX).stale.map((s) => s.vaultKey);

  test('A1: a vault written only in an EARLIER run is not claimed', () => {
    const t = jsonl(
      sessionStartLine('startup'),
      toolUseLine(W, { path: 'wiki/old-note.md', vault: 'b' }), // run 1: note in B, never refreshed
      sessionStartLine('resume'),
      toolUseLine(W, { path: 'wiki/new-note.md', vault: 'a' }), // run 2: note in A, refreshed
      toolUseLine(W, { path: 'wiki-meta/hot.md', vault: 'a' }),
    );
    // Control: the SAME fixture read whole still claims B, so the fixture can
    // tell the two behaviours apart.
    assert.deepEqual(findStaleVaults(t, CTX).stale.map((s) => s.vaultKey), ['/vaults/B']);
    assert.deepEqual(staleOfRun(t), []);
  });

  test('A2: a vault written in the CURRENT run without a refresh is still claimed', () => {
    const t = jsonl(
      sessionStartLine('startup'),
      toolUseLine(W, { path: 'wiki-meta/hot.md', vault: 'a' }), // run 1 refresh
      sessionStartLine('resume'),
      toolUseLine(W, { path: 'wiki/new-note.md', vault: 'a' }), // run 2 note, no refresh
    );
    assert.deepEqual(staleOfRun(t), ['/vaults/A']);
  });

  test('A3: no run-start marker → no bound (null), so nothing can be claimed', () => {
    const t = jsonl(toolUseLine(W, { path: 'wiki/note.md', vault: 'a' }));
    assert.equal(currentRunTranscript(t), null);
    assert.equal(currentRunTranscript(''), null);
    assert.equal(currentRunTranscript(undefined), null);
  });

  test('the LAST marker wins, when there are several', () => {
    const t = jsonl(
      sessionStartLine('startup'),
      toolUseLine(W, { path: 'wiki/one.md', vault: 'a' }),
      sessionStartLine('resume'),
      toolUseLine(W, { path: 'wiki/two.md', vault: 'b' }),
      sessionStartLine('resume'),
      toolUseLine(W, { path: 'wiki/three.md', vault: 'a' }),
    );
    assert.deepEqual(staleOfRun(t), ['/vaults/A']);
    assert.deepEqual([...findStaleVaults(currentRunTranscript(t), CTX).byVault.keys()], ['/vaults/A']);
  });

  test('a re-appended COPY of old history is not the current run (dedup by uuid)', () => {
    // Measured on session 8602edea: 2200 entries re-appended with uuids already
    // seen, the last marker among them. The real current run must be judged.
    const startup = withUuid(sessionStartLine('startup'), 'u1');
    const noteA = withUuid(toolUseLine(W, { path: 'wiki/a.md', vault: 'a' }), 'u2');
    const hotA = withUuid(toolUseLine(W, { path: 'wiki-meta/hot.md', vault: 'a' }), 'u3');
    const resume = withUuid(sessionStartLine('resume'), 'u4');
    const noteB = withUuid(toolUseLine(W, { path: 'wiki/b.md', vault: 'b' }), 'u5');
    const t = jsonl(startup, noteA, hotA, resume, noteB, startup, noteA); // last two: copies
    assert.deepEqual(staleOfRun(t), ['/vaults/B']);
  });

  test('a marker whose colon is JSON-escaped is still a marker (the value is judged, not the text)', () => {
    const escaped = sessionStartLine('resume').replace('SessionStart:resume', 'SessionStart' + '\\' + 'u003aresume');
    assert.ok(!escaped.includes('SessionStart:'), 'the fixture really is escaped');
    assert.equal(JSON.parse(escaped).attachment.hookName, 'SessionStart:resume');
    const t = jsonl(sessionStartLine('startup'), toolUseLine(W, { path: 'wiki/old.md', vault: 'b' }), escaped);
    assert.deepEqual(staleOfRun(t), []);
  });

  test('a marker whose NAME is fully JSON-escaped is still a marker (no text pre-filter)', () => {
    const escaped = sessionStartLine('resume').replace(/SessionStart/g, '\\' + 'u0053essionStart');
    assert.ok(!escaped.includes('SessionStart'), 'the fixture really is escaped');
    assert.equal(JSON.parse(escaped).attachment.hookName, 'SessionStart:resume');
    const t = jsonl(sessionStartLine('startup'), toolUseLine(W, { path: 'wiki/old.md', vault: 'b' }), escaped);
    assert.deepEqual(staleOfRun(t), []);
  });

  test('a COMPACTION is not a run boundary: a note written just before it is still owed', () => {
    const t = jsonl(
      sessionStartLine('startup'),
      toolUseLine(W, { path: 'wiki/before-compact.md', vault: 'a' }),
      sessionStartLine('compact'),
    );
    assert.deepEqual(staleOfRun(t), ['/vaults/A']);
  });

  test('an ASYNC SessionStart response is not a run boundary (it can arrive after the first writes)', () => {
    const t = jsonl(
      sessionStartLine('startup'),
      toolUseLine(W, { path: 'wiki/early.md', vault: 'a' }),
      sessionStartLine('startup', { type: 'async_hook_response' }),
    );
    assert.deepEqual(staleOfRun(t), ['/vaults/A']);
  });
});

// ---------------------------------------------------------------------------
// Defect B — scripts/vault-edit.mjs, run through Bash
// ---------------------------------------------------------------------------

describe('vault-edit.mjs through Bash is a write (defect B)', () => {
  const W = 'mcp__obsidian-router__write_file';
  const kinds = (line) => extractWriteToolUses(line).flatMap((tu) => classifyToolUse(tu, CTX).map((c) => [c.vaultKey, c.kind]));

  test('parses the measured command shape: cd && node … | tail', () => {
    assert.deepEqual(parseVaultEditInvocations(vaultEditCommand('kiviri stack', 'wiki-meta/hot.md')),
      [{ vault: 'kiviri stack', path: 'wiki-meta/hot.md', dryRun: false }]);
  });

  test('B1: a hot.md refresh through vault-edit is classified hot, and clears the vault', () => {
    const refresh = bashLine(vaultEditCommand('a', 'wiki-meta/hot.md'), VE_WROTE);
    assert.deepEqual(kinds(refresh), [['/vaults/A', 'hot']]);
    const t = jsonl(toolUseLine(W, { path: 'wiki/note.md', vault: 'a' }), refresh);
    assert.deepEqual(findStaleVaults(t, CTX).stale, []);
  });

  test('B2: a wiki/ note written through vault-edit is classified content, and makes the vault stale', () => {
    const note = bashLine(vaultEditCommand('a', 'wiki/x/note.md'), VE_WROTE);
    assert.deepEqual(kinds(note), [['/vaults/A', 'content']]);
    assert.deepEqual(findStaleVaults(jsonl(note), CTX).stale.map((s) => s.vaultKey), ['/vaults/A']);
  });

  test('B3: a --dry-run is classified other, even when its output claims a write', () => {
    // The output is deliberately the SUCCESS output. The dry-run rule has to
    // decide on its own, not lean on the output check.
    const dry = bashLine(vaultEditCommand('a', 'wiki/x/note.md', { dryRun: true }), VE_WROTE);
    assert.deepEqual(kinds(dry), [['/vaults/A', 'other']]);
    assert.deepEqual(findStaleVaults(jsonl(dry), CTX).stale, []);
    const t = jsonl(toolUseLine(W, { path: 'wiki/note.md', vault: 'a' }),
      bashLine(vaultEditCommand('a', 'wiki-meta/hot.md', { dryRun: true }), VE_WROTE));
    assert.deepEqual(findStaleVaults(t, CTX).stale.map((s) => s.vaultKey), ['/vaults/A']);
  });

  test('a REFUSAL piped through tail (is_error false) is not a write', () => {
    // Measured: `refused: edits[3].to must be a single line` came back with
    // is_error false, because the exit status the transcript records is tail's.
    const t = jsonl(toolUseLine(W, { path: 'wiki/note.md', vault: 'a' }),
      bashLine(vaultEditCommand('a', 'wiki-meta/hot.md'), 'refused: edits[3].to must be a single line'));
    assert.deepEqual(findStaleVaults(t, CTX).stale.map((s) => s.vaultKey), ['/vaults/A']);
    // Nor is a dry-run's own output. ("no change" is not a write either: see
    // its own test.)
    assert.deepEqual(extractWriteToolUses(bashLine(vaultEditCommand('a', 'wiki-meta/hot.md'), '--dry-run : rien écrit')), []);
  });

  test('is_error set by a LATER command does not undo a write the script reported', () => {
    // Claude Code marks the whole Bash call as an error when any command of
    // it exits non-zero: here a `grep -c` finding nothing after the write.
    const cmd = `${vaultEditCommand('a', 'wiki-meta/hot.md')}; grep -c needle x.md`;
    assert.deepEqual(kinds(bashLine(cmd, `Exit code 1\n${VE_WROTE}\n0`, { isError: true })), [['/vaults/A', 'hot']]);
  });

  test('a call that failed and printed no success lines is not a write', () => {
    assert.deepEqual(extractWriteToolUses(bashLine(vaultEditCommand('a', 'wiki/n.md'), 'Exit code 1\nTypeError: fetch failed', { isError: true })), []);
  });

  test('"no change" is NOT a write: re-running an unchanged spec after a block is the slip the guard catches', () => {
    const out = 'no change: wiki-meta/hot.md already has this content — nothing written';
    assert.deepEqual(extractWriteToolUses(bashLine(vaultEditCommand('a', 'wiki-meta/hot.md'), out)), []);
  });

  test('a commit message heredoc with an apostrophe inside "$( )" does not hide the call next to it', () => {
    const cmd = `${vaultEditCommand('a', 'wiki/n.md')}; git commit -m "$(cat <<'EOF'\nFix the user's note.\nEOF\n)"`;
    assert.deepEqual(parseVaultEditInvocations(cmd), [{ vault: 'a', path: 'wiki/n.md', dryRun: false }]);
  });

  test('a stray unquoted backtick is a character, not a reason to drop the command', () => {
    assert.deepEqual(parseVaultEditInvocations('echo a`b; node scripts/vault-edit.mjs --vault a --path wiki/n.md'),
      [{ vault: 'a', path: 'wiki/n.md', dryRun: false }]);
  });

  test('a stray backtick inside double quotes is a character, not a reason to drop the command', () => {
    assert.deepEqual(parseVaultEditInvocations('echo "a`b"; node scripts/vault-edit.mjs --vault a --path wiki/n.md'),
      [{ vault: 'a', path: 'wiki/n.md', dryRun: false }]);
  });

  test('a "$( )" that closes but whose content does not parse stays text, and the call next to it survives', () => {
    // `$'x\'` is an ANSI-C string left open: closeParen finds the `)`, the
    // content does not parse. The other fallback arm (cannot close) is the
    // commit-heredoc test.
    assert.deepEqual(parseVaultEditInvocations('echo "$(echo $\'x\\\')"; node scripts/vault-edit.mjs --vault a --path wiki/n.md'),
      [{ vault: 'a', path: 'wiki/n.md', dryRun: false }]);
  });

  test('an escaped `)` inside "$( )" does not close the substitution early', () => {
    assert.deepEqual(parseVaultEditInvocations('out="$(echo \\) ; node scripts/vault-edit.mjs --vault a --path wiki/n.md)"'),
      [{ vault: 'a', path: 'wiki/n.md', dryRun: false }]);
  });

  test('the script path read by ANOTHER program is not an invocation', () => {
    for (const cmd of ['sed -n \'1,60p\' scripts/vault-edit.mjs', 'ls scripts/vault-edit.mjs && cat scripts/vault-edit.mjs']) {
      assert.deepEqual(parseVaultEditInvocations(cmd), [], cmd);
    }
  });

  test('a COMMENTED-OUT invocation is not an invocation', () => {
    assert.deepEqual(parseVaultEditInvocations('true # node scripts/vault-edit.mjs --vault a --path wiki/n.md'), []);
    assert.deepEqual(parseVaultEditInvocations('# node scripts/vault-edit.mjs --vault a --path wiki/n.md'), []);
  });

  test('an apostrophe inside a COMMENT does not hide the real call after it', () => {
    // Without comment handling, `l'édition` opens a quote that never closes and
    // the whole command is not understood. Since the command-word rule, this
    // is the case that depends on the comment rule alone.
    assert.deepEqual(parseVaultEditInvocations('# on refait l\'édition du hot\nnode scripts/vault-edit.mjs --vault a --path wiki-meta/hot.md'),
      [{ vault: 'a', path: 'wiki-meta/hot.md', dryRun: false }]);
  });

  test('a QUOTED string is one word, so a call spelled inside it is not a call', () => {
    assert.deepEqual(parseVaultEditInvocations('echo "node scripts/vault-edit.mjs --vault a --path wiki/n.md"'), []);
  });

  test('an unbalanced quote is not understood, so nothing is counted', () => {
    assert.deepEqual(parseVaultEditInvocations('node scripts/vault-edit.mjs --vault "a --path wiki/n.md'), []);
  });

  test('two invocations in ONE Bash call count as nothing, even when both wrote', () => {
    // Neither the output nor the command text can say which ran first
    // (`a & b`, `(sleep 2; a) & b`), so none is credited.
    const cmd = `${vaultEditCommand('a', 'wiki/n.md')}; ${vaultEditCommand('a', 'wiki-meta/hot.md')}`;
    assert.equal(parseVaultEditInvocations(cmd).length, 2);
    assert.deepEqual(extractWriteToolUses(bashLine(cmd, `${VE_WROTE}\n${VE_WROTE}`)), []);
  });

  test('two invocations with ONE write printed: the write cannot be attributed → nothing counts', () => {
    const cmd = `${vaultEditCommand('a', 'wiki/n.md')}; ${vaultEditCommand('a', 'wiki-meta/hot.md')}`;
    const out = `${VE_WROTE}\nno change: wiki-meta/hot.md already has this content — nothing written`;
    assert.deepEqual(extractWriteToolUses(bashLine(cmd, out)), []);
  });

  test('a for-loop over `$p`: the path is not expanded, so no note is claimed (a miss, not an invention)', () => {
    const cmd = 'for p in wiki/a.md wiki/b.md; do node scripts/vault-edit.mjs --vault a --path "$p" --spec s.json; done';
    assert.deepEqual(parseVaultEditInvocations(cmd), [{ vault: 'a', path: '$p', dryRun: false }]);
    assert.deepEqual(findStaleVaults(jsonl(bashLine(cmd, `${VE_WROTE}\n${VE_WROTE}`)), CTX).stale, []);
  });

  test('success evidence is the script\'s two-line PAIR: an echoed success line alone is not a second write', () => {
    // A real write echoes the replaced spans. When the new text holds a line
    // that starts like the success line, the old one-line rule counted 2 for
    // 1 call and dropped a real write.
    const echoed = '  edits[0]\n    -  avant\n    +  exemple :\nécrit — casMode: atomic\n' + VE_WROTE;
    assert.deepEqual(kinds(bashLine(vaultEditCommand('a', 'wiki-meta/hot.md'), echoed)), [['/vaults/A', 'hot']]);
  });

  test('a REFUSAL that quotes the success line (its missing anchor) is not a write', () => {
    const forged = 'refused: edits[0]: "\nécrit — casMode: atomic\n" matched 0 times, expected exactly 1';
    assert.deepEqual(extractWriteToolUses(bashLine(vaultEditCommand('a', 'wiki-meta/hot.md'), forged)), []);
  });

  test('a failure AFTER the real size line (409) is not a write, even when an echo spelled the pair before it', () => {
    const out = `  edits[0]\n    -  avant\n    +  x\n${VE_WROTE}\n1 → 2 caractères, précondition 0123456789ab…\n`
      + 'refusé (409) : wiki-meta/hot.md a changé depuis la lecture. Rien n\'a été écrit.';
    assert.deepEqual(extractWriteToolUses(bashLine(vaultEditCommand('a', 'wiki-meta/hot.md'), out)), []);
  });

  test('a failure with NO refusal line after the real size line is not a write (network error)', () => {
    const out = `  edits[0]\n    +  x\n${VE_WROTE}\n1 → 2 caractères, précondition 0123456789ab…\nTypeError: fetch failed`;
    assert.deepEqual(extractWriteToolUses(bashLine(vaultEditCommand('a', 'wiki-meta/hot.md'), out)), []);
  });

  test('an echoed `refused:` line does not veto a REAL write', () => {
    const out = `  edits[0]\n    -  avant\n    +  x\nrefused: exemple documenté\n${VE_WROTE}`;
    assert.deepEqual(kinds(bashLine(vaultEditCommand('a', 'wiki-meta/hot.md'), out)), [['/vaults/A', 'hot']]);
  });

  test('output printed AFTER the success line (verification commands) does not matter', () => {
    // 20 of the 31 real writes measured are followed by such output.
    const cmd = `${vaultEditCommand('a', 'wiki-meta/hot.md')}; echo "mots : $(wc -w < x)"`;
    assert.deepEqual(kinds(bashLine(cmd, `${VE_WROTE}\nmots apres : 499 / 500`)), [['/vaults/A', 'hot']]);
  });

  test('the size line must carry a 12-hex precondition', () => {
    const out = '3276 → 3519 caractères, précondition XYZ…\nécrit — casMode: atomic';
    assert.deepEqual(extractWriteToolUses(bashLine(vaultEditCommand('a', 'wiki-meta/hot.md'), out)), []);
  });

  test('CRLF output is read like LF output', () => {
    assert.deepEqual(kinds(bashLine(vaultEditCommand('a', 'wiki-meta/hot.md'), VE_WROTE.replace(/\n/g, '\r\n') + '\r\n')),
      [['/vaults/A', 'hot']]);
  });

  test('a second MENTION of the script credits nothing, even when it is not a recognised call', () => {
    // The `timeout` call is not recognised, writes, and prints the pair; the
    // recognised call fails. Its output must not be credited to the hot refresh.
    const cmd = 'timeout 60 node scripts/vault-edit.mjs --vault a --path wiki/n.md --spec n.json; '
      + 'node scripts/vault-edit.mjs --vault a --path wiki-meta/hot.md --spec typo.json';
    assert.equal(parseVaultEditInvocations(cmd).length, 1);
    assert.deepEqual(extractWriteToolUses(bashLine(cmd, `${VE_WROTE}\ncannot read spec typo.json: ENOENT`)), []);
  });

  test('OBSIDIAN_ROUTER_CONFIG in the command: another registry, so the vault is not attributed', () => {
    const cmd = 'OBSIDIAN_ROUTER_CONFIG=/tmp/other.json node scripts/vault-edit.mjs --vault a --path wiki-meta/hot.md --spec s.json';
    assert.deepEqual(parseVaultEditInvocations(cmd), [{ vault: undefined, path: 'wiki-meta/hot.md', dryRun: false }]);
  });

  test('a call behind `if` / `while` is recognised', () => {
    assert.deepEqual(parseVaultEditInvocations('if node scripts/vault-edit.mjs --vault a --path wiki/n.md --spec s.json; then echo ok; fi'),
      [{ vault: 'a', path: 'wiki/n.md', dryRun: false }]);
  });

  test('a call behind `while` is recognised', () => {
    assert.deepEqual(parseVaultEditInvocations('while node scripts/vault-edit.mjs --vault a --path wiki/n.md --spec s.json; do sleep 1; done'),
      [{ vault: 'a', path: 'wiki/n.md', dryRun: false }]);
  });

  test('a call behind `until` is recognised', () => {
    assert.deepEqual(parseVaultEditInvocations('until node scripts/vault-edit.mjs --vault a --path wiki/n.md --spec s.json; do sleep 1; done'),
      [{ vault: 'a', path: 'wiki/n.md', dryRun: false }]);
  });

  test('a call inside `$( )` within DOUBLE quotes runs, so it is recognised', () => {
    assert.deepEqual(parseVaultEditInvocations('out="$(node scripts/vault-edit.mjs --vault a --path wiki-meta/hot.md --spec s.json)"; printf \'%s\\n\' "$out"'),
      [{ vault: 'a', path: 'wiki-meta/hot.md', dryRun: false }]);
  });

  test('a call inside an unquoted `$( )` is recognised', () => {
    assert.deepEqual(parseVaultEditInvocations('echo $(node scripts/vault-edit.mjs --vault a --path wiki-meta/hot.md --spec s.json)'),
      [{ vault: 'a', path: 'wiki-meta/hot.md', dryRun: false }]);
  });

  test('a call inside BACKTICKS within double quotes is recognised', () => {
    assert.deepEqual(parseVaultEditInvocations('out="`node scripts/vault-edit.mjs --vault a --path wiki-meta/hot.md --spec s.json`"'),
      [{ vault: 'a', path: 'wiki-meta/hot.md', dryRun: false }]);
  });

  test('a call inside BACKTICKS is recognised', () => {
    assert.deepEqual(parseVaultEditInvocations('out=`node scripts/vault-edit.mjs --vault a --path wiki-meta/hot.md --spec s.json`'),
      [{ vault: 'a', path: 'wiki-meta/hot.md', dryRun: false }]);
  });

  test('a bare arithmetic command `(( … ))` with a shift is not a heredoc', () => {
    assert.deepEqual(parseVaultEditInvocations('(( x = 1<<3 ))\nnode scripts/vault-edit.mjs --vault a --path wiki/n.md'),
      [{ vault: 'a', path: 'wiki/n.md', dryRun: false }]);
  });

  test('a heredoc feeding the call itself, with no closing delimiter, keeps the call', () => {
    // bash runs the body to the end of the input; the call is on the line
    // that opens the heredoc, so it runs.
    assert.deepEqual(parseVaultEditInvocations('node scripts/vault-edit.mjs --vault a --path wiki/n.md --spec /dev/stdin <<EOF\n{"edits":[]}'),
      [{ vault: 'a', path: 'wiki/n.md', dryRun: false }]);
  });

  test('a shift inside `$(( ))` is not a heredoc', () => {
    assert.deepEqual(parseVaultEditInvocations('echo $((1<<3))\nnode scripts/vault-edit.mjs --vault a --path wiki/n.md'),
      [{ vault: 'a', path: 'wiki/n.md', dryRun: false }]);
  });

  test('ANSI-C quoting `$\'…\'` with an escaped quote does not leave a quote open', () => {
    assert.deepEqual(parseVaultEditInvocations('echo $\'it\\\'s\'; node scripts/vault-edit.mjs --vault a --path wiki/n.md'),
      [{ vault: 'a', path: 'wiki/n.md', dryRun: false }]);
  });

  test('a heredoc whose delimiter never comes runs to the end of the input, as in bash', () => {
    assert.deepEqual(parseVaultEditInvocations('cat <<EOF\nnode scripts/vault-edit.mjs --vault a --path wiki/n.md'), []);
  });

  test('the success line must FOLLOW the size line directly, not appear later in the output', () => {
    // A failure right after the real size line, then a success line printed by
    // a later command (a log read back, a grep): not a write.
    const out = '1 → 2 caractères, précondition 0123456789ab…\nError: boom\nécrit — casMode: atomic';
    assert.deepEqual(extractWriteToolUses(bashLine(vaultEditCommand('a', 'wiki-meta/hot.md'), out)), []);
  });

  test('a heredoc delimiter line ending in CR is still the delimiter', () => {
    assert.deepEqual(parseVaultEditInvocations('cat <<EOF\r\nx\r\nEOF\r\nnode scripts/vault-edit.mjs --vault a --path wiki/n.md'),
      [{ vault: 'a', path: 'wiki/n.md', dryRun: false }]);
  });

  test('`<<<` is a here-string, not a heredoc', () => {
    assert.deepEqual(parseVaultEditInvocations('cat <<< hello; node scripts/vault-edit.mjs --vault a --path wiki/n.md'),
      [{ vault: 'a', path: 'wiki/n.md', dryRun: false }]);
  });

  test('a file-descriptor redirection before node (`2>/dev/null node …`) keeps node as the command', () => {
    assert.deepEqual(parseVaultEditInvocations('2>/dev/null node scripts/vault-edit.mjs --vault a --path wiki/n.md'),
      [{ vault: 'a', path: 'wiki/n.md', dryRun: false }]);
  });

  test('node -p alone (short print flag) is not an invocation', () => {
    assert.deepEqual(parseVaultEditInvocations('node -p \'//scripts/vault-edit.mjs\' --vault a --path wiki-meta/hot.md'), []);
  });

  test('a HEREDOC body is data: a call spelled inside it is not a call', () => {
    const body = 'cat > /tmp/x.md <<\'EOF\'\nnode scripts/vault-edit.mjs --vault a --path wiki-meta/hot.md --spec s.json\nEOF';
    assert.deepEqual(parseVaultEditInvocations(body), []);
  });

  test('a heredoc with an apostrophe in its body does not hide the real call after it', () => {
    const cmd = 'cat > /tmp/hot.md <<\'EOF\'\n# Hot\nL\'audit est fait.\nEOF\n'
      + 'node scripts/vault-edit.mjs --vault a --path wiki-meta/hot.md --spec s.json 2>&1 | tail -3';
    assert.deepEqual(parseVaultEditInvocations(cmd), [{ vault: 'a', path: 'wiki-meta/hot.md', dryRun: false }]);
    const tabbed = 'cat <<-END\n\tnode scripts/vault-edit.mjs --vault a --path wiki/n.md\n\tEND\nnode scripts/vault-edit.mjs --vault a --path wiki/m.md';
    assert.deepEqual(parseVaultEditInvocations(tabbed), [{ vault: 'a', path: 'wiki/m.md', dryRun: false }]);
  });

  test('node must be the COMMAND: an argument spelled `node` is not an invocation', () => {
    assert.deepEqual(parseVaultEditInvocations('printf \'%s\\n\' node scripts/vault-edit.mjs --vault a --path wiki-meta/hot.md'), []);
  });

  test('node -e / -p runs source TEXT: a script path in it is not an invocation', () => {
    for (const cmd of [
      'node -e \'//scripts/vault-edit.mjs\' -- --vault a --path wiki-meta/hot.md',
      'node --input-type=module -e x scripts/vault-edit.mjs --vault a --path wiki-meta/hot.md',
      'node -p 1 scripts/vault-edit.mjs --vault a --path wiki-meta/hot.md',
    ]) {
      assert.deepEqual(parseVaultEditInvocations(cmd), [], cmd);
    }
  });

  test('node options are skipped, including those that take a value, and VAR= prefixes', () => {
    const want = [{ vault: 'a', path: 'wiki/n.md', dryRun: false }];
    assert.deepEqual(parseVaultEditInvocations('node --require ./noop.cjs scripts/vault-edit.mjs --vault a --path wiki/n.md'), want);
    assert.deepEqual(parseVaultEditInvocations('FOO=1 node --no-warnings scripts/vault-edit.mjs --vault a --path wiki/n.md'), want);
    assert.deepEqual(parseVaultEditInvocations('node --disable-warning ExperimentalWarning scripts/vault-edit.mjs --vault a --path wiki/n.md'), want);
  });

  test('`>|` is a clobber redirection, not a pipe: its target cannot start a phantom call', () => {
    assert.deepEqual(parseVaultEditInvocations('echo x >| node scripts/vault-edit.mjs --vault a --path wiki/n.md'), []);
  });

  test('a redirection TARGET is not a word: a leading `> file` keeps node as the command', () => {
    assert.deepEqual(parseVaultEditInvocations('> /tmp/o.txt node scripts/vault-edit.mjs --vault a --path wiki/n.md'),
      [{ vault: 'a', path: 'wiki/n.md', dryRun: false }]);
  });

  test('--config: another registry names the vault, so the target is skipped, not attributed', () => {
    const cmd = 'node scripts/vault-edit.mjs --config other.json --vault a --path wiki/n.md --spec s.json';
    assert.deepEqual(parseVaultEditInvocations(cmd), [{ vault: undefined, path: 'wiki/n.md', dryRun: false }]);
    assert.deepEqual(findStaleVaults(jsonl(bashLine(cmd, VE_WROTE)), CTX).stale, []);
  });

  test('a `;` inside DOUBLE quotes does not split the command', () => {
    assert.deepEqual(parseVaultEditInvocations('echo "a; node scripts/vault-edit.mjs --vault a --path wiki/n.md"'), []);
  });

  test('a `;` inside SINGLE quotes does not split the command', () => {
    assert.deepEqual(parseVaultEditInvocations('echo \'a; node scripts/vault-edit.mjs --vault a --path wiki/n.md\''), []);
  });

  test('an unknown vault is skipped, never claimed (fail-open, as for MCP)', () => {
    assert.deepEqual(findStaleVaults(jsonl(bashLine(vaultEditCommand('nope', 'wiki/n.md'), VE_WROTE)), CTX).stale, []);
  });
});

// ---------------------------------------------------------------------------
// Hook end-to-end (subprocess)
// ---------------------------------------------------------------------------

describe('hot-cache-update-prompt hook (subprocess)', () => {
  let workDir, vaultPath, configPath, transcriptPath, projectDir, homeDir;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-guard-'));
    homeDir = path.join(workDir, 'home');
    fs.mkdirSync(homeDir, { recursive: true });
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

  // A real transcript starts with the run-start marker (the router installs its
  // own SessionStart hook), so the fixtures do too by default. Without one, the
  // guard cannot bound the run and fails open, which `{ marker: false }` tests.
  // The child gets a throwaway home, as every test child must.
  function run(transcriptLines, { stopHookActive = false, env = {}, marker = true } = {}) {
    const lines = marker ? [sessionStartLine('startup'), ...transcriptLines] : transcriptLines;
    fs.writeFileSync(transcriptPath, lines.join('\n') + '\n');
    const stdin = JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcriptPath, stop_hook_active: stopHookActive });
    const childEnv = homeSafeEnv(homeDir, { OBSIDIAN_ROUTER_CONFIG: configPath, CLAUDE_PROJECT_DIR: projectDir, ...env });
    delete childEnv.OBSIDIAN_ROUTER_DEFAULT_VAULT;
    if (!('OBSIDIAN_ROUTER_NO_HOT_CACHE_GUARD' in env)) delete childEnv.OBSIDIAN_ROUTER_NO_HOT_CACHE_GUARD;
    return spawnSync(process.execPath, [HOOK_PATH], { input: stdin, encoding: 'utf8', env: childEnv });
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

  const NOTE = (p = 'wiki/note.md') => toolUseLine('mcp__obsidian-router__write_file', { path: p, vault: 'fake-vault' });
  const HOT = () => toolUseLine('mcp__obsidian-router__write_file', { path: 'wiki-meta/hot.md', vault: 'fake-vault' });

  test('A1: a note written only before the RESUME does not block', () => {
    // Control first: without the resume marker, the same note blocks.
    assert.equal(run([NOTE()]).status, 2);
    const r = run([NOTE(), sessionStartLine('resume')]);
    assert.equal(r.status, 0, r.stderr);
  });

  test('A2: a note written after the resume, not refreshed, still blocks', () => {
    const r = run([HOT(), sessionStartLine('resume'), NOTE()]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /fake-vault/);
  });

  test('A3: no run-start marker at all → exit 0, even with an unrefreshed note', () => {
    const r = run([NOTE()], { marker: false });
    assert.equal(r.status, 0, r.stderr);
  });

  test('A3 is not SILENT: without a marker, a vault it would have claimed is named (systemMessage)', () => {
    // 20 of 403 measured sessions ran this guard without a marker; failing open
    // there must be visible, or the guard is switched off unnoticed.
    const r = run([NOTE()], { marker: false });
    assert.equal(r.status, 0, r.stderr);
    assert.match(JSON.parse(r.stdout.trim()).systemMessage, /fake-vault/);
  });

  test('A3 without a marker stays QUIET when nothing would have been claimed', () => {
    const quiet = run([NOTE(), HOT()], { marker: false });
    assert.equal(quiet.status, 0, quiet.stderr);
    assert.equal(quiet.stdout, '');
  });

  test('B: a hot refresh through vault-edit clears; a note through it blocks; a dry-run does neither', () => {
    const cmd = (p, o) => vaultEditCommand('fake-vault', p, o);
    assert.equal(run([NOTE(), bashLine(cmd('wiki-meta/hot.md'), VE_WROTE)]).status, 0);
    const blocked = run([bashLine(cmd('wiki/n.md'), VE_WROTE)]);
    assert.equal(blocked.status, 2, blocked.stderr);
    assert.match(blocked.stderr, /fake-vault/);
    assert.equal(run([bashLine(cmd('wiki/n.md', { dryRun: true }), VE_WROTE)]).status, 0);
  });

  test('C1: the size check still blocks on an oversized hot.md of a vault touched in this run, only this run', () => {
    const hotPath = path.join(vaultPath, 'wiki-meta', 'hot.md');
    fs.writeFileSync(hotPath, `# Hot\n\n${'mot '.repeat(20000)}\n`);
    try {
      const r = run([NOTE(), HOT()]); // fresh, but oversized
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /HORS LIMITE/);
      assert.doesNotMatch(r.stderr, /Tu as écrit des notes/);
      // The same vault touched only in an earlier run is not this run's debt.
      const old = run([NOTE(), HOT(), sessionStartLine('resume')]);
      assert.equal(old.status, 0, old.stderr);
    } finally {
      fs.rmSync(hotPath, { force: true });
    }
  });

  test('no transcript path → exit 0 (fail-open)', () => {
    const stdin = JSON.stringify({ hook_event_name: 'Stop' });
    const childEnv = homeSafeEnv(homeDir, { OBSIDIAN_ROUTER_CONFIG: configPath, CLAUDE_PROJECT_DIR: projectDir });
    delete childEnv.OBSIDIAN_ROUTER_DEFAULT_VAULT;
    const r = spawnSync(process.execPath, [HOOK_PATH], { input: stdin, encoding: 'utf8', env: childEnv });
    assert.equal(r.status, 0, r.stderr);
  });
});

// ---------------------------------------------------------------------------
// Defect B against the REAL script — its real output, not a copy of it
// ---------------------------------------------------------------------------

/**
 * The guard decides a vault-edit call wrote by reading the script's own success
 * line. A fixture that copies that line proves only the copy. Here the real
 * `scripts/vault-edit.mjs` runs against a stand-in vault (an old bridge: no
 * `/vault-cas/` route, so the write takes the GET-compare fallback), and what it
 * printed, cut the way `2>&1 | tail -4` cuts it, becomes the tool result.
 */
describe('vault-edit.mjs, real run → the guard reads its real output', () => {
  const REPO = path.resolve(__dirname, '..');
  const SCRIPT = path.join(REPO, 'scripts', 'vault-edit.mjs');
  const NOTE_PATH = 'wiki/x/note.md';
  let dir, server, store, configPath, homeDir;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-guard-ve-'));
    homeDir = path.join(dir, 'home');
    fs.mkdirSync(homeDir);
    store = new Map([[NOTE_PATH, 'avant\n'], ['wiki-meta/hot.md', '# Hot\n\navant\n']]);
    server = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const url = decodeURIComponent(req.url);
        if (url === '/') { res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"OK"}'); return; }
        if (!url.startsWith('/vault/')) { res.writeHead(404).end('not found'); return; }
        const rel = url.slice('/vault/'.length);
        if (req.method === 'PUT') { store.set(rel, body); res.writeHead(204).end(); return; }
        if (!store.has(rel)) { res.writeHead(404).end('not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/markdown' }).end(store.get(rel));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      portRegistry: {},
      remoteVaults: [{ name: 'fake', baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'k', timeoutMs: 5000 }],
    }));
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Run the real script; return the command as a transcript would show it, and `2>&1 | tail -4`. */
  function vaultEdit(relPath, edits, { dryRun = false } = {}) {
    const spec = path.join(dir, `spec-${nextToolUseId()}.json`);
    fs.writeFileSync(spec, JSON.stringify({ edits }));
    const args = ['--vault', 'fake', '--path', relPath, '--spec', spec, ...(dryRun ? ['--dry-run'] : [])];
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [SCRIPT, ...args], {
        cwd: REPO, env: homeSafeEnv(homeDir, { OBSIDIAN_ROUTER_CONFIG: configPath }),
      });
      let both = '';
      child.stdout.on('data', (c) => { both += c; });
      child.stderr.on('data', (c) => { both += c; });
      child.on('close', (code) => resolve({
        code,
        command: `node scripts/vault-edit.mjs ${args.map((a) => JSON.stringify(a)).join(' ')} 2>&1 | tail -4`,
        output: both.trimEnd().split('\n').slice(-4).join('\n'),
      }));
    });
  }

  const ctx = { vaultRoots: ['/vaults/F'], slugToRoot: (s) => (s === 'fake' ? '/vaults/F' : null), defaultRoot: null, isWin: false };
  const staleOf = (...lines) => findStaleVaults(jsonl(...lines), ctx).stale.map((s) => s.vaultKey);

  test('a real note write counts as content; a real hot write then clears the vault', async () => {
    const note = await vaultEdit(NOTE_PATH, [{ kind: 'unique', from: 'avant', to: 'note-v1' }]);
    assert.equal(note.code, 0, note.output);
    assert.equal(store.get(NOTE_PATH), 'note-v1\n'); // it really wrote
    const noteLine = bashLine(note.command, note.output);
    assert.deepEqual(staleOf(noteLine), ['/vaults/F']);

    const hot = await vaultEdit('wiki-meta/hot.md', [{ kind: 'unique', from: 'avant', to: 'hot-v1' }]);
    assert.equal(hot.code, 0, hot.output);
    assert.deepEqual(staleOf(noteLine, bashLine(hot.command, hot.output)), []);
  });

  test('a real --dry-run and a real refusal write nothing, and neither clears the vault', async () => {
    const note = await vaultEdit(NOTE_PATH, [{ kind: 'unique', from: 'note-v1', to: 'note-v2' }]);
    assert.equal(note.code, 0, note.output);
    const noteLine = bashLine(note.command, note.output);
    // Control: the note alone makes the vault stale. Without it, "still stale"
    // below could not be told apart from "the note was never counted".
    assert.deepEqual(staleOf(noteLine), ['/vaults/F']);

    const before = store.get('wiki-meta/hot.md');
    const dry = await vaultEdit('wiki-meta/hot.md', [{ kind: 'unique', from: 'hot-v1', to: 'hot-v2' }], { dryRun: true });
    assert.equal(dry.code, 0, dry.output);
    const refused = await vaultEdit('wiki-meta/hot.md', [{ kind: 'unique', from: 'absent-anchor', to: 'x' }]);
    assert.equal(refused.code, 1, refused.output);
    assert.equal(store.get('wiki-meta/hot.md'), before); // nothing was written

    // Piped through tail, both come back with is_error false, as measured.
    assert.deepEqual(staleOf(noteLine, bashLine(dry.command, dry.output)), ['/vaults/F']);
    assert.deepEqual(staleOf(noteLine, bashLine(refused.command, refused.output)), ['/vaults/F']);
  });
});
