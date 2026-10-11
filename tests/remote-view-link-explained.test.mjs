/**
 * A remote vault never gets a silent null link (bug of 2026-10-09).
 *
 * What happened: a session wrote into the remote vault `obsidian-mcp-router`
 * (Dedibox, reached over WireGuard), asked build_open_link for a link and got
 * `clickToOpenUrl: null`, `pathVerified: true` and nothing else. get_view_link
 * was not in its tool list, because the router instance Claude Code had
 * started carried no OBSIDIAN_ROUTER_VIEW_AGENT_URL. The session concluded
 * "the router cannot make a link for this vault" — while the view agent was up
 * and answering on the same network.
 *
 * What is pinned here, one block per rule:
 *   - build_open_link on a remote vault says WHY the local link is null and
 *     HOW to get one: with no agent, where to set it (never a workspace .env);
 *     with an agent, it fetches the view link itself (single mode) — wiki-meta/
 *     included — and does not fetch in batch;
 *   - get_view_link serves a wiki-meta/ page on an explicit request;
 *   - OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN_FILE is read at EACH use, wins over the
 *     inline token, blocks the request when unreadable, and is refused from a
 *     workspace .env;
 *   - list_vaults says in advance whether a read link exists (viewAgent,
 *     readLink), probing the agent's /health without the token;
 *   - the read/write results of a remote vault carry `linkHint` — driven
 *     through the REAL server over stdio, because that annotation lives in the
 *     CallTool dispatcher and nothing short of a tools/call reaches it.
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  remoteLinkHint,
  resolveViewAgentToken,
  viewAgentStatus,
  probeViewAgentHealth,
  VIEW_AGENT_SETUP,
} from '../src/helpers/view-link.mjs';
import { buildOpenLinkTool } from '../src/tools/build-open-link.mjs';
import { getViewLinkTool } from '../src/tools/get-view-link.mjs';
import { listVaults } from '../src/tools/list-vaults.mjs';
import { applyWorkspaceDotenv, classifyWorkspaceDotenvKey } from '../src/helpers/workspace-dotenv.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'obsidian-mcp-router.mjs');

const AGENT_LINK = 'https://obsidian:pw@view-probe.trycloudflare.com/';
const ENV_KEYS = [
  'OBSIDIAN_ROUTER_VIEW_AGENT_URL',
  'OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN',
  'OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN_FILE',
  'OBSIDIAN_ROUTER_SMART_LINK_URL',
  'OBSIDIAN_ROUTER_SMART_LINK_SECRET',
  'HOME',
  'USERPROFILE',
];

// ---------------------------------------------------------------------------
// A fake view agent: /view answers a link, /health lists `healthVaults`.
// ---------------------------------------------------------------------------
let agent;
let agentUrl;
const seen = [];
let healthVaults = ['r'];

let saved;
let tmp;

before(async () => {
  agent = http.createServer((req, res) => {
    seen.push({ url: req.url, token: req.headers['x-view-token'] });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url.startsWith('/health')) {
      res.end(JSON.stringify({ ok: true, vaults: healthVaults }));
      return;
    }
    res.end(JSON.stringify({ url: AGENT_LINK, idle_timeout_s: 900 }));
  });
  await new Promise((r) => agent.listen(0, '127.0.0.1', r));
  agentUrl = `http://127.0.0.1:${agent.address().port}`;
});

after(() => agent.close());

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS.slice(0, 5)) delete process.env[k];
  seen.length = 0;
  healthVaults = ['r'];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-view-link-'));
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const viewCalls = () => seen.filter((s) => s.url.startsWith('/view'));
const query = (s) => new URL(s.url, 'http://x').searchParams;

function tokenFile(content) {
  const p = path.join(tmp, 'view-agent.token');
  fs.writeFileSync(p, content);
  return p;
}

/** A remote vault answering over a fake REST listing — the shape build_open_link verifies against. */
const REMOTE = { name: 'r', type: 'remote', baseUrl: 'https://127.0.0.1:27126' };
const TREE = { '': ['wiki/', 'wiki-meta/'], wiki: ['alpha.md'], 'wiki-meta': ['hot.md'] };
const registry = { resolveVault: () => REMOTE };
const deps = {
  listFilesIn: async (_v, dir) => {
    if (!(dir in TREE)) {
      const err = new Error(`no such directory: ${dir}`);
      err.kind = 'not_found';
      throw err;
    }
    return { files: TREE[dir] };
  },
};

