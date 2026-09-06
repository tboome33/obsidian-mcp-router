/**
 * v0.90.0 — `confirm_workspace_binding`, the conversational half of the
 * workspace→vault binding.
 *
 * `--attach` is the deliberate command-line half. This is the half that works
 * inside a conversation: Claude sees an unconfirmed hint in `list_vaults`,
 * tells the user, the user says yes, and this records it — in the USER'S OWN
 * config, keyed by the canonical workspace path, so it never travels with a
 * clone.
 *
 * Every test drives the tool through injected read/write/launch seams. NOTHING
 * here touches a real config file and NOTHING spawns a desktop application.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { confirmWorkspaceBinding } from '../src/tools/workspace-binding.mjs';
import * as lockModule from '../src/tools/lock.mjs';
import {
  canonicalWorkspaceKey,
  readBinding,
  readRefusals,
  withRefusal,
  HINT_STATUS,
  WORKSPACE_BINDINGS_KEY,
} from '../src/helpers/workspace-bindings.mjs';
import { applyWorkspaceDotenv, _resetWorkspaceDotenvProvenance } from '../src/helpers/workspace-dotenv.mjs';

const CWD = process.cwd();

/**
 * A registry with three vaults.
 *
 * NOTE THE ABSENCE OF AN `online` FIELD, which is the point. The first version
 * of this fixture gave each entry `online: true`/`false` — and a registry
 * entry has never carried that field: `list_vaults` computes it by pinging and
 * attaches it to its own RESPONSE. So the fixture invented a world, the code
 * read `v.online` from a real registry where it is always `undefined`, and
 * every bound vault was relaunched whether or not it was already running. The
 * test could not fail. Found by the Codex review, 2026-09-03.
 *
 * Whether a vault is open is now ASKED, through the `ping` seam below, and the
 * fixture stays as poor in fields as the real thing.
 */
function registryOf(overrides = {}) {
  return {
    configPath: path.join('/cfg', 'config.json'),
    vaults: [
      { name: 'notes', type: 'local', path: '/v/Notes' },
      { name: 'work', type: 'local', path: '/v/Work' },
      { name: 'remote', type: 'remote' },
    ],
    ...overrides,
  };
}

/**
 * Seams that record instead of touching the disk, the network or the desktop.
 *
 * `openVaults` names the vaults whose Obsidian answers; everything else is
 * closed. Defaults to `notes`, matching the old fixture's intent.
 */
/**
 * The config ON DISK, as the tool re-reads it. Since round 2 of the Codex
 * review the tool validates names against the file as well as the live
 * registry — a vault the file no longer lists cannot be bound — so the
 * fixture's file has to list the vaults the registry knows, the way a real
 * install's does. A bare `{}` here would make every name "not registered",
 * which is the strictness working, not a fixture bug to paper over.
 */
const ON_DISK = () => ({
  portRegistry: { '/v/Notes': 27124, '/v/Work': 27125 },
  remoteVaults: [{ name: 'remote', baseUrl: 'https://r/' }],
});

function seams({ config = ON_DISK(), launch, openVaults = ['notes'] } = {}) {
  const written = [];
  const launched = [];
  const pinged = [];
  return {
    written,
    launched,
    pinged,
    seam: {
      cwd: CWD,
      readFile: () => JSON.stringify(config),
      writeFile: (p, c) => written.push({ path: p, config: JSON.parse(c) }),
      ping: async (v) => {
        pinged.push(v.name);
        return { online: openVaults.includes(v.name) };
      },
      launch: launch || ((name) => {
        launched.push(name);
        return { launched: true, uri: `obsidian://open?vault=${name}`, reason: null };
      }),
    },
  };
}

describe('confirm_workspace_binding — recording the user\'s own answer', () => {
  test('a confirmed binding lands under the canonical workspace key, and reads back', async () => {
    const { written, seam } = seams();
    const r = await confirmWorkspaceBinding(registryOf(), { vault: 'notes' }, seam);

    assert.equal(r.boundTo, 'notes');
    assert.equal(r.cleared, false);
    assert.equal(written.length, 1);
    const stored = written[0].config[WORKSPACE_BINDINGS_KEY];
    assert.deepEqual(Object.keys(stored), [canonicalWorkspaceKey(CWD)]);
    assert.equal(readBinding(written[0].config, CWD).vault, 'notes');
    assert.equal(readBinding(written[0].config, CWD).confirmedVia, 'tool',
      'the config records HOW it got there, for the human who reads it in six months');
  });

  test('`also` binds several vaults; the primary stays the default', async () => {
    const { written, seam } = seams();
    const r = await confirmWorkspaceBinding(registryOf(), { vault: 'notes', also: ['work'] }, seam);
    assert.equal(r.boundTo, 'notes');
    assert.deepEqual(r.also, ['work']);
    assert.match(r.message, /also bound and addressable by name/);
    assert.deepEqual(readBinding(written[0].config, CWD).also, ['work']);
  });

  test('THE BOUND: an unregistered vault is refused, and NOTHING is written', async () => {
    // A binding can never call a vault into existence — the same rule the
    // dotenv hint has always had. Checked against the registry, not a pattern.
    const { written, seam } = seams();
    await assert.rejects(
      () => confirmWorkspaceBinding(registryOf(), { vault: 'ghost' }, seam),
      /not a registered vault/,
    );
    assert.equal(written.length, 0, 'a refusal must not leave a partial config behind');
  });

  test('an unregistered vault in `also` is refused too — not only the primary', async () => {
    // The class-defect shape this repo knows: a rule applied to the first
    // field and not to the list beside it.
    const { written, seam } = seams();
    await assert.rejects(
      () => confirmWorkspaceBinding(registryOf(), { vault: 'notes', also: ['ghost'] }, seam),
      /not a registered vault/,
    );
    assert.equal(written.length, 0);
  });

  test('the refused name is sanitised before it reaches the message', async () => {
    const ESC = String.fromCharCode(27);
    const { seam } = seams();
    await assert.rejects(
      () => confirmWorkspaceBinding(registryOf(), { vault: `${ESC}[2Jnotes` }, seam),
      (e) => {
        assert.doesNotMatch(e.message, new RegExp(ESC), 'an escape sequence must not reach the terminal');
        return true;
      },
    );
  });

  test('`vault` is required, and the error points at the way to unbind', async () => {
    const { seam } = seams();
    for (const args of [{}, { vault: '' }, { vault: '   ' }, { also: ['notes'] }]) {
      await assert.rejects(
        () => confirmWorkspaceBinding(registryOf(), args, seam),
        /`vault` is required.*clear: true/s,
        JSON.stringify(args),
      );
    }
  });

  test('the LIVE registry is updated too — the session sees its own answer without a restart', async () => {
    const { seam } = seams();
    const reg = registryOf();
    await confirmWorkspaceBinding(reg, { vault: 'work', open: false }, seam);
    assert.equal(reg.defaultVault, 'work');
    assert.deepEqual(reg.defaultVaultSource, { origin: 'binding', variable: null });
    assert.equal(reg.workspaceBinding.vault, 'work');
  });

  test('a config that cannot be read stops everything, and says nothing was changed', async () => {
    const { written, seam } = seams();
    const bad = { ...seam, readFile: () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); } };
    await assert.rejects(
      () => confirmWorkspaceBinding(registryOf(), { vault: 'notes' }, bad),
      /cannot read the router config.*Nothing was changed/s,
    );
    assert.equal(written.length, 0);
  });

  test('the config is re-read from disk, so a concurrent edit is not clobbered', async () => {
    // Another session, `--attach`, or a hand edit may have touched the file
    // since this server started; a read-modify-write on a stale in-memory copy
    // would silently drop their work.
    // The file lists ONLY `work`, so `work` is the one vault this session may
    // bind (a name the file no longer carries is refused since round 2).
    const { written, seam } = seams({ config: { defaultVault: 'work', portRegistry: { '/v/Work': 1 } } });
    await confirmWorkspaceBinding(registryOf(), { vault: 'work' }, seam);
    assert.equal(written[0].config.defaultVault, 'work', 'the rest of the config survives');
    assert.deepEqual(written[0].config.portRegistry, { '/v/Work': 1 });
  });

  test('`locked` is TRI-STATE: absent keeps the lock, false lifts it, true sets it', async () => {
    // Round 2, found in this tool and in `--attach` together: rewriting the
    // binding with `locked: args.locked === true` meant that re-confirming a
    // locked workspace without mentioning the lock — the ordinary way of
    // adding an `also` — unlocked it on disk while the live guard stayed
    // locked, and the restart sided with the disk.
    const lockedOnDisk = {
      ...ON_DISK(),
      [WORKSPACE_BINDINGS_KEY]: { [canonicalWorkspaceKey(CWD)]: { vault: 'notes', locked: true, confirmedVia: 'tool' } },
    };

    // Absent: the lock survives an ordinary re-confirmation.
    let s = seams({ config: lockedOnDisk });
    let reg = registryOf({ lockedVault: 'notes', lockSource: { origin: 'binding', variable: null } });
    let r = await confirmWorkspaceBinding(reg, { vault: 'notes', also: ['work'], open: false }, s.seam);
    assert.equal(r.locked, true, 'absent keeps');
    assert.equal(readBinding(s.written[0].config, CWD).locked, true);
    assert.equal(reg.lockedVault, 'notes', 'the live guard agrees');

    // Explicit false on the SAME vault: lifted on disk AND live. (Round 2's
    // other half: the live guard used to stay locked in exactly this case.)
    s = seams({ config: lockedOnDisk });
    reg = registryOf({ lockedVault: 'notes', lockSource: { origin: 'binding', variable: null } });
    r = await confirmWorkspaceBinding(reg, { vault: 'notes', locked: false, open: false }, s.seam);
    assert.equal(r.locked, false);
    assert.equal(readBinding(s.written[0].config, CWD).locked, false);
    assert.equal(reg.lockedVault, null, 'the live guard is released too');
    assert.deepEqual(reg.lockSource, { origin: 'unset', variable: null });

    // Explicit true: set, and applied live.
    s = seams();
    reg = registryOf();
    r = await confirmWorkspaceBinding(reg, { vault: 'work', locked: true, open: false }, s.seam);
    assert.equal(r.locked, true);
    assert.equal(reg.lockedVault, 'work');
    assert.deepEqual(reg.lockSource, { origin: 'binding', variable: null });
  });

  test('a vault the live registry knows but the config file no longer lists is REFUSED', async () => {
    // Round 1 of the Codex review: validation used the start-up registry
    // alone, so under `--no-watch` a vault removed from the config since
    // start-up could still be bound — a binding the next start would fall
    // through in silence while the briefing announced it. Both must agree.
    const { written, seam } = seams({ config: { portRegistry: { '/v/Work': 27125 } } });
    await assert.rejects(
      () => confirmWorkspaceBinding(registryOf(), { vault: 'notes' }, seam),
      /"notes" is not a registered vault/,
    );
    assert.equal(written.length, 0, 'nothing written');
  });
});

