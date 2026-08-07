/**
 * THE AUDIT MIDDLEWARE, DRIVEN END TO END — the biggest coverage hole of the
 * v0.71.0 review.
 *
 * The whole audit surface was covered by unit tests on `pickAuditPath` and
 * `formatAuditLine` plus one test named "middleware wire-up sanity"
 * (`tests/user-id-audit.test.mjs`) which reads `src/index.mjs` AS TEXT and
 * greps it for three substrings. Measured: replacing the middleware's own
 * activation condition
 *
 *     if (userId && WRITE_TOOL_NAMES.has(name)) {
 *
 * with
 *
 *     if (false) {
 *
 * leaves 3 652 / 3 652 green. Every string the grep looks for is still in the
 * file; the branch is simply unreachable. Sixteen rounds hardened what the line
 * CONTAINS and nothing checked that the line is ever WRITTEN — the audit journal
 * could have been dead in production and the suite would have said so in no way
 * at all.
 *
 * So this file drives the REAL server: the actual `bin/obsidian-mcp-router.mjs`
 * process, over real stdio JSON-RPC, against a loopback HTTP server playing the
 * Local REST API. The assertion is on what that server RECEIVED — a `PUT` of the
 * note, then a `POST` appending the attribution line to `wiki-meta/journal.md`.
 * Nothing here reads the router's source.
 *
 * Why a subprocess rather than importing `startServer`: the middleware lives
 * inside the `CallToolRequestSchema` handler, which only runs when a real
 * `tools/call` arrives over a transport. Anything that reaches around the
 * transport tests the pieces again instead of the wiring — which is exactly how
 * the hole got here.
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
const API_KEY = 'e2e-test-key';

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

/**
 * A loopback stand-in for the Local REST API that RECORDS every request.
 *
 * Deliberately permissive — it answers 200 to everything under `/vault/` — so a
 * failing assertion below means the router did not make the call, never that the
 * fake refused it. A stricter fake would let a wrong request fail for the fake's
 * reasons instead of the router's, which is the trap the `set_frontmatter` row
 * in `security-invariants` documents.
 */
async function startFakeVault() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: decodeURIComponent(req.url), body, headers: req.headers });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { seen, port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

function writeConfig(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-e2e-'));
  tmpDirs.push(dir);
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    portRegistry: {},
    vaultNames: {},
    remoteVaults: [{
      name: 'probe',
      description: 'loopback stand-in for the Local REST API',
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: API_KEY,
      timeoutMs: 5000,
    }],
    defaultVault: 'probe',
  }, null, 2), 'utf8');
  return { dir, configPath };
}

