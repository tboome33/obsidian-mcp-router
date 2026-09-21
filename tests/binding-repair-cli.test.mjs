/**
 * `--repair-binding` — the command-line half of the repair, and the pure plan
 * behind it.
 *
 * The accepted decision of 2026-09-20 (points 4a and 5) opened this route: an
 * entry the router cannot read as written used to be diagnosed everywhere and
 * repairable only through an MCP session whose SERVER sat in that workspace.
 * The refusal spelled a call the operator could not make.
 *
 * What these tests hold in place:
 *   - the plan is PURE and its seal is bound to the WORKSPACE + CONFIG FILE,
 *     not to a vault identity (the design point the roadmap flagged as "not to
 *     be rushed"): two workspaces repaired to the same primary must NOT share
 *     a seal;
 *   - a repair KEEPS what the entry holds — secondaries, local tiers, the
 *     lock, unknown fields — because the code keeps them, which is the whole
 *     lot: no sentence is copied to make it true;
 *   - a LOCAL tier is kept and a GLOBAL one is never frozen into the entry;
 *   - the two preconditions are separate and both refuse;
 *   - a strict secondary is never promoted, from here either.
 *
 * The CLI half is spawned as a subprocess, this file's own convention for
 * setup-vault.mjs, against a temp config named by OBSIDIAN_ROUTER_CONFIG.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  planBindingRepair,
  bindingRepairIdentity,
  bindingRepairPlanCore,
  fileOnlyBindingFacts,
  BINDING_REPAIR_OP,
} from '../src/helpers/binding-repair-plan.mjs';
import { computePlanSeal } from '../src/helpers/plan-seal.mjs';
import {
  canonicalWorkspaceKey,
  readBinding,
  rawBindingEntry,
  withRefusal,
} from '../src/helpers/workspace-bindings.mjs';
import { describeBindingWriteEffects, RUNNING_SESSION_NOTE } from '../src/helpers/binding-write.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.resolve(__dirname, '..', 'scripts', 'setup-vault.mjs');

let workDir;
before(() => { workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-binding-')); });
after(() => { fs.rmSync(workDir, { recursive: true, force: true }); });

/** A config naming two bindable vaults, plus whatever entry a test wants. */
function configWith(wsPath, entry, extra = {}) {
  const cfg = {
    portRegistry: { 'C:/V/Notes': 27124, 'C:/V/Work': 27125 },
    vaultNames: { 'C:/V/Notes': 'notes', 'C:/V/Work': 'work' },
    ...extra,
  };
  if (entry !== undefined) cfg.workspaceBindings = { [canonicalWorkspaceKey(wsPath)]: entry };
  return cfg;
}

/** A workspace directory and a config file on disk, for the spawned CLI. */
function fixture(entry, extra = {}) {
  const root = fs.mkdtempSync(path.join(workDir, 'case-'));
  const ws = path.join(root, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(configWith(ws, entry, extra), null, 2));
  return { root, ws, configPath, read: () => JSON.parse(fs.readFileSync(configPath, 'utf8')) };
}

function runRepair(configPath, ...scriptArgs) {
  return spawnSync(process.execPath, [SCRIPT_PATH, '--repair-binding', ...scriptArgs], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: configPath },
  });
}
const sealOf = (out) => (out.match(/approvedPlanSha256:\s*([0-9a-f]{64})/) || [])[1] || null;

// ---------------------------------------------------------------------------
// The plan, as pure data
// ---------------------------------------------------------------------------

