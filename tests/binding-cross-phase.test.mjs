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

describe('a call that writes nothing leaves this session alone', () => {
  test('a REFUSED acceptance leaves this session exactly as it found it', async () => {
    // ► MUTATION WITNESS: install the file's binding in the preflight, as
    //   rounds 4 to 6 did, and this goes red on the binding and on the
    //   unqualified call.
    //
    // THIS TEST HAS NOW ASSERTED THREE DIFFERENT THINGS, and that history is
    // the most useful thing in the file. Round 4 found the session
    // half-refreshed and made the refresh WIDER: default vault and lock too.
    // Round 5 found a blocker in that. Round 6 found another, split the
    // refresh, and had this test demand that the BINDING still be adopted.
    // Round 7 showed that was wrong too: `registry.workspaceBinding` is not
    // knowledge — the reachability gate reads it on every call — so installing
    // a sibling's binding from a path that then refuses changes which vaults
    // answer, and can leave the default vault undeclared by the binding just
    // adopted. A refusal now changes nothing here at all except the refusals
    // this session has seen.
    //
    // Three rounds, three green mutation-killed versions of one test, two of
    // them wanting the wrong thing. A test proves only what someone thought to
    // want.
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

      // NOTHING OF THIS SESSION MOVED. Not the binding — which is what decides
      // reachability — not the default vault, not the lock.
      const listed = await a.call(4, 'tools/call', { name: 'list_vaults', arguments: {} });
      const state = JSON.parse(textOf(listed));
      assert.equal(
        state.workspaceBinding?.vault,
        'work',
        'a call that wrote nothing installed another session\'s binding, changing which vaults answer',
      );
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
      // AND THE SESSION STILL WORKS. This is the assertion the previous two
      // versions of this test were missing, and it is the one that catches the
      // defect round 7 found: adopting the binding left `defaultVault` naming a
      // vault the adopted binding no longer declared, so the next unqualified
      // call failed where it had worked. Measuring the call beats asserting
      // the fields.
      const unqualified = await a.call(5, 'tools/call', {
        name: 'get_file',
        arguments: { path: 'wiki/anything.md' },
      });
      assert.notEqual(
        unqualified.result?.isError,
        true,
        `a refused acceptance broke this session's unqualified calls:\n${textOf(unqualified)}`,
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

  test('NO OTHER TOOL re-routes on a call that wrote nothing either', async () => {
    // ► MUTATION WITNESS: put `if (binding)` back in place of the `wrote &&
    //   resolvable` guard in src/tools/set-secondary-vault-mode.mjs, and only
    //   this goes red. It survived the round-7 mutation run until this test
    //   was written — the repair was real and had no witness, which is exactly
    //   the state a later round finds and calls a regression.
    //
    // The rule the binding lot arrived at is not local to one tool: a call
    // that changes nothing on disk must not change where this session routes,
    // and must not install a sibling's binding, because the reachability gate
    // reads it. `set_secondary_vault_mode` has a genuine no-op — asking for
    // the mode a secondary already has — and it was adopting the file's
    // primary as this session's default anyway.
    const vault = await startFakeVault();
    const { dir, configPath } = writeConfig(vault.port, {
      binding: {
        vault: 'work', also: ['sci'], locked: false, confirmedAt: '2026-09-17', confirmedVia: 'test',
      },
    });
    const a = startRouter({ configPath, cwd: dir });
    const b = startRouter({ configPath, cwd: dir });
    try {
      await handshake(a, 'A');
      await handshake(b, 'B');

      // B re-binds the workspace to another primary, keeping `sci` a secondary
      // so the no-op below still validates.
      const moved = await b.call(2, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { vault: 'other', also: ['sci'], open: false },
      });
      // ASSERTED ON THE RESULT, NOT ON THE ABSENCE OF A FLAG. `notEqual(...,
      // true)` is satisfied by a JSON-RPC error, which has no `result` at all
      // — so a fixture that silently failed to set the scene would leave this
      // test green for the wrong reason, which is the ninth time that shape
      // has come up in this lot. (Codex, round eight.)
      assert.ok(moved.result, `B's re-bind returned no result: ${JSON.stringify(moved.error)}`);
      assert.notEqual(moved.result.isError, true, textOf(moved));

      // AND THE SCENE IS MEASURED, not assumed. The whole test rests on the
      // file naming `other` as primary and `sci` as a SOFT secondary; if
      // either were false the no-op below would prove nothing.
      const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'))
        .workspaceBindings?.[canonicalWorkspaceKey(dir)];
      assert.equal(onDisk?.vault, 'other', `the fixture did not re-bind: ${JSON.stringify(onDisk)}`);
      assert.ok((onDisk?.also || []).includes('sci'), 'sci is not a secondary, so the call below is not a no-op');
      assert.ok(!(onDisk?.alsoLocked || []).includes('sci'), 'sci is locked, so asking for soft WOULD write');
      assert.ok(!(onDisk?.alsoWritable || []).includes('sci'), 'sci is writable, so asking for soft WOULD write');
      const bytesBefore = fs.readFileSync(configPath, 'utf8');

      // A asks for the tier `sci` ALREADY has: nothing is written.
      const noop = await a.call(2, 'tools/call', {
        name: 'set_secondary_vault_mode',
        arguments: { vault: 'sci', mode: 'soft' },
      });
      assert.ok(noop.result, `the no-op returned no result: ${JSON.stringify(noop.error)}`);
      assert.notEqual(noop.result.isError, true, textOf(noop));
      assert.equal(fs.readFileSync(configPath, 'utf8'), bytesBefore, 'the "no-op" rewrote the config');

      const state = JSON.parse(textOf(await a.call(3, 'tools/call', { name: 'list_vaults', arguments: {} })));
      assert.equal(
        state.defaultVault,
        'work',
        'a no-op set_secondary_vault_mode re-routed this session to the sibling\'s primary',
      );
      assert.equal(
        state.workspaceBinding?.vault,
        'work',
        'a no-op installed another session\'s binding, changing which vaults answer',
      );

      // The answer names what THIS session applies. Here the two agree — the
      // session also holds `sci` as a soft secondary — so there is nothing to
      // warn about, and the warning must NOT fire.
      const said = JSON.parse(textOf(noop));
      assert.equal(said.modeInForceHere, 'soft', 'the answer does not say what this session applies');
      assert.doesNotMatch(textOf(noop), /did not adopt that binding/, 'warned about a difference that is not there');

      // ► AND WHEN THEY DISAGREE, IT SAYS SO. Keeping the session still is
      //   right; reporting the FILE's mode as though it were in force here is
      //   not. The sibling now LOCKS `sci` in the file. A asks for `locked`:
      //   the file already says so, nothing is written, nothing is adopted —
      //   and this session still applies `soft`. Silence there is the same lie
      //   the write path had, one door over. (Codex, round nine, the
      //   report-versus-state pass.)
      const locked = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      locked.workspaceBindings[canonicalWorkspaceKey(dir)].alsoLocked = ['sci'];
      fs.writeFileSync(configPath, JSON.stringify(locked, null, 2), 'utf8');

      const second = await a.call(4, 'tools/call', {
        name: 'set_secondary_vault_mode',
        arguments: { vault: 'sci', mode: 'locked' },
      });
      assert.ok(second.result, JSON.stringify(second.error));
      assert.notEqual(second.result.isError, true, textOf(second));
      const secondSaid = JSON.parse(textOf(second));
      assert.equal(secondSaid.mode, 'locked', 'the fixture did not ask for locked');
      assert.equal(
        secondSaid.modeInForceHere,
        'soft',
        'the answer claims this session applies a restriction it does not hold',
      );
      assert.match(
        textOf(second),
        /did not adopt that binding/,
        'a no-op reported a restriction as in force without saying this session had not adopted it',
      );
    } finally { a.kill(); b.kill(); }
  });

  test('inside confirm_workspace_binding, routing is adopted from exactly one place, after the write', () => {
    // ► THE INVARIANT THE SPLIT RESTS ON, pinned by a scan rather than left to
    //   discipline. Rounds 5 and 6 each found a blocker that existed only
    //   because routing state moved on a path that could still refuse.
    //
    //   ITS TITLE USED TO SAY "ROUTING is adopted from exactly one place",
    //   which was false at the scale it implied: this scan reads ONE FILE, and
    //   `lock.mjs` and `set-secondary-vault-mode.mjs` write the same fields.
    //   Those two are held by their own witnesses (the no-op test above, and
    //   the pair in registry.test.mjs); this one is about this tool. A test
    //   whose name claims more than it checks is how a gap reads as covered.
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

  test('the stale-proposal loop is broken at its SOURCE — the proposal is minted from the file', async () => {
    // ► MUTATION WITNESS: mint the proposal from `this.workspaceBinding`
    //   instead of the file's binding in `resolveVault`, and this goes red —
    //   the second identifier comes back identical to the first.
    //
    // THE LOOP, AND WHY IT MOVED. Rounds 2 and 3 found that a session could be
    // stuck forever: the proposal was minted from this session's stale copy,
    // so the identifier was already dead when it was handed out, the yes was
    // refused, and re-running produced the same dead identifier. They fixed it
    // by having the acceptance INSTALL the file's binding. Round 7 showed that
    // cure was worse than the disease — installing a binding silently changes
    // which vaults answer. So the loop is closed at the other end instead:
    // `resolveVault` reads the file to build the proposal, and installs
    // nothing. The advice "re-run and read what comes back" stays true, and no
    // session state moves to make it true.
    const vault = await startFakeVault();
    const { dir, configPath } = writeConfig(vault.port);
    const a = startRouter({ configPath, cwd: dir });
    const b = startRouter({ configPath, cwd: dir });
    try {
      await handshake(a, 'A');
      await handshake(b, 'B');

      const first = await reach(a, 2, 'sci');
      const before = first.result?._meta?.bindingProposal;
      assert.ok(before, textOf(first));

      // B moves the binding. A's identifier dies with it, and A is not told.
      const moved = await b.call(2, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { vault: 'work', also: ['other'], open: false },
      });
      assert.notEqual(moved.result?.isError, true, textOf(moved));

      const yes = await a.call(3, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { accept: before.proposalId, open: false },
      });
      assert.equal(yes.result?.isError, true, `a dead identifier was applied:
${textOf(yes)}`);

      // THE POINT: re-running the refused ACCESS mints a proposal against the
      // file, so the identifier is a new one and the yes can now land.
      const second = await reach(a, 4, 'sci');
      const after = second.result?._meta?.bindingProposal;
      assert.ok(after, `no fresh proposal after the refusal:
${textOf(second)}`);
      assert.notEqual(
        after.proposalId,
        before.proposalId,
        'the same dead identifier came back — the loop rounds 2 and 3 closed is open again',
      );
      assert.equal(after.currentPrimary, 'work', 'the fresh proposal was not minted from the file');

      // And it WORKS: the loop is broken because the yes is accepted, not
      // merely because a string differs.
      const applied = await a.call(5, 'tools/call', {
        name: 'confirm_workspace_binding',
        arguments: { accept: after.proposalId, open: false },
      });
      assert.notEqual(applied.result?.isError, true, `the fresh identifier was refused too:
${textOf(applied)}`);
      const written = JSON.parse(fs.readFileSync(configPath, 'utf8'))
        .workspaceBindings?.[canonicalWorkspaceKey(dir)];
      assert.ok((written?.also || []).includes('sci'), `sci was not added: ${JSON.stringify(written)}`);
      assert.ok((written?.also || []).includes('other'), 'the sibling secondary was dropped');
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

  test('a RESTRICTION this session records is a restriction this session APPLIES', async () => {
    // ► MUTATION WITNESS: gate the adoption on the primary being resolvable,
    //   as round 8 did, and this goes red.
    //
    // THE WORST SHAPE THIS LOT PRODUCED, and it survived a round because it
    // looked like caution. Round 8 refused to adopt a binding whose primary
    // this session cannot resolve. For the tool that records a secondary's
    // WRITE TIER, that means: the user asks to lock `sci` read-only, the tier
    // is written to the file, the tool confirms it — and this session keeps an
    // older binding in which `sci` is still WRITABLE. A restriction asked for,
    // confirmed, and not in force. Security is not a place for a guard that
    // fails open. (Codex, round nine, both passes converging.)
    const vault = await startFakeVault();
    const { dir, configPath } = writeConfig(vault.port, {
      binding: {
        vault: 'work',
        also: ['sci'],
        alsoWritable: ['sci'],
        locked: false,
        confirmedAt: '2026-09-17',
        confirmedVia: 'test',
      },
    });
    const a = startRouter({ configPath, cwd: dir });
    const b = startRouter({ configPath, cwd: dir });
    try {
      await handshake(a, 'A');
      await handshake(b, 'B');

      // A can write to `sci` today: it is a writable secondary.
      const before = await a.call(2, 'tools/call', { name: 'list_vaults', arguments: {} });
      assert.ok(before.result, JSON.stringify(before.error));
      assert.ok(
        (JSON.parse(textOf(before)).workspaceBinding?.alsoWritable || []).includes('sci'),
        'the fixture did not start with sci writable',
      );

      // A SIBLING REGISTERS A NEW VAULT AND BINDS TO IT. Written to the file
      // directly, because that is what the other process does and because the
      // point is precisely a vault A's catalogue has never heard of: A loaded
      // its vault list at start-up and, with hot-reload off, never revisits
      // it. Re-binding to a vault A already knew would leave the guard under
      // test unexercised — the first version of this witness did exactly that
      // and survived its mutation.
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      cfg.remoteVaults.push({
        name: 'later', baseUrl: `http://127.0.0.1:${vault.port}`, apiKey: API_KEY, timeoutMs: 5000,
      });
      cfg.workspaceBindings[canonicalWorkspaceKey(dir)] = {
        vault: 'later',
        also: ['sci'],
        alsoWritable: ['sci'],
        locked: false,
        confirmedAt: '2026-09-17',
        confirmedVia: 'test',
      };
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');

      // A now LOCKS `sci` read-only. This writes.
      const locked = await a.call(3, 'tools/call', {
        name: 'set_secondary_vault_mode',
        arguments: { vault: 'sci', mode: 'locked' },
      });
      assert.ok(locked.result, JSON.stringify(locked.error));
      assert.notEqual(locked.result.isError, true, textOf(locked));

      const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'))
        .workspaceBindings?.[canonicalWorkspaceKey(dir)];
      assert.ok((onDisk?.alsoLocked || []).includes('sci'), 'the tier was not written to the file');

      // ► THE POINT: A's own session must hold that restriction too.
      const after = JSON.parse(textOf(await a.call(4, 'tools/call', { name: 'list_vaults', arguments: {} })));
      assert.ok(
        (after.workspaceBinding?.alsoLocked || []).includes('sci'),
        'the restriction was written and confirmed but this session did not apply it',
      );
      assert.ok(
        !(after.workspaceBinding?.alsoWritable || []).includes('sci'),
        'this session still holds sci as WRITABLE after locking it read-only',
      );
    } finally { a.kill(); b.kill(); }
  });

  test('the acceptance asks the RAW entry INSIDE THE LOCK too — an incoherence born between the preflight and the write is refused there', async () => {
    // ► MUTATION WITNESS for the second of two sites. The end-to-end witness in
    //   binding-accept-e2e duplicates the secondary BEFORE the yes, so the
    //   preflight alone stops it, and removing only the in-lock check leaves
    //   that witness green (Codex, round 10, angle E: "a coverage of the
    //   preflight, not a proof of both sites"). Here the file is coherent at
    //   the preflight's read and incoherent at the lock's — the same repaired
    //   reading, the same digest, the identifier still resolving — so only the
    //   in-lock check can refuse, and only this goes red when it is removed.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-phase-inlock-'));
    tmpDirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    const vault = await startFakeVault();
    const remote = (name) => ({ name, baseUrl: `http://127.0.0.1:${vault.port}`, apiKey: API_KEY });
    const config = (also) => JSON.stringify({
      portRegistry: {},
      vaultNames: {},
      remoteVaults: [remote('work'), remote('ref'), remote('sci')],
      vaultReach: 'declared',
      openVaults: [],
      workspaceBindings: {
        [canonicalWorkspaceKey(process.cwd())]: { vault: 'work', also, locked: false, confirmedVia: 'test' },
      },
    }, null, 2);
    fs.writeFileSync(configPath, config(['ref']), 'utf8');
    const { loadRegistry } = await import('../src/registry.mjs');
    const { confirmWorkspaceBinding } = await import('../src/tools/workspace-binding.mjs');
    const registry = await loadRegistry({ configPath });

    let proposal = null;
    try { registry.resolveVault('sci'); } catch (e) { proposal = e.bindingProposal; }
    assert.ok(proposal?.proposalId, 'the fixture produced no proposal');

    // The seam: the preflight reads a coherent file, the lock reads one a
    // sibling has just hand-edited into a duplicate. Same digest either way.
    let reads = 0;
    const writes = [];
    const seams = {
      cwd: process.cwd(),
      readFile: (p) => {
        reads += 1;
        return reads === 1 ? config(['ref']) : config(['ref', 'ref']);
      },
      writeFile: (p, c) => { writes.push(c); },
      launch: async () => ({}),
      ping: async () => ({ ok: true }),
    };
    await assert.rejects(
      confirmWorkspaceBinding(registry, { accept: proposal.proposalId, open: false }, seams),
      /NO BINDING WAS WRITTEN[\s\S]*ref appears more than once/,
    );
    assert.ok(reads >= 2, `the lock never re-read the file (${reads} read)`);
    assert.equal(writes.length, 0, 'the yes was written over an entry the lock found incoherent');
  });

  test('a config the session can no longer READ is not diagnosed as a malformed entry — nothing was observed', async () => {
    // Round 11: `freshWorkspaceState` put `null` in `rawEntry` for an
    // unreadable file, and since round 10 a present `null` IS a malformed
    // entry — so an unreadable file was diagnosed as "the entry is not an
    // object at all", a sentence about a file nobody had read, with a repair
    // call spelled for it. Not observed is `undefined`, and the proposal is
    // minted from this session's own binding, as before.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-phase-unobserved-'));
    tmpDirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    const vault = await startFakeVault();
    const remote = (name) => ({ name, baseUrl: `http://127.0.0.1:${vault.port}`, apiKey: API_KEY });
    fs.writeFileSync(configPath, JSON.stringify({
      portRegistry: {},
      vaultNames: {},
      remoteVaults: [remote('work'), remote('sci')],
      vaultReach: 'declared',
      openVaults: [],
      workspaceBindings: {
        [canonicalWorkspaceKey(process.cwd())]: { vault: 'work', also: [], locked: false, confirmedVia: 'test' },
      },
    }, null, 2), 'utf8');
    const { loadRegistry } = await import('../src/registry.mjs');
    const registry = await loadRegistry({ configPath });
    fs.rmSync(configPath);
    let err = null;
    try { registry.resolveVault('sci'); } catch (e) { err = e; }
    assert.ok(err, 'sci resolved');
    assert.doesNotMatch(err.message, /not an object at all|cannot be taken as written/, 'an unread file was diagnosed');
    assert.ok(err.bindingProposal, `no proposal from the session's own binding:\n${err.message}`);
    assert.equal(err.bindingProposal.currentPrimary, 'work');
    // AND THE PROVENANCE IS SAID (round 12): the proposal rests on the
    // session's binding because the file could not be read.
    assert.match(err.message, /could not be read just now, so this proposal rests on the binding this session loaded/);
  });

  test('a BROKEN primary with an UNREADABLE file is not told "the config file has no such vault" from a copy', async () => {
    // Round 12: the fallback answered "neither this session nor the config
    // file has such a vault" from the copy loaded at start-up, about a file
    // it had just failed to read.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-phase-broken-unread-'));
    tmpDirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    const vault = await startFakeVault();
    const remote = (name) => ({ name, baseUrl: `http://127.0.0.1:${vault.port}`, apiKey: API_KEY });
    fs.writeFileSync(configPath, JSON.stringify({
      portRegistry: {},
      vaultNames: {},
      remoteVaults: [remote('sci')],
      vaultReach: 'declared',
      openVaults: [],
      workspaceBindings: { [canonicalWorkspaceKey(process.cwd())]: { vault: 'ghost', also: [], locked: false } },
    }, null, 2), 'utf8');
    const { loadRegistry } = await import('../src/registry.mjs');
    const registry = await loadRegistry({ configPath });
    fs.rmSync(configPath);
    let err = null;
    try { registry.resolveVault('sci'); } catch (e) { err = e; }
    assert.ok(err);
    assert.equal(err.bindingProposal, undefined);
    assert.doesNotMatch(err.message, /neither this session nor the config file/, 'an unread file was described');
    assert.match(err.message, /the config file could not be read just now, so what it currently says is unverified/);
  });

  test('an ACCEPTANCE is not refused by a strict tier only this session\'s stale copy still holds', async () => {
    // Round 12: the in-memory promotion preflight refused a yes whose
    // proposal, minted from the file, named the file's primary — because the
    // stale session still held that vault as a strict secondary. Gone: the
    // lock, asked of the file, is the one judge.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-phase-accept-stale-'));
    tmpDirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    const vault = await startFakeVault();
    const remote = (name) => ({ name, baseUrl: `http://127.0.0.1:${vault.port}`, apiKey: API_KEY });
    const config = (binding) => JSON.stringify({
      portRegistry: {},
      vaultNames: {},
      remoteVaults: [remote('work'), remote('ref'), remote('sci')],
      vaultReach: 'declared',
      openVaults: [],
      workspaceBindings: { [canonicalWorkspaceKey(process.cwd())]: binding },
    }, null, 2);
    fs.writeFileSync(configPath, config({ vault: 'work', also: ['ref'], alsoLocked: ['ref'] }), 'utf8');
    const { loadRegistry } = await import('../src/registry.mjs');
    const { confirmWorkspaceBinding } = await import('../src/tools/workspace-binding.mjs');
    const registry = await loadRegistry({ configPath });
    assert.deepEqual(registry.workspaceBinding?.alsoLocked, ['ref']);
    // A sibling makes `ref` the primary.
    fs.writeFileSync(configPath, config({ vault: 'ref', also: ['work'] }), 'utf8');
    let proposal = null;
    try { registry.resolveVault('sci'); } catch (e) { proposal = e.bindingProposal; }
    assert.equal(proposal?.currentPrimary, 'ref', 'the proposal was not minted from the file');
    const res = await confirmWorkspaceBinding(registry, { accept: proposal.proposalId, open: false },
      { cwd: process.cwd(), launch: async () => ({}), ping: async () => ({ ok: true }) });
    assert.ok(res, 'no result');
    const written = JSON.parse(fs.readFileSync(configPath, 'utf8')).workspaceBindings[canonicalWorkspaceKey(process.cwd())];
    assert.equal(written.vault, 'ref');
    assert.deepEqual(written.also, ['work', 'sci']);
    // AND THE SESSION APPLIES ITS OWN WRITE (round 13: the file alone left
    // this witness green with the adoption removed).
    assert.equal(registry.workspaceBinding?.vault, 'ref');
    assert.deepEqual(registry.workspaceBinding?.also, ['work', 'sci']);
    assert.equal(registry.defaultVault, 'ref');
  });

  test('a secondary the FILE lists and this session has not loaded is KEPT by an acceptance, and named as a reload when confirmed by name', async () => {
    // Round 13, angle B: A started without `q`; B registered `q` and added it
    // as a secondary. A's acceptance of an unrelated proposal carried `q`
    // over — and was refused as "not a registered vault" (it IS registered;
    // A has not loaded it). Keeping is not adding: A carries it over. And
    // naming it by hand gets a reload sentence, not "register it first".
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-phase-notloaded-secondary-'));
    tmpDirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    const vault = await startFakeVault();
    const remote = (name) => ({ name, baseUrl: `http://127.0.0.1:${vault.port}`, apiKey: API_KEY });
    const config = (vaults, binding) => JSON.stringify({
      portRegistry: {},
      vaultNames: {},
      remoteVaults: vaults.map(remote),
      vaultReach: 'declared',
      openVaults: [],
      workspaceBindings: { [canonicalWorkspaceKey(process.cwd())]: binding },
    }, null, 2);
    fs.writeFileSync(configPath, config(['work', 'sci'], { vault: 'work', also: [] }), 'utf8');
    const { loadRegistry } = await import('../src/registry.mjs');
    const { confirmWorkspaceBinding } = await import('../src/tools/workspace-binding.mjs');
    const registry = await loadRegistry({ configPath });
    const seams = { cwd: process.cwd(), launch: async () => ({}), ping: async () => ({ ok: true }) };
    // 1. A sibling registered `q`; the entry does NOT hold it yet. ADDING it
    //    by name from here is a reload, not a registration — and this is the
    //    ONE outcome allowed. The first version of this witness ran the same
    //    call AFTER the entry held `q` (kept, so the call resolved) and
    //    accepted "resolved" in the same regex: the not-loaded sentence could
    //    be deleted outright and the witness stayed green (mutation T8 of
    //    round 13 survived; the tautology was found by the harness, not by
    //    a reviewer).
    fs.writeFileSync(configPath, config(['work', 'sci', 'q'], { vault: 'work', also: [] }), 'utf8');
    await assert.rejects(
      confirmWorkspaceBinding(registry, { vault: 'work', also: ['q'], open: false }, seams),
      (e) => /listed in the config file but this session has not loaded it/.test(e.message)
        && /retry in a moment, or restart the session/.test(e.message)
        && !/not a registered vault/.test(e.message)
        && !/Register it first/.test(e.message),
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(configPath, 'utf8')).workspaceBindings[canonicalWorkspaceKey(process.cwd())],
      { vault: 'work', also: [] }, 'the refusal wrote',
    );
    // 2. The sibling added `q` to the entry. A's acceptance of an unrelated
    //    proposal CARRIES `q` over: kept, not added, so no bindability asked.
    fs.writeFileSync(configPath, config(['work', 'sci', 'q'], { vault: 'work', also: ['q'] }), 'utf8');
    let proposal = null;
    try { registry.resolveVault('sci'); } catch (e) { proposal = e.bindingProposal; }
    assert.ok(proposal?.proposalId, 'no proposal for sci');
    const res = await confirmWorkspaceBinding(registry, { accept: proposal.proposalId, open: false }, seams);
    assert.ok(res, 'the acceptance carrying a not-yet-loaded secondary was refused');
    const written = JSON.parse(fs.readFileSync(configPath, 'utf8')).workspaceBindings[canonicalWorkspaceKey(process.cwd())];
    assert.deepEqual(written.also, ['q', 'sci']);
    // 3. Now that the entry holds `q`, naming it again by hand is KEEPING it:
    //    the call resolves (one outcome, asserted as such — not "either").
    const kept = await confirmWorkspaceBinding(registry, { vault: 'work', also: ['q', 'sci'], open: false }, seams);
    assert.ok(kept, 'keeping a secondary the entry holds was refused');
    assert.deepEqual(
      JSON.parse(fs.readFileSync(configPath, 'utf8')).workspaceBindings[canonicalWorkspaceKey(process.cwd())].also,
      ['q', 'sci'],
    );
  });

  test('a repair spelled with a KEPT secondary that a sibling then REMOVES is refused as stale — not as "not a registered vault"', async () => {
    // Round 14, scenario S9. `assertBindable` exempts a secondary the entry
    // holds (round 13); when a sibling removes that secondary between the
    // diagnostic and the spelled repair, the exemption is gone and, asked
    // BEFORE the digest, the writer refused the repair for a registration
    // problem it does not have. The precondition is asked first now.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-phase-stale-kept-'));
    tmpDirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    const vault = await startFakeVault();
    const remote = (name) => ({ name, baseUrl: `http://127.0.0.1:${vault.port}`, apiKey: API_KEY });
    const config = (vaults, binding) => JSON.stringify({
      portRegistry: {},
      vaultNames: {},
      remoteVaults: vaults.map(remote),
      vaultReach: 'declared',
      openVaults: [],
      workspaceBindings: { [canonicalWorkspaceKey(process.cwd())]: binding },
    }, null, 2);
    // `envr` is nobody's here (another session's environment); the duplicate
    // is what earns the diagnostic.
    fs.writeFileSync(configPath, config(['work', 'sci'], { vault: 'work', also: ['envr', 'envr'] }), 'utf8');
    const { loadRegistry } = await import('../src/registry.mjs');
    const { confirmWorkspaceBinding } = await import('../src/tools/workspace-binding.mjs');
    const registry = await loadRegistry({ configPath });
    let err = null;
    try { registry.resolveVault('sci'); } catch (e) { err = e; }
    assert.ok(err, 'the incoherent entry earned no diagnostic');
    assert.match(err.message, /vault: "work", also: \["envr"\], ifBindingDigest/);
    const digest = /ifBindingDigest: "([0-9a-f]{64})"/.exec(err.message)?.[1];
    assert.ok(digest, err.message);
    // The sibling removes `envr` from the entry.
    fs.writeFileSync(configPath, config(['work', 'sci'], { vault: 'work', also: [] }), 'utf8');
    const seams = { cwd: process.cwd(), launch: async () => ({}), ping: async () => ({ ok: true }) };
    const routingBefore = JSON.stringify(registry.workspaceBinding);
    await assert.rejects(
      confirmWorkspaceBinding(registry, { vault: 'work', also: ['envr'], ifBindingDigest: digest, open: false }, seams),
      (e) => /binding entry now differs from the one that diagnostic described/.test(e.message)
        && !/not a registered vault/.test(e.message)
        && !/Register it first/.test(e.message),
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(configPath, 'utf8')).workspaceBindings[canonicalWorkspaceKey(process.cwd())],
      { vault: 'work', also: [] }, 'the stale repair wrote',
    );
    // Routing is what it was (the repaired reading of the start-up entry): a
    // refusal adopts nothing.
    assert.equal(JSON.stringify(registry.workspaceBinding), routingBefore, 'a refused repair changed routing');
  });

  test('an acceptance minted while the primary was registered, arriving after the file DROPPED that primary, gets the repair — not "register it first"', async () => {
    // Round 14, scenario S10. The entry is coherent and unchanged, so the
    // identifier still resolves; the registry facts were asked only for a
    // structurally incoherent entry, and the yes fell through to the generic
    // refusal with no repair spelled. Asked whether or not the entry is
    // coherent, as the proposal door does since round 12.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-phase-old-accept-'));
    tmpDirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    const vault = await startFakeVault();
    const remote = (name) => ({ name, baseUrl: `http://127.0.0.1:${vault.port}`, apiKey: API_KEY });
    const config = (vaults, binding) => JSON.stringify({
      portRegistry: {},
      vaultNames: {},
      remoteVaults: vaults.map(remote),
      vaultReach: 'declared',
      openVaults: [],
      workspaceBindings: { [canonicalWorkspaceKey(process.cwd())]: binding },
    }, null, 2);
    fs.writeFileSync(configPath, config(['work', 'sci'], { vault: 'work', also: [] }), 'utf8');
    const { loadRegistry } = await import('../src/registry.mjs');
    const { confirmWorkspaceBinding } = await import('../src/tools/workspace-binding.mjs');
    const registry = await loadRegistry({ configPath });
    let proposal = null;
    try { registry.resolveVault('sci'); } catch (e) { proposal = e.bindingProposal; }
    assert.ok(proposal?.proposalId, 'no proposal for sci');
    // The sibling drops `work` from the file; the entry itself is untouched.
    fs.writeFileSync(configPath, config(['sci'], { vault: 'work', also: [] }), 'utf8');
    const seams = { cwd: process.cwd(), launch: async () => ({}), ping: async () => ({ ok: true }) };
    await assert.rejects(
      confirmWorkspaceBinding(registry, { accept: proposal.proposalId, open: false }, seams),
      (e) => /its primary work is not a vault this config file registers/.test(e.message)
        && /<the primary vault you intend>/.test(e.message)
        && /ifBindingDigest: "[0-9a-f]{64}"/.test(e.message)
        && !/not a registered vault, so it cannot be bound/.test(e.message),
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(configPath, 'utf8')).workspaceBindings[canonicalWorkspaceKey(process.cwd())],
      { vault: 'work', also: [] }, 'the yes wrote',
    );
  });

  test('a call ADDING one name the file lists but this session has not loaded AND one nobody registered names each cause', async () => {
    // Round 14: the reload sentence was said only when EVERY refused name was
    // a reload; one unregistered name beside it turned both into "not a
    // registered vault".
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-phase-mixed-'));
    tmpDirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    const vault = await startFakeVault();
    const remote = (name) => ({ name, baseUrl: `http://127.0.0.1:${vault.port}`, apiKey: API_KEY });
    const config = (vaults, binding, extra = {}) => JSON.stringify({
      portRegistry: {},
      vaultNames: {},
      remoteVaults: vaults.map(remote),
      vaultReach: 'declared',
      openVaults: [],
      workspaceBindings: { [canonicalWorkspaceKey(process.cwd())]: binding },
      ...extra,
    }, null, 2);
    fs.writeFileSync(configPath, config(['work', 'sci'], { vault: 'work', also: [] }), 'utf8');
    const { loadRegistry } = await import('../src/registry.mjs');
    const { confirmWorkspaceBinding } = await import('../src/tools/workspace-binding.mjs');
    const registry = await loadRegistry({ configPath });
    // A sibling registers `q` and disables `sci`.
    fs.writeFileSync(configPath, config(['work', 'sci', 'q'], { vault: 'work', also: [] }, { disabledVaults: ['sci'] }), 'utf8');
    const seams = { cwd: process.cwd(), launch: async () => ({}), ping: async () => ({ ok: true }) };
    await assert.rejects(
      confirmWorkspaceBinding(registry, { vault: 'work', also: ['q', 'ghost', 'sci'], open: false }, seams),
      (e) => /"q" is listed in the config file but this session has not loaded it/.test(e.message)
        && /"ghost" is not a registered vault/.test(e.message)
        && /"sci" is DISABLED by `disabledVaults`/.test(e.message)
        && !/"q"[^.]*not a registered vault/.test(e.message)
        && /No binding was written/.test(e.message),
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(configPath, 'utf8')).workspaceBindings[canonicalWorkspaceKey(process.cwd())],
      { vault: 'work', also: [] },
    );
  });

  test('a primary the FILE has and this session has not loaded is a reload, not a repair — said in the same breath as the duplicate', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-phase-notloaded-'));
    tmpDirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    const vault = await startFakeVault();
    const remote = (name) => ({ name, baseUrl: `http://127.0.0.1:${vault.port}`, apiKey: API_KEY });
    const config = (vaults, binding) => JSON.stringify({
      portRegistry: {},
      vaultNames: {},
      remoteVaults: vaults.map(remote),
      vaultReach: 'declared',
      openVaults: [],
      workspaceBindings: { [canonicalWorkspaceKey(process.cwd())]: binding },
    }, null, 2);
    fs.writeFileSync(configPath, config(['work', 'sci'], { vault: 'work', also: [] }), 'utf8');
    const { loadRegistry } = await import('../src/registry.mjs');
    const registry = await loadRegistry({ configPath });
    // A sibling registers `newer`, binds to it, and leaves a duplicate.
    fs.writeFileSync(configPath, config(['work', 'sci', 'newer'], { vault: 'newer', also: ['sci', 'sci'] }), 'utf8');
    let err = null;
    try { registry.resolveVault('sci'); } catch (e) { err = e; }
    assert.ok(err);
    assert.equal(err.bindingProposal, undefined);
    assert.match(err.message, /sci appears more than once/);
    assert.match(err.message, /its primary newer is in the config file but this session has not loaded it yet/);
    assert.match(err.message, /vault: "newer", also: \["sci"\]/, 'a primary the file has must stay in the call, with the reload advice');
  });

  test('a REPAIR is not refused by the promotion preflight on a tier this session holds and the file no longer does', async () => {
    // Round 11: the in-memory preflight decided definitively when it refused.
    // This session still holds `ref` as strict; the file's entry (no primary)
    // holds it as writable; naming `ref` as primary is a valid repair the
    // lock would allow. For a repair the preflight is skipped and the lock,
    // asked of the file, decides.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-phase-stalepreflight-'));
    tmpDirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    const vault = await startFakeVault();
    const remote = (name) => ({ name, baseUrl: `http://127.0.0.1:${vault.port}`, apiKey: API_KEY });
    const config = (binding) => JSON.stringify({
      portRegistry: {},
      vaultNames: {},
      remoteVaults: [remote('work'), remote('ref')],
      vaultReach: 'declared',
      openVaults: [],
      workspaceBindings: { [canonicalWorkspaceKey(process.cwd())]: binding },
    }, null, 2);
    fs.writeFileSync(configPath, config({ vault: 'work', also: ['ref'], alsoLocked: ['ref'] }), 'utf8');
    const { loadRegistry } = await import('../src/registry.mjs');
    const { confirmWorkspaceBinding } = await import('../src/tools/workspace-binding.mjs');
    const { rawEntryDigest } = await import('../src/helpers/workspace-bindings.mjs');
    const registry = await loadRegistry({ configPath });
    assert.deepEqual(registry.workspaceBinding?.alsoLocked, ['ref'], 'the fixture did not load ref as strict');
    const later = { also: ['ref'], alsoWritable: ['ref'] };
    fs.writeFileSync(configPath, config(later), 'utf8');
    const res = await confirmWorkspaceBinding(registry, {
      vault: 'ref', also: [], ifBindingDigest: rawEntryDigest(later), open: false,
    }, { cwd: process.cwd(), launch: async () => ({}), ping: async () => ({ ok: true }) });
    assert.ok(res, 'no result');
    const written = JSON.parse(fs.readFileSync(configPath, 'utf8')).workspaceBindings[canonicalWorkspaceKey(process.cwd())];
    assert.equal(written.vault, 'ref');
  });

  test('a promotion refused inside the lock still honours the refusals the lock just read', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-phase-promo-refusals-'));
    tmpDirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    const vault = await startFakeVault();
    const remote = (name) => ({ name, baseUrl: `http://127.0.0.1:${vault.port}`, apiKey: API_KEY });
    const key = canonicalWorkspaceKey(process.cwd());
    const config = (binding, refusals) => JSON.stringify({
      portRegistry: {},
      vaultNames: {},
      remoteVaults: [remote('work'), remote('ref'), remote('other')],
      vaultReach: 'declared',
      openVaults: [],
      workspaceBindings: { [key]: binding },
      ...(refusals ? { workspaceRefusals: { [key]: refusals } } : {}),
    }, null, 2);
    fs.writeFileSync(configPath, config({ vault: 'work', also: [] }, null), 'utf8');
    const { loadRegistry } = await import('../src/registry.mjs');
    const { confirmWorkspaceBinding } = await import('../src/tools/workspace-binding.mjs');
    const { rawEntryDigest } = await import('../src/helpers/workspace-bindings.mjs');
    const registry = await loadRegistry({ configPath });
    const later = { also: ['ref'], alsoLocked: ['ref'] };
    fs.writeFileSync(configPath, config(later, { other: '2026-09-19' }), 'utf8');
    const before = {
      defaultVault: registry.defaultVault,
      defaultVaultSource: registry.defaultVaultSource,
      lockedVault: registry.lockedVault,
      lockSource: registry.lockSource,
    };
    await assert.rejects(
      confirmWorkspaceBinding(registry, { vault: 'ref', also: [], ifBindingDigest: rawEntryDigest(later), open: false },
        { cwd: process.cwd(), launch: async () => ({}), ping: async () => ({ ok: true }) }),
      /alsoLocked SECONDARY/,
    );
    assert.equal(registry.workspaceRefusals?.has?.('other'), true, 'a refusal the lock read was not honoured');
    assert.equal(registry.workspaceBinding?.vault, 'work', 'a refused promotion moved the routing');
    // "The routing did not move" is every routing field, not the primary
    // alone (Codex, round 12).
    assert.equal(registry.defaultVault, before.defaultVault);
    assert.deepEqual(registry.defaultVaultSource, before.defaultVaultSource);
    assert.equal(registry.lockedVault, before.lockedVault);
    assert.deepEqual(registry.lockSource, before.lockSource);
  });

  test('a config that becomes UNREADABLE between the preflight and the lock refuses the yes and writes nothing', async () => {
    // Round 10, angle F, the half the end-to-end witness cannot reach: the
    // preflight read a good file, the lock's read throws. "The acceptance
    // decides" was an intention; this is the measurement for that door.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-phase-unreadable-'));
    tmpDirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    const vault = await startFakeVault();
    const remote = (name) => ({ name, baseUrl: `http://127.0.0.1:${vault.port}`, apiKey: API_KEY });
    const good = JSON.stringify({
      portRegistry: {},
      vaultNames: {},
      remoteVaults: [remote('work'), remote('sci')],
      vaultReach: 'declared',
      openVaults: [],
      workspaceBindings: {
        [canonicalWorkspaceKey(process.cwd())]: { vault: 'work', also: [], locked: false, confirmedVia: 'test' },
      },
    }, null, 2);
    fs.writeFileSync(configPath, good, 'utf8');
    const { loadRegistry } = await import('../src/registry.mjs');
    const { confirmWorkspaceBinding } = await import('../src/tools/workspace-binding.mjs');
    const registry = await loadRegistry({ configPath });
    let proposal = null;
    try { registry.resolveVault('sci'); } catch (e) { proposal = e.bindingProposal; }
    assert.ok(proposal?.proposalId, 'the fixture produced no proposal');

    let reads = 0;
    const writes = [];
    const seams = {
      cwd: process.cwd(),
      readFile: () => {
        reads += 1;
        if (reads === 1) return good;
        const err = new Error('EACCES: permission denied');
        err.code = 'EACCES';
        throw err;
      },
      writeFile: (p, c) => { writes.push(c); },
      launch: async () => ({}),
      ping: async () => ({ ok: true }),
    };
    const before = { binding: registry.workspaceBinding, defaultVault: registry.defaultVault };
    await assert.rejects(confirmWorkspaceBinding(registry, { accept: proposal.proposalId, open: false }, seams));
    assert.ok(reads >= 2, `the lock never re-read the file (${reads} read)`);
    assert.equal(writes.length, 0, 'a yes was written past a config the lock could not read');
    assert.equal(registry.workspaceBinding, before.binding, 'the routing moved on a refused yes');
    assert.equal(registry.defaultVault, before.defaultVault);
  });

  test('a BROKEN binding is diagnosed as broken, even when it declares the vault asked for', async () => {
    // ► MUTATION WITNESS: move the "the config file DOES declare it" branch
    //   back above the broken-primary branch and only this goes red. It
    //   SURVIVED the first mutation run of round eight — the ordering repair
    //   had no witness, which is the state that reads as covered and is not.
    //
    // Two refusals can both apply, and the order decides which one the reader
    // acts on. The file says `{ vault: "absent", also: ["sci"] }` with `absent`
    // registered nowhere. Ask for `sci` and both are true: the file declares
    // it, AND the binding is unusable. "Start a new session" is the wrong
    // advice — restarting does not conjure the missing primary — so the repair
    // diagnostic has to win. (Codex, round eight.)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-phase-broken-'));
    tmpDirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    const vault = await startFakeVault();
    const remote = (name) => ({ name, baseUrl: `http://127.0.0.1:${vault.port}`, apiKey: API_KEY });
    const config = (also) => JSON.stringify({
      portRegistry: {},
      vaultNames: {},
      remoteVaults: [remote('sci'), remote('work')],
      vaultReach: 'declared',
      openVaults: [],
      workspaceBindings: {
        [canonicalWorkspaceKey(process.cwd())]: {
          vault: 'absent', also, locked: false, confirmedVia: 'test',
        },
      },
    }, null, 2);

    // THE TWO STATES HAVE TO DIFFER, or there is no refusal to order. This
    // session loads a binding that does NOT declare `sci`; a sibling then adds
    // it to the file. So `sci` is unreachable HERE (the refusal fires) while
    // the FILE declares it (the new branch would fire) and the primary is
    // broken in both (the repair branch must win).
    fs.writeFileSync(configPath, config([]), 'utf8');
    const { loadRegistry } = await import('../src/registry.mjs');
    const registry = await loadRegistry({ configPath });
    assert.ok(!registry.vaults.some((v) => v.name === 'absent'), 'the fixture registered the broken primary');
    assert.ok(registry.vaults.some((v) => v.name === 'sci'), 'the fixture never registered sci');
    fs.writeFileSync(configPath, config(['sci']), 'utf8');

    let err = null;
    try { registry.resolveVault('sci'); } catch (e) { err = e; }
    assert.ok(err, 'sci resolved instead of being refused');
    assert.equal(err.bindingProposal, undefined, 'a binding that needs repairing was extended instead');
    assert.match(err.message, /needs repairing/);
    // AND THE WHOLE BINDING TO RE-PASS IS SPELLED OUT — the decision's own
    // requirement for this row, which the first message did not meet ("naming
    // a registered primary and the secondaries you want to keep" names
    // nothing). Round 10: a non-conformity, not a wording. The primary is a
    // placeholder, the secondary the binding declares is carried, and the
    // call carries its precondition.
    assert.match(err.message, /its primary absent is not a vault this config file registers/);
    assert.match(err.message, /vault: "<the primary vault you intend>", also: \["sci"\], ifBindingDigest: "[0-9a-f]{64}"/);
    assert.doesNotMatch(
      err.message,
      /Start a new session|Retry in a moment/,
      'the reader was sent to restart, which cannot restore a primary this machine does not have',
    );

    // ► THE OTHER HALF, and the mutation that proves it: a primary missing
    //   from THIS SESSION's catalogue but present in the FILE is not a broken
    //   binding at all. A sibling registered it after this session loaded its
    //   vault list. Telling that reader to re-confirm the binding sends them
    //   to rewrite a configuration that was right. Force `fileHasIt` to false
    //   and this half goes red. (Codex, round nine.)
    const withLater = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    withLater.remoteVaults.push({
      name: 'absent', baseUrl: `http://127.0.0.1:${vault.port}`, apiKey: API_KEY,
    });
    fs.writeFileSync(configPath, JSON.stringify(withLater, null, 2), 'utf8');

    let stale = null;
    try { registry.resolveVault('sci'); } catch (e) { stale = e; }
    assert.ok(stale, 'sci resolved instead of being refused');
    assert.equal(stale.bindingProposal, undefined, 'a binding that only needs a reload was extended');
    assert.match(stale.message, /the config file does have it/);
    assert.match(stale.message, /Nothing needs repairing/);
    assert.doesNotMatch(
      stale.message,
      /needs repairing before anything/,
      'a config that was right was reported as broken',
    );
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

    // Both readers ask for the WRITER's set by name — `writerBindableNames`,
    // which composes `bindableVaultNames` with the environment's remotes
    // (round 12: the writer's own rule, in one place, after the remote
    // exemption was closed). The composition is the one place that asks
    // `bindableVaultNames` on their behalf.
    for (const rel of ['src/registry.mjs', 'src/tools/workspace-binding.mjs', 'src/tools/lock.mjs']) {
      const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
      assert.match(src, /writerBindableNames\(/, `${rel} does not ask the writer's predicate`);
    }
    assert.match(
      fs.readFileSync(path.join(REPO, 'src/helpers/workspace-bindings.mjs'), 'utf8'),
      /export function writerBindableNames[^]{0,400}bindableVaultNames\(cfg\)/,
      'the writer\'s set no longer composes the shared predicate',
    );
  });

  test('no real-router fixture launches the router with HOME === cwd — the home refusal would stand in for the binding\'s', () => {
    // Round 13. Once `lock_vault --persist` stopped preflighting the promotion
    // from this session's copy and let the FILE judge, the also-tier E2E read
    // "refusing to persist … in your home directory" where it expected the
    // promotion refusal: its fixture handed the router a throwaway HOME that
    // WAS the workspace, and the home guard sits between the in-memory lock
    // and the binding writer. No launch from a project folder ever takes that
    // branch, so a fixture that does proves nothing about the writer. Ten
    // fixtures shared the shape; the class is closed by the tree, not by the
    // one file that happened to persist a lock.
    const dir = path.join(REPO, 'tests');
    const self = path.basename(fileURLToPath(import.meta.url));
    const spawnsTheRouter = /\[BIN, '--config'/;
    const homeIsCwd = /homeSafeEnv\(\s*cwd\s*,/;
    // The positive control below is a LITERAL in this file, so the scan
    // flagged its own suite on the first run. This file's fixture is checked
    // apart, by the line that matters, rather than skipped.
    const offenders = [];
    let fixtures = 0;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.test.mjs') || name === self) continue;
      const src = fs.readFileSync(path.join(dir, name), 'utf8');
      if (!spawnsTheRouter.test(src)) continue;
      fixtures += 1;
      if (homeIsCwd.test(src)) offenders.push(name);
    }
    assert.ok(fixtures >= 5, `only ${fixtures} real-router fixtures found — the scan is not looking at the tree`);
    assert.deepEqual(offenders, [], `these hand the router a HOME that is its cwd: ${offenders.join(', ')}`);
    const own = fs.readFileSync(path.join(dir, self), 'utf8').split('\n')
      .filter((line) => /env: homeSafeEnv\(/.test(line) && !/assert\.match/.test(line));
    assert.ok(own.length >= 1, 'this suite\'s own fixture was not found');
    assert.ok(own.every((line) => !homeIsCwd.test(line)), `this suite's own fixture hands the router its cwd as HOME: ${own.join(' | ')}`);
    // Positive control, in the spelling the fixtures used before the sweep.
    assert.match('    env: homeSafeEnv(cwd, {', homeIsCwd, 'the scan would walk past the shape it was written for');
    assert.match("  spawn(process.execPath, [BIN, '--config', configPath], {", spawnsTheRouter);
  });
});
