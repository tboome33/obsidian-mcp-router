/**
 * v0.90.0 — the workspace→vault binding leaves the repository.
 *
 * Points 1 and 2 of the accepted decision `liaison-workspace-vault-hors-depot`.
 * Until now the binding lived in the project's own dotenv file, which travels
 * with a `git clone`: the link between "this project" and "that vault of mine"
 * was decided by a file the user may never have written. It now lives in the
 * user's own config, keyed by the canonical workspace path — a file that is
 * never synchronised between machines, so one machine's confirmation never
 * binds another's.
 *
 * The property under test, in one sentence: a confirmed binding outranks the
 * environment, a hint is classified but never applied, and "no binding" means
 * ALL vaults rather than none.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  WORKSPACE_BINDINGS_KEY,
  HINT_STATUS,
  canonicalWorkspaceKey,
  normalizeBinding,
  readBinding,
  boundVaults,
  classifyBindingHint,
  hintIsWorthSignalling,
  withBinding,
  withoutBinding,
  updateConfigBindings,
  authoritativeDefaultVault,
  authoritativeLockedVault,
  authoritativeVaultPath,
  MIGRATION_KEY,
  IMPORT_REASON,
  readMigrationState,
  migrationDecision,
  withMigrationState,
} from '../src/helpers/workspace-bindings.mjs';
import { acquireLock, lockPathFor } from '../src/helpers/file-lock.mjs';
import {
  applyWorkspaceDotenv,
  _resetWorkspaceDotenvProvenance,
} from '../src/helpers/workspace-dotenv.mjs';
import { blankStringsAndComments } from './_source-scan.mjs';
import { _internals, loadRegistry } from '../src/registry.mjs';

const { resolveDefaultVaultWithSource } = _internals;

const VAULTS = [
  { name: 'notes', type: 'local' },
  { name: 'work', type: 'local' },
  { name: 'archive', type: 'local' },
];
const isRegistered = (n) => VAULTS.some((v) => v.name === n);

describe('canonicalWorkspaceKey — one workspace, one key', () => {
  test('a relative path and its absolute spelling produce the SAME key', () => {
    // Two spellings of one directory must not become two bindings: the user
    // would confirm once and be asked again from the other spelling.
    assert.equal(canonicalWorkspaceKey('.'), canonicalWorkspaceKey(process.cwd()));
  });

  test('a trailing separator does not create a second key', () => {
    const base = process.cwd();
    assert.equal(canonicalWorkspaceKey(base + path.sep), canonicalWorkspaceKey(base));
  });

  test('nothing usable in, null out — never a key built from an empty string', () => {
    for (const bad of ['', '   ', null, undefined, 42, {}]) {
      assert.equal(canonicalWorkspaceKey(bad), null, JSON.stringify(bad));
    }
  });
});

describe('normalizeBinding — a config file is a file, so validate at the boundary', () => {
  test('a well-formed binding keeps its shape', () => {
    assert.deepEqual(
      normalizeBinding({ vault: 'notes', also: ['work'], locked: true, confirmedAt: '2026-09-03', confirmedVia: 'tool' }),
      { vault: 'notes', also: ['work'], locked: true, confirmedAt: '2026-09-03', confirmedVia: 'tool' },
    );
  });

  test('a missing or empty primary vault is NOT a binding — half-formed is worse than none', () => {
    for (const bad of [null, undefined, 42, 'notes', [], {}, { vault: '' }, { vault: '   ' }, { also: ['work'] }]) {
      assert.equal(normalizeBinding(bad), null, JSON.stringify(bad));
    }
  });

  test('`also` is cleaned: non-strings dropped, duplicates dropped, the primary never repeated', () => {
    const b = normalizeBinding({ vault: 'notes', also: ['work', 'work', 'notes', '', null, 7, 'archive'] });
    assert.deepEqual(b.also, ['work', 'archive'],
      'the primary in `also` would make "one vault" and "several" ambiguous for the briefing');
  });

  test('`locked` is true only when it is literally true, never merely truthy', () => {
    for (const v of ['true', 1, {}, 'yes']) {
      assert.equal(normalizeBinding({ vault: 'notes', locked: v }).locked, false, JSON.stringify(v));
    }
    assert.equal(normalizeBinding({ vault: 'notes', locked: true }).locked, true);
  });
});

describe('readBinding — what THIS workspace is bound to', () => {
  const cwd = process.cwd();
  const withBinding = (value, key = canonicalWorkspaceKey(cwd)) => ({
    [WORKSPACE_BINDINGS_KEY]: { [key]: value },
  });

  test('the binding for this workspace is found and normalised', () => {
    const b = readBinding(withBinding({ vault: 'notes', also: ['work'] }), cwd);
    assert.equal(b.vault, 'notes');
    assert.deepEqual(b.also, ['work']);
  });

  test('a config with no bindings at all is not an error — it is "all vaults"', () => {
    for (const cfg of [{}, null, undefined, { workspaceBindings: null }, { workspaceBindings: [] }]) {
      assert.equal(readBinding(cfg, cwd), null, JSON.stringify(cfg));
    }
  });

  test('ANOTHER workspace\'s binding is not this one\'s', () => {
    const other = canonicalWorkspaceKey(path.join(cwd, 'some', 'other', 'project'));
    assert.equal(readBinding(withBinding({ vault: 'notes' }, other), cwd), null);
  });

  test('a hand-edited config whose key is not canonical is still matched', () => {
    // The stored keys are canonicalised when written, but a human may edit the
    // file. Canonicalising BOTH sides beats trusting the file's spelling — the
    // same reason the vault registry compares normalised paths.
    const raw = cwd + path.sep;
    const b = readBinding(withBinding({ vault: 'work' }, raw), cwd);
    assert.ok(b, 'a trailing separator in the stored key must not hide the binding');
    assert.equal(b.vault, 'work');
  });
});

describe('boundVaults — the three states, read as the briefing will read them', () => {
  test('one vault, several vaults, or ALL of them', () => {
    assert.deepEqual(boundVaults(normalizeBinding({ vault: 'notes' })), ['notes'], 'one');
    assert.deepEqual(boundVaults(normalizeBinding({ vault: 'notes', also: ['work', 'archive'] })),
      ['notes', 'work', 'archive'], 'several — the primary first');
    assert.deepEqual(boundVaults(null), [],
      'no binding: EMPTY means "all vaults are available", never "no vault"');
  });
});

describe('classifyBindingHint — the hint is classified, never applied', () => {
  const binding = normalizeBinding({ vault: 'notes' });

  test('no hint at all, and a hint that agrees with the binding, are both silence', () => {
    for (const hint of [undefined, null, '', '   ']) {
      assert.equal(classifyBindingHint({ hint, binding, isRegistered }).status, HINT_STATUS.NONE, JSON.stringify(hint));
    }
    assert.equal(classifyBindingHint({ hint: 'notes', binding, isRegistered }).status, HINT_STATUS.CONFIRMED);
    assert.equal(hintIsWorthSignalling({ status: HINT_STATUS.NONE }), false);
    assert.equal(hintIsWorthSignalling({ status: HINT_STATUS.CONFIRMED }), false,
      'repeating "your file agrees with your registry" every start trains people to stop reading');
  });

  test('a hint naming a REGISTERED vault this workspace never confirmed is "unconfirmed"', () => {
    const c = classifyBindingHint({ hint: 'work', binding: null, isRegistered });
    assert.equal(c.status, HINT_STATUS.UNCONFIRMED);
    assert.equal(c.hint, 'work');
    assert.equal(c.boundTo, null);
    assert.equal(hintIsWorthSignalling(c), true);
  });

  test('a hint naming a vault this machine does not have is "unknown-vault"', () => {
    const c = classifyBindingHint({ hint: 'ghost', binding: null, isRegistered });
    assert.equal(c.status, HINT_STATUS.UNKNOWN_VAULT);
    assert.equal(hintIsWorthSignalling(c), true);
  });

  test('a binding plus a file naming a DIFFERENT vault is "conflicts" — and names both sides', () => {
    // The case the decision was written for: the file arrived with a clone (or
    // followed the user from another machine) and disagrees with what this
    // machine's owner confirmed.
    const c = classifyBindingHint({ hint: 'archive', binding, isRegistered });
    assert.equal(c.status, HINT_STATUS.CONFLICTS);
    assert.equal(c.hint, 'archive');
    assert.equal(c.boundTo, 'notes', 'the user has to be told what wins, not only what was refused');
    assert.equal(hintIsWorthSignalling(c), true);
  });
});

describe('withBinding / withoutBinding — pure transforms, so every rule is testable without a disk', () => {
  const cwd = process.cwd();

  test('a binding is written under the CANONICAL key and reads straight back', () => {
    const next = withBinding({}, cwd, { vault: 'notes', also: ['work'] });
    assert.deepEqual(Object.keys(next[WORKSPACE_BINDINGS_KEY]), [canonicalWorkspaceKey(cwd)]);
    const b = readBinding(next, cwd);
    assert.equal(b.vault, 'notes');
    assert.deepEqual(b.also, ['work']);
  });

  test('PURE: the input config is not mutated', () => {
    const before = { defaultVault: 'work' };
    const after = withBinding(before, cwd, { vault: 'notes' });
    assert.deepEqual(before, { defaultVault: 'work' }, 'the caller keeps its object');
    assert.equal(after.defaultVault, 'work', 'and the rest of the config rides along');
  });

  test('PURE against a config that ALREADY HAS bindings — the nested map is copied, not edited', () => {
    // The test above starts from a config with no `workspaceBindings` key, so
    // it cannot tell a copy from an in-place edit of the nested object: there
    // is no nested object yet. Every real call has one. Codex flagged it on
    // 2026-09-03, and it matters because `updateConfigBindings` reads the file
    // and hands the parsed object to these transforms — an in-place edit would
    // make "pure" false exactly where a caller might reuse the input to
    // compare before and after.
    const other = path.join(cwd, 'another-workspace');
    const before = {
      defaultVault: 'work',
      [WORKSPACE_BINDINGS_KEY]: {
        [canonicalWorkspaceKey(other)]: { vault: 'archive', also: [] },
      },
    };
    const snapshot = JSON.parse(JSON.stringify(before));
    const nestedBefore = before[WORKSPACE_BINDINGS_KEY];

    const after = withBinding(before, cwd, { vault: 'notes' });
    assert.deepEqual(before, snapshot, 'the caller keeps its object, nested map included');
    assert.notEqual(after[WORKSPACE_BINDINGS_KEY], nestedBefore, 'a NEW map, not the same object');
    assert.equal(Object.keys(after[WORKSPACE_BINDINGS_KEY]).length, 2, 'the other workspace survives');
    assert.equal(readBinding(after, other).vault, 'archive');
  });

  test('PURE: withoutBinding does not mutate either, and leaves other workspaces alone', () => {
    // `withoutBinding` had NO purity assertion at all.
    const other = path.join(cwd, 'another-workspace');
    const before = {
      [WORKSPACE_BINDINGS_KEY]: {
        [canonicalWorkspaceKey(cwd)]: { vault: 'notes', also: [] },
        [canonicalWorkspaceKey(other)]: { vault: 'archive', also: [] },
      },
    };
    const snapshot = JSON.parse(JSON.stringify(before));
    const nestedBefore = before[WORKSPACE_BINDINGS_KEY];

    const after = withoutBinding(before, cwd);
    assert.deepEqual(before, snapshot, 'the caller keeps its object');
    assert.notEqual(after[WORKSPACE_BINDINGS_KEY], nestedBefore);
    assert.equal(readBinding(after, cwd), null, 'this workspace is unbound');
    assert.equal(readBinding(after, other).vault, 'archive', 'the other one is untouched');
  });

  test('re-binding REPLACES rather than accumulating', () => {
    const once = withBinding({}, cwd, { vault: 'notes' });
    const twice = withBinding(once, cwd, { vault: 'archive' });
    assert.equal(Object.keys(twice[WORKSPACE_BINDINGS_KEY]).length, 1);
    assert.equal(readBinding(twice, cwd).vault, 'archive');
  });

  test('a hand-edited config holding the SAME workspace under two spellings collapses to one', () => {
    // Otherwise `readBinding`'s answer would depend on object key order, which
    // is a coin toss dressed as a rule.
    const dirty = {
      [WORKSPACE_BINDINGS_KEY]: {
        [cwd + path.sep]: { vault: 'stale' },
        [canonicalWorkspaceKey(cwd)]: { vault: 'alsoStale' },
      },
    };
    const next = withBinding(dirty, cwd, { vault: 'fresh' });
    assert.equal(Object.keys(next[WORKSPACE_BINDINGS_KEY]).length, 1);
    assert.equal(readBinding(next, cwd).vault, 'fresh');
  });

  test('`confirmedAt` is stamped when the caller does not supply one, and kept when it does', () => {
    assert.match(readBinding(withBinding({}, cwd, { vault: 'notes' }), cwd).confirmedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(
      readBinding(withBinding({}, cwd, { vault: 'notes', confirmedAt: '2020-01-01' }), cwd).confirmedAt,
      '2020-01-01',
    );
  });

  test('an invalid binding changes NOTHING — a half-formed entry is worse than none', () => {
    const before = { defaultVault: 'work' };
    for (const bad of [null, undefined, {}, { vault: '' }, { also: ['x'] }, 'notes']) {
      assert.deepEqual(withBinding(before, cwd, bad), before, JSON.stringify(bad));
    }
  });

  test('removing returns the workspace to "all vaults", and leaves other workspaces alone', () => {
    const other = canonicalWorkspaceKey(path.join(cwd, 'elsewhere'));
    let cfg = withBinding({}, cwd, { vault: 'notes' });
    cfg = { ...cfg, [WORKSPACE_BINDINGS_KEY]: { ...cfg[WORKSPACE_BINDINGS_KEY], [other]: { vault: 'work' } } };
    const after = withoutBinding(cfg, cwd);
    assert.equal(readBinding(after, cwd), null, 'this workspace: no binding = all vaults');
    assert.equal(Object.keys(after[WORKSPACE_BINDINGS_KEY]).length, 1, "another workspace's binding survives");
  });

  test('removing from a config that never had bindings is a no-op, not a crash', () => {
    assert.deepEqual(withoutBinding({ defaultVault: 'work' }, cwd), { defaultVault: 'work' });
    assert.doesNotThrow(() => withoutBinding(null, cwd));
  });
});

describe('THE CASCADE — a confirmed binding outranks the environment', () => {
  const withEnv = (value, fn) => {
    const before = process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT;
    if (value === undefined) delete process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT;
    else process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT = value;
    try { return fn(); } finally {
      if (before === undefined) delete process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT;
      else process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT = before;
    }
  };

  test('THE POINT: the binding wins over a dotenv value naming another vault', () => {
    // This is the whole lot in one assertion. Before v0.90.0 the environment
    // won and the file decided; now the user's own confirmed answer does.
    const r = withEnv('archive', () => resolveDefaultVaultWithSource({
      vaults: VAULTS, configuredDefault: 'work', binding: normalizeBinding({ vault: 'notes' }),
    }));
    assert.equal(r.name, 'notes');
    assert.equal(r.origin, 'binding');
    assert.equal(r.variable, null, 'no environment variable produced this answer');
  });

  test('with NO binding, the environment still resolves the session exactly as before', () => {
    // The lot must not break the ordinary case: a hint naming a registered
    // vault, on a workspace nobody has bound, still picks that vault.
    const r = withEnv('archive', () => resolveDefaultVaultWithSource({
      vaults: VAULTS, configuredDefault: 'work', binding: null,
    }));
    assert.equal(r.name, 'archive');
    assert.equal(r.variable, 'OBSIDIAN_ROUTER_DEFAULT_VAULT');
  });

  test('a binding whose vault was disabled or removed FALLS THROUGH instead of bricking the session', () => {
    // Same friendly failure the other tiers already have. A stale binding must
    // not make every tool call fail; it must quietly lose its turn.
    const r = withEnv(undefined, () => resolveDefaultVaultWithSource({
      vaults: VAULTS, configuredDefault: 'work', binding: normalizeBinding({ vault: 'gone' }),
    }));
    assert.equal(r.name, 'work');
    assert.equal(r.origin, 'config');
  });

  test('`also` does not change WHICH vault is the default — only the primary does', () => {
    const r = withEnv(undefined, () => resolveDefaultVaultWithSource({
      vaults: VAULTS, configuredDefault: 'work',
      binding: normalizeBinding({ vault: 'notes', also: ['archive'] }),
    }));
    assert.equal(r.name, 'notes', 'secondaries are addressable, not default');
  });

  test('no binding and no environment: the cascade below is untouched', () => {
    const r = withEnv(undefined, () => resolveDefaultVaultWithSource({
      vaults: VAULTS, configuredDefault: 'work', binding: null,
    }));
    assert.equal(r.name, 'work');
    assert.equal(r.origin, 'config');
  });
});

describe('updateConfigBindings — the ONE writer, and the lock that makes it one', () => {
  test('the read-modify-write happens INSIDE the lock, and the lock is released after', () => {
    // Re-reading the file before writing narrows the lost-update window; it
    // does not close it, because the read and the rename are two syscalls with
    // a gap. Codex, 2026-09-03: A reads, B reads, B writes, A writes — both
    // atomically — and B is gone. The file holds every vault's API key, so the
    // thing lost can be a key added a moment ago.
    //
    // The ORDER is what this pins: lock, then read, then write, then release.
    const order = [];
    const next = updateConfigBindings('/cfg/config.json', (c) => ({ ...c, touched: true }), {
      lock: () => { order.push('lock'); return () => order.push('release'); },
      readFile: () => { order.push('read'); return JSON.stringify({ portRegistry: {} }); },
      writeFile: () => { order.push('write'); },
    });
    assert.deepEqual(order, ['lock', 'read', 'write', 'release']);
    assert.equal(next.touched, true);
  });

  test('a lock that cannot be taken REFUSES the write instead of racing it', () => {
    let wrote = false;
    assert.throws(
      () => updateConfigBindings('/cfg/config.json', (c) => c, {
        lock: () => null,
        readFile: () => '{}',
        writeFile: () => { wrote = true; },
      }),
      /another process is writing the router config/,
    );
    assert.equal(wrote, false, 'writing anyway would discard exactly what the lock protects');
  });

  test('the lock is released even when the transform throws', () => {
    let released = false;
    assert.throws(() => updateConfigBindings('/cfg/config.json', () => { throw new Error('boom'); }, {
      lock: () => () => { released = true; },
      readFile: () => '{}',
      writeFile: () => {},
    }), /boom/);
    assert.equal(released, true, 'a crashed transform must not strand the lock for everyone else');
  });

  test('the lock is released when the config cannot be parsed', () => {
    let released = false;
    assert.throws(() => updateConfigBindings('/cfg/config.json', (c) => c, {
      lock: () => () => { released = true; },
      readFile: () => 'not json',
      writeFile: () => {},
    }), /cannot read the router config/);
    assert.equal(released, true);
  });
});

describe('acquireLock — mutual exclusion between processes', () => {
  test('a second acquisition fails while the first is held, and succeeds after release', () => {
    // Pinned HERE as well as in the bootstrapper's suite, because the config
    // writer now depends on it. `mkdirSync` with `{ recursive: true }` would
    // silently make this pass twice — recursive mkdir succeeds on an existing
    // directory — which removes the mutual exclusion while looking tidier.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-lock-'));
    const lockPath = path.join(dir, 'the.lock');
    try {
      const release = acquireLock(lockPath, { waitMs: 0 });
      assert.ok(release, 'first acquisition');
      assert.equal(acquireLock(lockPath, { waitMs: 0 }), null, 'second must fail while held');
      release();
      const again = acquireLock(lockPath, { waitMs: 0 });
      assert.ok(again, 'reusable after release');
      again();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Make a lock directory look abandoned by BACKDATING it, rather than by
   * passing a negative `staleMs`.
   *
   * The first version did the latter, and it was flaky: `age = Date.now() -
   * mtimeMs`, and on Windows `Date.now()` has ~15 ms granularity while the
   * filesystem's mtime is finer, so a lock created in the same instant can
   * report a mtime slightly in the FUTURE. The age is then about -15, which is
   * not greater than -1, and the reap does not happen. Caught by running the
   * suite three times while checking an unrelated mutation — a test that fails
   * one run in three is a test that will be ignored.
   */
  const backdate = (lockPath, ms) => {
    const when = new Date(Date.now() - ms);
    fs.utimesSync(lockPath, when, when);
  };

  test('a lock orphaned by a killed process is reaped, not waited on forever', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-stale-'));
    const lockPath = path.join(dir, 'the.lock');
    try {
      fs.mkdirSync(lockPath);
      backdate(lockPath, 10 * 60_000);
      const release = acquireLock(lockPath, { waitMs: 0, staleMs: 60_000 });
      assert.ok(release, 'a stale lock is taken over rather than blocking every future write');
      release();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('two different config paths never block each other; two spellings of ONE path share a lock', () => {
    assert.notEqual(lockPathFor('/a/config.json', 'config'), lockPathFor('/b/config.json', 'config'));
    assert.equal(lockPathFor('/a/config.json', 'config'), lockPathFor('/a/config.json', 'config'));
    // Keyed on the CANONICAL path. Round 2: the first version hashed the raw
    // `path.resolve`, so on Windows two casings of one config took two locks
    // and overwrote each other.
    assert.equal(lockPathFor('/a/./config.json', 'config'), lockPathFor('/a/sub/../config.json', 'config'));
    if (process.platform === 'win32') {
      assert.equal(lockPathFor('D:\\Router\\config.json', 'config'), lockPathFor('d:\\router\\CONFIG.JSON', 'config'));
    }
  });

  test('a holder that was reaped while suspended does NOT delete the reaper\'s lock on release', () => {
    // Round 2, both passes: reaping by age alone cannot tell a dead holder
    // from a slow live one. A suspended past the stale threshold, B reaps and
    // takes the lock, A resumes and its release deleted B's lock, C walked in
    // beside B. The owner token inside the directory is what makes A's late
    // release a no-op instead of a hole.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-owner-'));
    const lockPath = path.join(dir, 'the.lock');
    try {
      const releaseA = acquireLock(lockPath, { waitMs: 0 });
      assert.ok(releaseA);
      // B arrives, finds A "stale", reaps and acquires. Backdated rather than
      // forced with a negative threshold — see `backdate` above.
      backdate(lockPath, 10 * 60_000);
      const releaseB = acquireLock(lockPath, { waitMs: 0, staleMs: 60_000 });
      assert.ok(releaseB, 'B took the lock over');
      // A resumes and releases — the directory is B's now.
      releaseA();
      assert.ok(fs.existsSync(lockPath), 'A\'s release must not delete B\'s lock');
      assert.equal(acquireLock(lockPath, { waitMs: 0 }), null, 'C is still kept out');
      releaseB();
      assert.equal(fs.existsSync(lockPath), false, 'B\'s release removes B\'s lock');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a lock that cannot be created for a reason OTHER than contention throws, so nobody is blamed for holding it', () => {
    // Round 2: every non-EEXIST failure used to become `null`, and the caller
    // reported "another process is writing" for an unwritable temp directory
    // where no process was writing anything.
    const missingParent = path.join(os.tmpdir(), 'wb-no-such-parent-' + Date.now(), 'nested', 'the.lock');
    assert.throws(() => acquireLock(missingParent, { waitMs: 0 }), /ENOENT/);
  });
});

describe('readBinding — the answer does not depend on JSON key order', () => {
  const cwd = process.cwd();

  test('two NON-canonical spellings of one workspace resolve the same way whichever comes first', () => {
    // The exact-key fast path does not help here: NEITHER spelling is the
    // canonical one, so both go through the fallback scan — which returned the
    // first match in object order. Re-saving the config with its keys in a
    // different order therefore changed which vault the workspace was bound
    // to, silently. Found by the Codex review, 2026-09-03.
    //
    // Two spellings that collide on EVERY platform. The first version used an
    // uppercase spelling and returned early where case is significant — which
    // is every POSIX runner, so the test asserted nothing there. Round 2.
    const dotted = path.join(cwd, '.') + path.sep;      // `<cwd>/./`
    const detour = path.join(cwd, 'sub', '..');          // `<cwd>/sub/..`
    assert.equal(canonicalWorkspaceKey(dotted), canonicalWorkspaceKey(cwd), 'precondition');
    assert.equal(canonicalWorkspaceKey(detour), canonicalWorkspaceKey(cwd), 'precondition');
    assert.notEqual(dotted, detour);
    const upper = dotted;
    const trailing = detour;

    const a = { [WORKSPACE_BINDINGS_KEY]: { [upper]: { vault: 'alpha' }, [trailing]: { vault: 'beta' } } };
    const b = { [WORKSPACE_BINDINGS_KEY]: { [trailing]: { vault: 'beta' }, [upper]: { vault: 'alpha' } } };
    assert.equal(
      readBinding(a, cwd).vault,
      readBinding(b, cwd).vault,
      'the same config content must give the same answer in either key order',
    );
  });

  test('an EXACT canonical key still wins over any other spelling', () => {
    const key = canonicalWorkspaceKey(cwd);
    const config = {
      [WORKSPACE_BINDINGS_KEY]: {
        [cwd + path.sep]: { vault: 'stale' },
        [key]: { vault: 'current' },
      },
    };
    assert.equal(readBinding(config, cwd).vault, 'current');
  });
});

describe('the ONE-TIME import — every rule, without a disk', () => {
  const base = {
    binding: null,
    hint: 'notes',
    hintOrigin: 'workspace-dotenv',
    isRegistered: (n) => n === 'notes' || n === 'work',
    dotenvMtimeMs: Date.parse('2026-01-01T00:00:00Z'),
    openedAt: '2026-09-03T00:00:00Z',
    alreadyImported: false,
  };
  const decide = (over = {}) => migrationDecision({ ...base, ...over });

  test('the ordinary case: a hint older than the upgrade, naming a registered vault, is imported', () => {
    assert.deepEqual(decide(), { import: true, vault: 'notes', reason: IMPORT_REASON.IMPORTED });
  });

  test('a workspace that ALREADY has a binding is left alone', () => {
    assert.equal(decide({ binding: { vault: 'work' } }).reason, IMPORT_REASON.ALREADY_BOUND);
  });

  test('a workspace already imported is NEVER imported again — this is what makes a `clear` permanent', () => {
    // Without it, the next start would re-import the still-present hint and
    // quietly undo the user's decision to unbind. The one rule of this whole
    // mechanism that protects an explicit human act.
    assert.equal(decide({ alreadyImported: true }).reason, IMPORT_REASON.ALREADY_CONSIDERED);
  });

  test('no hint, nothing to import', () => {
    for (const hint of [undefined, null, '', '   ', 42]) {
      assert.equal(decide({ hint }).reason, IMPORT_REASON.NO_HINT, JSON.stringify(hint));
    }
  });

  test('a HOST value is not migrated — it is already an authority, and importing it would record a confirmation nobody gave', () => {
    for (const hintOrigin of ['host', 'runtime', 'unknown', null]) {
      assert.equal(decide({ hintOrigin }).reason, IMPORT_REASON.NOT_FROM_A_FILE, String(hintOrigin));
    }
  });

  test('a hint naming no registered vault is not imported', () => {
    assert.equal(decide({ hint: 'ghost' }).reason, IMPORT_REASON.UNKNOWN_VAULT);
  });

  test('THE WINDOW: a dotenv file NEWER than the upgrade is refused — this is what closes the migration', () => {
    // The discrimination the whole design rests on. `git clone` writes its
    // files now, so a freshly cloned repository's `.env` is always newer than
    // `openedAt` and never imported; a workspace attached last year is always
    // older. An import that kept running would be the old behaviour with a
    // delay — the `.env` deciding again, forever.
    assert.equal(decide({ dotenvMtimeMs: Date.parse('2026-09-04T00:00:00Z') }).reason,
      IMPORT_REASON.NEWER_THAN_UPGRADE);
    // Exactly at the instant counts as after: the window opens, then closes
    // behind everything that arrives from that moment on.
    assert.equal(decide({ dotenvMtimeMs: Date.parse('2026-09-03T00:00:00Z') }).reason,
      IMPORT_REASON.NEWER_THAN_UPGRADE);
    assert.equal(decide({ dotenvMtimeMs: Date.parse('2026-09-02T23:59:59Z') }).reason,
      IMPORT_REASON.IMPORTED);
  });

  test('no window recorded yet: this start is the one that opens it, so everything on disk predates it', () => {
    assert.equal(decide({ openedAt: null, dotenvMtimeMs: Date.now() }).reason, IMPORT_REASON.IMPORTED);
  });

  test('an unreadable mtime or an unparseable window does not silently open the door forever', () => {
    // Both are "we cannot tell". The choice is to import — the migration's
    // whole purpose — and it stays bounded because `alreadyImported` is
    // recorded either way.
    assert.equal(decide({ dotenvMtimeMs: null }).reason, IMPORT_REASON.IMPORTED);
    assert.equal(decide({ openedAt: 'not a date' }).reason, IMPORT_REASON.IMPORTED);
  });

  test('the reasons are exhaustive — every path names itself', () => {
    const seen = new Set([
      decide().reason,
      decide({ binding: { vault: 'work' } }).reason,
      decide({ alreadyImported: true }).reason,
      decide({ hint: '' }).reason,
      decide({ hintOrigin: 'host' }).reason,
      decide({ hint: 'ghost' }).reason,
      decide({ dotenvMtimeMs: Date.parse('2026-09-04T00:00:00Z') }).reason,
    ]);
    assert.deepEqual([...seen].sort(), Object.values(IMPORT_REASON).sort());
  });
});

describe('the migration state — read and written at the boundary', () => {
  const cwd = process.cwd();

  test('a malformed block yields an empty state rather than a throw', () => {
    for (const raw of [undefined, null, 'x', [], { openedAt: 42 }, { imported: 'no' }, { imported: [1, null] }]) {
      const s = readMigrationState({ [MIGRATION_KEY]: raw });
      assert.equal(typeof s.openedAt === 'string' || s.openedAt === null, true, JSON.stringify(raw));
      assert.equal(s.imported.size, 0, JSON.stringify(raw));
    }
  });

  test('stored keys are canonicalised on the way IN, so a hand-edited spelling still counts as imported', () => {
    const s = readMigrationState({ [MIGRATION_KEY]: { openedAt: 'x', imported: [cwd + path.sep] } });
    assert.equal(s.imported.has(canonicalWorkspaceKey(cwd)), true);
  });

  test('withMigrationState opens the window ONCE and never moves it', () => {
    const first = withMigrationState({}, { at: '2026-09-03T00:00:00Z' });
    assert.equal(first[MIGRATION_KEY].openedAt, '2026-09-03T00:00:00Z');
    const later = withMigrationState(first, { at: '2027-01-01T00:00:00Z' });
    assert.equal(later[MIGRATION_KEY].openedAt, '2026-09-03T00:00:00Z', 'the window is not reopened');
  });

  test('recording is idempotent, keyed canonically, and PURE', () => {
    const before = withMigrationState({}, { at: '2026-09-03T00:00:00Z' });
    const snapshot = JSON.parse(JSON.stringify(before));
    const once = withMigrationState(before, { cwd, recordImported: true });
    const twice = withMigrationState(once, { cwd: cwd + path.sep, recordImported: true });
    assert.deepEqual(before, snapshot, 'the caller keeps its object');
    assert.deepEqual(twice[MIGRATION_KEY].imported, [canonicalWorkspaceKey(cwd)], 'recorded once');
  });

  test('the window is opened even when nothing is imported — otherwise every later workspace looks pre-upgrade', () => {
    const opened = withMigrationState({}, { at: '2026-09-03T00:00:00Z', recordImported: false });
    assert.equal(opened[MIGRATION_KEY].openedAt, '2026-09-03T00:00:00Z');
    assert.deepEqual(opened[MIGRATION_KEY].imported, []);
  });
});

describe('the ONE-TIME import, END TO END through loadRegistry', () => {
  /**
   * A real config, a real workspace, a real `.env`, and the registry loaded
   * from `process.cwd()`. The unit tests above pin every RULE; this pins that
   * the rules are actually wired to a disk — the gap round 1 found twice, in
   * `--attach` and in the lock, where a private function was proven and its
   * caller was not.
   */
  const roots = [];
  const scenario = ({ hintAge = 'old', bindings, migration } = {}) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
    roots.push(root);
    const vault = path.join(root, 'notes');
    fs.mkdirSync(vault, { recursive: true });
    const ws = path.join(root, 'project');
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, '.env'), 'OBSIDIAN_ROUTER_DEFAULT_VAULT=notes\n', 'utf8');
    if (hintAge === 'old') {
      const old = new Date('2020-01-01T00:00:00Z');
      fs.utimesSync(path.join(ws, '.env'), old, old);
    }
    const configPath = path.join(root, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      portRegistry: { [vault]: 27124 },
      vaultNames: { [vault]: 'notes' },
      ...(bindings ? { [WORKSPACE_BINDINGS_KEY]: bindings } : {}),
      ...(migration ? { [MIGRATION_KEY]: migration } : {}),
    }, null, 2), 'utf8');
    return { root, ws, vault, configPath, read: () => JSON.parse(fs.readFileSync(configPath, 'utf8')) };
  };

  /** Load the registry AS IF the router had started in `ws`. */
  async function loadIn(sc) {
    const prevCwd = process.cwd();
    const hadVault = Object.hasOwn(process.env, 'OBSIDIAN_ROUTER_DEFAULT_VAULT');
    const prevVault = process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT;
    _resetWorkspaceDotenvProvenance();
    delete process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT;
    process.chdir(sc.ws);
    try {
      applyWorkspaceDotenv({ cwd: sc.ws, env: process.env, warn: () => {} });
      return await loadRegistry({ configPath: sc.configPath });
    } finally {
      process.chdir(prevCwd);
      if (hadVault) process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT = prevVault;
      else delete process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT;
      _resetWorkspaceDotenvProvenance();
    }
  }

  after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

  test('a pre-existing hint becomes a binding IN THIS SESSION, named as an import, and the window opens', async () => {
    const sc = scenario();
    const reg = await loadIn(sc);

    assert.equal(reg.defaultVault, 'notes', 'in force immediately, not at the next start');
    assert.deepEqual(reg.defaultVaultSource, { origin: 'binding', variable: null });
    assert.equal(reg.bindingImported?.vault, 'notes');
    assert.ok(reg.bindingImported.dotenvFile, 'the report names the file it came from');

    const cfg = sc.read();
    const entry = cfg[WORKSPACE_BINDINGS_KEY][canonicalWorkspaceKey(sc.ws)];
    assert.equal(entry.vault, 'notes');
    assert.equal(entry.confirmedVia, 'migration', 'a confirmation nobody gave is labelled as such');
    assert.equal(cfg[MIGRATION_KEY].imported.length, 1);
    assert.ok(cfg[MIGRATION_KEY].openedAt);
  });

  test('the SECOND start imports nothing and reports nothing — once means once', async () => {
    const sc = scenario();
    await loadIn(sc);
    const reg2 = await loadIn(sc);
    assert.equal(reg2.bindingImported, null);
    assert.equal(reg2.workspaceBinding.vault, 'notes', 'the binding is simply read now');
    assert.equal(sc.read()[MIGRATION_KEY].imported.length, 1, 'recorded once');
  });

  test('A CLEAR IS NEVER UNDONE: after the user unbinds, the still-present hint is not re-imported', async () => {
    // The rule the whole `imported` list exists for. Without it the next start
    // would re-import and silently reverse an explicit human decision — the
    // single worst thing an automatic migration can do.
    const sc = scenario();
    await loadIn(sc);
    const cfg = sc.read();
    delete cfg[WORKSPACE_BINDINGS_KEY][canonicalWorkspaceKey(sc.ws)];
    fs.writeFileSync(sc.configPath, JSON.stringify(cfg, null, 2), 'utf8');

    const reg = await loadIn(sc);
    assert.equal(reg.bindingImported, null);
    assert.equal(reg.workspaceBinding, null, 'still unbound');
    assert.notEqual(reg.defaultVaultSource.origin, 'binding');
  });

  test('a hint NEWER than the window is not imported — the freshly cloned repository case', async () => {
    // The window was opened yesterday; this `.env` was written now, which is
    // what `git clone` does to every file it checks out.
    const sc = scenario({ hintAge: 'new', migration: { openedAt: '2020-01-01T00:00:00Z', imported: [] } });
    const reg = await loadIn(sc);
    assert.equal(reg.bindingImported, null);
    assert.equal(reg.workspaceBinding, null);
    assert.equal(reg.bindingHint.status, HINT_STATUS.UNCONFIRMED, 'signalled instead, as any hint is');
    assert.deepEqual(sc.read()[MIGRATION_KEY].imported, [], 'and not recorded, since nothing was imported');
  });

  test('an existing binding is never overwritten by the import', async () => {
    const sc = scenario({ bindings: { [canonicalWorkspaceKey(fs.realpathSync(os.tmpdir()))]: { vault: 'notes' } } });
    const cfg = sc.read();
    cfg[WORKSPACE_BINDINGS_KEY] = { [canonicalWorkspaceKey(sc.ws)]: { vault: 'notes', also: ['x'], confirmedVia: 'tool' } };
    fs.writeFileSync(sc.configPath, JSON.stringify(cfg, null, 2), 'utf8');
    const reg = await loadIn(sc);
    assert.equal(reg.bindingImported, null);
    assert.equal(reg.workspaceBinding.confirmedVia, 'tool', 'the user\'s own confirmation is untouched');
  });

  test('an unwritable config does not stop the router from starting', async () => {
    // Best effort in the strict sense. The import is a convenience; the router
    // starting is not.
    const sc = scenario();
    const reg = await loadRegistryWithBrokenWrite(sc);
    assert.equal(reg.bindingImported, null, 'nothing claimed');
    assert.ok(Array.isArray(reg.vaults), 'and the registry loaded anyway');
  });

  /** Load with the config made unwritable for the duration. */
  async function loadRegistryWithBrokenWrite(sc) {
    fs.chmodSync(sc.configPath, 0o444);
    // On Windows a read-only flag does not stop a rename, so also hold the
    // lock the writer needs — the other way a write is refused.
    const release = acquireLock(lockPathFor(sc.configPath, 'config'), { waitMs: 0 });
    try {
      return await loadIn(sc);
    } finally {
      if (release) release();
      try { fs.chmodSync(sc.configPath, 0o644); } catch { /* best effort */ }
    }
  }
});

