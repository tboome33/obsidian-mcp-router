/**
 * WHAT THE PHASES DO TO EACH OTHER — the fourth review round's repairs.
 *
 * Three adversarial rounds had already run on this lot, each on the diff of one
 * phase. The fourth received the assembled surface and a single question:
 * are there two mechanisms, written in two different phases, correct on their
 * own, that contradict each other once put together? It found four, and this
 * file is their witness. None of them could have been seen from one phase's
 * diff, and none of them made a single existing test go red — the suite was
 * 7004 green before the repairs and 7004 green after, which is the whole
 * reason these had to be written.
 *
 *   1. THE CONSENT WAS ASKED OF MEMORY. `accept` was taught in round three to
 *      read refusals from the FILE. The path that PROPOSES was left reading the
 *      in-memory Map, so a refusal a sibling session recorded did not silence
 *      it: this repository's signature shape, a fix that reaches only its first
 *      site, for the fourth time.
 *   2. TWO DEFINITIONS OF "THE SAME BINDING". The digest sorts the secondaries
 *      on purpose; the acceptance compared them position by position.
 *   3. A HALF-REFRESHED SESSION. The preflight adopted another process's
 *      binding and left this session's default vault and lock guard derived
 *      from the previous one.
 *   4. A PROPOSAL THE ACCEPTANCE WOULD REFUSE. A local vault the config file
 *      no longer lists cannot be bound, and was still being proposed.
 *
 * Everything below drives the real binary over MCP, except the last block,
 * which pins a predicate and its two readers.
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
import { bindingDigest, sameSecondarySet } from '../src/helpers/binding-proposal.mjs';
import { bindableVaultNames } from '../src/helpers/vault-slug.mjs';
import { homeSafeEnv } from './_home-safe-spawn.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(REPO, 'bin', 'obsidian-mcp-router.mjs');
const API_KEY = 'binding-cross-phase-key';

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

function writeConfig(port, { binding = 'default', refuse = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binding-cross-phase-'));
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
    remoteVaults: ['work', 'sci', 'other'].map(remote),
    defaultVault: 'work',
    vaultReach: 'declared',
    openVaults: [],
    ...(theBinding ? { workspaceBindings: { [key]: theBinding } } : {}),
    ...(refuse ? { workspaceRefusals: { [key]: { [refuse]: '2026-09-16' } } } : {}),
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

async function handshake(rt, name) {
  await rt.call(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name, version: '0' },
  });
  rt.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

const textOf = (res) => (res.result?.content || []).map((c) => c.text || '').join('\n');

/** Name an undeclared vault and hand back the whole refusal, proposal or not. */
const reach = (rt, id, vault) => rt.call(id, 'tools/call', {
  name: 'get_file',
  arguments: { vault, path: 'wiki/anything.md' },
});

describe('the consent is asked of the FILE, so a sibling session is heard', () => {
  // ► MUTATION WITNESS for both tests: put `this.workspaceRefusals` back in
  //   place of the file's refusals in src/registry.mjs, and exactly these two
  //   go red. Nothing in binding-proposal-e2e or binding-accept-e2e moves:
  //   every one of those runs a single router, where the in-memory Map and the
  //   file never disagree. That is why the defect survived three rounds.

  test('a refusal recorded by ANOTHER process stops this session PROPOSING, not just writing', async () => {
    const vault = await startFakeVault();
    const { dir, configPath } = writeConfig(vault.port);
    const a = startRouter({ configPath, cwd: dir });
    const b = startRouter({ configPath, cwd: dir });
    try {
      await handshake(a, 'A');
      await handshake(b, 'B');

      // A sees a normal proposal first — otherwise "no proposal" later could
      // mean the guard was never on.
      const before = await reach(a, 2, 'sci');
      assert.equal(before.result?.isError, true, textOf(before));
      assert.ok(before.result?._meta?.bindingProposal, `no proposal to begin with:\n${textOf(before)}`);

      // B says no, durably. A is never told.
      const no = await b.call(2, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { refuse: 'sci' },
      });
      assert.notEqual(no.result?.isError, true, textOf(no));

      const after = await reach(a, 3, 'sci');
      assert.equal(after.result?.isError, true, textOf(after));
      assert.equal(
        after.result?._meta?.bindingProposal,
        undefined,
        `a vault the user REFUSED was proposed again:\n${textOf(after)}`,
      );
      // And the prose is the refusal's own, not the inviting one.
      assert.match(textOf(after), /already REFUSED/);
      assert.doesNotMatch(textOf(after), /Bind this workspace to it/);
    } finally { a.kill(); b.kill(); }
  });

  test('...and a refusal WITHDRAWN by another process stops silencing this one', async () => {
    // The other direction, and the one a union of the two sources would miss:
    // reading the file has to REPLACE the stale answer, not be added to it.
    const vault = await startFakeVault();
    const { dir, configPath } = writeConfig(vault.port, { refuse: 'sci' });
    const a = startRouter({ configPath, cwd: dir });
    const b = startRouter({ configPath, cwd: dir });
    try {
      await handshake(a, 'A');
      await handshake(b, 'B');

      const before = await reach(a, 2, 'sci');
      assert.equal(before.result?.isError, true, textOf(before));
      assert.equal(before.result?._meta?.bindingProposal, undefined, textOf(before));

      const back = await b.call(2, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { retract: 'sci' },
      });
      assert.notEqual(back.result?.isError, true, textOf(back));

      const after = await reach(a, 3, 'sci');
      assert.equal(after.result?.isError, true, textOf(after));
      assert.ok(
        after.result?._meta?.bindingProposal,
        `the refusal was taken back and this session still refuses to propose:\n${textOf(after)}`,
      );
    } finally { a.kill(); b.kill(); }
  });

  test('a REFUSED vault on a GATED deployment is not told to use a verb that deployment forbids', async () => {
    // ► MUTATION WITNESS: put the gated branch back AFTER the refusal branch
    //   and only this goes red. The order is the whole content of the repair.
    const vault = await startFakeVault();
    const { dir, configPath } = writeConfig(vault.port, { refuse: 'sci' });
    const rt = startRouter({
      configPath,
      cwd: dir,
      env: { OBSIDIAN_ROUTER_USER_ID: 'guest' },
    });
    try {
      await handshake(rt, 'gated');
      const res = await reach(rt, 2, 'sci');
      assert.equal(res.result?.isError, true, textOf(res));
      assert.equal(res.result?._meta?.bindingProposal, undefined, textOf(res));
      assert.match(textOf(res), /shared deployment/);
      assert.doesNotMatch(
        textOf(res),
        /retract/,
        'the refusal advised a verb this deployment refuses like every other',
      );
    } finally { rt.kill(); }
  });
});

