// W2 — plan_vault MCP tool (read-only). Drives the layer-0 engine in
// --dry-run --json mode and shapes the result into a questionnaire. Verifies
// the output shape + zero mutation.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planVaultTool } from '../src/tools/plan-vault.mjs';

describe('plan_vault tool', () => {
  let workDir, ref, cfg, prevEnv;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-vault-'));
    ref = path.join(workDir, '.template');
    for (const p of ['obsidian-local-rest-api', 'mcp-router-bridge', 'smart-connections']) {
      fs.mkdirSync(path.join(ref, '.obsidian', 'plugins', p), { recursive: true });
      fs.writeFileSync(path.join(ref, '.obsidian', 'plugins', p, 'main.js'), `// ${p}`);
    }
    fs.writeFileSync(path.join(ref, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'),
      JSON.stringify({ apiKey: 'REF-KEY', port: 27123 }));
    fs.writeFileSync(path.join(ref, '.obsidian', 'community-plugins.json'),
      JSON.stringify(['obsidian-local-rest-api', 'mcp-router-bridge', 'smart-connections', 'dataview']));
    fs.mkdirSync(path.join(ref, '.obsidian', 'themes', 'Blue Topaz'), { recursive: true });
    cfg = path.join(workDir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ referenceVault: ref, portRegistry: {}, portStart: 27200 }));
    prevEnv = process.env.OBSIDIAN_ROUTER_CONFIG;
    process.env.OBSIDIAN_ROUTER_CONFIG = cfg;
  });

  after(() => {
    if (prevEnv === undefined) delete process.env.OBSIDIAN_ROUTER_CONFIG;
    else process.env.OBSIDIAN_ROUTER_CONFIG = prevEnv;
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  test('returns defaults + a structured questionnaire, no mutation', async () => {
    const target = path.join(workDir, 'MyProject');
    const res = await planVaultTool({}, { path: target });

    // Defaults reflect the reference/recommended/personal plan.
    assert.equal(res.defaults.slug, 'myproject');
    assert.equal(res.defaults.source.kind, 'reference');
    assert.equal(res.defaults.plugins.profile, 'recommended');
    assert.ok(res.defaults.plugins.resolved.includes('smart-connections'));

    // Questionnaire: 5 wiki modes with descriptions, theme options include the
    // source's Blue Topaz, plugin profiles, source options.
    const q = Object.fromEntries(res.questions.map((x) => [x.id, x]));
    assert.equal(q.wikiMode.options.length, 5, 'all 5 wiki modes presented');
    assert.ok(q.wikiMode.options.every((o) => o.description && o.description.length > 0), 'each mode explained');
    assert.ok(q.wikiMode.options.some((o) => o.id === 'domain'));
    assert.ok(q.theme.options.some((o) => o.id === 'Blue Topaz'), 'source theme surfaced');
    assert.ok(q.theme.options.some((o) => o.id === 'obsidian-default'));
    assert.ok(q.plugins.options.some((o) => o.id === 'minimal'));
    assert.ok(q.source.options.some((o) => o.id === 'from-vault'));

    // Context carries known roots (for the provision path gate) + steps.
    assert.ok(Array.isArray(res.context.knownRoots));
    assert.ok(Array.isArray(res.steps) && res.steps.length > 0);

    // READ-ONLY: nothing created on disk.
    assert.ok(!fs.existsSync(target), 'plan_vault must not create the target');
  });

  test('a from-vault plan resolves the source + recommends its plugins', async () => {
    // Register a copyable vault.
    const other = path.join(workDir, 'OtherVault');
    fs.mkdirSync(path.join(other, '.obsidian', 'plugins', 'obsidian-local-rest-api'), { recursive: true });
    fs.mkdirSync(path.join(other, '.obsidian', 'plugins', 'mcp-router-bridge'), { recursive: true });
    fs.writeFileSync(path.join(other, '.obsidian', 'community-plugins.json'),
      JSON.stringify(['obsidian-local-rest-api', 'mcp-router-bridge', 'templater-obsidian']));
    const res = await planVaultTool({}, { path: path.join(workDir, 'Derived'), source: { kind: 'from-vault', fromVault: other } });
    assert.equal(res.defaults.source.kind, 'from-vault');
    assert.equal(path.resolve(res.defaults.source.sourceVault), path.resolve(other));
    assert.ok(res.defaults.plugins.resolved.includes('templater-obsidian'), 'from-vault plugins derived from that source');
  });

  test('requires a path', async () => {
    await assert.rejects(() => planVaultTool({}, {}), /requires `path`/);
  });
});
