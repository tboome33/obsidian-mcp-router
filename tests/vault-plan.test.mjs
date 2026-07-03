// W1 — pure planning layer (scripts/vault-plan.mjs). Unit-tests the wizard's
// "answers → resolved plan" mapping without triggering setup-vault.mjs's CLI.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defaultNameFromPath,
  existingSlugs,
  knownVaultRoots,
  isPathWithinRoots,
  resolveSourceVault,
  resolvePluginProfile,
  buildProvisionPlan,
} from '../scripts/vault-plan.mjs';

const REQUIRED = ['obsidian-local-rest-api', 'mcp-router-bridge'];

function tmpVault(plugins) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-'));
  fs.mkdirSync(path.join(dir, '.obsidian'), { recursive: true });
  if (plugins) {
    fs.writeFileSync(path.join(dir, '.obsidian', 'community-plugins.json'), JSON.stringify(plugins));
  }
  return dir;
}

test('defaultNameFromPath strips leading dot + lowercases (matches registry)', () => {
  assert.equal(defaultNameFromPath('C:\\VAULTS\\.template'), 'template');
  assert.equal(defaultNameFromPath('/home/u/MyVault'), 'myvault');
});

test('resolvePluginProfile: minimal = REQUIRED only', () => {
  assert.deepEqual(resolvePluginProfile('minimal', null, null, REQUIRED), REQUIRED);
});

test('resolvePluginProfile: custom = REQUIRED ∪ list, deduped', () => {
  const list = resolvePluginProfile('custom', ['dataview', 'mcp-router-bridge', 'x'], null, REQUIRED);
  assert.deepEqual(list.slice(0, 2), REQUIRED);
  assert.ok(list.includes('dataview'));
  assert.ok(list.includes('x'));
  assert.equal(list.filter((p) => p === 'mcp-router-bridge').length, 1, 'REQUIRED not duplicated');
});

test('resolvePluginProfile: recommended = source community-plugins ∪ REQUIRED', () => {
  const src = tmpVault(['smart-connections', 'realclaudian']);
  try {
    const list = resolvePluginProfile('recommended', null, src, REQUIRED);
    assert.ok(list.includes('smart-connections'));
    assert.ok(list.includes('realclaudian'));
    for (const r of REQUIRED) assert.ok(list.includes(r));
  } finally { fs.rmSync(src, { recursive: true, force: true }); }
});

test('existingSlugs maps derived + custom names', () => {
  const cfg = {
    portRegistry: { 'C:\\VAULTS\\Foo': 27100, 'C:\\VAULTS\\.template': 27101 },
    vaultNames: { 'C:\\VAULTS\\Foo': 'custom-foo' },
  };
  const slugs = existingSlugs(cfg);
  assert.ok(slugs.has('custom-foo'), 'custom name honored');
  assert.ok(slugs.has('template'), 'derived slug present');
});

test('knownVaultRoots = parents of registered vaults + reference parent', () => {
  const cfg = {
    portRegistry: { [path.join('C:', 'VAULTS', 'Foo')]: 1 },
    referenceVault: path.join('C:', 'VAULTS', '.template'),
  };
  const roots = knownVaultRoots(cfg);
  assert.ok(roots.some((r) => r.endsWith(path.join('C:', 'VAULTS')) || r.endsWith('VAULTS')));
});

test('isPathWithinRoots: inside allowed, sibling-prefix rejected', () => {
  const root = path.resolve('/data/vaults');
  assert.equal(isPathWithinRoots(path.resolve('/data/vaults/new'), [root]), true);
  assert.equal(isPathWithinRoots(root, [root]), true);
  assert.equal(isPathWithinRoots(path.resolve('/data/vaults-evil/new'), [root]), false, 'prefix but not subdir');
  assert.equal(isPathWithinRoots(path.resolve('/etc/passwd'), [root]), false);
});

test('resolveSourceVault: from-vault by slug resolves to registered path', () => {
  const src = tmpVault(['smart-connections']);
  try {
    const cfg = { portRegistry: { [src]: 27100 }, vaultNames: {} };
    const slug = defaultNameFromPath(src);
    const r = resolveSourceVault({ source: 'from-vault', fromVault: slug }, cfg);
    assert.equal(r.sourceVault, src);
    assert.equal(r.error, undefined);
  } finally { fs.rmSync(src, { recursive: true, force: true }); }
});

test('resolveSourceVault: from-vault missing → error', () => {
  const r = resolveSourceVault({ source: 'from-vault', fromVault: '/nope/nope-vault' }, {});
  assert.match(r.error, /not found/);
});