// ---------------------------------------------------------------------------
describe('build_open_link on a remote vault — never a null without its reason', () => {
  test('no view agent: the link is null AND the result says why, and where to set the agent', async () => {
    const res = await buildOpenLinkTool(registry, { path: 'wiki/alpha.md' }, deps);
    assert.equal(res.clickToOpenUrl, null);
    assert.equal(res.pathVerified, true);
    assert.equal(res.viewLink, undefined);
    assert.ok(typeof res.linkHint === 'string', `no linkHint: ${JSON.stringify(res)}`);
    assert.match(res.linkHint, /Vault "r" is remote/);
    assert.match(res.linkHint, /OBSIDIAN_ROUTER_VIEW_AGENT_URL is unset/);
    assert.match(res.linkHint, /get_view_link is hidden/);
    assert.match(res.linkHint, /never in a workspace \.env/);
    assert.match(res.linkHint, /OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN_FILE/);
  });

  test('view agent configured: single mode fetches the view link itself, with the token from the file', async () => {
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL = agentUrl;
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN_FILE = tokenFile('file-secret\n');
    const res = await buildOpenLinkTool(registry, { path: 'wiki/alpha.md' }, deps);
    assert.equal(res.clickToOpenUrl, null);
    assert.equal(res.viewLink, AGENT_LINK);
    assert.equal(res.viewLinkKind, 'agent');
    assert.equal(res.expiresInSeconds, 900);
    assert.match(res.linkHint, /`viewLink` opens the note in a browser/);
    const calls = viewCalls();
    assert.equal(calls.length, 1);
    assert.equal(query(calls[0]).get('vault'), 'r');
    assert.equal(query(calls[0]).get('note'), 'wiki/alpha.md');
    assert.equal(calls[0].token, 'file-secret', 'the token must come from the file, trimmed');
  });

  test('an explicit request for a wiki-meta/ page gets its link — the housekeeping skip is for the automatic one only', async () => {
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL = agentUrl;
    const res = await buildOpenLinkTool(registry, { path: 'wiki-meta/hot.md' }, deps);
    assert.equal(res.viewLink, AGENT_LINK);
    assert.equal(query(viewCalls()[0]).get('note'), 'wiki-meta/hot.md');
  });

  test('a requested anchor is echoed as not applied: a view link cannot deep-link a heading', async () => {
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL = agentUrl;
    const res = await buildOpenLinkTool(registry, { path: 'wiki/alpha.md', anchor: 'Intro' }, deps);
    assert.equal(res.viewLink, AGENT_LINK);
    assert.equal(res.anchorApplied, false);
  });

  test('batch mode fetches no view link and says once, on the batch, to call get_view_link per note', async () => {
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL = agentUrl;
    const res = await buildOpenLinkTool(registry, { paths: ['wiki/alpha.md', 'wiki-meta/hot.md'] }, deps);
    assert.equal(viewCalls().length, 0, 'a batch must not navigate the single GUI N times');
    for (const l of res.links) {
      assert.equal(l.clickToOpenUrl, null);
      assert.equal(l.linkHint, undefined, 'the explanation is said once, on the batch');
    }
    assert.match(res.linkHint, /get_view_link\(\{ vault, note \}\) once per note/);
  });

  test('the agent failing is reported, with the way out', async () => {
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL = 'http://127.0.0.1:1';
    const res = await buildOpenLinkTool(registry, { path: 'wiki/alpha.md' }, deps);
    assert.equal(res.viewLink, undefined);
    assert.match(res.viewLinkError, /view-agent unreachable/);
    assert.match(res.linkHint, /call get_view_link\(\{"vault":"r","note":"wiki\/alpha.md"\}\)/);
  });
});