describe('confirm_workspace_binding — clear: true releases the LIVE session, not only the file', () => {
  // Round 2 of the Codex review: the clear fixtures never set
  // `registry.defaultVault` and never cleared a LOCKED binding, so the two
  // live-state repair branches — re-running the cascade, releasing the lock —
  // could be deleted with every test still green.
  const boundOnDisk = (extra = {}) => ({
    ...ON_DISK(),
    [WORKSPACE_BINDINGS_KEY]: { [canonicalWorkspaceKey(CWD)]: { vault: 'notes', confirmedVia: 'tool', ...extra } },
  });

  test('the default is RECOMPUTED by the real cascade once the binding is gone', async () => {
    const { seam } = seams({ config: boundOnDisk() });
    const reg = registryOf({
      defaultVault: 'notes',
      defaultVaultSource: { origin: 'binding', variable: null },
      configuredDefault: 'work',
      workspaceBinding: { vault: 'notes', also: [], locked: false },
    });
    const r = await confirmWorkspaceBinding(reg, { clear: true }, seam);
    assert.equal(r.cleared, true);
    assert.equal(reg.workspaceBinding, null);
    assert.equal(reg.defaultVault, 'work', 'the config default answers now that tier 0 is gone');
    assert.deepEqual(reg.defaultVaultSource, { origin: 'config', variable: null });
  });

  test('a binding-imposed lock is released with the binding', async () => {
    const { seam } = seams({ config: boundOnDisk({ locked: true }) });
    const reg = registryOf({
      defaultVault: 'notes', lockedVault: 'notes',
      lockSource: { origin: 'binding', variable: null },
      workspaceBinding: { vault: 'notes', also: [], locked: true },
    });
    await confirmWorkspaceBinding(reg, { clear: true }, seam);
    assert.equal(reg.lockedVault, null);
    assert.deepEqual(reg.lockSource, { origin: 'unset', variable: null });
  });

  test('a HOST lock the binding had been shadowing comes BACK — whatever vault it names', async () => {
    // Round 2, pass A: the first version kept the host lock only when it named
    // the same vault as the binding, so clearing a binding locked to `notes`
    // silently dropped a host lock on `work`.
    const { seam } = seams({ config: boundOnDisk({ locked: true }) });
    const reg = registryOf({
      defaultVault: 'notes', lockedVault: 'notes',
      lockSource: { origin: 'binding', variable: null },
      workspaceBinding: { vault: 'notes', also: [], locked: true },
    });
    const had = Object.hasOwn(process.env, 'OBSIDIAN_ROUTER_LOCKED');
    const prev = process.env.OBSIDIAN_ROUTER_LOCKED;
    process.env.OBSIDIAN_ROUTER_LOCKED = 'work';
    try {
      await confirmWorkspaceBinding(reg, { clear: true }, seam);
      assert.equal(reg.lockedVault, 'work', 'the host lock is restored, not erased');
      assert.deepEqual(reg.lockSource, { origin: 'host', variable: 'OBSIDIAN_ROUTER_LOCKED' });
    } finally {
      if (had) process.env.OBSIDIAN_ROUTER_LOCKED = prev; else delete process.env.OBSIDIAN_ROUTER_LOCKED;
    }
  });

  test('…but a host lock naming a vault this workspace cannot REACH is not restored (it would refuse every call)', async () => {
    // Review round 3 of Phase 2/3 (portee-ergonomie-refus-roadmap): start-up
    // already rejects such a host lock through validateLock's reachability
    // context; `releaseBindingLock` re-derived it against the active set
    // only and handed it back on `clear` — `lockedVault` set to a name
    // resolveVault() refuses, every call failing until unlock_vaults.
    const { seam } = seams({ config: boundOnDisk({ locked: true }) });
    const reg = registryOf({
      defaultVault: 'notes', lockedVault: 'notes',
      lockSource: { origin: 'binding', variable: null },
      workspaceBinding: { vault: 'notes', also: [], locked: true },
      vaultReach: 'declared', openVaults: [],
    });
    const had = Object.hasOwn(process.env, 'OBSIDIAN_ROUTER_LOCKED');
    const prev = process.env.OBSIDIAN_ROUTER_LOCKED;
    process.env.OBSIDIAN_ROUTER_LOCKED = 'work';
    try {
      await confirmWorkspaceBinding(reg, { clear: true }, seam);
      // After `clear` there is no binding and `openVaults` is empty, so
      // nothing is reachable — `work` least of all.
      assert.equal(reg.lockedVault, null, 'an unreachable host lock must not come back');
      assert.deepEqual(reg.lockSource, { origin: 'unset', variable: null });
    } finally {
      if (had) process.env.OBSIDIAN_ROUTER_LOCKED = prev; else delete process.env.OBSIDIAN_ROUTER_LOCKED;
    }
  });
});

