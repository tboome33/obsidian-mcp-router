/**
 * THE REPLAY INVARIANT — Phase 5 of `proposition-de-liaison-roadmap`, items 28
 * and 29.
 *
 * The decision `proposition-de-liaison-a-l-acces` says the refused call is
 * REPLAYED after the user says yes, and draws the consequence itself: a tool
 * that has already ACTED on one target before being refused on another would
 * have that first effect applied twice. So the invariant is
 *
 *     every target is resolved before the first effect.
 *
 * The audit behind these tests, stated so the next reader does not redo it:
 *
 *   - `move_file` and `write_bundle` resolve ONE vault, at the top, before any
 *     request leaves the process. Nothing to double.
 *   - `search` and `search_smart` with `vault: "*"` do NOT refuse an
 *     undeclared vault at all: they FILTER the candidate list by reachability,
 *     which is the right answer — a fan-out is a name for "every vault this
 *     workspace may name", not an escape from the rule and not a request for
 *     any particular one. So a fan-out never produces a binding proposal, and
 *     there is nothing to replay.
 *
 * Both of those are properties of today's code, which is exactly why they are
 * pinned here rather than left as a note: the first is what makes the replay
 * advice safe, and the second is what stops a fan-out from putting 23 proposals
 * in front of the user.
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
import { canOpenLocally } from '../src/helpers/binding-proposal.mjs';
import { homeSafeEnv } from './_home-safe-spawn.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(REPO, 'bin', 'obsidian-mcp-router.mjs');
const API_KEY = 'replay-safety-e2e-key';

const tmpDirs = [];
const servers = [];
after(() => {
  for (const s of servers) { try { s.close(); } catch { /* best effort */ } }
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

/** Records every request, so "no write landed" is a measurement and not a hope. */
async function startFakeVault() {
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
      if (req.method === 'PUT' || req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE') {
        res.writeHead(204).end();
        return;
      }
      if (url.startsWith('/search')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([]));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/markdown' });
      res.end('# hello');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { port: server.address().port, seen };
}

const MUTATING = new Set(['PUT', 'POST', 'PATCH', 'DELETE']);

function writeConfig(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-safety-e2e-'));
  tmpDirs.push(dir);
  const configPath = path.join(dir, 'config.json');
  const baseUrl = `http://127.0.0.1:${port}`;
  const remote = (name) => ({ name, baseUrl, apiKey: API_KEY, timeoutMs: 5000 });
  const key = canonicalWorkspaceKey(dir);
  fs.writeFileSync(configPath, JSON.stringify({
    portRegistry: {},
    vaultNames: {},
    remoteVaults: [remote('work'), remote('sci'), remote('other')],
    defaultVault: 'work',
    vaultReach: 'declared',
    openVaults: [],
    workspaceBindings: {
      [key]: { vault: 'work', also: [], locked: false, confirmedAt: '2026-09-16', confirmedVia: 'test' },
    },
  }, null, 2), 'utf8');
  return { dir, configPath, key };
}

function startRouter({ configPath, cwd }) {
  const child = spawn(process.execPath, [BIN, '--config', configPath], {
    cwd,
    env: homeSafeEnv(cwd, {
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
    clientInfo: { name: 'replay-safety-e2e', version: '0' },
  });
  rt.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

const textOf = (res) => (res.result?.content || []).map((c) => c.text || '').join('\n');

describe('E2E: the replay invariant', () => {
  test('TRAP 6 — a MULTI-FILE write to an undeclared vault is refused before a single byte leaves', async () => {
    // `write_bundle` is the tool with the most effects per call in the tree. If
    // any of them could land before the reachability refusal, the replay the
    // decision prescribes would apply that one twice.
    const vault = await startFakeVault();
    const { dir, configPath } = writeConfig(vault.port);
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const res = await rt.call(2, 'tools/call', {
        name: 'write_bundle',
        arguments: {
          vault: 'sci',
          files: [
            { path: 'wiki/one.md', content: '# one' },
            { path: 'wiki/two.md', content: '# two' },
          ],
        },
      });
      assert.equal(res.result?.isError, true, textOf(res));
      assert.match(textOf(res), /not reachable from this workspace/);
      assert.ok(res.result?._meta?.bindingProposal, 'the refusal carried no proposal');

      // THE MEASUREMENT, not the assumption: the fake vault recorded every
      // request it received, and none of them may mutate anything.
      const mutations = vault.seen.filter((r) => MUTATING.has(r.method));
      assert.deepEqual(
        mutations.map((r) => `${r.method} ${r.url}`), [],
        'a write landed before the refusal, so replaying the call would apply it twice',
      );
    } finally { rt.kill(); }
  });

  test('a FAN-OUT never refuses and never proposes — it narrows to what this workspace may name', async () => {
    // A fan-out is a name for "every vault this workspace may name", not a
    // request for any particular one. Refusing it would make `vault: "*"`
    // unusable the moment one vault is undeclared, and proposing from it would
    // put one proposal per undeclared vault in front of the user at once —
    // which is the solicitation trap 7 forbids, arriving by another door.
    const vault = await startFakeVault();
    const { dir, configPath } = writeConfig(vault.port);
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const res = await rt.call(2, 'tools/call', {
        name: 'search',
        arguments: { vault: '*', query: 'anything' },
      });
      assert.notEqual(res.result?.isError, true, textOf(res));
      const text = textOf(res);
      assert.ok(!text.includes('not reachable from this workspace'), text.slice(0, 300));
      assert.ok(!text.includes('BindingProposal:'), 'a fan-out proposed a binding');
      assert.equal(res.result?._meta?.bindingProposal, undefined);
      // And it really did narrow: the two undeclared vaults are absent.
      assert.ok(!/"sci"/.test(text) && !/"other"/.test(text), text.slice(0, 400));
    } finally { rt.kill(); }
  });
});

describe('canOpenLocally — one predicate, two readers', () => {
  test('a vault with a local folder can be opened; a remote one cannot', () => {
    assert.equal(canOpenLocally({ path: 'C:\\VAULTS\\x' }), true);
    assert.equal(canOpenLocally({ name: 'remote' }), false);
    assert.equal(canOpenLocally({ path: '' }), false);
    assert.equal(canOpenLocally(null), false);
    assert.equal(canOpenLocally(undefined), false);
  });

  test('the proposal and the opener read the SAME predicate, not two copies of it', () => {
    // ► MUTATION WITNESS: inline `Boolean(v.path)` back into either site and
    //   this scan goes red. The promise a proposal makes (`willOpen`) and the
    //   decision the opener takes are the same question; two spellings of it is
    //   how they come to disagree.
    const sites = ['src/registry.mjs', 'src/tools/workspace-binding.mjs'];
    for (const rel of sites) {
      const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
      assert.ok(
        src.includes('canOpenLocally'),
        `${rel} no longer reads the shared predicate`,
      );
      assert.ok(
        !/\bBoolean\(v\.path\)|\bv\.path \?/.test(src),
        `${rel} spells the openability test by hand again instead of calling canOpenLocally`,
      );
    }
  });
});
