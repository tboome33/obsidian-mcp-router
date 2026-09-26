/**
 * The /view "vault hints" — `rest` and `obsidian_name` (view-agent repo,
 * docs/CONTRACT.md § Vault hints).
 *
 * A provider such as view-agent-direct classifies a vault nobody declared to
 * it from these two claims: the origin of the vault's Local REST API as the
 * router reaches it, and the vault's label inside Obsidian. Without them the
 * desktop vault `router` (PC 10.8.0.10, REST :27163) answers `400 unknown
 * vault`, and no write into it carries a viewLink.
 *
 * What is pinned here, one block per rule:
 *   - `rest` is the origin ONLY: no userinfo, no path, no query, no fragment,
 *     an explicit port even when `baseUrl` has none, http/https only;
 *   - `obsidian_name` is the folder name for a local vault, the declared
 *     `obsidianName` for a remote one, and is validated before it is sent;
 *   - nothing is sent when nothing is known, and nothing secret ever is: the
 *     URL and the request headers are checked for the API key and for every
 *     extraHeaders value;
 *   - the three callers hand the descriptor over — `get_view_link` and
 *     `open_in_obsidian` driven directly, the write-time injection driven
 *     through the REAL server over stdio, because it lives in the CallTool
 *     dispatcher and nothing short of a tools/call reaches it;
 *   - the registry loads `obsidianName` from `remoteVaults[]` and `VAULT_*`,
 *     and drops an invalid one without dropping the vault.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { fetchViewLink, viewLinkForWrite, vaultHints, __resetViewLinkCircuit } from '../src/helpers/view-link.mjs';
import { isValidObsidianName, obsidianNameFor } from '../src/helpers/obsidian-name.mjs';
import { getViewLinkTool } from '../src/tools/get-view-link.mjs';
import { openInObsidianTool } from '../src/tools/open-in-obsidian.mjs';
import { loadRegistry, _internals } from '../src/registry.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(REPO, 'bin', 'obsidian-mcp-router.mjs');

// Distinctive markers, not credentials: the assertions search the wire for them.
const SECRET_KEY = ['marker', 'apikey', 'vault', 'hints'].join('-');
const SECRET_HEADER = ['marker', 'extraheader', 'vault', 'hints'].join('-');
const CTRL = String.fromCharCode(7);
const AGENT_LINK = 'http://10.8.0.1:27200/go?v=x&s=sig';

// ---------------------------------------------------------------------------
// A stand-in view-agent that records every request.
// ---------------------------------------------------------------------------

let agent;
let agentUrl;
let seen;

before(async () => {
  seen = [];
  agent = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ url: AGENT_LINK }));
  });
  await new Promise((r) => agent.listen(0, '127.0.0.1', r));
  agentUrl = `http://127.0.0.1:${agent.address().port}`;
});

after(() => agent.close());

beforeEach(() => {
  seen.length = 0;
  __resetViewLinkCircuit();
  process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL = agentUrl;
  delete process.env.OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN;
  delete process.env.OBSIDIAN_ROUTER_SMART_LINK_URL;
  delete process.env.OBSIDIAN_ROUTER_SMART_LINK_SECRET;
});

/** The query of the one /view request the agent saw, as a URLSearchParams. */
function lastQuery() {
  const hits = seen.filter((r) => r.url.startsWith('/view'));
  assert.equal(hits.length, 1, `expected exactly one /view request, saw ${hits.length}`);
  return new URL(hits[0].url, 'http://agent').searchParams;
}