describe('confirm_workspace_binding — an alsoLocked SECONDARY cannot be promoted to primary from the conversation', () => {
  // Phase 3 review round 3 (portee-ergonomie-refus-roadmap): `alsoWriteTierFor`
  // returns null for a primary, so re-binding the workspace onto its locked
  // secondary was the one-step way past the hard tier.
  const bound = (extra = {}) => registryOf({
    defaultVault: 'notes',
    workspaceBinding: { vault: 'notes', also: ['work'], locked: false },
    alsoWritable: [],
    alsoLocked: ['work'],
    ...extra,
  });

  test('promoting the locked secondary is refused, and nothing is written', async () => {
    const { written, seam } = seams();
    await assert.rejects(confirmWorkspaceBinding(bound(), { vault: 'work' }, seam), /alsoLocked SECONDARY/);
    assert.equal(written.length, 0);
  });

  test('the SAME call on a soft-tier secondary still promotes it (the refusal is about the hard tier only)', async () => {
    const { seam } = seams();
    const r = await confirmWorkspaceBinding(bound({ alsoLocked: [] }), { vault: 'work' }, seam);
    assert.equal(r.boundTo, 'work');
  });

  test('a workspace with NO binding binds it as primary freely — it is not promoting anything', async () => {
    const { seam } = seams();
    const r = await confirmWorkspaceBinding(registryOf({ alsoLocked: ['work'] }), { vault: 'work' }, seam);
    assert.equal(r.boundTo, 'work', 'this is the maintaining workspace declaring its primary from the start');
  });

  test('clearing first, then re-binding, is still possible — two explicit acts, not one', async () => {
    const { seam } = seams();
    const reg = bound();
    await confirmWorkspaceBinding(reg, { clear: true }, seam);
    assert.equal(reg.workspaceBinding, null);
    const r = await confirmWorkspaceBinding(reg, { vault: 'work' }, seam);
    assert.equal(r.boundTo, 'work');
  });

  test('the FILE decides: a tier a sibling session recorded since this process started refuses the promotion, INSIDE the lock', async () => {
    // Codex, round on fd9e1cd. The live registry (this session's copy) knows
    // no tier; the file — rewritten by another session's
    // set_secondary_vault_mode, unseen under `--no-watch` — marks `work`
    // strict. The preflight passed on the stale copy; the transform then read
    // the fresh tier and filtered it away as "no longer a secondary".
    const onDisk = {
      ...ON_DISK(),
      [WORKSPACE_BINDINGS_KEY]: { [canonicalWorkspaceKey(CWD)]: { vault: 'notes', also: ['work'], alsoLocked: ['work'] } },
    };
    const { written, seam } = seams({ config: onDisk });
    const reg = bound({ alsoLocked: [], workspaceBinding: { vault: 'notes', also: ['work'], locked: false, alsoLocked: [], alsoWritable: [] } });
    await assert.rejects(confirmWorkspaceBinding(reg, { vault: 'work' }, seam), /alsoLocked SECONDARY/);
    assert.equal(written.length, 0, 'refused inside the lock, before the binding was rewritten');
    assert.equal(reg.workspaceBinding.vault, 'notes', 'and the live registry was not moved either');
  });

  test('the file\'s GLOBAL alsoLocked list is read inside the lock too', async () => {
    const onDisk = {
      ...ON_DISK(),
      alsoLocked: ['work'],
      [WORKSPACE_BINDINGS_KEY]: { [canonicalWorkspaceKey(CWD)]: { vault: 'notes', also: ['work'] } },
    };
    const { written, seam } = seams({ config: onDisk });
    await assert.rejects(confirmWorkspaceBinding(bound({ alsoLocked: [] }), { vault: 'work' }, seam), /alsoLocked SECONDARY/);
    assert.equal(written.length, 0);
  });
});

describe('confirm_workspace_binding — opening what is not open', () => {
  test('a bound vault whose Obsidian is CLOSED is opened; an open one is left alone', async () => {
    // The whole reason the launcher moved into the server: a closed vault does
    // not answer, so a binding to one would be a promise that does not work.
    const { launched, pinged, seam } = seams();
    const r = await confirmWorkspaceBinding(registryOf(), { vault: 'notes', also: ['work'] }, seam);
    assert.deepEqual(launched, ['Work'], 'only the closed one, and by its Obsidian-side label');
    assert.equal(r.opened.length, 1);
    assert.equal(r.opened[0].vault, 'work');
    assert.equal(r.opened[0].launched, true);
    // AND the question was actually asked. Without this, a future version that
    // decided openness from some field on the registry entry would pass here
    // while being wrong for the same reason the first one was.
    assert.deepEqual(pinged, ['notes', 'work'], 'every bound vault is asked, not assumed');
  });

  test('an open vault is left alone even when it is the only one bound', async () => {
    // The narrow case the old fixture could not express: one vault, already
    // running. `v.online` being permanently undefined made this launch — and
    // stealing focus on every confirmation is exactly the annoyance the
    // "already open is left alone" sentence promised not to cause.
    const { launched, pinged, seam } = seams({ openVaults: ['work'] });
    const r = await confirmWorkspaceBinding(registryOf(), { vault: 'work' }, seam);
    assert.deepEqual(launched, []);
    assert.deepEqual(r.opened, []);
    assert.deepEqual(pinged, ['work']);
    assert.equal(r.boundTo, 'work');
  });

  test('a ping that throws is treated as CLOSED, not as a failure of the whole call', async () => {
    const { launched, seam } = seams();
    seam.ping = async () => { throw new Error('ECONNREFUSED'); };
    const r = await confirmWorkspaceBinding(registryOf(), { vault: 'work' }, seam);
    assert.deepEqual(launched, ['Work']);
    assert.equal(r.boundTo, 'work', 'the binding is recorded regardless');
  });

  test('the label is the on-disk basename WITH its casing, not the router slug', async () => {
    // The obsidian:// handler matches what Obsidian registered, which is the
    // folder basename; the router's slug is lowercased.
    const { launched, seam } = seams();
    await confirmWorkspaceBinding(registryOf(), { vault: 'work' }, seam);
    assert.deepEqual(launched, ['Work'], 'slug "work" → label "Work"');
  });

  test('`open: false` records without opening anything', async () => {
    const { launched, seam } = seams();
    const r = await confirmWorkspaceBinding(registryOf(), { vault: 'work', open: false }, seam);
    assert.deepEqual(launched, []);
    assert.deepEqual(r.opened, []);
    assert.equal(r.boundTo, 'work', 'the binding is still recorded');
  });

  test('a REMOTE vault is never launched — there is no local Obsidian to open', async () => {
    const { launched, seam } = seams();
    await confirmWorkspaceBinding(registryOf(), { vault: 'notes', also: ['remote'] }, seam);
    assert.deepEqual(launched, [], 'a vault with no local path has nothing to launch');
  });

  test('BEST EFFORT: a launch that fails does NOT undo the binding', async () => {
    const { written, seam } = seams({ launch: () => ({ launched: false, uri: 'obsidian://x', reason: 'no handler' }) });
    const r = await confirmWorkspaceBinding(registryOf(), { vault: 'work' }, seam);
    assert.equal(r.boundTo, 'work');
    assert.equal(written.length, 1, 'the binding was recorded regardless');
    assert.equal(r.opened[0].launched, false);
    assert.equal(r.opened[0].reason, 'no handler', 'and the user is told why the window did not appear');
  });
});

