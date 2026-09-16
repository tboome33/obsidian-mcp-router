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
 * The first three blocks drive the real binary over MCP, two routers at a time
 * where the defect needs two. The last two are pure: one pins two definitions
 * of "the same binding" against each other, the other pins a predicate, its
 * readers, and a scan of the shipped tree.
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

  test('a refusal once READ survives a later unreadable config — the fallback is the last state SEEN', async () => {
    // ► MUTATION WITNESS: remove `this.workspaceRefusals = live.refusals` and
    //   only this goes red.
    //
    // The round-4 repair consulted the file and threw the answer away, so the
    // map it fell back to when a read failed was the one loaded at START-UP.
    // A refusal this session had already seen and honoured could be forgotten
    // by one corrupt read, and the vault offered again — under a comment
    // promising a refusal is never forgotten over a parse error. The fallback
    // must return the last state OBSERVED, not the oldest one held.
    const vault = await startFakeVault();
    const { dir, configPath } = writeConfig(vault.port);
    const a = startRouter({ configPath, cwd: dir });
    const b = startRouter({ configPath, cwd: dir });
    try {
      await handshake(a, 'A');
      await handshake(b, 'B');

      const no = await b.call(2, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { refuse: 'sci' },
      });
      assert.notEqual(no.result?.isError, true, textOf(no));

      // A READS the refusal from the file once.
      const seen = await reach(a, 2, 'sci');
      assert.equal(seen.result?._meta?.bindingProposal, undefined, textOf(seen));

      // The config becomes unparseable. A's fresh read now fails on every call.
      const good = fs.readFileSync(configPath, 'utf8');
      fs.writeFileSync(configPath, `${good.slice(0, Math.floor(good.length / 2))}`, 'utf8');
      try {
        const again = await reach(a, 3, 'sci');
        assert.equal(again.result?.isError, true, textOf(again));
        assert.equal(
          again.result?._meta?.bindingProposal,
          undefined,
          `an unreadable config resurrected a vault this session had already seen REFUSED:\n${textOf(again)}`,
        );
        assert.match(textOf(again), /already REFUSED/);
      } finally {
        fs.writeFileSync(configPath, good, 'utf8');
      }
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
  test('a REFUSED acceptance changes what the session KNOWS and not where it ROUTES', async () => {
    // ► MUTATION WITNESS: call `adoptRouting` from the preflight, as round 4
    //   did, and this goes red on the default vault.
    //
    // THIS TEST ASSERTED THE OPPOSITE UNTIL ROUND 6, and that is the point
    // worth keeping. Round 4 found the session half-refreshed and concluded
    // the refresh should be WIDER — default vault and lock included. Rounds 5
    // and 6 each found a blocker inside that conclusion, because the preflight
    // runs on a call that may refuse: it was moving where unqualified calls go
    // and which vaults answer at all, on the way to writing nothing. The
    // correct split is narrower, not wider — knowledge follows the file on any
    // path, routing waits for a successful write — and this witness now pins
    // that. A test can be green, mutation-killed and still wrong about what it
    // wants; only a later round says so.
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

      // KNOWLEDGE followed the file: A now reports B's binding, so the advice
      // "re-run the refused call and read what comes back" is true.
      const listed = await a.call(4, 'tools/call', { name: 'list_vaults', arguments: {} });
      const state = JSON.parse(textOf(listed));
      assert.equal(state.workspaceBinding?.vault, 'other', 'the binding was not adopted at all');
      assert.equal(state.workspaceBinding?.locked, true, 'the binding was adopted without its lock flag');

      // ROUTING did not move, because nothing was written.
      assert.equal(
        state.defaultVault,
        'work',
        'a call that wrote nothing moved where unqualified calls go',
      );
      assert.equal(
        state.lockedTo,
        null,
        'a call that wrote nothing imposed an isolation the user never asked for',
      );
    } finally { a.kill(); b.kill(); }
  });

  test('a REFUSED acceptance does NOT lift a lock this session asked for itself', async () => {
    // ► MUTATION WITNESS: change the release back to `else if
    //   (registry.lockedVault)` — the mechanism copied without its guard — and
    //   only this goes red.
    //
    // The defect this pins is the shape this repository keeps paying for: the
    // `clear` path has tested `lockSource.origin === 'binding'` since an
    // earlier round, precisely because a volatile `lock_vault` lock "is not
    // this call's to lift". The round-4 adopter copied the release and left
    // the test behind — and then ran it on a PREFLIGHT, so a call that goes on
    // to FAIL was silently dropping an isolation the user had asked for.
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

      // A locks itself, volatile — nothing to do with the binding.
      const locked = await a.call(3, 'tools/call', {
        name: 'lock_vault',
        arguments: { vault: 'work' },
      });
      assert.notEqual(locked.result?.isError, true, textOf(locked));
      const before = JSON.parse(textOf(await a.call(4, 'tools/call', { name: 'list_vaults', arguments: {} })));
      assert.equal(before.lockedTo, 'work', 'the fixture never locked');
      assert.notEqual(before.lockSource?.origin, 'binding', 'the fixture locked by BINDING, not by lock_vault');

      // B moves the binding, leaving it UNLOCKED. A's identifier dies with it.
      const moved = await b.call(2, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { vault: 'other', open: false },
      });
      assert.notEqual(moved.result?.isError, true, textOf(moved));

      const yes = await a.call(5, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { accept: proposal.proposalId, open: false },
      });
      assert.equal(yes.result?.isError, true, `the dead identifier was applied:\n${textOf(yes)}`);

      const after = JSON.parse(textOf(await a.call(6, 'tools/call', { name: 'list_vaults', arguments: {} })));
      assert.equal(
        after.lockedTo,
        'work',
        'a FAILED acceptance lifted a lock this session had asked for with lock_vault',
      );
    } finally { a.kill(); b.kill(); }
  });

  test('ROUTING is adopted from exactly one place, and that place is after the write', () => {
    // ► THE INVARIANT THE WHOLE SPLIT RESTS ON, so it is pinned by a scan
    //   rather than left to discipline. Rounds 5 and 6 each found a blocker
    //   that existed only because routing state moved on a path that could
    //   still refuse; round 6's was a lock released for a binding the session
    //   could not even apply. Both become unreachable once `adoptRouting` has
    //   a single caller and that caller runs after a successful write — which
    //   is a structural fix, not a guarded branch, and structural fixes need a
    //   witness that the structure holds.
    const src = fs.readFileSync(path.join(REPO, 'src/tools/workspace-binding.mjs'), 'utf8');
    const lines = src.split('\n').map((line, i) => [i + 1, line]);
    const code = lines.filter(([, line]) => !/^\s*(\*|\/\/)/.test(line));
    const defs = code.filter(([, line]) => /const adoptRouting\s*=/.test(line));
    const uses = code.filter(([, line]) => /(?<![\w.])adoptRouting\s*\(/.test(line)
      && !/const adoptRouting\s*=/.test(line));
    assert.equal(defs.length, 1, `expected one definition, found ${defs.length}`);
    assert.equal(
      uses.length,
      1,
      `routing is adopted from ${uses.length} places: lines ${uses.map(([n]) => n).join(', ')}`,
    );

    // And that one call sits AFTER the write, which here means after the
    // config transform returned — the line that produces `next`.
    const writeLine = src.split('\n').findIndex((line) => /const next = updateConfigBindings\(/.test(line)) + 1;
    assert.ok(writeLine > 0, 'the write site moved; this scan no longer knows where it is');
    assert.ok(
      uses[0][0] > writeLine,
      `routing is adopted at line ${uses[0][0]}, before the write at line ${writeLine}`,
    );

    // POSITIVE CONTROL: the pattern finds the calls it is meant to find, and
    // would find a second one. A scan whose regex is dead reads exactly like a
    // structure that holds.
    assert.match('    adoptRouting(previous);', /(?<![\w.])adoptRouting\s*\(/);
    assert.doesNotMatch('    thing.adoptRouting(previous);', /(?<![\w.])adoptRouting\s*\(/);
  });

  test('a binding CLEARED elsewhere is KNOWN at once, and leaves the repair path armed', async () => {
    // ► MUTATION WITNESS: make the preflight skip `adoptKnowledge` and this
    //   goes red on the adopted binding.
    //
    // ROUND 5 MADE THIS BRANCH SET `defaultVaultSource` TO "unknown", AND THAT
    // WAS WRONG TWICE OVER. It erased a provenance the router actually knew,
    // while the session went on routing by that very default — "I cannot say"
    // is not more honest than a wrong answer when you are still acting on the
    // answer. Worse, it DISARMED the next repair: `clear` re-runs the cascade
    // only when the source still reads "binding", so relabelling it meant a
    // later `clear` walked past the stale default it exists to fix. A refusing
    // call does not repair routing; it must leave the repair possible.
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

      const cleared = await b.call(2, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { clear: true },
      });
      assert.notEqual(cleared.result?.isError, true, textOf(cleared));

      const yes = await a.call(3, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { accept: proposal.proposalId, open: false },
      });
      assert.equal(yes.result?.isError, true, textOf(yes));

      const state = JSON.parse(textOf(await a.call(4, 'tools/call', { name: 'list_vaults', arguments: {} })));
      assert.equal(state.workspaceBinding, null, 'the cleared binding was not adopted');
      // Routing is untouched by a call that wrote nothing...
      assert.equal(state.defaultVault, 'work', 'a refused acceptance moved the default vault');
      // ...and the source still reads "binding", which is what keeps `clear`
      // able to re-run the cascade. Asserting this is asserting that the
      // repair path is still armed; `unknown` here would disarm it silently.
      assert.equal(
        state.defaultVaultSource?.origin,
        'binding',
        'the source was relabelled, so a later clear will walk past this stale default',
      );

      // AND THE REPAIR REALLY WORKS. Measuring it beats asserting the label:
      // `clear` is the call that repairs routing, and after it the default is
      // whatever the cascade says — here nothing at all, because clearing the
      // binding leaves `vaultReach: "declared"` with an empty `openVaults`.
      const cleanup = await a.call(5, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { clear: true },
      });
      assert.notEqual(cleanup.result?.isError, true, textOf(cleanup));
      const after = JSON.parse(textOf(await a.call(6, 'tools/call', { name: 'list_vaults', arguments: {} })));
      if (after.defaultVault === undefined || after.defaultVault === null) {
        assert.equal(after.defaultVaultSource?.origin, 'unset', 'no default, but a source that claims one');
      } else {
        assert.ok(
          (after.vaults || []).some((v) => v.name === after.defaultVault),
          `after the repair the default "${after.defaultVault}" is not one this session can resolve`,
        );
      }
    } finally { a.kill(); b.kill(); }
  });
});

