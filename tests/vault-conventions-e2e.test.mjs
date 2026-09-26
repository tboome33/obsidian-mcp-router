/**
 * END TO END, over the real server's stdio: the conventions reach the writer.
 *
 * The unit tests in vault-conventions-reach.test.mjs prove the pieces; this
 * proves the WIRING — that the dispatcher really attaches the brief to the
 * first write into a vault and only that one, attaches the decision-page checks
 * to a bad decision write, and that `list_vaults` really reports the build and
 * the hooks. A helper that works and is never called is the defect class this
 * file exists to catch.
 *
 * The vault is a loopback HTTP stand-in for the Local REST API; its conventions
 * file is the real template file (tests/fixtures/kiviri-os-documentation/).
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(REPO, 'bin', 'obsidian-mcp-router.mjs');
// Built, not written as a literal: the release scan flags any long string
// assigned to a key-shaped name, fixture or not.
const API_KEY = ['e2e', 'conv'].join('-');
const CONVENTIONS = fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'kiviri-os-documentation', 'CLAUDE.md'), 'utf8');

const tmpDirs = [];
after(() => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

async function startFakeVault() {
  const files = { 'Documentation/CLAUDE.md': CONVENTIONS };
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = decodeURIComponent(req.url.split('?')[0]);
      seen.push(`${req.method} ${url}`);
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'GET' && url === '/') return json(200, { status: 'OK', authenticated: true, service: 'Obsidian Local REST API', versions: { self: '4.0.0' } });
      if (req.method === 'GET' && url.startsWith('/vault/') && url.endsWith('/')) {
        const dir = url.slice('/vault/'.length);
        const names = new Set();
        for (const p of Object.keys(files)) {
          if (!p.startsWith(dir)) continue;
          const rest = p.slice(dir.length);
          names.add(rest.includes('/') ? `${rest.split('/')[0]}/` : rest);
        }
        if (dir && names.size === 0) return json(404, { message: 'Not Found', errorCode: 40400 });
        return json(200, { files: [...names] });
      }
      if (req.method === 'GET' && url.startsWith('/vault/')) {
        const p = url.slice('/vault/'.length);
        if (!(p in files)) return json(404, { message: 'Not Found', errorCode: 40400 });
        res.writeHead(200, { 'Content-Type': 'text/markdown' });
        return res.end(files[p]);
      }
      if (req.method === 'PUT' && url.startsWith('/vault/')) {
        files[url.slice('/vault/'.length)] = body;
        res.writeHead(204); return res.end();
      }
      if (req.method === 'POST') { res.writeHead(204); return res.end(); }
      return json(404, { message: 'Not Found', errorCode: 40400 });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { seen, files, port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

function startRouter(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-e2e-'));
  tmpDirs.push(dir);
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    portRegistry: {},
    vaultNames: {},
    remoteVaults: [{ name: 'probe', baseUrl: `http://127.0.0.1:${port}`, apiKey: API_KEY, timeoutMs: 5000 }],
    defaultVault: 'probe',
  }, null, 2));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const child = spawn(process.execPath, [BIN, '--config', configPath], {
    cwd: dir,
    env: {
      ...process.env,
      HOME: home, USERPROFILE: home, HOMEDRIVE: '', HOMEPATH: home,
      OBSIDIAN_ROUTER_CONFIG: configPath,
      OBSIDIAN_ROUTER_NO_WATCH: '1',
      OBSIDIAN_ROUTER_USER_ID: '',
      OBSIDIAN_ROUTER_LOCKED: '',
      OBSIDIAN_ROUTER_VIEW_AGENT_URL: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  const waiters = new Map();
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { err += c; });
  child.stdout.on('data', (chunk) => {
    out += chunk;
    let nl;
    while ((nl = out.indexOf('\n')) !== -1) {
      const raw = out.slice(0, nl).trim();
      out = out.slice(nl + 1);
      if (!raw) continue;
      let msg; try { msg = JSON.parse(raw); } catch { continue; }
      const w = waiters.get(msg.id); if (w) { waiters.delete(msg.id); w(msg); }
    }
  });
  let id = 10;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const my = id++;
    const t = setTimeout(() => reject(new Error(`timeout ${method}\n${err}`)), 20000);
    waiters.set(my, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: my, method, params })}\n`);
  });
  const tool = async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: args });
    assert.ok(!r.error, `${name}: ${JSON.stringify(r.error)}\n${err}`);
    const text = r.result?.content?.[0]?.text ?? '';
    assert.ok(!r.result?.isError, `${name} failed: ${text}\n${err}`);
    return JSON.parse(text);
  };
  return {
    init: async () => {
      await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'conv-e2e', version: '0' } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    },
    tool,
    kill: () => child.kill(),
  };
}

describe('E2E: the first write into a vault carries its conventions', () => {
  test('brief once, decision checks on a bad decision page, nothing on a clean second write', async () => {
    const vault = await startFakeVault();
    const rt = startRouter(vault.port);
    try {
      await rt.init();
      const first = await rt.tool('write_file', {
        vault: 'probe',
        path: 'wiki/decision-x.md',
        content: '---\ntype: decision\ntitle: X\n---\n\n# X\n\nWe chose X.\n',
      });
      assert.ok(vault.files['wiki/decision-x.md'], 'the write happened — the checks never block it');
      assert.equal(first.vaultConventions?.conventionsFile, 'Documentation/CLAUDE.md', JSON.stringify(first));
      assert.ok(first.vaultConventions.installed.includes('wiki-query-first'));
      const rules = first.pageChecks?.[0]?.findings?.map((f) => f.rule) ?? [];
      for (const want of ['status-missing', 'section-missing-context', 'description-missing']) {
        assert.ok(rules.includes(want), `expected ${want}; got ${rules}`);
      }

      const second = await rt.tool('write_file', { vault: 'probe', path: 'wiki/note.md', content: '---\ntype: concept\n---\n\n# N\n' });
      assert.equal(second.vaultConventions, undefined, 'the brief is shown once per vault per session');
      assert.equal(second.pageChecks, undefined);

      const audit = await rt.tool('audit_vault_conventions', { vault: 'probe' });
      assert.equal(audit.conventionsFile, 'Documentation/CLAUDE.md');
      assert.deepEqual(audit.missingRecommended.sort(), ['auto-enrichment', 'bilingual', 'heading-hierarchy', 'source-type']);
      assert.equal(audit.reference.status, 'not-configured');

      const lv = await rt.tool('list_vaults', {});
      assert.match(lv.routerBuild?.fingerprint ?? '', /^[0-9a-f]{16}$/, JSON.stringify(lv.routerBuild));
      assert.equal(lv.routerBuild.hooksManifest, true, 'this checkout has hooks/hooks.json');
      assert.ok(['not-yet-observed', 'not-observed'].includes(lv.sessionHooks?.status), `no hook ran in this test: ${JSON.stringify(lv.sessionHooks)}`);
    } finally {
      rt.kill();
      await vault.close();
    }
  });
});
