/**
 * END TO END — attach a BLANK remote vault, and finish with every plugin
 * installed AND loaded, the wiki created and the conventions chosen, following
 * only the next steps the router itself prints.
 *
 * THE CASE. Obsidian in a container whose volume sits on this machine, after a
 * settings-only sync: the vault holds `.obsidian/` and nothing else — the Local
 * REST API with its code and its data.json, and a community-plugins.json that
 * enables the reference skeleton's plugins, none of which has code. Attaching
 * it once ended with no bridge, no wiki, no conventions and no line saying so.
 *
 * WHAT IS REAL AND WHAT IS FAKED:
 *   - real: the `--attach` CLI (a child process, isolated HOME and config),
 *     `runInstallPlugins` with the REAL network allowlist and bridge location
 *     from setup-vault.mjs, `runPluginHealth` with the real `liveRequest`, the
 *     real registry (`loadRegistry` on a temp config) and the real tools
 *     `writeFileTool` / `installConventionsTool` over the real rest-client;
 *   - faked: GitHub (tests/fixtures/plugin-github-fake.mjs — no network), and
 *     Obsidian's Local REST API, by a loopback server BACKED BY THE VAULT
 *     DIRECTORY (what it serves is what the disk holds). Its `GET /commands/`
 *     answers for the plugins that were enabled AND had code at its last
 *     `reload()` — the one step a human does in Obsidian, simulated
 *     explicitly where the router's output tells the user to do it. No bridge
 *     route (`/vault-cas/` answers 404, as with the bridge absent), so a
 *     guarded write takes the GET-compare fallback.
 *   - not driven: the MCP server's dispatch layer (the tools are called as
 *     functions, with the registry the server would build).
 *
 * Each step is a test; a step whose predecessor failed is SKIPPED with that
 * reason rather than failing for a cause it does not own.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { runInstallPlugins } from '../scripts/install-plugins.mjs';
import { BRIDGE_PLUGIN_URLS } from '../scripts/setup-vault.mjs';
import { runPluginHealth } from '../scripts/plugin-health.mjs';
import { assessAttachReadiness, RECOMMENDED_CONVENTIONS } from '../scripts/attach-readiness.mjs';
import { createGuardedFetch, repoFromGithubUrl, REGISTRY_URL } from '../src/helpers/plugin-release-resolver.mjs';
import { loadRegistry } from '../src/registry.mjs';
import { writeFileTool } from '../src/tools/write-file.mjs';
import { installConventionsTool } from '../src/tools/install-conventions.mjs';
import { fakeGitHub, releaseRoutes, manifestOf } from './fixtures/plugin-github-fake.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SETUP_VAULT = path.join(REPO, 'scripts', 'setup-vault.mjs');
const SKELETON_COMMUNITY = path.join(REPO, 'templates', 'reference-vault-skeleton', '.obsidian', 'community-plugins.json');
const LRA = 'obsidian-local-rest-api';
const BRIDGE = 'mcp-router-bridge';
const NAME = 'Box';
const API_KEY = 'e2e'.repeat(12);

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// ---------------------------------------------------------------------------
// The fake Obsidian: a Local REST API over a directory.
// ---------------------------------------------------------------------------

function enabledWithCode(vaultDir) {
  let ids = [];
  try { ids = JSON.parse(fs.readFileSync(path.join(vaultDir, '.obsidian', 'community-plugins.json'), 'utf8')); } catch { ids = []; }
  return ids.filter((id) => typeof id === 'string'
    && fs.existsSync(path.join(vaultDir, '.obsidian', 'plugins', id, 'main.js'))
    && fs.existsSync(path.join(vaultDir, '.obsidian', 'plugins', id, 'manifest.json')));
}

function startFakeObsidian(vaultDir) {
  const requests = [];
  // What the running Obsidian loaded: fixed at start-up, changed by reload() only.
  let loaded = enabledWithCode(vaultDir);
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const notFound = (res) => json(res, 404, { errorCode: 40400, message: 'Not Found' });

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const rawPath = req.url.split('?')[0];
      let url;
      try { url = decodeURIComponent(rawPath); } catch { notFound(res); return; }
      requests.push({ method: req.method, url });
      // The bridge's /open/ route is PUBLIC once the bridge is loaded (a
      // nonexistent note → 404); before that the path is unregistered and the
      // auth layer refuses it like any other — what the real server does, and
      // what --plugin-health's probe reads.
      if (req.method === 'GET' && url.startsWith('/open/') && loaded.includes('mcp-router-bridge')) { notFound(res); return; }
      if (req.headers.authorization !== `Bearer ${API_KEY}`) { json(res, 401, { errorCode: 40101, message: 'Authorization required' }); return; }

      if (req.method === 'GET' && url === '/commands/') {
        const commands = [{ id: 'app:reload', name: 'Reload app without saving' }, ...loaded.map((id) => ({ id: `${id}:e2e-command`, name: `${id}: command` }))];
        json(res, 200, { commands });
        return;
      }
      if (url.startsWith('/open/') || url.startsWith('/vault-cas/')) { notFound(res); return; }
      if (!url.startsWith('/vault/')) { notFound(res); return; }

      const rel = url.slice('/vault/'.length);
      const segs = rel.split('/').filter(Boolean);
      // The Local REST API does not serve dot-directories, nor anything above the vault.
      if (segs.some((s) => s.startsWith('.'))) { notFound(res); return; }
      const abs = path.join(vaultDir, ...segs);

      if (req.method === 'GET' && (rel === '' || rel.endsWith('/'))) {
        let entries;
        try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { notFound(res); return; }
        const files = entries.filter((e) => !e.name.startsWith('.')).map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
        json(res, 200, { files });
        return;
      }
      if (req.method === 'GET') {
        let buf;
        try { buf = fs.readFileSync(abs); } catch { notFound(res); return; }
        res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
        res.end(buf);
        return;
      }
      if (req.method === 'PUT' && segs.length > 0) {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, Buffer.concat(chunks));
        res.writeHead(204);
        res.end();
        return;
      }
      json(res, 405, { errorCode: 40500, message: 'Method not allowed' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      requests,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      /** The human step: Ctrl+P → "Reload app without saving". */
      reload() { loaded = enabledWithCode(vaultDir); },
      loaded: () => [...loaded],
    }));
  });
}

