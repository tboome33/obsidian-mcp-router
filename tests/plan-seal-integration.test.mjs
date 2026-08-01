/**
 * Integration tests for the C3 sealed preview wired into the three two-phase
 * MCP families:
 *   - delete_file          (preview:true → confirm:true + approvedPlanSha256)
 *   - provision_vault      (plan_vault seal → provision_vault verify)
 *   - refresh_okf_projections (check:true seal → apply verify)
 *
 * Each family is driven through injected dependencies (no real network / no
 * child process), so the tests are deterministic and fast. The invariant under
 * test is the same everywhere: an identical live plan applies; ANY drift
 * (content, existence, tree, environment, or vault) refuses BEFORE any write.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { deleteFileTool, buildDeletePlan } from '../src/tools/delete-file.mjs';
import { planVaultTool } from '../src/tools/plan-vault.mjs';
import { provisionVaultTool } from '../src/tools/provision-vault.mjs';
import { refreshProjectionsForVault, refreshOkfProjectionsTool } from '../src/tools/refresh-okf-projections.mjs';
import { PlanDriftError } from '../src/helpers/plan-seal.mjs';
import { contentSha256 } from '../src/helpers/content-hash.mjs';
import { projectionMarkerLine } from '../src/helpers/okf-projections.mjs';

const notFound = () => Object.assign(new Error('404'), { kind: 'not_found' });

// ---------------------------------------------------------------------------
// delete_file
// ---------------------------------------------------------------------------

describe('delete_file — sealed preview', () => {
  // A registry + injectable file store. `content` is mutable so a test can make
  // the file drift between the preview and the confirm.
  function harness({ name = 'v', baseUrl = 'http://v', content = 'hello' } = {}) {
    const state = { content, deleted: false };
    const registry = { resolveVault: () => ({ name, baseUrl }) };
    const deps = {
      getFileContent: async () => {
        if (state.content === null) throw notFound();
        return state.content;
      },
      deleteFile: async () => { state.deleted = true; },
    };
    return { state, registry, deps };
  }

  test('preview:true returns a sealed plan and deletes nothing', async () => {
    const { state, registry, deps } = harness({ content: 'hello' });
    const out = await deleteFileTool(registry, { path: 'a.md', preview: true }, deps);
    assert.equal(out.preview, true);
    assert.equal(out.exists, true);
    assert.equal(out.willDelete, true);
    assert.equal(out.contentSha256, contentSha256('hello'));
    assert.match(out.approvedPlanSha256, /^[0-9a-f]{64}$/);
    assert.equal(state.deleted, false);
  });

  test('preview of a missing file → exists:false, willDelete:false', async () => {
    const { registry, deps } = harness({ content: null });
    const out = await deleteFileTool(registry, { path: 'gone.md', preview: true }, deps);
    assert.equal(out.exists, false);
    assert.equal(out.willDelete, false);
    assert.match(out.message, /does not exist/);
  });

  test('confirm + matching seal → deletes', async () => {
    const { state, registry, deps } = harness({ content: 'hello' });
    const pv = await deleteFileTool(registry, { path: 'a.md', preview: true }, deps);
    await deleteFileTool(
      registry,
      { path: 'a.md', confirm: true, approvedPlanSha256: pv.approvedPlanSha256 },
      deps,
    );
    assert.equal(state.deleted, true);
  });

  test('content drifted since preview → refuses, no DELETE', async () => {
    const { state, registry, deps } = harness({ content: 'hello' });
    const pv = await deleteFileTool(registry, { path: 'a.md', preview: true }, deps);
    state.content = 'CHANGED'; // another writer touched it
    await assert.rejects(
      () => deleteFileTool(registry, { path: 'a.md', confirm: true, approvedPlanSha256: pv.approvedPlanSha256 }, deps),
      (e) => e instanceof PlanDriftError && /drift/i.test(e.message),
    );
    assert.equal(state.deleted, false);
  });

  test('file vanished since preview → refuses (existence drift), no DELETE', async () => {
    const { state, registry, deps } = harness({ content: 'hello' });
    const pv = await deleteFileTool(registry, { path: 'a.md', preview: true }, deps);
    state.content = null; // deleted by someone else
    await assert.rejects(
      () => deleteFileTool(registry, { path: 'a.md', confirm: true, approvedPlanSha256: pv.approvedPlanSha256 }, deps),
      PlanDriftError,
    );
    assert.equal(state.deleted, false);
  });

  test('REVERSE existence drift: absent at preview, created before confirm → refuses, no DELETE', async () => {
    // The safety-critical direction: the caller previewed "nothing to delete"
    // (exists:false), a file then MATERIALIZED at that path, and the confirm
    // must NOT delete a file the caller never saw. buildDeletePlan now returns
    // exists:true → the seal mismatches → refusal before the DELETE.
    const { state, registry, deps } = harness({ content: null }); // absent at preview
    const pv = await deleteFileTool(registry, { path: 'a.md', preview: true }, deps);
    assert.equal(pv.exists, false);
    state.content = 'materialized after the caller approved deleting nothing';
    await assert.rejects(
      () => deleteFileTool(registry, { path: 'a.md', confirm: true, approvedPlanSha256: pv.approvedPlanSha256 }, deps),
      PlanDriftError,
    );
    assert.equal(state.deleted, false);
  });

  test('cross-vault replay → refuses (a seal from vault A cannot confirm on vault B)', async () => {
    const a = harness({ name: 'A', baseUrl: 'http://a', content: 'same' });
    const pv = await deleteFileTool(a.registry, { path: 'a.md', preview: true }, a.deps);
    const b = harness({ name: 'B', baseUrl: 'http://b', content: 'same' }); // identical content
    await assert.rejects(
      () => deleteFileTool(b.registry, { path: 'a.md', confirm: true, approvedPlanSha256: pv.approvedPlanSha256 }, b.deps),
      PlanDriftError,
    );
    assert.equal(b.state.deleted, false);
  });

  test('malformed approvedPlanSha256 → validation error before the vault is resolved', async () => {
    const exploding = { resolveVault() { throw new Error('must not resolve'); } };
    await assert.rejects(
      () => deleteFileTool(exploding, { path: 'a.md', confirm: true, approvedPlanSha256: 'nope' }),
      /Invalid approvedPlanSha256/,
    );
  });

  test('backward compat: confirm without a seal still deletes', async () => {
    const { state, registry, deps } = harness({ content: 'hello' });
    await deleteFileTool(registry, { path: 'a.md', confirm: true }, deps);
    assert.equal(state.deleted, true);
  });

  test('no confirm, no preview → still refuses with the accidental-delete guard', async () => {
    const { state, registry, deps } = harness({ content: 'hello' });
    await assert.rejects(
      () => deleteFileTool(registry, { path: 'a.md' }, deps),
      /pass confirm: true/,
    );
    assert.equal(state.deleted, false);
  });

  test('buildDeletePlan: non-string content is fingerprinted (drift-detectable), not dropped to null', async () => {
    const p1 = await buildDeletePlan({ name: 'v' }, 'a.md', async () => ({ some: 'object' }));
    const p2 = await buildDeletePlan({ name: 'v' }, 'a.md', async () => ({ some: 'CHANGED' }));
    assert.equal(p1.exists, true);
    assert.match(p1.contentSha256, /^[0-9a-f]{64}$/);
    assert.notEqual(p1.contentSha256, p2.contentSha256, 'a changed structured note must change the plan');
  });
});

// ---------------------------------------------------------------------------
// provision_vault  (plan_vault seal → provision_vault verify)
// ---------------------------------------------------------------------------

describe('provision_vault — sealed preview', () => {
  const registry = { resolveVault: () => ({ name: 'x' }), configPath: null };

  const okPlan = () => ({
    path: 'C:/VAULTS/x',
    slug: 'x',
    name: 'x',
    source: { kind: 'reference' },
    plugins: { profile: 'recommended', resolved: ['local-rest-api', 'bridge'] },
    theme: null,
    wikiMode: { mode: 'personal' },
    conventions: null,
    claudeWorkspace: false,
    warnings: [],
    steps: [],
    context: { knownRoots: ['C:/VAULTS'] },
  });

  const okProvisionResult = () => ({
    code: 0,
    stdout: '',
    stderr: '',
    result: { ok: true, kind: 'reference', abs: 'C:/VAULTS/x', slug: 'x', obsidianName: 'x', port: 1, insecurePort: 2, openUri: 'obsidian://x', opened: false, probe: null },
  });

  test('plan_vault emits a seal that provision_vault accepts for the same plan', async () => {
    const plan = okPlan();
    const planned = await planVaultTool(registry, { path: 'C:/VAULTS/x' }, { runDryRunPlan: async () => plan });
    assert.match(planned.approvedPlanSha256, /^[0-9a-f]{64}$/);

    let provisioned = false;
    const out = await provisionVaultTool(
      registry,
      { path: 'C:/VAULTS/x', approvedPlanSha256: planned.approvedPlanSha256 },
      { runDryRunPlan: async () => okPlan(), runProvision: async () => { provisioned = true; return okProvisionResult(); } },
    );
    assert.equal(provisioned, true);
    assert.equal(out.ok, true);
  });

  test('environment drift (plugin set changed) → refuses, real run never spawned', async () => {
    const planned = await planVaultTool(registry, { path: 'C:/VAULTS/x' }, { runDryRunPlan: async () => okPlan() });
    const drifted = okPlan();
    drifted.plugins.resolved = ['local-rest-api', 'bridge', 'dataview']; // a plugin appeared
    let provisioned = false;
    await assert.rejects(
      () => provisionVaultTool(
        registry,
        { path: 'C:/VAULTS/x', approvedPlanSha256: planned.approvedPlanSha256 },
        { runDryRunPlan: async () => drifted, runProvision: async () => { provisioned = true; return okProvisionResult(); } },
      ),
      (e) => e instanceof PlanDriftError && /drift/i.test(e.message),
    );
    assert.equal(provisioned, false, 'no filesystem-mutating run after a drift refusal');
  });

  test('exec-options drift (gitInit flipped) → refuses even though the dry-run core is identical', async () => {
    // The caller previewed with default options, then tries to apply with
    // gitInit:true — a side effect the preview never approved. Same plan core,
    // different executable knob → seal mismatch. Guards the spec requirement
    // that the seal cover EXACTLY what will be executed.
    const planned = await planVaultTool(registry, { path: 'C:/VAULTS/x' }, { runDryRunPlan: async () => okPlan() });
    let provisioned = false;
    await assert.rejects(
      () => provisionVaultTool(
        registry,
        { path: 'C:/VAULTS/x', gitInit: true, approvedPlanSha256: planned.approvedPlanSha256 },
        { runDryRunPlan: async () => okPlan(), runProvision: async () => { provisioned = true; return okProvisionResult(); } },
      ),
      (e) => e instanceof PlanDriftError && /drift/i.test(e.message),
    );
    assert.equal(provisioned, false, 'a side effect the preview never approved must not run');
  });

  test('malformed seal → validation error before the planner runs', async () => {
    let planned = false;
    await assert.rejects(
      () => provisionVaultTool(
        registry,
        { path: 'C:/VAULTS/x', approvedPlanSha256: 'nope' },
        { runDryRunPlan: async () => { planned = true; return okPlan(); }, runProvision: async () => okProvisionResult() },
      ),
      /Invalid approvedPlanSha256/,
    );
    assert.equal(planned, false);
  });

  test('backward compat: provisioning without a seal still runs', async () => {
    let provisioned = false;
    const out = await provisionVaultTool(
      registry,
      { path: 'C:/VAULTS/x' },
      { runDryRunPlan: async () => okPlan(), runProvision: async () => { provisioned = true; return okProvisionResult(); } },
    );
    assert.equal(provisioned, true);
    assert.equal(out.ok, true);
  });
});

// ---------------------------------------------------------------------------
// refresh_okf_projections  (check:true seal → apply verify)
// ---------------------------------------------------------------------------

describe('refresh_okf_projections — sealed preview', () => {
  function makeVaultFs(files = {}) {
    const store = new Map(Object.entries(files));
    const writes = [];
    const deletes = [];
    const deps = {
      listFilesIn: async (_v, dir) => {
        const prefix = dir ? `${dir}/` : '';
        const names = new Set();
        for (const p of store.keys()) {
          if (!p.startsWith(prefix)) continue;
          const rest = p.slice(prefix.length);
          const slash = rest.indexOf('/');
          names.add(slash === -1 ? rest : `${rest.slice(0, slash)}/`);
        }
        if (names.size === 0 && dir !== '') throw new Error('404');
        return { files: [...names].sort() };
      },
      getFileContent: async (_v, p) => {
        if (!store.has(p)) throw notFound();
        return store.get(p);
      },
      writeFile: async (_v, p, content) => { store.set(p, content); writes.push(p); },
      deleteFile: async (_v, p) => { store.delete(p); deletes.push(p); },
    };
    return { store, writes, deletes, deps };
  }
  const PAGE = (title) => `---\ntype: note\ntitle: "${title}"\ndescription: "Desc ${title}"\ncreated: 2026-07-01\n---\n\nCorps.\n`;
  const V = { name: 'test-vault' };
  const now = '2026-07-30';

  test('check:true returns a seal; apply with it (unchanged tree) writes', async () => {
    const { deps, writes } = makeVaultFs({ 'wiki/a/p.md': PAGE('P') });
    const chk = await refreshProjectionsForVault(V, deps, { check: true, now });
    assert.match(chk.approvedPlanSha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(writes, [], 'check writes nothing');
    const applied = await refreshProjectionsForVault(V, deps, { approvedPlanSha256: chk.approvedPlanSha256, now });
    assert.equal(applied.mode, 'apply');
    assert.ok(writes.length > 0, 'the approved plan applied');
  });

  test('tree drifted since check (a page was added) → refuses, writes nothing', async () => {
    const { deps, store, writes } = makeVaultFs({ 'wiki/a/p.md': PAGE('P') });
    const chk = await refreshProjectionsForVault(V, deps, { check: true, now });
    store.set('wiki/b/q.md', PAGE('Q')); // a new page appeared after the check
    await assert.rejects(
      () => refreshProjectionsForVault(V, deps, { approvedPlanSha256: chk.approvedPlanSha256, now }),
      (e) => e instanceof PlanDriftError && /drift/i.test(e.message),
    );
    assert.deepEqual(writes, [], 'a drifted plan writes nothing');
  });

  test('conflict-mode: an unmarked homonym appearing after the check → drift refusal', async () => {
    const { deps, store, writes } = makeVaultFs({ 'wiki/a/p.md': PAGE('P') });
    const chk = await refreshProjectionsForVault(V, deps, { check: true, now });
    // a hand-written file squats a projection path after the check → the plan
    // now carries a conflict it didn't before.
    store.set('wiki/a/index.md', '# écrit main\n');
    await assert.rejects(
      () => refreshProjectionsForVault(V, deps, { approvedPlanSha256: chk.approvedPlanSha256, now }),
      PlanDriftError,
    );
    assert.deepEqual(writes, []);
  });

  test('cross-vault: a seal checked on vault A refuses to apply on vault B', async () => {
    const { deps } = makeVaultFs({ 'wiki/a/p.md': PAGE('P') });
    const chk = await refreshProjectionsForVault({ name: 'A' }, deps, { check: true, now });
    await assert.rejects(
      () => refreshProjectionsForVault({ name: 'B' }, deps, { approvedPlanSha256: chk.approvedPlanSha256, now }),
      PlanDriftError,
    );
  });

  test('deletes-branch drift: a stale generated index un-stales before apply → refuses, deletes nothing', async () => {
    // Guards the `deletes` dimension of the seal (which the other tests, whose
    // plans only ever WRITE, never exercise). At check time wiki/vieux/ has no
    // content page, so its MARKED generated index is planned for DELETION. A
    // page then reappears under wiki/vieux/ before apply, so the fresh plan no
    // longer deletes that index — a drift the seal must catch. A regression that
    // dropped `deletes` from the sealed plan-core, or ran the delete loop before
    // verifyPlanSeal, would let the stale delete fire; this test forbids that.
    const { deps, store, writes, deletes } = makeVaultFs({
      'wiki/a/p.md': PAGE('P'),
      'wiki/vieux/index.md': `# Vieux\n\n${projectionMarkerLine()}\n`,
    });
    const chk = await refreshProjectionsForVault(V, deps, { check: true, now });
    assert.ok(chk.deleted.includes('wiki/vieux/index.md'), 'the checked plan must plan a delete');
    store.set('wiki/vieux/q.md', PAGE('Q')); // the directory is repopulated
    await assert.rejects(
      () => refreshProjectionsForVault(V, deps, { approvedPlanSha256: chk.approvedPlanSha256, now }),
      PlanDriftError,
    );
    assert.deepEqual(writes, [], 'a drifted plan writes nothing');
    assert.deepEqual(deletes, [], 'and deletes nothing');
    assert.ok(store.has('wiki/vieux/index.md'), 'the stale index survives the refusal');
  });

  test('backward compat: apply without a seal still writes', async () => {
    const { deps, writes } = makeVaultFs({ 'wiki/a/p.md': PAGE('P') });
    await refreshProjectionsForVault(V, deps, { now });
    assert.ok(writes.length > 0);
  });

  test('tool wrapper rejects a malformed seal BEFORE resolving the vault or any I/O', async () => {
    // Prove the ORDERING, not just the message: an exploding registry + deps
    // that throw if touched. If the wrapper-level shape check were removed,
    // resolveVault / listFilesIn would fire and surface a DIFFERENT error, so
    // this test would fail — which is exactly the regression it must catch.
    const registry = { resolveVault: () => { throw new Error('resolveVault must not be reached'); } };
    const deps = {
      listFilesIn: async () => { throw new Error('no I/O allowed'); },
      getFileContent: async () => { throw new Error('no I/O allowed'); },
      writeFile: async () => { throw new Error('no I/O allowed'); },
      deleteFile: async () => { throw new Error('no I/O allowed'); },
      now,
    };
    await assert.rejects(
      () => refreshOkfProjectionsTool(registry, { approvedPlanSha256: 'nope' }, deps),
      /Invalid approvedPlanSha256/,
    );
  });

  test('tool wrapper: check:true surfaces the seal through sanitizeResponse', async () => {
    const { deps } = makeVaultFs({ 'wiki/a/p.md': PAGE('P') });
    const registry = { resolveVault: (n) => ({ name: n ?? 'default' }) };
    const r = await refreshOkfProjectionsTool(registry, { check: true }, { ...deps, now });
    assert.match(r.approvedPlanSha256, /^[0-9a-f]{64}$/);
  });
});
