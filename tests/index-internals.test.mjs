/**
 * Unit tests for `_internals.requiresAlsoTierCheck` — the pure predicate that
 * decides whether a `CallTool` dispatch needs the also-tier write gate
 * (decision `portee-et-mode-ecriture-des-vaults` §2, Phase 3 of
 * `portee-ergonomie-refus-roadmap`) run before its handler. No I/O, no vault
 * resolution — just tool name + args in, boolean out — so it is tested here
 * in isolation from `assertVaultWritable` (tests/vault-reach.test.mjs) and
 * from the real dispatcher wiring (tests/also-tier-write-gate-e2e.test.mjs).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { _internals } from '../src/index.mjs';

const { requiresAlsoTierCheck, ALSO_TIER_EXEMPT_TOOL_NAMES, WRITE_TOOL_NAMES, toolActuallyWrote } = _internals;

describe('ALSO_TIER_EXEMPT_TOOL_NAMES', () => {
  test('is a Set of the 3 tools that never address an already-registered vault as their write target', () => {
    assert.ok(ALSO_TIER_EXEMPT_TOOL_NAMES instanceof Set);
    assert.deepEqual(
      [...ALSO_TIER_EXEMPT_TOOL_NAMES].sort(),
      ['download_page_assets', 'provision_vault', 'register_remote_vault'],
    );
  });

  test('every exempt name is itself a documented write tool (the exemption narrows WRITE_TOOL_NAMES, it does not name something else)', () => {
    for (const n of ALSO_TIER_EXEMPT_TOOL_NAMES) {
      assert.ok(WRITE_TOOL_NAMES.has(n), `"${n}" is exempt from the also-tier gate but is not in WRITE_TOOL_NAMES`);
    }
  });
});

describe('requiresAlsoTierCheck', () => {
  test('a read tool never needs the check, regardless of args', () => {
    assert.equal(requiresAlsoTierCheck('get_file', {}), false);
    assert.equal(requiresAlsoTierCheck('list_vaults', {}), false);
    assert.equal(requiresAlsoTierCheck('search', { vault: 'x' }), false);
  });

  test('an unknown tool name never needs the check', () => {
    assert.equal(requiresAlsoTierCheck('not_a_real_tool', {}), false);
  });

  test('the 3 exempt write tools never need the check, even with a `vault` argument (they do not have one, but a stray one must not flip the gate on)', () => {
    assert.equal(requiresAlsoTierCheck('provision_vault', { vault: 'x' }), false);
    assert.equal(requiresAlsoTierCheck('register_remote_vault', { vault: 'x' }), false);
    assert.equal(requiresAlsoTierCheck('download_page_assets', { vault: 'x' }), false);
  });

  test('an ordinary write tool with no special flag needs the check', () => {
    for (const n of ['write_file', 'append_to_file', 'move_file', 'set_frontmatter', 'merge_frontmatter', 'patch_file', 'record_source']) {
      assert.equal(requiresAlsoTierCheck(n, {}), true, `"${n}" must require the also-tier check by default`);
    }
  });

  test('execute_template: only requires the check when createFile is true', () => {
    assert.equal(requiresAlsoTierCheck('execute_template', {}), false);
    assert.equal(requiresAlsoTierCheck('execute_template', { createFile: false }), false);
    assert.equal(requiresAlsoTierCheck('execute_template', { createFile: 'yes' }), false, 'must be the literal boolean true, not a truthy string');
    assert.equal(requiresAlsoTierCheck('execute_template', { createFile: true }), true);
  });

  test('write_bundle: preview:true and the READ-ONLY recovery listing (recover:true) are exempt; an ordinary apply is not', () => {
    assert.equal(requiresAlsoTierCheck('write_bundle', { preview: true }), false);
    assert.equal(requiresAlsoTierCheck('write_bundle', { recover: true }), false);
    assert.equal(requiresAlsoTierCheck('write_bundle', { recover: 'true' }), false, 'a string "true" normalises to the same LIST mode as the boolean');
    assert.equal(requiresAlsoTierCheck('write_bundle', {}), true);
    assert.equal(requiresAlsoTierCheck('write_bundle', { preview: false }), true);
  });

  test('write_bundle: a RUN-mode recovery (an actual operation id) is NOT exempt — it WRITES, so alsoLocked\'s "no exceptions" must still apply to it', () => {
    assert.equal(requiresAlsoTierCheck('write_bundle', { recover: 'op-1234567890abcdef', confirm: true }), true);
    assert.equal(requiresAlsoTierCheck('write_bundle', { recover: 'op-1234567890abcdef' }), true);
  });

  test('delete_file: preview:true is exempt, an actual delete is not', () => {
    assert.equal(requiresAlsoTierCheck('delete_file', { preview: true }), false);
    assert.equal(requiresAlsoTierCheck('delete_file', { confirm: true }), true);
    assert.equal(requiresAlsoTierCheck('delete_file', {}), true);
  });

  test('build_wiki_graph: dryRun:true is exempt, a real build is not', () => {
    assert.equal(requiresAlsoTierCheck('build_wiki_graph', { dryRun: true }), false);
    assert.equal(requiresAlsoTierCheck('build_wiki_graph', {}), true);
  });

  test('build_search_index and refresh_okf_projections: check:true is exempt, an actual run is not', () => {
    assert.equal(requiresAlsoTierCheck('build_search_index', { check: true }), false);
    assert.equal(requiresAlsoTierCheck('build_search_index', {}), true);
    assert.equal(requiresAlsoTierCheck('refresh_okf_projections', { check: true }), false);
    assert.equal(requiresAlsoTierCheck('refresh_okf_projections', {}), true);
  });

  test('every WRITE_TOOL_NAMES member is covered by name here (either exempt-by-default or exercised with a conditional flag) — no silent new write tool skips the gate', () => {
    const conditionallyExempt = new Set([
      'execute_template', 'write_bundle', 'delete_file',
      'build_wiki_graph', 'build_search_index', 'refresh_okf_projections',
    ]);
    for (const n of WRITE_TOOL_NAMES) {
      if (ALSO_TIER_EXEMPT_TOOL_NAMES.has(n) || conditionallyExempt.has(n)) continue;
      assert.equal(requiresAlsoTierCheck(n, {}), true, `"${n}" is a write tool with no known exemption — it must require the also-tier check`);
    }
  });
});

/**
 * `toolActuallyWrote` — the predicate the audit log and the debounced
 * projections/search-index scheduler now consult instead of bare
 * `WRITE_TOOL_NAMES.has(name)`. Codex review (two independent passes) found
 * that a preview/dry-run call — exactly the ones `requiresAlsoTierCheck`
 * exempts because they write nothing — still reached both of those
 * post-write middleware blocks, so a preview against an `alsoLocked`
 * secondary still produced a real write (an audit-journal entry, a scheduled
 * projections refresh). See tests/also-tier-write-gate-e2e.test.mjs for the
 * end-to-end proof through the real dispatcher.
 */
