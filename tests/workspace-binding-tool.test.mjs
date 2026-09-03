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

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { confirmWorkspaceBinding } from '../src/tools/workspace-binding.mjs';
import * as lockModule from '../src/tools/lock.mjs';
import { canonicalWorkspaceKey, readBinding, WORKSPACE_BINDINGS_KEY } from '../src/helpers/workspace-bindings.mjs';

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
    assert.deepEqual(next, { vault: 'notes', locked: true });
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

  test('locking to a DIFFERENT vault than the binding drops the old `also`', async () => {
    // The secondaries belonged to the previous primary; carrying them onto a
    // different vault would invent a binding the user never made.
    const config = {
      [WORKSPACE_BINDINGS_KEY]: { [canonicalWorkspaceKey(CWD)]: { vault: 'notes', also: ['work'] } },
    };
    const { written, seam } = io(config);
    _internals.recordLockInBinding(registryOf(), CWD, 'work', seam);
    const b = readBinding(written[0], CWD);
    assert.equal(b.vault, 'work');
    assert.deepEqual(b.also, []);
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

  test('unlocking a workspace with no binding writes nothing to invent', async () => {
    const { written, seam } = io();
    const r = _internals.recordLockInBinding(registryOf(), CWD, null, seam);
    assert.equal(r, null);
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