describe('the repair plan — what it keeps', () => {
  const WS = path.resolve('/w/project');

  test('an entry with no primary keeps its secondary, its LOCAL tier, its lock and its unknown field', () => {
    const entry = { also: ['work'], alsoLocked: ['work'], locked: true, futureField: 9 };
    const plan = planBindingRepair(configWith(WS, entry), WS, { wantedPrimary: 'notes' });
    assert.equal(plan.blocked, null);
    assert.equal(plan.primary, 'notes');
    assert.deepEqual(plan.also, ['work']);
    assert.deepEqual(plan.alsoLocked, ['work']);
    assert.equal(plan.locked, true, 'the lock is kept by RULE, not by a sentence that names it');
    assert.deepEqual(plan.unknownFields, ['futureField']);
    assert.deepEqual(plan.dropped, [], 'a repair drops nothing');
  });

  test('the caller names NOTHING and still keeps everything — that is the difference from a replacement', () => {
    // The `also` the command passes is empty by construction: `repair` mode
    // unions the entry's own secondaries in. If this ever regressed to
    // "whatever the caller listed", the guarantee would be back in the
    // caller's memory, which is where the lot found it.
    const entry = { also: ['work', 'elsewhere'], alsoWritable: ['work'] };
    const plan = planBindingRepair(configWith(WS, entry), WS, { wantedPrimary: 'notes' });
    assert.deepEqual(plan.also, ['work', 'elsewhere']);
    assert.deepEqual(plan.alsoWritable, ['work']);
  });

  test('a GLOBAL tier is never frozen into the entry', () => {
    // The property to PRESERVE, not to fix. Freezing an effective tier here
    // would create a local restriction outliving the global rule that caused it.
    const entry = { also: ['work'] };
    const plan = planBindingRepair(configWith(WS, entry, { alsoLocked: ['work'] }), WS, { wantedPrimary: 'notes' });
    assert.deepEqual(plan.alsoLocked, [], 'the global list stays global');
  });

  test('the entry\'s own primary is kept when the file can still bind it, with no --primary', () => {
    const entry = { vault: 'notes', also: ['work', 'work'] };
    const plan = planBindingRepair(configWith(WS, entry), WS);
    assert.equal(plan.primary, 'notes');
    assert.deepEqual(plan.also, ['work'], 'the duplicate the router had to repair to read is gone');
  });

  test('an entry naming an unbindable primary is BLOCKED until a primary is chosen', () => {
    const entry = { vault: 'ghost', also: ['work'] };
    const plan = planBindingRepair(configWith(WS, entry), WS);
    assert.equal(plan.blocked, 'no-primary');
    assert.equal(plan.primary, null);
  });

  test('a --primary the file cannot bind is BLOCKED, not taken on trust', () => {
    const plan = planBindingRepair(configWith(WS, { also: ['work'] }), WS, { wantedPrimary: 'ghost' });
    assert.equal(plan.blocked, 'primary-not-bindable');
    assert.equal(plan.primary, null);
  });

  test('a --primary the entry holds as STRICT read-only is BLOCKED', () => {
    const entry = { also: ['work'], alsoLocked: ['work'] };
    const plan = planBindingRepair(configWith(WS, entry), WS, { wantedPrimary: 'work' });
    assert.equal(plan.blocked, 'promotion-refused');
  });

  test('a GLOBAL strict tier blocks the promotion too', () => {
    const entry = { vault: 'notes', also: ['work'] };
    const plan = planBindingRepair(configWith(WS, entry, { alsoLocked: ['work'] }), WS, { wantedPrimary: 'work' });
    assert.equal(plan.blocked, 'promotion-refused');
  });

  test('a DISABLED vault cannot be the repaired primary', () => {
    const plan = planBindingRepair(
      configWith(WS, { also: ['work'] }, { disabledVaults: ['notes'] }),
      WS,
      { wantedPrimary: 'notes' },
    );
    assert.equal(plan.blocked, 'primary-not-bindable');
  });

  test('a workspace with no entry at all is blocked, and says there is nothing to repair', () => {
    const plan = planBindingRepair(configWith(WS, undefined), WS);
    assert.equal(plan.blocked, 'no-entry');
    assert.equal(plan.hasEntry, false);
  });

  test('a --primary does NOT let a repair CREATE a binding where there is none', () => {
    // Found by review. Absence used to be rejected only inside the "no primary
    // could be chosen" branch, so naming one sailed past it and `withBinding`
    // created an entry — turning a repair into a binding command that skips
    // everything `--attach` also writes (the .env hint, the plugin settings,
    // the CLAUDE.md block).
    const plan = planBindingRepair(configWith(WS, undefined), WS, { wantedPrimary: 'notes' });
    assert.equal(plan.blocked, 'no-entry');
    assert.equal(plan.primary, null);
  });

  test('a PRESENT null entry is still repairable — absence and malformation are not the same', () => {
    // `rawBindingEntry` distinguishes `undefined` (no entry) from a stored
    // `null` (someone wrote it). The second is an entry the forgiving reading
    // turns into "no binding" in silence, which is exactly what a repair is for.
    const plan = planBindingRepair(configWith(WS, null), WS, { wantedPrimary: 'notes' });
    assert.equal(plan.blocked, null);
    assert.equal(plan.primary, 'notes');
  });

  test('REPAIR keeps the lock even when the primary CHANGES — replace still does not', () => {
    // Found by review, and it is this lot's own defect one case over: the
    // missing-primary entry got the `?? raw` and the fix was announced for
    // every entry. An entry `{ vault: 'ghost', locked: true }` reads back
    // FINE through `normalizeBinding` — `previous` is not null, its vault is
    // merely unbindable — so repairing it to a new primary took the
    // "same primary?" branch, found false, and dropped the lock in silence,
    // under a preview that promised in writing not to.
    const plan = planBindingRepair(configWith(WS, { vault: 'ghost', also: ['work'], locked: true }), WS, {
      wantedPrimary: 'notes',
    });
    assert.equal(plan.locked, true, 'a repair keeps the lock the entry holds');
    assert.equal(plan.lockMovesTo, 'notes', 'and says where keeping it puts it');
    assert.deepEqual(plan.also, ['work']);
  });

  test('the effective tier is SHOWN, and a global rule is what makes it strict', () => {
    // The local lists alone do not answer "what will this binding permit":
    // `alsoLocked: (none)` can sit above a vault a GLOBAL rule holds strict.
    const entry = { vault: 'notes', also: ['work'] };
    const plain = planBindingRepair(configWith(WS, entry), WS);
    assert.deepEqual(plain.effectiveTiers, [{ vault: 'work', tier: 'soft' }]);
    const global = planBindingRepair(configWith(WS, entry, { alsoLocked: ['work'] }), WS);
    assert.deepEqual(global.alsoLocked, [], 'the global list is still never written into the entry');
    assert.deepEqual(global.effectiveTiers, [{ vault: 'work', tier: 'locked' }]);
  });

  test('the write\'s OTHER footprint is named: the alias entries it deletes', () => {
    // Found by review round 2. `withBinding` deletes EVERY stored key that
    // canonicalises to this workspace before writing the canonical one — which
    // is how the ambiguity self-heals, and is invisible to a routing reader.
    // It is not invisible to someone APPROVING the write: those entries carry
    // their own vault, tiers, lock and unknown fields, and they disappear.
    const key = canonicalWorkspaceKey(WS);
    const cfg = {
      portRegistry: { 'C:/V/Notes': 27124, 'C:/V/Work': 27125 },
      vaultNames: { 'C:/V/Notes': 'notes', 'C:/V/Work': 'work' },
      workspaceBindings: {
        [key]: { also: ['work'], locked: true },
        // The same directory, spelled the way a hand edit would.
        [`${WS}${path.sep}`]: { vault: 'work', note: 'this entry vanishes' },
      },
    };
    const plan = planBindingRepair(cfg, WS, { wantedPrimary: 'notes' });
    assert.deepEqual(plan.aliasesCollapsed.map((a) => a.key), [`${WS}${path.sep}`]);
    assert.deepEqual(bindingRepairPlanCore(plan).aliasesCollapsed, plan.aliasesCollapsed,
      'and it is SEALED: a sibling adding an alias between preview and apply changes what is destroyed');
  });

  test('an alias carries the DIGEST of its content, so EDITING one moves the seal', () => {
    // Found by review round 3. Sealing the alias KEY alone caught a sibling
    // ADDING an alias and missed one EDITING it: the selected entry is
    // untouched, its digest does not move, the key list is identical, and the
    // apply destroys content nobody approved destroying.
    const key = canonicalWorkspaceKey(WS);
    const alias = `${WS}${path.sep}`;
    const cfgWith = (aliasValue) => ({
      portRegistry: { 'C:/V/Notes': 27124, 'C:/V/Work': 27125 },
      vaultNames: { 'C:/V/Notes': 'notes', 'C:/V/Work': 'work' },
      workspaceBindings: { [key]: { also: ['work'] }, [alias]: aliasValue },
    });
    const core = (v) => bindingRepairPlanCore(planBindingRepair(cfgWith(v), WS, { wantedPrimary: 'notes' }));
    const a = core({ vault: 'work', note: 'before' });
    const b = core({ vault: 'work', note: 'AFTER' });
    assert.notDeepEqual(a, b, 'editing a losing alias must move the approved plan');
    // And a re-save that only reorders keys is still not a change.
    assert.deepEqual(
      core({ vault: 'work', note: 'before' }),
      core({ note: 'before', vault: 'work' }),
    );
  });

  test('the write\'s OTHER footprint is named: the refusals it drops', () => {
    // `withBinding` drops a recorded refusal for every vault it binds —
    // adopting is the opposite of refusing. The MCP façade has always said so;
    // this one did not know about it.
    const cfg = configWith(WS, { also: ['work'], locked: true });
    const withRef = withRefusal(cfg, WS, 'work');
    const plan = planBindingRepair(withRef, WS, { wantedPrimary: 'notes' });
    assert.deepEqual(plan.refusalsDropped, ['work']);
    assert.deepEqual(bindingRepairPlanCore(plan).refusalsDropped, ['work']);
  });

  test('dropping a refusal seals the SPELLINGS that removal collapses', () => {
    // Found by review round 4, and it is round 3's alias defect one object
    // over — found by the round that reviewed the repair for it. Dropping a
    // refusal does not edit one key: `withoutRefusal` rebuilds this
    // workspace's entry from the UNION of every spelling and deletes them
    // all. So a sibling editing a spelling that LOSES the union destroys
    // content the selected binding entry's digest cannot see.
    const key = canonicalWorkspaceKey(WS);
    const alias = `${WS}${path.sep}`;
    const cfgWith = (losing) => ({
      ...configWith(WS, { also: ['work'] }),
      workspaceRefusals: {
        [key]: { notes: '2026-09-01', other: '2026-09-02' },
        [alias]: { other: losing },
      },
    });
    const core = (losing) => bindingRepairPlanCore(
      planBindingRepair(cfgWith(losing), WS, { wantedPrimary: 'notes' }),
    );
    const before = core('2026-09-03');
    assert.deepEqual(before.refusalsDropped, ['notes'], 'binding notes drops its refusal');
    assert.equal(before.refusalSpellings.length, 2, 'both spellings are collapsed by that removal');
    assert.notDeepEqual(before, core('2026-09-09'),
      'editing the LOSING spelling must move the approved plan');
  });

  test('a repair that drops NO refusal does not seal the refusal spellings', () => {
    // Otherwise an apply would refuse because someone edited a refusal this
    // write never touches: with nothing to remove, `withoutRefusal` is
    // identity and no spelling is collapsed.
    const key = canonicalWorkspaceKey(WS);
    const cfg = {
      ...configWith(WS, { also: ['work'] }),
      workspaceRefusals: { [key]: { unrelated: '2026-09-01' } },
    };
    const plan = planBindingRepair(cfg, WS, { wantedPrimary: 'notes' });
    assert.deepEqual(plan.refusalsDropped, []);
    assert.deepEqual(plan.refusalSpellings, []);
  });

  test('an UNRELATED refusal does not move the seal when no rebuild happens', () => {
    // Found by review round 7, and it is the round-6 repair forgetting the
    // gate the round-4 repair had just written down one field above it.
    // `withoutRefusal` returns its input immediately when the vault is not
    // refused, so a repair that drops nothing does not touch the refusal
    // record at all — and a sibling recording a refusal of some other vault
    // must not refuse the approved apply.
    const key = canonicalWorkspaceKey(WS);
    const entry = { vault: 'notes', also: [] };
    const plain = configWith(WS, entry);
    const withUnrelated = { ...plain, workspaceRefusals: { [key]: { elsewhere: '2026-09-21' } } };
    const core = (cfg) => bindingRepairPlanCore(planBindingRepair(cfg, WS, { today: '2026-09-21' }));
    assert.deepEqual(core(plain), core(withUnrelated),
      'a refusal this write never touches is not part of the approved plan');
  });

  test('a refusal the repair DOES drop still moves the seal', () => {
    // The other direction, so the gate is not simply "never seal it".
    const key = canonicalWorkspaceKey(WS);
    const entry = { vault: 'notes', also: [] };
    const cfg = (extra) => ({
      ...configWith(WS, entry),
      workspaceRefusals: { [key]: { notes: '2026-09-20', ...extra } },
    });
    const core = (extra) => bindingRepairPlanCore(planBindingRepair(cfg(extra), WS, { today: '2026-09-21' }));
    assert.notDeepEqual(core({}), core({ other: '2026-09-21' }),
      'when the record IS rebuilt, what survives it is part of the approved plan');
  });

  test('the confirmedVia VALUE is sealed, not just the fact that metadata changes', () => {
    // Found by review round 7: two plans differing only in `confirmedVia`
    // sealed identically. Not an approval bypass today — the CLI hard-codes
    // the value — but a helper whose contract holds only by virtue of its one
    // caller has no contract.
    const cfg = configWith(WS, { vault: 'notes', also: [] });
    const core = (confirmedVia) => bindingRepairPlanCore(
      planBindingRepair(cfg, WS, { confirmedVia, today: '2026-09-21' }),
    );
    assert.notDeepEqual(core('repair-A'), core('repair-B'));
    assert.equal(core('repair-binding').confirmedVia, 'repair-binding');
  });

  test('an EMPTY or malformed injected date is refused, never treated as absence', () => {
    // Found by review round 8. An empty `today` sealed `confirmedAt: ''`
    // while `planBindingWrite` dropped it as falsy and `withBinding` fell
    // back to its own clock — so the approved plan named a date the write did
    // not use, which is the exact hole the sealed date was added to close. A
    // silent degradation to the clock is worse than a refusal.
    const cfg = configWith(WS, { vault: 'notes', also: [] });
    for (const today of ['', '2026-9-1', 'today', '20260921']) {
      assert.throws(
        () => planBindingRepair(cfg, WS, { today }),
        /YYYY-MM-DD/,
        `today=${JSON.stringify(today)} must be refused`,
      );
    }
  });

  test('an injected date makes the planner read no clock at all', () => {
    // The header promises this, and it is what makes every date assertion
    // above a measurement rather than a race with midnight.
    const cfg = configWith(WS, { vault: 'notes', also: [] });
    const a = bindingRepairPlanCore(planBindingRepair(cfg, WS, { today: '1999-12-31' }));
    const b = bindingRepairPlanCore(planBindingRepair(cfg, WS, { today: '1999-12-31' }));
    assert.deepEqual(a, b);
    assert.equal(a.confirmedAt, '1999-12-31');
  });

  test('an ordinary entry has an EMPTY extra footprint — the fields are not noise', () => {
    const plan = planBindingRepair(configWith(WS, { also: ['work'] }), WS, { wantedPrimary: 'notes' });
    assert.deepEqual(plan.aliasesCollapsed, []);
    assert.deepEqual(plan.refusalsDropped, []);
  });

  test('the effective tier is NOT in the sealed core — the seal covers what is WRITTEN', () => {
    // Sealing it would refuse an apply because somebody edited a global rule
    // this repair does not touch, and would blur the very line the lot holds:
    // LOCAL data is kept, the EFFECTIVE answer is computed.
    const entry = { vault: 'notes', also: ['work'] };
    const a = bindingRepairPlanCore(planBindingRepair(configWith(WS, entry), WS));
    const b = bindingRepairPlanCore(planBindingRepair(configWith(WS, entry, { alsoLocked: ['work'] }), WS));
    assert.deepEqual(a, b);
    assert.equal(Object.hasOwn(a, 'effectiveTiers'), false);
  });

  test('the lock is CONSERVED, never invented', () => {
    const entry = { also: ['work'] };
    assert.equal(planBindingRepair(configWith(WS, entry), WS, { wantedPrimary: 'notes' }).locked, false);
    assert.equal(
      planBindingRepair(configWith(WS, entry), WS, { wantedPrimary: 'notes', locked: true }).locked,
      true,
      'an explicit --locked still decides',
    );
  });

  test('keeping the lock of a primary-less entry is reported as a DISPLACEMENT', () => {
    // Keeping `locked: true` while choosing a primary does not keep the lock
    // where it was: it points it at another vault. The plan names that so a
    // façade can say it rather than printing a carried boolean.
    const entry = { also: ['work'], locked: true };
    const plan = planBindingRepair(configWith(WS, entry), WS, { wantedPrimary: 'notes' });
    assert.equal(plan.lockMovesTo, 'notes');
  });

  test('"not loaded here" is a session\'s fact, and a command has no session', () => {
    // `registryFactsFor(cfg, [])` would report every healthy name as "in the
    // file but this session has not loaded it" — advice to restart a session
    // that does not exist. The command judges the FILE.
    const facts = fileOnlyBindingFacts(configWith(WS, undefined));
    assert.deepEqual([...facts.sessionNames].sort(), [...facts.bindable].sort());
    const plan = planBindingRepair(configWith(WS, { vault: 'notes', also: [] }), WS);
    assert.deepEqual(plan.anomalies, [], 'a healthy entry has no anomaly to report');
  });
});