describe('toolActuallyWrote', () => {
  test('agrees with requiresAlsoTierCheck for every ordinary write tool and every preview/dry-run flag', () => {
    for (const [name, args] of [
      ['write_file', {}],
      ['execute_template', {}],
      ['execute_template', { createFile: true }],
      ['write_bundle', { preview: true }],
      ['write_bundle', {}],
      ['write_bundle', { recover: true }],
      ['write_bundle', { recover: 'op-1234567890abcdef', confirm: true }],
      ['delete_file', { preview: true }],
      ['delete_file', { confirm: true }],
      ['build_wiki_graph', { dryRun: true }],
      ['build_wiki_graph', {}],
      ['build_search_index', { check: true }],
      ['build_search_index', {}],
      ['refresh_okf_projections', { check: true }],
      ['refresh_okf_projections', {}],
    ]) {
      assert.equal(
        toolActuallyWrote(name, args), requiresAlsoTierCheck(name, args),
        `toolActuallyWrote(${name}, ${JSON.stringify(args)}) must agree with requiresAlsoTierCheck here`,
      );
    }
  });

  test('the 3 also-tier-exempt tools are STILL treated as writes — audit/projections coverage for them is unchanged', () => {
    for (const n of ALSO_TIER_EXEMPT_TOOL_NAMES) {
      assert.equal(requiresAlsoTierCheck(n, {}), false, `fixture sanity: "${n}" must be also-tier exempt`);
      assert.equal(toolActuallyWrote(n, {}), true, `"${n}" must still count as a write for audit/projections purposes, unchanged from before this fix`);
    }
  });

  test('a read tool is never treated as a write', () => {
    for (const n of ['get_file', 'list_vaults', 'search', 'search_smart']) {
      assert.equal(toolActuallyWrote(n, {}), false);
    }
  });
});