// ---------------------------------------------------------------------------
describe('get_view_link — any note on explicit request', () => {
  test('a wiki-meta/ page is served', async () => {
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL = agentUrl;
    const res = await getViewLinkTool(registry, { vault: 'r', note: 'wiki-meta/hot.md' });
    assert.equal(res.url, AGENT_LINK);
    assert.equal(query(viewCalls()[0]).get('note'), 'wiki-meta/hot.md');
  });
});

// ---------------------------------------------------------------------------
describe('OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN_FILE', () => {
  test('re-read at each use: a rotated file is sent on the next call, no restart', async () => {
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL = agentUrl;
    const p = tokenFile('first');
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN_FILE = p;
    await getViewLinkTool(registry, { note: 'wiki/alpha.md' });
    fs.writeFileSync(p, 'second\n');
    await getViewLinkTool(registry, { note: 'wiki/alpha.md' });
    assert.deepEqual(viewCalls().map((c) => c.token), ['first', 'second']);
  });

  test('the file wins over the inline token, and says so', () => {
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN = 'inline';
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN_FILE = tokenFile('from-file');
    const t = resolveViewAgentToken(process.env);
    assert.equal(t.token, 'from-file');
    assert.equal(t.source, 'file');
    assert.equal(t.inlineIgnored, true);
  });

  test('`~/` is expanded against the home directory', () => {
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    tokenFile('tilde');
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN_FILE = '~/view-agent.token';
    assert.equal(resolveViewAgentToken(process.env).token, 'tilde');
  });

  test('unreadable, empty or relative: no request leaves, and the error names the variable', async () => {
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL = agentUrl;
    for (const [value, re] of [
      [path.join(tmp, 'absent.token'), /could not be read \(ENOENT\)/],
      [tokenFile('  \n'), /is empty/],
      ['relative/view-agent.token', /must be an absolute path/],
    ]) {
      process.env.OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN_FILE = value;
      await assert.rejects(() => getViewLinkTool(registry, { note: 'wiki/alpha.md' }), (err) => {
        assert.match(err.message, /OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN_FILE/);
        assert.match(err.message, re);
        return true;
      });
    }
    assert.equal(viewCalls().length, 0, 'no request without the configured token');
  });

  test('refused from a workspace .env, like the URL and the inline token', () => {
    for (const k of ['OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN_FILE', 'OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN', 'OBSIDIAN_ROUTER_VIEW_AGENT_URL']) {
      assert.equal(classifyWorkspaceDotenvKey(k), 'ignore', k);
    }
    fs.writeFileSync(path.join(tmp, '.env'), [
      'OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN_FILE=./planted.token',
      'OBSIDIAN_ROUTER_VIEW_AGENT_URL=https://evil.example/agent',
      '',
    ].join('\n'));
    const env = {};
    const warnings = [];
    const r = applyWorkspaceDotenv({ cwd: tmp, env, warn: (m) => warnings.push(m) });
    assert.deepEqual(env, {}, 'nothing from that file may reach the environment');
    assert.deepEqual(r.ignored, ['OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN_FILE', 'OBSIDIAN_ROUTER_VIEW_AGENT_URL']);
    assert.match(warnings.join('\n'), /OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN_FILE/);
  });
});

