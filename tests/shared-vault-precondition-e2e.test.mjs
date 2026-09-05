/**
 * THE SHARED-VAULT PRECONDITION, DRIVEN END TO END.
 *
 * Phase 4 of `portee-ergonomie-refus-roadmap` (decision
 * `ergonomie-creation-liaison-vaults`, point 6). `tests/vault-sharing.test.mjs`
 * proves the pure pieces — who declares a vault, whether that makes it shared,
 * what a call brings, the refusal — and every one of those assertions stays
 * green if the `CallTool` dispatcher never calls any of them. This file is the
 * half that cannot: it spawns the real `bin/obsidian-mcp-router.mjs`, speaks
 * MCP over its stdio, and asks for real writes.
 *
 * The headline is item 19 of the roadmap, and it is why the router here runs
 * with `OBSIDIAN_ROUTER_NO_WATCH=1`: a vault must acquire the requirement AT
 * THE INSTANT a second workspace declares it, with no restart AND no config
 * hot-reload. The second workspace is another session in another directory —
 * its binding exists only in the config file — so a test that let the watcher
 * do the work would be proving the watcher, not the rule.
 *
 * The harness is the one `tests/audit-middleware-e2e.test.mjs` established and
 * `tests/also-tier-write-gate-e2e.test.mjs` reuses: a loopback stand-in for
 * the Local REST API, in-process, so the router's real request/response cycle
 * runs without a vault on disk.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { canonicalWorkspaceKey } from '../src/helpers/workspace-bindings.mjs';
import { homeSafeEnv } from './_home-safe-spawn.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(REPO, 'bin', 'obsidian-mcp-router.mjs');
const API_KEY = 'shared-vault-e2e-key';
const NOTE = 'wiki/notes/alpha.md';

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

const FILES = {
  'wiki-meta/catalog.md': '---\ntype: index\ntitle: "Wiki Catalog"\n---\n\n# Wiki Catalog\n',
  [NOTE]: '---\ntype: note\ntitle: "Alpha"\n---\n\nUn corps.\n',
};

async function startFakeVault(files) {
  const store = new Map(Object.entries(files));
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = decodeURIComponent(req.url);
      seen.push({ method: req.method, url, body });
      if (url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'OK' }));
        return;
      }
      // No `/vault-cas/` route here on purpose: this stand-in is an OLD
      // bridge, so an ifMatch write takes the GET-compare fallback — the tier
      // most installations are actually on.
      if (!url.startsWith('/vault/')) { res.writeHead(404).end('not found'); return; }
      const rel = url.replace(/^\/vault\//, '');
      if (req.method === 'PUT') { store.set(rel, body); res.writeHead(204).end(); return; }
      if (req.method === 'DELETE') { store.delete(rel); res.writeHead(204).end(); return; }
      if (rel.endsWith('/') || rel === '') {
        const names = new Set();
        for (const p of store.keys()) {
          if (!p.startsWith(rel)) continue;
          const rest = p.slice(rel.length);
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
  return { seen, store, port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

/** One workspace bound to `work`; `personal` exists and is optionally an openVault. */
function writeConfig(port, { openVaults = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-vault-e2e-'));
  tmpDirs.push(dir);
  const configPath = path.join(dir, 'config.json');
  const baseUrl = `http://127.0.0.1:${port}`;
  const remote = (name) => ({ name, baseUrl, apiKey: API_KEY, timeoutMs: 5000 });
  const key = canonicalWorkspaceKey(dir);
  const config = {
    portRegistry: {},
    vaultNames: {},
    remoteVaults: [remote('work'), remote('personal')],
    defaultVault: 'work',
    ...(openVaults.length ? { openVaults } : {}),
    workspaceBindings: {
      [key]: {
        vault: 'work', also: ['personal'], alsoWritable: ['personal'],
        locked: false, confirmedAt: '2026-09-05', confirmedVia: 'test',
      },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  return { dir, configPath, key };
}

/** What another session, in another directory, would write into the same config. */
function addSecondWorkspace(configPath, vaultName) {
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  cfg.workspaceBindings[canonicalWorkspaceKey(path.join(os.tmpdir(), 'some-other-project'))] = {
    vault: vaultName, also: [], locked: false, confirmedAt: '2026-09-05', confirmedVia: 'test',
  };
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
}

function startRouter({ configPath, cwd }) {
  const child = spawn(process.execPath, [BIN, '--config', configPath], {
    cwd,
    env: homeSafeEnv(cwd, {
      // NO WATCH: the freshness under test must come from the gate's own
      // re-read of the file, never from a hot-reload of the registry.
      OBSIDIAN_ROUTER_NO_WATCH: '1',
      MD_ALLOWED_PATHS: cwd,
      OBSIDIAN_ROUTER_LOCKED: '',
      OBSIDIAN_ROUTER_VIEW_AGENT_URL: '',
      OBSIDIAN_ROUTER_USER_ID: '',
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
  let nextId = 100;
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = nextId += 1;
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${method}\n--- router stderr ---\n${stderr}`)),
      20000,
    );
    waiters.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  return { child, call, stderrText: () => stderr, kill: () => child.kill() };
}

async function handshake(rt) {
  await rt.call('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'shared-vault-e2e', version: '0' },
  });
  rt.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
}

const textOf = (res) => res.result?.content?.[0]?.text ?? '';
const isRefusal = (res) => Boolean(res.error) || res.result?.isError === true;
const jsonOf = (res) => JSON.parse(textOf(res));
const putsTo = (vault, rel) => vault.seen.filter((r) => r.method === 'PUT' && r.url === `/vault/${rel}`);

async function withRouter(opts, body) {
  const vault = await startFakeVault(opts.files || FILES);
  const { dir, configPath } = writeConfig(vault.port, opts);
  const rt = startRouter({ configPath, cwd: dir });
  try {
    await handshake(rt);
    await body({ rt, vault, configPath, dir });
  } finally {
    rt.kill();
    await vault.close();
  }
}

describe('E2E: a vault only ONE workspace declares is unchanged', () => {
  test('a plain write with no precondition succeeds — the decision\'s own condition for the feature', async () => {
    await withRouter({}, async ({ rt, vault }) => {
      const res = await rt.call('tools/call', {
        name: 'write_file',
        arguments: { vault: 'work', path: NOTE, content: '# Rewritten\n' },
      });
      assert.ok(!isRefusal(res), `single-workspace write was refused: ${textOf(res)}\n${rt.stderrText()}`);
      assert.equal(putsTo(vault, NOTE).length, 1);
    });
  });
});

describe('E2E: the instant a SECOND workspace declares the vault (roadmap item 19)', () => {
  test('the very next write is refused — no restart, no hot-reload, no new session', async () => {
    await withRouter({}, async ({ rt, vault, configPath }) => {
      const before = await rt.call('tools/call', {
        name: 'write_file',
        arguments: { vault: 'work', path: NOTE, content: '# One\n' },
      });
      assert.ok(!isRefusal(before), `precondition: the first write must succeed — ${textOf(before)}`);
      const putsBefore = putsTo(vault, NOTE).length;

      // Another session, in another directory, binds itself to the same vault.
      addSecondWorkspace(configPath, 'work');

      const after = await rt.call('tools/call', {
        name: 'write_file',
        arguments: { vault: 'work', path: NOTE, content: '# Two\n' },
      });
      assert.ok(isRefusal(after), `expected a refusal once the vault became shared, got: ${textOf(after)}`);
      assert.match(textOf(after), /is SHARED/);
      assert.match(textOf(after), /2 workspaces declare it/);
      assert.equal(putsTo(vault, NOTE).length, putsBefore, 'the refused write must not have reached the vault');
    });
  });

  test('and the SAME call goes through once it carries the precondition read from get_file', async () => {
    await withRouter({}, async ({ rt, vault, configPath }) => {
      addSecondWorkspace(configPath, 'work');
      const read = await rt.call('tools/call', { name: 'get_file', arguments: { vault: 'work', path: NOTE } });
      const { contentSha256 } = jsonOf(read);
      assert.match(contentSha256, /^[0-9a-f]{64}$/);

      const res = await rt.call('tools/call', {
        name: 'write_file',
        arguments: { vault: 'work', path: NOTE, content: '# Guarded\n', ifMatch: contentSha256 },
      });
      assert.ok(!isRefusal(res), `guarded write refused: ${textOf(res)}\n${rt.stderrText()}`);
      assert.equal(putsTo(vault, NOTE).length, 1, 'the guarded write reached the vault');
      assert.equal(vault.store.get(NOTE), '# Guarded\n');
    });
  });

  test('creating a NEW note stays possible on a shared vault — ifNew is the precondition against absence', async () => {
    await withRouter({}, async ({ rt, vault, configPath }) => {
      addSecondWorkspace(configPath, 'work');
      const res = await rt.call('tools/call', {
        name: 'write_file',
        arguments: { vault: 'work', path: 'wiki/notes/brand-new.md', content: '# New\n', ifNew: true },
      });
      assert.ok(!isRefusal(res), `ifNew write refused: ${textOf(res)}\n${rt.stderrText()}`);
      assert.equal(putsTo(vault, 'wiki/notes/brand-new.md').length, 1);
    });
  });

  test('a PREVIEW is never refused: it writes nothing, so it has nothing to guard', async () => {
    await withRouter({}, async ({ rt, configPath }) => {
      addSecondWorkspace(configPath, 'work');
      const res = await rt.call('tools/call', {
        name: 'delete_file',
        arguments: { vault: 'work', path: NOTE, preview: true },
      });
      assert.ok(!isRefusal(res), `a preview must not be refused: ${textOf(res)}`);
    });
  });

  test('a SECOND workspace on a DIFFERENT vault leaves this one alone — the count is per vault', async () => {
    await withRouter({}, async ({ rt, configPath }) => {
      addSecondWorkspace(configPath, 'personal');
      const res = await rt.call('tools/call', {
        name: 'write_file',
        arguments: { vault: 'work', path: NOTE, content: '# Still fine\n' },
      });
      assert.ok(!isRefusal(res), `an unrelated second binding must not gate this vault: ${textOf(res)}`);
    });
  });
});

describe('E2E: an openVaults vault is shared by hypothesis', () => {
  test('a write to it is refused without a precondition, with ONE workspace and no second binding', async () => {
    await withRouter({ openVaults: ['personal'] }, async ({ rt, vault }) => {
      const res = await rt.call('tools/call', {
        name: 'write_file',
        arguments: { vault: 'personal', path: NOTE, content: '# Nope\n' },
      });
      assert.ok(isRefusal(res), `expected a refusal for an openVaults vault, got: ${textOf(res)}`);
      assert.match(textOf(res), /openVaults/);
      assert.equal(putsTo(vault, NOTE).length, 0);
    });
  });
});

describe('E2E: the two blockers of the Fable 5.1 round, closed at the real dispatcher', () => {
  test('ifNew on a file that EXISTS is refused by the ROUTER — the server never honoured the header', async () => {
    // Before this round `ifNew: true` was a plain overwriting PUT on every real
    // installation (Local REST API reads no such header), and the gate let it
    // through a shared vault as a "compare-and-swap against absence".
    await withRouter({}, async ({ rt, vault, configPath }) => {
      addSecondWorkspace(configPath, 'work');
      const res = await rt.call('tools/call', {
        name: 'write_file',
        arguments: { vault: 'work', path: NOTE, content: '# Clobber\n', ifNew: true },
      });
      assert.ok(isRefusal(res), `expected a refusal, got: ${textOf(res)}`);
      assert.match(textOf(res), /already exists/);
      assert.equal(putsTo(vault, NOTE).length, 0, 'nothing reached the vault');
      assert.equal(vault.store.get(NOTE), FILES[NOTE], 'the existing note is byte-identical');
    });
  });

  test('a recovery run with preview:true no longer slips past both gates', async () => {
    // The dispatcher exempted write_bundle on `preview` before looking at
    // `recover`; the handler routes on `recover` first and its recovery path
    // never reads `preview` — so one stray flag REPLAYED THE JOURNAL with both
    // gates, the audit line and the projections refresh skipped. Seeded with a
    // journal whose replay would PUT the note, so a reopened bypass shows up as
    // a landed write, not merely a different message.
    const OP = 'op-0123456789abcdef';
    const journal = {
      version: 1, operationId: OP, vault: 'work', startedAt: '2026-09-05T10:00:00.000Z', state: 'pending',
      steps: [{ index: 0, op: 'write', path: NOTE }],
      backups: { [NOTE]: { existed: true, content: '# ORIGINAL\n', contentSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' } },
    };
    const files = { ...FILES, [`wiki-meta/write-journal/${OP}.json`]: `${JSON.stringify(journal, null, 2)}\n` };
    await withRouter({ files }, async ({ rt, vault, configPath }) => {
      addSecondWorkspace(configPath, 'work');
      const res = await rt.call('tools/call', {
        name: 'write_bundle',
        arguments: { vault: 'work', recover: OP, confirm: true, preview: true },
      });
      assert.ok(isRefusal(res), `expected a refusal, got: ${textOf(res)}`);
      assert.match(textOf(res), /is SHARED.*`expect`/s, 'refused by the shared-vault gate, for the missing expect');
      assert.equal(putsTo(vault, NOTE).length, 0, 'the journal was NOT replayed');
      assert.equal(vault.store.get(NOTE), FILES[NOTE]);
    });
  });
});

describe('E2E: openVaults added to the FILE takes effect at once (Codex round on 23bbbaa)', () => {
  test('a vault added to openVaults while the router runs is refused on the next write, watcher off', async () => {
    // The first version read `openVaults` from the in-memory registry only, so
    // a vault the user had just opened to every workspace kept accepting blind
    // writes until a hot-reload — which never comes under --no-watch. Both
    // views count now, and this proves the file half.
    await withRouter({}, async ({ rt, vault, configPath }) => {
      const before = await rt.call('tools/call', {
        name: 'write_file',
        arguments: { vault: 'personal', path: NOTE, content: '# One\n' },
      });
      assert.ok(!isRefusal(before), `precondition: the first write must succeed — ${textOf(before)}`);
      const puts = putsTo(vault, NOTE).length;

      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      cfg.openVaults = ['personal'];
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');

      const after = await rt.call('tools/call', {
        name: 'write_file',
        arguments: { vault: 'personal', path: NOTE, content: '# Two\n' },
      });
      assert.ok(isRefusal(after), `expected a refusal once the vault was opened, got: ${textOf(after)}`);
      assert.match(textOf(after), /openVaults/);
      assert.equal(putsTo(vault, NOTE).length, puts, 'the refused write must not have reached the vault');
    });
  });
});

describe('E2E: list_vaults says which vaults demand it, BEFORE a write is refused', () => {
  test('the flag flips for the vault a second workspace just declared, and only for it', async () => {
    await withRouter({}, async ({ rt, configPath }) => {
      const first = jsonOf(await rt.call('tools/call', { name: 'list_vaults', arguments: {} }));
      const flag = (r, name) => r.vaults.find((v) => v.name === name);
      assert.equal(flag(first, 'work').writesRequireIfMatch, false);
      assert.equal(flag(first, 'work').sharingReason, null);

      addSecondWorkspace(configPath, 'work');

      const second = jsonOf(await rt.call('tools/call', { name: 'list_vaults', arguments: {} }));
      assert.equal(flag(second, 'work').writesRequireIfMatch, true);
      assert.equal(flag(second, 'work').sharingReason, 'multi-workspace');
      assert.equal(flag(second, 'personal').writesRequireIfMatch, false, 'the other vault is untouched');
    });
  });
});