describe('the effect sentences — when what they describe takes effect', () => {
  // Found by review round 2. One sentence said "the session is now locked to
  // X, and no other vault answers" for all three readers. True of the MCP
  // tool, which adopts the routing live. FALSE of a command-line apply, which
  // writes a file that a running session never re-reads — the command itself
  // says so two lines later. False twice over of a DRY-RUN, which has written
  // nothing at all: a preview narrating an accomplished fact is the worst of
  // the three.
  const plan = { lockMovesTo: 'notes', droppedSecondaries: ['work'] };

  test('the LIVE voice speaks of this session, because the tool changed it', () => {
    const [lock] = describeBindingWriteEffects(plan, (s) => s, { voice: 'live' });
    assert.match(lock, /the session is now locked to notes/);
  });

  test('the STORED voice speaks of the FILE, not of this session', () => {
    const [lock] = describeBindingWriteEffects(plan, (s) => s, { voice: 'stored' });
    assert.match(lock, /RECORDS a lock on notes/);
    assert.doesNotMatch(lock, /the session is now locked/);
  });

  test('the PLANNED voice is conditional throughout — nothing has happened yet', () => {
    const [lock, drop] = describeBindingWriteEffects(plan, (s) => s, { voice: 'planned' });
    assert.match(lock, /WOULD record a lock on notes/);
    assert.match(lock, /nothing has been written yet/);
    assert.match(drop, /WOULD be dropped/);
  });

  test('an unknown voice falls back to the live one rather than printing undefined', () => {
    const [lock] = describeBindingWriteEffects(plan, (s) => s, { voice: 'nonsense' });
    assert.match(lock, /the session is now locked to notes/);
  });

  test('an INHERITED property name falls back too — the dictionaries have no prototype', () => {
    // Found by review round 3, by execution. A plain object literal inherits
    // from Object.prototype, so `VOICE['toString']` is a function and is not
    // nullish: `?? live` never fires and the sentence rendered
    // "[object Undefined]". `VOICE['__proto__']` is an object, not a
    // function, and threw. Every caller passes a literal today, which is
    // exactly the kind of contract defect that waits for a fourth caller.
    for (const voice of ['toString', '__proto__', 'constructor', 'hasOwnProperty']) {
      const [lock] = describeBindingWriteEffects(plan, (s) => s, { voice });
      assert.match(lock, /the session is now locked to notes/, `voice=${voice}`);
    }
  });

  test('EVERY CLAUSE of the shared note is one the watcher owes', () => {
    // "reloads this within moments" was a timing guarantee the implementation
    // does not give: the handler debounces by 500 ms (so a stream of changes
    // keeps postponing it), a rebuild that throws is caught and the PREVIOUS
    // registry is kept, and watching is skipped under --no-watch, abandoned
    // on a watcher error, and never started if the directory cannot be
    // watched. (Codex, review round 5.)
    assert.match(RUNNING_SESSION_NOTE, /ATTEMPTS a reload/);
    assert.match(RUNNING_SESSION_NOTE, /may pick this up/);
    assert.match(RUNNING_SESSION_NOTE, /a reload that fails keeps the previous state/);
    assert.match(RUNNING_SESSION_NOTE, /--no-watch/);
    assert.doesNotMatch(RUNNING_SESSION_NOTE, /within moments/);
  });

  test('THE CLASS IS SWEPT: no file claims a running session never re-reads the config', () => {
    // A SCAN, not an assertion per site. The false sentence was repaired in
    // the renderer and left standing in the CLI preview, the CLI recap, this
    // file's own JSDoc and an implementation comment — four readers, repaired
    // one at a time across two review rounds. What keeps it from coming back
    // is a search of the sources, not a promise that they were all found.
    const files = [
      'src/helpers/binding-write.mjs',
      'src/helpers/binding-repair-plan.mjs',
      'src/tools/workspace-binding.mjs',
      'scripts/setup-vault.mjs',
    ];
    const banned = [
      /does not re-read (this|the) (file|config)/i,
      /changed no running session/i,
      /changes NO running session/i,
      /never re-reads it/i,
      /within moments/i,
    ];
    for (const rel of files) {
      const text = fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
      for (const pattern of banned) {
        assert.doesNotMatch(text, pattern, `${rel} must not claim: ${pattern}`);
      }
    }
  });

  test('the STORED voice does not promise a restart is needed — the router watches its config', () => {
    // "keeps what it has until it is restarted" was an unjustified promise:
    // the router watches its config file by default and reloads the registry
    // on change. Only --no-watch makes the restart sentence true, and the
    // renderer cannot know which was used.
    const [lock] = describeBindingWriteEffects(plan, (s) => s, { voice: 'stored' });
    assert.ok(lock.includes(RUNNING_SESSION_NOTE), 'it QUOTES the one definition, it does not paraphrase it');
    assert.match(lock, /--no-watch/);
  });

  test('the promotion sentence obeys the voice too — a new sentence inherits no rule by itself', () => {
    // Found by review round 4: the promotion sentence was ADDED by the round
    // that reviewed the voice repair, and walked straight past it — "is now
    // its PRIMARY" under `planned`, where nothing has been written.
    const promo = { promoted: { vault: 'work', tier: 'writable' } };
    assert.match(describeBindingWriteEffects(promo, (s) => s, { voice: 'planned' })[0], /WOULD become its PRIMARY/);
    assert.match(describeBindingWriteEffects(promo, (s) => s, { voice: 'live' })[0], /is now its PRIMARY/);
    assert.match(
      describeBindingWriteEffects(promo, (s) => s, { voice: 'stored' })[0],
      /is now, in the stored binding, its PRIMARY/,
    );
  });

  test('the promotion sentence says LOCAL tier, and that a global rule is untouched', () => {
    // The old wording claimed re-declaring the vault brings back NO tier,
    // which cannot describe the EFFECTIVE tier: a global rule survives all of
    // this and applies again the moment the vault is a secondary.
    const [said] = describeBindingWriteEffects({ promoted: { vault: 'work', tier: 'locked' } }, (s) => s);
    assert.match(said, /RECORDED ON THIS BINDING/);
    assert.match(said, /GLOBAL alsoLocked\/alsoWritable rule naming it is untouched/);
  });
});