describe('adopting another session\'s binding adopts ALL of it', () => {
  test('a REFUSED acceptance leaves the default vault and the lock agreeing with the binding it loaded', async () => {
    // ► MUTATION WITNESS: make `adoptBinding` assign only `workspaceBinding`
    //   and `workspaceRefusals`, as the two refresh sites used to, and this
    //   goes red on the default vault. Nothing else in the suite moves.
    const vault = await startFakeVault();
    const { dir, configPath } = writeConfig(vault.port);
    const a = startRouter({ configPath, cwd: dir });
    const b = startRouter({ configPath, cwd: dir });
    try {
      await handshake(a, 'A');
      await handshake(b, 'B');

      const refusal = await reach(a, 2, 'sci');
      const proposal = refusal.result?._meta?.bindingProposal;
      assert.ok(proposal, textOf(refusal));

      // B re-binds the workspace elsewhere AND locks it. A's identifier dies
      // with that write, which is exactly what it is for.
      const moved = await b.call(2, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { vault: 'other', locked: true, open: false },
      });
      assert.notEqual(moved.result?.isError, true, textOf(moved));

      const yes = await a.call(3, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { accept: proposal.proposalId, open: false },
      });
      assert.equal(yes.result?.isError, true, `the dead identifier was applied:\n${textOf(yes)}`);

      // THE POINT: A has loaded B's binding. Everything A derives from a
      // binding must now come from THAT binding — not half from it and half
      // from the one A started with.
      const listed = await a.call(4, 'tools/call', { name: 'list_vaults', arguments: {} });
      const state = JSON.parse(textOf(listed));
      assert.equal(state.workspaceBinding?.vault, 'other', 'the binding was not adopted at all');
      assert.equal(
        state.defaultVault,
        'other',
        'the session reports one binding and routes unqualified calls to another',
      );
      assert.equal(
        state.lockedTo,
        'other',
        'the session REPORTS a lock it does not enforce — lockedTo is the only field the guard reads',
      );
    } finally { a.kill(); b.kill(); }
  });
});

describe('one definition of "the same binding", read by both halves', () => {
  // The window this closes — between the acceptance preflight and the write
  // lock — is microseconds wide and cannot be driven from outside the process.
  // So what is pinned is the INVARIANT rather than the race: the comparison
  // that decides whether to apply a yes must answer exactly what the digest
  // that mints the identifier answers. Two mechanisms, one question.
  const shuffles = [
    [['a', 'b'], ['b', 'a']],
    [['a', 'b', 'c'], ['c', 'a', 'b']],
    [[], []],
    [['solo'], ['solo']],
  ];
  for (const [left, right] of shuffles) {
    test(`${JSON.stringify(left)} and ${JSON.stringify(right)} are one binding to BOTH`, () => {
      const digestsAgree = bindingDigest({ vault: 'p', also: left })
        === bindingDigest({ vault: 'p', also: right });
      assert.equal(digestsAgree, true, 'the digest moved on a reorder');
      assert.equal(
        sameSecondarySet(left, right),
        digestsAgree,
        'the identifier says "unchanged" and the write says "changed"',
      );
    });
  }

  test('a genuine difference is a difference to both — including a DUPLICATE', () => {
    const pairs = [
      [['a'], ['a', 'b']],
      [['a'], ['a', 'a']],
      [['a', 'b'], ['a', 'c']],
    ];
    for (const [left, right] of pairs) {
      const digestsAgree = bindingDigest({ vault: 'p', also: left })
        === bindingDigest({ vault: 'p', also: right });
      assert.equal(digestsAgree, false, `the digest ignored ${JSON.stringify([left, right])}`);
      assert.equal(sameSecondarySet(left, right), false, JSON.stringify([left, right]));
    }
  });

  test('a non-list never throws and is never equal to a non-empty one', () => {
    assert.equal(sameSecondarySet(null, []), true);
    assert.equal(sameSecondarySet(undefined, ['a']), false);
    assert.equal(sameSecondarySet('ab', ['a', 'b']), false);
  });
});