// ---------------------------------------------------------------------------
// A fake GitHub serving every plugin the skeleton enables.
// ---------------------------------------------------------------------------

function githubForSkeleton(ids) {
  const routes = {};
  const registry = [];
  let base = 10_000;
  const bridgeRepo = repoFromGithubUrl(BRIDGE_PLUGIN_URLS['main.js']);
  for (const id of ids) {
    const repo = id === BRIDGE ? bridgeRepo : `e2e-owner/${id}`;
    if (id !== BRIDGE) registry.push({ id, name: id, repo });
    Object.assign(routes, releaseRoutes({
      repo,
      tag: '1.2.3',
      files: { 'main.js': `/* ${id} 1.2.3 */ module.exports = {};`, 'manifest.json': manifestOf(id, '1.2.3') },
      assetIdBase: base,
    }));
    base += 10;
  }
  routes[REGISTRY_URL] = { status: 200, body: registry };
  return fakeGitHub(routes);
}

// ---------------------------------------------------------------------------
// The scenario's world.
// ---------------------------------------------------------------------------

const W = {};
let failedStep = null;

/** A sequential step: skipped, with the reason, when an earlier one failed. */
function step(name, fn) {
  test(name, async (t) => {
    if (failedStep) { t.skip(`not run: step "${failedStep}" failed first`); return; }
    try {
      await fn(t);
    } catch (err) {
      failedStep = name;
      throw err;
    }
  });
}

function runAttach(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SETUP_VAULT, '--attach', NAME, '--workspace', W.ws, ...args], {
      cwd: W.ws,
      env: {
        ...process.env,
        HOME: W.home,
        USERPROFILE: W.home,
        HOMEDRIVE: '',
        HOMEPATH: W.home,
        OBSIDIAN_ROUTER_CONFIG: W.configPath,
        OBSIDIAN_ROUTER_ALLOWED_VAULTS: '',
        OBSIDIAN_ROUTER_DEFAULT_VAULT: '',
        NO_COLOR: '1',
      },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (status) => resolve({ status, out }));
  });
}

/** The numbered lines under "next steps" of the Final state, in order. */
function nextStepsOf(out) {
  const lines = out.replace(/\r\n/g, '\n').split('\n');
  const at = lines.findIndex((l) => /^\s*next steps\s*$/.test(l));
  if (at === -1) return [];
  const steps = [];
  for (const l of lines.slice(at + 1)) {
    const m = l.match(/^\s+(\d+)\. (.*)$/);
    if (!m) break;
    steps.push(m[2]);
  }
  return steps;
}

const pluginFile = (id, name) => path.join(W.vaultDir, '.obsidian', 'plugins', id, name);
const readCfg = () => JSON.parse(fs.readFileSync(W.configPath, 'utf8'));
const io = () => {
  const o = [];
  const e = [];
  return { o, e, deps: { out: (s) => o.push(s), err: (s) => e.push(s), env: {} } };
};

