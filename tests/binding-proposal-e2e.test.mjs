/**
 * THE BINDING PROPOSAL, DRIVEN END TO END — trap 4 of the decision.
 *
 * Decision `proposition-de-liaison-a-l-acces` (accepted 2026-09-15), Phase 2
 * of its roadmap, items 9 and 10. `tests/binding-proposal.test.mjs` proves the
 * helpers as pure functions and stays green even if the object never reaches a
 * client. THIS file is the other half, and it is the half the decision calls
 * the likeliest way the lot fails:
 *
 *   "Un objet posé dans une exception et perdu à la conversion est le défaut
 *    le plus probable de ce lot."
 *
 * So nothing here calls `resolveVault()` or the renderer directly. It spawns
 * the real `bin/obsidian-mcp-router.mjs`, speaks MCP over its stdio, calls a
 * real tool by name, and reads the reply the way a real client would — the
 * text first, because the text is this channel's authoritative half, and
 * `_meta` second.
 *
 * The harness is the one `tests/audit-middleware-e2e.test.mjs` established and
 * `tests/also-tier-write-gate-e2e.test.mjs` reuses.
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
import { buildBindingProposal, PROPOSAL_ID_PREFIX } from '../src/helpers/binding-proposal.mjs';
import { homeSafeEnv } from './_home-safe-spawn.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(REPO, 'bin', 'obsidian-mcp-router.mjs');
const API_KEY = 'binding-proposal-e2e-key';

const tmpDirs = [];
const servers = [];
after(() => {
  for (const s of servers) { try { s.close(); } catch { /* best effort */ } }
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

/** Minimal loopback stand-in: enough to be a healthy vault, never actually reached here. */
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
 * A workspace bound to `work` with two secondaries, plus `sci` — registered,
 * healthy, and declared by nobody. `vaultReach: "declared"` with an empty
 * `openVaults` is the configuration Roland actually runs.
 */
function writeConfig(port, { refuseSci = false, primary = 'work' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binding-proposal-e2e-'));
  tmpDirs.push(dir);
  const configPath = path.join(dir, 'config.json');
  const baseUrl = `http://127.0.0.1:${port}`;
  const remote = (name) => ({ name, baseUrl, apiKey: API_KEY, timeoutMs: 5000 });
  const key = canonicalWorkspaceKey(dir);
  const binding = {
    vault: primary,
    also: ['writable-ref', 'locked-ref'],
    locked: false,
    alsoWritable: ['writable-ref'],
    alsoLocked: ['locked-ref'],
    confirmedAt: '2026-09-16',
    confirmedVia: 'test',
  };
  fs.writeFileSync(configPath, JSON.stringify({
    portRegistry: {},
    vaultNames: {},
    remoteVaults: [remote('work'), remote('writable-ref'), remote('locked-ref'), remote('sci')],
    defaultVault: 'work',
    vaultReach: 'declared',
    openVaults: [],
    workspaceBindings: { [key]: binding },
    ...(refuseSci ? { workspaceRefusals: { [key]: { sci: '2026-09-16' } } } : {}),
  }, null, 2), 'utf8');
  return { dir, configPath, key, binding };
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
    clientInfo: { name: 'binding-proposal-e2e', version: '0' },
  });
  rt.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

const textOf = (res) => (res.result?.content || []).map((c) => c.text || '').join('\n');

