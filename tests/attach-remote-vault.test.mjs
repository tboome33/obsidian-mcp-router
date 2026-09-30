/**
 * `--attach` of a REMOTE vault, and the `localPath` it can carry.
 *
 * The case, measured before any of this was written: Obsidian in a container,
 * its Local REST API on a WireGuard address, its files ALSO on the machine the
 * router runs on. `--attach <name>` refused it ("not in portRegistry");
 * `search_smart` declined freshness as `no-local-disk`; the CLAUDE.md block
 * claimed a hot.md was auto-loaded that did not exist.
 *
 * What is covered here, each by driving the code rather than reading it:
 *   - the CLI, spawned against an isolated config and an isolated HOME, talking
 *     to a stub Local REST API on 127.0.0.1 (port 0) — attach of a remote name
 *     binds it; `--local-path` verified is recorded, mismatch is refused with
 *     nothing written; a missing wiki is a warning, not a failure;
 *   - `verifyRemoteLocalPath` with an injected client, every verdict;
 *   - the block's hot.md sentence in its three truths;
 *   - `detectVaultContext` for a remote vault with a localPath;
 *   - `assessEmbeddingFreshness` using a remote `diskPath`, and still declining
 *     without one;
 *   - the registry's `diskPath` passthrough;
 *   - `register_remote_vault`'s `localPath` validation.
 *
 * No real vault, no real config, no network beyond the loopback stub.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildWorkspaceVaultsBlock } from '../scripts/setup-vault.mjs';
import { verifyRemoteLocalPath, LOCAL_PATH_STATUS } from '../src/helpers/remote-local-path.mjs';
import { detectVaultContext } from '../hooks/_helpers/workspace-vault.mjs';
import { withBinding, readBinding } from '../src/helpers/workspace-bindings.mjs';
import { assessEmbeddingFreshness } from '../src/helpers/embedding-staleness.mjs';
import { loadRegistry } from '../src/registry.mjs';
import { registerRemoteVaultTool } from '../src/tools/register-remote-vault.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.resolve(__dirname, '..', 'scripts', 'setup-vault.mjs');

let workDir;
before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-remote-'));
});
after(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A stub Local REST API: GET /vault/<path> serves `files[path]` or a 404,
// GET /vault/ lists the keys. Nothing else is needed by the code under test.
// ---------------------------------------------------------------------------

function startStub(files) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (req.method !== 'GET' || !url.startsWith('/vault/')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ errorCode: 40400, message: 'Not Found' }));
      return;
    }
    const rel = url.slice('/vault/'.length);
    if (rel === '') {
      const top = new Set();
      for (const k of Object.keys(files)) {
        const i = k.indexOf('/');
        top.add(i === -1 ? k : `${k.slice(0, i)}/`);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ files: [...top].sort() }));
      return;
    }
    if (Object.hasOwn(files, rel)) {
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      res.end(files[rel]);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ errorCode: 40400, message: 'File does not exist' }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

/** A scenario: temp root, one remote vault in the config, an empty workspace, an isolated HOME. */
function makeScenario({ baseUrl, name = 'Box', extra = {} }) {
  const root = fs.mkdtempSync(path.join(workDir, 'sc-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const ws = path.join(root, 'myrepo');
  fs.mkdirSync(ws, { recursive: true });
  const configPath = path.join(root, 'config.json');
  const cfg = {
    portRegistry: {},
    remoteVaults: [{ name, baseUrl, apiKey: 'k'.repeat(32), tlsInsecure: false, ...extra }],
  };
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  return { root, home, ws, configPath };
}

/** Spawn the CLI WITHOUT blocking this process: the stub server lives here. */
function runCli(sc, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT_PATH, ...args], {
      cwd: sc.ws,
      env: {
        ...process.env,
        HOME: sc.home,
        USERPROFILE: sc.home,
        HOMEDRIVE: '',
        HOMEPATH: sc.home,
        OBSIDIAN_ROUTER_CONFIG: sc.configPath,
        OBSIDIAN_ROUTER_ALLOWED_VAULTS: '',
        NO_COLOR: '1',
      },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (status) => resolve({ status, out }));
  });
}

const readCfg = (sc) => JSON.parse(fs.readFileSync(sc.configPath, 'utf8'));
const readIf = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);