describe('lock_vault --persist writes the BINDING too — the second writer', () => {
  // Persisting a lock is the user saying "this workspace goes with this vault,
  // permanently", which is a confirmation in everything but name. It records
  // the binding in the user's own config; the dotenv line stays as the
  // portable hint for the next machine.
  const { _internals } = lockModule;

  function io(config = {}) {
    const written = [];
    return {
      written,
      seam: { readFile: () => JSON.stringify(config), writeFile: (p, c) => written.push(JSON.parse(c)) },
    };
  }

  test('locking a workspace that had NO binding creates one, marked locked', async () => {
    const reg = registryOf();
    // NOTE — the tests in this block drive `recordLockInBinding` directly,
    // which proves what it DOES and not that anyone calls it. The public
    // wiring (`lock_vault --persist`, `unlock_vaults --persist`) is asserted
    // end-to-end in tests/registry.test.mjs, against a real config file on
    // disk: deleting the two call sites in src/tools/lock.mjs leaves this
    // block green and turns that one red. Codex flagged the gap on
    // 2026-09-03 — a private-function suite is a description, not a contract.
    const next = _internals.recordLockInBinding(reg, CWD, 'notes', io().seam);
    assert.deepEqual(next, { vault: 'notes', locked: true, also: [] });
  });

  test('locking a workspace that ALREADY has a binding keeps its `also` and its provenance', async () => {
    // A lock narrows what the session may reach; it does not redefine which
    // other vaults the workspace is bound to.
    const config = {
      [WORKSPACE_BINDINGS_KEY]: {
        [canonicalWorkspaceKey(CWD)]: { vault: 'notes', also: ['work'], confirmedVia: 'attach', confirmedAt: '2020-01-01' },
      },
    };
    const { written, seam } = io(config);
    _internals.recordLockInBinding(registryOf(), CWD, 'notes', seam);
    const b = readBinding(written[0], CWD);
    assert.deepEqual(b.also, ['work'], 'the secondaries survive a lock');
    assert.equal(b.confirmedVia, 'attach', 'the original provenance is not overwritten by "lock"');
    assert.equal(b.confirmedAt, '2020-01-01');
    assert.equal(b.locked, true);
  });

  test('locking to a DIFFERENT vault CARRIES the previous primary and secondaries into `also`', async () => {
    // THIS TEST USED TO PIN THE DEFECT. It asserted `also: []` under the
    // heading "drops the old `also`", with a rationale ("carrying them onto a
    // different vault would invent a binding the user never made") that
    // contradicted the comment three lines above the code, which promised a
    // lock "does not change which OTHER vaults this workspace is bound to".
    // Both could not be true, and the destructive reading was the one the code
    // implemented: a workspace bound to `notes` with `work` also bound, locked
    // onto a third vault, came out bound to that vault ALONE — the other two
    // silently gone from the user's own config. Found in the final review,
    // 2026-09-03.
    //
    // What a lock says is "this workspace goes with THIS vault, now": the
    // locked vault becomes the primary. What it does not say is "forget the
    // others", so they move into `also`, where they stay bound and addressable
    // by name. Nothing the user recorded is lost by an operation whose whole
    // subject is something else.
    const config = {
      [WORKSPACE_BINDINGS_KEY]: { [canonicalWorkspaceKey(CWD)]: { vault: 'notes', also: ['work'] } },
    };
    const { written, seam } = io(config);
    _internals.recordLockInBinding(registryOf(), CWD, 'third', seam);
    const b = readBinding(written[0], CWD);
    assert.equal(b.vault, 'third', 'the locked vault is the primary');
    assert.deepEqual(b.also, ['notes', 'work'], 'the previous primary first, then its secondaries');
    assert.equal(b.locked, true);
  });

  test('a strict tier the FILE records on the vault being locked onto refuses the promotion — the one error this best-effort writer lets out', async () => {
    // Codex, round on fd9e1cd: `lockVault`'s preflight asks the live registry;
    // this transform used to read the fresh tier and drop it with `keep`.
    const config = {
      [WORKSPACE_BINDINGS_KEY]: { [canonicalWorkspaceKey(CWD)]: { vault: 'notes', also: ['work'], alsoLocked: ['work'] } },
    };
    const { written, seam } = io(config);
    assert.throws(() => _internals.recordLockInBinding(registryOf(), CWD, 'work', seam), /alsoLocked SECONDARY/);
    assert.equal(written.length, 0);
    // The ordinary best-effort contract is untouched: a config that cannot be
    // read is still `null` ("could not be written"), never a throw.
    const unreadable = { readFile: () => { throw new Error('EACCES'); }, writeFile: () => {} };
    assert.equal(_internals.recordLockInBinding(registryOf(), CWD, 'work', unreadable), null);
  });

  test('locking onto a vault that was merely a SECONDARY promotes it without duplicating it', async () => {
    // The narrow case the filter exists for: `also` must never end up naming
    // the primary, or "one vault or several" stops being answerable.
    const config = {
      [WORKSPACE_BINDINGS_KEY]: { [canonicalWorkspaceKey(CWD)]: { vault: 'notes', also: ['work'] } },
    };
    const { written, seam } = io(config);
    _internals.recordLockInBinding(registryOf(), CWD, 'work', seam);
    const b = readBinding(written[0], CWD);
    assert.equal(b.vault, 'work');
    assert.deepEqual(b.also, ['notes'], 'the old primary is kept, the new one is not repeated');
  });

  test('re-locking an ALREADY-locked identical binding writes nothing', async () => {
    // The same rule as `withMigrationState`, one transform over: a write that
    // cannot change the content can still fail, still contends for the
    // inter-process lock, and still moves the mtime of the file holding every
    // vault's API key. `lock_vault --persist` run twice used to rewrite it for
    // byte-identical content. A repair that reaches only its first transform
    // is the shape this repository keeps rediscovering — measured, then fixed
    // in all three.
    const config = {
      [WORKSPACE_BINDINGS_KEY]: {
        [canonicalWorkspaceKey(CWD)]: {
          vault: 'notes', also: ['work'], locked: true, confirmedVia: 'tool', confirmedAt: '2020-01-01',
        },
      },
    };
    const { written, seam } = io(config);
    const r = lockModule._internals.recordLockInBinding(registryOf(), CWD, 'notes', seam);
    assert.deepEqual(written, [], 'nothing to change, nothing written');
    assert.deepEqual(r, { vault: 'notes', locked: true, also: ['work'] }, 'and the state is still reported');
  });

  test('an imported binding stops claiming nobody confirmed it once the user locks it', async () => {
    // `confirmedVia: 'migration'` is what makes the session briefing say
    // "NOBODY CONFIRMED THIS BINDING" at every start. Persisting a lock IS a
    // confirmation — the user typed it — so leaving the marker in place kept
    // the router accusing itself of a guess the user had already answered.
    // A real confirmation (`tool`, `attach`) is still not overwritten: it is
    // not this lock's place to claim someone else's.
    const config = {
      [WORKSPACE_BINDINGS_KEY]: { [canonicalWorkspaceKey(CWD)]: { vault: 'notes', confirmedVia: 'migration' } },
    };
    const { written, seam } = io(config);
    _internals.recordLockInBinding(registryOf(), CWD, 'notes', seam);
    assert.equal(readBinding(written[0], CWD).confirmedVia, 'lock');
  });

  test('UNLOCKING lifts the lock but KEEPS the binding — the workspace still goes with its vault', async () => {
    const config = {
      [WORKSPACE_BINDINGS_KEY]: { [canonicalWorkspaceKey(CWD)]: { vault: 'notes', also: ['work'], locked: true } },
    };
    const { written, seam } = io(config);
    _internals.recordLockInBinding(registryOf(), CWD, null, seam);
    const b = readBinding(written[0], CWD);
    assert.equal(b.locked, false, 'no longer restricted');
    assert.equal(b.vault, 'notes', 'but still bound');
    assert.deepEqual(b.also, ['work']);
  });

  test('unlocking a workspace with no binding writes nothing to invent, and says so as a SUCCESS', async () => {
    // Nothing is written — there is no binding to lift a lock from.
    //
    // But the ANSWER is not `null`. `null` from this function means "the
    // config could not be written, a recorded lock may still be there", and
    // `unlock_vaults` turns it into `bindingLifted: false`, which
    // `skills/unlock` told Claude to relay as "the lock is still recorded in
    // the router config and WILL come back at the next start". For a workspace
    // that never had a binding that sentence is simply false, and it sent the
    // user looking for a lock nobody had set. The two cases are now
    // distinguishable, which is what lets both the tool message and the skill
    // be true. Found in the final review, 2026-09-03.
    const { written, seam } = io();
    const r = _internals.recordLockInBinding(registryOf(), CWD, null, seam);
    assert.deepEqual(written, [], 'nothing invented on disk');
    assert.deepEqual(r, { vault: null, locked: false, also: [] }, 'a success: no lock is recorded here');
  });

  test('unlocking a binding that is ALREADY unlocked writes nothing, and still reports success', async () => {
    const config = {
      [WORKSPACE_BINDINGS_KEY]: { [canonicalWorkspaceKey(CWD)]: { vault: 'notes', also: ['work'], locked: false } },
    };
    const { written, seam } = io(config);
    const r = _internals.recordLockInBinding(registryOf(), CWD, null, seam);
    assert.deepEqual(written, [], 'no rewrite of an unchanged file');
    assert.deepEqual(r, { vault: 'notes', locked: false, also: ['work'] });
  });

  test('BEST EFFORT: an unwritable config returns null instead of throwing', async () => {
    // The lock is already in force in memory and already in the workspace
    // file by the time this runs. A config that cannot be written must not
    // turn a successful lock into a failed tool call.
    const seam = { readFile: () => { throw new Error('EACCES'); }, writeFile: () => {} };
    assert.doesNotThrow(() => _internals.recordLockInBinding(registryOf(), CWD, 'notes', seam));
    assert.equal(_internals.recordLockInBinding(registryOf(), CWD, 'notes', seam), null);
  });

  test('a registry with no configPath is a no-op, not a crash', async () => {
    assert.equal(_internals.recordLockInBinding({ vaults: [] }, CWD, 'notes'), null);
  });
});