describe('one definition of "the same binding", read by both halves', () => {
  // The window this closes sits between the acceptance preflight and the write
  // lock. Driving it would need a synchronisation point inside the tool — a
  // seam that does not exist today and that is not worth adding for one race —
  // so what is pinned here is the INVARIANT rather than the interleaving: the
  // comparison that decides whether to apply a yes must answer exactly what the
  // digest that mints the identifier answers. Two mechanisms, one question. The
  // last test of this block is what keeps the decision SITE asking it; the ones
  // before it only keep the two definitions agreeing.
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

  test('and the DECISION SITE calls it — the tests above guard the utility, not the repair', () => {
    // ► THE WITNESS THAT WAS MISSING, and the review named it before it bit:
    //   every assertion above calls `sameSecondarySet` and `bindingDigest`
    //   DIRECTLY. Put the positional comparison back at the call site inside
    //   the write lock and they all stay green — the helper would keep its
    //   promise while the code that decides had stopped asking it. A mutation
    //   aimed at the helper proves the helper; the repair lives at the site.
    const src = fs.readFileSync(path.join(REPO, 'src/tools/workspace-binding.mjs'), 'utf8');
    assert.match(
      src,
      /!sameSecondarySet\(\s*onDisk\.also\s*,\s*also\s*\)/,
      'the in-lock check no longer asks the shared predicate',
    );
    // And the shape it replaced must not come back beside it: an index
    // comparison over the two lists, whatever the callback's parameters are
    // named.
    assert.doesNotMatch(
      src,
      /onDisk\.also\.some\(/,
      'the in-lock check compares the secondaries positionally again',
    );
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
      // NO BINDING ENTRY, AND THAT IS DELIBERATE. The first version wrote one
      // under `canonicalWorkspaceKey(dir)`, which this process never adopts:
      // `loadRegistry` reads `process.cwd()`, and passing `configPath` does not
      // change it. The fixture's binding was inert, so the test claimed a
      // situation it had not built. With no binding at all the workspace
      // declares nothing, `vaultReach: "declared"` refuses the vault, and the
      // branch under test is reached honestly. (Codex, round 5.)
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
    // THE MESSAGE MUST NAME WHAT IS KNOWN, NOT A CAUSE IT GUESSED. The first
    // version of this assertion required the words "visible only through the
    // environment" — false in this very fixture, where the file listed the
    // vault and a sibling removed it. A test that demands a wrong explanation
    // is how a wrong explanation survives a review. (Codex, round 5.)
    assert.match(err.message, /not listed in the router's config file/);
    assert.match(err.message, /removed since this session started/);
    assert.doesNotMatch(err.message, /only through the environment/);
    assert.match(err.message, /setup-vault/);
  });

  test('the WHOLE shipped tree builds this set in exactly one place', () => {
    // A SCAN WITH AN EXEMPTION IS UNTESTED CODE, and the first version had two:
    // it looked at two named files only, and it excused `src/registry.mjs` from
    // the hand-spelled check. It was also defeated by renaming one callback
    // parameter, which is the classic way a name-keyed guard walks past the
    // thing it was written for. (Codex, round 5.)
    //
    // So the question is asked of the tree, and asked by SHAPE rather than by
    // spelling: anywhere a registered-path list is mapped through `vaultSlug`,
    // that is this set being rebuilt by hand. `bindableVaultNames` itself is
    // the one legitimate site, named exactly, with its reason.
    const OWNER = 'src/helpers/vault-slug.mjs';
    const roots = ['src', 'hooks', 'scripts', 'bin'];
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(full);
      }
    };
    for (const root of roots) {
      const full = path.join(REPO, root);
      if (fs.existsSync(full)) walk(full);
    }
    assert.ok(files.length > 50, `the walk found only ${files.length} files — it is not scanning`);

    // THE PATTERN NAMES THE SET, NOT THE ENUMERATION, and getting that wrong
    // the first time is the point worth keeping. A scan for "registered paths
    // mapped through vaultSlug" flagged FOUR honest sites — a collision check
    // at registration, the hooks' permitted-vault set, and two config
    // generators — because enumerating vault names is an ordinary thing to do.
    // A guard that shouts at every neighbour teaches people to silence it.
    //
    // What is unique to THIS question is the UNION: the local names and the
    // remote names gathered into one set, which is the set a workspace binding
    // may name. `[^]` rather than `.` so a construction wrapped over several
    // lines is caught too.
    const rebuildsByHand = /new Set\(\[[^]{0,400}?registeredVaultPaths\([^]{0,400}?remoteVaults[^]{0,200}?\]\)/;
    const offenders = [];
    for (const file of files) {
      const rel = path.relative(REPO, file).split(path.sep).join('/');
      if (rel === OWNER) continue;
      const src = fs.readFileSync(file, 'utf8');
      if (rebuildsByHand.test(src)) offenders.push(rel);
    }
    assert.deepEqual(offenders, [], `these rebuild the bindable-name set by hand: ${offenders.join(', ')}`);

    // TWO POSITIVE CONTROLS, because a dead pattern reads exactly like a clean
    // tree. First the owner: the one site that legitimately holds the shape.
    assert.match(
      fs.readFileSync(path.join(REPO, OWNER), 'utf8'),
      rebuildsByHand,
      'the scan pattern no longer matches even its own owner — it cannot catch anything',
    );
    // Then a probe built here, in the spelling an offender would most plausibly
    // use: different callback parameter, different formatting, same question.
    const probe = [
      'const fileNames = new Set([',
      '  ...registeredVaultPaths(config).map((entry) => vaultSlug(config, entry)),',
      '  ...(Array.isArray(config.remoteVaults) ? config.remoteVaults : [])',
      '    .map((r) => r?.name).filter(Boolean),',
      ']);',
    ].join('\n');
    assert.match(probe, rebuildsByHand, 'the scan would walk past a hand-built copy of the set');

    // Both readers ask for it by name.
    for (const rel of ['src/registry.mjs', 'src/tools/workspace-binding.mjs']) {
      const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
      assert.match(src, /bindableVaultNames\(/, `${rel} does not ask the shared predicate`);
    }
  });
});