describe('E2E: a refusal reaches the client CARRYING its proposal', () => {
  test('naming an undeclared vault through a real tool returns the proposal, in the text AND in _meta', async () => {
    const vault = await startFakeVault();
    const { dir, configPath, key, binding } = writeConfig(vault.port);
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const res = await rt.call(2, 'tools/call', {
        name: 'get_file',
        arguments: { vault: 'sci', path: 'wiki/anything.md' },
      });

      assert.equal(res.result?.isError, true, 'the call was not refused at all');
      const text = textOf(res);

      // THE TEXT IS THE AUTHORITATIVE HALF. A client that drops `_meta` must
      // still be able to act, so everything needed is asserted here first.
      assert.match(text, /not reachable from this workspace/);
      assert.match(text, /BindingProposal: this workspace does not declare vault sci/);
      assert.match(text, /Proposed role: secondary \(the primary stays work\)/);
      assert.match(text, /NO write/);
      assert.match(text, /Ask the user before calling either/);

      // The id is DERIVED, so the test can recompute what it must be rather
      // than accepting whatever came back. Recomputed from the same binding the
      // config declares — if the two ever disagree, an accept could never match.
      const expected = buildBindingProposal({ vault: 'sci', binding, workspaceKey: key });
      assert.match(text, new RegExp(`confirm_workspace_binding\\(\\{ accept: "${expected.proposalId}" \\}\\)`));
      assert.match(text, /confirm_workspace_binding\(\{ refuse: "sci" \}\)/);

      // ...and `_meta` mirrors the same object for a client that can read it.
      const meta = res.result?._meta?.bindingProposal;
      assert.ok(meta, 'the structured mirror is missing from _meta');
      assert.equal(meta.proposalId, expected.proposalId);
      assert.equal(meta.proposedRole, 'secondary');
      assert.equal(meta.currentPrimary, 'work');
      assert.equal(meta.bindingDigest, expected.bindingDigest);
      assert.deepEqual(meta.accept.args, { accept: expected.proposalId });
      assert.deepEqual(Object.keys(meta.accept.args), ['accept']);

      // The classification survives: a refusal to name is a permission verdict
      // and repeating the call cannot help.
      assert.equal(res.result?._meta?.errorCategory, 'permission');
      assert.equal(res.result?._meta?.isRetryable, false);
      assert.equal(res.result?._meta?.kind, 'workspace_declaration_required');

      // AND IT DOES NOT PROMISE A WINDOW IT CANNOT OPEN. Every vault here is a
      // REMOTE entry, so it has no local folder and the opener skips it — a
      // proposal saying "accepting also opens the vault in Obsidian" would be
      // announcing something the accept path cannot do. (Codex.)
      assert.equal(meta.willOpen, false, 'a remote vault was promised an Obsidian window');
      assert.ok(!/also opens the vault in Obsidian/.test(text), text);
    } finally { rt.kill(); }
  });

  test('a binding whose PRIMARY this machine does not have is one to repair, and gets no proposal', async () => {
    // `proposedRoleFor` answers "secondary" for such a binding, so the prose
    // would have read "the primary stays <a vault that does not exist>" — an
    // offer to extend a binding that cannot resolve. (Codex.) The full
    // diagnostic is Phase 6; refusing to guess is what ships until then.
    const vault = await startFakeVault();
    const { dir, configPath } = writeConfig(vault.port, { primary: 'gone-from-this-machine' });
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const res = await rt.call(2, 'tools/call', {
        name: 'get_file',
        arguments: { vault: 'sci', path: 'wiki/anything.md' },
      });
      assert.equal(res.result?.isError, true);
      const text = textOf(res);
      assert.ok(!text.includes('BindingProposal:'), `a broken binding was offered an extension:\n${text}`);
      assert.equal(res.result?._meta?.bindingProposal, undefined);
      assert.match(text, /needs repairing/);
      assert.match(text, /gone-from-this-machine/);
    } finally { rt.kill(); }
  });

  test('the id the client is handed matches what the server will recompute at the yes', async () => {
    // Not a restatement of the test above: it pins that the id is a function of
    // the CURRENT binding, by proving a DIFFERENT binding yields a different
    // id. Without this, a constant would pass the assertion above forever.
    const vault = await startFakeVault();
    const { dir, configPath, key, binding } = writeConfig(vault.port);
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const res = await rt.call(2, 'tools/call', {
        name: 'get_file',
        arguments: { vault: 'sci', path: 'wiki/anything.md' },
      });
      const got = res.result?._meta?.bindingProposal?.proposalId;
      assert.ok(got.startsWith(PROPOSAL_ID_PREFIX));
      const moved = buildBindingProposal({
        vault: 'sci',
        binding: { ...binding, alsoWritable: ['writable-ref', 'locked-ref'], alsoLocked: [] },
        workspaceKey: key,
      });
      assert.notEqual(got, moved.proposalId, 'a tier change did not move the id');
    } finally { rt.kill(); }
  });

  test('a vault the user already REFUSED is still refused, with NO proposal anywhere', async () => {
    // Decision refus-d-une-proposition-de-liaison: a vault the user turned down
    // is not put back in front of them, and a tool call the MODEL decided to
    // make is not "the user bringing it up again".
    //
    // ► MUTATION WITNESS: drop the `workspaceRefusals` check in resolveVault()
    //   and only this test goes red — the two above keep passing, because a
    //   workspace with no refusals is unaffected.
    const vault = await startFakeVault();
    const { dir, configPath } = writeConfig(vault.port, { refuseSci: true });
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const res = await rt.call(2, 'tools/call', {
        name: 'get_file',
        arguments: { vault: 'sci', path: 'wiki/anything.md' },
      });
      assert.equal(res.result?.isError, true);
      const text = textOf(res);
      assert.match(text, /not reachable from this workspace/);
      assert.ok(!text.includes('BindingProposal:'), 'a refused vault was proposed again in the text');
      assert.ok(!text.includes('confirm_workspace_binding({ accept:'), 'a refused vault was handed an accept call');
      assert.equal(res.result?._meta?.bindingProposal, undefined, 'a refused vault was proposed again in _meta');
      // AND THE PROSE MUST FALL SILENT TOO. Dropping the object while the text
      // still said "bind this workspace to it with confirm_workspace_binding"
      // left the invitation standing in the channel this lot calls
      // authoritative — the object was silent and the guard was not. (Codex.)
      assert.ok(
        !/[Bb]ind this workspace to it/.test(text),
        `the text still invites the binding of a refused vault:\n${text}`,
      );
      assert.match(text, /already REFUSED/);
      assert.match(text, /retract/);
    } finally { rt.kill(); }
  });

  test('a DECLARED vault is not refused at all — the gate did not become a wall', async () => {
    const vault = await startFakeVault();
    const { dir, configPath } = writeConfig(vault.port);
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const res = await rt.call(2, 'tools/call', {
        name: 'get_file',
        arguments: { vault: 'work', path: 'wiki/anything.md' },
      });
      const text = textOf(res);
      // THE CALL MUST HAVE SUCCEEDED, not merely avoided two phrases. Asserting
      // the absence of fragments passes just as well on a validation error, an
      // auth failure, or a JSON-RPC reply with no result at all — a green for
      // the wrong reason. So: no error flag, and the fake vault's own content
      // came back. (Codex.)
      assert.notEqual(res.result?.isError, true, `the call failed instead of succeeding:\n${text}`);
      assert.match(text, /# hello/, `the vault's content did not come back:\n${text.slice(0, 300)}`);
      assert.ok(!text.includes('not reachable from this workspace'), text.slice(0, 300));
      assert.ok(!text.includes('BindingProposal:'));
    } finally { rt.kill(); }
  });
});
