/**
 * THE SILENCES — Phase 3 of `proposition-de-liaison-roadmap`, items 11, 12, 15,
 * 16 and 17.
 *
 * A guard that proposes is only half a design. The other half is everything it
 * must NOT propose, and the decision `proposition-de-liaison-a-l-acces` names
 * each case with its own reason:
 *
 *   openVaults          a vault reachable from everywhere by construction. The
 *                       call simply passes — proposing to declare it would
 *                       empty the escape valve of its meaning.
 *   workspaceRefusals   the user already said no. (Proved in
 *                       tests/binding-proposal-e2e.test.mjs.)
 *   broken binding      a binding to REPAIR is not one to extend. (Same file.)
 *   incoherent binding  an entry the router had to repair to read — a
 *                       duplicate, a primary as its own secondary, a vault in
 *                       both tiers, no primary at all — is diagnosed with the
 *                       whole binding to re-pass, and NOTHING is proposed
 *                       over it. (Decision, "Mal configuré"; this file.)
 *   gated deployment    no verb of confirm_workspace_binding exists there, so
 *                       an `accept` call would be a wall.
 *   the INVENTORY       `list_vaults` is a list, not an offer.
 *
 * Every one of these is true of today's code, and that is exactly why they are
 * pinned: a silence nobody tests is a silence one refactor away from becoming
 * twenty-three questions in a row.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  canonicalWorkspaceKey, normalizeBinding, bindingIncoherences, describeBindingRepair,
} from '../src/helpers/workspace-bindings.mjs';
import { proposedRoleFor } from '../src/helpers/binding-proposal.mjs';
import { homeSafeEnv } from './_home-safe-spawn.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(REPO, 'bin', 'obsidian-mcp-router.mjs');
const API_KEY = 'silences-e2e-key';

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

/** Five registered vaults, one bound, so "many undeclared" is the normal shape. */
function writeConfig(port, { openVaults = [], binding = 'default' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'silences-e2e-'));
  tmpDirs.push(dir);
  const configPath = path.join(dir, 'config.json');
  const baseUrl = `http://127.0.0.1:${port}`;
  const remote = (name) => ({ name, baseUrl, apiKey: API_KEY, timeoutMs: 5000 });
  const key = canonicalWorkspaceKey(dir);
  const theBinding = binding === 'default'
    ? { vault: 'work', also: [], locked: false, confirmedAt: '2026-09-16', confirmedVia: 'test' }
    : binding;
  fs.writeFileSync(configPath, JSON.stringify({
    portRegistry: {},
    vaultNames: {},
    remoteVaults: ['work', 'sci', 'other', 'third', 'fourth'].map(remote),
    defaultVault: 'work',
    vaultReach: 'declared',
    openVaults,
    ...(theBinding ? { workspaceBindings: { [key]: theBinding } } : {}),
  }, null, 2), 'utf8');
  return { dir, configPath, key };
}

function startRouter({ configPath, cwd, env = {} }) {
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
  return { call, send, kill: () => child.kill() };
}

async function handshake(rt) {
  await rt.call(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'silences-e2e', version: '0' },
  });
  rt.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

const textOf = (res) => (res.result?.content || []).map((c) => c.text || '').join('\n');
const read = (rt, id, vault) => rt.call(id, 'tools/call', {
  name: 'get_file',
  arguments: { vault, path: 'wiki/anything.md' },
});