// ---------------------------------------------------------------------------
describe('list_vaults says in advance whether a read link exists', () => {
  const pingable = { ...REMOTE, baseUrl: 'http://127.0.0.1:1', apiKey: 'k', timeoutMs: 500 };
  const reg = () => ({ vaults: [pingable], skipped: [], configPath: path.join(tmp, 'config.json') });

  test('remote vault, no agent: viewAgent.hint says where to set it; readLink.available is false', async () => {
    const out = await listVaults(reg());
    assert.equal(out.viewAgent.configured, false);
    assert.equal(out.viewAgent.health, 'not-configured');
    assert.match(out.viewAgent.hint, /1 remote vault\(s\) here, and no view agent/);
    assert.ok(out.viewAgent.hint.endsWith(VIEW_AGENT_SETUP));
    const rl = out.vaults[0].readLink;
    assert.equal(rl.available, false);
    assert.equal(rl.viewLink, null);
    assert.match(rl.hint, /no view agent/);
  });

  test('agent configured and healthy: available, listed, token by source only', async () => {
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL = `${agentUrl}/`;
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN_FILE = tokenFile('never-shown');
    const out = await listVaults(reg());
    assert.equal(out.viewAgent.configured, true);
    assert.equal(out.viewAgent.url, agentUrl);
    assert.equal(out.viewAgent.token, 'file');
    assert.equal(out.viewAgent.health, 'ok');
    assert.equal(out.viewAgent.vaultsListed, 1);
    assert.equal(out.viewAgent.hint, null);
    assert.deepEqual(out.vaults[0].readLink, {
      available: true, clickToOpen: false, viewLink: 'view-agent', agentListsVault: true, hint: null,
    });
    assert.ok(!JSON.stringify(out).includes('never-shown'), 'the token value must never appear');
    const health = seen.find((s) => s.url.startsWith('/health'));
    assert.ok(health, 'the /health route was not probed');
    assert.equal(health.token, undefined, '/health is probed without the token');
  });

  test('an agent that does not list the vault is not a refusal — only a hint', async () => {
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL = agentUrl;
    healthVaults = ['other'];
    const out = await listVaults(reg());
    const rl = out.vaults[0].readLink;
    assert.equal(rl.available, true);
    assert.equal(rl.agentListsVault, false);
    assert.match(rl.hint, /accepts vault hints/);
  });

  test('agent configured but not answering: unavailable, and said why', async () => {
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL = 'http://127.0.0.1:1';
    const out = await listVaults(reg());
    assert.equal(out.viewAgent.health, 'unreachable');
    assert.match(out.viewAgent.hint, /did not answer \/health/);
    assert.equal(out.vaults[0].readLink.available, false);
  });

  test('the helpers alone: status without network, health with it', async () => {
    assert.deepEqual(await probeViewAgentHealth({ env: {} }), { status: 'not-configured', vaults: null });
    const st = viewAgentStatus({ OBSIDIAN_ROUTER_VIEW_AGENT_URL: 'http://u:p@192.0.2.10:27200/x?y' });
    assert.equal(st.url, 'http://192.0.2.10:27200', 'origin only — no userinfo, path or query');
    assert.equal(st.token, 'none');
    assert.equal(remoteLinkHint({ vault: { name: 'l', type: 'local' } }), null, 'nothing to explain for a local vault here');
  });
});

// ---------------------------------------------------------------------------
// The read/write results, through the real server.
// ---------------------------------------------------------------------------

