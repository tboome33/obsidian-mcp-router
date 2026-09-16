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

import { canonicalWorkspaceKey, normalizeBinding } from '../src/helpers/workspace-bindings.mjs';
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

describe('the duplicate incoherence is ABSORBED, not diagnosed — and this is the tripwire', () => {
  // Phase 6 of the roadmap asked for a diagnostic when a vault sits in a
  // binding TWICE — as primary and as a secondary, or twice in `also`. The
  // measurement says that state cannot reach the proposal code: every binding
  // becomes one through `normalizeBinding`, whose `seen` set STARTS with the
  // primary, so the duplicate is gone before anyone can be confused by it.
  //
  // Absorbing is the right answer here, and not a dodge. A duplicate has ONE
  // unambiguous meaning — that vault is a secondary — so repairing it silently
  // at the single boundary where a config becomes a binding costs nothing,
  // while refusing the call would turn an obvious typo into a wall. Contrast
  // the primary that is ABSENT from the registry, which has no unambiguous
  // repair and IS diagnosed (see binding-proposal-e2e).
  //
  // ► SO THIS IS A TRIPWIRE, not a behaviour test. The day `normalizeBinding`
  //   stops deduplicating, the state becomes reachable, `bindingDigest` starts
  //   seeing it (it deliberately does NOT deduplicate), and the proposal code
  //   needs the diagnostic phase 6 described. These assertions are what will
  //   say so.
  const shapes = [
    ['the primary also listed as a secondary', { vault: 'work', also: ['work', 'sci'] }],
    ['a duplicate inside also', { vault: 'work', also: ['sci', 'sci'] }],
    ['both at once, repeatedly', { vault: 'work', also: ['work', 'sci', 'sci', 'work'] }],
  ];
  for (const [name, raw] of shapes) {
    test(`${name} is cleaned to a coherent binding`, () => {
      const n = normalizeBinding(raw);
      assert.deepEqual(n.also, ['sci'], `got ${JSON.stringify(n.also)}`);
      assert.ok(!n.also.includes(n.vault), 'the primary survived inside also');
      assert.equal(new Set(n.also).size, n.also.length, 'a duplicate survived');
    });
  }

  test('a write tier naming something that is not a secondary is dropped, and a name in BOTH tiers is LOCKED', () => {
    // The hard tier wins a conflict, exactly as it does for the global lists —
    // the safe direction, and the one the decision names.
    assert.deepEqual(normalizeBinding({ vault: 'work', also: ['sci'], alsoLocked: ['ghost'] }).alsoLocked, []);
    const both = normalizeBinding({ vault: 'work', also: ['sci'], alsoLocked: ['sci'], alsoWritable: ['sci'] });
    assert.deepEqual(both.alsoLocked, ['sci']);
    assert.deepEqual(both.alsoWritable, []);
  });

  test('so a proposal built from an incoherent config is still coherent, end to end', async () => {
    // The consequence that matters: the prose can never read "the primary stays
    // work" while `work` is also listed as a secondary of itself.
    const vault = await startFakeVault();
    const { dir, configPath } = writeConfig(vault.port, {
      binding: {
        vault: 'work',
        also: ['work', 'other', 'other'],
        locked: false,
        confirmedAt: '2026-09-16',
        confirmedVia: 'test',
      },
    });
    const rt = startRouter({ configPath, cwd: dir });
    try {
      await handshake(rt);
      const res = await read(rt, 2, 'sci');
      assert.equal(res.result?.isError, true);
      const proposal = res.result?._meta?.bindingProposal;
      assert.ok(proposal, textOf(res));
      assert.equal(proposal.proposedRole, 'secondary');
      assert.equal(proposal.currentPrimary, 'work');
      assert.match(textOf(res), /the primary stays work/);
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
    // never produces. "Secondary of nothing" is not an answer, so these read as
    // "no binding" and the proposal is for a primary.
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