/** Speak MCP over the real process's stdio. Resolves when `id` comes back. */
function startRouter({ configPath, cwd, env = {} }) {
  const child = spawn(process.execPath, [BIN, '--config', configPath], {
    cwd,
    env: {
      ...process.env,
      OBSIDIAN_ROUTER_NO_WATCH: '1',
      // Setting a user id puts the router in "gated deployment" mode, which
      // fails closed at startup unless the conversion sandbox is configured.
      // Pointed at the throwaway config dir: this test converts nothing, and a
      // real path here would widen the sandbox for the sake of a fixture.
      MD_ALLOWED_PATHS: cwd,
      // Keep the run hermetic: no workspace .env, no lock, no view agent, and
      // no projections scheduler racing the assertions.
      OBSIDIAN_ROUTER_LOCKED: '',
      OBSIDIAN_ROUTER_VIEW_AGENT_URL: '',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
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
  const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  const call = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${method}\n--- router stderr ---\n${stderr}`)),
      20000,
    );
    waiters.set(id, (m) => { clearTimeout(timer); resolve(m); });
    send({ jsonrpc: '2.0', id, method, params });
  });
  return { child, call, send, stderrText: () => stderr, kill: () => child.kill() };
}

async function handshake(rt) {
  await rt.call(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'audit-e2e', version: '0' },
  });
  rt.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

describe('E2E: a successful write really does append an attribution line', () => {
  test('write_file over real stdio JSON-RPC produces the PUT and then the journal POST', async () => {
    const vault = await startFakeVault();
    const { dir, configPath } = writeConfig(vault.port);
    const rt = startRouter({
      configPath,
      cwd: dir,
      env: { OBSIDIAN_ROUTER_USER_ID: 'roland' },
    });
    try {
      await handshake(rt);
      const res = await rt.call(2, 'tools/call', {
        name: 'write_file',
        arguments: { vault: 'probe', path: 'wiki/e2e.md', content: '# hello\n' },
      });
      assert.ok(!res.error, `the write itself failed: ${JSON.stringify(res.error)}\n${rt.stderrText()}`);

      // 1. THE WRITE HAPPENED. Without this the audit assertion below could be
      //    satisfied by a router that journals writes it never performed.
      const put = vault.seen.find((r) => r.method === 'PUT' && r.url === '/vault/wiki/e2e.md');
      assert.ok(put, `no PUT of the note: ${JSON.stringify(vault.seen.map((r) => `${r.method} ${r.url}`))}`);
      assert.equal(put.body, '# hello\n');

      // 2. AND SO DID THE ATTRIBUTION. This is the assertion the whole file
      //    exists for: an append to the journal, from the middleware, after the
      //    handler returned. `if (false)` above the audit block makes exactly
      //    this line red and nothing else in the suite.
      const appends = vault.seen.filter(
        (r) => r.method === 'POST' && /\/vault\/wiki-meta\/(journal|log)\.md$/.test(r.url),
      );
      assert.ok(
        appends.length >= 1,
        'the audit middleware never appended: '
        + `${JSON.stringify(vault.seen.map((r) => `${r.method} ${r.url}`))}\n${rt.stderrText()}`,
      );

      // 3. AND IT SAYS THE RIGHT THING. Same shape downstream tooling greps for
      //    (`git log -p wiki-meta/journal.md | grep "by roland"`).
      const audit = appends.map((a) => a.body).join('');
      assert.match(
        audit,
        /^\n\[claude-write by roland\] \d{4}-\d{2}-\d{2} \d{2}:\d{2} — write_file path="wiki\/e2e\.md"\n$/,
        `the appended line is not the audit record: ${JSON.stringify(audit)}`,
      );

      // 4. THE REQUEST WAS AUTHENTICATED AND ORDERED. The append must follow the
      //    write — a journal entry for a write that had not happened yet would
      //    be attributing an outcome nobody had.
      assert.equal(appends[0].headers.authorization, `Bearer ${API_KEY}`);
      assert.ok(
        vault.seen.indexOf(put) < vault.seen.indexOf(appends[0]),
        'the journal was appended BEFORE the write it attributes',
      );
    } finally {
      rt.kill();
      await vault.close();
    }
  });

  test('with OBSIDIAN_ROUTER_USER_ID unset, the same write appends nothing', async () => {
    // THE OTHER HALF OF THE CLAIM. A pin that only proves the append happens is
    // satisfied by a router that appends unconditionally — and audit logging is
    // documented as opt-in, gated on the operator setting a user id. Without
    // this, "the middleware is wired" and "the middleware is always on" are
    // indistinguishable.
    const vault = await startFakeVault();
    const { dir, configPath } = writeConfig(vault.port);
    const rt = startRouter({ configPath, cwd: dir, env: { OBSIDIAN_ROUTER_USER_ID: '' } });
    try {
      await handshake(rt);
      const res = await rt.call(2, 'tools/call', {
        name: 'write_file',
        arguments: { vault: 'probe', path: 'wiki/e2e.md', content: '# hello\n' },
      });
      assert.ok(!res.error, `the write itself failed: ${JSON.stringify(res.error)}`);
      assert.ok(vault.seen.some((r) => r.method === 'PUT'), 'the write did not happen at all');
      assert.deepEqual(
        vault.seen.filter((r) => r.method === 'POST').map((r) => r.url), [],
        'the audit journal was written even though no user id is configured',
      );
    } finally {
      rt.kill();
      await vault.close();
    }
  });

  test('provision_vault can never reach the audit line — the two gates are one condition', async () => {
    // WHY THIS IS A TEST AND NOT A FIX. `provision_vault.path` has exactly the
    // shape that made `download_page_assets.outputDir` unsafe: a caller-supplied
    // ABSOLUTE path that never meets `canonicalVaultPath` and would be rendered
    // by `formatAuditLine`. It is nonetheless unreachable, and adding a guard
    // there would be a defensive edit nobody could justify later — so the
    // reasoning is pinned instead:
    //
    //   audit fires   iff  `userId` is truthy          (index.mjs, ~line 2072)
    //   tool refused  iff  `gated` is truthy           (index.mjs, ~line 2053)
    //   userId and gated are BOTH derived from OBSIDIAN_ROUTER_USER_ID
    //
    // …and the refusal happens BEFORE the handler runs, while the audit block
    // runs only AFTER it returns. So the audit path and the tool are mutually
    // exclusive by construction. If a future change gives audit its own env var,
    // or moves the gate after dispatch, this test is what says so.
    const vault = await startFakeVault();
    const { dir, configPath } = writeConfig(vault.port);
    const rt = startRouter({ configPath, cwd: dir, env: { OBSIDIAN_ROUTER_USER_ID: 'roland' } });
    try {
      await handshake(rt);
      // It is hidden from ListTools…
      const listed = await rt.call(2, 'tools/list', {});
      const names = (listed.result?.tools || []).map((t) => t.name);
      assert.ok(names.includes('write_file'), 'the tool list is empty — the assertion below would be vacuous');
      assert.ok(!names.includes('provision_vault'), 'a gated deployment advertises provision_vault');
      // …and refused when called directly, before any handler runs.
      const res = await rt.call(3, 'tools/call', {
        name: 'provision_vault',
        arguments: { path: 'C:/anywhere\u2028else', vault: 'probe' },
      });
      assert.match(JSON.stringify(res), /disabled on this deployment/,
        'provision_vault was not refused on a gated deployment');
      assert.deepEqual(
        vault.seen.map((r) => `${r.method} ${r.url}`), [],
        'the refused tool still journalled — the two gates are no longer one condition',
      );
    } finally {
      rt.kill();
      await vault.close();
    }
  });

  test('a FAILED write is not journalled', async () => {
    // Documented behaviour ("we deliberately don't log failed writes"), and it
    // is what makes the journal readable as a record of what happened rather
    // than of what was attempted. Driven with an unknown tool name, which the
    // dispatcher refuses before any handler runs.
    const vault = await startFakeVault();
    const { dir, configPath } = writeConfig(vault.port);
    const rt = startRouter({ configPath, cwd: dir, env: { OBSIDIAN_ROUTER_USER_ID: 'roland' } });
    try {
      await handshake(rt);
      const res = await rt.call(2, 'tools/call', {
        name: 'write_file',
        arguments: { vault: 'probe', path: '../../commands/app:reload/', content: 'x' },
      });
      const text = JSON.stringify(res);
      assert.match(text, /segment|may not walk outside/, `the containment guard did not refuse: ${text}`);
      assert.deepEqual(
        vault.seen.map((r) => `${r.method} ${r.url}`), [],
        'a refused write reached the vault, or was journalled',
      );
    } finally {
      rt.kill();
      await vault.close();
    }
  });
});