test('resolveSourceVault: from-vault non-obsidian dir → error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notvault-'));
  try {
    const r = resolveSourceVault({ source: 'from-vault', fromVault: dir }, {});
    assert.match(r.error, /not an Obsidian vault/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('buildProvisionPlan: default (reference/recommended/personal) — no mutation', () => {
  const src = tmpVault(['smart-connections', 'templater-obsidian']);
  const target = path.join(os.tmpdir(), 'wizard-target-' + process.pid);
  try {
    const cfg = { referenceVault: src, portRegistry: {}, vaultNames: {} };
    const plan = buildProvisionPlan({ vaultPath: target, opts: {}, cfg, requiredPlugins: REQUIRED });
    assert.equal(plan.slug, path.basename(target).toLowerCase());
    assert.equal(plan.source.kind, 'reference');
    assert.equal(plan.plugins.profile, 'recommended');
    assert.ok(plan.plugins.resolved.includes('smart-connections'));
    assert.equal(plan.wikiMode.mode, 'personal');
    assert.ok(Array.isArray(plan.steps) && plan.steps.length > 0);
    // Read-only: target must NOT have been created.
    assert.ok(!fs.existsSync(target), 'buildProvisionPlan performs no writes');
  } finally { fs.rmSync(src, { recursive: true, force: true }); }
});

test('buildProvisionPlan: --name sets slug + collision warning against a different path', () => {
  const cfg = { portRegistry: { 'C:\\VAULTS\\Existing': 27100 }, vaultNames: { 'C:\\VAULTS\\Existing': 'taken' } };
  const plan = buildProvisionPlan({
    vaultPath: path.join(os.tmpdir(), 'brandnew'),
    opts: { name: 'Taken' }, cfg, requiredPlugins: REQUIRED,
  });
  assert.equal(plan.slug, 'taken');
  assert.ok(plan.warnings.some((w) => w.code === 'slug-collision'));
});

test('buildProvisionPlan: --bare forces minimal plugin profile', () => {
  const src = tmpVault(['smart-connections', 'dataview']);
  try {
    const cfg = { referenceVault: src, portRegistry: {} };
    const plan = buildProvisionPlan({
      vaultPath: path.join(os.tmpdir(), 'bare-t'),
      opts: { source: 'bare' }, cfg, requiredPlugins: REQUIRED,
    });
    assert.equal(plan.plugins.profile, 'minimal');
    assert.deepEqual(plan.plugins.resolved, REQUIRED);
  } finally { fs.rmSync(src, { recursive: true, force: true }); }
});

test('buildProvisionPlan: --wiki-mode code when linkWorkspace; domain w/o sections warns', () => {
  const src = tmpVault(['smart-connections']);
  try {
    const cfg = { referenceVault: src, portRegistry: {} };
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
    const plan1 = buildProvisionPlan({
      vaultPath: path.join(os.tmpdir(), 'code-t'),
      opts: { linkWorkspace: ws }, cfg, requiredPlugins: REQUIRED,
    });
    assert.equal(plan1.wikiMode.mode, 'code', 'workspace-bound default = code');

    const plan2 = buildProvisionPlan({
      vaultPath: path.join(os.tmpdir(), 'dom-t'),
      opts: { wikiMode: 'domain' }, cfg, requiredPlugins: REQUIRED,
    });
    assert.ok(plan2.warnings.some((w) => w.code === 'domain-no-sections'));
    fs.rmSync(ws, { recursive: true, force: true });
  } finally { fs.rmSync(src, { recursive: true, force: true }); }
});

test('buildProvisionPlan: wikiMode.explicit distinguishes passed mode from default', () => {
  const src = tmpVault(['smart-connections']);
  try {
    const cfg = { referenceVault: src, portRegistry: {} };
    const passed = buildProvisionPlan({ vaultPath: path.join(os.tmpdir(), 'e1'), opts: { wikiMode: 'research' }, cfg, requiredPlugins: REQUIRED });
    assert.equal(passed.wikiMode.explicit, true);
    const defaulted = buildProvisionPlan({ vaultPath: path.join(os.tmpdir(), 'e2'), opts: {}, cfg, requiredPlugins: REQUIRED });
    assert.equal(defaulted.wikiMode.explicit, false, 'no --wiki-mode → not explicit (engine keeps generic template)');
    assert.match(defaulted.steps.join('\n'), /generic template unless --wiki-mode/, 'step notes the default caveat');
  } finally { fs.rmSync(src, { recursive: true, force: true }); }
});

test('buildProvisionPlan: skeleton source steps reflect the bootstrap-reference delegation', () => {
  const cfg = { referenceVault: null, portRegistry: {} };
  const plan = buildProvisionPlan({
    vaultPath: path.join(os.tmpdir(), 'sk'),
    opts: { source: 'skeleton' }, cfg, requiredPlugins: REQUIRED, skeletonDir: '/repo/templates/reference-vault-skeleton',
  });
  const joined = plan.steps.join('\n');
  assert.match(joined, /skeleton/i);
  assert.match(joined, /download the mcp-router-bridge/i);
  assert.ok(!/write \.env/.test(joined), 'skeleton plan does NOT promise the full-clone end-state');
});

test('buildProvisionPlan: plan.probe mirrors opts.probe', () => {
  const src = tmpVault(['smart-connections']);
  try {
    const cfg = { referenceVault: src, portRegistry: {} };
    assert.equal(buildProvisionPlan({ vaultPath: path.join(os.tmpdir(), 'p1'), opts: { probe: true }, cfg, requiredPlugins: REQUIRED }).probe, true);
    assert.equal(buildProvisionPlan({ vaultPath: path.join(os.tmpdir(), 'p2'), opts: {}, cfg, requiredPlugins: REQUIRED }).probe, false);
  } finally { fs.rmSync(src, { recursive: true, force: true }); }
});

test('buildProvisionPlan: --theme records choice but flags it blocked', () => {
  const src = tmpVault(['smart-connections']);
  try {
    const cfg = { referenceVault: src, portRegistry: {} };
    const plan = buildProvisionPlan({
      vaultPath: path.join(os.tmpdir(), 'theme-t'),
      opts: { theme: 'Blue Topaz' }, cfg, requiredPlugins: REQUIRED,
    });
    assert.equal(plan.theme.name, 'Blue Topaz');
    assert.equal(plan.theme.blocked, true);
    assert.ok(plan.warnings.some((w) => w.code === 'theme-blocked'));
  } finally { fs.rmSync(src, { recursive: true, force: true }); }
});
