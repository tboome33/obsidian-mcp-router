import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBindingsReader, sharingRequirement } from '../src/helpers/vault-sharing.mjs';
import { _internals as index } from '../src/index.mjs';
import { _internals as registry, loadRegistry } from '../src/registry.mjs';
import { createConformanceGate, createMaintenancePass } from '../src/helpers/vault-conformance.mjs';
import { withVaultLock } from '../src/helpers/vault-maintenance-lock.mjs';
import { assertVaultWritable } from '../src/helpers/vault-reach.mjs';
import { setSecondaryVaultMode } from '../src/tools/set-secondary-vault-mode.mjs';
import { orderedVaultCandidates } from '../hooks/_helpers/doc-drift-detector.mjs';
import { applyWorkspaceDotenv, workspaceBindingProposal } from '../src/helpers/workspace-dotenv.mjs';
import { canonicalWorkspaceKey, migrationDecision } from '../src/helpers/workspace-bindings.mjs';
import { composeBriefing } from '../src/helpers/binding-briefing.mjs';
import { confirmWorkspaceBinding } from '../src/tools/workspace-binding.mjs';
import { registerRemoteVaultTool } from '../src/tools/register-remote-vault.mjs';
import { downloadAssets } from '../src/helpers/asset-downloader.mjs';
import { homeSafeEnv } from './_home-safe-spawn.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lot-remainder-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('A: a successful solo read cannot authorize a write after a failed current read', () => {
  let bytes = JSON.stringify({ workspaceBindings: { [canonicalWorkspaceKey(ROOT)]: { vault: 'ref' } } });
  const reader = createBindingsReader({ configPath: 'injected', readFile: () => {
    if (bytes === 'FAIL') throw new Error('EBUSY');
    return bytes;
  } });
  const good = reader.current();
  assert.equal(sharingRequirement('ref', {}, good).required, false);
  for (const failure of ['FAIL', '{bad', '[]', 'null']) {
    bytes = failure;
    assert.equal(reader.current(), null, failure);
    assert.equal(sharingRequirement('ref', {}, reader.current()).required, true, failure);
  }
  bytes = JSON.stringify(good);
  assert.deepEqual(reader.current(), good, 'recovery restores a current answer');
});

