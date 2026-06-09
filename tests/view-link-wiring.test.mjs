/**
 * Wiring tests for Option B: the `VIEW_LINK_TOOLS` set (which write tools auto-inject a
 * `viewLink`) and `computeExposedTools` (exposure gating — readonly + view-agent config).
 * Imports the module `_internals` (the module loads + exits cleanly, no MCP transport).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { _internals } from '../src/index.mjs';

const { TOOLS, WRITE_TOOL_NAMES, VIEW_LINK_TOOLS, computeExposedTools } = _internals;
const nameSet = (arr) => new Set(arr.map((t) => t.name));

describe('VIEW_LINK_TOOLS — note-write tools that get a deterministic viewLink', () => {
  test('is exactly the 6 note-write tools', () => {
    assert.deepEqual(
      [...VIEW_LINK_TOOLS].sort(),
      ['append_to_file', 'merge_frontmatter', 'move_file', 'patch_file', 'set_frontmatter', 'write_file'].sort(),
    );
  });

  test('excludes non-note writes + reads (no link for those)', () => {
    for (const n of [
      'delete_file',
      'download_page_assets',
      'build_wiki_graph',
      'execute_template',
      'get_file',
      'get_view_link',
    ]) {
      assert.equal(VIEW_LINK_TOOLS.has(n), false, `${n} must NOT auto-inject a viewLink`);
    }
  });

  test('every VIEW_LINK_TOOL is also a write tool (consistency)', () => {
    for (const n of VIEW_LINK_TOOLS) {
      assert.ok(WRITE_TOOL_NAMES.has(n), `${n} should be in WRITE_TOOL_NAMES`);
    }
  });

  test('get_view_link itself is read-only (not a write tool) but is in the catalog', () => {
    assert.equal(WRITE_TOOL_NAMES.has('get_view_link'), false);
    assert.ok(nameSet(TOOLS).has('get_view_link'));
  });
});

describe('computeExposedTools — exposure gating (readonly + view-agent)', () => {
  test('view-agent configured → get_view_link exposed', () => {
    const out = nameSet(computeExposedTools(TOOLS, { readonly: false, viewAgentConfigured: true }));
    assert.ok(out.has('get_view_link'));
    assert.ok(out.has('write_file'));
  });

  test('view-agent UNconfigured → get_view_link hidden (geste 1), other tools intact', () => {
    const out = nameSet(computeExposedTools(TOOLS, { readonly: false, viewAgentConfigured: false }));
    assert.equal(out.has('get_view_link'), false);
    assert.ok(out.has('write_file'));
    assert.ok(out.has('get_file'));
  });

  test('readonly hides write tools, but a configured view-agent keeps the read-only get_view_link', () => {
    const out = nameSet(computeExposedTools(TOOLS, { readonly: true, viewAgentConfigured: true }));
    assert.equal(out.has('write_file'), false);
    assert.ok(out.has('get_view_link'));
    assert.ok(out.has('get_file'));
  });

  test('readonly + unconfigured → both filters apply', () => {
    const out = nameSet(computeExposedTools(TOOLS, { readonly: true, viewAgentConfigured: false }));
    assert.equal(out.has('write_file'), false);
    assert.equal(out.has('get_view_link'), false);
  });

  test('default opts (no gates) → unconfigured behaviour (get_view_link hidden, no crash)', () => {
    const out = nameSet(computeExposedTools(TOOLS));
    assert.equal(out.has('get_view_link'), false);
    assert.ok(out.has('get_file'));
  });
});