describe('the live registry after a binding change — what THIS session sees', () => {
  // Every field the tools mutate on the running registry, checked through the
  // registry object rather than through the tool's return value. A tool that
  // reports a change it did not apply is the shape this lot keeps rediscovering.

  test('confirming RE-CLASSIFIES the hint: what was just adopted stops being a proposal', async () => {
    // `bindingHint` is computed once, at start-up. Every tool that changed the
    // binding left it alone, so after `confirm_workspace_binding({ vault })`
    // the very hint the user had just accepted was still reported
    // `unconfirmed` — and this tool's own description tells Claude to offer a
    // confirmation whenever it sees that status, so the assistant would keep
    // proposing what had already been accepted, for the whole session under
    // `--no-watch`. Measured through the real `list_vaults` in the final
    // review, 2026-09-03.
    const reg = registryOf({
      bindingHint: { status: 'unconfirmed', hint: 'notes', boundTo: null, origin: 'workspace-dotenv' },
    });
    const prev = process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT;
    process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT = 'notes';
    try {
      await confirmWorkspaceBinding(reg, { vault: 'notes', open: false }, seams().seam);
      assert.equal(reg.bindingHint.status, 'confirmed', 'the hint now agrees with the binding');
      assert.equal(reg.bindingHint.boundTo, 'notes');
    } finally {
      if (prev === undefined) delete process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT;
      else process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT = prev;
    }
  });

  test('and CLEARING re-classifies it the other way — the proposal comes back', async () => {
    const config = { ...ON_DISK(), [WORKSPACE_BINDINGS_KEY]: { [canonicalWorkspaceKey(CWD)]: { vault: 'notes' } } };
    const reg = registryOf({ bindingHint: { status: 'confirmed', hint: 'notes', boundTo: 'notes', origin: 'workspace-dotenv' } });
    const prev = process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT;
    process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT = 'notes';
    try {
      await confirmWorkspaceBinding(reg, { clear: true }, seams({ config }).seam);
      assert.equal(reg.bindingHint.status, 'unconfirmed', 'nothing is bound, so the file is proposing again');
      assert.equal(reg.bindingHint.boundTo, null);
    } finally {
      if (prev === undefined) delete process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT;
      else process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT = prev;
    }
  });

  test('a persisted lock moves the session DEFAULT with it, not only the guard', async () => {
    // The binding is tier 0 of the cascade, so a lock that moves the primary
    // moves the default. Without this the session kept resolving unqualified
    // calls to whatever the cascade picked at start-up while the config said
    // the workspace goes with the vault just locked — and `unlock_vaults`
    // handed the session back to the stale answer rather than to the binding.
    const reg = registryOf({ defaultVault: 'work', defaultVaultSource: { origin: 'config', variable: null } });
    lockModule._internals.recordLockInBinding(reg, CWD, 'notes', seams().seam);
    assert.equal(reg.defaultVault, 'notes');
    assert.deepEqual(reg.defaultVaultSource, { origin: 'binding', variable: null });
  });

  test('eligibility is re-checked INSIDE the lock, against the config the transform gets', async () => {
    // Codex, round 5. Round 4 moved the `locked` decision inside the lock and
    // left the NAME VALIDATION outside it, reading a copy taken before. So:
    // A validates vault `work`, B removes `work` from the config and saves,
    // A takes the lock and writes a binding to a vault that is no longer
    // there — and reports success, while the next session falls through it.
    //
    // WHAT IS PINNED IS THAT THERE IS ONLY ONE READ, and it is the transform's.
    // With the pre-lock read gone there is no second state to make the two
    // reads disagree about, so the observable property is the absence of that
    // read: restoring `const onDisk = readConfig()` before the lock takes the
    // count from one to two, and this test goes red on the commit that does it.
    let reads = 0;
    const config = ON_DISK();
    const seam = {
      cwd: CWD,
      readFile: () => { reads += 1; return JSON.stringify(config); },
      writeFile: () => {},
    };
    await confirmWorkspaceBinding(registryOf(), { vault: 'work', open: false }, seam);
    assert.equal(reads, 1, 'the config is read exactly once, inside the lock');

    // And the file half of the check still bites: a vault the live registry
    // knows but the config no longer lists cannot be bound, because the NEXT
    // session would load the file and fall through the binding.
    const gone = { portRegistry: { '/v/Notes': 27124 }, remoteVaults: [] };
    await assert.rejects(
      () => confirmWorkspaceBinding(registryOf(), { vault: 'work', open: false }, {
        cwd: CWD, readFile: () => JSON.stringify(gone), writeFile: () => {},
      }),
      /is not a registered vault/,
    );
  });

  test('clearing a binding whose vault name came from a hand-edited config cannot drive the terminal', async () => {
    // `had.vault` is read straight out of `workspaceBindings` and, on this
    // path, is never checked against the registry — so a name carrying an
    // escape sequence or a newline reached the message raw while the rejected
    // argument beside it was carefully sanitised. Half a guard reads as a
    // guard. Measured on 2026-09-03.
    const evil = `x${String.fromCharCode(27)}[31mEVIL${String.fromCharCode(10)}second line`;
    const config = { ...ON_DISK(), [WORKSPACE_BINDINGS_KEY]: { [canonicalWorkspaceKey(CWD)]: { vault: evil } } };
    const r = await confirmWorkspaceBinding(registryOf(), { clear: true }, seams({ config }).seam);
    assert.equal(r.message.includes(String.fromCharCode(27)), false, 'no escape sequence');
    assert.equal(r.message.includes(String.fromCharCode(10)), false, 'and no line break to forge a second message');
  });

  test('the SUCCESS message is sanitised too — the primary and every secondary', async () => {
    // The refusal message was cleaned and the success message was not, which
    // is the same half-a-guard shape one branch over. These names are the
    // REGISTERED spellings, and a registered spelling comes from `vaultNames`
    // or from a vault path — both hand-editable. (Codex, round 5.)
    const evilPrimary = `n${String.fromCharCode(27)}[31motes`;
    const evilAlso = `w${String.fromCharCode(27)}[31mork`;
    const reg = registryOf({
      vaults: [{ name: evilPrimary, type: 'local', path: '/v/Notes' }, { name: evilAlso, type: 'local', path: '/v/Work' }],
    });
    const config = {
      portRegistry: { '/v/Notes': 27124, '/v/Work': 27125 },
      vaultNames: { '/v/Notes': evilPrimary, '/v/Work': evilAlso },
    };
    const r = await confirmWorkspaceBinding(
      reg,
      { vault: evilPrimary, also: [evilAlso], open: false },
      seams({ config }).seam,
    );
    assert.equal(r.message.includes(String.fromCharCode(27)), false, 'no escape sequence survives');
  });

  test('a persisted lock and its lift both re-classify the live hint', async () => {
    // `refreshRegistryBindingHint` was called from the confirmation tool and
    // from `recordLockInBinding`, and only the confirmation side was pinned —
    // so removing the call from the lock side stayed green while `list_vaults`
    // reported a hint that had stopped describing the binding. (Codex, round 5.)
    const prev = process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT;
    process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT = 'notes';
    try {
      const reg = registryOf({
        bindingHint: { status: 'unconfirmed', hint: 'notes', boundTo: null, origin: 'workspace-dotenv' },
      });
      const lockSeam = (config = {}) => ({
        readFile: () => JSON.stringify(config),
        writeFile: () => {},
      });
      lockModule._internals.recordLockInBinding(reg, CWD, 'notes', lockSeam());
      assert.equal(reg.bindingHint.status, 'confirmed', 'the lock created a binding the hint now agrees with');
      assert.equal(reg.bindingHint.boundTo, 'notes');

      // And the LIFT path, which writes nothing when there is no binding —
      // it must still leave the live hint describing reality.
      const reg2 = registryOf({
        bindingHint: { status: 'confirmed', hint: 'notes', boundTo: 'notes', origin: 'workspace-dotenv' },
      });
      lockModule._internals.recordLockInBinding(reg2, CWD, null, lockSeam());
      assert.equal(reg2.bindingHint.status, 'unconfirmed', 'no binding on disk, so the file is proposing again');
    } finally {
      if (prev === undefined) delete process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT;
      else process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT = prev;
    }
  });

  test('clearing releases a BINDING-imposed lock by its SOURCE, not by comparing names', async () => {
    // Codex, round 5. This session started locked to `notes` by its binding;
    // another process then re-bound the workspace to `work`, also locked. The
    // clear reads `had` inside the lock — correctly `work` — and the old
    // condition compared that fresh name with the live `lockedVault`, still
    // `notes`. They differ, so nothing was released: the response said "all
    // registered vaults are available again" while the session stayed locked.
    // The question being asked is "who imposed this lock", and `lockSource`
    // answers it.
    const config = { ...ON_DISK(), [WORKSPACE_BINDINGS_KEY]: { [canonicalWorkspaceKey(CWD)]: { vault: 'work', locked: true } } };
    const reg = registryOf({
      lockedVault: 'notes',
      lockSource: { origin: 'binding', variable: null },
      defaultVault: 'notes',
      defaultVaultSource: { origin: 'binding', variable: null },
      configuredDefault: null,
    });
    const r = await confirmWorkspaceBinding(reg, { clear: true }, seams({ config }).seam);
    assert.equal(r.cleared, true);
    assert.equal(reg.lockedVault, null, 'the session really is unlocked, as the message says');
    assert.notEqual(reg.defaultVaultSource.origin, 'binding', 'and the default is re-derived');
  });

  test('the vault CATALOGUE in the refusal message is sanitised too, not only the rejected name', async () => {
    const evil = `w${String.fromCharCode(27)}[31mork`;
    const reg = registryOf({ vaults: [{ name: evil, type: 'remote' }] });
    const config = { portRegistry: {}, remoteVaults: [{ name: evil, baseUrl: 'https://r/' }] };
    await assert.rejects(
      () => confirmWorkspaceBinding(reg, { vault: 'ghost' }, seams({ config }).seam),
      (err) => {
        assert.equal(err.message.includes(String.fromCharCode(27)), false, 'the catalogue is cleaned');
        return true;
      },
    );
  });
});