function remote(extra = {}) {
  return {
    name: 'router',
    type: 'remote',
    baseUrl: 'http://10.8.0.10:27163',
    apiKey: SECRET_KEY,
    extraHeaders: { 'CF-Access-Client-Secret': SECRET_HEADER },
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// vaultHints — the rules, pure
// ---------------------------------------------------------------------------

describe('rest — the origin and nothing else', () => {
  test('a plain baseUrl gives scheme://host:port', () => {
    assert.equal(vaultHints(remote()).rest, 'http://10.8.0.10:27163');
  });

  test('userinfo in baseUrl never reaches the hint', () => {
    const h = vaultHints(remote({ baseUrl: 'https://user:p4ss@10.8.0.10:27163' }));
    assert.equal(h.rest, 'https://10.8.0.10:27163');
  });

  test('a path, query and fragment in baseUrl are dropped', () => {
    const h = vaultHints(remote({ baseUrl: 'http://10.8.0.10:27163/some/path?k=v#frag' }));
    assert.equal(h.rest, 'http://10.8.0.10:27163');
  });

  test('no explicit port → the scheme default, stated explicitly', () => {
    assert.equal(vaultHints(remote({ baseUrl: 'http://10.8.0.10' })).rest, 'http://10.8.0.10:80');
    assert.equal(vaultHints(remote({ baseUrl: 'https://vault.example.com' })).rest, 'https://vault.example.com:443');
    // An explicit default port is dropped by the URL parser — it must come back.
    assert.equal(vaultHints(remote({ baseUrl: 'https://vault.example.com:443' })).rest, 'https://vault.example.com:443');
  });

  test('an IPv6 host keeps its brackets', () => {
    assert.equal(vaultHints(remote({ baseUrl: 'https://[::1]:27124' })).rest, 'https://[::1]:27124');
  });

  test('odd baseUrls: the hint is an origin with an explicit port, or nothing', () => {
    const ORIGIN = /^https?:\/\/[^/@?#\s]+:\d+$/;
    const odd = [
      'HTTP://User:Pw@10.8.0.10:27163/A?b#c',
      'http://a\\b@10.8.0.10:27163/x',
      'http:10.8.0.10:27163/x',
      '  http://10.8.0.10:27163/x  ',
      'http://%31%30.8.0.10:27163/%2F?x=@',
      'https://xn--bcher-kva.example./path',
      'https://bücher.example:8443/p?q',
      'http://[fe80::1%25eth0]:27163/',
      'http://u@[::1]:27163/p',
      'http://10.8.0.10:27163@evil.example/p',
      'http://evil.example#@10.8.0.10:27163',
    ];
    for (const b of odd) {
      const r = vaultHints(remote({ baseUrl: b })).rest;
      if (r === undefined) continue; // the parser refused it: no hint, which is allowed
      assert.match(r, ORIGIN, `${JSON.stringify(b)} → ${JSON.stringify(r)}`);
      assert.ok(!/user|pw|@/i.test(r), `${JSON.stringify(b)} leaked userinfo into ${r}`);
    }
    // Where the host really is, the hint says so — not the part a reader might mistake for it.
    assert.equal(vaultHints(remote({ baseUrl: 'http://10.8.0.10:27163@evil.example/p' })).rest, 'http://evil.example:80');
  });

  test('a scheme other than http/https sends no rest hint', () => {
    assert.equal(vaultHints(remote({ baseUrl: 'ftp://10.8.0.10:27163' })).rest, undefined);
    assert.equal(vaultHints(remote({ baseUrl: 'file:///C:/vault' })).rest, undefined);
  });

  test('an absent or unparsable baseUrl sends no rest hint, and does not throw', () => {
    assert.equal(vaultHints(remote({ baseUrl: undefined })).rest, undefined);
    assert.equal(vaultHints(remote({ baseUrl: 'not a url' })).rest, undefined);
    assert.equal(vaultHints(remote({ baseUrl: 42 })).rest, undefined);
    assert.deepEqual(vaultHints(undefined), {});
    assert.deepEqual(vaultHints(null), {});
  });
});

describe('obsidian_name — the label inside Obsidian', () => {
  test('a local vault sends its folder name, casing kept (Windows path)', () => {
    const local = { name: 'opsidian-mcp-router et bridge', type: 'local', baseUrl: 'https://127.0.0.1:27160', path: 'C:\\VAULTS\\Opsidian MCP Router' };
    assert.equal(vaultHints(local).obsidian_name, 'Opsidian MCP Router');
  });

  test('a local vault sends its folder name (POSIX path)', () => {
    const local = { name: 'roland', type: 'local', baseUrl: 'https://127.0.0.1:27157', path: '/srv/vaults/Roland' };
    assert.equal(vaultHints(local).obsidian_name, 'Roland');
  });

  test('a remote vault sends its declared obsidianName', () => {
    assert.equal(vaultHints(remote({ obsidianName: 'opsidian-mcp-router et bridge' })).obsidian_name, 'opsidian-mcp-router et bridge');
  });

  test('a declared obsidianName wins over a path basename', () => {
    assert.equal(obsidianNameFor({ obsidianName: 'Declared', path: 'C:\\VAULTS\\Folder' }), 'Declared');
  });

  test('a remote vault without obsidianName sends none — the router name is never guessed as a label', () => {
    assert.equal(vaultHints(remote()).obsidian_name, undefined);
  });

  test('an invalid label is not sent, even one the loader never saw', () => {
    for (const bad of ['', '   ', `a${CTRL}b`, 'a/b', 'a\\b', 'x'.repeat(256), 5]) {
      assert.equal(vaultHints(remote({ obsidianName: bad })).obsidian_name, undefined, `sent ${JSON.stringify(bad)}`);
    }
    // a derived basename passes the same gate
    assert.equal(vaultHints({ name: 'v', path: `C:\\VAULTS\\a${CTRL}b` }).obsidian_name, undefined);
  });

  test('the validator accepts the 255-character boundary and real vault names', () => {
    assert.equal(isValidObsidianName('x'.repeat(255)), true);
    assert.equal(isValidObsidianName('x'.repeat(256)), false);
    assert.equal(isValidObsidianName('opsidian-mcp-router et bridge'), true);
    assert.equal(isValidObsidianName('selarl cabinet dentaire galzy r.'), true);
    assert.equal(isValidObsidianName('la méthode licares'), true);
  });
});

// ---------------------------------------------------------------------------
// fetchViewLink — what actually goes on the wire
// ---------------------------------------------------------------------------

describe('fetchViewLink — the hints on the wire', () => {
  test('sends rest and obsidian_name alongside vault and note', async () => {
    await fetchViewLink({
      vaultName: 'router',
      note: 'wiki/a.md',
      vault: remote({ baseUrl: 'http://user:pw@10.8.0.10:27163/x?y=1', obsidianName: 'opsidian-mcp-router et bridge' }),
    });
    const q = lastQuery();
    assert.equal(q.get('vault'), 'router');
    assert.equal(q.get('note'), 'wiki/a.md');
    assert.equal(q.get('rest'), 'http://10.8.0.10:27163');
    assert.equal(q.get('obsidian_name'), 'opsidian-mcp-router et bridge');
    assert.deepEqual([...q.keys()].sort(), ['note', 'obsidian_name', 'rest', 'vault']);
  });

  test('no API key, no extraHeaders value, no credential anywhere in the request', async () => {
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN = 'view-token';
    await fetchViewLink({
      vaultName: 'router',
      note: 'a.md',
      vault: remote({ baseUrl: `http://${SECRET_KEY}:${SECRET_HEADER}@10.8.0.10:27163`, obsidianName: 'router vault' }),
    });
    const hit = seen.find((r) => r.url.startsWith('/view'));
    const wire = decodeURIComponent(hit.url) + JSON.stringify(hit.headers);
    assert.ok(!wire.includes(SECRET_KEY), 'the API key reached the view-agent');
    assert.ok(!wire.includes(SECRET_HEADER), 'an extraHeaders value reached the view-agent');
    assert.equal(hit.headers.authorization, undefined, 'an Authorization header was sent');
    assert.equal(hit.headers['cf-access-client-secret'], undefined);
    assert.equal(hit.headers['x-view-token'], 'view-token');
  });

  test('without a descriptor, the request is exactly what it was before (additive contract)', async () => {
    await fetchViewLink({ vaultName: 'router', note: 'a.md' });
    assert.deepEqual([...lastQuery().keys()].sort(), ['note', 'vault']);
  });

  test('nothing known → no hint parameter at all', async () => {
    await fetchViewLink({ vaultName: 'router', vault: { name: 'router', type: 'remote', baseUrl: 'garbage' } });
    assert.deepEqual([...lastQuery().keys()], ['vault']);
  });

  test("a descriptor for ANOTHER vault sends no hint — one vault is never labelled with another's origin", async () => {
    await fetchViewLink({ vaultName: 'router', vault: remote({ name: 'other', obsidianName: 'Other' }) });
    assert.deepEqual([...lastQuery().keys()], ['vault']);
  });

  test('a redirect is refused, never followed — the token and the hints stay with the provider', async () => {
    // A second server stands where a redirect would lead, and records anything that arrives.
    const elsewhere = [];
    const collector = http.createServer((req, res) => {
      elsewhere.push({ url: req.url, headers: req.headers });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: 'http://collector/stolen' }));
    });
    await new Promise((r) => collector.listen(0, '127.0.0.1', r));
    const target = `http://127.0.0.1:${collector.address().port}/view`;
    const redirecting = http.createServer((req, res) => {
      seen.push({ url: req.url, headers: req.headers });
      res.writeHead(302, { Location: target });
      res.end();
    });
    await new Promise((r) => redirecting.listen(0, '127.0.0.1', r));
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL = `http://127.0.0.1:${redirecting.address().port}`;
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN = 'view-token';
    try {
      await assert.rejects(
        () => fetchViewLink({ vaultName: 'router', note: 'a.md', vault: remote({ obsidianName: 'Router Vault' }) }),
        (err) => /redirect \(302\)/.test(err.message) && err.viewAgentTransient === false,
      );
      assert.equal(elsewhere.length, 0, `the redirect was followed: ${JSON.stringify(elsewhere)}`);
      // The eager path reports it and stays up — and the breaker stays closed.
      for (let i = 0; i < 4; i++) {
        const r = await viewLinkForWrite({ vaultName: 'router', note: 'a.md', vault: remote() });
        assert.match(r.viewLinkError || '', /redirect/);
      }
      assert.equal(elsewhere.length, 0);
    } finally {
      await new Promise((r) => redirecting.close(r));
      await new Promise((r) => collector.close(r));
    }
  });

  test('viewLinkForWrite hands the descriptor through', async () => {
    const r = await viewLinkForWrite({ vaultName: 'router', note: 'wiki/a.md', vault: remote({ obsidianName: 'Router Vault' }) });
    assert.ok(r.viewLink, JSON.stringify(r));
    const q = lastQuery();
    assert.equal(q.get('rest'), 'http://10.8.0.10:27163');
    assert.equal(q.get('obsidian_name'), 'Router Vault');
  });
});