describe('the seal identity — a workspace and a config file, NOT a vault', () => {
  const A = path.resolve('/w/alpha');
  const B = path.resolve('/w/beta');

  test('two workspaces repaired to the same primary do NOT share a seal', () => {
    // THE DESIGN POINT. `vaultIdentity` produces `{ name, baseUrl }` — right
    // for an operation that acts on a vault, wrong here: a binding repair acts
    // on a workspace and a config file. Borrowing it would have let a plan
    // previewed for one workspace confirm an apply on another whenever both
    // chose the same primary.
    const entry = { also: ['work'], locked: true };
    const cfgPath = '/cfg/config.json';
    const sealFor = (ws) => computePlanSeal({
      op: BINDING_REPAIR_OP,
      identity: bindingRepairIdentity({ cwd: ws, configPath: cfgPath }),
      plan: bindingRepairPlanCore(planBindingRepair(configWith(ws, entry), ws, { wantedPrimary: 'notes' })),
    });
    assert.notEqual(sealFor(A), sealFor(B));
  });

  test('the same workspace in two DIFFERENT config files does not share a seal', () => {
    const entry = { also: ['work'] };
    const plan = bindingRepairPlanCore(planBindingRepair(configWith(A, entry), A, { wantedPrimary: 'notes' }));
    const seal = (configPath) => computePlanSeal({
      op: BINDING_REPAIR_OP,
      identity: bindingRepairIdentity({ cwd: A, configPath }),
      plan,
    });
    assert.notEqual(seal('/cfg/one.json'), seal('/cfg/two.json'));
  });

  test('the identity normalises both halves, so two spellings of one target agree', () => {
    const a = bindingRepairIdentity({ cwd: A, configPath: '/cfg/./config.json' });
    const b = bindingRepairIdentity({ cwd: A, configPath: '/cfg/config.json' });
    assert.deepEqual(a, b);
  });

  test('the identity CARRIES both halves — asked of the identity, not through a plan', () => {
    // THIS WITNESS EXISTS BECAUSE A MUTATION SURVIVED. Emptying the workspace
    // half of the identity changed no seal, because `bindingRepairPlanCore`
    // ALSO carries the workspace: the seal stayed distinct for the right
    // answer by the wrong mechanism, and the test could not tell which of the
    // two was doing the work. The redundancy is worth keeping — the identity
    // is what binds a seal to its target even if the plan's shape changes —
    // so it is asked here, on its own.
    const a = bindingRepairIdentity({ cwd: A, configPath: '/cfg/config.json' });
    const b = bindingRepairIdentity({ cwd: B, configPath: '/cfg/config.json' });
    assert.equal(a.workspace, canonicalWorkspaceKey(A));
    assert.notEqual(a.workspace, b.workspace, 'the workspace half distinguishes two targets');
    assert.equal(a.configPath, path.resolve('/cfg/config.json'));
    assert.notDeepEqual(a, b);
  });

  test('a missing half is empty, never undefined — the seal must be computable either way', () => {
    const id = bindingRepairIdentity({ cwd: '', configPath: '' });
    assert.deepEqual(id, { workspace: '', configPath: '' });
  });

  test('the seal moves when the plan moves — a different primary is a different plan', () => {
    const entry = { also: ['work'], locked: true };
    const id = bindingRepairIdentity({ cwd: A, configPath: '/cfg/config.json' });
    const sealWith = (opts) => computePlanSeal({
      op: BINDING_REPAIR_OP,
      identity: id,
      plan: bindingRepairPlanCore(planBindingRepair(configWith(A, entry), A, opts)),
    });
    assert.notEqual(sealWith({ wantedPrimary: 'notes' }), sealWith({ wantedPrimary: 'work' }));
    assert.notEqual(
      sealWith({ wantedPrimary: 'notes' }),
      sealWith({ wantedPrimary: 'notes', locked: false }),
      'dropping the lock is a different plan, and must not pass under the same seal',
    );
  });
});

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