test('B: first contact rechecks a primary becoming soft while waiting for the maintenance lock', async () => {
  const vault = { name: 'race-ref' };
  const reg = { workspaceBinding: { vault: vault.name, also: [] }, vaultReach: 'declared' };
  let release;
  const held = withVaultLock(vault.name, () => new Promise((resolve) => { release = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  let writes = 0;
  const maintain = createMaintenancePass({
    refreshProjections: async () => { writes++; return {}; },
    shouldSkip: (v, context) => index.queuedMaintenanceBlocked(v.name, reg, context),
    logInfo: () => {},
  });
  assert.equal(index.automaticWriteAllowed(vault.name, reg), true);
  const pending = createConformanceGate({ maintain }).ensure(vault);
  await new Promise((resolve) => setImmediate(resolve));
  reg.workspaceBinding = { vault: 'other', also: [vault.name] };
  release();
  await held;
  assert.equal((await pending).skipped, 'blocked-at-run-time');
  assert.equal(writes, 0);
  await maintain(vault);
  assert.equal(writes, 1, 'housekeeping after an approved write still runs on the soft tier');
  reg.workspaceBinding = null;
  assert.equal(index.automaticWriteAllowed(vault.name, reg), false, 'unreachable is never automatic');
});

test('C: the refusal names supported binding-local changes and the mode tool actually lifts that tier', async (t) => {
  const cwd = temporary(t);
  const binding = { vault: 'work', also: ['ref'], alsoLocked: ['ref'] };
  let cfg = { workspaceBindings: { [canonicalWorkspaceKey(cwd)]: binding } };
  const reg = { configPath: path.join(cwd, 'config.json'), workspaceBinding: binding, vaults: [{ name: 'work' }, { name: 'ref' }] };
  assert.throws(() => assertVaultWritable({ name: 'ref' }, reg), /set_secondary_vault_mode.*clearing the binding/s);
  await setSecondaryVaultMode(reg, { vault: 'ref', mode: 'writable' }, {
    cwd, readFile: () => JSON.stringify(cfg), writeFile: (_p, c) => { cfg = JSON.parse(c); },
  });
  assert.doesNotThrow(() => assertVaultWritable({ name: 'ref' }, reg));
  reg.alsoLocked = ['ref'];
  assert.throws(() => assertVaultWritable({ name: 'ref' }, reg), /global.*config.json/s);
});

test('D: drift binding, default and disabled selection preserve exact slug case', (t) => {
  const cwd = temporary(t);
  const a = path.join(cwd, 'lower');
  const b = path.join(cwd, 'upper');
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  const cfg = { portRegistry: { [a]: 27124, [b]: 27125 }, vaultNames: { [a]: 'notes', [b]: 'NOTES' } };
  const bound = { ...cfg, workspaceBindings: { [canonicalWorkspaceKey(cwd)]: { vault: 'NOTES' } } };
  assert.equal(orderedVaultCandidates(cwd, bound)[0], b);
  assert.equal(orderedVaultCandidates(cwd, { ...cfg, defaultVault: 'NOTES' })[0], b);
  assert.deepEqual(orderedVaultCandidates(path.join(cwd, 'unrelated'), { ...cfg, disabledVaults: ['notes'] }), [b]);
});

test('E: proposal and migration both choose the workspace lock over either default', (t) => {
  const cwd = temporary(t);
  for (const hint of ['notes', 'other']) {
    fs.writeFileSync(path.join(cwd, '.env'), `OBSIDIAN_ROUTER_DEFAULT_VAULT=${hint}\nOBSIDIAN_ROUTER_LOCKED=notes\n`);
    const env = {};
    applyWorkspaceDotenv({ cwd, env, warn: () => {} });
    const proposal = workspaceBindingProposal(env);
    const decision = migrationDecision({ hint, hintOrigin: 'workspace-dotenv', lockHint: 'notes', lockHintOrigin: 'workspace-dotenv', isRegistered: () => true });
    assert.equal(proposal.hint, decision.vault);
    assert.equal(proposal.byLock, decision.locked);
    assert.equal(proposal.byLock, true);
  }
});

test('F: stale locked secondaries and stale primaries get executable binding remedies', () => {
  for (const primary of [false, true]) {
    const binding = { vault: primary ? 'gone' : 'work', also: primary ? [] : ['gone'], locked: true };
    const out = composeBriefing({ binding, registeredCount: 1, isRegistered: (n) => n === 'work', hint: { status: 'unknown-vault', hint: 'gone', origin: 'workspace-dotenv' } });
    assert.doesNotMatch(out, /refuse:|"gone" stays bound and addressable/);
    assert.match(out, primary ? /clear: true/ : /also: \[\]/);
    assert.match(out, /cannot be refused/);
  }
});

test('G: clear and no-binding briefing describe declared reachability, including none', async (t) => {
  const cwd = temporary(t);
  let cfg = { workspaceBindings: { [canonicalWorkspaceKey(cwd)]: { vault: 'ref' } } };
  const reg = { configPath: path.join(cwd, 'config.json'), workspaceBinding: cfg.workspaceBindings[canonicalWorkspaceKey(cwd)], vaultReach: 'declared', openVaults: [], vaults: [{ name: 'ref' }] };
  reg.defaultVault = 'ref';
  reg.defaultVaultSource = { origin: 'binding' };
  const out = await confirmWorkspaceBinding(reg, { clear: true }, {
    cwd, readFile: () => JSON.stringify(cfg), writeFile: (_p, c) => { cfg = JSON.parse(c); },
  });
  assert.match(out.message, /openVaults.*possibly none/);
  assert.equal(reg.defaultVault, undefined, 'clearing re-runs the reachable default cascade');
  assert.doesNotMatch(out.message, /All registered vaults are available/);
  assert.match(composeBriefing({ registeredCount: 1 }), /vaultReach.*openVaults.*possibly none/s);
});

test('H: every default tier filters unreachable vaults; unset reach keeps the old cascade', () => {
  const vaults = [{ name: 'private', type: 'local' }, { name: 'public', type: 'remote' }];
  const base = { vaults, configuredDefault: 'private' };
  const resolve = registry.resolveDefaultVaultWithSource;
  assert.equal(resolve({ ...base, reach: { vaultReach: 'declared' } }).name, undefined);
  assert.equal(resolve({ ...base, reach: { vaultReach: 'declared', openVaults: ['public'] } }).name, 'public');
  assert.equal(resolve(base).name, 'private');
});

test('H wiring: loading an unbound declared registry cannot announce an unreachable default', async (t) => {
  const cwd = temporary(t);
  const configPath = path.join(cwd, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ vaultReach: 'declared', defaultVault: 'private', remoteVaults: [{ name: 'private', baseUrl: 'https://example.invalid', apiKey: 'fixture' }] }));
  const reg = await loadRegistry({ configPath });
  assert.equal(reg.defaultVault, undefined);
});

test('I: empty query and fragment delimiters are refused before registration', async (t) => {
  const cwd = temporary(t);
  for (const suffix of ['?', '#']) {
    let writes = 0;
    await assert.rejects(registerRemoteVaultTool({ configPath: path.join(cwd, 'config.json') }, { name: 'ref', baseUrl: `https://example.invalid/${suffix}`, apiKey: 'fixture' }, {
      readFile: () => '{}', writeFile: () => { writes++; },
    }), /baseUrl/);
    assert.equal(writes, 0);
  }
});

test('J: name-only setup refuses adoption of an existing folder through a filesystem alias', (t) => {
  const cwd = temporary(t);
  const real = path.join(cwd, 'real');
  const alias = path.join(cwd, 'my-vault');
  fs.mkdirSync(real);
  try { fs.symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) { t.skip(`Cannot create directory link: ${e.code}`); return; }
  const configPath = path.join(cwd, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ vaultsRoot: cwd, portRegistry: { [real]: 27124 }, vaultNames: { [real]: 'original' } }));
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'setup-vault.mjs'), '--name', 'My Vault', '--dry-run', '--json'], {
    cwd, encoding: 'utf8', env: homeSafeEnv(cwd, { OBSIDIAN_ROUTER_CONFIG: configPath, OBSIDIAN_ROUTER_NO_AUTO_INSTALL_HOOKS: '1' }),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /already registered as vault.*original/s);
  if (process.platform === 'win32') {
    fs.writeFileSync(configPath, JSON.stringify({ vaultsRoot: cwd, portRegistry: { [alias.toUpperCase()]: 27124 }, vaultNames: { [alias.toUpperCase()]: 'original' } }));
    const byCase = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'setup-vault.mjs'), '--name', 'My Vault', '--dry-run', '--json'], {
      cwd, encoding: 'utf8', env: homeSafeEnv(cwd, { OBSIDIAN_ROUTER_CONFIG: configPath, OBSIDIAN_ROUTER_NO_AUTO_INSTALL_HOOKS: '1' }),
    });
    assert.notEqual(byCase.status, 0);
    assert.match(byCase.stdout + byCase.stderr, /already registered as vault.*original/s);
  }
});

test('K: asset batches preserve rename and already-present metadata across repeat downloads', async (t) => {
  const cwd = temporary(t);
  fs.writeFileSync(path.join(cwd, 'hero.png'), 'existing');
  const opts = { createOnly: true, _fetchFn: async () => ({ buffer: Buffer.alloc(2048, 7), contentType: 'image/png' }) };
  const urls = ['https://example.invalid/hero.png'];
  const first = await downloadAssets(urls, cwd, opts);
  assert.equal(first.downloaded[0].renamedFrom, 'hero.png');
  const second = await downloadAssets(urls, cwd, opts);
  assert.equal(second.downloaded[0].alreadyPresent, true);
  assert.equal(second.downloaded[0].savedAs, first.downloaded[0].savedAs);
});