// ---------------------------------------------------------------------------
// The two tools
// ---------------------------------------------------------------------------

describe('the explicit callers pass the resolved descriptor', () => {
  const registryFor = (v) => ({ resolveVault: () => v, defaultVault: v.name });

  test('get_view_link', async () => {
    await getViewLinkTool(registryFor(remote({ obsidianName: 'Router Vault' })), { vault: 'router', note: 'a.md' });
    const q = lastQuery();
    assert.equal(q.get('rest'), 'http://10.8.0.10:27163');
    assert.equal(q.get('obsidian_name'), 'Router Vault');
  });

  test('open_in_obsidian (view-agent branch)', async () => {
    const r = await openInObsidianTool(registryFor(remote({ obsidianName: 'Router Vault' })), { vault: 'router', path: 'a.md' });
    assert.equal(r.viewLinkKind, 'agent');
    const q = lastQuery();
    assert.equal(q.get('rest'), 'http://10.8.0.10:27163');
    assert.equal(q.get('obsidian_name'), 'Router Vault');
  });
});

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

function quietly(fn) {
  const original = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.map(String).join(' '));
  return Promise.resolve()
    .then(fn)
    .then((result) => ({ result, stderr: lines.join('\n') }))
    .finally(() => { console.error = original; });
}

describe('registry — obsidianName is loaded, validated, and never fatal', () => {
  test('VAULT_*: a valid obsidianName is carried, an invalid one dropped with the vault kept', async () => {
    const env = {
      VAULT_A: JSON.stringify({ name: 'a', baseUrl: 'http://10.8.0.10:1', apiKey: 'k', obsidianName: 'Vault A' }),
      VAULT_B: JSON.stringify({ name: 'b', baseUrl: 'http://10.8.0.10:2', apiKey: 'k', obsidianName: `x${CTRL}y` }),
      VAULT_C: JSON.stringify({ name: 'c', baseUrl: 'http://10.8.0.10:3', apiKey: 'k' }),
      // JSON null is documented as "absent": no label, and no warning either.
      VAULT_D: JSON.stringify({ name: 'd', baseUrl: 'http://10.8.0.10:4', apiKey: 'k', obsidianName: null }),
    };
    const { result, stderr } = await quietly(() => _internals.parseEnvVaults(env));
    const byName = Object.fromEntries(result.envVaults.map((v) => [v.name, v]));
    assert.deepEqual(Object.keys(byName).sort(), ['a', 'b', 'c', 'd']);
    assert.equal(byName.a.obsidianName, 'Vault A');
    assert.equal(byName.b.obsidianName, undefined);
    assert.equal(byName.c.obsidianName, undefined);
    assert.equal(byName.d.obsidianName, undefined);
    assert.match(stderr, /VAULT_B: obsidianName ignored/);
    assert.equal((stderr.match(/obsidianName ignored/g) || []).length, 1, stderr);
    assert.ok(!stderr.includes(CTRL), 'the warning echoed the rejected value');
  });

  test('remoteVaults[]: same rule through loadRegistry', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-hints-reg-'));
    const saved = {};
    for (const k of Object.keys(process.env)) if (/^VAULT_/.test(k)) { saved[k] = process.env[k]; delete process.env[k]; }
    // Anything the loader resolves under a home directory lands in the temp dir.
    const HOME_KEYS = ['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH'];
    const savedHome = Object.fromEntries(HOME_KEYS.map((k) => [k, process.env[k]]));
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    process.env.HOMEDRIVE = '';
    process.env.HOMEPATH = '';
    try {
      const configPath = path.join(dir, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({
        portRegistry: {},
        remoteVaults: [
          { name: 'good', baseUrl: 'http://10.8.0.10:27163', apiKey: 'k', obsidianName: 'opsidian-mcp-router et bridge' },
          { name: 'bad', baseUrl: 'http://10.8.0.10:27164', apiKey: 'k', obsidianName: 'a/b' },
        ],
      }), 'utf8');
      const { result: reg, stderr } = await quietly(() => loadRegistry({ configPath }));
      const good = reg.vaults.find((v) => v.name === 'good');
      const bad = reg.vaults.find((v) => v.name === 'bad');
      assert.equal(good.obsidianName, 'opsidian-mcp-router et bridge');
      assert.ok(bad, 'an invalid obsidianName dropped the whole vault');
      assert.equal(bad.obsidianName, undefined);
      assert.match(stderr, /remoteVault "bad": obsidianName ignored/);
      // And end to end from the loaded descriptor:
      assert.equal(vaultHints(good).obsidian_name, 'opsidian-mcp-router et bridge');
    } finally {
      Object.assign(process.env, saved);
      for (const [k, v] of Object.entries(savedHome)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The write-time injection, through the real server
// ---------------------------------------------------------------------------

describe('E2E: a note write sends the hints to the view-agent', () => {
  test('write_file over stdio → /view carries rest and obsidian_name from the loaded config', async () => {
    const vaultSeen = [];
    const fakeVault = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        vaultSeen.push(`${req.method} ${req.url}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise((r) => fakeVault.listen(0, '127.0.0.1', r));
    const vaultPort = fakeVault.address().port;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-hints-e2e-'));
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      portRegistry: {},
      vaultNames: {},
      remoteVaults: [{
        name: 'probe',
        baseUrl: `http://127.0.0.1:${vaultPort}`,
        apiKey: SECRET_KEY,
        timeoutMs: 5000,
        obsidianName: 'Probe Vault',
      }],
      defaultVault: 'probe',
    }), 'utf8');

    const home = path.join(dir, 'home');
    fs.mkdirSync(home);
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^VAULT_/.test(k)) delete env[k];
    const child = spawn(process.execPath, [BIN, '--config', configPath], {
      cwd: dir,
      env: {
        ...env,
        HOME: home,
        USERPROFILE: home,
        HOMEDRIVE: '',
        HOMEPATH: '',
        OBSIDIAN_ROUTER_NO_WATCH: '1',
        OBSIDIAN_ROUTER_LOCKED: '',
        OBSIDIAN_ROUTER_USER_ID: '',
        OBSIDIAN_ROUTER_SMART_LINK_URL: '',
        OBSIDIAN_ROUTER_SMART_LINK_SECRET: '',
        OBSIDIAN_ROUTER_VIEW_AGENT_URL: agentUrl,
        OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN: '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Track termination FROM THE START: a router that dies before answering
    // must fail the pending call at once, and the cleanup below must not wait
    // for an 'exit' event that has already fired.
    let exitInfo = null;
    const exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => { exitInfo = { code, signal }; resolve(); });
      child.once('error', (err) => { exitInfo = { error: err.message }; resolve(); });
    });
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
    const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
    const call = (id, method, params) => new Promise((resolve, reject) => {
      if (exitInfo) { reject(new Error(`router already exited ${JSON.stringify(exitInfo)}\n${stderr}`)); return; }
      const t = setTimeout(() => reject(new Error(`timed out on ${method}\n${stderr}`)), 20000);
      exited.then(() => { clearTimeout(t); reject(new Error(`router exited ${JSON.stringify(exitInfo)} during ${method}\n${stderr}`)); });
      waiters.set(id, (m) => { clearTimeout(t); resolve(m); });
      send({ jsonrpc: '2.0', id, method, params });
    });

    try {
      await call(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'vault-hints-e2e', version: '0' } });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const res = await call(2, 'tools/call', { name: 'write_file', arguments: { vault: 'probe', path: 'wiki/e2e.md', content: '# hi\n' } });
      assert.ok(!res.error, `write failed: ${JSON.stringify(res.error)}\n${stderr}`);
      assert.ok(vaultSeen.some((l) => l.startsWith('PUT /vault/wiki/e2e.md')), `no PUT: ${vaultSeen.join(', ')}`);
      // The LINK itself, not a mention of it: `viewLinkError` would match /viewLink/.
      assert.notEqual(res.result.isError, true, `the tool reported an error: ${JSON.stringify(res.result)}`);
      const text = res.result.content.map((c) => c.text || '').join('');
      const payload = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
      assert.equal(payload.viewLinkError, undefined, `viewLinkError: ${payload.viewLinkError}\n${stderr}`);
      assert.equal(payload.viewLinkKind, 'agent');
      assert.equal(payload.viewLink, AGENT_LINK);

      const q = lastQuery();
      assert.equal(q.get('vault'), 'probe');
      assert.equal(q.get('note'), 'wiki/e2e.md');
      assert.equal(q.get('rest'), `http://127.0.0.1:${vaultPort}`);
      assert.equal(q.get('obsidian_name'), 'Probe Vault');
      const hit = seen.find((r) => r.url.startsWith('/view'));
      assert.ok(!(decodeURIComponent(hit.url) + JSON.stringify(hit.headers)).includes(SECRET_KEY), 'the API key reached the view-agent');
    } finally {
      // Wait for the exit: on Windows the child holds its cwd until it is gone.
      if (!exitInfo) child.kill();
      await exited;
      await new Promise((r) => fakeVault.close(r));
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });
});
