/**
 * `--plugin-health` — the disk inventory, the live evidence from GET
 * /commands/, the verdict and its exit codes. Vaults under fs.mkdtempSync; the
 * REST API is an injected request function; the one end-to-end case spawns
 * the real binary with HOME/USERPROFILE/HOMEDRIVE/HOMEPATH pointed at the
 * temp dir and --offline, so nothing leaves the machine.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  inspectVaultPlugins,
  parseCommandsEvidence,
  gatherLiveEvidence,
  evaluatePluginHealth,
  loadExpectedPlugins,
  readLocalRestEndpoint,
  OPEN_PROBE_PATH,
} from '../src/helpers/plugin-inventory.mjs';
import { runPluginHealth } from '../scripts/plugin-health.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpRoots = [];
afterEach(() => {
  while (tmpRoots.length) fs.rmSync(tmpRoots.pop(), { recursive: true, force: true });
});

const CODE = (id, version = '1.0.0') => ({ 'main.js': 'module.exports={}', 'manifest.json': JSON.stringify({ id, version }) });

function makeVault({ enabled = [], plugins = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-health-'));
  tmpRoots.push(root);
  const vault = path.join(root, 'healthvault');
  fs.mkdirSync(path.join(vault, '.obsidian', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(vault, '.obsidian', 'community-plugins.json'), JSON.stringify(enabled));
  for (const [id, files] of Object.entries(plugins)) {
    const dir = path.join(vault, '.obsidian', 'plugins', id);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  }
  const config = path.join(root, 'router-config.json');
  fs.writeFileSync(config, JSON.stringify({ portRegistry: { [vault]: 27124 } }));
  return { root, vault, config };
}

const HEALTHY = {
  'obsidian-local-rest-api': { ...CODE('obsidian-local-rest-api', '3.1.0'), 'data.json': JSON.stringify({ port: 27999, apiKey: 'test-key', enableInsecureServer: true, insecurePort: 27998 }) },
  'mcp-router-bridge': CODE('mcp-router-bridge', '0.4.0'),
};

describe('inventory classification', () => {
  test('code / settings-only / enabled-without-code / bridge absent', () => {
    const { vault } = makeVault({
      enabled: ['obsidian-local-rest-api', 'templater-obsidian', 'obsidian-icon-folder'],
      plugins: {
        'obsidian-local-rest-api': CODE('obsidian-local-rest-api', '3.1.0'),
        'obsidian-icon-folder': { 'data.json': '{}' },
        'stray-plugin': CODE('some-other-id'),
      },
    });
    const inv = inspectVaultPlugins(vault, { expected: ['templater-obsidian'] });
    const by = Object.fromEntries(inv.plugins.map((p) => [p.id, p]));
    assert.equal(by['obsidian-local-rest-api'].codeInstalled, true);
    assert.equal(by['obsidian-local-rest-api'].version, '3.1.0');
    assert.equal(by['obsidian-icon-folder'].settingsOnly, true);
    assert.equal(by['obsidian-icon-folder'].codeInstalled, false);
    assert.equal(by['templater-obsidian'].dirPresent, false);
    assert.equal(by['stray-plugin'].manifestIdMatches, false);
    assert.equal(by['stray-plugin'].enabledListed, false);
    assert.deepEqual(inv.enabledWithoutCode.sort(), ['obsidian-icon-folder', 'templater-obsidian']);
    assert.equal(inv.bridge, 'absent');
    assert.deepEqual(inv.missing.sort(), ['mcp-router-bridge', 'templater-obsidian']);
  });

  test('bridge settings-only is its own state', () => {
    const { vault } = makeVault({ plugins: { 'mcp-router-bridge': { 'data.json': '{}' } } });
    assert.equal(inspectVaultPlugins(vault).bridge, 'settings-only');
  });

  test('the expected set is the bundled skeleton ∪ REQUIRED', () => {
    const expected = loadExpectedPlugins(path.join(REPO, 'templates', 'reference-vault-skeleton', '.obsidian', 'community-plugins.json'));
    assert.ok(expected.includes('obsidian-local-rest-api'));
    assert.ok(expected.includes('mcp-router-bridge'));
    assert.ok(expected.includes('smart-connections'));
    assert.deepEqual(loadExpectedPlugins('does-not-exist.json'), ['obsidian-local-rest-api', 'mcp-router-bridge']);
  });
});

describe('/commands/ evidence', () => {
  test('plugin ids are the command-id prefix; core areas and malformed entries are ignored', () => {
    const ids = parseCommandsEvidence({
      commands: [
        { id: 'templater-obsidian:insert-templater', name: 'x' },
        { id: 'templater-obsidian:other', name: 'y' },
        { id: 'editor:toggle-bold', name: 'z' },
        { id: 'nocolon' },
        { id: ':leading' },
        null,
        { name: 'no id' },
      ],
    });
    assert.deepEqual([...ids].sort(), ['editor', 'templater-obsidian']);
    assert.equal(parseCommandsEvidence({ nope: [] }), null);
    assert.equal(parseCommandsEvidence(null), null);
  });

  test('the live endpoint uses the router\'s port rule: disk first, registry as fallback, no key → no probe', () => {
    const { vault } = makeVault({ plugins: { 'obsidian-local-rest-api': HEALTHY['obsidian-local-rest-api'] } });
    const ep = readLocalRestEndpoint(vault, { registryPorts: { https: 27111, http: 27112 } });
    assert.equal(ep.baseUrl, 'https://127.0.0.1:27999');
    assert.equal(ep.insecurePort, 27998);
    assert.equal(ep.apiKey, 'test-key');

    const noPort = makeVault({ plugins: { 'obsidian-local-rest-api': { 'data.json': JSON.stringify({ apiKey: 'k2' }) } } });
    const fb = readLocalRestEndpoint(noPort.vault, { registryPorts: { https: 27111, http: 27112 } });
    assert.equal(fb.baseUrl, 'https://127.0.0.1:27111');
    assert.equal(fb.insecurePort, null, 'enableInsecureServer absent means off');

    const noKey = makeVault({ plugins: { 'obsidian-local-rest-api': { 'data.json': JSON.stringify({ port: 27999 }) } } });
    assert.equal(readLocalRestEndpoint(noKey.vault, { registryPorts: { https: 27111, http: null } }), null);
  });

  test('gatherLiveEvidence: authorised GET /commands/ and the bridge /open/ probe', async () => {
    const seen = [];
    const request = async (url, opts) => {
      seen.push({ url, auth: opts.headers.authorization, tlsInsecure: opts.tlsInsecure });
      if (url.endsWith('/commands/')) return { status: 200, body: JSON.stringify({ commands: [{ id: 'templater-obsidian:a' }] }) };
      if (url.endsWith(OPEN_PROBE_PATH)) return { status: 404, body: '' };
      return { status: 500 };
    };
    const ev = await gatherLiveEvidence({ endpoint: { baseUrl: 'https://127.0.0.1:27999', apiKey: 'k', tlsInsecure: true, insecurePort: 27998 }, request });
    assert.equal(ev.reachable, true);
    assert.deepEqual(ev.loadedIds, ['templater-obsidian']);
    assert.equal(ev.bridgeRoute, 'live');
    assert.equal(seen[0].url, 'https://127.0.0.1:27999/commands/');
    assert.equal(seen[0].auth, 'Bearer k');
    assert.equal(seen[1].url, `http://127.0.0.1:27998${OPEN_PROBE_PATH}`);
  });

  test('a REMOTE vault\'s bridge is probed at its declared baseUrl, without the API key', async () => {
    const seen = [];
    const request = async (url, opts) => {
      seen.push({ url, auth: opts.headers.authorization, tlsInsecure: opts.tlsInsecure });
      if (url.endsWith('/commands/')) return { status: 200, body: '{"commands":[]}' };
      if (url.endsWith(OPEN_PROBE_PATH)) return { status: 404, body: '' };
      return { status: 500 };
    };
    const ev = await gatherLiveEvidence({
      endpoint: { baseUrl: 'http://192.0.2.10:27180/', apiKey: 'k', insecurePort: null, openProbeBase: 'http://192.0.2.10:27180/' },
      request,
    });
    assert.equal(ev.bridgeRoute, 'live');
    assert.equal(seen[1].url, `http://192.0.2.10:27180${OPEN_PROBE_PATH}`);
    assert.equal(seen[1].auth, undefined, 'the /open/ probe must not carry the API key');
  });

  test('a 401 on /open/ means the route is not registered; no endpoint means not probed', async () => {
    const request = async (url) => (url.endsWith('/commands/') ? { status: 200, body: '{"commands":[]}' } : { status: 401 });
    const ev = await gatherLiveEvidence({ endpoint: { baseUrl: 'https://h', apiKey: 'k', insecurePort: 1 }, request });
    assert.equal(ev.bridgeRoute, 'not-registered');
    const none = await gatherLiveEvidence({ endpoint: null, request: async () => { throw new Error('must not be called'); } });
    assert.equal(none.probed, false);
  });

  test('loaded / not-loaded / no-command-seen per row', () => {
    const { vault } = makeVault({
      enabled: ['obsidian-local-rest-api', 'mcp-router-bridge', 'templater-obsidian', 'obsidian-quiet-outline'],
      plugins: { ...HEALTHY, 'templater-obsidian': CODE('templater-obsidian'), 'obsidian-quiet-outline': CODE('obsidian-quiet-outline') },
    });
    const inv = inspectVaultPlugins(vault, { expected: ['templater-obsidian', 'obsidian-quiet-outline'] });
    const v = evaluatePluginHealth(inv, { probed: true, reachable: true, loadedIds: ['templater-obsidian'], bridgeRoute: 'live' });
    const by = Object.fromEntries(v.rows.map((r) => [r.id, r.live]));
    assert.equal(by['templater-obsidian'], 'loaded');
    assert.equal(by['obsidian-local-rest-api'], 'loaded');
    assert.equal(by['mcp-router-bridge'], 'loaded');
    assert.equal(by['obsidian-quiet-outline'], 'no-commands-seen');
    assert.ok(v.problems.some((p) => p.id === 'obsidian-quiet-outline' && p.kind === 'not-seen-loaded' && p.soft));
    assert.equal(v.exitCode, 0, 'a soft "no command seen" never fails the check');
  });
});

describe('health verdict and exit codes', () => {
  function runHealth(argv, { config, request }) {
    const out = [];
    const err = [];
    return runPluginHealth([...argv, '--config', config], {
      env: {}, request, out: (s) => out.push(s), err: (s) => err.push(s),
    }).then((code) => ({ code, out: out.join('\n'), err: err.join('\n') }));
  }
  const offlineRequest = async () => ({ status: null, error: 'ECONNREFUSED' });

  test('healthy vault → exit 0', async () => {
    const { config } = makeVault({ enabled: ['obsidian-local-rest-api', 'mcp-router-bridge'], plugins: HEALTHY });
    const r = await runHealth(['healthvault'], { config, request: offlineRequest });
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /Required plugins: OK/);
    assert.match(r.out, /Bridge: installed/);
  });

  test('bridge absent → exit 1, with the explicit line and the install command', async () => {
    const { config } = makeVault({ enabled: ['obsidian-local-rest-api'], plugins: { 'obsidian-local-rest-api': HEALTHY['obsidian-local-rest-api'] } });
    const r = await runHealth(['healthvault'], { config, request: offlineRequest });
    assert.equal(r.code, 1);
    assert.match(r.out, /Bridge: absent/);
    assert.match(r.out, /--install-plugins "healthvault" --only mcp-router-bridge --dry-run/);
  });

  test('a required plugin enabled without code → exit 1; an optional one → exit 0 but named', async () => {
    const req = makeVault({ enabled: ['obsidian-local-rest-api', 'mcp-router-bridge'], plugins: { 'mcp-router-bridge': HEALTHY['mcp-router-bridge'], 'obsidian-local-rest-api': { 'data.json': '{}' } } });
    const r1 = await runHealth(['healthvault'], { config: req.config, request: offlineRequest });
    assert.equal(r1.code, 1);
    assert.match(r1.out, /Enabled without code: obsidian-local-rest-api/);
    assert.match(r1.out, /enabled in community-plugins\.json but has no code on disk \(settings only\)/);

    const opt = makeVault({ enabled: ['obsidian-local-rest-api', 'mcp-router-bridge', 'templater-obsidian'], plugins: HEALTHY });
    const r2 = await runHealth(['healthvault'], { config: opt.config, request: offlineRequest });
    assert.equal(r2.code, 0);
    assert.match(r2.out, /Enabled without code: templater-obsidian/);
  });

  test('--json carries the same verdict and never the API key', async () => {
    const { config } = makeVault({ enabled: ['obsidian-local-rest-api'], plugins: HEALTHY });
    const request = async (url) => (url.endsWith('/commands/') ? { status: 200, body: '{"commands":[]}' } : { status: 404 });
    const r = await runHealth(['healthvault', '--json'], { config, request });
    const doc = JSON.parse(r.out);
    assert.equal(doc.ok, true);
    assert.equal(doc.bridge, 'installed');
    assert.equal(doc.live.bridgeRoute, 'live');
    assert.doesNotMatch(r.out, /test-key/);
  });

  test('remote vault without localPath → exit 2', async () => {
    const { root } = makeVault();
    const config = path.join(root, 'remote.json');
    fs.writeFileSync(config, JSON.stringify({ remoteVaults: [{ name: 'nas', baseUrl: 'https://nas.example', apiKey: 'k' }] }));
    const r = await runHealth(['nas'], { config, request: offlineRequest });
    assert.equal(r.code, 2);
    assert.match(r.err, /no localPath/);
  });

  test('refuses to read vault disk inside the router server process', () => {
    const { vault } = makeVault();
    const MARK = Symbol.for('obsidian-mcp-router.server-process');
    const prev = globalThis[MARK];
    globalThis[MARK] = true;
    try {
      assert.throws(() => inspectVaultPlugins(vault), /inside the router server process/);
      assert.throws(() => readLocalRestEndpoint(vault), /inside the router server process/);
    } finally {
      if (prev === undefined) delete globalThis[MARK]; else globalThis[MARK] = prev;
    }
  });

  test('end to end through the binary: --plugin-health passthrough propagates the exit code', () => {
    const healthy = makeVault({ enabled: ['obsidian-local-rest-api', 'mcp-router-bridge'], plugins: HEALTHY });
    const broken = makeVault({ enabled: ['obsidian-local-rest-api', 'mcp-router-bridge'], plugins: { 'obsidian-local-rest-api': HEALTHY['obsidian-local-rest-api'] } });
    const env = (root) => ({
      ...process.env,
      HOME: root, USERPROFILE: root, HOMEDRIVE: path.parse(root).root.replace(/[\\/]$/, ''), HOMEPATH: root.slice(path.parse(root).root.length - 1),
      OBSIDIAN_ROUTER_CONFIG: path.join(root, 'router-config.json'),
    });
    const bin = path.join(REPO, 'bin', 'obsidian-mcp-router.mjs');
    const ok = spawnSync(process.execPath, [bin, '--plugin-health', 'healthvault', '--offline'], { env: env(healthy.root), encoding: 'utf8', cwd: healthy.root });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /Required plugins: OK/);
    const ko = spawnSync(process.execPath, [bin, '--plugin-health', 'healthvault', '--offline'], { env: env(broken.root), encoding: 'utf8', cwd: broken.root });
    assert.equal(ko.status, 1, ko.stdout + ko.stderr);
    assert.match(ko.stdout, /Bridge: absent/);
    const usage = spawnSync(process.execPath, [bin, '--install-plugins'], { env: env(broken.root), encoding: 'utf8', cwd: broken.root });
    assert.equal(usage.status, 2, usage.stdout + usage.stderr);
  });
});