describe('--repair-binding, spawned', () => {
  test('a --dry-run prints the plan and a seal, and writes NOTHING', () => {
    const f = fixture({ also: ['work'], alsoLocked: ['work'], locked: true, futureField: 9 });
    const before = fs.readFileSync(f.configPath, 'utf8');
    const r = runRepair(f.configPath, f.ws, '--primary', 'notes', '--dry-run');
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.ok(sealOf(r.stdout), 'a 64-hex seal must be printed');
    assert.match(r.stdout, /secondaries:\s+work/);
    assert.match(r.stdout, /alsoLocked:\s+work/);
    assert.match(r.stdout, /locked:\s+true/);
    assert.match(r.stdout, /other fields kept: futureField/);
    assert.equal(fs.readFileSync(f.configPath, 'utf8'), before, 'a dry-run writes nothing');
  });

  test('the dry-run ANNOUNCES the lock displacement, in the words of this façade', () => {
    const f = fixture({ also: ['work'], locked: true });
    const r = runRepair(f.configPath, f.ws, '--primary', 'notes', '--dry-run');
    assert.match(r.stdout, /keeping it MOVES it/);
    assert.match(r.stdout, /--no-locked/, 'a terminal operator is told a flag they can type, not a tool argument');
    assert.doesNotMatch(r.stdout, /pass `locked: false`/);
  });

  test('an apply with the seal keeps everything the entry held', () => {
    const f = fixture({ also: ['work'], alsoLocked: ['work'], locked: true, futureField: 9 });
    const seal = sealOf(runRepair(f.configPath, f.ws, '--primary', 'notes', '--dry-run').stdout);
    const r = runRepair(f.configPath, f.ws, '--primary', 'notes', '--approved-plan-sha256', seal);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const after = f.read();
    const binding = readBinding(after, f.ws);
    assert.equal(binding.vault, 'notes');
    assert.deepEqual(binding.also, ['work']);
    assert.deepEqual(binding.alsoLocked, ['work']);
    assert.equal(binding.locked, true);
    assert.equal(rawBindingEntry(after, f.ws).futureField, 9);
    assert.equal(binding.confirmedVia, 'repair-binding');
  });

  test('an apply WITHOUT a seal is refused, and writes nothing', () => {
    // Stricter than the other sealed flows in this script, on purpose: a
    // binding repair is applied by someone who has read what it would keep,
    // and the seal is what proves they saw it.
    const f = fixture({ also: ['work'], locked: true });
    const before = fs.readFileSync(f.configPath, 'utf8');
    const r = runRepair(f.configPath, f.ws, '--primary', 'notes');
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /--approved-plan-sha256/);
    assert.equal(fs.readFileSync(f.configPath, 'utf8'), before);
  });

  test('a seal that was already used refuses the second time (the entry moved)', () => {
    const f = fixture({ also: ['work'], locked: true });
    const seal = sealOf(runRepair(f.configPath, f.ws, '--primary', 'notes', '--dry-run').stdout);
    assert.equal(runRepair(f.configPath, f.ws, '--primary', 'notes', '--approved-plan-sha256', seal).status, 0);
    const afterFirst = fs.readFileSync(f.configPath, 'utf8');
    const second = runRepair(f.configPath, f.ws, '--primary', 'notes', '--approved-plan-sha256', seal);
    assert.equal(second.status, 1);
    assert.equal(fs.readFileSync(f.configPath, 'utf8'), afterFirst, 'the refusal changed nothing');
  });

  test('the drift refusal names what actually moved — not "the vault"', () => {
    // The shared drift sentence says "The vault changed between the preview
    // and this apply", which is true of every operation it was written for and
    // false of this one: it acts on a workspace and a config file. A refusal
    // that sends the operator to inspect a healthy vault is a wrong sentence.
    const f = fixture({ also: ['work'], locked: true });
    const seal = sealOf(runRepair(f.configPath, f.ws, '--primary', 'notes', '--dry-run').stdout);
    runRepair(f.configPath, f.ws, '--primary', 'notes', '--approved-plan-sha256', seal);
    const drift = runRepair(f.configPath, f.ws, '--primary', 'notes', '--approved-plan-sha256', seal);
    const said = drift.stdout + drift.stderr;
    assert.match(said, /binding entry/);
    assert.doesNotMatch(said, /The vault changed between the preview/);
  });

  test('a seal minted for ANOTHER workspace does not apply here', () => {
    const a = fixture({ also: ['work'], locked: true });
    const b = fixture({ also: ['work'], locked: true });
    const sealA = sealOf(runRepair(a.configPath, a.ws, '--primary', 'notes', '--dry-run').stdout);
    const before = fs.readFileSync(b.configPath, 'utf8');
    const r = runRepair(b.configPath, b.ws, '--primary', 'notes', '--approved-plan-sha256', sealA);
    assert.equal(r.status, 1, 'a plan approved for one workspace is not a plan approved for another');
    assert.equal(fs.readFileSync(b.configPath, 'utf8'), before);
  });

  test('a strict secondary is NOT promoted to primary by this command — refused at the DRY-RUN', () => {
    // Question 4(b) of the decision page is open, and its status quo — refused
    // since round sixteen — is not reopened by opening a terminal route.
    //
    // AND IT IS REFUSED BEFORE A SEAL EXISTS. The first version only refused at
    // the apply, so `--dry-run` printed a full plan and an approvedPlanSha256
    // for a repair that could never land: an approval handed out for something
    // that cannot happen reads as a green light.
    const f = fixture({ vault: 'notes', also: ['work'], alsoLocked: ['work'] });
    const before = fs.readFileSync(f.configPath, 'utf8');
    const dry = runRepair(f.configPath, f.ws, '--primary', 'work', '--dry-run');
    assert.equal(dry.status, 1);
    assert.equal(sealOf(dry.stdout), null, 'no seal is minted for a plan that cannot be applied');
    assert.match(dry.stdout + dry.stderr, /LOCKED read-only/);
    assert.equal(fs.readFileSync(f.configPath, 'utf8'), before);
  });

  test('a strict secondary held only by the entry of a PRIMARY-LESS binding is refused too', () => {
    // The raw-entry reading (round 11): the repaired reading is null for this
    // entry, so a guard asking `previous` would see no tier at all and let the
    // promotion through — by way of the very door a repair opens.
    const f = fixture({ also: ['work'], alsoLocked: ['work'] });
    const before = fs.readFileSync(f.configPath, 'utf8');
    const dry = runRepair(f.configPath, f.ws, '--primary', 'work', '--dry-run');
    assert.equal(dry.status, 1);
    assert.equal(sealOf(dry.stdout), null);
    assert.match(dry.stdout + dry.stderr, /LOCKED read-only/);
    assert.equal(fs.readFileSync(f.configPath, 'utf8'), before);
  });

  test('an unbindable --primary is refused at the DRY-RUN, with no seal minted', () => {
    // A name the operator typed is judged like any other. Taken on trust, it
    // produced a plan and a seal the apply then refused one command later.
    const f = fixture({ also: ['work'] });
    const r = runRepair(f.configPath, f.ws, '--primary', 'ghost', '--dry-run');
    assert.equal(r.status, 1);
    assert.equal(sealOf(r.stdout), null);
    const said = r.stdout + r.stderr;
    assert.match(said, /not a vault this config file can bind/);
    assert.doesNotMatch(said, /permission/i);
  });

  test('a primary-less entry with no --primary says what to pass, and lists what is bindable', () => {
    const f = fixture({ also: ['work'], locked: true });
    const r = runRepair(f.configPath, f.ws, '--dry-run');
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /--primary <vault>/);
    assert.match(r.stdout + r.stderr, /notes, work/);
  });

  test('--locked and --no-locked together are refused rather than silently ordered', () => {
    const f = fixture({ also: ['work'] });
    const r = runRepair(f.configPath, f.ws, '--primary', 'notes', '--locked', '--no-locked', '--dry-run');
    assert.equal(r.status, 1);
  });

  test('--no-locked drops a lock the entry held, and the apply honours it', () => {
    const f = fixture({ also: ['work'], locked: true });
    const seal = sealOf(runRepair(f.configPath, f.ws, '--primary', 'notes', '--no-locked', '--dry-run').stdout);
    const r = runRepair(f.configPath, f.ws, '--primary', 'notes', '--no-locked', '--approved-plan-sha256', seal);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.equal(readBinding(f.read(), f.ws).locked, false);
  });

  test('a repair of an unbindable-primary entry keeps the lock, end to end', () => {
    const f = fixture({ vault: 'ghost', also: ['work'], alsoLocked: ['work'], locked: true });
    const dry = runRepair(f.configPath, f.ws, '--primary', 'notes', '--dry-run');
    assert.equal(dry.status, 0, dry.stderr || dry.stdout);
    assert.match(dry.stdout, /locked:\s+true/);
    assert.match(dry.stdout, /keeping it MOVES it/);
    const r = runRepair(f.configPath, f.ws, '--primary', 'notes', '--approved-plan-sha256', sealOf(dry.stdout));
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const binding = readBinding(f.read(), f.ws);
    assert.equal(binding.locked, true);
    assert.deepEqual(binding.alsoLocked, ['work']);
  });

  test('--repair-binding refuses to CREATE a binding, even with --primary', () => {
    const f = fixture(undefined);
    const before = fs.readFileSync(f.configPath, 'utf8');
    const r = runRepair(f.configPath, f.ws, '--primary', 'notes', '--dry-run');
    assert.equal(r.status, 1);
    assert.equal(sealOf(r.stdout), null);
    assert.match(r.stdout + r.stderr, /--attach or --link-workspace/);
    assert.equal(fs.readFileSync(f.configPath, 'utf8'), before);
  });

  test('the dry-run prints the EFFECTIVE tier, global rules included', () => {
    const f = fixture({ vault: 'notes', also: ['work'] }, { alsoLocked: ['work'] });
    const r = runRepair(f.configPath, f.ws, '--dry-run');
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /alsoLocked:\s+\(none\)/, 'the entry\'s own list stays empty');
    assert.match(r.stdout, /work: locked/, 'and the effective answer says what it will permit');
  });

  test('the dry-run speaks in the conditional, and the apply speaks of the FILE', () => {
    const f = fixture({ also: ['work'], locked: true });
    const dry = runRepair(f.configPath, f.ws, '--primary', 'notes', '--dry-run');
    assert.match(dry.stdout, /WOULD record a lock on/);
    assert.doesNotMatch(dry.stdout, /the session is now locked/);
    const r = runRepair(f.configPath, f.ws, '--primary', 'notes', '--approved-plan-sha256', sealOf(dry.stdout));
    assert.match(r.stdout, /RECORDS a lock on/);
    assert.doesNotMatch(r.stdout, /the session is now locked/,
      'a command writes a file; it does not re-route a session that is already running');
  });

  test('--no-locked does not print "it does not drop a lock" above a plan that drops one', () => {
    // A promise contradicted four lines up by the plan it introduces.
    const f = fixture({ vault: 'notes', also: ['work'], locked: true });
    const r = runRepair(f.configPath, f.ws, '--no-locked', '--dry-run');
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /locked:\s+false/);
    assert.doesNotMatch(r.stdout, /does not drop a secondary, a write tier, a lock/,
      'the unqualified promise is not printed at all when it has an exception');
    assert.match(r.stdout, /EXCEPT:/);
    assert.match(r.stdout, /because you passed --no-locked/);
  });

  test('a coherent entry says so WITHOUT claiming the call changes nothing', () => {
    // "This entry reads as written" is about the ENTRY; "only re-writes it as
    // it stands" is about THIS CALL, and a call carrying --primary changes it.
    const f = fixture({ vault: 'notes', also: ['work'] });
    const same = runRepair(f.configPath, f.ws, '--dry-run');
    // Round 4: there is no "changes nothing" repair. Even a call that keeps
    // every routing field re-stamps confirmedVia/confirmedAt, because a repair
    // IS a fresh confirmation — so the metadata is what it changes, and it
    // says so rather than claiming a no-op.
    assert.match(same.stdout, /reads as written/);
    assert.match(same.stdout, /confirmedVia becomes repair-binding/);
    assert.doesNotMatch(same.stdout, /the primary becomes/);

    const moved = runRepair(f.configPath, f.ws, '--primary', 'work', '--dry-run');
    assert.match(moved.stdout, /reads as written/);
    assert.match(moved.stdout, /the primary becomes work/);
  });

  test('a flag that changes NOTHING is not announced as a change of its own', () => {
    // Found by review round 3: the announcement counted FLAGS, so `--locked`
    // on an already-locked entry claimed a lock change there was none of. A
    // flag is a request; the plan is the answer, and the answer is what is read.
    const f = fixture({ vault: 'notes', also: ['work'], locked: true });
    const r = runRepair(f.configPath, f.ws, '--locked', '--dry-run');
    assert.doesNotMatch(r.stdout, /locked becomes/);
    assert.doesNotMatch(r.stdout, /the primary becomes/);
  });

  test('an entry stored under a NON-canonical spelling reports its relocation', () => {
    // Found by review round 4. `withBinding` deletes the key the entry was
    // read from and stores the canonical one. No alias, no content lost — but
    // the file is not what it was, and the preview said nothing.
    const f = fixture(undefined);
    const cfg = JSON.parse(fs.readFileSync(f.configPath, 'utf8'));
    cfg.workspaceBindings = { [`${f.ws}${path.sep}`]: { vault: 'notes', also: ['work'] } };
    fs.writeFileSync(f.configPath, JSON.stringify(cfg, null, 2));
    const r = runRepair(f.configPath, f.ws, '--dry-run');
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /moves to this workspace's canonical key/);
    assert.doesNotMatch(r.stdout, /What it also DELETES/, 'one spelling is not an alias collapse');
  });

  test('a refusal that the write will drop counts as a change, with no flag passed', () => {
    // The other direction of the same defect: "changing nothing" was printed
    // while `withBinding` removed a recorded refusal.
    const f = fixture({ vault: 'notes', also: [] });
    const cfg = withRefusal(JSON.parse(fs.readFileSync(f.configPath, 'utf8')), f.ws, 'notes');
    fs.writeFileSync(f.configPath, JSON.stringify(cfg, null, 2));
    const r = runRepair(f.configPath, f.ws, '--dry-run');
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /a recorded refusal is dropped/);
    assert.doesNotMatch(r.stdout, /changing nothing/);
  });

  test('promoting a writable secondary is announced as the loss it is', () => {
    // The conservation promise used to be printed unqualified above a plan
    // that removed a secondary declaration and its tier.
    const f = fixture({ vault: 'notes', also: ['work'], alsoWritable: ['work'] });
    const r = runRepair(f.configPath, f.ws, '--primary', 'work', '--dry-run');
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /EXCEPT:/);
    assert.doesNotMatch(r.stdout, /does not drop a secondary, a write tier, a lock/);
    assert.match(r.stdout, /writable tier, because you made/);
    // The dry-run speaks in the conditional here too.
    assert.match(r.stdout, /was a SECONDARY of this workspace and WOULD become its PRIMARY/);
  });

  test('the dry-run NAMES the alias entries the write will delete', () => {
    const f = fixture({ vault: 'notes', also: ['work'] });
    // A second spelling of the same directory, as a hand edit leaves behind.
    const cfg = JSON.parse(fs.readFileSync(f.configPath, 'utf8'));
    const alias = `${f.ws}${path.sep}`;
    cfg.workspaceBindings[alias] = { vault: 'work', note: 'this entry vanishes' };
    fs.writeFileSync(f.configPath, JSON.stringify(cfg, null, 2));

    const dry = runRepair(f.configPath, f.ws, '--dry-run');
    assert.equal(dry.status, 0, dry.stderr || dry.stdout);
    assert.match(dry.stdout, /What it also DELETES/);
    const r = runRepair(f.configPath, f.ws, '--approved-plan-sha256', sealOf(dry.stdout));
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /other spellings of this workspace DELETED/);
    assert.equal(Object.keys(f.read().workspaceBindings).length, 1, 'the alias really is gone');
  });

  test('an alias added between the preview and the apply refuses the seal', () => {
    // The concurrency the round-2 finding names: the SELECTED entry is
    // untouched, so its digest does not move — but the write destroys more
    // than the operator approved.
    const f = fixture({ vault: 'notes', also: ['work'] });
    const seal = sealOf(runRepair(f.configPath, f.ws, '--dry-run').stdout);
    const cfg = JSON.parse(fs.readFileSync(f.configPath, 'utf8'));
    cfg.workspaceBindings[`${f.ws}${path.sep}`] = { vault: 'work', note: 'added by a sibling' };
    fs.writeFileSync(f.configPath, JSON.stringify(cfg, null, 2));
    const before = fs.readFileSync(f.configPath, 'utf8');

    const r = runRepair(f.configPath, f.ws, '--approved-plan-sha256', seal);
    assert.equal(r.status, 1, 'the approved plan no longer describes what would be destroyed');
    assert.equal(fs.readFileSync(f.configPath, 'utf8'), before);
  });

  test('repairing the SAME entry twice in one day writes nothing the second time, and says so', () => {
    // Found by review round 5, refuting a claim of round 4's. Round 4 deleted
    // the "writes nothing" branch as unreachable, on the strength of
    // `metadataRewritten = raw !== undefined` — which is whether the metadata
    // is ASSIGNED, not whether it DIFFERS. The second repair assigns the same
    // confirmedVia and the same date, `unchangedBindings` finds the record
    // identical, and no file is written at all.
    const f = fixture({ also: ['work'], locked: true });
    const seal = sealOf(runRepair(f.configPath, f.ws, '--primary', 'notes', '--dry-run').stdout);
    assert.equal(runRepair(f.configPath, f.ws, '--primary', 'notes', '--approved-plan-sha256', seal).status, 0);
    const afterFirst = fs.readFileSync(f.configPath, 'utf8');

    const second = runRepair(f.configPath, f.ws, '--primary', 'notes', '--dry-run');
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.match(second.stdout, /would write nothing/);
    assert.doesNotMatch(second.stdout, /confirmedVia becomes repair-binding/);

    const applied = runRepair(f.configPath, f.ws, '--primary', 'notes', '--approved-plan-sha256', sealOf(second.stdout));
    assert.equal(applied.status, 0, applied.stderr || applied.stdout);
    assert.equal(fs.readFileSync(f.configPath, 'utf8'), afterFirst, 'the file is left byte-identical');
  });

  test('dropping a refusal DISCLOSES the rebuild, not only the name it drops', () => {
    // Round 4 SEALED the refusal spellings and round 5 found that no sentence
    // described them: the operator was asked to approve a destruction the
    // preview never mentioned. Removing a refusal deletes every spelling and
    // rebuilds one canonical entry from the union of the readable ones — so
    // content the reader cannot take as a refusal map is destroyed outright.
    const f = fixture({ vault: 'notes', also: [] });
    const cfg = JSON.parse(fs.readFileSync(f.configPath, 'utf8'));
    cfg.workspaceRefusals = {
      [canonicalWorkspaceKey(f.ws)]: { notes: '2026-09-20', other: '2026-09-19' },
      [`${f.ws}${path.sep}`]: ['content the union reader ignores'],
    };
    fs.writeFileSync(f.configPath, JSON.stringify(cfg, null, 2));

    const r = runRepair(f.configPath, f.ws, '--dry-run');
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /recorded refusal of notes/);
    assert.match(r.stdout, /REBUILDS this workspace's refusal record/);
    assert.match(r.stdout, /cannot take as a refusal map is dropped/);
    // What is written BACK, named — `other` survives, `notes` is adopted.
    assert.match(r.stdout, /What is written back, in one canonical entry: other\./);
    assert.match(r.stdout, /refusal record is rebuilt, keeping other/);
  });

  test('when the adopted vaults were the ONLY refusals, the record is REMOVED, and it says so', () => {
    // Found by review round 6. `withoutRefusal` writes the canonical entry
    // only `if (current.size)`: the preview promised "one canonical entry is
    // written" in every case, and in this one nothing is written back at all
    // — the record goes, and the top-level property with it.
    const f = fixture({ vault: 'notes', also: [] });
    const cfg = JSON.parse(fs.readFileSync(f.configPath, 'utf8'));
    cfg.workspaceRefusals = { [canonicalWorkspaceKey(f.ws)]: { notes: '2026-09-20' } };
    fs.writeFileSync(f.configPath, JSON.stringify(cfg, null, 2));

    const r = runRepair(f.configPath, f.ws, '--dry-run');
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /NOTHING is written back/);
    assert.match(r.stdout, /refusal record is REMOVED/);
    assert.doesNotMatch(r.stdout, /What is written back, in one canonical entry/);

    const applied = runRepair(f.configPath, f.ws, '--approved-plan-sha256', sealOf(r.stdout));
    assert.equal(applied.status, 0, applied.stderr || applied.stdout);
    assert.equal(f.read().workspaceRefusals, undefined, 'and that is really what happens');
  });

  test('the DATE is sealed as a VALUE, so two previews a day apart do not share a seal', () => {
    // Found by review round 6, and it is the strongest of that round. The
    // plan sealed a BOOLEAN — "the metadata differs" — which cannot tell the
    // 21st from the 22nd: both previews said true, the cores matched, the
    // seal passed, and the writer stamped a date the preview never showed.
    const W = path.resolve('/w/dated');
    const cfg = configWith(W, { vault: 'notes', also: [], confirmedVia: 'repair-binding', confirmedAt: '2026-09-19' });
    const core = (today) => bindingRepairPlanCore(planBindingRepair(cfg, W, { today }));
    const a = core('2026-09-21');
    const b = core('2026-09-22');
    assert.equal(a.confirmedAt, '2026-09-21');
    assert.notDeepEqual(a, b, 'a different stamped date is a different write');
  });

  test('the plan hands the writer the date it sealed, instead of letting it read a clock', () => {
    // Sealing the date is not enough on its own: `withBinding` stamps
    // `new Date()` when the entry carries no `confirmedAt`, so the verified
    // plan and the write could straddle midnight and disagree anyway.
    const W = path.resolve('/w/dated');
    const plan = planBindingRepair(configWith(W, { vault: 'notes', also: [] }), W, { today: '2026-01-02' });
    assert.equal(plan.entry.confirmedAt, '2026-01-02',
      'the entry the writer stores carries the verified date');
  });

  test('a missing workspace directory is refused before anything is read', () => {
    const f = fixture({ also: ['work'] });
    const r = runRepair(f.configPath, path.join(f.root, 'nope'), '--primary', 'notes', '--dry-run');
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /does not exist/);
  });

  test('a malformed seal fails fast rather than degrading to "no seal"', () => {
    const f = fixture({ also: ['work'] });
    const before = fs.readFileSync(f.configPath, 'utf8');
    const r = runRepair(f.configPath, f.ws, '--primary', 'notes', '--approved-plan-sha256', 'nothex');
    assert.equal(r.status, 1);
    assert.equal(fs.readFileSync(f.configPath, 'utf8'), before);
  });

  test('the command never writes the workspace\'s .env', () => {
    const f = fixture({ also: ['work'], locked: true });
    const seal = sealOf(runRepair(f.configPath, f.ws, '--primary', 'notes', '--dry-run').stdout);
    runRepair(f.configPath, f.ws, '--primary', 'notes', '--approved-plan-sha256', seal);
    assert.equal(fs.existsSync(path.join(f.ws, '.env')), false,
      'a repair touches the binding record and nothing else');
  });
});
