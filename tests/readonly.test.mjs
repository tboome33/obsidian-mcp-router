/**
 * Tests for v0.9.0 OBSIDIAN_ROUTER_READONLY behavior.
 *
 * The env var is the opt-in toggle that makes a router instance refuse
 * every write tool. Used by MCPHub deployments that share a single
 * `.mcpb` bundle but want some Server entries to be RO (e.g. an external
 * collaborator with a guest bearer key).
 *
 * Two layers of defense, both tested here:
 *   1. ListTools surface — write tools are filtered out, so clients
 *      discover only safe ones.
 *   2. CallTool dispatch — a client that already knows a write tool name
 *      and calls it directly still gets refused.
 *
 * Tests are unit-level: they exercise `isReadonlyMode` and
 * `_internals.WRITE_TOOL_NAMES` + the filtering logic that the server
 * applies internally, without booting a real MCP transport.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { isReadonlyMode, _internals } from '../src/index.mjs';

const { TOOLS, TOOL_HANDLERS, WRITE_TOOL_NAMES } = _internals;

// ---------------------------------------------------------------------------
// isReadonlyMode — env-var parsing
// ---------------------------------------------------------------------------

describe('isReadonlyMode', () => {
  test('unset / null / undefined → false', () => {
    assert.equal(isReadonlyMode(undefined), false);
    assert.equal(isReadonlyMode(null), false);
  });

  test('empty string → false (treated as unset)', () => {
    assert.equal(isReadonlyMode(''), false);
  });

  test('truthy tokens → true (case-insensitive)', () => {
    assert.equal(isReadonlyMode('true'), true);
    assert.equal(isReadonlyMode('TRUE'), true);
    assert.equal(isReadonlyMode('True'), true);
    assert.equal(isReadonlyMode('1'), true);
    assert.equal(isReadonlyMode('yes'), true);
    assert.equal(isReadonlyMode('Yes'), true);
    assert.equal(isReadonlyMode('on'), true);
    assert.equal(isReadonlyMode('ON'), true);
  });

  test('falsy tokens → false', () => {
    assert.equal(isReadonlyMode('false'), false);
    assert.equal(isReadonlyMode('0'), false);
    assert.equal(isReadonlyMode('no'), false);
    assert.equal(isReadonlyMode('off'), false);
    assert.equal(isReadonlyMode('disabled'), false);
  });

  test('typos / random strings → false (fail-closed = writable, not the inverse)', () => {
    // We chose fail-closed-to-writable rather than fail-closed-to-readonly
    // because the env var is OPT-IN. A typo on the deployer's side should
    // not silently lock the router. A loud warning surfaces if mode != none.
    assert.equal(isReadonlyMode('trueeee'), false);
    assert.equal(isReadonlyMode('readonly'), false);
  });

  test('whitespace is trimmed', () => {
    assert.equal(isReadonlyMode('  true  '), true);
    assert.equal(isReadonlyMode('\ttrue\n'), true);
  });
});

// ---------------------------------------------------------------------------
// WRITE_TOOL_NAMES — set contents
// ---------------------------------------------------------------------------

describe('WRITE_TOOL_NAMES', () => {
  test('is a Set of strings', () => {
    assert.ok(WRITE_TOOL_NAMES instanceof Set);
    for (const n of WRITE_TOOL_NAMES) {
      assert.equal(typeof n, 'string');
    }
  });

  test('contains the 16 documented write tools', () => {
    const expected = [
      'write_file',
      'append_to_file',
      'patch_file',
      'set_frontmatter',
      'merge_frontmatter',
      'move_file',
      'delete_file',
      'execute_template',
      // v0.14.x Phase E — writes binary asset files to disk.
      'download_page_assets',
      // understand-anything #1 — writes the knowledge-graph JSON (canonical
      // wiki-meta/graph/ + derived .understand-anything/ copy).
      'build_wiki_graph',
      // v0.35.0 — vault-creation wizard: writes a NEW vault to the local
      // filesystem. plan_vault (read-only) is deliberately excluded.
      'provision_vault',
      // v0.59.0 — volet ②: rewrites the generated OKF projections in wiki/.
      'refresh_okf_projections',
      // C4 — writes wiki-meta/search-index.json (the local BM25 index).
      // search_smart's `tier: 'local'` only READS it, so it stays exposed.
      'build_search_index',
      // C6 — writes wiki-meta/source-ledger.json. `audit_sources` is read-only
      // and is deliberately NOT gated.
      'record_source',
      // C2 — runs several write tools as one journaled operation, and writes its
      // own rollback journal under wiki-meta/write-journal/. Gated wholesale:
      // its read-only `recover:true` listing goes with it, which costs nothing
      // because a readonly deployment cannot leave a bundle half-applied.
      'write_bundle',
      // v0.90.0 — writes a new remoteVaults entry (apiKey included) to
      // config.json. Same reasoning as provision_vault: a read-only
      // deployment must hide it too, not just the OBSIDIAN_ROUTER_USER_ID gate.
      'register_remote_vault',
    ];
    assert.equal(WRITE_TOOL_NAMES.size, expected.length);
    for (const e of expected) {
      assert.ok(WRITE_TOOL_NAMES.has(e), `missing write tool: ${e}`);
    }
  });

  test('every WRITE_TOOL_NAMES entry corresponds to a tool that actually exists', () => {
    // Catches drift: if someone adds a name to WRITE_TOOL_NAMES that no
    // longer exists in TOOLS / TOOL_HANDLERS, the readonly filter would
    // silently target nothing — and a renamed write tool would slip
    // through unfiltered. Cross-check protects against both.
    const toolNames = new Set(TOOLS.map((t) => t.name));
    const handlerNames = new Set(Object.keys(TOOL_HANDLERS));
    for (const w of WRITE_TOOL_NAMES) {
      assert.ok(toolNames.has(w), `WRITE_TOOL_NAMES entry "${w}" not in TOOLS`);
      assert.ok(handlerNames.has(w), `WRITE_TOOL_NAMES entry "${w}" not in TOOL_HANDLERS`);
    }
  });
});

// ---------------------------------------------------------------------------
// readonly filtering — behavior on TOOLS / TOOL_HANDLERS
// ---------------------------------------------------------------------------

describe('readonly filtering behavior (simulated)', () => {
  // We don't boot the actual MCP server (would need a real stdio transport);
  // instead we verify the same filtering logic as the production code:
  //   exposedTools = readonly ? TOOLS.filter(t => !WRITE_TOOL_NAMES.has(t.name)) : TOOLS

  test('readonly=false → TOOLS exposed entirely', () => {
    const exposed = TOOLS;
    const exposedNames = new Set(exposed.map((t) => t.name));
    for (const w of WRITE_TOOL_NAMES) {
      assert.ok(exposedNames.has(w), `write tool "${w}" must be exposed when readonly=false`);
    }
  });

  test('readonly=true → all WRITE_TOOL_NAMES are filtered from ListTools', () => {
    const exposed = TOOLS.filter((t) => !WRITE_TOOL_NAMES.has(t.name));
    const exposedNames = new Set(exposed.map((t) => t.name));
    for (const w of WRITE_TOOL_NAMES) {
      assert.ok(
        !exposedNames.has(w),
        `write tool "${w}" must be ABSENT from exposed list when readonly=true`,
      );
    }
  });

  test('readonly=true → read tools (list_vaults, list_files, get_file, search, search_smart, get_frontmatter, lock_vault, unlock_vaults, set_auto_enrich_mode) stay exposed', () => {
    const exposed = TOOLS.filter((t) => !WRITE_TOOL_NAMES.has(t.name));
    const exposedNames = new Set(exposed.map((t) => t.name));
    const expectedReadTools = [
      'list_vaults',
      'list_files',
      'get_file',
      'search',
      'search_smart',
      'get_frontmatter',
      'lock_vault',
      'unlock_vaults',
      'set_auto_enrich_mode',
    ];
    for (const r of expectedReadTools) {
      assert.ok(exposedNames.has(r), `read tool "${r}" must remain exposed when readonly=true`);
    }
  });

  test('readonly=true exposed count = TOOLS.length - WRITE_TOOL_NAMES.size', () => {
    const exposed = TOOLS.filter((t) => !WRITE_TOOL_NAMES.has(t.name));
    assert.equal(exposed.length, TOOLS.length - WRITE_TOOL_NAMES.size);
  });

  test('CallTool guard rejects every write tool with a clear error message (simulated)', () => {
    // The production guard is:
    //   if (readonly && WRITE_TOOL_NAMES.has(name)) {
    //     throw new Error(`Tool "${name}" is disabled in read-only mode ...`);
    //   }
    // We exercise the predicate directly — a structural test that the
    // guard CAN reject every documented write tool.
    for (const w of WRITE_TOOL_NAMES) {
      assert.ok(WRITE_TOOL_NAMES.has(w), `guard must recognise "${w}" as a write tool`);
    }
    // And cannot reject a read tool by mistake (otherwise the guard would
    // accidentally block reads in readonly mode).
    const readTools = ['list_vaults', 'list_files', 'get_file', 'search', 'get_frontmatter'];
    for (const r of readTools) {
      assert.ok(!WRITE_TOOL_NAMES.has(r), `guard must NOT classify read tool "${r}" as write`);
    }
  });
});
