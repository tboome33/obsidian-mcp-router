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
  rawSecondaryTiers, rawEntryDigest, registryIncoherences, registryFactsFor, writerBindableNames,
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
    // A throwaway HOME UNDER the workspace, never the workspace itself: with
    // HOME === cwd, `lock_vault --persist` refuses as "your home directory"
    // before the binding is reached (round 13, seen in the also-tier E2E).
    env: homeSafeEnv(path.join(cwd, 'home'), {
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
  test('bindingIncoherences — coherent shapes, and the TWO shapes that mean "no binding"', () => {
    // ► `null`, `'work'` and `['work']` USED TO BE IN THIS LIST. Round 10 read
    //   it back against the rule the block above states — "only an absent or
    //   empty entry means no binding" — and found the test consecrating three
    //   exemptions the rule does not make: a present entry of the wrong type
    //   is something someone wrote, and the forgiving reading turns it into
    //   "no binding" in silence. They moved to the malformed column.
    for (const raw of [
      { vault: 'work', also: [] },
      { vault: 'work', also: ['sci', 'other'], alsoLocked: ['sci'], alsoWritable: ['other'], locked: true },
      {},
      undefined,
    ]) {
      assert.deepEqual(bindingIncoherences(raw), [], JSON.stringify(raw));
    }
  });

  test('bindingIncoherences — a PRESENT entry of the wrong type is malformed, not "no binding"', () => {
    for (const raw of [null, 'work', ['work'], 42, true]) {
      assert.deepEqual(bindingIncoherences(raw).map((i) => i.kind), ['malformed-entry'], JSON.stringify(raw));
    }
  });

  test('bindingIncoherences — a duplicate INSIDE a tier, and the primary holding a tier through `also`', () => {
    // Two shapes `normalizeBinding` repairs that the first predicate did not
    // name — its claim was "everything the forgiving reading changes", and
    // these two were the gap (Codex, round 10).
    assert.deepEqual(
      bindingIncoherences({ vault: 'work', also: ['ref'], alsoLocked: ['ref', 'ref'] }).map((i) => i.kind),
      ['duplicate-tier-entry'],
    );
    assert.deepEqual(
      bindingIncoherences({ vault: 'work', also: ['ref'], alsoWritable: ['ref', 'ref'] }).map((i) => i.kind),
      ['duplicate-tier-entry'],
    );
    // A vault in both tiers once each is a CONFLICT, not a duplicate.
    assert.deepEqual(
      bindingIncoherences({ vault: 'work', also: ['ref'], alsoLocked: ['ref'], alsoWritable: ['ref'] }).map((i) => i.kind),
      ['tier-conflict'],
    );
    // The primary listed in `also` AND in a tier: it is its own secondary, and
    // the tier qualifies nothing — the role set is `also` minus the primary,
    // as the forgiving reading has it.
    assert.deepEqual(
      bindingIncoherences({ vault: 'work', also: ['work', 'ref'], alsoLocked: ['work'] }).map((i) => i.kind),
      ['primary-in-also', 'tier-without-role'],
    );
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
    assert.match(text, /confirm_workspace_binding\(\{ vault: "work", also: \["te\\"am", "other"\], locked: true, ifBindingDigest: "[0-9a-f]{64}" \}\)/);
    assert.match(text, /locked: "other"; writable: "te\\"am"/);
    assert.match(text, /set_secondary_vault_mode/);
  });

  test('describeBindingRepair — without a primary the call still carries the TIERS, and says the placeholder is not to be copied', () => {
    // ► THE ROUND-10 BLOCKER. The first renderer said nothing about tiers when
    //   the repaired reading was null, and the tool then carried none: a
    //   strict secondary came out of its own repair as soft. Both Codex
    //   passes found it. The tool now reads the tiers from the entry as
    //   written (proved end to end in binding-accept-e2e), and the text says
    //   what that keeps.
    const text = describeBindingRepair({ also: ['strict', 'editable'], alsoLocked: ['strict'], alsoWritable: ['editable'] });
    assert.match(text, /names no usable primary vault/);
    assert.match(text, /vault: "<the primary vault you intend>", also: \["strict", "editable"\], ifBindingDigest: "[0-9a-f]{64}"/);
    assert.match(text, /locked: "strict"; writable: "editable"/);
    assert.match(text, /never copy the placeholder literally/);
  });

  test('describeBindingRepair — a primary no registry knows gets the placeholder too, in the same breath as the other faults', () => {
    const text = describeBindingRepair(
      { vault: 'ghost', also: ['ref', 'ref'] },
      [...bindingIncoherences({ vault: 'ghost', also: ['ref', 'ref'] }), { kind: 'primary-not-registered', names: ['ghost'] }],
    );
    assert.match(text, /ref appears more than once/);
    assert.match(text, /its primary ghost is not a vault this config file registers/);
    assert.match(text, /vault: "<the primary vault you intend>", also: \["ref"\]/);
    assert.ok(!/vault: "ghost"/.test(text), 'the repair call named the unregistered primary');
  });

  test('rawSecondaryTiers — the tiers of a primary-less entry, read with NO primary invented', () => {
    // Round 10 read them under a sentinel primary. A sentinel is a name a
    // vault can carry: an entry holding a secondary of that exact name lost
    // it, and a strict one of that name stopped being a secondary before the
    // promotion guard asked. (Codex, round 11.) Nothing is invented here.
    const sentinel = '<the primary vault you intend>';
    const t = rawSecondaryTiers({ also: [sentinel, 'b', 'b'], alsoLocked: [sentinel], alsoWritable: ['b', 'ghost'] });
    assert.deepEqual(t, { also: [sentinel, 'b'], alsoLocked: [sentinel], alsoWritable: ['b'] });
    // A vault in both tiers is locked; a name without a role holds none.
    assert.deepEqual(
      rawSecondaryTiers({ also: ['a'], alsoLocked: ['a'], alsoWritable: ['a', 'x'] }),
      { also: ['a'], alsoLocked: ['a'], alsoWritable: [] },
    );
    assert.equal(rawSecondaryTiers('work'), null);
    assert.equal(rawSecondaryTiers(undefined), null);
  });

  test('rawEntryDigest — the identity of the ENTRY, not of a projection of it', () => {
    // The round-11 blocker: `bindingDigest` projected the entry (five
    // fields, strings coerced, absent == null), so a stale repair could be
    // applied after a sibling deleted the entry, or after `[7]` became
    // `["7"]` — a real strict tier appearing. And the renderer digested
    // `null` for an array entry while the tool digested the array.
    assert.notEqual(rawEntryDigest(undefined), rawEntryDigest(null), 'absent and a present null share a digest');
    assert.notEqual(rawEntryDigest({ vault: 'w', also: [7], alsoLocked: ['7'] }), rawEntryDigest({ vault: 'w', also: ['7'], alsoLocked: ['7'] }));
    assert.notEqual(rawEntryDigest(['work']), rawEntryDigest(null));
    assert.notEqual(rawEntryDigest({ vault: 'w', also: ['a', 'b'] }), rawEntryDigest({ vault: 'w', also: ['b', 'a'] }), 'list order is part of the entry');
    // Key order is not a change: re-saving the file with keys reordered must
    // not refuse a legitimate repair.
    assert.equal(rawEntryDigest({ vault: 'w', also: ['a'], locked: true }), rawEntryDigest({ locked: true, also: ['a'], vault: 'w' }));
    assert.equal(rawEntryDigest({ a: { y: 1, x: [1, { q: 2, p: 3 }] } }), rawEntryDigest({ a: { x: [1, { p: 3, q: 2 }], y: 1 } }));
    assert.match(rawEntryDigest({}), /^[0-9a-f]{64}$/);
  });

  test('registryIncoherences — the WRITER\'s set decides what can be bound; the session decides what is loaded', () => {
    const bindable = new Set(['work', 'newer', 'sci']);
    const session = new Set(['work', 'sci']);
    assert.deepEqual(registryIncoherences({ vault: 'ghost' }, { bindable, sessionNames: session }).map((i) => i.kind), ['primary-not-registered']);
    // Known to the session, gone from the file: the writer refuses it, so
    // "known to file OR session" was the wrong test (Codex, round 11).
    assert.deepEqual(registryIncoherences({ vault: 'old' }, { bindable, sessionNames: new Set(['old']) }).map((i) => i.kind), ['primary-not-registered']);
    assert.deepEqual(registryIncoherences({ vault: 'newer' }, { bindable, sessionNames: session }).map((i) => i.kind), ['primary-not-loaded-here']);
    assert.deepEqual(registryIncoherences({ vault: 'work' }, { bindable, sessionNames: session }), []);
    // A SECONDARY the writer refuses is named too, and left out of the call
    // (round 12: the spelled call failed at assertBindable before the
    // precondition was even looked at).
    assert.deepEqual(
      registryIncoherences({ vault: 'work', also: ['sci', 'gone', 'gone'] }, { bindable, sessionNames: session }),
      [{ kind: 'secondary-not-registered', names: ['gone'] }],
    );
    assert.deepEqual(registryIncoherences({ also: ['x'] }, { bindable, sessionNames: session }).map((i) => i.kind), ['secondary-not-registered']);
    assert.deepEqual(registryIncoherences('work', { bindable, sessionNames: session }), []);
    assert.deepEqual(registryIncoherences(undefined, { bindable, sessionNames: session }), []);
    // THREE FACTS ABOUT A SECONDARY OUTSIDE THE SET, told apart (round 14):
    // disabled by the file; dropped from the file but still loaded here; and
    // neither listed nor loaded. And a disabled PRIMARY is its own kind.
    const disabled = new Set(['off']);
    assert.deepEqual(
      registryIncoherences(
        { vault: 'work', also: ['off', 'old', 'gone'] },
        { bindable, sessionNames: new Set(['work', 'old']), disabled },
      ),
      [
        { kind: 'secondary-disabled', names: ['off'] },
        { kind: 'secondary-dropped-still-loaded', names: ['old'] },
        { kind: 'secondary-not-registered', names: ['gone'] },
      ],
    );
    assert.deepEqual(registryIncoherences({ vault: 'off' }, { bindable, sessionNames: session, disabled }).map((i) => i.kind), ['primary-disabled']);
    // The facts helper builds the three sets from one config and one catalogue.
    const facts = registryFactsFor(
      { portRegistry: {}, vaultNames: {}, remoteVaults: [{ name: 'work' }, { name: 'off' }], disabledVaults: ['off'] },
      [{ name: 'work', type: 'remote' }, { name: 'old', type: 'remote' }],
    );
    assert.deepEqual([...facts.bindable].sort(), ['work']);
    assert.deepEqual([...facts.sessionNames].sort(), ['old', 'work']);
    assert.deepEqual([...facts.disabled], ['off']);
  });

  test('e2e — a COHERENT binding with a secondary this session cannot bind still PROPOSES (only the primary blocks)', async () => {
    // Round 13: round 12 blocked every proposal on such a secondary — a
    // policy nobody accepted (the decision's row is about the primary), with
    // a real victim: a secondary another session's environment provides
    // silenced this one for good.
    const vault = await startFakeVault();
    const { dir, configPath } = writeConfig(vault.port, { binding: { vault: 'work', also: ['other'] } });
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      cfg.remoteVaults = cfg.remoteVaults.filter((r) => r.name !== 'other');
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
      const res = await read(rt, 2, 'sci');
      assert.equal(res.result?.isError, true, textOf(res));
      assert.equal(res.result?._meta?.bindingProposal?.proposedRole, 'secondary', `no proposal:\n${textOf(res)}`);
    } finally { rt.kill(); }
  });

  test('writerBindableNames — the file\'s names plus the ENVIRONMENT\'s remotes, nothing else', () => {
    // The hole carried since round 5: every remote was exempt from the file
    // check, so a remote a sibling removed from the file stayed bindable. The
    // exemption existed for remotes the environment provides (VAULT_*), which
    // the file never lists — told apart by their `source` now.
    const cfg = { portRegistry: {}, vaultNames: {}, remoteVaults: [{ name: 'filed' }] };
    const vaults = [{ name: 'filed', type: 'remote' }, { name: 'env-only', type: 'remote', source: 'env' }, { name: 'stale-remote', type: 'remote' }];
    const set = writerBindableNames(cfg, vaults);
    assert.equal(set.has('filed'), true);
    assert.equal(set.has('env-only'), true, 'an environment-provided remote must stay bindable');
    assert.equal(set.has('stale-remote'), false, 'a remote the file no longer lists was still bindable');
    // A vault the config DISABLES is not bindable, whatever lists it (round
    // 13: a disabled remote counted as "listed", and its owner was told to
    // retry or restart for an exclusion that outlives every restart).
    const disabled = writerBindableNames({ ...cfg, disabledVaults: ['filed'] }, vaults);
    assert.equal(disabled.has('filed'), false);
    // AND AN ENVIRONMENT REMOTE THE FILE DISABLES IS NOT PUT BACK (round 14: a
    // session loaded before a sibling disabled it still carried the `env`
    // descriptor, and the re-add ran after the deletion).
    const envOff = writerBindableNames({ ...cfg, disabledVaults: ['env-only'] }, vaults);
    assert.equal(envOff.has('env-only'), false, 'a disabled environment remote came back through the env re-add');
    assert.equal(envOff.has('filed'), true);
  });

  test('describeBindingRepair — a secondary this session cannot bind is NAMED and KEPT in the spelled call', () => {
    // ► ROUND 12 LEFT IT OUT, and round 13 measured what that did: the
    //   repair dropped the secondary AND its tier for good (it came back
    //   soft), and a secondary another session's ENVIRONMENT provides was
    //   "unregistered" for this one — so this session's repair erased that
    //   session's binding with the precondition satisfied. A repair keeps
    //   what was there.
    const raw = { vault: 'work', also: ['sci', 'gone'], alsoLocked: ['gone'] };
    const text = describeBindingRepair(raw, [
      ...bindingIncoherences(raw),
      { kind: 'secondary-not-registered', names: ['gone'] },
    ]);
    assert.match(text, /its secondary gone is not a vault this config file lists nor one this session's environment provides, and this session has not loaded it/);
    assert.match(text, /it is KEPT in the call below, tier included/);
    // Round 14: "stays unreachable … for good" overstated both halves. What is
    // said now is what is known: from here it answers "Unknown vault"; a
    // removal is a choice, and the tier can be set again.
    assert.match(text, /from here it does not answer \(Unknown vault\)/);
    assert.match(text, /Removing it from the call is a choice, not a fix/);
    assert.doesNotMatch(text, /for good|stays unreachable/);
    assert.match(text, /vault: "work", also: \["sci", "gone"\], ifBindingDigest/);
    assert.match(text, /locked: "gone"/);
    // The two other facts about such a secondary, and the disabled primary,
    // each with its own sentence and the same KEEP (round 14).
    const three = describeBindingRepair(raw, [
      ...bindingIncoherences(raw),
      { kind: 'secondary-disabled', names: ['gone'] },
      { kind: 'secondary-dropped-still-loaded', names: ['sci'] },
    ]);
    assert.match(three, /its secondary gone is DISABLED by `disabledVaults`[^.]*registering it again or restarting lifts nothing; it is KEPT in the call below/);
    assert.match(three, /its secondary sci is no longer a vault this config file lists[^.]*it still ANSWERS here[^.]*the next start will not load it; it is KEPT in the call below/);
    assert.match(three, /vault: "work", also: \["sci", "gone"\], ifBindingDigest/);
    const offPrimary = describeBindingRepair({ vault: 'off', also: ['sci'] }, [{ kind: 'primary-disabled', names: ['off'] }]);
    assert.match(offPrimary, /its primary off is DISABLED by `disabledVaults`/);
    assert.match(offPrimary, /vault: "<the primary vault you intend>", also: \["sci"\]/);
  });

  // END TO END, through the dispatcher: a refusal, NO proposal, and the repair
  // spelled out with the whole binding to re-pass.
  const onDisk = [
    ['the primary as its own secondary, and a duplicate', {
      vault: 'work', also: ['work', 'other', 'other'], locked: false, confirmedAt: '2026-09-16', confirmedVia: 'test',
    }, [/its primary work is also listed as its own secondary/, /other appears more than once/,
      /confirm_workspace_binding\(\{ vault: "work", also: \["other"\], ifBindingDigest: "[0-9a-f]{64}" \}\)/,
      // The preamble names its source: the binding THIS SESSION routes by —
      // not "this workspace's binding", which the file's entry may contradict.
      /the binding this session routes by does not name it/]],
    // No `locked: true` in this fixture: a persisted lock closes an EARLIER
    // door (the lock guard refuses every other vault before reachability is
    // asked), so the diagnostic would never be reached through the dispatcher.
    // That fixture was tried and hit the lock; the `locked` argument of the
    // repair call is proved on the renderer, below.
    ['a vault in both tiers', {
      vault: 'work', also: ['other'], alsoLocked: ['other'], alsoWritable: ['other'], locked: false,
    }, [/other is in BOTH write tiers/, /confirm_workspace_binding\(\{ vault: "work", also: \["other"\], ifBindingDigest: "[0-9a-f]{64}" \}\)/,
      /no secondary role holds no tier\): locked: "other"/]],
    ['secondaries but no primary — NOT an occasion to create one', {
      also: ['other'], locked: false,
    }, [/names no usable primary vault/, /vault: "<the primary vault you intend>", also: \["other"\]/]],
    // TWO FAULTS AT ONCE: incoherent AND a primary nobody registers. The
    // first version stopped at the duplicate and spelled a call naming the
    // unknown primary — a call the tool refuses one step later. Both are
    // named now, and the call carries the placeholder. (Codex, round 10.)
    ['a duplicate AND a primary no registry knows', {
      vault: 'ghost', also: ['other', 'other'],
    }, [/other appears more than once/, /its primary ghost is not a vault this config file registers/,
      /vault: "<the primary vault you intend>", also: \["other"\]/]],
    // A PRESENT entry of the wrong type: something was written, and the
    // forgiving reading would have turned it into "no binding" and proposed
    // a primary over it.
    ['a string where the entry should be', 'work',
      [/the entry is not an object at all/, /vault: "<the primary vault you intend>", also: \[\]/]],
    // A SECONDARY this session cannot bind is named and KEPT in the call
    // (round 13 — round 12 left it out, which dropped its tier for good and
    // erased what another session's environment provided).
    ['a duplicate secondary no registry knows', { vault: 'work', also: ['gone', 'gone'] },
      [/gone appears more than once/, /its secondary gone is not a vault this config file lists/,
        /vault: "work", also: \["gone"\], ifBindingDigest/]],
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

  test('e2e — a COHERENT binding whose primary the file no longer lists is a repair, not a proposal', async () => {
    // Round 12: with no structural fault the proposal path went on minting
    // a proposal whose yes the writer then refused (the primary was gone from
    // the file), forever. The registry facts are asked whether or not the
    // entry is coherent.
    const vault = await startFakeVault();
    const { dir, configPath } = writeConfig(vault.port);
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      // A sibling removes `work` from the file (this session still knows it).
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      cfg.remoteVaults = cfg.remoteVaults.filter((r) => r.name !== 'work');
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
      const res = await read(rt, 2, 'sci');
      assert.equal(res.result?.isError, true, textOf(res));
      const text = textOf(res);
      assert.equal(res.result?._meta?.bindingProposal, undefined, `a proposal was minted over a primary the file lost:\n${text}`);
      assert.match(text, /its primary work is not a vault this config file registers/);
      assert.match(text, /vault: "<the primary vault you intend>", also: \[\]/);
    } finally { rt.kill(); }
  });

  test('e2e — a remote the ENVIRONMENT provides stays bindable, a remote the file dropped does not', async () => {
    // The closure of the exemption every remote had (carried as open since
    // round 5): `writerBindableNames` is the file's names plus the
    // environment's remotes, told apart by their `source`.
    const vault = await startFakeVault();
    const { dir, configPath } = writeConfig(vault.port);
    const rt = startRouter({
      configPath,
      cwd: dir,
      env: { VAULT_ENVR: JSON.stringify({ name: 'envr', baseUrl: `http://127.0.0.1:${vault.port}`, apiKey: API_KEY }) },
    });
    try {
      await handshake(rt);
      const ok = await rt.call(2, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { vault: 'work', also: ['envr'], open: false },
      });
      assert.ok(ok.result, JSON.stringify(ok));
      assert.notEqual(ok.result?.isError, true, `an environment-provided remote was refused:\n${textOf(ok)}`);
      // Now the file drops `other`; this session still knows it.
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      cfg.remoteVaults = cfg.remoteVaults.filter((r) => r.name !== 'other');
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
      const no = await rt.call(3, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { vault: 'work', also: ['envr', 'other'], open: false },
      });
      assert.equal(no.result?.isError, true, `a remote the file no longer lists was bound:\n${textOf(no)}`);
      assert.match(textOf(no), /"other" is not a registered vault/);
      // And the list of what CAN be bound does not cite the very name it
      // refuses (round 13).
      assert.ok(!/Registered vaults: [^.]*\bother\b/.test(textOf(no)), textOf(no));
    } finally { rt.kill(); }
  });

  test('e2e — a vault DISABLED after this session loaded it is refused as disabled, not as "not listed in the config file"', async () => {
    // Round 14: the writer's set lacks a disabled name, and the refusal read
    // that absence as "never registered, or removed since — register it",
    // for an exclusion no registration and no restart lifts.
    const vault = await startFakeVault();
    const { dir, configPath } = writeConfig(vault.port, { binding: { vault: 'work', also: [] } });
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      cfg.disabledVaults = ['other'];
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
      const res = await read(rt, 2, 'other');
      assert.equal(res.result?.isError, true, textOf(res));
      const text = textOf(res);
      assert.match(text, /DISABLED by `disabledVaults` in the router's config file/);
      assert.match(text, /registering it again or restarting lifts nothing/);
      assert.doesNotMatch(text, /not listed in the router's config file/);
      assert.equal(res.result?._meta?.bindingProposal, undefined, 'a disabled vault was proposed');
      // And adding it by name says the same thing.
      const add = await rt.call(3, 'tools/call', { name: 'confirm_workspace_binding', arguments: { vault: 'work', also: ['other'], open: false } });
      assert.equal(add.result?.isError, true, textOf(add));
      assert.match(textOf(add), /"other" is DISABLED by `disabledVaults`/);
      assert.doesNotMatch(textOf(add), /Register it first/);
      // AND A DISABLED PRIMARY IS A REPAIR, NOT A PROPOSAL — the session still
      // has it loaded, so "broken primary" (asked of the catalogue) would not
      // say so; the writer's set does.
      cfg.disabledVaults = ['other', 'work'];
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
      const sci = await read(rt, 4, 'sci');
      assert.equal(sci.result?.isError, true, textOf(sci));
      assert.match(textOf(sci), /its primary work is DISABLED by `disabledVaults`/);
      assert.match(textOf(sci), /vault: "<the primary vault you intend>"/);
      assert.equal(sci.result?._meta?.bindingProposal, undefined, 'a proposal was minted over a disabled primary');
    } finally { rt.kill(); }
  });

  test('e2e — a secondary another session\'s ENVIRONMENT provides is KEPT by a session that lacks it — accept and repair alike', async () => {
    // Scenario S3 of round 13. A (with VAULT_ENVR) binds `envr` as a
    // secondary. B, without the variable, cannot resolve `envr` — and round
    // 12 refused B's acceptance of an unrelated proposal for it, and spelled
    // B a repair that dropped it. Keeping is not adding: B carries it over.
    const vault = await startFakeVault();
    const { dir, configPath, key } = writeConfig(vault.port, {
      binding: { vault: 'work', also: ['envr', 'other', 'other'], alsoLocked: ['envr'] },
    });
    // B: no VAULT_ENVR in its environment.
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const res = await read(rt, 2, 'sci');
      const text = textOf(res);
      assert.match(text, /its secondary envr is not a vault this config file lists nor one this session's environment provides, and this session has not loaded it/);
      assert.match(text, /vault: "work", also: \["envr", "other"\], ifBindingDigest/);
      // THE DIGEST MUST BE EXTRACTED, or the call below runs WITHOUT the
      // precondition (JSON drops an undefined field) and this witness proves
      // an unconditional confirmation instead of the repair. (Codex, round 14,
      // angle E.)
      const digest = /ifBindingDigest: "([0-9a-f]{64})"/.exec(text)?.[1];
      assert.ok(digest, `no digest rendered in:\n${text}`);
      const repaired = await rt.call(3, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { vault: 'work', also: ['envr', 'other'], ifBindingDigest: digest, open: false },
      });
      assert.notEqual(repaired.result?.isError, true, `B could not keep A's environment secondary:\n${textOf(repaired)}`);
      // AND THE SUCCESS SAYS WHAT THE KEPT SECONDARY IS FROM HERE: declared,
      // tier kept, not answering — not "addressable by name" (round 14).
      const repairedJson = JSON.parse(textOf(repaired));
      assert.match(repairedJson.message, /"envr" stays declared in the binding \(tier kept\) but this session has not loaded it/);
      assert.match(repairedJson.message, /with "other" also bound and addressable by name/);
      assert.doesNotMatch(repairedJson.message, /"envr"[^.]*addressable by name/);
      assert.deepEqual(repairedJson.notLoadedHere, ['envr']);
      assert.deepEqual(repairedJson.also, ['envr', 'other']);
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')).workspaceBindings[key];
      assert.deepEqual(cfg.also, ['envr', 'other']);
      assert.deepEqual(cfg.alsoLocked, ['envr'], 'the kept secondary lost its strict tier');
      // And a proposal from B now, accepted by B, keeps it too.
      const res2 = await read(rt, 4, 'sci');
      const proposal = res2.result?._meta?.bindingProposal;
      assert.ok(proposal, textOf(res2));
      const yes = await rt.call(5, 'tools/call', { name: 'confirm_workspace_binding', arguments: { accept: proposal.proposalId, open: false } });
      assert.notEqual(yes.result?.isError, true, textOf(yes));
      const after = JSON.parse(fs.readFileSync(configPath, 'utf8')).workspaceBindings[key];
      assert.deepEqual(after.also, ['envr', 'other', 'sci']);
      assert.deepEqual(after.alsoLocked, ['envr']);
      // But B can never ADD a name it cannot bind.
      const add = await rt.call(6, 'tools/call', { name: 'confirm_workspace_binding', arguments: { vault: 'work', also: ['envr', 'other', 'sci', 'nowhere'], open: false } });
      assert.equal(add.result?.isError, true, textOf(add));
    } finally { rt.kill(); }
  });

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
