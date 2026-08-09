/**
 * THE FIRST-CONTACT REPAIR, DRIVEN END TO END.
 *
 * The repair lives inside `src/index.mjs`'s `CallToolRequestSchema` handler, and
 * that handler only runs when a real `tools/call` arrives over a transport.
 * `tests/vault-conformance.test.mjs` proves the gate and the two repair cores in
 * isolation — all of which stay green if the dispatcher never calls them. This
 * file is the other half: it spawns the actual `bin/obsidian-mcp-router.mjs`,
 * speaks MCP over its stdio, and asserts on what a loopback stand-in for the
 * Local REST API RECEIVED.
 *
 * The harness is the one `tests/audit-middleware-e2e.test.mjs` established, for
 * the reason its header records: a "wire-up sanity" test that greps the source
 * left `if (false)` around the middleware fully green.
 *
 * Nothing here reads the router's source, and nothing touches a real vault.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { SEARCH_INDEX_PATH, indexProblem } from '../src/helpers/bm25-index.mjs';
import { homeSafeEnv } from './_home-safe-spawn.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(REPO, 'bin', 'obsidian-mcp-router.mjs');
const API_KEY = 'conformance-e2e-key';

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

/**
 * A loopback stand-in for the Local REST API backed by an in-memory store, so
 * the router's enumerate → read → write cycle actually completes. It records
 * every request; the assertions are on that record.
 */
async function startFakeVault(files, { pingFails = false } = {}) {
  const store = new Map(Object.entries(files));
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = decodeURIComponent(req.url);
      seen.push({ method: req.method, url, body });

      // `pingFails`: the health probe answers 503 while the vault endpoints stay
      // fully functional. That is what makes the "offline default vault" test
      // meaningful — a closed socket would make every request fail, so the
      // absence of a repair would prove nothing.
      if (pingFails && url === '/') { res.writeHead(503).end('unavailable'); return; }

      const rel = url.replace(/^\/vault\//, '');
      if (req.method === 'PUT') {
        store.set(rel, body);
        res.writeHead(204).end();
        return;
      }
      if (req.method === 'DELETE') {
        store.delete(rel);
        res.writeHead(204).end();
        return;
      }
      if (url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'OK' }));
        return;
      }
      if (rel.endsWith('/') || rel === '') {
        // Directory listing: immediate children, directories suffixed with '/'.
        const prefix = rel;
        const names = new Set();
        for (const p of store.keys()) {
          if (!p.startsWith(prefix)) continue;
          const rest = p.slice(prefix.length);
          const slash = rest.indexOf('/');
          names.add(slash === -1 ? rest : `${rest.slice(0, slash)}/`);
        }
        if (names.size === 0) { res.writeHead(404).end('not found'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ files: [...names].sort() }));
        return;
      }
      if (!store.has(rel)) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/markdown' });
      res.end(store.get(rel));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    seen,
    store,
    port: server.address().port,
    close: () => new Promise((r) => server.close(r)),
  };
}

