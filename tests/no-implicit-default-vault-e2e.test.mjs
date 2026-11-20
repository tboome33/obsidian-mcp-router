/**
 * NO IMPLICIT DEFAULT VAULT, DRIVEN END TO END (v0.124.0).
 *
 * The bug: an unbound workspace (C:\Users\<me>, vaultReach "declared", eleven
 * openVaults, a config.json `defaultVault` naming a disabled vault) got DEDIBOX
 * as its default — origin "first-healthy" — although nobody had asked for a
 * vault there. A vault is now either bound, named by the host, the working
 * directory itself, or named in the call; anything else is refused, out loud.
 *
 * Like binding-accept-e2e, this spawns the real binary and speaks MCP over its
 * stdio: what matters is what a client actually receives from `get_file`.
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
const API_KEY = ['no-default', 'e2e'].join('-');

const tmpDirs = [];
const servers = [];
after(() => {
  for (const s of servers) { try { s.close(); } catch { /* best effort */ } }
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

async function startFakeVault() {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (decodeURIComponent(req.url) === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'OK' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/markdown' });
      res.end('# hello');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { port: server.address().port };
}

/**
 * Five healthy vaults, two of them open. `defaultVault` names a vault that
 * would have been the default before — present here on purpose, to prove it
 * decides nothing. `binding` null = the unbound case under test.
 */
function writeConfig(port, { binding = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-implicit-default-e2e-'));
  tmpDirs.push(dir);
  const configPath = path.join(dir, 'config.json');
  const baseUrl = `http://127.0.0.1:${port}`;
  const remote = (name) => ({ name, baseUrl, apiKey: API_KEY, timeoutMs: 5000 });
  const key = canonicalWorkspaceKey(dir);
  fs.writeFileSync(configPath, JSON.stringify({
    portRegistry: {},
    vaultNames: {},
    remoteVaults: [remote('dedibox'), remote('notes'), remote('work'), remote('roland'), remote('sci')],
    defaultVault: 'roland',
    disabledVaults: ['roland'],
    vaultReach: 'declared',
    openVaults: ['dedibox', 'notes'],
    ...(binding ? { workspaceBindings: { [key]: binding } } : {}),
  }, null, 2), 'utf8');
  return { dir, configPath, key };
}

function startRouter({ configPath, cwd }) {
  const child = spawn(process.execPath, [BIN, '--config', configPath], {
    cwd,
    env: homeSafeEnv(path.join(cwd, 'home'), {
      OBSIDIAN_ROUTER_NO_WATCH: '1',
      MD_ALLOWED_PATHS: cwd,
      OBSIDIAN_ROUTER_LOCKED: '',
      OBSIDIAN_ROUTER_DEFAULT_VAULT: '',
      VAULT_PATH: '',
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
  const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  const call = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${method}\n--- router stderr ---\n${stderr}`)),
      20000,
    );
    waiters.set(id, (m) => { clearTimeout(timer); resolve(m); });
    send({ jsonrpc: '2.0', id, method, params });
  });
  return { call, send, kill: () => child.kill() };
}

async function handshake(rt) {
  await rt.call(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'no-implicit-default-e2e', version: '0' },
  });
  rt.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

const textOf = (res) => (res.result?.content || []).map((c) => c.text || '').join('\n');
const getFile = (rt, id, vault) => rt.call(id, 'tools/call', {
  name: 'get_file',
  arguments: { ...(vault ? { vault } : {}), path: 'wiki/anything.md' },
});

describe('E2E: an unbound workspace has no default vault', () => {
  test('list_vaults: defaultVault null, origin "unset", openVaults listed, the config key reported obsolete', async () => {
    const vault = await startFakeVault();
    const { dir, configPath } = writeConfig(vault.port);
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const res = await rt.call(2, 'tools/call', { name: 'list_vaults', arguments: {} });
      assert.notEqual(res.result?.isError, true, textOf(res));
      const out = JSON.parse(textOf(res));
      assert.equal(out.workspaceBinding, null);
      assert.equal(out.defaultVault, null, 'an unbound session must not get a default vault');
      assert.deepEqual(out.defaultVaultSource, { origin: 'unset', variable: null });
      assert.equal(out.defaultVaultStatus, null);
      assert.equal(out.vaultReach, 'declared');
      assert.deepEqual(out.openVaults, ['dedibox', 'notes']);
      assert.ok(out.vaults.every((v) => v.isDefault !== true), 'no vault may be flagged as the default');
      assert.equal(out.obsoleteConfigKeys.length, 1);
      assert.equal(out.obsoleteConfigKeys[0].key, 'defaultVault');
      assert.equal(out.obsoleteConfigKeys[0].value, 'roland');
    } finally {
      rt.kill();
    }
  });

  test('get_file WITHOUT vault → an explicit refusal that lists the openVaults, never a silent pick', async () => {
    const vault = await startFakeVault();
    const { dir, configPath } = writeConfig(vault.port);
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const res = await getFile(rt, 2, null);
      const text = textOf(res);
      assert.equal(res.result?.isError, true, `a call naming no vault was served:\n${text}`);
      assert.match(text, /no primary vault/);
      assert.match(text, /reachable vaults: dedibox, notes/);
      assert.match(text, /confirm_workspace_binding/);
      assert.equal(res.result?._meta?.bindingProposal, undefined, 'no vault was named, so none is proposed');
    } finally {
      rt.kill();
    }
  });

  test('get_file WITH vault = an openVault → served', async () => {
    const vault = await startFakeVault();
    const { dir, configPath } = writeConfig(vault.port);
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const res = await getFile(rt, 2, 'notes');
      assert.notEqual(res.result?.isError, true, `an openVault named explicitly was refused:\n${textOf(res)}`);
      assert.match(textOf(res), /hello/);
    } finally {
      rt.kill();
    }
  });

  test('get_file WITH a vault outside openVaults → the existing refusal, with its bindingProposal', async () => {
    const vault = await startFakeVault();
    const { dir, configPath } = writeConfig(vault.port);
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const res = await getFile(rt, 2, 'work');
      assert.equal(res.result?.isError, true, textOf(res));
      assert.match(textOf(res), /not reachable from this workspace/);
      assert.ok(res.result?._meta?.bindingProposal, `no proposal:\n${textOf(res)}`);
    } finally {
      rt.kill();
    }
  });
});

describe('E2E: a bound workspace is unchanged (non-regression)', () => {
  test('the primary is the default, a secondary answers by name, defaultVaultSource says "binding"', async () => {
    const vault = await startFakeVault();
    const { dir, configPath } = writeConfig(vault.port, {
      binding: { vault: 'work', also: ['sci'], locked: false, confirmedAt: '2026-11-01', confirmedVia: 'test' },
    });
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const list = JSON.parse(textOf(await rt.call(2, 'tools/call', { name: 'list_vaults', arguments: {} })));
      assert.equal(list.defaultVault, 'work');
      assert.deepEqual(list.defaultVaultSource, { origin: 'binding', variable: null });

      const unnamed = await getFile(rt, 3, null);
      assert.notEqual(unnamed.result?.isError, true, `the bound primary was not the default:\n${textOf(unnamed)}`);
      const secondary = await getFile(rt, 4, 'sci');
      assert.notEqual(secondary.result?.isError, true, `a bound secondary was refused:\n${textOf(secondary)}`);
    } finally {
      rt.kill();
    }
  });

  test('a bound workspace whose primary is not loaded is told so — no fallback to another vault', async () => {
    const vault = await startFakeVault();
    const { dir, configPath } = writeConfig(vault.port, {
      binding: { vault: 'roland', also: ['sci'], locked: false, confirmedAt: '2026-11-01', confirmedVia: 'test' },
    });
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const res = await getFile(rt, 2, null);
      const text = textOf(res);
      assert.equal(res.result?.isError, true, `a disabled primary fell back to another vault:\n${text}`);
      assert.match(text, /primary vault "roland" is not loaded/);
    } finally {
      rt.kill();
    }
  });
});