before(async () => {
  W.root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-attach-blank-'));
  W.home = path.join(W.root, 'home');
  fs.mkdirSync(path.join(W.home, '.claude'), { recursive: true });
  W.ws = path.join(W.root, 'myrepo');
  fs.mkdirSync(W.ws);

  // The blank vault: .obsidian/ only — the Local REST API with code and
  // settings, and the skeleton's community-plugins.json.
  W.vaultDir = path.join(W.root, 'box-vault');
  const lraDir = path.join(W.vaultDir, '.obsidian', 'plugins', LRA);
  fs.mkdirSync(lraDir, { recursive: true });
  fs.writeFileSync(path.join(lraDir, 'main.js'), '/* local rest api */ module.exports = {};');
  fs.writeFileSync(path.join(lraDir, 'manifest.json'), JSON.stringify(manifestOf(LRA, '3.1.0')));
  fs.writeFileSync(path.join(lraDir, 'data.json'), JSON.stringify({ apiKey: API_KEY, port: 27124, insecurePort: 27123, enableInsecureServer: true }));
  fs.copyFileSync(SKELETON_COMMUNITY, path.join(W.vaultDir, '.obsidian', 'community-plugins.json'));
  W.skeletonIds = JSON.parse(fs.readFileSync(SKELETON_COMMUNITY, 'utf8'));
  W.lraDataSha = sha(path.join(lraDir, 'data.json'));
  W.communitySha = sha(path.join(W.vaultDir, '.obsidian', 'community-plugins.json'));

  W.fake = await startFakeObsidian(W.vaultDir);
  W.configPath = path.join(W.root, 'config.json');
  fs.writeFileSync(W.configPath, JSON.stringify({
    portRegistry: {},
    remoteVaults: [{ name: NAME, baseUrl: W.fake.baseUrl, apiKey: API_KEY, tlsInsecure: false }],
  }, null, 2));
  W.github = githubForSkeleton(W.skeletonIds.filter((id) => id !== LRA));
});

after(() => {
  W.fake?.server.closeAllConnections?.();
  W.fake?.server.close();
  fs.rmSync(W.root, { recursive: true, force: true });
});