function writeConfig(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conformance-e2e-'));
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

function startRouter({ configPath, cwd, env = {} }) {
  // HOME redirected to the per-test temp dir like every other test child — the
  // router bin does not write ~/.claude today, but rebuilding the env by hand is
  // exactly how D1 slipped in, so this env goes through the one guarded builder.
  const child = spawn(process.execPath, [BIN, '--config', configPath], {
    cwd,
    env: homeSafeEnv(cwd, {
      OBSIDIAN_ROUTER_NO_WATCH: '1',
      MD_ALLOWED_PATHS: cwd,
      OBSIDIAN_ROUTER_LOCKED: '',
      OBSIDIAN_ROUTER_VIEW_AGENT_URL: '',
      OBSIDIAN_ROUTER_USER_ID: '',
      ...env,
    }),
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
    clientInfo: { name: 'conformance-e2e', version: '0' },
  });
  rt.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

/** The repair is fire-and-forget, so wait for its effect rather than for the call. */
async function waitForIndexWrite(vault, { timeoutMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (vault.seen.some((r) => r.method === 'PUT' && r.url === `/vault/${SEARCH_INDEX_PATH}`)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/** A drifted vault: the scaffold, content pages, marked projections, no index. */
const DRIFTED = {
  'wiki-meta/catalog.md': '---\ntype: index\ntitle: "Wiki Catalog"\n---\n\n# Wiki Catalog\n',
  'wiki/index.md':
    "---\nokf_version: '0.1'\n---\n\n# probe\n\n> Generated by obsidian-mcp-router — index de navigation généré.\n\n# Subdirectories\n\n* [notes](notes/index.md) - Contains 1 document\n",
  'wiki/log.md':
    '# Update Log\n\n> Generated by obsidian-mcp-router — index de navigation généré.\n\n## 2026-07-01\n\n* **Created**: [Alpha](notes/alpha.md)\n',
  'wiki/notes/index.md':
    '# Note\n\n> Generated by obsidian-mcp-router — index de navigation généré.\n\n* [Alpha](alpha.md) - Desc Alpha\n',
  'wiki/notes/alpha.md':
    '---\ntype: note\ntitle: "Alpha"\ndescription: "Desc Alpha"\ncreated: 2026-07-01\n---\n\nUn corps avec des mots discriminants: hydrolienne, marmotte.\n',
};

describe('E2E: first contact really does repair, and really is gated', () => {
  test('a read-only tool call triggers the search-index rebuild for that vault', async () => {
    const vault = await startFakeVault(DRIFTED);
    const { dir, configPath } = writeConfig(vault.port);
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const res = await rt.call(2, 'tools/call', {
        name: 'get_file',
        arguments: { vault: 'probe', path: 'wiki/notes/alpha.md' },
      });
      assert.ok(!res.error, `the read itself failed: ${JSON.stringify(res.error)}\n${rt.stderrText()}`);

      // THE ASSERTION THIS FILE EXISTS FOR. `if (conformanceGate)` turned off in
      // the dispatcher makes exactly this line red.
      assert.ok(
        await waitForIndexWrite(vault),
        'first contact never wrote the search index: '
          + `${JSON.stringify(vault.seen.map((r) => `${r.method} ${r.url}`))}\n${rt.stderrText()}`,
      );

      // And what it wrote is a real index of the real corpus, not a placeholder.
      const written = JSON.parse(vault.store.get(SEARCH_INDEX_PATH));
      assert.equal(indexProblem(written), null, 'the index the router wrote must be usable');
      assert.ok(
        written.chunks.some((c) => c.path === 'wiki/notes/alpha.md'),
        'the index must cover the vault’s content page',
      );
      assert.ok(
        written.chunks.every((c) => c.path !== 'wiki/notes/index.md'),
        'generated projections must not be indexed',
      );
    } finally {
      rt.kill();
      await vault.close();
    }
  });

  test('the SECOND call on the same vault does not repair again', async () => {
    const vault = await startFakeVault(DRIFTED);
    const { dir, configPath } = writeConfig(vault.port);
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      await rt.call(2, 'tools/call', { name: 'get_file', arguments: { vault: 'probe', path: 'wiki/notes/alpha.md' } });
      assert.ok(await waitForIndexWrite(vault), 'the first contact did not repair');

      const putsAfterFirst = vault.seen.filter((r) => r.method === 'PUT').length;
      await rt.call(3, 'tools/call', { name: 'get_file', arguments: { vault: 'probe', path: 'wiki/notes/alpha.md' } });
      await new Promise((r) => setTimeout(r, 500));

      assert.equal(
        vault.seen.filter((r) => r.method === 'PUT').length,
        putsAfterFirst,
        'the session debounce failed — a second contact re-ran the repair',
      );
    } finally {
      rt.kill();
      await vault.close();
    }
  });

  test('OBSIDIAN_ROUTER_NO_AUTO_CONFORMANCE=1 turns the whole moment off', async () => {
    // THE OTHER HALF OF THE CLAIM. A pin that only proves the repair happens is
    // satisfied by a router with no off switch at all.
    const vault = await startFakeVault(DRIFTED);
    const { dir, configPath } = writeConfig(vault.port);
    const rt = startRouter({ configPath, cwd: dir, env: { OBSIDIAN_ROUTER_NO_AUTO_CONFORMANCE: '1' } });
    try {
      await handshake(rt);
      const res = await rt.call(2, 'tools/call', {
        name: 'get_file',
        arguments: { vault: 'probe', path: 'wiki/notes/alpha.md' },
      });
      assert.ok(!res.error, `the read itself failed: ${JSON.stringify(res.error)}`);
      await new Promise((r) => setTimeout(r, 800));
      assert.deepEqual(
        vault.seen.filter((r) => r.method === 'PUT').map((r) => r.url), [],
        'the opt-out was ignored — the router repaired anyway',
      );
    } finally {
      rt.kill();
      await vault.close();
    }
  });

  test('a read-only deployment never repairs (repairing is writing)', async () => {
    const vault = await startFakeVault(DRIFTED);
    const { dir, configPath } = writeConfig(vault.port);
    const rt = startRouter({ configPath, cwd: dir, env: { OBSIDIAN_ROUTER_READONLY: 'true' } });
    try {
      await handshake(rt);
      const res = await rt.call(2, 'tools/call', {
        name: 'get_file',
        arguments: { vault: 'probe', path: 'wiki/notes/alpha.md' },
      });
      assert.ok(!res.error, `the read itself failed: ${JSON.stringify(res.error)}`);
      await new Promise((r) => setTimeout(r, 800));
      assert.deepEqual(
        vault.seen.filter((r) => r.method === 'PUT' || r.method === 'DELETE').map((r) => r.url), [],
        'a read-only router wrote to the vault behind the user’s back',
      );
    } finally {
      rt.kill();
      await vault.close();
    }
  });

  test('list_vaults — the session health check — repairs the DEFAULT vault when its ping says online', async () => {
    const vault = await startFakeVault(DRIFTED);
    const { dir, configPath } = writeConfig(vault.port);
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const res = await rt.call(2, 'tools/call', { name: 'list_vaults', arguments: {} });
      assert.ok(!res.error, `list_vaults failed: ${JSON.stringify(res.error)}`);
      assert.ok(
        await waitForIndexWrite(vault),
        'the session health check did not reach the default vault: '
          + `${JSON.stringify(vault.seen.map((r) => `${r.method} ${r.url}`))}\n${rt.stderrText()}`,
      );
    } finally {
      rt.kill();
      await vault.close();
    }
  });

  test('list_vaults on an OFFLINE default vault does not launch a repair at it', async () => {
    // The ping in the very same response says the vault did not answer. Firing a
    // full enumerate → read → write cycle at it buys nothing but a guaranteed
    // failed pass — and spends one of the session's bounded retry attempts.
    // The vault ANSWERS — only its health probe fails. So a repair launched at
    // it would leave a visible trail; the absence of one is real evidence.
    const vault = await startFakeVault(DRIFTED, { pingFails: true });
    const { dir, configPath } = writeConfig(vault.port);
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const res = await rt.call(2, 'tools/call', { name: 'list_vaults', arguments: {} });
      assert.ok(!res.error, `list_vaults failed: ${JSON.stringify(res.error)}`);
      const parsed = JSON.parse(res.result.content[0].text);
      assert.equal(parsed.defaultVaultStatus.online, false, 'fixture sanity: the vault must read offline');
      await new Promise((r) => setTimeout(r, 800));
      assert.deepEqual(
        vault.seen.filter((r) => r.url.startsWith('/vault/')).map((r) => `${r.method} ${r.url}`), [],
        'a repair was launched at a vault the router had just measured as offline',
      );
    } finally {
      rt.kill();
      await vault.close();
    }
  });
});

describe('E2E: which tool calls count as contact', () => {
  test('a FAILING call still triggers the repair (the founding incident)', async () => {
    // The class of bug: a call that FAILS is often the very call that proves the
    // vault needs repairing. If only successes triggered contact, the failure
    // would repeat identically for the whole session.
    //
    // `get_file` on a missing path is used rather than `search_smart` ON
    // PURPOSE: `search_smart` repairs BEFORE its handler runs (it is the one
    // blocking tool), so it would go green whether or not the failure path is
    // wired — it cannot test this branch. A non-blocking tool that 404s can.
    const vault = await startFakeVault(DRIFTED);
    const { dir, configPath } = writeConfig(vault.port);
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const res = await rt.call(2, 'tools/call', {
        name: 'get_file',
        arguments: { vault: 'probe', path: 'wiki/notes/does-not-exist.md' },
      });
      const text = res.result?.content?.[0]?.text ?? '';
      assert.ok(res.result?.isError || /Error:/.test(text), `fixture sanity: the call must FAIL — got ${text.slice(0, 200)}`);

      assert.ok(
        await waitForIndexWrite(vault),
        `no repair after a failing call: ${JSON.stringify(vault.seen.map((r) => `${r.method} ${r.url}`))}\n${rt.stderrText()}`,
      );
    } finally {
      rt.kill();
      await vault.close();
    }
  });

  test('the first search_smart of a session WAITS for the repair, and finds the content', async () => {
    // The blocking branch. Without it the session's first semantic search fails
    // on a drifted vault, which is the symptom the whole feature exists to
    // remove.
    const vault = await startFakeVault(DRIFTED);
    const { dir, configPath } = writeConfig(vault.port);
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const res = await rt.call(2, 'tools/call', {
        name: 'search_smart',
        arguments: { vault: 'probe', query: 'hydrolienne', tier: 'local' },
      });
      assert.ok(!res.error, `the first search_smart failed: ${JSON.stringify(res.error)}\n${rt.stderrText()}`);
      const parsed = JSON.parse(res.result.content[0].text);
      assert.equal(parsed.isError, undefined);
      assert.ok(
        JSON.stringify(parsed).includes('alpha.md'),
        `the first search of the session did not find the vault's content: ${JSON.stringify(parsed).slice(0, 400)}`,
      );
      // The index was written BEFORE the search answered, not after.
      assert.ok(vault.seen.some((r) => r.method === 'PUT' && r.url === `/vault/${SEARCH_INDEX_PATH}`));
    } finally {
      rt.kill();
      await vault.close();
    }
  });

  test('build_search_index check:true writes NOTHING — its contract says so', async () => {
    // The tool description users read promises a report "WITHOUT writing".
    // Triggering a repair alongside it would make that sentence false.
    const vault = await startFakeVault(DRIFTED);
    const { dir, configPath } = writeConfig(vault.port);
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const res = await rt.call(2, 'tools/call', {
        name: 'build_search_index',
        arguments: { vault: 'probe', check: true },
      });
      assert.ok(!res.error, `check failed: ${JSON.stringify(res.error)}`);
      await new Promise((r) => setTimeout(r, 800));
      assert.deepEqual(
        vault.seen.filter((r) => r.method === 'PUT' || r.method === 'DELETE').map((r) => r.url), [],
        'a check:true call caused a write',
      );
    } finally {
      rt.kill();
      await vault.close();
    }
  });

  test('refresh_okf_projections check:true writes NOTHING either', async () => {
    const vault = await startFakeVault(DRIFTED);
    const { dir, configPath } = writeConfig(vault.port);
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const res = await rt.call(2, 'tools/call', {
        name: 'refresh_okf_projections',
        arguments: { vault: 'probe', check: true },
      });
      assert.ok(!res.error, `check failed: ${JSON.stringify(res.error)}`);
      await new Promise((r) => setTimeout(r, 800));
      assert.deepEqual(
        vault.seen.filter((r) => r.method === 'PUT' || r.method === 'DELETE').map((r) => r.url), [],
        'a check:true call caused a write',
      );
    } finally {
      rt.kill();
      await vault.close();
    }
  });

  test('a converter that names no vault does not maintain the DEFAULT one', async () => {
    const vault = await startFakeVault(DRIFTED);
    const { dir, configPath } = writeConfig(vault.port);
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      // Deliberately a call that FAILS (no such file): the failure path triggers
      // contact too, so this also pins that the exemption holds on both paths.
      await rt.call(2, 'tools/call', {
        name: 'pdf_to_markdown',
        arguments: { filePath: path.join(dir, 'does-not-exist.pdf') },
      });
      await new Promise((r) => setTimeout(r, 800));
      assert.deepEqual(
        vault.seen.filter((r) => r.method === 'PUT').map((r) => r.url), [],
        'converting an unrelated file maintained the default vault',
      );
    } finally {
      rt.kill();
      await vault.close();
    }
  });
});
