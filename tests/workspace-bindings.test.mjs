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
import fsp from 'node:fs/promises';
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
  WORKSPACE_REFUSALS_KEY,
  readRefusals,
  withRefusal,
  withoutRefusal,
} from '../src/helpers/workspace-bindings.mjs';
import { composeBriefing } from '../src/helpers/binding-briefing.mjs';
import { listVaults } from '../src/tools/list-vaults.mjs';
import { acquireLock, lockPathFor } from '../src/helpers/file-lock.mjs';
import {
  applyWorkspaceDotenv,
  _resetWorkspaceDotenvProvenance,
} from '../src/helpers/workspace-dotenv.mjs';
import { blankStringsAndComments } from './_source-scan.mjs';
import { _internals, loadRegistry } from '../src/registry.mjs';
import { confirmWorkspaceBinding } from '../src/tools/workspace-binding.mjs';

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
      // `alsoLocked` / `alsoWritable` (Phase 3, per-workspace write tiers) are
      // always present, empty when the record carries none — a reader never
      // has to guard against `undefined`.
      { vault: 'notes', also: ['work'], locked: true, confirmedAt: '2026-09-03', confirmedVia: 'tool', alsoLocked: [], alsoWritable: [] },
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

describe('normalizeBinding — the write tier of each secondary, recorded on the binding (Phase 3, per workspace)', () => {
  test('alsoLocked / alsoWritable are carried, as subsets of `also`, deduplicated', () => {
    const b = normalizeBinding({
      vault: 'notes',
      also: ['ref', 'shared', 'scratch'],
      alsoLocked: ['ref', 'ref', 'not-a-secondary', 'notes'],
      alsoWritable: ['scratch', 42, ''],
    });
    assert.deepEqual(b.alsoLocked, ['ref'], 'a name outside `also` (or the primary) has no role to qualify');
    assert.deepEqual(b.alsoWritable, ['scratch']);
  });

  test('a name in BOTH lists is locked — the hard tier wins a conflict', () => {
    const b = normalizeBinding({ vault: 'notes', also: ['ref'], alsoLocked: ['ref'], alsoWritable: ['ref'] });
    assert.deepEqual(b.alsoLocked, ['ref']);
    assert.deepEqual(b.alsoWritable, []);
  });

  test('absent or malformed lists are empty arrays — every secondary is then soft', () => {
    for (const raw of [
      { vault: 'notes', also: ['ref'] },
      { vault: 'notes', also: ['ref'], alsoLocked: 'ref', alsoWritable: { 0: 'ref' } },
    ]) {
      const b = normalizeBinding(raw);
      assert.deepEqual(b.alsoLocked, []);
      assert.deepEqual(b.alsoWritable, []);
    }
  });

  test('withBinding round-trips the tiers through the config, and re-writing the same tiers changes nothing', () => {
    const cfg = withBinding({}, '/w/proj', { vault: 'notes', also: ['ref', 'scratch'], alsoLocked: ['ref'], alsoWritable: ['scratch'] });
    const back = readBinding(cfg, '/w/proj');
    assert.deepEqual(back.alsoLocked, ['ref']);
    assert.deepEqual(back.alsoWritable, ['scratch']);
    const again = withBinding(cfg, '/w/proj', { ...back });
    assert.equal(again, cfg, 'identity — the writer must see "nothing to write"');
    const changed = withBinding(cfg, '/w/proj', { ...back, alsoLocked: [], alsoWritable: ['scratch', 'ref'] });
    assert.notEqual(changed, cfg);
    assert.deepEqual(readBinding(changed, '/w/proj').alsoWritable, ['scratch', 'ref']);
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

describe('classifyBindingHint — the SIXTH status: a proposal the user REFUSED (decision refus-d-une-proposition-de-liaison)', () => {
  const binding = normalizeBinding({ vault: 'notes' });
  const refusedWork = (name) => name === 'work';

  test('a refusal in the user\'s config is SILENCE — whether or not the vault is registered', () => {
    const known = classifyBindingHint({ hint: 'work', binding: null, isRegistered, isRefused: refusedWork });
    assert.equal(known.status, HINT_STATUS.REFUSED);
    assert.equal(hintIsWorthSignalling(known), false, 'the question was asked and answered');
    // An unregistered vault can be refused too: that is how the unknown-vault
    // notice stops, since there is nothing to register.
    const unknown = classifyBindingHint({ hint: 'work', binding: null, isRegistered: () => false, isRefused: refusedWork });
    assert.equal(unknown.status, HINT_STATUS.REFUSED);
  });

  test('TRAP 1 — a refusal names ONE vault: a proposal naming another is signalled as usual', () => {
    const c = classifyBindingHint({ hint: 'archive', binding: null, isRegistered, isRefused: refusedWork });
    assert.equal(c.status, HINT_STATUS.UNCONFIRMED);
    assert.equal(hintIsWorthSignalling(c), true);
  });

  test('a hint naming a SECONDARY the workspace is bound to is "confirmed" — bound is satisfied, primary or not', () => {
    // Fable round on 7efbad1: a secondary fell to `conflicts`, so the briefing
    // told a workspace bound to notes + work that "the binding wins" over
    // `work` and offered a refusal the tool rejected (the vault is bound).
    const several = normalizeBinding({ vault: 'notes', also: ['work'] });
    const c = classifyBindingHint({ hint: 'work', binding: several, isRegistered });
    assert.equal(c.status, HINT_STATUS.CONFIRMED);
    assert.equal(hintIsWorthSignalling(c), false);
    // …and a stale refusal of that secondary does not change it (trap 5, one role over).
    assert.equal(classifyBindingHint({ hint: 'work', binding: several, isRegistered, isRefused: refusedWork }).status, HINT_STATUS.CONFIRMED);
  });

  test('a bound workspace whose hint names a vault the machine does NOT have is "unknown-vault", not "conflicts"', () => {
    // `conflicts` is documented as "a DIFFERENT registered vault". The old order
    // answered it for any hint beside a binding, so the briefing said "the
    // binding wins" and never that the vault does not exist.
    const c = classifyBindingHint({ hint: 'ghost', binding, isRegistered });
    assert.equal(c.status, HINT_STATUS.UNKNOWN_VAULT);
    assert.equal(c.boundTo, 'notes', 'the binding is still named beside it');
    // A registered, different vault is still `conflicts`.
    assert.equal(classifyBindingHint({ hint: 'archive', binding, isRegistered }).status, HINT_STATUS.CONFLICTS);
  });

  test('a hint naming a bound vault the machine no longer HAS is "unknown-vault", not "confirmed" — a stale binding is not satisfaction', () => {
    // Codex (gpt-5.6-terra), round on 1fad78c: the bound check ran before the
    // registration check, so a secondary left in `also` after its vault was
    // removed silenced the very proposal that should have said "not
    // registered on this machine".
    const stale = normalizeBinding({ vault: 'notes', also: ['gone'] });
    const c = classifyBindingHint({ hint: 'gone', binding: stale, isRegistered });
    assert.equal(c.status, HINT_STATUS.UNKNOWN_VAULT);
    assert.equal(hintIsWorthSignalling(c), true);
    // …unless the user refused it — refusing is how the unknown-vault notice stops.
    assert.equal(classifyBindingHint({ hint: 'gone', binding: stale, isRegistered, isRefused: (n) => n === 'gone' }).status, HINT_STATUS.REFUSED);
  });

  test('TRAP 5 — the binding in force wins: the bound vault reads "confirmed" even against a stale refusal', () => {
    // The user refused X, then bound the workspace to X deliberately (by a
    // path that does not drop refusals — a hand edit). The briefing must not
    // call refused the binding it has just announced.
    const c = classifyBindingHint({ hint: 'notes', binding, isRegistered, isRefused: (n) => n === 'notes' });
    assert.equal(c.status, HINT_STATUS.CONFIRMED);
  });

  test('bound elsewhere, and the file proposes a vault the user refused: silence, not "conflicts"', () => {
    const c = classifyBindingHint({ hint: 'work', binding, isRegistered, isRefused: refusedWork });
    assert.equal(c.status, HINT_STATUS.REFUSED);
    assert.equal(c.boundTo, 'notes');
  });

  test('the FILE\'s own refusal changes NO verdict — it only sets previouslyRefused', () => {
    // The reinstall case: the config that held the answer is gone, the file
    // still says "refused here before". Asked once more, with that context.
    // A file that could silence a proposal is a cloned repository silencing
    // one for everybody it reaches.
    const c = classifyBindingHint({ hint: 'work', binding: null, isRegistered, fileRefusal: 'work' });
    assert.equal(c.status, HINT_STATUS.UNCONFIRMED);
    assert.equal(c.previouslyRefused, true);
    assert.equal(hintIsWorthSignalling(c), true);
    const other = classifyBindingHint({ hint: 'work', binding: null, isRegistered, fileRefusal: 'archive' });
    assert.equal(other.previouslyRefused, false, 'a refusal of another vault is not context for this one');
    for (const bad of [null, undefined, '', 42, {}]) {
      const x = classifyBindingHint({ hint: 'work', binding: null, isRegistered, fileRefusal: bad });
      assert.equal(x.previouslyRefused, false, JSON.stringify(bad));
      assert.equal(x.status, HINT_STATUS.UNCONFIRMED);
    }
  });

  test('previouslyRefused is a fact about the file, carried whatever the verdict; NONE carries false', () => {
    assert.equal(classifyBindingHint({ hint: '', binding: null, isRegistered, fileRefusal: '' }).previouslyRefused, false);
    const c = classifyBindingHint({ hint: 'work', binding: null, isRegistered, isRefused: refusedWork, fileRefusal: 'work' });
    assert.equal(c.status, HINT_STATUS.REFUSED);
    assert.equal(c.previouslyRefused, true);
  });

  test('a non-function isRefused means "nothing refused" — never a throw, never a silence', () => {
    for (const bad of [null, undefined, true, 'work', {}, ['work']]) {
      const c = classifyBindingHint({ hint: 'work', binding: null, isRegistered, isRefused: bad });
      assert.equal(c.status, HINT_STATUS.UNCONFIRMED, JSON.stringify(bad));
    }
  });
});

describe('HINT_STATUS — the silent/signalled partition is TOTAL, and every consumer handles every value (roadmap item 25)', () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const hintOf = (status) => ({ status, hint: 'work', boundTo: null, origin: 'workspace-dotenv', previouslyRefused: false });

  test('six values, each on exactly one side of hintIsWorthSignalling', () => {
    const values = Object.values(HINT_STATUS);
    assert.equal(values.length, 6, 'a seventh status must be classified here, in the briefing and in list_vaults');
    const silent = values.filter((s) => !hintIsWorthSignalling({ status: s })).sort();
    const signalled = values.filter((s) => hintIsWorthSignalling({ status: s })).sort();
    assert.deepEqual(silent, ['confirmed', 'none', 'refused']);
    assert.deepEqual(signalled, ['conflicts', 'unconfirmed', 'unknown-vault']);
  });

  test('CONSUMER 1 — the briefing: a sentence for every signalled value, silence for every silent one', () => {
    for (const status of Object.values(HINT_STATUS)) {
      const out = composeBriefing({ binding: null, hint: hintOf(status), registeredCount: 1 });
      assert.equal(/proposes/.test(out), hintIsWorthSignalling({ status }), status);
      // And every signalled value offers the way to say no.
      assert.equal(/refuse: "work"/.test(out), hintIsWorthSignalling({ status }), `${status}: the refusal is offered`);
    }
  });

  test('CONSUMER 2 — list_vaults passes every value through, and drops only what the classifier cannot produce', async () => {
    for (const status of Object.values(HINT_STATUS)) {
      const out = await listVaults({ vaults: [], skipped: [], configPath: '/c', bindingHint: { ...hintOf(status), previouslyRefused: true } });
      assert.equal(out.bindingHint?.status, status, status);
      assert.equal(out.bindingHint.previouslyRefused, true, `${status}: the file's fact is carried`);
    }
    const junk = await listVaults({ vaults: [], skipped: [], configPath: '/c', bindingHint: { ...hintOf('declined') } });
    assert.equal(junk.bindingHint, null, 'a status this build cannot produce is not reported half-true');
  });

  test('CONSUMER 3 — the list_vaults description names every value, and no other module hand-copies the vocabulary', () => {
    const index = fs.readFileSync(path.join(ROOT, 'src', 'index.mjs'), 'utf8');
    for (const status of Object.values(HINT_STATUS)) {
      assert.ok(index.includes(`"${status}"`), `the list_vaults description must explain "${status}"`);
    }
    // The vocabulary lives in ONE module. A second enumeration of the literals
    // anywhere in src/ or hooks/ is a copy that will say "five" after the
    // sixth arrives — which is exactly what list-vaults.mjs did until it was
    // made to derive its validator from HINT_STATUS.
    const OWNER = 'src/helpers/workspace-bindings.mjs';
    const PROSE_ONLY = new Set(['src/index.mjs']); // tool descriptions, checked above
    const copies = [];
    for (const dir of ['src', 'hooks']) {
      for (const rel of fs.readdirSync(path.join(ROOT, dir), { recursive: true }).map(String)) {
        if (!/[.]mjs$/.test(rel)) continue;
        const file = `${dir}/${rel.replace(/\\/g, '/')}`;
        if (file === OWNER || PROSE_ONLY.has(file)) continue;
        const src = fs.readFileSync(path.join(ROOT, dir, rel), 'utf8');
        const found = Object.values(HINT_STATUS).filter((s) => s !== 'none' && (src.includes(`'${s}'`) || src.includes(`"${s}"`)));
        // A module may mention ONE status by literal in a message; enumerating
        // three or more of them is a copy of the vocabulary.
        if (found.length >= 3) copies.push(`${file}: ${found.join(', ')}`);
      }
    }
    assert.deepEqual(copies, [], 'derive from HINT_STATUS instead of copying its values');
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

describe('workspaceRefusals — read at the boundary, written by two pure transforms', () => {
  const cwd = process.cwd();
  const key = canonicalWorkspaceKey(cwd);
  const refusedAt = (entries) => ({ [WORKSPACE_REFUSALS_KEY]: { [key]: entries } });

  test('readRefusals validates at the boundary: junk in, an empty Map out', () => {
    for (const cfg of [
      null, undefined, {}, { [WORKSPACE_REFUSALS_KEY]: null }, { [WORKSPACE_REFUSALS_KEY]: [] },
      { [WORKSPACE_REFUSALS_KEY]: 'work' }, refusedAt('work'), refusedAt(['work']), refusedAt(null),
    ]) {
      assert.equal(readRefusals(cfg, cwd).size, 0, JSON.stringify(cfg));
    }
    const m = readRefusals(refusedAt({ work: '2026-09-06', '': 'x', '  ': 'y', archive: 7 }), cwd);
    assert.deepEqual([...m.entries()], [['work', '2026-09-06'], ['archive', null]],
      'a name without a usable date is still refused; an empty name is not a name');
    assert.equal(readRefusals(refusedAt({ work: '2026-09-06' }), '').size, 0, 'no usable cwd, nothing');
  });

  test('two spellings of the same directory are UNIONED — two refusals cannot contradict each other', () => {
    const cfg = { [WORKSPACE_REFUSALS_KEY]: { [cwd + path.sep]: { work: '2026-09-06' }, [key]: { archive: '2026-09-07' } } };
    assert.deepEqual([...readRefusals(cfg, cwd).keys()].sort(), ['archive', 'work']);
  });

  test('withRefusal records under the canonical key, dates it, and is IDENTITY when already refused', () => {
    const a = withRefusal({}, cwd, 'work', { at: '2026-09-06' });
    assert.deepEqual(a[WORKSPACE_REFUSALS_KEY], { [key]: { work: '2026-09-06' } });
    assert.equal(withRefusal(a, cwd, 'work'), a, 'nothing to change → the input object, so the writer skips the file');
    const b = withRefusal(a, cwd, 'archive', { at: '2026-09-07' });
    assert.deepEqual(b[WORKSPACE_REFUSALS_KEY][key], { work: '2026-09-06', archive: '2026-09-07' });
    assert.deepEqual(a[WORKSPACE_REFUSALS_KEY][key], { work: '2026-09-06' }, 'pure: the input is not mutated');
    assert.match(withRefusal({}, cwd, 'work')[WORKSPACE_REFUSALS_KEY][key].work, /^\d{4}-\d{2}-\d{2}$/, 'dated today when no date is given');
    for (const bad of ['', '  ', null, 42]) assert.equal(withRefusal(a, cwd, bad), a, JSON.stringify(bad));
    assert.deepEqual(withRefusal(null, cwd, 'work')[WORKSPACE_REFUSALS_KEY], { [key]: { work: withRefusal(null, cwd, 'work')[WORKSPACE_REFUSALS_KEY][key].work } });
  });

  test('withRefusal collapses colliding spellings into the canonical key, keeping what they held', () => {
    const cfg = { [WORKSPACE_REFUSALS_KEY]: { [cwd + path.sep]: { work: '2026-09-06' } } };
    const next = withRefusal(cfg, cwd, 'archive', { at: '2026-09-07' });
    assert.deepEqual(Object.keys(next[WORKSPACE_REFUSALS_KEY]), [key]);
    assert.deepEqual(next[WORKSPACE_REFUSALS_KEY][key], { work: '2026-09-06', archive: '2026-09-07' });
  });

  test('a vault named like an Object property is a name, not a prototype — through a JSON round trip', () => {
    for (const name of ['__proto__', 'constructor', 'hasOwnProperty']) {
      const cfg = JSON.parse(JSON.stringify(withRefusal({}, cwd, name, { at: '2026-09-06' })));
      assert.equal(readRefusals(cfg, cwd).has(name), true, name);
      assert.equal(readRefusals(cfg, cwd).has('toString'), false, `${name}: no prototype walk`);
      assert.equal(readRefusals(withoutRefusal(cfg, cwd, name), cwd).has(name), false, `${name}: removable too`);
    }
  });

  test('withoutRefusal removes one refusal, drops an emptied entry AND an emptied key, and is identity otherwise', () => {
    const two = withRefusal(withRefusal({ defaultVault: 'notes' }, cwd, 'work', { at: '2026-09-06' }), cwd, 'archive', { at: '2026-09-07' });
    const one = withoutRefusal(two, cwd, 'work');
    assert.deepEqual(one[WORKSPACE_REFUSALS_KEY][key], { archive: '2026-09-07' });
    const none = withoutRefusal(one, cwd, 'archive');
    assert.equal(Object.hasOwn(none, WORKSPACE_REFUSALS_KEY), false, 'nothing left, no key left');
    assert.equal(none.defaultVault, 'notes', 'the rest of the config survives');
    assert.equal(withoutRefusal(none, cwd, 'work'), none, 'identity when there is nothing to remove');
    assert.equal(withoutRefusal(two, cwd, 'ghost'), two);
    assert.equal(withoutRefusal(two, cwd, 42), two);
    assert.doesNotThrow(() => withoutRefusal(null, cwd, 'work'));
  });

  test('other workspaces\' refusals are never touched', () => {
    const other = path.join(cwd, 'elsewhere');
    const cfg = withRefusal(withRefusal({}, other, 'work', { at: '2026-09-06' }), cwd, 'work', { at: '2026-09-06' });
    const next = withoutRefusal(cfg, cwd, 'work');
    assert.equal(readRefusals(next, other).has('work'), true);
    assert.equal(readRefusals(next, cwd).has('work'), false);
  });

  test('BINDING A VAULT ADOPTS IT — withBinding drops the refusal of the primary and of each secondary, whoever writes the binding', () => {
    const refused = ['notes', 'work', 'archive']
      .reduce((cfg, n) => withRefusal(cfg, cwd, n, { at: '2026-09-06' }), {});
    const bound = withBinding(refused, cwd, { vault: 'notes', also: ['work'] });
    assert.deepEqual([...readRefusals(bound, cwd).keys()], ['archive'], 'the vault NOT bound stays refused');
    // The no-change rule survives: the same binding again, nothing to drop →
    // the input object.
    assert.equal(withBinding(bound, cwd, { vault: 'notes', also: ['work'] }), bound);
    // And a binding that changes nothing but has a refusal to drop IS a change.
    const stale = withRefusal(bound, cwd, 'notes', { at: '2026-09-08' });
    const again = withBinding(stale, cwd, { vault: 'notes', also: ['work'] });
    assert.notEqual(again, stale);
    assert.equal(readRefusals(again, cwd).has('notes'), false);
    assert.equal(readBinding(again, cwd).vault, 'notes');
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

  test('the lock is released when the WRITE ITSELF throws — the exit path nothing covered', () => {
    // Three exit paths were pinned (success, unparseable config, crashed
    // transform) and the fourth was not, so a `finally` narrowed to the first
    // three would have stayed green while a disk-full or read-only config
    // stranded the lock for every other process on the machine for a full
    // minute — including the router's own start-up. Codex flagged the gap in
    // the final review, 2026-09-03; the coverage was one line short of the
    // failure mode most likely to actually happen.
    let released = false;
    assert.throws(() => updateConfigBindings('/cfg/config.json', (c) => ({ ...c, x: 1 }), {
      lock: () => () => { released = true; },
      readFile: () => '{}',
      writeFile: () => { throw new Error('ENOSPC'); },
    }), /ENOSPC/);
    assert.equal(released, true, 'a failed write must not strand the lock');
  });

  test('a transform that changes NOTHING writes nothing at all', () => {
    // Identity, not deep equality: every transform here is pure and returns a
    // new object when it changes something, so handing back the same object is
    // an unambiguous "no change". `unlock_vaults --persist` on a workspace
    // with no binding used to rewrite the file holding every vault's API key
    // for nothing — a write that cannot change the content can still fail, and
    // still moves the mtime the one-time import reads.
    const writes = [];
    const out = updateConfigBindings('/cfg/config.json', (c) => c, {
      lock: () => () => {},
      readFile: () => '{"portRegistry":{}}',
      writeFile: (p, content) => writes.push(content),
    });
    assert.deepEqual(writes, []);
    assert.deepEqual(out, { portRegistry: {} }, 'and the caller still gets the config back');
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
    assert.deepEqual(decide(), {
      import: true, vault: 'notes', locked: false, reason: IMPORT_REASON.IMPORTED, record: true,
    });
  });

  test('a workspace that ALREADY has a binding is left alone — AND written down as considered', () => {
    // `record` is the half that was missing, and its absence was a defect with
    // teeth. The window only closed for a workspace something was actually
    // imported INTO, so a workspace that already had a binding at the first
    // start of this version was never recorded — and the day the user CLEARED
    // that binding, the next start read the still-present dotenv hint and put
    // the binding back, `confirmedVia: 'migration'`. An automatic import
    // silently reversing an explicit human decision, which is the exact
    // failure this whole mechanism is built to prevent. Measured against the
    // real `loadRegistry` in the final review, 2026-09-03.
    const d = decide({ binding: { vault: 'work' } });
    assert.equal(d.reason, IMPORT_REASON.ALREADY_BOUND);
    assert.equal(d.import, false, 'nothing is imported over an existing binding');
    assert.equal(d.record, true, 'but this workspace is done with: the window closes');
  });

  test('the window closes ONLY on the two verdicts that are permanent', () => {
    // The other four are transient conditions, and recording them would turn
    // a passing state into a life sentence: a vault registered next week
    // (`unknown-vault`), a hint added next month (`no-hint`), a value that
    // came from the host this time (`not-from-a-file`), a file edited after
    // the upgrade (`newer-than-upgrade`) — each may become importable later.
    assert.equal(decide({ hint: undefined }).record, false, 'no-hint');
    assert.equal(decide({ hintOrigin: 'host' }).record, false, 'not-from-a-file');
    assert.equal(decide({ hint: 'ghost' }).record, false, 'unknown-vault');
    assert.equal(decide({ dotenvMtimeMs: Date.parse('2026-09-04T00:00:00Z') }).record, false, 'newer-than-upgrade');
    assert.equal(decide({ alreadyImported: true }).record, false, 'already recorded, nothing to add');
  });

  test('a workspace already imported is NEVER imported again — this is what makes a `clear` permanent', () => {
    // Without it, the next start would re-import the still-present hint and
    // quietly undo the user's decision to unbind. The one rule of this whole
    // mechanism that protects an explicit human act.
    assert.equal(decide({ alreadyImported: true }).reason, IMPORT_REASON.ALREADY_CONSIDERED);
  });

  test('a PERSISTED LOCK is migrated too, and it decides the vault', () => {
    // `lock_vault --persist` wrote OBSIDIAN_ROUTER_LOCKED into the workspace
    // file, and the router applied it at start-up. Closing the gate refuses
    // it — so without this an upgrade removed an isolation boundary the user
    // had explicitly set, in silence, with no field anywhere reporting it.
    //
    // It is considered BEFORE the default-vault hint because it decided more:
    // while a lock was in force, every call without an explicit vault resolved
    // to the locked one and every other vault was refused. A file naming a
    // lock on `work` and a default of `notes` described a workspace on `work`
    // alone, so importing `notes` would move where the notes go.
    const d = decide({ lockHint: 'work', lockHintOrigin: 'workspace-dotenv', lockMtimeMs: base.dotenvMtimeMs });
    assert.equal(d.import, true);
    assert.equal(d.vault, 'work', 'the LOCKED vault, not the default hint');
    assert.equal(d.locked, true);
  });

  test('a lock hint naming an UNREGISTERED vault imports NOTHING — it does not fall back', () => {
    // Codex, round 5. The fall-back was the wrong instinct: a file naming a
    // lock on B and a default of A described an installation working in B
    // alone, so importing A binds the workspace to a vault the old behaviour
    // never used — and then `record` CLOSES the window on that wrong answer,
    // so registering B tomorrow can never restore the isolation. A transient
    // condition (a vault temporarily disabled, not yet re-added) would have
    // become a permanent verdict, which is exactly what `CLOSING_REASONS`
    // exists to prevent one level up.
    const d = decide({ lockHint: 'ghost', lockHintOrigin: 'workspace-dotenv', lockMtimeMs: base.dotenvMtimeMs });
    assert.equal(d.import, false, 'nothing is imported');
    assert.equal(d.reason, IMPORT_REASON.UNKNOWN_VAULT);
    assert.equal(d.record, false, 'and the window stays OPEN for when that vault comes back');
  });

  test('an age that cannot be established fails CLOSED', () => {
    // `mtimeMs` is null when the file the loader read has been deleted,
    // renamed or made unreadable since — so the one fact separating a
    // workspace attached last year from a repository cloned this morning was
    // never measured. `Number.isFinite` guarded only the comparison, so a null
    // skipped the window check entirely and the hint was imported on the
    // strength of a measurement nobody took. (Codex, round 5.)
    assert.equal(decide({ dotenvMtimeMs: null }).reason, IMPORT_REASON.NEWER_THAN_UPGRADE);
    assert.equal(decide({ dotenvMtimeMs: undefined }).reason, IMPORT_REASON.NEWER_THAN_UPGRADE);
    assert.equal(decide({ dotenvMtimeMs: NaN }).reason, IMPORT_REASON.NEWER_THAN_UPGRADE);
    // And it stays OPEN: an unreadable file this minute is readable the next.
    assert.equal(decide({ dotenvMtimeMs: null }).record, false);
    // With no window open yet there is nothing to compare against, so the
    // first-ever start still imports — that limit is documented, not accidental.
    assert.equal(decide({ dotenvMtimeMs: null, openedAt: null }).import, true);
  });

  test('a lock hint follows every rule the default hint follows', () => {
    const withLock = (over) => decide({
      lockHint: 'work', lockHintOrigin: 'workspace-dotenv', lockMtimeMs: base.dotenvMtimeMs, ...over,
    });
    // From the HOST it is already an authority; importing it would record a
    // confirmation nobody gave — so the default hint is used instead.
    assert.equal(withLock({ lockHintOrigin: 'host' }).vault, 'notes');
    // Naming a vault this machine does not have, it imports NOTHING — see the
    // test above for why falling back to the default hint was wrong.
    assert.equal(withLock({ lockHint: 'ghost' }).import, false);
    // And its OWN file's mtime closes the window on it — the lock line may
    // live in a different file from the default hint, so the mtime that counts
    // is the one of the file that carried the value being imported.
    assert.equal(
      withLock({ lockMtimeMs: Date.parse('2026-09-04T00:00:00Z') }).reason,
      IMPORT_REASON.NEWER_THAN_UPGRADE,
    );
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

  test('"we cannot tell" splits into two answers, and only one of them imports', () => {
    // These two used to be treated as one case — "we cannot tell, so import,
    // and it stays bounded because the workspace is recorded either way". The
    // reasoning was wrong on the first of them, and Codex said so in round 5:
    // being recorded bounds the NUMBER of imports, not their correctness, and
    // an import is exactly the decision that needs the fact nobody measured.
    //
    //   - AN UNREADABLE MTIME is a missing measurement about THIS workspace's
    //     file: the file the loader read is gone, renamed or unreadable, so
    //     the one thing separating a workspace attached last year from a
    //     repository cloned this morning was never established. Fail closed:
    //     the hint stays a hint, the briefing says so, one sentence confirms it.
    //     The window stays open, because the file may be readable next time.
    //   - AN UNPARSEABLE `openedAt` is a corrupt WINDOW, not a corrupt file.
    //     There is no upgrade instant to compare against, which is the same
    //     situation as a first-ever start — and that case imports by design.
    const unreadable = decide({ dotenvMtimeMs: null });
    assert.equal(unreadable.reason, IMPORT_REASON.NEWER_THAN_UPGRADE);
    assert.equal(unreadable.record, false, 'and it stays open for a later start');
    assert.equal(decide({ openedAt: 'not a date' }).reason, IMPORT_REASON.IMPORTED);
  });

  test('A REFUSED VAULT IS NEVER IMPORTED — and the window stays open, since a refusal can be retracted', () => {
    // Decision refus-d-une-proposition-de-liaison. The reinstall scenario is
    // this function's blind spot without it: a fresh config opens the window
    // NOW, every file on disk predates it, so a `.env` saying both "propose
    // notes" and "notes was refused here" would have `notes` imported as a
    // confirmed binding at the very first start.
    const r = decide({ isRefused: (n) => n === 'notes' });
    assert.deepEqual(r, { import: false, vault: null, locked: false, reason: IMPORT_REASON.REFUSED, record: false });
    // `refused` is reported before `unknown-vault`: a refusal names a vault
    // whether or not this machine has it, and it is the more useful answer.
    assert.equal(decide({ hint: 'ghost', isRefused: (n) => n === 'ghost' }).reason, IMPORT_REASON.REFUSED);
    // A refusal of ANOTHER vault changes nothing (trap 1).
    assert.equal(decide({ isRefused: (n) => n === 'work' }).import, true);
    // And a non-function is "nothing refused".
    assert.equal(decide({ isRefused: true }).import, true);
  });

  test('a refused LOCK hint imports nothing at all — not even the default-vault hint beside it', () => {
    // Same rule as an unknown lock: the lock is what the installation was
    // doing, so either it is imported or NOTHING is. Falling back to the
    // default-vault hint would bind the workspace to a vault the old behaviour
    // never used.
    const r = decide({
      lockHint: 'work', lockHintOrigin: 'workspace-dotenv', lockMtimeMs: base.dotenvMtimeMs,
      isRefused: (n) => n === 'work',
    });
    assert.equal(r.import, false);
    assert.equal(r.reason, IMPORT_REASON.REFUSED);
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
      decide({ isRefused: (n) => n === 'notes' }).reason,
    ]);
    // The gated reason needs the environment, not an argument: the predicate
    // reads `process.env` at call time, like every other consumer of it.
    const had = Object.hasOwn(process.env, 'OBSIDIAN_ROUTER_READONLY');
    const prev = process.env.OBSIDIAN_ROUTER_READONLY;
    process.env.OBSIDIAN_ROUTER_READONLY = 'true';
    try {
      seen.add(decide().reason);
    } finally {
      if (had) process.env.OBSIDIAN_ROUTER_READONLY = prev;
      else delete process.env.OBSIDIAN_ROUTER_READONLY;
    }
    assert.deepEqual([...seen].sort(), Object.values(IMPORT_REASON).sort());
  });

  test('a GATED deployment never imports — whatever the file says, and before every other question', () => {
    // The whole-lot review, 2026-09-06: under `OBSIDIAN_ROUTER_READONLY` the
    // import wrote `confirmedVia: "migration"` into the config every tenant
    // shares, from the SERVER's own directory, while
    // `confirm_workspace_binding` refused a caller the very same write. What
    // makes the import defensible is that it announces itself at the top of
    // every session — and that hook does not exist on a gated deployment.
    const GATES = [['OBSIDIAN_ROUTER_READONLY', 'true'], ['OBSIDIAN_ROUTER_ALLOWED_VAULTS', 'notes'], ['OBSIDIAN_ROUTER_USER_ID', 'u1']];
    for (const [key, value] of GATES) {
      const had = Object.hasOwn(process.env, key);
      const prev = process.env[key];
      process.env[key] = value;
      try {
        // The most importable case there is: a registered vault, from a file,
        // older than the window, never considered, never refused.
        const d = decide();
        assert.equal(d.import, false, `${key} still imported`);
        assert.equal(d.reason, IMPORT_REASON.GATED_DEPLOYMENT, key);
        // And NOT a closing reason: the same config read by an ordinary local
        // router must still be importable there.
        assert.equal(d.record, false, `${key} closed the window for good`);
      } finally {
        if (had) process.env[key] = prev; else delete process.env[key];
      }
    }
    // Ungated, the same call imports — the gate is what refuses, not the rule.
    assert.equal(decide().import, true);
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

  test('a state that changes NOTHING returns the input object, so the writer can skip the file', () => {
    // Identity is the signal `updateConfigBindings` reads. Without it the
    // migration re-recorded the window on every start — content-identical,
    // object-new — and the router rewrote `config.json`, the file holding
    // every vault's API key, once per session forever.
    //
    // TESTED HERE, DIRECTLY, because the integration test cannot separate this
    // repair from the other one: the caller now also skips the lock when the
    // workspace is already recorded, so either repair alone suppresses the
    // write and neither has a witness through the registry. Two defences, two
    // tests — the pair is pinned end-to-end by "a settled workspace writes
    // nothing on later starts" further down.
    const opened = withMigrationState({}, { at: '2026-09-03T00:00:00Z' });
    assert.equal(withMigrationState(opened, { at: '2027-01-01T00:00:00Z' }), opened,
      're-opening an open window changes nothing');
    const recorded = withMigrationState(opened, { cwd, recordImported: true });
    assert.notEqual(recorded, opened, 'the first recording IS a change');
    assert.equal(withMigrationState(recorded, { cwd, recordImported: true }), recorded,
      'recording the same workspace twice changes nothing');
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
  const scenario = ({
    hintAge = 'old',
    bindings,
    migration,
    // Vault names THIS workspace refused, written under its canonical key.
    refusals = null,
    // The whole dotenv body, so a scenario can carry a persisted LOCK line as
    // well as the default-vault hint. Both are migrated, and the lock decides.
    dotenv = 'OBSIDIAN_ROUTER_DEFAULT_VAULT=notes\n',
  } = {}) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
    roots.push(root);
    const vault = path.join(root, 'notes');
    fs.mkdirSync(vault, { recursive: true });
    const ws = path.join(root, 'project');
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, '.env'), dotenv, 'utf8');
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
      ...(refusals
        ? { [WORKSPACE_REFUSALS_KEY]: { [canonicalWorkspaceKey(ws)]: Object.fromEntries(refusals.map((n) => [n, '2026-09-06'])) } }
        : {}),
    }, null, 2), 'utf8');
    return { root, ws, vault, configPath, read: () => JSON.parse(fs.readFileSync(configPath, 'utf8')) };
  };

  /**
   * Load the registry AS IF the router had started in `ws`. `host` names
   * variables the LAUNCHER set — present before the workspace file is read,
   * so the loader records them as the host's, never the file's.
   */
  async function loadIn(sc, { host = {} } = {}) {
    const prevCwd = process.cwd();
    // BOTH gated variables are saved and cleared, not just the default vault:
    // a scenario whose `.env` carries a persisted lock has to reach the loader
    // through the file, exactly as it would in the field, and a leftover value
    // in this process's environment would arrive as the HOST's and be an
    // authority instead.
    const KEYS = ['OBSIDIAN_ROUTER_DEFAULT_VAULT', 'OBSIDIAN_ROUTER_LOCKED', 'OBSIDIAN_ROUTER_REFUSED_VAULT'];
    const saved = KEYS.map((k) => [k, Object.hasOwn(process.env, k), process.env[k]]);
    _resetWorkspaceDotenvProvenance();
    for (const k of KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(host)) process.env[k] = v;
    process.chdir(sc.ws);
    try {
      applyWorkspaceDotenv({ cwd: sc.ws, env: process.env, warn: () => {} });
      return await loadRegistry({ configPath: sc.configPath });
    } finally {
      process.chdir(prevCwd);
      for (const [k, had, value] of saved) {
        if (had) process.env[k] = value;
        else delete process.env[k];
      }
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

  test('a binding recorded AFTER this process read the config is not overwritten by the import', async () => {
    // THE BLOCKER of the merge review. The decision used to be computed from
    // the config read at start-up and then applied inside the lock without
    // rechecking — so an `--attach` or another session's confirmation landing
    // in between was overwritten by the dotenv hint. Taking the lock is not
    // enough when the DECISION was made outside it, and the failure is the
    // worst one this feature has: an automatic import silently reversing an
    // explicit human choice.
    //
    // Reproduced by writing the competing binding from inside the transform's
    // own read — the only deterministic way to sit in that window.
    const sc = scenario();
    const competitor = { vault: 'notes', also: ['planted'], confirmedVia: 'tool' };
    let planted = false;
    const realRead = fs.readFileSync;
    fs.readFileSync = function patched(p, ...rest) {
      const out = realRead.call(this, p, ...rest);
      if (!planted && String(p) === sc.configPath) {
        planted = true;
        const cfg = JSON.parse(realRead.call(this, p, 'utf8'));
        cfg[WORKSPACE_BINDINGS_KEY] = { [canonicalWorkspaceKey(sc.ws)]: competitor };
        realRead.call(this, p, 'utf8'); // keep the read count honest
        fs.writeFileSync(sc.configPath, JSON.stringify(cfg, null, 2), 'utf8');
        return JSON.stringify(cfg);
      }
      return out;
    };
    try {
      await loadIn(sc);
    } finally {
      fs.readFileSync = realRead;
    }
    const entry = sc.read()[WORKSPACE_BINDINGS_KEY][canonicalWorkspaceKey(sc.ws)];
    assert.equal(entry.confirmedVia, 'tool', 'the human confirmation survives');
    assert.deepEqual(entry.also, ['planted'], 'and is not rewritten by the import');
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

  test('A CLEARED BINDING STAYS CLEARED, even when the binding predates the first start', async () => {
    // THE BLOCKER of the final review, reproduced end-to-end against the real
    // `loadRegistry` before it was fixed.
    //
    // The window used to close for a workspace only when something was
    // actually imported INTO it. A workspace that already had a binding —
    // written by `--attach`, by the tool, or by `lock_vault --persist` before
    // this version ever ran — came out of the first start as `already-bound`
    // and was never written into `imported[]`. So the day the user cleared
    // that binding, the next start found no binding, found the still-present
    // dotenv hint, and imported it: an automatic decision reversing an
    // explicit human one, which is the single failure this whole mechanism
    // exists to prevent. `confirmedVia` came back `migration`, so the config
    // even recorded that nobody had confirmed the thing the user had just
    // deliberately removed.
    const sc = scenario();
    const key = canonicalWorkspaceKey(sc.ws);
    const cfg = sc.read();
    cfg[WORKSPACE_BINDINGS_KEY] = { [key]: { vault: 'notes', also: [], confirmedVia: 'attach' } };
    fs.writeFileSync(sc.configPath, JSON.stringify(cfg, null, 2), 'utf8');

    const first = await loadIn(sc);
    assert.equal(first.bindingImported, null, 'nothing imported over an existing binding');
    assert.deepEqual(sc.read()[MIGRATION_KEY].imported, [key],
      'but the workspace is written down as considered — this is the fix');

    // The user clears it, through the very transform the tool uses.
    updateConfigBindings(sc.configPath, (c) => withoutBinding(c, sc.ws));
    assert.equal(readBinding(sc.read(), sc.ws), null);

    const second = await loadIn(sc);
    assert.equal(second.bindingImported, null, 'the cleared binding does NOT come back');
    assert.equal(second.workspaceBinding, null, 'and the workspace is on "all vaults", as the user asked');
  });

  test('and `clear` through THE TOOL closes the window too, whatever the migration had decided', async () => {
    // The registry side closes it for `already-bound`; the tool closes it for
    // the act the user just performed. Two independent reasons, because this
    // is the one place an automatic decision can overwrite a human one — and a
    // workspace can reach `clear` down a path where the migration never had an
    // opinion to record.
    //
    // THE TOOL IS CALLED, not the transform it happens to use. The first
    // version of this test built the same config by calling
    // `updateConfigBindings` with `withMigrationState(withoutBinding(...))` by
    // hand — which is the production code copied into the test, so removing
    // that call from `confirm_workspace_binding` left it green. A mutation
    // said so before this comment was written; the test was decoration for
    // about twenty minutes.
    const sc = scenario({ migration: { openedAt: '2020-06-01T00:00:00Z', imported: [] } });
    const key = canonicalWorkspaceKey(sc.ws);
    updateConfigBindings(sc.configPath, (c) => withBinding(c, sc.ws, { vault: 'notes', confirmedVia: 'tool' }));

    const registry = {
      configPath: sc.configPath,
      vaults: [{ name: 'notes', type: 'local', path: sc.vault }],
      workspaceBinding: readBinding(sc.read(), sc.ws),
    };
    await confirmWorkspaceBinding(registry, { clear: true }, { cwd: sc.ws });
    assert.deepEqual(sc.read()[MIGRATION_KEY].imported, [key],
      'the tool itself wrote the workspace down as considered');

    const reg = await loadIn(sc);
    assert.equal(reg.bindingImported, null, 'the hint is not re-imported after a clear');
    assert.equal(reg.workspaceBinding, null);
  });

  test('A SETTLED WORKSPACE WRITES NOTHING ON LATER STARTS — the config is not touched per session', async () => {
    // A REGRESSION INTRODUCED BY THIS ROUND'S OWN REPAIR, caught by measuring
    // rather than by reading. Closing the window for `already-bound` made that
    // a verdict returned on EVERY start, and the recording is idempotent in
    // content but was returning a fresh object regardless — so the router
    // re-took the inter-process config lock and rewrote `config.json`, the file
    // holding every vault's API key, once per session for the rest of time.
    // Two sessions starting together would also wait on each other for it.
    //
    // Two independent repairs, and this test needs both: `withMigrationState`
    // returns its input when nothing changes, so the WRITE is suppressed; and
    // the caller skips the lock entirely when the workspace is already
    // recorded, so the CONTENTION is too. The mtime is what a user would
    // notice; it is also the only thing that proves no write happened.
    const sc = scenario();
    const key = canonicalWorkspaceKey(sc.ws);
    const cfg = sc.read();
    cfg[WORKSPACE_BINDINGS_KEY] = { [key]: { vault: 'notes', also: [], confirmedVia: 'tool' } };
    fs.writeFileSync(sc.configPath, JSON.stringify(cfg, null, 2), 'utf8');

    await loadIn(sc); // the start that records the workspace as considered
    assert.deepEqual(sc.read()[MIGRATION_KEY].imported, [key]);

    // The mtime is stamped to a KNOWN OLD instant rather than merely read
    // back: two starts inside one filesystem tick would otherwise leave an
    // unchanged mtime whether or not a write happened, which is the
    // granularity flake this repository has already been bitten by
    // (`staleMs: -1`, one launch in three). An hour in the past cannot be
    // produced by accident.
    const stamp = new Date(Date.now() - 3_600_000);
    fs.utimesSync(sc.configPath, stamp, stamp);
    const settled = fs.statSync(sc.configPath).mtimeMs;
    await loadIn(sc);
    await loadIn(sc);
    assert.equal(fs.statSync(sc.configPath).mtimeMs, settled,
      'a second and third start must not rewrite the config at all');
  });

  test('a settled workspace does not even TAKE the config lock — two sessions never wait on each other', async () => {
    // The second half of the repair above, and it needs its own witness
    // because the two mask each other: suppressing the WRITE already stops the
    // file changing, so the mtime assertion cannot tell whether the lock was
    // taken. It matters on its own — Roland runs parallel sessions on one
    // machine, and a lock taken at every start of every bound workspace
    // serialises their start-ups for nothing.
    //
    // Observed by HOLDING the lock and requiring the start to be unaffected.
    // The assertion is one-sided and cannot flake in the false-failure
    // direction: an uncontended start is milliseconds, and a start that takes
    // the lock waits `LOCK_WAIT_MS` (10s) before giving up. Anything under
    // five seconds means the lock was never requested.
    const sc = scenario();
    const key = canonicalWorkspaceKey(sc.ws);
    const cfg = sc.read();
    cfg[WORKSPACE_BINDINGS_KEY] = { [key]: { vault: 'notes', also: [], confirmedVia: 'tool' } };
    fs.writeFileSync(sc.configPath, JSON.stringify(cfg, null, 2), 'utf8');
    await loadIn(sc); // records the workspace as considered

    const release = acquireLock(lockPathFor(sc.configPath, 'config'), { waitMs: 0 });
    assert.ok(release, 'the test must actually hold the lock');
    try {
      const started = Date.now();
      const reg = await loadIn(sc);
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 5_000, `a settled start must not queue behind the lock (took ${elapsed}ms)`);
      assert.equal(reg.workspaceBinding?.vault, 'notes', 'and it still answers correctly');
    } finally {
      release();
    }
  });

  test('A PERSISTED LOCK survives the upgrade — end to end, from the file to the registry', async () => {
    // `lock_vault --persist` wrote this pair. Before the fix the import read
    // only the default-vault line, wrote `locked: false`, and start-up then
    // refused the workspace-origin `OBSIDIAN_ROUTER_LOCKED` — so an isolation
    // boundary the user had explicitly set disappeared on upgrade with nothing
    // anywhere reporting it. Not a lost convenience: the point of a lock is
    // that writes cannot land in another vault.
    const sc = scenario({ dotenv: 'OBSIDIAN_ROUTER_DEFAULT_VAULT=notes\nOBSIDIAN_ROUTER_LOCKED=notes\n' });
    const reg = await loadIn(sc);
    assert.equal(reg.bindingImported?.vault, 'notes');
    assert.equal(reg.bindingImported?.locked, true, 'the import says the lock came with it');
    assert.equal(reg.workspaceBinding.locked, true, 'and the binding on disk carries it');
    assert.equal(sc.read()[WORKSPACE_BINDINGS_KEY][canonicalWorkspaceKey(sc.ws)].locked, true);
  });

  test('THE LIMIT, MEASURED: an archive-extracted project keeps its mtime and IS imported', async () => {
    // `git clone` writes its files now, which is what the window relies on.
    // `tar x`, an unzip that restores timestamps, GitHub's source zipball and
    // `rsync -a` do NOT: they restore the recorded mtime, so a project
    // obtained that way after the upgrade looks older than it is and is
    // imported. No in-process check can tell that file from one written last
    // year — a timestamp is the only signal the disk carries.
    //
    // Pinned rather than fixed, and stated in the README and the CHANGELOG in
    // the same words, because the absolute "a repository you clone after
    // upgrading is never imported" is the kind of claim a user plans around.
    // If someone ever finds a real discriminator, this test is what tells them
    // they are changing a documented behaviour.
    const sc = scenario({ migration: { openedAt: new Date(Date.now() - 3_600_000).toISOString(), imported: [] } });
    const lastYear = new Date(Date.now() - 365 * 86_400_000);
    fs.utimesSync(path.join(sc.ws, '.env'), lastYear, lastYear);
    const reg = await loadIn(sc);
    assert.equal(reg.bindingImported?.vault, 'notes', 'imported — the known limit');
    assert.equal(reg.workspaceBinding.confirmedVia, 'migration',
      'and announced as an import at every session, which is what makes it recoverable');
  });

  test('a binding confirmed after start-up is seen even when the import does NOTHING', async () => {
    // Codex, round 5, on the repair round 4 made. Handing back the binding
    // read INSIDE the lock fixed the path where the import ran — and left the
    // early-return path reading the copy `loadRegistry` parsed at start-up.
    // That is the overwhelmingly common path: nothing to import, so return
    // immediately. A binding another session confirmed in between was on disk,
    // correctly untouched, and ignored for this session's entire life under
    // `--no-watch`, with unqualified calls going wherever the cascade pointed.
    // A fix that reaches only its first site, in a repair for a fix that
    // reached only its first site.
    //
    // The window is CLOSED here (`imported` already holds this workspace), so
    // the import has nothing to do and takes no lock — which is precisely the
    // path that was reading stale.
    //
    // THE FIXTURE IS WHAT MAKES THIS DECISIVE. Writing the binding to the file
    // before `loadIn` would put it in the start-up copy too, and the test
    // would pass with or without the repair. So the START-UP READ is patched
    // to return the config WITHOUT the binding — `loadRegistry` reads through
    // `node:fs/promises`, the fallback re-reads through `node:fs` — while the
    // file on disk carries it. That is the interleaving, reproduced by making
    // the two reads see the two states rather than by hoping for a race.
    const sc = scenario();
    const key = canonicalWorkspaceKey(sc.ws);
    const settled = sc.read();
    settled[MIGRATION_KEY] = { openedAt: '2020-06-01T00:00:00Z', imported: [key] };
    const stale = JSON.stringify(settled, null, 2);
    // What another process confirmed, on disk, after our start-up read.
    settled[WORKSPACE_BINDINGS_KEY] = { [key]: { vault: 'notes', also: ['late'], confirmedVia: 'tool' } };
    fs.writeFileSync(sc.configPath, JSON.stringify(settled, null, 2), 'utf8');

    const realRead = fsp.readFile;
    fsp.readFile = async function patched(p, ...rest) {
      if (String(p) === sc.configPath) return stale;
      return realRead.call(this, p, ...rest);
    };
    let reg;
    try {
      reg = await loadIn(sc);
    } finally {
      fsp.readFile = realRead;
    }
    assert.equal(reg.bindingImported, null, 'nothing was imported — this is the early-return path');
    assert.equal(reg.workspaceBinding?.vault, 'notes', 'and the binding on disk is in force');
    assert.deepEqual(reg.workspaceBinding.also, ['late']);
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

  test('THE REINSTALL CASE: a fresh config, a .env that proposes AND says it refused the same vault — nothing is imported, the question is asked once, with its context', async () => {
    // Decision refus-d-une-proposition-de-liaison, the scenario it was written
    // for: the router was uninstalled (config gone) and reinstalled; the
    // workspace file is the only memory left. The first start opens the window
    // NOW and every file predates it — so without the refusal check, `notes`
    // would be imported as a confirmed binding, in silence, the one thing the
    // file was asking the router NOT to decide alone.
    const sc = scenario({ dotenv: 'OBSIDIAN_ROUTER_DEFAULT_VAULT=notes\nOBSIDIAN_ROUTER_REFUSED_VAULT=notes\n' });
    const reg = await loadIn(sc);
    assert.equal(reg.bindingImported, null, 'the file said no once; the router must not say yes for it');
    assert.equal(reg.workspaceBinding, null);
    assert.equal(reg.bindingHint.status, HINT_STATUS.UNCONFIRMED, 'asked once more…');
    assert.equal(reg.bindingHint.previouslyRefused, true, '…with the context that it was refused here before');
    assert.equal(reg.workspaceRefusals.size, 0, 'the config has no answer — that is the whole situation');
    const cfg = sc.read();
    assert.ok(cfg[MIGRATION_KEY].openedAt, 'the window still opens');
    assert.deepEqual(cfg[MIGRATION_KEY].imported, [], 'and does not close: the user may answer either way');
  });

  test('a refusal in the CONFIG silences the proposal at load, and the registry carries it', async () => {
    const sc = scenario({ refusals: ['notes'] });
    const reg = await loadIn(sc);
    assert.equal(reg.bindingImported, null);
    assert.equal(reg.workspaceBinding, null);
    assert.equal(reg.bindingHint.status, HINT_STATUS.REFUSED);
    assert.equal(reg.bindingHint.previouslyRefused, false, 'the file itself carries no refusal line');
    assert.deepEqual([...reg.workspaceRefusals.keys()], ['notes']);
  });

  test('THE REINSTALL CASE, LOCK FLAVOUR: a .env carrying only LOCKED=X + REFUSED_VAULT=X imports nothing — the refusal answers the lock line too', async () => {
    // Fable round on 7efbad1: the file-side refusal was judged against the
    // DEFAULT_VAULT line only, so this file — a clone of a workspace someone
    // had locked, then refused, then --unlink-workspace'd (which removes the
    // DEFAULT line alone) — had `notes` imported LOCKED at the first start
    // after a reinstall. A workspace file proposes through two lines.
    const sc = scenario({ dotenv: 'OBSIDIAN_ROUTER_LOCKED=notes\nOBSIDIAN_ROUTER_REFUSED_VAULT=notes\n' });
    const reg = await loadIn(sc);
    assert.equal(reg.bindingImported, null, 'the lock hint is refused by the file that carries it');
    assert.equal(reg.workspaceBinding, null);
    assert.equal(reg.lockedVault ?? null, null);
    assert.deepEqual(sc.read()[MIGRATION_KEY].imported, [], 'and the window stays open');
  });

  test('a refusal the HOST exports is not the file\'s: the import runs, and no context is claimed for a line the file never had', async () => {
    // Codex, round on b59eb00: the first version read OBSIDIAN_ROUTER_REFUSED_VAULT
    // from the raw environment, so a launcher exporting it beside a file
    // proposing the same vault skipped the import and had the briefing accuse
    // the project file of a refusal it never contained. The hint counts only
    // when the loader took it from the same workspace file as the proposal.
    const sc = scenario();
    const reg = await loadIn(sc, { host: { OBSIDIAN_ROUTER_REFUSED_VAULT: 'notes' } });
    assert.equal(reg.bindingImported?.vault, 'notes', 'imported as if the variable were not there');
    assert.equal(reg.bindingHint.status, HINT_STATUS.CONFIRMED);
    assert.equal(reg.bindingHint.previouslyRefused, false, 'a fact about the FILE, and the file has no such line');
  });

  test('a refusal of ANOTHER vault does not stop the import (trap 1), and rides along on the registry', async () => {
    const sc = scenario({ refusals: ['work'] });
    const reg = await loadIn(sc);
    assert.equal(reg.bindingImported?.vault, 'notes');
    assert.deepEqual([...reg.workspaceRefusals.keys()], ['work']);
    assert.equal(reg.bindingHint.status, HINT_STATUS.CONFIRMED);
  });
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
      // Compares the proposal to the vault being REFUSED, to decide whether
      // the workspace file spoke that name and so gets the refusal line beside
      // it (decision refus-d-une-proposition-de-liaison, trap 3). Reports and
      // writes a hint; resolves nothing — the vault it acts on is the one
      // the user just named.
      'src/tools/workspace-binding.mjs',
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

    // EVERY ORDINARY SPELLING OF A READ. Round 2 added a bracket-access
    // branch and it was DEAD CODE: this scan runs on `blankStringsAndComments`
    // output, which erases the CONTENT of every string literal, so
    // `process.env['OBSIDIAN_ROUTER_LOCKED']` arrives as `process.env[    ]`
    // and a pattern looking for the quoted key can never match. The mutation
    // that was supposed to prove the branch went red for a different reason —
    // the file had also stopped calling the gate — which is how a dead
    // pattern passed for a whole review round. Found by the Codex review of
    // the merge, 2026-09-03.
    //
    // The repair is to stop looking for the key inside quotes and look at the
    // RAW source for the bracket and alias forms, while still requiring the
    // match to sit at an offset that is code in the blanked text. And an
    // ALIAS of `process.env` is refused outright: a file may not bind it to a
    // local name at all, which is the only way to catch `e.OBSIDIAN_ROUTER_*`
    // without re-implementing scope analysis.
    const keys = GATED_KEYS.join('|');
    const readRe = new RegExp(
      `process[.]env[.](?:${keys})\\b`
      + `|\\{[^}]*\\b(?:${keys})\\b[^}]*\\}\\s*=\\s*process[.]env\\b`,
    );
    // Matched against the RAW source at a code offset (see below).
    const rawReadRe = new RegExp(
      `process\\s*[.\\[]\\s*['"]?env['"]?\\s*\\]?\\s*\\[\\s*['"](?:${keys})['"]\\s*\\]`,
      'g',
    );
    // `const e = process.env;` — an alias hides every later read from any
    // pattern that names `process.env`. The binding must END at `env`: the
    // first version omitted the terminator and matched
    // `const cwd = process.env.CLAUDE_PROJECT_DIR`, i.e. an ordinary read of
    // an unrelated key, and reported five innocent files. Flagging an alias
    // is not enough either — building a subprocess environment from one is
    // legitimate and common — so an alias is only a finding when a GATED KEY
    // is then read off it.
    const aliasBindingRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*process\s*(?:\.\s*env|\[\s*['"]env['"]\s*\])\s*(?=[;,\n])/g;
    const gateRe = /authoritative(?:DefaultVault|LockedVault|VaultPath|EnvSetting)\s*\(/;

    const readers = [];
    const gated = [];
    const aliases = [];
    for (const dir of ['bin', 'hooks', 'src', 'scripts']) {
      for (const file of walk(path.join(ROOT, dir))) {
        const rel = path.relative(ROOT, file).replace(/\\/g, '/');
        const raw = fs.readFileSync(file, 'utf8');
        const code = blankStringsAndComments(raw);
        // A raw-source match counts only where the blanked text still has
        // code — otherwise a sentence in a docblock would register as a read.
        const rawHit = (re) => {
          re.lastIndex = 0;
          for (let m = re.exec(raw); m; m = re.exec(raw)) {
            if (code[m.index] !== ' ') return true;
          }
          return false;
        };
        if (readRe.test(code) || rawHit(rawReadRe)) readers.push(rel);
        // Every local name bound to `process.env`, then: does a gated key get
        // read off any of them?
        aliasBindingRe.lastIndex = 0;
        for (let m = aliasBindingRe.exec(raw); m; m = aliasBindingRe.exec(raw)) {
          if (code[m.index] === ' ') continue; // inside a comment or a string
          const viaAlias = new RegExp(
            `\\b${m[1]}\\s*(?:[.]\\s*(?:${keys})\\b|\\[\\s*['"](?:${keys})['"]\\s*\\])`,
          );
          if (viaAlias.test(raw)) { aliases.push(`${rel} (via \`${m[1]}\`)`); break; }
        }
        if (gateRe.test(code) && rel !== GATE_OWNER) gated.push(rel);
      }
    }

    assert.deepEqual(aliases, [],
      'a local alias of `process.env` hides every later read from this scan — read it directly, '
      + 'or take the value through the gate in src/helpers/workspace-bindings.mjs');
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