describe('attach a BLANK remote vault, then follow the printed next steps to "ready"', () => {
  step('1. --attach --local-path on the blank vault: attached; the folder cannot be verified yet, and the next steps say so in a workable order', async () => {
    assert.deepEqual(fs.readdirSync(W.vaultDir), ['.obsidian'], 'the vault really is blank');
    const res = await runAttach(['--local-path', W.vaultDir]);
    W.attach1 = res;
    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /Final state/);
    assert.match(res.out, /catalog: no · hot\.md: no/);
    // A blank vault holds no note to compare, so the directory is NOT
    // verified and NOT recorded (remote-local-path.mjs: nothing-to-compare).
    assert.match(res.out, /localPath {3}unverifiable — /);
    assert.doesNotMatch(res.out, /\(recorded\)/);
    assert.equal(readCfg().remoteVaults[0].localPath, undefined, 'no unverified directory is recorded');
    assert.match(res.out, /plugins {5}unknown \(no disk to read\)/);
    // What the user is told to do, in order: the wiki FIRST (it writes the
    // note that makes the folder verifiable), THEN --local-path again.
    const steps = nextStepsOf(res.out);
    W.steps1 = steps;
    assert.equal(steps.length, 2, steps.join('\n'));
    assert.match(steps[0], /Create the wiki: \/obsidian-router:wiki/);
    assert.match(steps[1], /--attach "Box" --local-path <abs-dir>/);
  });

  step('2. wiki: the four scaffolds and the CLAUDE.md block, through write_file { ifNew } on the router registry', async () => {
    W.registry = await loadRegistry({ configPath: W.configPath });
    const stamp = '2026-09-24 12:00';
    const scaffolds = ['catalog', 'hot', 'journal', 'overview'];
    for (const n of scaffolds) {
      const content = fs.readFileSync(path.join(REPO, 'templates', 'wiki-meta', `${n}.md`), 'utf8')
        .replaceAll('{{TIMESTAMP}}', stamp).replaceAll('{{VAULT_PATH}}', W.vaultDir);
      const r = await writeFileTool(W.registry, { vault: NAME, path: `wiki-meta/${n}.md`, content, ifNew: true });
      assert.equal(r.mode, 'create-only');
      assert.equal(fs.readFileSync(path.join(W.vaultDir, 'wiki-meta', `${n}.md`), 'utf8'), content, `${n}.md landed on the vault's disk`);
    }
    const block = fs.readFileSync(path.join(REPO, 'templates', 'wiki', 'CLAUDE.md'), 'utf8').replaceAll('{{VAULT_PATH}}', W.vaultDir);
    await writeFileTool(W.registry, { vault: NAME, path: 'CLAUDE.md', content: block, ifNew: true });
    assert.equal(fs.readFileSync(path.join(W.vaultDir, 'CLAUDE.md'), 'utf8'), block);
    // ifNew never clobbers: a second create is refused, the file unchanged.
    const catalogPath = path.join(W.vaultDir, 'wiki-meta', 'catalog.md');
    const before = sha(catalogPath);
    await assert.rejects(
      writeFileTool(W.registry, { vault: NAME, path: 'wiki-meta/catalog.md', content: 'CLOBBER', ifNew: true }),
      /already exists/,
    );
    assert.equal(sha(catalogPath), before);
  });

  step('3. --attach --local-path again (step 2 of the printed list): verified and recorded; plugins missing listed; install → reload → conventions', async () => {
    const res = await runAttach(['--local-path', W.vaultDir]);
    W.attach2 = res;
    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /localPath {3}verified — .* \(recorded\)/);
    assert.equal(readCfg().remoteVaults[0].localPath, W.vaultDir);
    assert.match(res.out, /catalog: yes · hot\.md: yes/);
    const missing = W.skeletonIds.filter((id) => id !== LRA).sort();
    W.missing = missing;
    assert.match(res.out, new RegExp(`plugins {5}1/${W.skeletonIds.length} with code · bridge: absent`));
    const steps = nextStepsOf(res.out);
    W.steps2 = steps;
    assert.equal(steps.length, 3, steps.join('\n'));
    assert.ok(steps[0].includes(`Install the missing plugin code (${missing.length}: ${missing.join(', ')})`), steps[0]);
    assert.match(steps[0], /obsidian-mcp-router --install-plugins "Box" --dry-run/);
    assert.match(steps[1], /Reload Obsidian/);
    assert.match(steps[1], /obsidian-mcp-router --plugin-health "Box"/);
    assert.match(steps[2], /\/obsidian-router:conventions pick \(pre-checked: /);
  });

  step('4. --install-plugins: dry run lists each missing plugin and a seal; the sealed apply writes main.js + manifest.json, data.json untouched', async () => {
    const fetch = createGuardedFetch({ transport: W.github.transport });
    const dry = io();
    const code = await runInstallPlugins(['--install-plugins', NAME, '--dry-run', '--config', W.configPath], { ...dry.deps, fetch });
    const dryOut = dry.o.join('\n');
    assert.equal(code, 0, `${dryOut}\n${dry.e.join('\n')}`);
    assert.match(dryOut, new RegExp(`Plugins to install: ${W.missing.length}`));
    for (const id of W.missing) assert.match(dryOut, new RegExp(`^ {2}${id} {2}\\(install\\)$`, 'm'), `${id} is in the plan`);
    assert.match(dryOut, /Already installed .*: obsidian-local-rest-api/);
    assert.doesNotMatch(dryOut, /Refused:|Outside the network allowlist/);
    for (const id of W.missing) assert.equal(fs.existsSync(pluginFile(id, 'main.js')), false, 'a dry run writes nothing');
    const seal = (dryOut.match(/approvedPlanSha256: ([0-9a-f]{64})/) || [])[1];
    assert.ok(seal, 'a seal is printed');

    const apply = io();
    const code2 = await runInstallPlugins(['--install-plugins', NAME, '--approved-plan-sha256', seal, '--config', W.configPath], { ...apply.deps, fetch });
    assert.equal(code2, 0, `${apply.o.join('\n')}\n${apply.e.join('\n')}`);
    for (const id of W.missing) {
      assert.ok(fs.existsSync(pluginFile(id, 'main.js')), `${id}/main.js`);
      assert.equal(JSON.parse(fs.readFileSync(pluginFile(id, 'manifest.json'), 'utf8')).id, id, `${id}/manifest.json`);
    }
    assert.equal(sha(pluginFile(LRA, 'data.json')), W.lraDataSha, 'the Local REST API data.json is byte-identical');
    assert.equal(sha(path.join(W.vaultDir, '.obsidian', 'community-plugins.json')), W.communitySha, 'every plugin was already listed: community-plugins.json untouched');
  });

  step('5. --plugin-health: before the reload nothing new is loaded; after it, every expected plugin has code, is enabled and is loaded', async () => {
    const pre = io();
    await runPluginHealth(['--plugin-health', NAME, '--json', '--config', W.configPath], pre.deps);
    const before = JSON.parse(pre.o.join('\n'));
    assert.equal(before.live.reachable, true);
    const notSeen = before.problems.filter((p) => p.kind === 'not-seen-loaded').map((p) => p.id).sort();
    assert.deepEqual(notSeen, W.missing, 'code on disk is not code loaded: the reload is a real step');

    W.fake.reload(); // the human step the output names: Ctrl+P → "Reload app without saving"

    const post = io();
    const code = await runPluginHealth(['--plugin-health', NAME, '--json', '--config', W.configPath], post.deps);
    const after = JSON.parse(post.o.join('\n'));
    assert.equal(code, 0, post.o.join('\n'));
    assert.equal(after.ok, true);
    assert.equal(after.bridge, 'installed');
    assert.deepEqual(after.missing, []);
    assert.deepEqual(after.enabledWithoutCode, []);
    assert.deepEqual(after.problems, []);
    const rows = after.plugins.filter((p) => p.expected);
    assert.equal(rows.length, W.skeletonIds.length, `${rows.length}/${W.skeletonIds.length} expected rows`);
    const bad = rows.filter((p) => !(p.codeInstalled && p.enabledListed && p.live === 'loaded'));
    assert.deepEqual(bad.map((p) => `${p.id}: code=${p.codeInstalled} enabled=${p.enabledListed} live=${p.live}`), []);
    // The evidence came from GET /commands/ on the fake, not from the disk alone.
    assert.ok(W.fake.requests.some((r) => r.method === 'GET' && r.url === '/commands/'));
    // And the bridge's /open/ route was asked at the REMOTE address: before the
    // reload it was not registered, after it the route is live.
    assert.ok(before.problems.some((p) => p.kind === 'bridge-route-not-registered'), 'pre-reload: the bridge route is not live yet');
    assert.ok(W.fake.requests.some((r) => r.method === 'GET' && r.url.startsWith('/open/')), 'the /open/ probe reached the remote vault');
  });

  step('6. conventions: install_conventions dry run, then the pre-checked set in ONE call — one PUT, verified', async () => {
    const dry = await installConventionsTool(W.registry, { vault: NAME, ids: [], dryRun: true });
    assert.equal(dry.path, 'CLAUDE.md');
    assert.equal(dry.fileExisted, true);
    assert.equal(dry.written, false);
    const absent = dry.detection.filter((d) => !d.installed).map((d) => d.id);
    // The picker's pre-check: absent ∩ recommended — and the same list step 3 printed.
    const preChecked = RECOMMENDED_CONVENTIONS.filter((id) => absent.includes(id));
    const printed = (W.steps2[2].match(/pre-checked: ([^;]+);/) || [])[1];
    assert.equal(printed, preChecked.join(', '), 'what --attach printed is what the picker pre-checks');

    const from = W.fake.requests.length;
    // `languages` is pre-checked and carries a value: the picker asks it
    // before this call (the tool refuses the call without it).
    const r = await installConventionsTool(W.registry, { vault: NAME, ids: preChecked, languages: ['fr'] });
    assert.deepEqual(r.vaultLanguages.languages, ['fr'], 'the value landed in the file and reads back');
    const traffic = W.fake.requests.slice(from);
    const puts = traffic.filter((q) => q.method === 'PUT' && q.url.startsWith('/vault/'));
    assert.equal(puts.length, 1, JSON.stringify(traffic));
    assert.equal(puts[0].url, '/vault/CLAUDE.md');
    assert.equal(r.written, true);
    assert.equal(r.verified, true, JSON.stringify(r.problems));
    assert.equal(r.casMode, 'fallback', 'no bridge CAS route on the fake: the GET-compare fallback carried the precondition');
    assert.deepEqual([...r.installed].sort(), [...preChecked].sort());
    assert.deepEqual(r.problems, []);
  });

  step('7. re-assess: --attach again says "ready yes" with no next step; assessAttachReadiness agrees', async () => {
    const res = await runAttach([]);
    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /^ +ready {7}yes — plugins, wiki and conventions verified/m, res.out);
    assert.match(res.out, new RegExp(`plugins {5}${W.skeletonIds.length}/${W.skeletonIds.length} with code · bridge: installed`));
    assert.match(res.out, /conventions 9 installed \(CLAUDE\.md\) · recommended still absent: 0/);
    assert.deepEqual(nextStepsOf(res.out), []);
    const r = assessAttachReadiness({ vault: NAME, kind: 'remote', diskPath: W.vaultDir, wiki: { catalog: true, hot: true } });
    assert.equal(r.ready, true);
    assert.deepEqual(r.nextSteps, []);
    assert.equal(r.conventions.missingRecommended.length, 0);
    assert.deepEqual(r.plugins.missing, []);
  });
});