describe('the silences — what must NOT produce a proposal', () => {
  test('SILENCE 1 — a vault in openVaults is not refused, so there is nothing to propose', async () => {
    // The escape valve of `vaultReach: "declared"`: a vault listed here answers
    // from anywhere, declared by nobody. Proposing to declare it would empty it
    // of its meaning — and it is what keeps the Desktop chat, which can never
    // declare a binding, able to reach anything at all.
    const vault = await startFakeVault();
    const { dir, configPath } = writeConfig(vault.port, { openVaults: ['sci'] });
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const res = await read(rt, 2, 'sci');
      assert.notEqual(res.result?.isError, true, textOf(res));
      assert.match(textOf(res), /# hello/);
      assert.equal(res.result?._meta?.bindingProposal, undefined);
      assert.ok(!textOf(res).includes('BindingProposal:'));

      // ...and the valve is narrow: the OTHER undeclared vaults still refuse.
      const other = await read(rt, 3, 'other');
      assert.equal(other.result?.isError, true);
      assert.ok(other.result?._meta?.bindingProposal, 'the valve leaked to a vault not in openVaults');
    } finally { rt.kill(); }
  });

  test('SILENCE 2 — a GATED deployment refuses without proposing, because no acceptance can be given there', async () => {
    // ► MUTATION WITNESS: drop the gated branch and this goes red while every
    //   other test here stays green. On a gated deployment EVERY verb of
    //   confirm_workspace_binding is refused, so an `accept` call handed to the
    //   model spends a turn to arrive at a wall.
    const vault = await startFakeVault();
    const { dir, configPath } = writeConfig(vault.port);
    const rt = startRouter({ configPath, cwd: dir, env: { OBSIDIAN_ROUTER_USER_ID: 'tenant-7' } });
    try {
      await handshake(rt);
      const res = await read(rt, 2, 'sci');
      assert.equal(res.result?.isError, true, textOf(res));
      const text = textOf(res);
      assert.match(text, /not reachable from this workspace/);
      assert.equal(res.result?._meta?.bindingProposal, undefined, 'a gated deployment was handed a proposal');
      assert.ok(!text.includes('confirm_workspace_binding({ accept:'), 'a gated deployment was handed an accept call');
      assert.match(text, /shared deployment/);
    } finally { rt.kill(); }
  });

  test('SILENCE 3 — list_vaults is an INVENTORY: five vaults, four undeclared, zero proposals', async () => {
    // Trap 7 of the decision. A proposal is born from an ACCESS; if the
    // inventory produced them, opening a session on this machine would put one
    // question per undeclared vault in front of the user at once.
    const vault = await startFakeVault();
    const { dir, configPath } = writeConfig(vault.port);
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const res = await rt.call(2, 'tools/call', { name: 'list_vaults', arguments: {} });
      assert.notEqual(res.result?.isError, true, textOf(res));
      const text = textOf(res);
      assert.ok(!text.includes('BindingProposal:'), 'the inventory carried proposals');
      assert.equal(res.result?._meta?.bindingProposal, undefined);
      assert.ok(!/"proposalId"/.test(text), 'the inventory carried a proposal identifier');
      // It still SHOWS them, which is the other half of the rule: an inventory
      // that hid what is undeclared would make the system undiscoverable.
      const parsed = JSON.parse(text);
      const awaiting = (parsed.disabled || []).filter((d) => d.awaitingDeclaration === true);
      assert.equal(awaiting.length, 4, `expected the four undeclared vaults to be listed, got ${awaiting.length}`);
    } finally { rt.kill(); }
  });

  test('a FIRST binding names the directory it would bind, instead of inferring a workspace', async () => {
    // The Desktop chat starts in the application's own folder and belongs to no
    // project — and it is NOT distinguishable from an honest project that has
    // no binding yet: both are "a directory with no entry in the registry".
    // Rather than a heuristic that would guess wrong in both directions, the
    // directory is NAMED, in the authoritative channel, and only when the
    // proposal would create a binding where there was none.
    const vault = await startFakeVault();
    const { dir, configPath } = writeConfig(vault.port, { binding: null });
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const res = await read(rt, 2, 'sci');
      assert.equal(res.result?.isError, true);
      const text = textOf(res);
      assert.equal(res.result?._meta?.bindingProposal?.proposedRole, 'primary');
      assert.match(text, /It would bind THIS directory:/);
      assert.match(text, /If that is not a project of yours/);
    } finally { rt.kill(); }
  });

  test('...and a SECONDARY proposal does not, because the binding already exists', async () => {
    const vault = await startFakeVault();
    const { dir, configPath } = writeConfig(vault.port);
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const res = await read(rt, 2, 'sci');
      const text = textOf(res);
      assert.equal(res.result?._meta?.bindingProposal?.proposedRole, 'secondary');
      assert.ok(!text.includes('It would bind THIS directory:'), text);
    } finally { rt.kill(); }
  });
});

