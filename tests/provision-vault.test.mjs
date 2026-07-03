// W2 — provision_vault MCP tool + the security gates. Drives the layer-0
// engine for real, enforces the path gate, and is hidden on gated deployments.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { provisionVaultTool } from '../src/tools/provision-vault.mjs';
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
});

describe('vault-wizard tools security gate', () => {
  test('both tools are hidden when OBSIDIAN_ROUTER_USER_ID is set (gated)', () => {
    const { TOOLS, LOCAL_ONLY_TOOL_NAMES, computeExposedTools } = _internals;
    assert.deepEqual([...LOCAL_ONLY_TOOL_NAMES].sort(), ['plan_vault', 'provision_vault']);
    const gated = computeExposedTools(TOOLS, { gated: true }).map((t) => t.name);
    assert.ok(!gated.includes('plan_vault'), 'plan_vault hidden when gated');
    assert.ok(!gated.includes('provision_vault'), 'provision_vault hidden when gated');
    const open = computeExposedTools(TOOLS, { gated: false }).map((t) => t.name);
    assert.ok(open.includes('plan_vault') && open.includes('provision_vault'), 'exposed when not gated');
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
});