// ---------------------------------------------------------------------------
// THE GATE, AND THE CLASS IT CLOSES
// ---------------------------------------------------------------------------

/**
 * `authoritativeDefaultVault` is the one gate between "a workspace file
 * PROPOSES a vault" and "something ACTS on that vault".
 *
 * The Codex review of 2026-09-03 found the hole this closes, and both of its
 * passes found it independently: the resolution cascade applied
 * OBSIDIAN_ROUTER_DEFAULT_VAULT whatever had set it, so `list_vaults` and the
 * session briefing reported a hint as "unconfirmed, not applied" while that
 * same hint was choosing the default vault. Neither half was wrong alone.
 *
 * The review then pushed further, and that is the part worth building a guard
 * around: THREE MORE resolvers read the variable directly, none of them the
 * cascade — `detectVaultContext` (every workspace-bound hook), the doc-drift
 * detector, and the vault-link linter. A repair that reached only the cascade
 * would have read as closed with three of four doors open. So the tests below
 * sweep the CLASS: one loop over the resolvers, and one scan of the tree that
 * refuses a fifth reader nobody classified.
 */
describe('GUARD — a workspace file proposes a vault; only the host may choose one', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const ROOT = path.resolve(HERE, '..');

  /** A workspace directory whose `.env` names `vault`. */
  function workspaceProposing(vault) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ws-'));
    fs.writeFileSync(path.join(dir, '.env'), `OBSIDIAN_ROUTER_DEFAULT_VAULT=${vault}\n`, 'utf8');
    return dir;
  }

  // BOTH WRAPPERS ARE ASYNC, and that is not incidental. The first version was
  // synchronous, so for a resolver that had to be `await`ed the `finally`
  // deleted the environment variable BEFORE the resolver ever read it — the
  // refusal assertion then passed because the variable was gone, not because
  // the gate refused it. Green for the wrong reason, in a guard written to
  // catch exactly that. `await fn(...)` inside the try is the whole fix.

  /** Run `fn` with `key` set the way the HOST would set it. */
  async function asHost(value, fn, key = 'OBSIDIAN_ROUTER_DEFAULT_VAULT') {
    _resetWorkspaceDotenvProvenance();
    const had = Object.hasOwn(process.env, key);
    const prev = process.env[key];
    process.env[key] = value;
    try { return await fn(); } finally {
      if (had) process.env[key] = prev;
      else delete process.env[key];
    }
  }

  /** Run `fn` with `key` set the way a cloned repository would set it. */
  async function asWorkspaceFile(value, fn, key = 'OBSIDIAN_ROUTER_DEFAULT_VAULT') {
    _resetWorkspaceDotenvProvenance();
    delete process.env[key];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ws-'));
    fs.writeFileSync(path.join(dir, '.env'), `${key}=${value}\n`, 'utf8');
    applyWorkspaceDotenv({ cwd: dir, env: process.env, warn: () => {} });
    try {
      assert.equal(process.env[key], value,
        'precondition: the loader really does put the value in the environment');
      return await fn(dir);
    } finally {
      delete process.env[key];
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * THE THREE GATED SETTINGS, AS A TABLE. Round 2 of the Codex review found
   * that the default vault was the only one exercised behaviourally — the
   * lock's gate could have been mutated to `return env.OBSIDIAN_ROUTER_LOCKED`
   * and nothing would have gone red, because the consumer scan counted the
   * function's presence, not its behaviour. A row per setting closes that,
   * and a fourth gated setting has to add a row here.
   */
  const GATED = [
    { key: 'OBSIDIAN_ROUTER_DEFAULT_VAULT', gate: (env) => authoritativeDefaultVault(env), value: 'notes' },
    { key: 'OBSIDIAN_ROUTER_LOCKED', gate: (env) => authoritativeLockedVault(env), value: 'notes' },
  ];

  for (const g of GATED) {
    test(`the gate for ${g.key}: the host decides, the project file does not, and the value is unchanged either way`, async () => {
      await asHost(g.value, () => assert.equal(g.gate(), g.value), g.key);
      await asWorkspaceFile(g.value, () => assert.equal(g.gate(), null), g.key);

      // An empty or absent value is nobody's choice, whatever the origin.
      await asHost('', () => assert.equal(g.gate(), null), g.key);
      await asHost('   ', () => assert.equal(g.gate(), null), g.key);
      _resetWorkspaceDotenvProvenance();
      delete process.env[g.key];
      assert.equal(g.gate(), null);

      // A value nobody consulted a file for is a host value: if no workspace
      // file was ever read INTO this environment, nothing from one can be in
      // it. Refusing here would take authority from a legitimate host on every
      // path that loads no dotenv, and buy nothing.
      _resetWorkspaceDotenvProvenance();
      assert.equal(g.gate({ [g.key]: g.value }), g.value);
    });
  }

  test('the gate for VAULT_PATH: from a workspace file, only a statement about the workspace ITSELF passes', async () => {
    // Round 2's first BLOCKER. Tier 2 of the cascade matched VAULT_PATH
    // against every registered vault path, so a cloned repository's `.env`
    // could set `VAULT_PATH=<any vault of yours>` and choose the default
    // through the door tier 1 had just closed. The spec had said VAULT_PATH
    // was "the observation that the current directory IS a vault" — which is
    // exactly the rule now: from the file, honoured only when it names the
    // directory the file lives in.
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-elsewhere-'));
    try {
      // From the host: an authority, wherever it points.
      await asHost(elsewhere, () => assert.equal(authoritativeVaultPath(process.cwd()), elsewhere), 'VAULT_PATH');

      // From the workspace file, pointing ELSEWHERE: refused.
      await asWorkspaceFile(elsewhere, (dir) => assert.equal(authoritativeVaultPath(dir), null), 'VAULT_PATH');

      // From the workspace file, naming the workspace itself — what
      // `setup-vault` writes into each vault's own .env: honoured, in a
      // spelling that canonicalises to the same directory. Written DIRECTLY
      // rather than through the wrapper: the file must carry the real path,
      // because overwriting the environment afterwards would make the loader
      // classify the value as `runtime` and the gate would pass it for THAT
      // reason — a green assertion proving nothing about the self rule.
      _resetWorkspaceDotenvProvenance();
      delete process.env.VAULT_PATH;
      const selfDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-self-'));
      try {
        const spelled = selfDir + path.sep;
        fs.writeFileSync(path.join(selfDir, '.env'), `VAULT_PATH=${spelled}\n`, 'utf8');
        applyWorkspaceDotenv({ cwd: selfDir, env: process.env, warn: () => {} });
        assert.equal(process.env.VAULT_PATH, spelled, 'precondition: applied from the file');
        assert.equal(authoritativeVaultPath(selfDir), spelled, 'the file named its own directory');
        // The same file read from ANOTHER workspace would be a redirection.
        assert.equal(authoritativeVaultPath(elsewhere), null);
      } finally {
        delete process.env.VAULT_PATH;
        fs.rmSync(selfDir, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  /**
   * THE FOUR RESOLVERS, as a table rather than four separate tests.
   *
   * Each entry answers "which vault am I going to act on?" from an
   * environment. Adding a fifth resolver means adding a row — and the tree
   * scan below is what makes forgetting to add the row fail.
   *
   * THREE ROWS FOR FOUR RESOLVERS, said plainly rather than left to be
   * discovered: `hooks/vault-link-linter.mjs` resolves its vault in top-level
   * script body with no callable export, so it is covered by the tree scan
   * below (which asserts it goes through the gate) and not behaviourally here.
   * That is a weaker guarantee, and naming it is the point — a coverage claim
   * nobody can check is how a blind guard starts.
   */
  const RESOLVERS = [
    {
      name: 'the resolution cascade (src/registry.mjs)',
      resolve: () => resolveDefaultVaultWithSource({
        vaults: VAULTS, configuredDefault: 'work', binding: null,
      }).name,
      // What the cascade falls through to when the proposal is refused.
      fallback: 'work',
    },
    {
      name: 'detectVaultContext (every workspace-bound hook)',
      resolve: async (cwd, vaultDir) => {
        const { detectVaultContext } = await import('../hooks/_helpers/workspace-vault.mjs');
        const cfg = { portRegistry: { [vaultDir]: 27999 }, vaultNames: { [vaultDir]: 'notes' } };
        return detectVaultContext(cwd, cfg)?.slug ?? null;
      },
      fallback: null,
    },
    {
      name: 'orderedVaultCandidates (doc-drift detector)',
      resolve: async (cwd, vaultDir, otherDir) => {
        const { orderedVaultCandidates } = await import('../hooks/_helpers/doc-drift-detector.mjs');
        // TWO registered vaults, and `other` is the config default. With only
        // one vault this resolver returns it whatever happens — the ordering
        // has nothing to order — so a single-vault fixture would report a
        // refusal that never took place. The first version of this row did
        // exactly that and passed for the wrong reason.
        const cfg = {
          portRegistry: { [vaultDir]: 27999, [otherDir]: 28000 },
          vaultNames: { [vaultDir]: 'notes', [otherDir]: 'other' },
          defaultVault: 'other',
        };
        const ordered = orderedVaultCandidates(cwd, cfg);
        if (ordered[0] === vaultDir) return 'notes';
        if (ordered[0] === otherDir) return 'other';
        return null;
      },
      fallback: 'other',
    },
  ];

  for (const r of RESOLVERS) {
    test(`${r.name} — refuses a proposal from a workspace file, honours one from the host`, async () => {
      // Two real registered vaults on disk, so the resolvers that check the
      // filesystem have something to find AND something to prefer instead.
      const mkVault = (prefix) => {
        const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
        fs.mkdirSync(path.join(d, 'wiki-meta'), { recursive: true });
        fs.writeFileSync(path.join(d, 'wiki-meta', 'catalog.md'), '# Catalog\n');
        return d;
      };
      const vaultDir = mkVault('gate-notes-');
      const otherDir = mkVault('gate-other-');
      try {
        const refused = await asWorkspaceFile('notes', (cwd) => r.resolve(cwd, vaultDir, otherDir));
        assert.equal(refused, r.fallback,
          `${r.name}: a cloned repository's .env must not choose the vault this acts on`);

        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-host-'));
        const honoured = await asHost('notes', () => r.resolve(cwd, vaultDir, otherDir));
        assert.equal(honoured, 'notes',
          `${r.name}: the user's own MCP host, launcher or shell is still an authority`);
        fs.rmSync(cwd, { recursive: true, force: true });
      } finally {
        fs.rmSync(vaultDir, { recursive: true, force: true });
        fs.rmSync(otherDir, { recursive: true, force: true });
      }
    });
  }

  test('every file that reads the variable is classified — a fifth reader cannot arrive unnoticed', () => {
    // The behavioural loop above can only cover the resolvers it knows about.
    // This is the half that notices a NEW one: it finds every direct read in
    // the tree and requires it to be on one of two lists, by path, with a
    // reason. A resolver added without the gate lands in neither and fails
    // here rather than shipping as a fourth open door.
    const GATE_OWNER = 'src/helpers/workspace-bindings.mjs';
    // BOTH GATED SETTINGS, as one class. The default vault was the one the
    // review found; the lock follows the same rule for a reason the spec
    // states and the gate's own comment repeats — locking a session to a vault
    // is the strongest possible way of choosing where its writes land. A guard
    // that covered only the first would invite the second to drift.
    const GATED_KEYS = ['OBSIDIAN_ROUTER_DEFAULT_VAULT', 'OBSIDIAN_ROUTER_LOCKED', 'VAULT_PATH'];
    // Files allowed to read a raw value because they REPORT it rather than
    // act on it: a hint has to be seen to be described. `validateLock` is the
    // shared validator every lock candidate goes through, gated or not.
    const CLASSIFIERS = new Set([
      'src/registry.mjs',             // builds `bindingHint` for list_vaults
      'hooks/workspace-briefing.mjs', // builds the session-start sentence
      'src/tools/lock.mjs',           // reports and rewrites the .env line itself
      'scripts/setup-vault.mjs',      // the WRITER of the workspace file
      'bin/obsidian-mcp-router.mjs',  // --help text and start-up diagnostics
    ]);

    function walk(dir, out = []) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (/[.](mjs|cjs|js)$/.test(e.name)) out.push(p);
      }
      return out;
    }

    // EVERY ORDINARY SPELLING OF A READ, not only dot access. Round 2 of the
    // Codex review: `process.env['OBSIDIAN_ROUTER_LOCKED']` and
    // `const { OBSIDIAN_ROUTER_LOCKED } = process.env` were invisible to the
    // first version, so a resolver written either way slipped past the scan.
    // And a file counts as GATED only if it CALLS the gate — an unused import
    // left behind while the code resolved some other way used to pass.
    const keys = GATED_KEYS.join('|');
    const readRe = new RegExp(
      `process[.]env[.](?:${keys})\\b`
      + `|process[.]env\\s*\\[\\s*['"](?:${keys})['"]\\s*\\]`
      + `|\\{[^}]*\\b(?:${keys})\\b[^}]*\\}\\s*=\\s*process[.]env\\b`,
    );
    const gateRe = /authoritative(?:DefaultVault|LockedVault|VaultPath|EnvSetting)\s*\(/;

    const readers = [];
    const gated = [];
    for (const dir of ['bin', 'hooks', 'src', 'scripts']) {
      for (const file of walk(path.join(ROOT, dir))) {
        const rel = path.relative(ROOT, file).replace(/\\/g, '/');
        const code = blankStringsAndComments(fs.readFileSync(file, 'utf8'));
        if (readRe.test(code)) readers.push(rel);
        if (gateRe.test(code) && rel !== GATE_OWNER) gated.push(rel);
      }
    }

    for (const rel of readers) {
      assert.ok(
        rel === GATE_OWNER || CLASSIFIERS.has(rel),
        `${rel} reads ${GATED_KEYS.join(' or ')} directly. If it RESOLVES a vault or a lock, route `
        + 'it through the gate in src/helpers/workspace-bindings.mjs; if it only REPORTS the '
        + 'value, add it to CLASSIFIERS here with the reason.',
      );
    }
    // And the gate must actually be used where it is supposed to be — a guard
    // whose subject has been deleted or renamed would otherwise pass in
    // silence, which is the BLIND failure this repository has shipped twice.
    assert.deepEqual([...new Set(gated)].sort(), [
      'hooks/_helpers/doc-drift-detector.mjs',
      'hooks/_helpers/workspace-vault.mjs',
      'hooks/vault-link-linter.mjs',
      'src/index.mjs',
      'src/registry.mjs',
      'src/tools/workspace-binding.mjs',
    ], 'every consumer of the gate, by path — a row removed here is a door reopened');
  });
});