describe('confirm_workspace_binding — clearing, the third state', () => {
  test('`clear: true` removes the binding and says ALL vaults are available', async () => {
    const config = { [WORKSPACE_BINDINGS_KEY]: { [canonicalWorkspaceKey(CWD)]: { vault: 'notes' } } };
    const { written, seam } = seams({ config });
    const r = await confirmWorkspaceBinding(registryOf(), { clear: true }, seam);

    assert.equal(r.cleared, true);
    assert.equal(r.boundTo, null);
    assert.deepEqual(r.previous, { vault: 'notes', also: [] });
    assert.match(r.message, /All registered vaults are available again/);
    assert.equal(readBinding(written[0].config, CWD), null);
  });

  test('clearing a workspace that had no binding is honest, not an error', async () => {
    const { seam } = seams();
    const r = await confirmWorkspaceBinding(registryOf(), { clear: true }, seam);
    assert.equal(r.cleared, true);
    assert.equal(r.previous, null);
    assert.match(r.message, /had no binding; nothing changed/);
  });

  test('clearing needs no `vault`, and ignores one if given', async () => {
    const { written, seam } = seams();
    const r = await confirmWorkspaceBinding(registryOf(), { clear: true, vault: 'notes' }, seam);
    assert.equal(r.cleared, true);
    assert.equal(readBinding(written[0].config, CWD), null);
  });
});