describe('bindableVaultNames — one predicate, two readers', () => {
  // The asymmetry it closes: the live catalogue is WIDER than the file (it
  // keeps a vault a sibling session removed, and holds vaults the environment
  // alone provides), while a binding may only name what the file knows,
  // because the next start-up reads the file. The proposal was built from the
  // wide side and the acceptance checked the narrow one, so a perfectly valid
  // identifier led to a wall.
  const cfg = {
    portRegistry: { 'C:\\VAULTS\\Work': { securePort: 27100 } },
    vaultNames: { 'C:\\VAULTS\\Work': 'work' },
    remoteVaults: [{ name: 'far' }, { name: 42 }, {}],
  };

  test('it names the file\'s local vaults and its remote ones, and nothing else', () => {
    const names = bindableVaultNames(cfg);
    assert.equal(names.has('work'), true);
    assert.equal(names.has('far'), true);
    assert.equal(names.has('ghost'), false);
    assert.equal(names.size, 2, `unexpected names: ${[...names].join(', ')}`);
  });

  test('a config that is not one answers with an empty set rather than throwing', () => {
    for (const bad of [null, undefined, 42, 'nope', [], { remoteVaults: 'not-an-array' }]) {
      assert.equal(bindableVaultNames(bad).size, 0, JSON.stringify(bad));
    }
  });

  test('a LOCAL vault the file no longer lists is refused WITHOUT a proposal', async () => {
    // ► MUTATION WITNESS: delete the `bindableVaultNames` branch from
    //   resolveVault and only this goes red.
    //
    // No server and no HTTP: `resolveVault` resolves, it does not dial, and the
    // scope check comes before the API-key check (phase 1), so a vault with no
    // key on disk still reaches the refusal this is about.
    //
    // The sequence is the real one. A loads a config listing a local vault; a
    // sibling session removes it; A runs with `--no-watch` and keeps it in the
    // live catalogue for the rest of its life. Binding it would write a name
    // the next start-up cannot resolve, which is why the acceptance refuses it
    // — so proposing it hands out a yes that leads to a wall.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-phase-local-'));
    tmpDirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    const vaultPath = path.join(dir, 'Notes');
    fs.mkdirSync(vaultPath, { recursive: true });
    const withVault = (present) => ({
      portRegistry: present ? { [vaultPath]: { securePort: 27100 } } : {},
      vaultNames: present ? { [vaultPath]: 'notes' } : {},
      remoteVaults: [],
      vaultReach: 'declared',
      openVaults: [],
      workspaceBindings: {
        [canonicalWorkspaceKey(dir)]: {
          vault: 'notes-elsewhere', also: [], locked: false, confirmedVia: 'test',
        },
      },
    });

    fs.writeFileSync(configPath, JSON.stringify(withVault(true), null, 2), 'utf8');
    const { loadRegistry } = await import('../src/registry.mjs');
    const registry = await loadRegistry({ configPath });
    assert.ok(registry.vaults.some((v) => v.name === 'notes'), 'the fixture never registered the vault');

    // The sibling session removes it. This process is never told.
    fs.writeFileSync(configPath, JSON.stringify(withVault(false), null, 2), 'utf8');

    let err = null;
    try { registry.resolveVault('notes'); } catch (e) { err = e; }
    assert.ok(err, 'the vault resolved instead of being refused');
    assert.equal(err.bindingProposal, undefined, 'a vault that cannot be bound was proposed');
    assert.match(err.message, /through the environment, not/);
    assert.match(err.message, /setup-vault/);
  });

  test('BOTH readers call it — neither spells the question out again', () => {
    // The scan is the point. Asserting the behaviour at each site would pass
    // the day someone re-writes the expression by hand at a third one.
    const sites = ['src/registry.mjs', 'src/tools/workspace-binding.mjs'];
    for (const rel of sites) {
      const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
      assert.match(src, /bindableVaultNames\(/, `${rel} does not ask the shared predicate`);
      // The hand-spelled shape this replaced, in either of its two halves.
      const handSpelled = /registeredVaultPaths\([^)]*\)\s*\.map\(\s*\(?\s*vp\s*\)?\s*=>\s*vaultSlug/;
      if (rel !== 'src/registry.mjs') {
        assert.doesNotMatch(src, handSpelled, `${rel} still builds the set by hand`);
      }
    }
  });
});
