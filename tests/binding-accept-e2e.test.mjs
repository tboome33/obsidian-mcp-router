/**
 * THE `accept` VERB, DRIVEN END TO END — Phase 4 of the decision
 * `proposition-de-liaison-a-l-acces`.
 *
 * Saying yes to a binding proposal is the half of the lot that WRITES, and the
 * decision is explicit about what it must never become: the model recomposing a
 * binding. `confirm_workspace_binding({ vault: X })` replaces the primary and
 * drops every secondary that was not passed again, so the yes is one token the
 * server resolves, and the server performs an ADD.
 *
 * Nothing here calls the tool function directly. It spawns the real binary,
 * speaks MCP over its stdio, reads the proposal out of a real refusal, and
 * sends the identifier back — because the only thing worth proving is that the
 * two halves agree in the wiring, not in a harness's imagination.
 *
 * The two traps the decision names by number are tests 2 and 3:
 *   trap 2: every existing secondary AND its write tier survives the add.
 *   trap 3: a binding that moved between the proposal and the yes REFUSES it.
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
const API_KEY = 'binding-accept-e2e-key';

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

/** `binding: null` writes NO workspaceBindings entry — the "primary" case. */
function writeConfig(port, { binding = 'default', refuse = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binding-accept-e2e-'));
  tmpDirs.push(dir);
  const configPath = path.join(dir, 'config.json');
  const baseUrl = `http://127.0.0.1:${port}`;
  const remote = (name) => ({ name, baseUrl, apiKey: API_KEY, timeoutMs: 5000 });
  const key = canonicalWorkspaceKey(dir);
  const theBinding = binding === 'default'
    ? {
      vault: 'work',
      also: ['writable-ref', 'locked-ref'],
      locked: false,
      alsoWritable: ['writable-ref'],
      alsoLocked: ['locked-ref'],
      confirmedAt: '2026-09-16',
      confirmedVia: 'test',
    }
    : binding;
  fs.writeFileSync(configPath, JSON.stringify({
    portRegistry: {},
    vaultNames: {},
    remoteVaults: [remote('work'), remote('writable-ref'), remote('locked-ref'), remote('sci'), remote('other')],
    defaultVault: 'work',
    vaultReach: 'declared',
    openVaults: [],
    ...(theBinding ? { workspaceBindings: { [key]: theBinding } } : {}),
    ...(refuse ? { workspaceRefusals: { [key]: { [refuse]: '2026-09-16' } } } : {}),
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
    clientInfo: { name: 'binding-accept-e2e', version: '0' },
  });
  rt.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

const textOf = (res) => (res.result?.content || []).map((c) => c.text || '').join('\n');

/** Provoke a real refusal and return the proposal the client was handed. */
async function proposalFor(rt, vault, id = 2) {
  const res = await rt.call(id, 'tools/call', {
    name: 'get_file',
    arguments: { vault, path: 'wiki/anything.md' },
  });
  assert.equal(res.result?.isError, true, `no refusal for ${vault}:\n${textOf(res)}`);
  const proposal = res.result?._meta?.bindingProposal;
  assert.ok(proposal, `no proposal for ${vault}:\n${textOf(res)}`);
  return proposal;
}

const bindingOnDisk = (configPath, key) => JSON.parse(fs.readFileSync(configPath, 'utf8')).workspaceBindings?.[key];

describe('E2E: accepting a binding proposal', () => {
  test('TRAP 2 — the add preserves every secondary AND both write tiers', async () => {
    // ► MUTATION WITNESS: make the accept path re-send `{ vault: target }`, the
    //   call the model would have composed from the old prose, and this goes
    //   red on all four counts at once.
    const vault = await startFakeVault();
    const { dir, configPath, key } = writeConfig(vault.port);
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const proposal = await proposalFor(rt, 'sci');
      assert.equal(proposal.proposedRole, 'secondary');

      const res = await rt.call(3, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { accept: proposal.proposalId, open: false },
      });
      assert.notEqual(res.result?.isError, true, textOf(res));

      const after = bindingOnDisk(configPath, key);
      assert.equal(after.vault, 'work', 'the primary was replaced');
      assert.deepEqual(after.also, ['writable-ref', 'locked-ref', 'sci'], 'a secondary was dropped or misordered');
      assert.deepEqual(after.alsoWritable, ['writable-ref'], 'a write tier was lost');
      assert.deepEqual(after.alsoLocked, ['locked-ref'], 'a locked tier was lost');
      // And the newcomer is in NO tier — read-only soft, per decision §6.
      assert.ok(!after.alsoWritable.includes('sci'));
      assert.ok(!after.alsoLocked.includes('sci'));
    } finally { rt.kill(); }
  });

  test('the accepted vault is reachable in the SAME session, without a restart', async () => {
    const vault = await startFakeVault();
    const { dir, configPath } = writeConfig(vault.port);
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const proposal = await proposalFor(rt, 'sci');
      await rt.call(3, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { accept: proposal.proposalId, open: false },
      });
      const again = await rt.call(4, 'tools/call', {
        name: 'get_file',
        arguments: { vault: 'sci', path: 'wiki/anything.md' },
      });
      assert.notEqual(again.result?.isError, true, textOf(again));
      assert.match(textOf(again), /# hello/);
    } finally { rt.kill(); }
  });

  test('TRAP 3 — a binding that MOVED between the proposal and the yes refuses it, and writes nothing', async () => {
    const vault = await startFakeVault();
    const { dir, configPath, key } = writeConfig(vault.port);
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const proposal = await proposalFor(rt, 'sci');

      // Another session moves a TIER — the change that does not touch `also` at
      // all, and the one a naive "is the vault still absent?" check would miss.
      const res = await rt.call(3, 'tools/call', {
        name: 'set_secondary_vault_mode',
        arguments: { vault: 'locked-ref', mode: 'writable' },
      });
      assert.notEqual(res.result?.isError, true, textOf(res));

      const yes = await rt.call(4, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { accept: proposal.proposalId, open: false },
      });
      assert.equal(yes.result?.isError, true, 'a stale acceptance was applied');
      assert.match(textOf(yes), /no longer matches|changed while/);

      const after = bindingOnDisk(configPath, key);
      assert.ok(!after.also.includes('sci'), 'the stale acceptance wrote anyway');
    } finally { rt.kill(); }
  });

  test('a binding hand-edited into INCOHERENCE between the proposal and the yes refuses the yes, and writes nothing', async () => {
    // THE CHANGE THE IDENTIFIER CANNOT SEE. The digest is computed on the
    // forgiving reading, so adding a duplicate to `also` in the file changes
    // nothing the identifier looks at: it still resolves. Without its own
    // check the acceptance would add a secondary on top of an entry the
    // decision says must be read and repaired first ("Mal configuré", rows 1
    // and 2). This witness is the only thing separating that check from the
    // identifier — which is why a mutation that drops the check must turn
    // THIS red and nothing else.
    const vault = await startFakeVault();
    const { dir, configPath, key } = writeConfig(vault.port);
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const proposal = await proposalFor(rt, 'sci');

      // Another process (a hand edit, here) duplicates a secondary. Same
      // forgiving reading, same digest, same identifier.
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      cfg.workspaceBindings[key].also = ['writable-ref', 'locked-ref', 'locked-ref'];
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');

      const yes = await rt.call(3, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { accept: proposal.proposalId, open: false },
      });
      assert.equal(yes.result?.isError, true, `an acceptance was applied over an incoherent binding:\n${textOf(yes)}`);
      const text = textOf(yes);
      assert.match(text, /NO BINDING WAS WRITTEN/);
      assert.match(text, /locked-ref appears more than once in `also`/);
      assert.match(text, /confirm_workspace_binding\(\{ vault: "work", also: \["writable-ref", "locked-ref"\], ifBindingDigest: "[0-9a-f]{64}" \}\)/);
      assert.match(text, /locked: "locked-ref"; writable: "writable-ref"/);
      // What the session did before refusing is SAID, as the neighbouring
      // exits say it (Codex, round 10).
      assert.match(text, /refusals were refreshed from the file; its binding and routing are unchanged/);

      const after = bindingOnDisk(configPath, key);
      assert.deepEqual(after.also, ['writable-ref', 'locked-ref', 'locked-ref'], 'the file was rewritten');
      assert.ok(!after.also.includes('sci'), 'the yes wrote anyway');
    } finally { rt.kill(); }
  });

  test('THE REPAIR IS FOLLOWED, not just read: an entry with NO primary keeps its write tiers through the call the diagnostic spells out', async () => {
    // ► THE ROUND-10 BLOCKER, found by both passes. The diagnostic told the
    //   user to re-confirm `{ vault, also }`; the tool then read the tiers
    //   from the REPAIRED reading of the entry, which is null when the entry
    //   has no primary — so `keep()` kept nothing and a strict secondary came
    //   out of its own repair as soft. A regex on the diagnostic's text could
    //   never see that; only executing the call can.
    const vault = await startFakeVault();
    const { dir, configPath, key } = writeConfig(vault.port, {
      binding: { also: ['writable-ref', 'locked-ref'], alsoLocked: ['locked-ref'], alsoWritable: ['writable-ref'], locked: false },
    });
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const res = await rt.call(2, 'tools/call', { name: 'get_file', arguments: { vault: 'sci', path: 'wiki/x.md' } });
      assert.equal(res.result?.isError, true, textOf(res));
      const text = textOf(res);
      assert.equal(res.result?._meta?.bindingProposal, undefined, `a primary was proposed over a primary-less entry:\n${text}`);
      const digest = /ifBindingDigest: "([0-9a-f]{64})"/.exec(text)?.[1];
      assert.ok(digest, `no precondition in the diagnostic:\n${text}`);
      assert.match(text, /locked: "locked-ref"; writable: "writable-ref"/);

      // The user names the primary; the model copies the rest of the call.
      const repaired = await rt.call(3, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { vault: 'work', also: ['writable-ref', 'locked-ref'], ifBindingDigest: digest, open: false },
      });
      assert.ok(repaired.result, `no result at all:\n${JSON.stringify(repaired)}`);
      assert.notEqual(repaired.result?.isError, true, textOf(repaired));

      const after = bindingOnDisk(configPath, key);
      assert.equal(after.vault, 'work');
      assert.deepEqual(after.also, ['writable-ref', 'locked-ref']);
      assert.deepEqual(after.alsoLocked, ['locked-ref'], 'the strict tier was lost in the repair');
      assert.deepEqual(after.alsoWritable, ['writable-ref'], 'the writable tier was lost in the repair');

      // And THIS session applies it: the write is adopted in full.
      const lv = await rt.call(4, 'tools/call', { name: 'list_vaults', arguments: {} });
      const wb = JSON.parse(textOf(lv)).workspaceBinding;
      assert.deepEqual(wb.alsoLocked, ['locked-ref']);
      assert.deepEqual(wb.alsoWritable, ['writable-ref']);
    } finally { rt.kill(); }
  });

  test('the repair of a primary-less entry cannot PROMOTE a secondary that entry holds as strict', async () => {
    // ► THE DOOR ROUND 10 OPENED. Reading the tiers from the raw entry made
    //   them survive the repair — and the promotion guard still read the
    //   repaired binding, null for that entry, so naming the strict secondary
    //   as the new primary walked past it and lifted the hard tier. Found on
    //   my own read before round 11; the guard now reads the raw entry too.
    const vault = await startFakeVault();
    const { dir, configPath, key } = writeConfig(vault.port, {
      binding: { also: ['locked-ref', 'writable-ref'], alsoLocked: ['locked-ref'], alsoWritable: ['writable-ref'] },
    });
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const res = await rt.call(2, 'tools/call', { name: 'get_file', arguments: { vault: 'sci', path: 'wiki/x.md' } });
      const digest = /ifBindingDigest: "([0-9a-f]{64})"/.exec(textOf(res))?.[1];
      assert.ok(digest, textOf(res));
      const bytesBefore = fs.readFileSync(configPath);

      const promote = await rt.call(3, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { vault: 'locked-ref', also: ['writable-ref'], ifBindingDigest: digest, open: false },
      });
      assert.equal(promote.result?.isError, true, `a strict secondary was promoted through the repair:\n${textOf(promote)}`);
      assert.match(textOf(promote), /alsoLocked SECONDARY/);
      assert.ok(fs.readFileSync(configPath).equals(bytesBefore), 'the promotion was written');
      assert.deepEqual(bindingOnDisk(configPath, key).alsoLocked, ['locked-ref']);
    } finally { rt.kill(); }
  });

  test('THE REPAIR HAS A PRECONDITION: a binding another session replaced since the diagnostic refuses the spelled-out call', async () => {
    // ► THE OTHER ROUND-10 BLOCKER. `{ vault, also }` replaces whatever the
    //   file holds at write time; recommending it in a diagnostic recommended
    //   putting an old photograph over a sibling's work. The call now carries
    //   the digest of the entry AS WRITTEN, and the tool refuses to apply it
    //   over anything else.
    const vault = await startFakeVault();
    const { dir, configPath, key } = writeConfig(vault.port, {
      binding: { vault: 'work', also: ['locked-ref', 'locked-ref'], locked: false },
    });
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const res = await rt.call(2, 'tools/call', { name: 'get_file', arguments: { vault: 'sci', path: 'wiki/x.md' } });
      const digest = /ifBindingDigest: "([0-9a-f]{64})"/.exec(textOf(res))?.[1];
      assert.ok(digest, textOf(res));

      // A sibling binds this workspace elsewhere.
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      cfg.workspaceBindings[key] = { vault: 'other', also: ['sci'], locked: false, confirmedVia: 'sibling' };
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
      const bytesBefore = fs.readFileSync(configPath);

      const stale = await rt.call(3, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { vault: 'work', also: ['locked-ref'], ifBindingDigest: digest, open: false },
      });
      assert.equal(stale.result?.isError, true, `the stale repair was applied over the sibling's binding:\n${textOf(stale)}`);
      assert.match(textOf(stale), /no longer the entry that diagnostic described/);
      // The advice names the ACCESS call, not this repair with its old digest
      // (Codex, round 11: "re-run the call that was refused" pointed at the
      // repair itself, which repeats the same refusal forever).
      assert.match(textOf(stale), /Do NOT retry this repair with the same digest/);
      assert.match(textOf(stale), /Re-run the ACCESS call/);
      assert.match(textOf(stale), /NO BINDING WAS WRITTEN/);
      assert.ok(fs.readFileSync(configPath).equals(bytesBefore), 'the file was rewritten');
      assert.equal(bindingOnDisk(configPath, key).vault, 'other');
    } finally { rt.kill(); }
  });

  test('THE PRECONDITION IS THE ENTRY, NOT A PROJECTION: a sibling turning `[7]` into `["7"]` — a strict tier appearing — refuses the stale repair', async () => {
    // ► THE ROUND-11 BLOCKER. `bindingDigest` coerced list items to strings
    //   and read a non-list as an empty list, so this change kept the digest:
    //   the stale repair (spelled with `also: []`) went through and erased the
    //   strict secondary the sibling had just recorded. `rawEntryDigest` is
    //   the identity of the entry as written.
    const vault = await startFakeVault();
    // ► SAME NAME, DIFFERENT TYPE — the first fixture changed the name too
    //   (`[7]` → `["locked-ref"]`), so the digest moved for the name and the
    //   coercion under test was never exercised: mutation P1 (coerce
    //   primitives to strings) left this witness green. The lesson of round 9
    //   again: the fixture must reach the branch.
    const { dir, configPath, key } = writeConfig(vault.port, {
      binding: { vault: 'work', also: [7], alsoLocked: ['7'] },
    });
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const res = await rt.call(2, 'tools/call', { name: 'get_file', arguments: { vault: 'sci', path: 'wiki/x.md' } });
      const text = textOf(res);
      assert.match(text, /malformed|do not have the expected shape/, text);
      const digest = /ifBindingDigest: "([0-9a-f]{64})"/.exec(text)?.[1];
      assert.ok(digest, text);

      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      cfg.workspaceBindings[key] = { vault: 'work', also: ['7'], alsoLocked: ['7'] };
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
      const bytesBefore = fs.readFileSync(configPath);

      const stale = await rt.call(3, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { vault: 'work', also: [], ifBindingDigest: digest, open: false },
      });
      assert.equal(stale.result?.isError, true, `the stale repair erased a strict tier recorded since:\n${textOf(stale)}`);
      assert.ok(fs.readFileSync(configPath).equals(bytesBefore), 'the file was rewritten');
      assert.deepEqual(bindingOnDisk(configPath, key).alsoLocked, ['7']);
    } finally { rt.kill(); }
  });

  test('a diagnostic on a present `null` entry does not let the repair recreate an entry a sibling has DELETED since', async () => {
    const vault = await startFakeVault();
    const { dir, configPath, key } = writeConfig(vault.port, { binding: null });
    // `binding: null` writes no entry; put a PRESENT null there by hand.
    const cfg0 = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    cfg0.workspaceBindings = { [key]: null };
    fs.writeFileSync(configPath, JSON.stringify(cfg0, null, 2), 'utf8');
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const res = await rt.call(2, 'tools/call', { name: 'get_file', arguments: { vault: 'sci', path: 'wiki/x.md' } });
      const text = textOf(res);
      assert.match(text, /not an object at all/, text);
      const digest = /ifBindingDigest: "([0-9a-f]{64})"/.exec(text)?.[1];
      assert.ok(digest, text);

      // A sibling deletes the entry (a clear).
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      delete cfg.workspaceBindings[key];
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
      const bytesBefore = fs.readFileSync(configPath);

      const stale = await rt.call(3, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { vault: 'work', also: [], ifBindingDigest: digest, open: false },
      });
      assert.equal(stale.result?.isError, true, `a stale repair recreated a deleted entry:\n${textOf(stale)}`);
      assert.ok(fs.readFileSync(configPath).equals(bytesBefore), 'the file was rewritten');
    } finally { rt.kill(); }
  });

  test('an ARRAY entry can actually be repaired with the digest the diagnostic shows', async () => {
    // Round 11: the renderer digested `null` for an array (not an object)
    // while the tool digested the array, so the diagnosed repair could never
    // be applied and blamed "another session" for a change nobody made.
    const vault = await startFakeVault();
    const { dir, configPath, key } = writeConfig(vault.port, { binding: null });
    const cfg0 = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    cfg0.workspaceBindings = { [key]: ['work'] };
    fs.writeFileSync(configPath, JSON.stringify(cfg0, null, 2), 'utf8');
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const res = await rt.call(2, 'tools/call', { name: 'get_file', arguments: { vault: 'sci', path: 'wiki/x.md' } });
      const digest = /ifBindingDigest: "([0-9a-f]{64})"/.exec(textOf(res))?.[1];
      assert.ok(digest, textOf(res));
      const repaired = await rt.call(3, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { vault: 'work', also: [], ifBindingDigest: digest, open: false },
      });
      assert.ok(repaired.result, JSON.stringify(repaired));
      assert.notEqual(repaired.result?.isError, true, textOf(repaired));
      assert.equal(bindingOnDisk(configPath, key).vault, 'work');
    } finally { rt.kill(); }
  });

  test('the ACCEPTANCE names an unregistered primary too, in the same breath as the duplicate', async () => {
    // Round 10 injected the registry fact at the proposal door only; this
    // door went on spelling `vault: "ghost"`. (Codex, round 11.)
    const vault = await startFakeVault();
    const { dir, configPath, key } = writeConfig(vault.port);
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const proposal = await proposalFor(rt, 'sci');
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      cfg.workspaceBindings[key] = { vault: 'ghost', also: ['locked-ref', 'locked-ref'] };
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
      const yes = await rt.call(3, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { accept: proposal.proposalId, open: false },
      });
      assert.equal(yes.result?.isError, true, textOf(yes));
      const text = textOf(yes);
      assert.match(text, /locked-ref appears more than once/);
      assert.match(text, /its primary ghost is not a vault this config file registers/);
      assert.match(text, /vault: "<the primary vault you intend>", also: \["locked-ref"\]/);
      assert.ok(!/vault: "ghost"/.test(text), 'the acceptance spelled a repair naming the unregistered primary');
    } finally { rt.kill(); }
  });

  test('`clear: true` on an entry the router could not read says it REMOVED one, not "nothing changed"', async () => {
    const vault = await startFakeVault();
    const { dir, configPath, key } = writeConfig(vault.port, { binding: { also: ['locked-ref'], alsoLocked: ['locked-ref'] } });
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const res = await rt.call(2, 'tools/call', { name: 'confirm_workspace_binding', arguments: { clear: true } });
      assert.notEqual(res.result?.isError, true, textOf(res));
      assert.match(textOf(res), /could not read as a binding/);
      assert.ok(!/nothing changed/.test(textOf(res)), textOf(res));
      assert.equal(bindingOnDisk(configPath, key), undefined, 'the malformed entry survived the clear');
    } finally { rt.kill(); }
  });

  test('the placeholder copied literally is refused, and `ifBindingDigest` cannot ride along with `accept`', async () => {
    const vault = await startFakeVault();
    const { dir, configPath, key } = writeConfig(vault.port, { binding: { also: ['locked-ref'], alsoLocked: ['locked-ref'] } });
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const res = await rt.call(2, 'tools/call', { name: 'get_file', arguments: { vault: 'sci', path: 'wiki/x.md' } });
      const digest = /ifBindingDigest: "([0-9a-f]{64})"/.exec(textOf(res))?.[1];
      assert.ok(digest, textOf(res));
      const bytesBefore = fs.readFileSync(configPath);

      const literal = await rt.call(3, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { vault: '<the primary vault you intend>', also: ['locked-ref'], ifBindingDigest: digest, open: false },
      });
      assert.equal(literal.result?.isError, true, textOf(literal));
      assert.match(textOf(literal), /not a registered vault/);
      assert.ok(fs.readFileSync(configPath).equals(bytesBefore), 'a literal placeholder was written');

      const mixed = await rt.call(4, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { accept: 'bp1_anything', ifBindingDigest: digest, open: false },
      });
      assert.equal(mixed.result?.isError, true, textOf(mixed));
      assert.match(textOf(mixed), /goes with `vault`/);
      assert.ok(fs.readFileSync(configPath).equals(bytesBefore));
      assert.deepEqual(bindingOnDisk(configPath, key).alsoLocked, ['locked-ref']);
    } finally { rt.kill(); }
  });

  test('a config that cannot be READ at the yes refuses the yes, and does not replace the file', async () => {
    // Round 10, angle F: "the acceptance decides" was an intention; this is
    // the measurement. Invalid JSON at the preflight is an explicit refusal
    // and the bytes on disk are left exactly as they were.
    const vault = await startFakeVault();
    const { dir, configPath } = writeConfig(vault.port);
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const proposal = await proposalFor(rt, 'sci');
      fs.writeFileSync(configPath, '{ this is not json', 'utf8');
      const bytesBefore = fs.readFileSync(configPath);
      const yes = await rt.call(3, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { accept: proposal.proposalId, open: false },
      });
      assert.equal(yes.result?.isError, true, textOf(yes));
      assert.match(textOf(yes), /cannot read the router config/);
      assert.match(textOf(yes), /Nothing was changed/);
      assert.ok(fs.readFileSync(configPath).equals(bytesBefore), 'an unreadable config was replaced');
    } finally { rt.kill(); }
  });

  test('TRAP 3, THE HALF THE PREFLIGHT CANNOT SEE — another PROCESS moves the binding, and the yes is still refused', async () => {
    // ► THE WITNESS THAT WAS MISSING, and the mutation that found the hole:
    //   blank out the in-lock re-resolution and every other test here stays
    //   green, because they all change the binding through the SAME router,
    //   whose live copy learns about it — so the preflight catches them and the
    //   guard that matters is never exercised.
    //
    //   Two routers on ONE config and ONE workspace, both with --no-watch, is
    //   the real shape of the race the identifier exists to close: A hands out
    //   a proposal, B writes a different binding to the file, and A's live
    //   registry never learns. Only the read INSIDE the lock can see it.
    const vault = await startFakeVault();
    const { dir, configPath, key } = writeConfig(vault.port);
    const rtA = startRouter({ configPath, cwd: dir });
    const rtB = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rtA);
      await handshake(rtB);
      const proposal = await proposalFor(rtA, 'sci');

      const moved = await rtB.call(2, 'tools/call', {
        name: 'set_secondary_vault_mode',
        arguments: { vault: 'locked-ref', mode: 'writable' },
      });
      assert.notEqual(moved.result?.isError, true, textOf(moved));
      // A still believes the old binding — that is the point of the test.
      assert.deepEqual(bindingOnDisk(configPath, key).alsoWritable.slice().sort(), ['locked-ref', 'writable-ref']);

      const yes = await rtA.call(3, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { accept: proposal.proposalId, open: false },
      });
      assert.equal(yes.result?.isError, true, 'a yes was applied against a binding another process had moved');
      assert.match(textOf(yes), /changed while|no longer matches/);
      assert.ok(!bindingOnDisk(configPath, key).also.includes('sci'), 'the stale acceptance wrote anyway');
    } finally { rtA.kill(); rtB.kill(); }
  });

  test('a preflight may not REJECT on a stale copy — a retraction by another process is honoured', async () => {
    // ► The mirror image of the refusal test, and a blocking defect on its own:
    //   a preflight is allowed to be optimistic because the lock decides, but
    //   it is NOT allowed to turn a valid yes away. B retracts a refusal and
    //   hands A a perfectly valid proposal; A's in-memory Map still says
    //   "refused" and threw before ever reaching the lock. Under `--no-watch`
    //   nothing corrected it, so A could never say yes. (Codex, round 3.)
    const vault = await startFakeVault();
    const { dir, configPath, key } = writeConfig(vault.port, { refuse: 'sci' });
    const rtA = startRouter({ configPath, cwd: dir });
    const rtB = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rtA);
      await handshake(rtB);
      // A starts life believing `sci` is refused — and it is, for now.
      const refusedRead = await rtA.call(2, 'tools/call', {
        name: 'get_file',
        arguments: { vault: 'sci', path: 'wiki/anything.md' },
      });
      assert.match(textOf(refusedRead), /already REFUSED/);

      // B takes the refusal back and gets the proposal A can no longer mint.
      const back = await rtB.call(2, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { retract: 'sci' },
      });
      assert.notEqual(back.result?.isError, true, textOf(back));
      const proposal = await proposalFor(rtB, 'sci', 3);

      // A says yes to it. A's memory still holds the refusal; the file does not.
      const yes = await rtA.call(4, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { accept: proposal.proposalId, open: false },
      });
      assert.notEqual(yes.result?.isError, true, `a stale refusal vetoed a valid yes:\n${textOf(yes)}`);
      assert.deepEqual(bindingOnDisk(configPath, key).also, ['writable-ref', 'locked-ref', 'sci']);
    } finally { rtA.kill(); rtB.kill(); }
  });

  test('after a refused yes, the SAME session mints a DIFFERENT proposal — the loop is broken', async () => {
    // ► The witness the previous round was missing: it proved the refusal, not
    //   the recovery. Without the refresh, this session keeps the binding it
    //   started with, so "re-run the call that was refused" hands back the SAME
    //   dead identifier and the next yes fails identically, forever.
    const vault = await startFakeVault();
    const { dir, configPath } = writeConfig(vault.port);
    const rtA = startRouter({ configPath, cwd: dir });
    const rtB = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rtA);
      await handshake(rtB);
      const stale = await proposalFor(rtA, 'sci');

      const moved = await rtB.call(2, 'tools/call', {
        name: 'set_secondary_vault_mode',
        arguments: { vault: 'locked-ref', mode: 'writable' },
      });
      assert.notEqual(moved.result?.isError, true, textOf(moved));

      const refused = await rtA.call(3, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { accept: stale.proposalId, open: false },
      });
      assert.equal(refused.result?.isError, true);

      // NOW the advice in that message must actually work.
      const fresh = await proposalFor(rtA, 'sci', 4);
      assert.notEqual(
        fresh.proposalId, stale.proposalId,
        'the "fresh" proposal carried the same dead identifier — the recovery advice is a loop',
      );
      const yes = await rtA.call(5, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { accept: fresh.proposalId, open: false },
      });
      assert.notEqual(yes.result?.isError, true, textOf(yes));
    } finally { rtA.kill(); rtB.kill(); }
  });

  test('with NO binding at all, the proposal is for a PRIMARY and the add creates one', async () => {
    const vault = await startFakeVault();
    const { dir, configPath, key } = writeConfig(vault.port, { binding: null });
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const proposal = await proposalFor(rt, 'sci');
      assert.equal(proposal.proposedRole, 'primary');
      assert.equal(proposal.currentPrimary, null);

      const res = await rt.call(3, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { accept: proposal.proposalId, open: false },
      });
      assert.notEqual(res.result?.isError, true, textOf(res));
      const after = bindingOnDisk(configPath, key);
      assert.equal(after.vault, 'sci');
      assert.deepEqual(after.also, []);
      assert.equal(after.locked, false);
    } finally { rt.kill(); }
  });

  test('`accept` is ALONE — combining it with `vault` is refused before anything is written', async () => {
    const vault = await startFakeVault();
    const { dir, configPath, key } = writeConfig(vault.port);
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const proposal = await proposalFor(rt, 'sci');
      const res = await rt.call(3, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { accept: proposal.proposalId, vault: 'sci', open: false },
      });
      assert.equal(res.result?.isError, true);
      assert.match(textOf(res), /cannot be combined with/);
      assert.deepEqual(bindingOnDisk(configPath, key).also, ['writable-ref', 'locked-ref']);
    } finally { rt.kill(); }
  });

  test('an identifier this router never minted is refused, and nothing is written', async () => {
    const vault = await startFakeVault();
    const { dir, configPath, key } = writeConfig(vault.port);
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const res = await rt.call(2, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { accept: 'bp1_deadbeefdeadbeefdeadbeefdeadbeef', open: false },
      });
      assert.equal(res.result?.isError, true);
      assert.match(textOf(res), /no longer matches/);
      assert.deepEqual(bindingOnDisk(configPath, key).also, ['writable-ref', 'locked-ref']);
    } finally { rt.kill(); }
  });

  test('a REFUSAL recorded by another process beats an identifier that was received before it', async () => {
    // ► THE THIRD TEST THIS SESSION THAT WAS GREEN FOR THE WRONG REASON, and
    //   the reviewer was right both times. The first version built a SECOND
    //   workspace to add the refusal, which meant a different canonical key,
    //   which meant the identifier could not resolve at all — the refusal check
    //   was never reached, and deleting it entirely would have left the test
    //   green. It asserted a refusal, not the reason for it.
    //
    //   The real shape needs one workspace and two processes, because the whole
    //   point is a refusal this session cannot see: A is handed a proposal for
    //   `sci`, B refuses `sci` WITHOUT touching the binding — so the digest
    //   does not move and A's identifier still resolves perfectly — and A then
    //   says yes. Only reading the refusals from the FILE inside the lock can
    //   stop it. And the comment that used to justify this check was wrong too:
    //   the identifier was not fabricated, it was RECEIVED, before the refusal.
    const vault = await startFakeVault();
    const { dir, configPath, key } = writeConfig(vault.port);
    const rtA = startRouter({ configPath, cwd: dir });
    const rtB = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rtA);
      await handshake(rtB);
      const proposal = await proposalFor(rtA, 'sci');

      const no = await rtB.call(2, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { refuse: 'sci' },
      });
      assert.notEqual(no.result?.isError, true, textOf(no));
      // The binding itself is untouched, so A's identifier is still valid.
      assert.deepEqual(bindingOnDisk(configPath, key).also, ['writable-ref', 'locked-ref']);

      const yes = await rtA.call(3, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { accept: proposal.proposalId, open: false },
      });
      assert.equal(yes.result?.isError, true, 'a refusal recorded by another process was ignored');
      // The REASON matters: a refusal for any other cause would mean the check
      // under test never ran.
      assert.match(textOf(yes), /was REFUSED for this workspace/);
      assert.match(textOf(yes), /retract/);
      assert.ok(!bindingOnDisk(configPath, key).also.includes('sci'), 'the accept wrote anyway');
    } finally { rtA.kill(); rtB.kill(); }
  });
});