describe('confirm_workspace_binding — refuse: the user says NO (decision refus-d-une-proposition-de-liaison)', () => {
  const refusalsOf = (config) => readRefusals(config, CWD);
  const withDefaultVault = async (value, fn) => {
    const had = Object.hasOwn(process.env, 'OBSIDIAN_ROUTER_DEFAULT_VAULT');
    const prev = process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT;
    if (value === null) delete process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT;
    else process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT = value;
    try { return await fn(); } finally {
      if (had) process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT = prev; else delete process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT;
    }
  };

  test('a refusal lands in the user\'s config under the canonical key, dated, and the LIVE registry carries it', async () => {
    const { written, seam } = seams();
    const reg = registryOf();
    const r = await confirmWorkspaceBinding(reg, { refuse: 'work' }, seam);
    assert.equal(r.refused, true);
    assert.equal(r.vault, 'work');
    assert.equal(r.alreadyRefused, false);
    assert.equal(written.length, 1);
    const stored = refusalsOf(written[0].config);
    assert.deepEqual([...stored.keys()], ['work']);
    assert.match(stored.get('work'), /^\d{4}-\d{2}-\d{2}$/, 'dated, for the human who reads the config later');
    assert.deepEqual([...reg.workspaceRefusals.keys()], ['work'], 'the session sees its own answer without a restart');
    assert.equal(r.hintWritten, false, 'no workspace file proposed anything here');
    assert.match(r.message, /Nothing was written to this project's \.env/);
    assert.match(r.message, /confirm_workspace_binding\(\{ retract: "work" \}\)/, 'the way back is named');
  });

  test('refusing the vault the CURRENT proposal names silences it in this session — list_vaults would say "refused"', async () => {
    await withDefaultVault('work', async () => {
      const { seam } = seams();
      const reg = registryOf();
      const r = await confirmWorkspaceBinding(reg, { refuse: 'work' }, seam);
      assert.equal(r.silencesCurrentHint, true);
      assert.equal(reg.bindingHint.status, HINT_STATUS.REFUSED);
      assert.equal(reg.bindingHint.hint, 'work');
    });
  });

  test('refusing some OTHER vault leaves the current proposal signalled (trap 1)', async () => {
    await withDefaultVault('work', async () => {
      const { seam } = seams();
      const reg = registryOf();
      const r = await confirmWorkspaceBinding(reg, { refuse: 'notes' }, seam);
      assert.equal(r.silencesCurrentHint, false);
      assert.equal(reg.bindingHint.status, HINT_STATUS.UNCONFIRMED);
    });
  });

  test('`refuse` and `retract` are their own acts — never combined with vault, also, locked, clear, or each other', async () => {
    const { written, seam } = seams();
    for (const args of [
      { refuse: 'work', vault: 'notes' },
      { refuse: 'work', clear: true },
      { refuse: 'work', retract: 'work' },
      { retract: 'work', also: ['notes'] },
      { refuse: 'work', locked: true },
    ]) {
      await assert.rejects(() => confirmWorkspaceBinding(registryOf(), args, seam), /cannot be combined with/, JSON.stringify(args));
    }
    assert.equal(written.length, 0, 'a refused call writes nothing');
  });

  test('the name is validated at the boundary — empty, multi-line, absurdly long or not a string: refused, nothing written', async () => {
    const { written, seam } = seams();
    for (const bad of ['', '   ', 'a\nb', 'a\rb', 'x'.repeat(256), 42, null]) {
      await assert.rejects(
        () => confirmWorkspaceBinding(registryOf(), { refuse: bad }, seam),
        /must (name a vault|be a plain vault name)/,
        JSON.stringify(bad),
      );
    }
    assert.equal(written.length, 0);
  });

  test('the vault this workspace is BOUND to cannot be refused — primary or secondary, read from the file inside the lock, each with ITS way out', async () => {
    const config = { ...ON_DISK(), [WORKSPACE_BINDINGS_KEY]: { [canonicalWorkspaceKey(CWD)]: { vault: 'notes', also: ['work', 'remote'] } } };
    const { written, seam } = seams({ config });
    // The primary: clear the binding, or bind elsewhere.
    await assert.rejects(
      () => confirmWorkspaceBinding(registryOf(), { refuse: 'notes' }, seam),
      /bound to "notes" as its primary, so that vault cannot be refused.*clear: true/s,
    );
    // A secondary: "clear the binding" would throw away the primary and every
    // other secondary to refuse one name — the way out is a re-confirmation
    // without it, spelled with the names that stay. (Fable round on 7efbad1.)
    await assert.rejects(
      () => confirmWorkspaceBinding(registryOf(), { refuse: 'work' }, seam),
      /"work" is a SECONDARY of this workspace.*confirm_workspace_binding\(\{ vault: "notes", also: \["remote"\] \}\)/s,
    );
    assert.equal(written.length, 0);
  });

  test('on a GATED deployment refuse and retract are unavailable, and nothing is written', async () => {
    // Fable round on 7efbad1, measured on the real server: under READONLY the
    // tool was exposed and `refuse` wrote the shared config AND the server's
    // own `.env` — one caller's answer standing for every tenant.
    const had = Object.hasOwn(process.env, 'OBSIDIAN_ROUTER_READONLY');
    const prev = process.env.OBSIDIAN_ROUTER_READONLY;
    process.env.OBSIDIAN_ROUTER_READONLY = 'true';
    try {
      const { written, seam } = seams();
      for (const args of [{ refuse: 'work' }, { retract: 'work' }]) {
        await assert.rejects(() => confirmWorkspaceBinding(registryOf(), args, seam), /not available on a gated deployment/, JSON.stringify(args));
      }
      assert.equal(written.length, 0);
    } finally {
      if (had) process.env.OBSIDIAN_ROUTER_READONLY = prev; else delete process.env.OBSIDIAN_ROUTER_READONLY;
    }
  });

  test('refusing twice is honest — "already refused", and the config is NOT rewritten', async () => {
    const config = withRefusal(ON_DISK(), CWD, 'work', { at: '2026-09-06' });
    const { written, seam } = seams({ config });
    const r = await confirmWorkspaceBinding(registryOf(), { refuse: 'work' }, seam);
    assert.equal(r.alreadyRefused, true);
    assert.equal(written.length, 0, 'an identity transform must not touch the file that holds every API key');
    assert.match(r.message, /already refused/);
  });

  test('an UNREGISTERED vault can be refused — that is how the unknown-vault notice stops', async () => {
    const { written, seam } = seams();
    const r = await confirmWorkspaceBinding(registryOf(), { refuse: 'ghost' }, seam);
    assert.equal(r.refused, true);
    assert.equal(refusalsOf(written[0].config).has('ghost'), true);
  });

  test('the refused name is sanitised before it reaches the message', async () => {
    const ESC = String.fromCharCode(27);
    const { seam } = seams();
    const r = await confirmWorkspaceBinding(registryOf(), { refuse: `${ESC}[2Jwork` }, seam);
    assert.doesNotMatch(r.message, new RegExp(ESC));
  });

  test('retract takes a refusal back — in the file and in the live registry — and says so honestly when there was none', async () => {
    const config = withRefusal(ON_DISK(), CWD, 'work', { at: '2026-09-06' });
    const { written, seam } = seams({ config });
    const reg = registryOf({ workspaceRefusals: new Map([['work', '2026-09-06']]) });
    const r = await confirmWorkspaceBinding(reg, { retract: 'work' }, seam);
    assert.equal(r.retracted, true);
    assert.equal(refusalsOf(written[0].config).has('work'), false);
    assert.equal(reg.workspaceRefusals.size, 0);
    assert.match(r.message, /signalled again/);

    const fresh = seams();
    const none = await confirmWorkspaceBinding(registryOf(), { retract: 'work' }, fresh.seam);
    assert.equal(none.retracted, false);
    assert.equal(fresh.written.length, 0, 'nothing to remove, nothing rewritten');
    assert.match(none.message, /No refusal/);
  });

  test('BINDING A REFUSED VAULT DROPS THE REFUSAL, in the file and live, and the answer says so', async () => {
    const config = withRefusal(withRefusal(ON_DISK(), CWD, 'notes', { at: '2026-09-06' }), CWD, 'remote', { at: '2026-09-06' });
    const { written, seam } = seams({ config });
    const reg = registryOf({ workspaceRefusals: new Map([['notes', '2026-09-06'], ['remote', '2026-09-06']]) });
    const r = await confirmWorkspaceBinding(reg, { vault: 'notes', open: false }, seam);
    assert.deepEqual(r.refusalsDropped, ['notes']);
    assert.match(r.message, /earlier refusal of "notes" recorded for this workspace is dropped/);
    assert.deepEqual([...refusalsOf(written[0].config).keys()], ['remote'], 'the vault NOT bound stays refused');
    assert.deepEqual([...reg.workspaceRefusals.keys()], ['remote'], 'the live registry agrees with the file');
  });

  test('binding a vault that was never refused reports an empty refusalsDropped and says nothing about it', async () => {
    const { seam } = seams();
    const r = await confirmWorkspaceBinding(registryOf(), { vault: 'notes', open: false }, seam);
    assert.deepEqual(r.refusalsDropped, []);
    assert.doesNotMatch(r.message, /refusal/);
  });
});

describe('every binding writer refreshes the live refusals — the sweep behind I7', () => {
  // `withBinding` drops a refusal of any vault it binds, in every writer. The
  // first version of Phase 5 refreshed `registry.workspaceRefusals` after the
  // confirmation tool only: `lock_vault --persist` on a refused vault dropped
  // the refusal on disk and left the live copy listing it, so `list_vaults`
  // offered a retraction that was a no-op. (Codex, round on b59eb00.)
  const { _internals } = lockModule;

  test('lock_vault --persist onto a refused vault drops the refusal on disk AND live', () => {
    const config = withRefusal(ON_DISK(), CWD, 'notes', { at: '2026-09-06' });
    const written = [];
    const seam = { readFile: () => JSON.stringify(config), writeFile: (p, c) => written.push(JSON.parse(c)) };
    const reg = registryOf({ workspaceRefusals: new Map([['notes', '2026-09-06']]) });
    const r = _internals.recordLockInBinding(reg, CWD, 'notes', seam);
    assert.equal(r?.vault, 'notes');
    assert.equal(readRefusals(written[0], CWD).has('notes'), false, 'dropped on disk by withBinding');
    assert.equal(reg.workspaceRefusals.size, 0, 'and the live registry says so too');
  });

  test('GUARD: every tool that assigns registry.workspaceBinding assigns registry.workspaceRefusals in the same file', () => {
    // A textual sweep over the writers, so the next binding writer cannot
    // refresh one field and forget the other. The two assignments travel
    // together because the two facts do: `withBinding` may change both.
    const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const toolsDir = path.join(ROOT, 'src', 'tools');
    const offenders = [];
    let writers = 0;
    for (const name of fs.readdirSync(toolsDir)) {
      if (!name.endsWith('.mjs')) continue;
      const src = fs.readFileSync(path.join(toolsDir, name), 'utf8');
      if (!/registry\.workspaceBinding\s*=[^=]/.test(src)) continue;
      writers += 1;
      if (!/registry\.workspaceRefusals\s*=[^=]/.test(src)) offenders.push(name);
    }
    assert.ok(writers >= 3, `expected the three known writers (confirm, lock, set-secondary-vault-mode), saw ${writers}`);
    assert.deepEqual(offenders, [], 'a writer that refreshes the binding but not the refusals');
  });
});

describe('confirm_workspace_binding — refuse: the PORTABLE half, written only into the file that spoke (trap 3)', () => {
  // A real temporary workspace and the real loader, because the tool decides
  // from the loader's own record (`envKeySourceFile`) which file — if any —
  // carried the proposal it is answering.
  const roots = [];
  after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });
  const KEYS = ['OBSIDIAN_ROUTER_DEFAULT_VAULT', 'OBSIDIAN_ROUTER_REFUSED_VAULT'];

  async function withCleanEnv(fn) {
    const saved = KEYS.map((k) => [k, Object.hasOwn(process.env, k), process.env[k]]);
    for (const k of KEYS) delete process.env[k];
    _resetWorkspaceDotenvProvenance();
    try { return await fn(); } finally {
      for (const [k, had, value] of saved) { if (had) process.env[k] = value; else delete process.env[k]; }
      _resetWorkspaceDotenvProvenance();
    }
  }
  function workspace(dotenv) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refuse-ws-'));
    roots.push(dir);
    if (dotenv !== null) fs.writeFileSync(path.join(dir, '.env'), dotenv, 'utf8');
    return dir;
  }
  const load = (dir) => applyWorkspaceDotenv({ cwd: dir, env: process.env, warn: () => {} });

  test('the .env that PROPOSED the vault receives the refusal line, beside the proposal', async () => {
    await withCleanEnv(async () => {
      const ws = workspace('# project\nOBSIDIAN_ROUTER_DEFAULT_VAULT=work\n');
      load(ws);
      const { written, seam } = seams();
      const reg = registryOf();
      const r = await confirmWorkspaceBinding(reg, { refuse: 'work' }, { ...seam, cwd: ws });
      assert.equal(r.hintWritten, true);
      assert.equal(r.envPath, path.join(ws, '.env'));
      assert.equal(r.silencesCurrentHint, true);
      const text = fs.readFileSync(path.join(ws, '.env'), 'utf8');
      assert.match(text, /^OBSIDIAN_ROUTER_DEFAULT_VAULT=work$/m, 'the proposal stays: the line answers it, it does not erase it');
      assert.match(text, /^OBSIDIAN_ROUTER_REFUSED_VAULT=work$/m);
      assert.match(text, /^# project$/m, 'the rest of the file is preserved');
      assert.match(r.message, /portable half/);
      assert.match(r.message, /may travel with the project/);
      assert.equal(written.length, 1, 'and the config half was written first');
    });
  });

  test('a name with whitespace is quoted like the proposal line, and reads back as the same name', async () => {
    await withCleanEnv(async () => {
      const ws = workspace('OBSIDIAN_ROUTER_DEFAULT_VAULT="my vault"\n');
      load(ws);
      assert.equal(process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT, 'my vault', 'the loader strips the quotes');
      const r = await confirmWorkspaceBinding(registryOf(), { refuse: 'my vault' }, { ...seams().seam, cwd: ws });
      assert.equal(r.hintWritten, true);
      const text = fs.readFileSync(path.join(ws, '.env'), 'utf8');
      assert.match(text, /^OBSIDIAN_ROUTER_REFUSED_VAULT="my vault"$/m);
      // Read back through the real loader, as the next start would.
      delete process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT;
      _resetWorkspaceDotenvProvenance();
      load(ws);
      assert.equal(process.env.OBSIDIAN_ROUTER_REFUSED_VAULT, 'my vault');
    });
  });

  test('a proposal from the HOST leaves the project file untouched — there is no line there to answer', async () => {
    await withCleanEnv(async () => {
      const ws = workspace('# nothing proposed here\n');
      process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT = 'work'; // the host's, so the loader records nothing for it
      load(ws);
      const r = await confirmWorkspaceBinding(registryOf(), { refuse: 'work' }, { ...seams().seam, cwd: ws });
      assert.equal(r.refused, true);
      assert.equal(r.hintWritten, false);
      assert.equal(fs.readFileSync(path.join(ws, '.env'), 'utf8'), '# nothing proposed here\n');
      // Not "the file did not propose it" — the file MAY carry the line; the
      // host's value simply won (parent wins), so the router took nothing from
      // the file and writes beside nothing. (Fable round on 7efbad1.)
      assert.match(r.message, /the proposal in force did not come from that file/);
      assert.doesNotMatch(r.message, /did not propose/);
    });
  });

  test('a file that proposed ANOTHER vault is not written into either — the line stands beside the proposal it answers', async () => {
    await withCleanEnv(async () => {
      const ws = workspace('OBSIDIAN_ROUTER_DEFAULT_VAULT=notes\n');
      load(ws);
      const r = await confirmWorkspaceBinding(registryOf(), { refuse: 'work' }, { ...seams().seam, cwd: ws });
      assert.equal(r.hintWritten, false);
      assert.doesNotMatch(fs.readFileSync(path.join(ws, '.env'), 'utf8'), /REFUSED/);
    });
  });

  test('the file must be THIS workspace\'s — a loader record from another directory is never written into', async () => {
    await withCleanEnv(async () => {
      const spoke = workspace('OBSIDIAN_ROUTER_DEFAULT_VAULT=work\n');
      load(spoke);
      const elsewhere = workspace(null);
      const r = await confirmWorkspaceBinding(registryOf(), { refuse: 'work' }, { ...seams().seam, cwd: elsewhere });
      assert.equal(r.refused, true);
      assert.equal(r.hintWritten, false);
      assert.doesNotMatch(fs.readFileSync(path.join(spoke, '.env'), 'utf8'), /REFUSED/);
      assert.equal(fs.existsSync(path.join(elsewhere, '.env')), false, 'and no file is created where nothing spoke');
    });
  });

  test('a file that cannot be written costs the reinstall memory, not the refusal', async () => {
    await withCleanEnv(async () => {
      const ws = workspace('OBSIDIAN_ROUTER_DEFAULT_VAULT=work\n');
      load(ws);
      const { written, seam } = seams();
      const r = await confirmWorkspaceBinding(registryOf(), { refuse: 'work' }, {
        ...seam, cwd: ws, upsertDotenv: async () => { throw new Error('EACCES: read-only checkout'); },
      });
      assert.equal(r.refused, true);
      assert.equal(written.length, 1, 'the config half — the one that decides — was recorded');
      assert.equal(r.hintWritten, false);
      assert.match(r.hintError, /EACCES/);
      assert.match(r.message, /could NOT be written/);
      assert.match(r.message, /in force from your config alone/);
    });
  });

  test('the value written goes through the shared dotenv validator — a name that would inject a line is refused before any write', async () => {
    // Belt and braces: `refusalName` already rejects a line break at the
    // boundary. This pins that the WRITER refuses too, so the boundary check
    // is not the only thing standing between a hostile name and the file.
    await withCleanEnv(async () => {
      const ws = workspace('OBSIDIAN_ROUTER_DEFAULT_VAULT=work\n');
      load(ws);
      const { upsertDotenvVar } = await import('../src/helpers/dotenv-writer.mjs');
      await assert.rejects(
        () => upsertDotenvVar(path.join(ws, '.env'), 'OBSIDIAN_ROUTER_REFUSED_VAULT', 'work\nOBSIDIAN_ROUTER_READONLY=false'),
        /refusing to persist/,
      );
      assert.doesNotMatch(fs.readFileSync(path.join(ws, '.env'), 'utf8'), /READONLY/);
    });
  });
});
