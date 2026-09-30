/**
 * `--install-plugins` — plan, seal, apply, driven in-process through
 * runInstallPlugins with a fake GitHub (tests/fixtures/plugin-github-fake.mjs)
 * and vaults built under fs.mkdtempSync. No network, no real vault, no real
 * router config: the config is a temp file passed with --config.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInstallPlugins, parseInstallArgs, setupVaultSymbols } from '../scripts/install-plugins.mjs';
import { createGuardedFetch } from '../src/helpers/plugin-release-resolver.mjs';
import { buildInstallPlan, applyInstallPlan, readCommunityPlugins, ensureCommunityPluginsListed } from '../src/helpers/plugin-installer.mjs';
import { resolvePluginTarget } from '../src/helpers/plugin-cli-target.mjs';
import {
  fakeGitHub, standardFleet, testSymbols, TEST_ALLOWLIST, TEST_REQUIRED, BRIDGE_REPO,
} from './fixtures/plugin-github-fake.mjs';

const tmpRoots = [];
afterEach(() => {
  while (tmpRoots.length) fs.rmSync(tmpRoots.pop(), { recursive: true, force: true });
});

function makeVault({ enabled = [], plugins = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-plugins-'));
  tmpRoots.push(root);
  const vault = path.join(root, 'testvault');
  fs.mkdirSync(path.join(vault, '.obsidian', 'plugins'), { recursive: true });
  if (enabled !== null) fs.writeFileSync(path.join(vault, '.obsidian', 'community-plugins.json'), JSON.stringify(enabled, null, 2));
  for (const [id, files] of Object.entries(plugins)) {
    const dir = path.join(vault, '.obsidian', 'plugins', id);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  }
  const config = path.join(root, 'router-config.json');
  fs.writeFileSync(config, JSON.stringify({ portRegistry: { [vault]: 27124 } }));
  return { root, vault, config };
}

function run(argv, { transport, config, symbols = testSymbols() }) {
  const out = [];
  const err = [];
  return runInstallPlugins([...argv, '--config', config], {
    fetch: createGuardedFetch({ transport }),
    symbols,
    env: {},
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  }).then((code) => ({ code, out: out.join('\n'), err: err.join('\n') }));
}

const sealOf = (text) => (text.match(/approvedPlanSha256: ([0-9a-f]{64})/) || [])[1];
const pluginFile = (vault, id, name) => path.join(vault, '.obsidian', 'plugins', id, name);

describe('dry run', () => {
  test('prints each plugin with registry repo → resolved repo, tag, assets, destination, and a seal; writes nothing', async () => {
    const { vault, config } = makeVault({ enabled: ['obsidian-style-settings', 'templater-obsidian', 'some-outsider'] });
    const gh = fakeGitHub(standardFleet());
    const before = fs.readFileSync(path.join(vault, '.obsidian', 'community-plugins.json'), 'utf8');
    const r = await run(['testvault', '--dry-run'], { transport: gh.transport, config });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /obsidian-style-settings {2}\(install\)/);
    assert.match(r.out, /old-owner\/obsidian-style-settings → REDIRECTED to community-archive\/obsidian-style-settings/);
    assert.match(r.out, /release {5}: 1\.0\.9/);
    assert.match(r.out, /main\.js [\d.]+ (B|KB), manifest\.json [\d.]+ (B|KB), styles\.css/);
    assert.match(r.out, /destination : \.obsidian\/plugins\/obsidian-style-settings/);
    assert.match(r.out, /templater-obsidian {2}\(install\)/);
    assert.match(r.out, /mcp-router-bridge {2}\(install\)/);
    assert.match(r.out, new RegExp(`the bridge's own GitHub release — ${BRIDGE_REPO}`));
    assert.match(r.out, /Outside the network allowlist \(reported, never downloaded\): some-outsider/);
    assert.ok(sealOf(r.out), 'a seal is printed');
    // Nothing written, and the outsider's repository was never contacted.
    assert.equal(fs.existsSync(pluginFile(vault, 'obsidian-style-settings', 'main.js')), false);
    assert.equal(fs.readFileSync(path.join(vault, '.obsidian', 'community-plugins.json'), 'utf8'), before);
    assert.ok(!gh.calls.some((u) => u.includes('outsider/plugin')), 'an out-of-allowlist plugin was contacted');
    // The impostor registry entry for the bridge's id is never used.
    assert.ok(!gh.calls.some((u) => u.includes('impostor')), 'the bridge was resolved through the registry');
  });

  test('already-installed code is reported and left alone', async () => {
    const { vault, config } = makeVault({
      enabled: ['templater-obsidian'],
      plugins: { 'templater-obsidian': { 'main.js': 'OLD', 'manifest.json': '{"id":"templater-obsidian","version":"1.0.0"}' } },
    });
    const gh = fakeGitHub(standardFleet());
    const r = await run(['testvault', '--dry-run'], { transport: gh.transport, config });
    assert.match(r.out, /Already installed .*: templater-obsidian/);
    assert.doesNotMatch(r.out, /templater-obsidian {2}\(install\)/);
    assert.equal(fs.readFileSync(pluginFile(vault, 'templater-obsidian', 'main.js'), 'utf8'), 'OLD');
  });

  test('a manifest whose id differs from the requested id refuses that plugin', async () => {
    const { config } = makeVault({ enabled: ['templater-obsidian'] });
    const routes = standardFleet();
    const cdn = Object.keys(routes).find((u) => u.startsWith('https://release-assets.githubusercontent.com/') && u.includes('manifest.json'));
    const body = JSON.stringify({ id: 'not-templater', version: '2.3.0' });
    routes[cdn] = { status: 200, body };
    // keep the declared size honest so the refusal is the id, not the size
    const api = routes['https://api.github.com/repos/tmpl-owner/Templater/releases/latest'];
    api.body.assets.find((a) => a.name === 'manifest.json').size = Buffer.byteLength(body);
    const r = await run(['testvault', '--dry-run'], { transport: fakeGitHub(routes).transport, config });
    // Order-free: the Refused block may list other plugins before this one.
    assert.match(r.out.slice(r.out.indexOf('Refused:')), /^ {2}templater-obsidian: manifest\.json id mismatch/m);
    assert.doesNotMatch(r.out, /templater-obsidian {2}\(install\)/);
  });
});

describe('apply', () => {
  test('refuses without a seal, before any network call', async () => {
    const { config } = makeVault({ enabled: ['templater-obsidian'] });
    const gh = fakeGitHub(standardFleet());
    const r = await run(['testvault'], { transport: gh.transport, config });
    assert.equal(r.code, 2);
    assert.match(r.err, /refusing to write without an approved plan/);
    assert.equal(gh.calls.length, 0);
  });

  test('a seal that no longer matches (a release published since the dry run) refuses and writes nothing', async () => {
    const { vault, config } = makeVault({ enabled: ['obsidian-style-settings'] });
    const dry = await run(['testvault', '--dry-run'], { transport: fakeGitHub(standardFleet()).transport, config });
    const seal = sealOf(dry.out);
    const moved = fakeGitHub(standardFleet({ styleTag: '1.1.0' }));
    const r = await run(['testvault', '--approved-plan-sha256', seal], { transport: moved.transport, config });
    assert.equal(r.code, 1);
    assert.match(r.err, /sealed-preview drift/);
    assert.equal(fs.existsSync(pluginFile(vault, 'obsidian-style-settings', 'main.js')), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(vault, '.obsidian', 'community-plugins.json'), 'utf8')), ['obsidian-style-settings']);
  });

  test('a matching seal installs, keeps data.json byte-identical, and lists the ids in community-plugins.json', async () => {
    const DATA = '{"secret":"per-vault settings"}';
    const { vault, config } = makeVault({
      enabled: ['obsidian-style-settings'],
      // settings only: a folder with data.json and no code
      plugins: { 'mcp-router-bridge': { 'data.json': DATA } },
    });
    const gh = fakeGitHub(standardFleet());
    const dry = await run(['testvault', '--dry-run'], { transport: gh.transport, config });
    const r = await run(['testvault', '--approved-plan-sha256', sealOf(dry.out)], { transport: gh.transport, config });
    assert.equal(r.code, 0, r.err);
    assert.match(fs.readFileSync(pluginFile(vault, 'obsidian-style-settings', 'main.js'), 'utf8'), /style-settings 1\.0\.9/);
    assert.ok(fs.existsSync(pluginFile(vault, 'obsidian-style-settings', 'styles.css')));
    assert.match(fs.readFileSync(pluginFile(vault, 'mcp-router-bridge', 'main.js'), 'utf8'), /bridge 0\.4\.0/);
    assert.equal(fs.readFileSync(pluginFile(vault, 'mcp-router-bridge', 'data.json'), 'utf8'), DATA);
    assert.match(fs.readFileSync(pluginFile(vault, 'obsidian-local-rest-api', 'main.js'), 'utf8'), /lra 3\.1\.0/);
    const listed = JSON.parse(fs.readFileSync(path.join(vault, '.obsidian', 'community-plugins.json'), 'utf8'));
    assert.deepEqual(listed, ['obsidian-style-settings', 'obsidian-local-rest-api', 'mcp-router-bridge']);
    // No staging directory left behind.
    assert.deepEqual(fs.readdirSync(path.join(vault, '.obsidian', 'plugins')).filter((n) => n.startsWith('.')), []);
    assert.match(r.out, /Reload app without saving/);
    assert.match(r.out, /Restricted mode must be OFF/);
    assert.match(r.out, /--plugin-health "testvault"/);
  });

  test('never overwrites an existing main.js without --force; --force reinstalls and still keeps data.json', async () => {
    const DATA = '{"k":1}';
    const { vault, config } = makeVault({
      enabled: ['templater-obsidian'],
      plugins: { 'templater-obsidian': { 'main.js': 'OLD', 'manifest.json': '{"id":"templater-obsidian","version":"1.0.0"}', 'data.json': DATA } },
    });
    const gh = fakeGitHub(standardFleet());
    const dry = await run(['testvault', '--dry-run', '--only', 'templater-obsidian'], { transport: gh.transport, config });
    const r = await run(['testvault', '--approved-plan-sha256', sealOf(dry.out), '--only', 'templater-obsidian'], { transport: gh.transport, config });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Nothing to install/);
    assert.equal(fs.readFileSync(pluginFile(vault, 'templater-obsidian', 'main.js'), 'utf8'), 'OLD');

    const dryF = await run(['testvault', '--dry-run', '--only', 'templater-obsidian', '--force'], { transport: gh.transport, config });
    assert.match(dryF.out, /templater-obsidian {2}\(reinstall\)/);
    // A --force seal is not valid for an apply without --force.
    const noForce = await run(['testvault', '--approved-plan-sha256', sealOf(dryF.out), '--only', 'templater-obsidian'], { transport: gh.transport, config });
    assert.equal(noForce.code, 1);
    assert.equal(fs.readFileSync(pluginFile(vault, 'templater-obsidian', 'main.js'), 'utf8'), 'OLD');
    const rF = await run(['testvault', '--approved-plan-sha256', sealOf(dryF.out), '--only', 'templater-obsidian', '--force'], { transport: gh.transport, config });
    assert.equal(rF.code, 0, rF.err);
    assert.match(fs.readFileSync(pluginFile(vault, 'templater-obsidian', 'main.js'), 'utf8'), /templater 2\.3\.0/);
    assert.equal(fs.readFileSync(pluginFile(vault, 'templater-obsidian', 'data.json'), 'utf8'), DATA);
  });

  test('a seal is bound to its vault: replayed against another vault it refuses', async () => {
    const a = makeVault({ enabled: ['templater-obsidian'] });
    const b = makeVault({ enabled: ['templater-obsidian'] });
    const gh = fakeGitHub(standardFleet());
    const dry = await run([a.vault, '--dry-run'], { transport: gh.transport, config: a.config });
    const r = await run([b.vault, '--approved-plan-sha256', sealOf(dry.out)], { transport: gh.transport, config: b.config });
    assert.equal(r.code, 1);
    assert.equal(fs.existsSync(pluginFile(b.vault, 'templater-obsidian', 'main.js')), false);
  });

  // A link INSIDE the vault (a junction on Windows, a symlink elsewhere) sends
  // every write below it wherever the link points, and the seal — bound to
  // the lexical path — would not notice one swapped in after the preview.
  // Planted between the dry run and the apply, exactly the window the seal
  // does not cover.
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  test(`\`.obsidian/plugins\` replaced by a ${linkType} after the dry run: the apply refuses, and nothing lands where the link points`, async () => {
    const { root, vault, config } = makeVault({ enabled: ['templater-obsidian'] });
    const gh = fakeGitHub(standardFleet());
    const dry = await run(['testvault', '--dry-run'], { transport: gh.transport, config });
    const seal = sealOf(dry.out);
    assert.ok(seal, dry.out);
    const outside = path.join(root, 'elsewhere');
    fs.mkdirSync(outside);
    const pluginsDir = path.join(vault, '.obsidian', 'plugins');
    fs.rmSync(pluginsDir, { recursive: true, force: true });
    fs.symlinkSync(outside, pluginsDir, linkType);
    assert.ok(fs.lstatSync(pluginsDir).isSymbolicLink(), 'the fixture did not plant a link');
    const r = await run(['testvault', '--approved-plan-sha256', seal], { transport: gh.transport, config });
    assert.notEqual(r.code, 0, r.out);
    assert.match(`${r.out}\n${r.err}`, /not a plain directory/);
    assert.deepEqual(fs.readdirSync(outside), [], 'a write went through the link');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(vault, '.obsidian', 'community-plugins.json'), 'utf8')), ['templater-obsidian']);
  });

  test(`\`community-plugins.json\` that is a link is not written through`, () => {
    const { root, vault } = makeVault({ enabled: [] });
    const target = path.join(root, 'elsewhere.json');
    fs.writeFileSync(target, '[]');
    const file = path.join(vault, '.obsidian', 'community-plugins.json');
    fs.rmSync(file);
    fs.symlinkSync(target, file, 'file');
    const r = ensureCommunityPluginsListed(vault, ['templater-obsidian']);
    assert.equal(r.state, 'refused');
    assert.deepEqual(r.added, []);
    assert.equal(fs.readFileSync(target, 'utf8'), '[]', 'the link target was rewritten');
  });
});

describe('targets and preconditions', () => {
  test('a remote vault without localPath is refused with the fix', async () => {
    const { root } = makeVault();
    const config = path.join(root, 'remote-config.json');
    fs.writeFileSync(config, JSON.stringify({ remoteVaults: [{ name: 'nas', baseUrl: 'https://nas.example:27124', apiKey: 'k' }] }));
    const gh = fakeGitHub(standardFleet());
    const r = await run(['nas', '--dry-run'], { transport: gh.transport, config });
    assert.equal(r.code, 2);
    assert.match(r.err, /remote vault with no localPath/);
    assert.match(r.err, /Add "localPath"/);
    assert.equal(gh.calls.length, 0);
  });

  test('a remote vault WITH localPath resolves to that folder', () => {
    const { vault } = makeVault();
    const t = resolvePluginTarget({ remoteVaults: [{ name: 'nas', baseUrl: 'https://nas.example', apiKey: 'k', localPath: vault }] }, 'nas');
    assert.equal(t.ok, true);
    assert.equal(t.type, 'remote');
    assert.equal(t.vaultPath, path.resolve(vault));
    assert.equal(t.endpoint.baseUrl, 'https://nas.example');
  });

  test('an invalid community-plugins.json is refused, never rewritten', async () => {
    const { vault, config } = makeVault({ enabled: null });
    fs.writeFileSync(path.join(vault, '.obsidian', 'community-plugins.json'), '{"not":"an array"}');
    const r = await run(['testvault', '--dry-run'], { transport: fakeGitHub(standardFleet()).transport, config });
    assert.equal(r.code, 1);
    assert.match(r.err, /not a JSON array/);
    assert.equal(fs.readFileSync(path.join(vault, '.obsidian', 'community-plugins.json'), 'utf8'), '{"not":"an array"}');
  });

  test('without the setup-vault exports the command refuses and names them', async () => {
    const { config } = makeVault();
    const r = await run(['testvault', '--dry-run'], { transport: fakeGitHub({}).transport, config, symbols: setupVaultSymbols({}) });
    assert.equal(r.code, 2);
    assert.match(r.err, /does not export NETWORK_PLUGIN_ALLOWLIST, REQUIRED_PLUGINS, BRIDGE_PLUGIN_URLS/);
    // Positive control: the right shapes are accepted.
    assert.deepEqual(setupVaultSymbols({ NETWORK_PLUGIN_ALLOWLIST: new Set(['a']), REQUIRED_PLUGINS: ['a'], BRIDGE_PLUGIN_URLS: { 'main.js': 'x' } }).missing, []);
  });

  test('argument parsing: dry-run and seal are exclusive, a malformed seal is refused', () => {
    assert.match(parseInstallArgs(['v', '--dry-run', '--approved-plan-sha256', 'a'.repeat(64)]).error, /exclusive/);
    assert.match(parseInstallArgs(['v', '--approved-plan-sha256', 'nothex']).error, /64-hex/);
    assert.deepEqual(parseInstallArgs(['--install-plugins', 'v', '--only', 'a, b,a']).only, ['a', 'b']);
  });

  test('refuses to run inside the router server process', async () => {
    const { vault } = makeVault();
    const MARK = Symbol.for('obsidian-mcp-router.server-process');
    const prev = globalThis[MARK];
    globalThis[MARK] = true;
    try {
      // Each door refuses AT ITS OWN ENTRY — the message names the function —
      // not because a helper it happens to call first is guarded too.
      await assert.rejects(
        buildInstallPlan({ vaultPath: vault, fetch: async () => { throw new Error('no network'); }, allowlist: TEST_ALLOWLIST, required: TEST_REQUIRED, bridgeRepo: BRIDGE_REPO }),
        /^Error: buildInstallPlan: refusing .* inside the router server process/,
      );
      await assert.rejects(
        applyInstallPlan({ vaultPath: vault, plan: { install: [], force: false }, fetch: async () => { throw new Error('no network'); } }),
        /^Error: applyInstallPlan: refusing .* inside the router server process/,
      );
      assert.throws(() => readCommunityPlugins(vault), /^Error: readCommunityPlugins: refusing/);
      assert.throws(() => ensureCommunityPluginsListed(vault, ['x']), /^Error: ensureCommunityPluginsListed: refusing/);
      assert.equal(fs.existsSync(path.join(vault, '.obsidian', 'community-plugins.json')), true);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(vault, '.obsidian', 'community-plugins.json'), 'utf8')), []);
    } finally {
      if (prev === undefined) delete globalThis[MARK]; else globalThis[MARK] = prev;
    }
  });
});