async function withRouter({ agentEnv }, fn) {
  const fakeVault = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.method === 'GET' && req.url.startsWith('/vault/')) {
        res.writeHead(200, { 'Content-Type': 'text/markdown' });
        res.end('# hi\n');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((r) => fakeVault.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-view-link-e2e-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    portRegistry: {},
    vaultNames: {},
    remoteVaults: [{ name: 'probe', baseUrl: `http://127.0.0.1:${fakeVault.address().port}`, apiKey: 'k', timeoutMs: 5000 }],
    defaultVault: 'probe',
  }), 'utf8');
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^VAULT_|^OBSIDIAN_ROUTER_/.test(k)) delete env[k];
  const child = spawn(process.execPath, [BIN, '--config', configPath], {
    cwd: dir,
    env: { ...env, HOME: home, USERPROFILE: home, HOMEDRIVE: '', HOMEPATH: '', OBSIDIAN_ROUTER_NO_WATCH: '1', ...agentEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let exitInfo = null;
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => { exitInfo = { code, signal }; resolve(); });
    child.once('error', (err) => { exitInfo = { error: err.message }; resolve(); });
  });
  child.stdin.on('error', () => {});
  let stdout = '';
  let stderr = '';
  const waiters = new Map();
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    let nl;
    while ((nl = stdout.indexOf('\n')) !== -1) {
      const raw = stdout.slice(0, nl).trim();
      stdout = stdout.slice(nl + 1);
      if (!raw) continue;
      let msg;
      try { msg = JSON.parse(raw); } catch { continue; }
      const w = waiters.get(msg.id);
      if (w) { waiters.delete(msg.id); w(msg); }
    }
  });
  let nextId = 1;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    if (exitInfo) { reject(new Error(`router exited ${JSON.stringify(exitInfo)}\n${stderr}`)); return; }
    const id = nextId++;
    const t = setTimeout(() => reject(new Error(`timed out on ${method}\n${stderr}`)), 20000);
    exited.then(() => { clearTimeout(t); reject(new Error(`router exited during ${method}\n${stderr}`)); });
    waiters.set(id, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const callTool = async (name, args) => {
    const res = await rpc('tools/call', { name, arguments: args });
    assert.ok(!res.error, `${name} failed: ${JSON.stringify(res.error)}\n${stderr}`);
    assert.notEqual(res.result.isError, true, `${name} reported an error: ${JSON.stringify(res.result)}`);
    const text = res.result.content.map((c) => c.text || '').join('');
    return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  };
  try {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'remote-view-link-e2e', version: '0' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    await fn({ callTool, rpc });
  } finally {
    if (!exitInfo) child.kill();
    await exited;
    await new Promise((r) => fakeVault.close(r));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

describe('E2E: read and write results of a remote vault carry linkHint', () => {
  test('no agent: get_file and write_file say why there is no link, briefly, and where to look', async () => {
    await withRouter({ agentEnv: {} }, async ({ callTool, rpc }) => {
      const tools = (await rpc('tools/list', {})).result.tools.map((t) => t.name);
      assert.ok(!tools.includes('get_view_link'), 'the precondition of the bug: get_view_link hidden');
      for (const [tool, args] of [
        ['get_file', { vault: 'probe', path: 'wiki/a.md' }],
        ['write_file', { vault: 'probe', path: 'wiki/a.md', content: '# a\n' }],
      ]) {
        const out = await callTool(tool, args);
        assert.ok('clickToOpenUrl' in out, `${tool}: the null link must be stated, not omitted`);
        assert.equal(out.clickToOpenUrl, null, tool);
        assert.match(out.linkHint || '', /No local click-to-open link for remote vault "probe", and this router has no view agent/, tool);
        assert.match(out.linkHint, /list_vaults \(viewAgent\.hint\)/, tool);
      }
    });
  });

  test('agent configured: a housekeeping write gets no automatic link, so its hint names the explicit call', async () => {
    await withRouter({ agentEnv: { OBSIDIAN_ROUTER_VIEW_AGENT_URL: agentUrl } }, async ({ callTool }) => {
      const out = await callTool('write_file', { vault: 'probe', path: 'wiki-meta/log-test.md', content: 'x\n' });
      assert.equal(out.viewLink, undefined, 'wiki-meta/ is skipped by the automatic injection');
      assert.match(out.linkHint || '', /call get_view_link\(\{"vault":"probe","note":"wiki-meta\/log-test.md"\}\)/);
      // A normal note write gets its link, and then no hint.
      const ok = await callTool('write_file', { vault: 'probe', path: 'wiki/b.md', content: 'x\n' });
      assert.equal(ok.viewLink, AGENT_LINK);
      assert.equal(ok.linkHint, undefined);
    });
  });
});
