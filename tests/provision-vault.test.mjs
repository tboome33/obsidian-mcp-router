// W2 — provision_vault MCP tool + the security gates. Drives the layer-0
// engine for real, enforces the path gate, and is hidden on gated deployments.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { provisionVaultTool } from '../src/tools/provision-vault.mjs';
import { provisionExecOptions } from '../src/helpers/vault-wizard-engine.mjs';
import { _internals } from '../src/index.mjs';

describe('provision_vault tool', () => {
  let workDir, ref, cfg, prevEnv;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-vault-'));
    // Reference vault at workDir/.template → its parent (workDir) is a known
    // vault root, so targets under workDir are allowed by the path gate.
    ref = path.join(workDir, '.template');
    for (const p of ['obsidian-local-rest-api', 'mcp-router-bridge', 'smart-connections']) {
      fs.mkdirSync(path.join(ref, '.obsidian', 'plugins', p), { recursive: true });
      fs.writeFileSync(path.join(ref, '.obsidian', 'plugins', p, 'main.js'), `// ${p}`);
    }
    fs.writeFileSync(path.join(ref, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'),
      JSON.stringify({ apiKey: 'REF-SECRET-KEY', port: 27123 }));
    fs.writeFileSync(path.join(ref, '.obsidian', 'community-plugins.json'),
      JSON.stringify(['obsidian-local-rest-api', 'mcp-router-bridge', 'smart-connections']));
    cfg = path.join(workDir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ referenceVault: ref, portRegistry: {}, portStart: 27400 }));
    prevEnv = process.env.OBSIDIAN_ROUTER_CONFIG;
    process.env.OBSIDIAN_ROUTER_CONFIG = cfg;
  });

  after(() => {
    if (prevEnv === undefined) delete process.env.OBSIDIAN_ROUTER_CONFIG;
    else process.env.OBSIDIAN_ROUTER_CONFIG = prevEnv;
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  test('provisions a vault under a known root + returns port/insecurePort/openUri', async () => {
    const target = path.join(workDir, 'ProvisionedVault');
    const res = await provisionVaultTool({}, { path: target });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(path.resolve(res.path), path.resolve(target));
    assert.equal(res.slug, 'provisionedvault');
    assert.ok(Number.isInteger(res.port) && res.port > 0, 'port allocated');
    assert.equal(res.insecurePort, res.port + 10, 'insecurePort = port + 10');
    assert.match(res.openUri, /^obsidian:\/\/open\?vault=/);
    assert.equal(res.hooksWired, false, 'MCP provision never wires global hooks');
    // Real artifacts on disk.
    assert.ok(fs.existsSync(path.join(target, '.env')));
    assert.ok(fs.existsSync(path.join(target, '.obsidian', 'plugins', 'smart-connections')));
    // Fresh secret (not the reference's).
    const restData = JSON.parse(fs.readFileSync(
      path.join(target, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'), 'utf8'));
    assert.notEqual(restData.apiKey, 'REF-SECRET-KEY');
  });

  test('SECURITY: refuses a target path outside the known vault roots', async () => {
    const outside = path.join(os.tmpdir(), 'wizard-outside-' + process.pid);
    await assert.rejects(
      () => provisionVaultTool({}, { path: outside }),
      /outside all known vault roots/i,
    );
    assert.ok(!fs.existsSync(outside), 'refused target must not be created');
  });

  test('SECURITY: allowOutsideRoots overrides the path gate', async () => {
    const outside = path.join(os.tmpdir(), 'wizard-optin-' + process.pid);
    try {
      const res = await provisionVaultTool({}, { path: outside, allowOutsideRoots: true });
      assert.equal(res.ok, true);
      assert.ok(fs.existsSync(path.join(outside, '.env')));
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('SECURITY (fail-closed): an EMPTY-roots config still refuses an arbitrary path', async () => {
    // review+ W2 IMPORTANT: a config with no referenceVault / no portRegistry
    // has zero known roots → buildProvisionPlan emits NO out-of-roots warning.
    // The gate must still refuse without allowOutsideRoots.
    const emptyCfg = path.join(workDir, 'empty-config.json');
    fs.writeFileSync(emptyCfg, JSON.stringify({ portStart: 27950, portRegistry: {} }));
    // A valid source vault so the ONLY reason to refuse is the empty-roots gate.
    const src = path.join(workDir, 'FailClosedSrc');
    for (const p of ['obsidian-local-rest-api', 'mcp-router-bridge']) {
      fs.mkdirSync(path.join(src, '.obsidian', 'plugins', p), { recursive: true });
      fs.writeFileSync(path.join(src, '.obsidian', 'plugins', p, 'main.js'), '//');
    }
    fs.writeFileSync(path.join(src, '.obsidian', 'community-plugins.json'),
      JSON.stringify(['obsidian-local-rest-api', 'mcp-router-bridge']));
    const target = path.join(os.tmpdir(), 'fail-closed-' + process.pid);
    // Pass the empty config via reg.configPath (overrides the describe's env).
    await assert.rejects(
      () => provisionVaultTool({ configPath: emptyCfg }, { path: target, source: { kind: 'from-vault', fromVault: src } }),
      /outside all known vault roots/i,
    );
    assert.ok(!fs.existsSync(target), 'refused target not created');
  });

  test('--from-vault via provision copies config, regenerates the secret, excludes workspace.json', async () => {
    // Source under workDir so it's a known root.
    const src = path.join(workDir, 'CopySource');
    for (const p of ['obsidian-local-rest-api', 'mcp-router-bridge']) {
      fs.mkdirSync(path.join(src, '.obsidian', 'plugins', p), { recursive: true });
      fs.writeFileSync(path.join(src, '.obsidian', 'plugins', p, 'main.js'), `// ${p}`);
    }
    fs.writeFileSync(path.join(src, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'),
      JSON.stringify({ apiKey: 'SRC-SECRET', port: 27500 }));
    fs.writeFileSync(path.join(src, '.obsidian', 'community-plugins.json'),
      JSON.stringify(['obsidian-local-rest-api', 'mcp-router-bridge']));
    fs.writeFileSync(path.join(src, '.obsidian', 'workspace.json'), JSON.stringify({ ui: 'state' }));

    const target = path.join(workDir, 'CopiedByTool');
    const res = await provisionVaultTool({}, { path: target, source: { kind: 'from-vault', fromVault: src } });
    assert.equal(res.ok, true);
    const restData = JSON.parse(fs.readFileSync(
      path.join(target, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'), 'utf8'));
    assert.notEqual(restData.apiKey, 'SRC-SECRET', 'source secret not copied');
    assert.ok(!fs.existsSync(path.join(target, '.obsidian', 'workspace.json')), 'workspace.json excluded');
  });

  test('name alone composes a path under vaultsRoot and provisions there (decision ergonomie-creation-liaison-vaults §1)', async () => {
    const vaultsRootDir = path.join(workDir, 'name-only-roots');
    fs.mkdirSync(vaultsRootDir, { recursive: true });
    const cfgWithRoot = path.join(workDir, 'config-with-root.json');
    fs.writeFileSync(cfgWithRoot, JSON.stringify({
      referenceVault: ref, portRegistry: {}, portStart: 27600, vaultsRoot: vaultsRootDir,
    }));
    const res = await provisionVaultTool({ configPath: cfgWithRoot }, { name: 'Tartenpion' });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(path.resolve(res.path), path.join(vaultsRootDir, 'tartenpion'));
    assert.ok(fs.existsSync(path.join(vaultsRootDir, 'tartenpion', '.env')));
  });

  test('two --name values folding to the SAME vaultsRoot folder slug: refused, not silently relabeled (regression, found in review)', async () => {
    // slugifyForPath (the folder slug) folds both ' ' and '.' to '-', so "My
    // Vault" and "My.Vault" compose the identical folder — while the
    // vaultNames slug the existing collision guard checks (a bare
    // .toLowerCase(), no folding) sees "my vault" vs "my.vault": genuinely
    // different, so that guard alone cannot see this collision.
    const vaultsRootDir = path.join(workDir, 'slug-fold-roots');
    fs.mkdirSync(vaultsRootDir, { recursive: true });
    const cfgWithRoot = path.join(workDir, 'config-slug-fold.json');
    fs.writeFileSync(cfgWithRoot, JSON.stringify({
      referenceVault: ref, portRegistry: {}, portStart: 27700, vaultsRoot: vaultsRootDir,
    }));
    const first = await provisionVaultTool({ configPath: cfgWithRoot }, { name: 'My Vault' });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(path.resolve(first.path), path.join(vaultsRootDir, 'my-vault'));

    await assert.rejects(
      () => provisionVaultTool({ configPath: cfgWithRoot }, { name: 'My.Vault' }),
      /already registered as vault/,
    );

    // Re-running with the SAME --name (case-insensitive) on the same folder
    // is the legitimate case and must keep working.
    const again = await provisionVaultTool({ configPath: cfgWithRoot }, { name: 'my vault' });
    assert.equal(again.ok, true, JSON.stringify(again));
  });
});

describe('provision_vault — bindToWorkspace (decision ergonomie-creation-liaison-vaults §1)', () => {
  const okPlan = () => ({
    path: 'C:/VAULTS/x', slug: 'x', name: 'x', source: { kind: 'reference' },
    plugins: { profile: 'recommended', resolved: [] }, theme: null, wikiMode: { mode: 'personal' },
    conventions: null, claudeWorkspace: false, warnings: [], steps: [], context: { knownRoots: ['C:/VAULTS'] },
  });
  const okResult = () => ({
    code: 0, stdout: '', stderr: '',
    result: { ok: true, kind: 'reference', abs: 'C:/VAULTS/x', slug: 'x', obsidianName: 'x', port: 1, insecurePort: 2, openUri: 'obsidian://x', opened: false, probe: null },
  });
  const registry = { resolveVault: () => ({ name: 'x' }), configPath: null };

  test('bindToWorkspace: true derives linkWorkspace = process.cwd() ONLY for the real run, never for the dry-run/seal computation', async () => {
    // The dry-run must see the SAME input plan_vault would have seen (no
    // resolution) — see tests/plan-seal-integration.test.mjs for why: resolving
    // it before the dry-run/seal made every plan_vault -> provision_vault call
    // with bindToWorkspace:true refuse with a false plan_drift.
    let seenAtPlan, seenAtApply;
    await provisionVaultTool(
      registry,
      { path: 'C:/VAULTS/x', bindToWorkspace: true },
      {
        runDryRunPlan: async (input) => { seenAtPlan = input.linkWorkspace; return okPlan(); },
        runProvision: async (input) => { seenAtApply = input.linkWorkspace; return okResult(); },
      },
    );
    assert.equal(seenAtPlan, undefined, 'the dry-run must not see a resolved linkWorkspace');
    assert.equal(seenAtApply, process.cwd(), 'only the real spawn resolves it');
  });

  test('bindToWorkspace: false (default) — linkWorkspace stays unset, never bound silently', async () => {
    let seen = 'UNTOUCHED';
    await provisionVaultTool(
      registry,
      { path: 'C:/VAULTS/x' },
      { runDryRunPlan: async (input) => { seen = input.linkWorkspace; return okPlan(); }, runProvision: async () => okResult() },
    );
    assert.equal(seen, undefined);
  });

  test('an explicit linkWorkspace always wins over bindToWorkspace', async () => {
    let seen;
    await provisionVaultTool(
      registry,
      { path: 'C:/VAULTS/x', bindToWorkspace: true, linkWorkspace: '/explicit/ws' },
      { runDryRunPlan: async (input) => { seen = input.linkWorkspace; return okPlan(); }, runProvision: async () => okResult() },
    );
    assert.equal(seen, '/explicit/ws');
  });
});

describe('vault-wizard tools security gate', () => {
  test('all three tools are hidden when OBSIDIAN_ROUTER_USER_ID is set (gated)', () => {
    const { TOOLS, LOCAL_ONLY_TOOL_NAMES, computeExposedTools } = _internals;
    assert.deepEqual(
      [...LOCAL_ONLY_TOOL_NAMES].sort(),
      ['plan_vault', 'provision_vault', 'register_remote_vault'],
    );
    const gated = computeExposedTools(TOOLS, { gated: true }).map((t) => t.name);
    assert.ok(!gated.includes('plan_vault'), 'plan_vault hidden when gated');
    assert.ok(!gated.includes('provision_vault'), 'provision_vault hidden when gated');
    assert.ok(
      !gated.includes('register_remote_vault'),
      'register_remote_vault hidden when gated — MCPHub tenants share one central config.json',
    );
    const open = computeExposedTools(TOOLS, { gated: false }).map((t) => t.name);
    assert.ok(
      open.includes('plan_vault') && open.includes('provision_vault') && open.includes('register_remote_vault'),
      'exposed when not gated',
    );
  });

  test('both tools have a registered handler (drift guard)', () => {
    const { TOOL_HANDLERS } = _internals;
    assert.equal(typeof TOOL_HANDLERS.plan_vault, 'function');
    assert.equal(typeof TOOL_HANDLERS.provision_vault, 'function');
  });

  test('READONLY hides provision_vault (a write tool) but keeps plan_vault', () => {
    const { TOOLS, WRITE_TOOL_NAMES, computeExposedTools } = _internals;
    assert.ok(WRITE_TOOL_NAMES.has('provision_vault'), 'provision_vault is a write tool');
    assert.ok(!WRITE_TOOL_NAMES.has('plan_vault'), 'plan_vault is read-only');
    const ro = computeExposedTools(TOOLS, { readonly: true }).map((t) => t.name);
    assert.ok(!ro.includes('provision_vault'), 'provision_vault hidden in readonly');
    assert.ok(ro.includes('plan_vault'), 'plan_vault still exposed in readonly');
  });

  test('plan_vault declares every exec option the seal folds in — schema symmetry (regression: C3 catch-22)', () => {
    // Bug found live (2026-08-29, session "Configuration vault Obsidian"): a
    // path outside the known vault roots needs allowOutsideRoots:true, but
    // plan_vault's schema didn't declare it (nor open/probe/probeTimeout/
    // gitInit) — an MCP client that only forwards schema-declared properties
    // drops it before planVaultTool ever sees it, so the preview seals
    // `exec.allowOutsideRoots: null` while provision_vault's apply hashes
    // `true` → a caller who genuinely intends the SAME options on both calls
    // gets a systematic plan_drift. Guard the INVARIANT, not the one flagged
    // field: every key provisionExecOptions folds into the seal must be a
    // declared property on BOTH tools, so adding a future exec option without
    // updating plan_vault's schema fails here instead of resurfacing live.
    const { TOOLS } = _internals;
    const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
    const execKeys = Object.keys(provisionExecOptions({}));
    assert.ok(execKeys.length > 0, 'fixture sanity: provisionExecOptions must expose at least one key');
    for (const key of execKeys) {
      assert.ok(
        Object.hasOwn(byName.provision_vault.inputSchema.properties, key),
        `provision_vault must declare exec option "${key}" (sanity check on the fixture list itself)`,
      );
      assert.ok(
        Object.hasOwn(byName.plan_vault.inputSchema.properties, key),
        `plan_vault must declare exec option "${key}" too, or an MCP client can silently drop it before the seal — causing a systematic plan_drift`,
      );
    }
  });
});