describe('an INCOHERENT binding is DIAGNOSED, never proposed over — the decision as accepted', () => {
  // ► THIS BLOCK USED TO ASSERT THE OPPOSITE, and its history is the point.
  //
  //   Phase 6 of the roadmap asked for a diagnostic when a vault sits in a
  //   binding TWICE. The measurement found that `normalizeBinding` absorbs the
  //   duplicate before the proposal code can see it, and the phase shipped that
  //   absorption AS THE POLICY, with this block as a "tripwire": a router
  //   started on an incoherent config rendered a coherent proposal, and the
  //   last test here required exactly that ("the primary stays work").
  //
  //   The round-8 conformance pass read the accepted decision again: a
  //   structurally incoherent binding "bloque la proposition et explique la
  //   réparation" — rows 1 and 2 of its "Mal configuré" table. Absorbing was a
  //   policy Roland never accepted, and this block was the witness locking it
  //   in. Roland delegated the call on 2026-09-18; the decision as written
  //   stands. So: the forgiving reading still ROUTES the session (least
  //   privilege is the reading to act on, proved below), but a proposal is
  //   never minted over an entry the router had to repair to read, and the
  //   refusal spells out the whole binding to re-pass.
  //
  //   The `normalizeBinding` assertions stay, reframed: they are no longer a
  //   tripwire for "the state cannot reach the proposal code" — it can, through
  //   `rawBindingEntry` — but the contract of the reading this session routes
  //   by, which the diagnostic must NOT change.
  const shapes = [
    ['the primary also listed as a secondary', { vault: 'work', also: ['work', 'sci'] }],
    ['a duplicate inside also', { vault: 'work', also: ['sci', 'sci'] }],
    ['both at once, repeatedly', { vault: 'work', also: ['work', 'sci', 'sci', 'work'] }],
  ];
  for (const [name, raw] of shapes) {
    test(`${name} still ROUTES as a coherent binding — the forgiving reading is unchanged`, () => {
      const n = normalizeBinding(raw);
      assert.deepEqual(n.also, ['sci'], `got ${JSON.stringify(n.also)}`);
      assert.ok(!n.also.includes(n.vault), 'the primary survived inside also');
      assert.equal(new Set(n.also).size, n.also.length, 'a duplicate survived');
    });
  }

  test('a write tier naming something that is not a secondary is dropped, and a name in BOTH tiers is LOCKED — for ROUTING', () => {
    // The hard tier wins a conflict, exactly as it does for the global lists —
    // the safe direction to route by. Diagnosed below, all the same.
    assert.deepEqual(normalizeBinding({ vault: 'work', also: ['sci'], alsoLocked: ['ghost'] }).alsoLocked, []);
    const both = normalizeBinding({ vault: 'work', also: ['sci'], alsoLocked: ['sci'], alsoWritable: ['sci'] });
    assert.deepEqual(both.alsoLocked, ['sci']);
    assert.deepEqual(both.alsoWritable, []);
  });

  // THE PREDICATE, kind by kind, on the raw entry. `{}` is deliberately in the
  // "coherent" column: it carries nothing to lose and reads as "no binding".
  const incoherent = [
    ['primary listed as its own secondary', { vault: 'work', also: ['work', 'sci'] }, ['primary-in-also']],
    ['a duplicate in also', { vault: 'work', also: ['sci', 'sci'] }, ['duplicate-secondary']],
    ['both at once', { vault: 'work', also: ['work', 'sci', 'sci', 'work'] }, ['primary-in-also', 'duplicate-secondary']],
    ['a vault in both tiers', { vault: 'work', also: ['sci'], alsoLocked: ['sci'], alsoWritable: ['sci'] }, ['tier-conflict']],
    ['a tier naming a non-secondary', { vault: 'work', also: ['sci'], alsoLocked: ['ghost'] }, ['tier-without-role']],
    ['an empty primary beside secondaries', { vault: '', also: ['x'] }, ['no-primary']],
    ['no primary at all beside secondaries', { also: ['x'] }, ['no-primary']],
    ['a null primary', { vault: null }, ['no-primary']],
    ['also that is not a list', { vault: 'work', also: 'sci' }, ['malformed-field']],
    ['locked that is not a boolean', { vault: 'work', also: [], locked: 'yes' }, ['malformed-field']],
  ];
  for (const [name, raw, kinds] of incoherent) {
    test(`bindingIncoherences — ${name}`, () => {
      assert.deepEqual(bindingIncoherences(raw).map((i) => i.kind), kinds, JSON.stringify(raw));
    });
  }
  test('bindingIncoherences — coherent shapes, and the shapes that mean "no binding"', () => {
    for (const raw of [
      { vault: 'work', also: [] },
      { vault: 'work', also: ['sci', 'other'], alsoLocked: ['sci'], alsoWritable: ['other'], locked: true },
      {},
      null,
      undefined,
      'work',
      ['work'],
    ]) {
      assert.deepEqual(bindingIncoherences(raw), [], JSON.stringify(raw));
    }
  });

  test('describeBindingRepair — the call carries the lock, the tiers, and a lossless spelling of every name', () => {
    // A persisted lock is part of "the whole binding to re-pass" — leaving it
    // out of the suggested call would hand the reader a repair that silently
    // unlocks the workspace. And a name with a quote in it must come back as
    // a JSON literal, not as a broken call (the `identifierForCall` lesson).
    const text = describeBindingRepair({
      vault: 'work', also: ['te"am', 'te"am', 'other'], alsoLocked: ['other'], alsoWritable: ['te"am'], locked: true,
    });
    // Prose spells the name as prose; only the CALL carries the JSON literal.
    assert.match(text, /te"am appears more than once/);
    assert.match(text, /confirm_workspace_binding\(\{ vault: "work", also: \["te\\"am", "other"\], locked: true \}\)/);
    assert.match(text, /locked: "other"; writable: "te\\"am"/);
    assert.match(text, /set_secondary_vault_mode/);
  });

  // END TO END, through the dispatcher: a refusal, NO proposal, and the repair
  // spelled out with the whole binding to re-pass.
  const onDisk = [
    ['the primary as its own secondary, and a duplicate', {
      vault: 'work', also: ['work', 'other', 'other'], locked: false, confirmedAt: '2026-09-16', confirmedVia: 'test',
    }, [/its primary work is also listed as its own secondary/, /other appears more than once/,
      /confirm_workspace_binding\(\{ vault: "work", also: \["other"\] \}\)/]],
    // No `locked: true` in this fixture: a persisted lock closes an EARLIER
    // door (the lock guard refuses every other vault before reachability is
    // asked), so the diagnostic would never be reached through the dispatcher.
    // That fixture was tried and hit the lock; the `locked` argument of the
    // repair call is proved on the renderer, below.
    ['a vault in both tiers', {
      vault: 'work', also: ['other'], alsoLocked: ['other'], alsoWritable: ['other'], locked: false,
    }, [/other is in BOTH write tiers/, /confirm_workspace_binding\(\{ vault: "work", also: \["other"\] \}\)/,
      /read as locked\): locked: "other"/]],
    ['secondaries but no primary — NOT an occasion to create one', {
      also: ['other'], locked: false,
    }, [/names no usable primary vault/, /vault: "<the primary vault you intend>", also: \["other"\]/]],
  ];
  for (const [name, binding, expectations] of onDisk) {
    test(`e2e — ${name}: refused, no proposal, repair spelled out`, async () => {
      const vault = await startFakeVault();
      const { dir, configPath } = writeConfig(vault.port, { binding });
      const rt = startRouter({ configPath, cwd: dir });
      try {
        await handshake(rt);
        const res = await read(rt, 2, 'sci');
        assert.equal(res.result?.isError, true, textOf(res));
        const text = textOf(res);
        assert.equal(res.result?._meta?.bindingProposal, undefined, `a proposal was minted over an incoherent binding:\n${text}`);
        assert.ok(!/"proposalId"/.test(text), `a proposal identifier leaked into the text:\n${text}`);
        for (const re of expectations) assert.match(text, re);
      } finally { rt.kill(); }
    });
  }

  test('e2e — an EMPTY entry is "no binding": the proposal is for a primary, not a wall', async () => {
    // The positive control for the predicate's one deliberate exemption. A
    // reader who confuses "malformed" with "empty" would turn a harmless `{}`
    // into a repair demand for a binding that holds nothing.
    const vault = await startFakeVault();
    const { dir, configPath } = writeConfig(vault.port, { binding: {} });
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const res = await read(rt, 2, 'sci');
      assert.equal(res.result?.isError, true, textOf(res));
      assert.equal(res.result?._meta?.bindingProposal?.proposedRole, 'primary', textOf(res));
    } finally { rt.kill(); }
  });
});

describe('proposedRoleFor — the rule, and the shapes a hand-edited config can hold', () => {
  test('the rule itself', () => {
    assert.equal(proposedRoleFor(null), 'primary');
    assert.equal(proposedRoleFor({ vault: 'work', also: [] }), 'secondary');
  });

  test('a binding whose primary is empty or missing is NOT a binding for this purpose', () => {
    // A config file is a file: it can be hand-edited into shapes the writer
    // never produces. "Secondary of nothing" is not an answer, so the PURE
    // function reads these as "no binding" and answers `primary`.
    //
    // ► WHAT THIS NO LONGER MEANS: that such an entry PRODUCES a primary
    //   proposal. It used to (the third drift the round-8 conformance pass
    //   named: point 2 says `primary` for a NULL binding, and a malformed one
    //   is not null). `resolveVault` now diagnoses the raw entry BEFORE this
    //   function is consulted — see the e2e block above — so these shapes
    //   reach it only through `{}`, the one that really is "no binding".
    for (const shape of [{ vault: '', also: [] }, { also: ['x'] }, { vault: null }, {}]) {
      assert.equal(proposedRoleFor(shape), 'primary', JSON.stringify(shape));
    }
  });

  test('a non-object never throws and never invents a role', () => {
    // ► Written here once as `typeof bad === 'object' ? 'primary' : 'primary'`,
    //   which is the same value on both branches: an assertion that cannot
    //   fail, dressed as one that discriminates. The fifth of this session.
    //   A ternary in an expected value is nearly always that mistake.
    for (const bad of ['work', 42, [], true, () => {}]) {
      assert.equal(
        proposedRoleFor(bad), 'primary',
        `a ${typeof bad} was read as a binding instead of as "there is none"`,
      );
    }
  });
});
