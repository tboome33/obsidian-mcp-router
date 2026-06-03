/**
 * Tests for the deterministic hot-cache freshness guard:
 *   - src/helpers/hot-staleness.mjs  (pure logic — the bulk of coverage)
 *   - hooks/hot-cache-update-prompt.mjs  (end-to-end via spawnSync)
 *
 * The pure layer is tested directly (fast, no fs). The hook is smoke-tested
 * as a subprocess feeding a synthetic transcript JSONL + a temp router
 * config via OBSIDIAN_ROUTER_CONFIG, mirroring tests/vault-link-linter.test.mjs.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  isWriteToolName,
  isBuiltinWriteTool,
  extractWriteToolUses,
  targetsFromToolUse,
  pathKind,
  classifyToolUse,
  findStaleVaults,
} from '../src/helpers/hot-staleness.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HOOK_PATH = path.resolve(__dirname, '..', 'hooks', 'hot-cache-update-prompt.mjs');

// ---------------------------------------------------------------------------
// Helpers for building synthetic transcripts
// ---------------------------------------------------------------------------

/** One assistant message line carrying a single tool_use block. */
function toolUseLine(name, input) {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name, input }] },
  });
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
// isWriteToolName / isBuiltinWriteTool
// ---------------------------------------------------------------------------

describe('isWriteToolName', () => {
  test('built-in write tools', () => {
    for (const n of ['Write', 'Edit', 'MultiEdit']) assert.equal(isWriteToolName(n), true, n);
    assert.equal(isBuiltinWriteTool('Edit'), true);
  });
  test('local MCP write tools', () => {
    for (const v of ['write_file', 'patch_file', 'append_to_file', 'set_frontmatter', 'merge_frontmatter', 'move_file', 'delete_file', 'execute_template']) {
      assert.equal(isWriteToolName('mcp__obsidian-router__' + v), true, v);
    }
  });
  test('MCPHub-namespaced write tools (hyphen before verb)', () => {
    assert.equal(isWriteToolName('mcp__5f30__obsidian-router-Tribu-write_file'), true);
  });
  test('non-write tools are rejected', () => {
    for (const n of ['Read', 'Bash', 'Grep', 'mcp__obsidian-router__search', 'mcp__obsidian-router__get_file', 'mcp__obsidian-router__list_vaults']) {
      assert.equal(isWriteToolName(n), false, n);
    }
  });
  test('garbage input', () => {
    assert.equal(isWriteToolName(null), false);
    assert.equal(isWriteToolName(''), false);
    assert.equal(isWriteToolName(42), false);
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
  test('MCP carries relative path + vault slug', () => {
    const t = targetsFromToolUse({ toolName: 'mcp__obsidian-router__write_file', input: { path: 'wiki/a.md', vault: 'smile' } });
    assert.deepEqual(t.relPaths, ['wiki/a.md']);
    assert.equal(t.vaultSlug, 'smile');
  });
  test('move_file contributes destination too', () => {
    const t = targetsFromToolUse({ toolName: 'mcp__obsidian-router__move_file', input: { path: 'wiki/a.md', destination: 'wiki/b.md' } });
    assert.deepEqual(t.relPaths.sort(), ['wiki/a.md', 'wiki/b.md']);
  });
});

// ---------------------------------------------------------------------------
// extractWriteToolUses
// ---------------------------------------------------------------------------

describe('extractWriteToolUses', () => {
  test('returns only write-flavored tool_use blocks', () => {
    const t = jsonl(
      textLine('some prose'),
      toolUseLine('mcp__obsidian-router__write_file', { path: 'wiki/a.md', vault: 'a' }),
      toolUseLine('mcp__obsidian-router__search', { query: 'x' }),
      toolUseLine('Read', { file_path: '/x' }),
      toolUseLine('Edit', { file_path: '/vaults/A/wiki/b.md' }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x' }] } }),
    );
    const got = extractWriteToolUses(t);
    assert.equal(got.length, 2);
    assert.equal(got[0].toolName, 'mcp__obsidian-router__write_file');
    assert.equal(got[1].toolName, 'Edit');
  });
  test('skips malformed lines, tolerates empty', () => {
    assert.deepEqual(extractWriteToolUses(''), []);
    const t = 'not json\n' + toolUseLine('Write', { file_path: '/vaults/A/wiki/x.md' }) + '\n{bad';
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

  test('Windows case-insensitive root matching', () => {
    const winCtx = { vaultRoots: ['C:\\VAULTS\\X'], slugToRoot: () => null, defaultRoot: null, isWin: true };
    const t = jsonl(toolUseLine('Edit', { file_path: 'C:/VAULTS/X/wiki/a.md' }));
    const { stale } = findStaleVaults(t, winCtx);
    assert.equal(stale.length, 1);
  });

  test('empty transcript → not stale', () => {
    assert.equal(findStaleVaults('', CTX).stale.length, 0);
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

  test('passes (exit 0) when only scaffolds touched', () => {
    const r = run([toolUseLine('mcp__obsidian-router__patch_file', { path: 'wiki-meta/index.md', vault: 'fake-vault' })]);
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