/** A directory holding the same files the stub serves. */
function mirrorDir(files) {
  const dir = fs.mkdtempSync(path.join(workDir, 'mirror-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return dir;
}

// ---------------------------------------------------------------------------
// The CLI
// ---------------------------------------------------------------------------

describe('--attach <remote name> (CLI, stub REST API)', () => {
  const WIKI = {
    'wiki-meta/catalog.md': '# Catalog\n',
    'wiki-meta/hot.md': '# Hot\nstate\n',
    'README.md': 'hello\n',
  };
  let stub;
  before(async () => { stub = await startStub(WIKI); });
  after(() => { stub.server.close(); });

  test('a remote name is attached and BOUND — it used to be refused as "not in portRegistry"', async () => {
    const sc = makeScenario({ baseUrl: stub.baseUrl });
    const res = await runCli(sc, ['--attach', 'Box']);
    assert.equal(res.status, 0, res.out);
    assert.doesNotMatch(res.out, /not in portRegistry/);
    const binding = readBinding(readCfg(sc), sc.ws);
    assert.equal(binding?.vault, 'Box', 'the binding names the remote vault');
    assert.match(readIf(path.join(sc.ws, '.env')), /OBSIDIAN_ROUTER_DEFAULT_VAULT=Box/);
    // No local directory: the block must NOT claim an auto-load.
    const md = readIf(path.join(sc.ws, 'CLAUDE.md'));
    assert.match(md, /remote, served at http:\/\/127\.0\.0\.1:/);
    assert.match(md, /NOT auto-loaded at session start: this is a remote vault with no local directory/);
    assert.doesNotMatch(md, /  Auto-loaded at session start/);
    // And the final state says what is true.
    assert.match(res.out, /Final state/);
    assert.match(res.out, /vault\s+Box \(remote\)/);
    assert.match(res.out, /localPath\s+none/);
    assert.match(res.out, /catalog: yes · hot\.md: yes/);
  });

  test('a case-folded remote name resolves to the stored spelling', async () => {
    const sc = makeScenario({ baseUrl: stub.baseUrl });
    const res = await runCli(sc, ['--attach', 'box']);
    assert.equal(res.status, 0, res.out);
    assert.equal(readBinding(readCfg(sc), sc.ws)?.vault, 'Box');
  });

  test('--local-path VERIFIED against the vault is recorded, and the block then says auto-loaded', async () => {
    const sc = makeScenario({ baseUrl: stub.baseUrl });
    const dir = mirrorDir(WIKI);
    const res = await runCli(sc, ['--attach', 'Box', '--local-path', dir]);
    assert.equal(res.status, 0, res.out);
    const cfg = readCfg(sc);
    assert.equal(cfg.remoteVaults[0].localPath, dir, 'recorded in the remoteVaults entry');
    assert.equal(cfg.remoteVaults[0].apiKey, 'k'.repeat(32), 'the rest of the entry is untouched');
    assert.equal(readBinding(cfg, sc.ws)?.vault, 'Box');
    const md = readIf(path.join(sc.ws, 'CLAUDE.md'));
    assert.match(md, /  Auto-loaded at session start \(its `wiki-meta\/hot\.md`\)/);
    assert.match(res.out, /localPath\s+verified/);
  });

  test('--local-path that is NOT the vault is REFUSED, and nothing is written', async () => {
    const sc = makeScenario({ baseUrl: stub.baseUrl });
    const dir = mirrorDir({ ...WIKI, 'wiki-meta/catalog.md': '# Another vault\n' });
    const before = fs.readFileSync(sc.configPath, 'utf8');
    const res = await runCli(sc, ['--attach', 'Box', '--local-path', dir]);
    assert.equal(res.status, 1, `a clean refusal, not a crash:\n${res.out}`);
    assert.match(res.out, /is NOT the files of remote vault "Box"/);
    assert.equal(fs.readFileSync(sc.configPath, 'utf8'), before, 'config byte-identical: no localPath, no binding');
    assert.equal(fs.existsSync(path.join(sc.ws, '.env')), false, 'no .env hint either');
    assert.equal(fs.existsSync(path.join(sc.ws, 'CLAUDE.md')), false);
  });

  test('--local-path on a LOCAL primary is refused', async () => {
    const sc = makeScenario({ baseUrl: stub.baseUrl });
    const vp = mirrorDir({ 'wiki-meta/catalog.md': '# c\n' });
    const cfg = readCfg(sc);
    cfg.portRegistry = { [vp]: 27100 };
    fs.writeFileSync(sc.configPath, JSON.stringify(cfg));
    const res = await runCli(sc, ['--attach', path.basename(vp), '--local-path', vp]);
    assert.notEqual(res.status, 0, res.out);
    assert.match(res.out, /--local-path applies to a REMOTE primary only/);
  });
});

describe('--attach <remote name> whose vault has NO wiki yet', () => {
  let stub;
  before(async () => { stub = await startStub({}); });
  after(() => { stub.server.close(); });

  test('warns and attaches — a missing wiki is not a failure for a remote vault', async () => {
    const sc = makeScenario({ baseUrl: stub.baseUrl });
    const res = await runCli(sc, ['--attach', 'Box']);
    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /has no wiki yet \(no wiki-meta\/catalog\.md\)/);
    assert.equal(readBinding(readCfg(sc), sc.ws)?.vault, 'Box');
    assert.match(res.out, /catalog: no · hot\.md: no/);
    const md = readIf(path.join(sc.ws, 'CLAUDE.md'));
    assert.match(md, /does not exist yet — create the wiki/);
    assert.match(md, /and even then it will not be auto-loaded/);
  });
});

// ---------------------------------------------------------------------------
// verifyRemoteLocalPath — every verdict, client injected
// ---------------------------------------------------------------------------

function fakeClient(files, { listFails = false, readFails = false } = {}) {
  return {
    async readText(_vault, rel) {
      if (readFails) throw new Error('ECONNREFUSED');
      return Object.hasOwn(files, rel) ? files[rel] : null;
    },
    async list() {
      if (listFails) throw new Error('ECONNREFUSED');
      return Object.keys(files).filter((k) => !k.includes('/'));
    },
  };
}

describe('verifyRemoteLocalPath', () => {
  const vault = { name: 'Box', type: 'remote' };

  test('same catalog bytes → verified', async () => {
    const files = { 'wiki-meta/catalog.md': '# C\n' };
    const r = await verifyRemoteLocalPath({ vault, localPath: mirrorDir(files), client: fakeClient(files) });
    assert.equal(r.status, LOCAL_PATH_STATUS.VERIFIED);
    assert.equal(r.evidence.file, 'wiki-meta/catalog.md');
    assert.equal(r.evidence.restSha256, r.evidence.diskSha256);
  });

  test('no catalog anywhere: a root note is compared instead', async () => {
    const files = { 'b.md': 'bee\n', 'a.md': 'ay\n' };
    const r = await verifyRemoteLocalPath({ vault, localPath: mirrorDir(files), client: fakeClient(files) });
    assert.equal(r.status, LOCAL_PATH_STATUS.VERIFIED);
    assert.equal(r.evidence.file, 'a.md', 'sorted: the first root note');
  });

  test('different content → mismatch', async () => {
    const files = { 'wiki-meta/catalog.md': '# C\n' };
    const r = await verifyRemoteLocalPath({
      vault,
      localPath: mirrorDir({ 'wiki-meta/catalog.md': '# D\n' }),
      client: fakeClient(files),
    });
    assert.equal(r.status, LOCAL_PATH_STATUS.MISMATCH);
    assert.equal(r.evidence.reason, 'different-content');
  });

  test('a file one side has and the other lacks → mismatch', async () => {
    const files = { 'wiki-meta/catalog.md': '# C\n' };
    const r = await verifyRemoteLocalPath({ vault, localPath: mirrorDir({ 'x.txt': 'x' }), client: fakeClient(files) });
    assert.equal(r.status, LOCAL_PATH_STATUS.MISMATCH);
    assert.equal(r.evidence.reason, 'present-on-one-side-only');
  });

  test('a directory that does not exist → mismatch', async () => {
    const r = await verifyRemoteLocalPath({ vault, localPath: path.join(workDir, 'nope-404'), client: fakeClient({}) });
    assert.equal(r.status, LOCAL_PATH_STATUS.MISMATCH);
    assert.equal(r.evidence.reason, 'not-a-directory');
  });

  test('nothing to compare → unverifiable, never verified', async () => {
    const r = await verifyRemoteLocalPath({ vault, localPath: mirrorDir({}), client: fakeClient({}) });
    assert.equal(r.status, LOCAL_PATH_STATUS.UNVERIFIABLE);
    assert.equal(r.evidence.reason, 'nothing-to-compare');
  });

  test('the vault does not answer → unverifiable, not mismatch', async () => {
    const r = await verifyRemoteLocalPath({ vault, localPath: mirrorDir({ 'a.md': 'a' }), client: fakeClient({}, { readFails: true }) });
    assert.equal(r.status, LOCAL_PATH_STATUS.UNVERIFIABLE);
    assert.equal(r.evidence.reason, 'rest-error');
  });
});

// ---------------------------------------------------------------------------
// The block's hot.md sentence
// ---------------------------------------------------------------------------

describe('buildWorkspaceVaultsBlock — the hot.md sentence tells the truth', () => {
  const local = { slug: 'notes', kind: 'local', path: '/v/notes' };
  const remote = { slug: 'Box', kind: 'remote', path: null, baseUrl: 'http://192.0.2.10:27180' };

  test('loadable and present → auto-loaded', () => {
    const b = buildWorkspaceVaultsBlock({ primary: { ...local, hot: { exists: true, loadable: true } } });
    assert.match(b, /  Auto-loaded at session start \(its `wiki-meta\/hot\.md`\)/);
  });

  test('absent → "does not exist yet", never "auto-loaded"', () => {
    const b = buildWorkspaceVaultsBlock({ primary: { ...local, hot: { exists: false, loadable: true } } });
    assert.match(b, /NOT auto-loaded at session start: its `wiki-meta\/hot\.md` does not exist yet/);
    assert.doesNotMatch(b, /  Auto-loaded at/);
    assert.doesNotMatch(b, /even then/, 'a local vault WILL load it once it exists');
  });

  test('remote without a local directory → not auto-loaded, read it with get_file', () => {
    const b = buildWorkspaceVaultsBlock({ primary: { ...remote, hot: { exists: true, loadable: false } } });
    assert.match(b, /NOT auto-loaded at session start: this is a remote vault with no local directory/);
    assert.match(b, /with `get_file`/);
    assert.match(b, /remote, served at http:\/\/192\.0\.2\.10:27180/);
    assert.doesNotMatch(b, /  Auto-loaded at/);
  });

  test('remote WITH a verified local directory → auto-loaded, and the directory is named', () => {
    const b = buildWorkspaceVaultsBlock({ primary: { ...remote, path: '/srv/box', hot: { exists: true, loadable: true } } });
    assert.match(b, /files also at \/srv\/box/);
    assert.match(b, /  Auto-loaded at session start/);
  });
});

// ---------------------------------------------------------------------------
// The hooks' vault context
// ---------------------------------------------------------------------------

describe('detectVaultContext — a remote vault with a localPath', () => {
  test('resolves to that directory, marked remote', () => {
    const dir = mirrorDir({ 'wiki-meta/catalog.md': '# c\n', 'wiki-meta/hot.md': '# h\n' });
    const ws = fs.mkdtempSync(path.join(workDir, 'ws-'));
    const base = { portRegistry: {}, remoteVaults: [{ name: 'Box', baseUrl: 'http://127.0.0.1:1', apiKey: 'k', localPath: dir }] };
    const cfg = withBinding(base, ws, { vault: 'Box' });
    const saved = process.env.OBSIDIAN_ROUTER_ALLOWED_VAULTS;
    delete process.env.OBSIDIAN_ROUTER_ALLOWED_VAULTS;
    try {
      const ctx = detectVaultContext(ws, cfg);
      assert.equal(ctx?.mode, 'workspace-bound');
      assert.equal(ctx.vaultPath, dir);
      assert.equal(ctx.remote, true);
      assert.equal(ctx.slug, 'Box');

      // Without the field: no disk, no context — as before.
      const noDisk = withBinding({ ...base, remoteVaults: [{ ...base.remoteVaults[0], localPath: undefined }] }, ws, { vault: 'Box' });
      assert.equal(detectVaultContext(ws, noDisk), null);
      // A RELATIVE localPath is not a directory the hooks may use — even one
      // that WOULD resolve to the vault from the current directory: a hook's
      // cwd is whichever workspace it started in.
      const rel = withBinding({ ...base, remoteVaults: [{ ...base.remoteVaults[0], localPath: path.basename(dir) }] }, ws, { vault: 'Box' });
      const cwd = process.cwd();
      process.chdir(path.dirname(dir));
      try {
        assert.equal(detectVaultContext(ws, rel), null);
      } finally {
        process.chdir(cwd);
      }
    } finally {
      if (saved !== undefined) process.env.OBSIDIAN_ROUTER_ALLOWED_VAULTS = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// Index freshness, the registry, register_remote_vault
// ---------------------------------------------------------------------------

describe('assessEmbeddingFreshness — a remote vault with a diskPath', () => {
  test('no longer declines no-local-disk when diskPath is set', () => {
    const dir = mirrorDir({ 'a.md': 'a' });
    const r = assessEmbeddingFreshness({ type: 'remote', name: 'Box', diskPath: dir }, ['a.md']);
    assert.notEqual(r.reason, 'no-local-disk');
    assert.equal(r.reason, 'store-missing', 'it looked at the disk: there is simply no Smart Connections store');
  });

  test('still declines no-local-disk without one', () => {
    const r = assessEmbeddingFreshness({ type: 'remote', name: 'Box' }, ['a.md']);
    assert.equal(r.checkable, false);
    assert.equal(r.reason, 'no-local-disk');
  });
});

describe('registry — remoteVaults[].localPath becomes diskPath, never path', () => {
  test('absolute: passed through as diskPath; relative: dropped', async () => {
    const dir = mirrorDir({});
    const p = path.join(fs.mkdtempSync(path.join(workDir, 'cfg-')), 'config.json');
    fs.writeFileSync(p, JSON.stringify({
      portRegistry: {},
      remoteVaults: [
        { name: 'Box', baseUrl: 'http://127.0.0.1:1', apiKey: 'k', localPath: dir },
        { name: 'Rel', baseUrl: 'http://127.0.0.1:2', apiKey: 'k', localPath: 'relative/dir' },
        { name: 'None', baseUrl: 'http://127.0.0.1:3', apiKey: 'k' },
      ],
    }));
    const reg = await loadRegistry({ configPath: p });
    const box = reg.vaults.find((v) => v.name === 'Box');
    assert.equal(box.type, 'remote');
    assert.equal(box.diskPath, dir);
    assert.equal(box.path, undefined, 'NOT path: every `type === local && path` test keeps its meaning');
    assert.equal('diskPath' in reg.vaults.find((v) => v.name === 'Rel'), false);
    assert.equal('diskPath' in reg.vaults.find((v) => v.name === 'None'), false);
  });
});

describe('register_remote_vault — localPath', () => {
  const registry = { configPath: path.join('/cfg', 'config.json') };
  const seams = () => {
    const written = [];
    return {
      written,
      seam: {
        readFile: () => JSON.stringify({ portRegistry: {}, remoteVaults: [] }),
        writeFile: (p, c) => written.push(JSON.parse(c)),
      },
    };
  };

  test('an absolute localPath is stored AS DECLARED, and the result says so', async () => {
    const { written, seam } = seams();
    const out = await registerRemoteVaultTool(registry, {
      name: 'Box', baseUrl: 'http://192.0.2.10:27180', apiKey: 'k', localPath: '/srv/obsidian/box',
    }, seam);
    assert.equal(written[0].remoteVaults[0].localPath, '/srv/obsidian/box');
    assert.deepEqual(out.localPath, { path: '/srv/obsidian/box', status: 'declared' });
    assert.match(out.localPathNote, /--attach "Box" --local-path/);
  });

  test('a relative localPath is refused, nothing written', async () => {
    const { written, seam } = seams();
    await assert.rejects(
      registerRemoteVaultTool(registry, { name: 'Box', baseUrl: 'http://192.0.2.10:27180', apiKey: 'k', localPath: 'box' }, seam),
      /is not an ABSOLUTE directory path/,
    );
    assert.equal(written.length, 0);
  });

  test('without localPath the entry is exactly what it was', async () => {
    const { written, seam } = seams();
    const out = await registerRemoteVaultTool(registry, { name: 'Box', baseUrl: 'http://192.0.2.10:27180', apiKey: 'k' }, seam);
    assert.equal('localPath' in written[0].remoteVaults[0], false);
    assert.equal('localPath' in out, false);
  });
});
