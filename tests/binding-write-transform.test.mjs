/**
 * The binding WRITE TRANSFORM — the sequence `confirm_workspace_binding` runs
 * inside the config lock, characterised BEFORE it was extracted into a shared
 * function.
 *
 * Why this file exists, and why it was written first. The lot « réparation des
 * liaisons » moves that sequence out of the tool so the MCP tool and the CLI
 * can share ONE repairer rather than two that drift. Moved code is new code,
 * and this particular code has been hardened by seventeen rounds of
 * adversarial review — so every property the move must not lose is pinned
 * here, driven through the PUBLIC tool, and each witness was run against the
 * pre-move implementation before a single line was displaced.
 *
 * The one witness that was RED on the old code is marked as such: the lock of
 * an entry without a primary (chantier 3.1). It is the reason the lot exists —
 * today the lock survives a repair only because `describeBindingRepair` writes
 * `locked: true` into the sentence it spells, not because any rule conserves
 * it. A caller who writes its own repair call loses the lock in silence.
 *
 * Everything runs through injected seams: no config file, no desktop.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { confirmWorkspaceBinding } from '../src/tools/workspace-binding.mjs';
import {
  canonicalWorkspaceKey,
  readBinding,
  rawBindingEntry,
  rawEntryDigest,
  WORKSPACE_BINDINGS_KEY,
} from '../src/helpers/workspace-bindings.mjs';
import {
  readBindingWriteContext,
  planBindingWrite,
  describeBindingWriteEffects,
  BINDING_WRITE_MODE,
} from '../src/helpers/binding-write.mjs';

const CWD = process.cwd();
const KEY = canonicalWorkspaceKey(CWD);

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
 * The config ON DISK. It has to list the vaults the registry knows: since
 * round 2 the writer validates every name against the FILE as well as the
 * live catalogue, so a bare `{}` would make every name unbindable — the
 * strictness working, not a fixture to paper over.
 */
function onDisk({ entry, ...rest } = {}) {
  const cfg = {
    portRegistry: { '/v/Notes': 27124, '/v/Work': 27125 },
    remoteVaults: [{ name: 'remote', baseUrl: 'https://r/' }],
    ...rest,
  };
  if (entry !== undefined) cfg[WORKSPACE_BINDINGS_KEY] = { [KEY]: entry };
  return cfg;
}

function seams(config) {
  const written = [];
  return {
    written,
    seam: {
      cwd: CWD,
      readFile: () => JSON.stringify(config),
      writeFile: (p, c) => written.push({ path: p, config: JSON.parse(c) }),
      // Nothing is open, so nothing is pinged into a launch we care about;
      // `launch` records instead of spawning Obsidian.
      ping: async () => ({ online: false, identity: 'unreachable' }),
      launch: (name) => ({ launched: true, uri: `obsidian://open?vault=${name}`, reason: null }),
    },
  };
}

/** The entry as the file holds it after the call — not the repaired reading. */
function storedEntry(written) {
  assert.equal(written.length, 1, 'exactly one config write');
  return written[0].config[WORKSPACE_BINDINGS_KEY][KEY];
}

describe('the write transform — the tiers a re-confirmation carries over', () => {
  test('the tier of a secondary that STAYS survives a re-confirmation', async () => {
    // Adding a secondary is the ordinary reason to call this again, and the
    // first version reset every mode `set_secondary_vault_mode` had recorded.
    const config = onDisk({ entry: { vault: 'notes', also: ['work'], alsoLocked: ['work'], confirmedVia: 'tool' } });
    const { written, seam } = seams(config);
    await confirmWorkspaceBinding(registryOf(), { vault: 'notes', also: ['work', 'remote'] }, seam);
    const stored = storedEntry(written);
    assert.deepEqual(stored.alsoLocked, ['work'], 'the strict tier is not silently lifted');
    assert.deepEqual(stored.also, ['work', 'remote']);
  });

  test('the tier of a secondary that LEAVES is dropped with it', async () => {
    // `keep()` filters to the vaults that are still secondaries after the
    // call: a tier belongs to a role, and a name with no role holds none.
    const config = onDisk({ entry: { vault: 'notes', also: ['work', 'remote'], alsoLocked: ['work'] } });
    const { written, seam } = seams(config);
    await confirmWorkspaceBinding(registryOf(), { vault: 'notes', also: ['remote'] }, seam);
    assert.deepEqual(storedEntry(written).alsoLocked, []);
  });

  test('the tiers of an entry WITHOUT a primary are read from the entry as written', async () => {
    // Round 10, both passes: the repaired reading of such an entry is null,
    // so the first version read no tiers at all and a strict secondary came
    // out of its own repair as SOFT — the restriction lifted by the very call
    // the diagnostic told the user to make.
    const entry = { also: ['work'], alsoLocked: ['work'] };
    const config = onDisk({ entry });
    const { written, seam } = seams(config);
    await confirmWorkspaceBinding(
      registryOf(),
      { vault: 'notes', also: ['work'], ifBindingDigest: rawEntryDigest(entry) },
      seam,
    );
    assert.deepEqual(storedEntry(written).alsoLocked, ['work']);
  });

  test('THE PROPERTY TO PRESERVE: a GLOBAL tier is never frozen into the binding', async () => {
    // `keep()` filters `tierSource` — the local binding, or the raw entry —
    // and NEVER the global `alsoLocked`/`alsoWritable` of the config. Freezing
    // a global tier into the entry would create a LOCAL restriction that
    // outlived the deletion of the global rule. The effective tier is computed
    // at read time from both; only the local data is written.
    const config = onDisk({
      entry: { vault: 'notes', also: ['work'] },
      alsoLocked: ['work'],
    });
    const { written, seam } = seams(config);
    await confirmWorkspaceBinding(registryOf(), { vault: 'notes', also: ['work'] }, seam);
    const stored = storedEntry(written);
    assert.deepEqual(stored.alsoLocked, [], 'the global list stays global');
    assert.deepEqual(stored.alsoWritable, []);
  });

  test('a field this version does not know survives the write', async () => {
    const config = onDisk({ entry: { vault: 'notes', also: [], futureField: { keep: 1 } } });
    const { written, seam } = seams(config);
    await confirmWorkspaceBinding(registryOf(), { vault: 'notes', also: ['work'] }, seam);
    assert.deepEqual(storedEntry(written).futureField, { keep: 1 });
  });
});

describe('the write transform, asked directly — what the pure function decides', () => {
  // THESE WITNESSES EXIST BECAUSE A MUTATION SURVIVED THE ONES ABOVE. Driving
  // the transform through the tool cannot separate what `keep()` decides from
  // what `normalizeBinding` decides afterwards: both drop a tier whose vault
  // is no longer a secondary, so removing the filter from `keep()` changed
  // nothing observable on disk. A second, redundant guard is worth having —
  // but a test that cannot tell which of the two is doing the work is not a
  // test of either. Asked of the function itself.
  const ctxFor = (entry) => readBindingWriteContext(onDisk({ entry }), CWD);

  test('keep() filters the tiers to the secondaries that REMAIN', () => {
    const ctx = ctxFor({ vault: 'notes', also: ['work', 'remote'], alsoLocked: ['work'], alsoWritable: ['remote'] });
    const plan = planBindingWrite(ctx, {
      mode: BINDING_WRITE_MODE.REPLACE, primary: 'notes', also: ['remote'], confirmedVia: 'tool',
    });
    assert.deepEqual(plan.entry.alsoLocked, [], 'a tier belongs to a role; no role, no tier');
    assert.deepEqual(plan.entry.alsoWritable, ['remote']);
  });

  test('repair mode keeps the entry\'s secondaries when the call names none', () => {
    const ctx = ctxFor({ also: ['work', 'remote'], alsoLocked: ['work'] });
    const plan = planBindingWrite(ctx, {
      mode: BINDING_WRITE_MODE.REPAIR, primary: 'notes', also: [], confirmedVia: 'repair-binding',
    });
    assert.deepEqual(plan.entry.also, ['work', 'remote']);
    assert.deepEqual(plan.entry.alsoLocked, ['work']);
    assert.deepEqual(plan.droppedSecondaries, []);
  });

  test('replace mode drops what the call did not name, and SAYS which', () => {
    const ctx = ctxFor({ vault: 'notes', also: ['work', 'remote'] });
    const plan = planBindingWrite(ctx, {
      mode: BINDING_WRITE_MODE.REPLACE, primary: 'notes', also: ['remote'], confirmedVia: 'tool',
    });
    assert.deepEqual(plan.droppedSecondaries, ['work']);
    assert.deepEqual(plan.keptFromEntry, ['remote']);
  });

  test('THE TWO MODES DIVERGE ON THE LOCK, and that is why repair is a mode', () => {
    // Found by review. Giving repair the replace rule cost the lot's own
    // promise one case over from the one it fixed: an entry whose primary the
    // config no longer binds reads back FINE through `normalizeBinding`, so
    // `source.vault !== primary` held, and the repair dropped the lock in
    // silence. Replace must keep the old rule; repair must keep the lock.
    const ctx = ctxFor({ vault: 'ghost', also: ['work'], locked: true });
    const repaired = planBindingWrite(ctx, {
      mode: BINDING_WRITE_MODE.REPAIR, primary: 'notes', also: [], confirmedVia: 'repair-binding',
    });
    assert.equal(repaired.entry.locked, true, 'a repair keeps the lock across a change of primary');
    assert.equal(repaired.lockMovesTo, 'notes', 'and names where keeping it put it');

    const replaced = planBindingWrite(ctx, {
      mode: BINDING_WRITE_MODE.REPLACE, primary: 'notes', also: [], confirmedVia: 'tool',
    });
    assert.equal(replaced.entry.locked, false,
      'a replacement still does NOT lock a new primary nobody asked to lock');
    assert.equal(replaced.lockMovesTo, null);
  });

  test('an explicit `locked` beats the mode, in both modes', () => {
    const ctx = ctxFor({ vault: 'ghost', also: ['work'], locked: true });
    for (const mode of [BINDING_WRITE_MODE.REPAIR, BINDING_WRITE_MODE.REPLACE]) {
      const p = planBindingWrite(ctx, { mode, primary: 'notes', also: [], locked: false, confirmedVia: 'x' });
      assert.equal(p.entry.locked, false, `${mode}: an explicit false unlocks`);
      assert.equal(p.lockMovesTo, null, `${mode}: nothing moved, so nothing is announced`);
    }
  });

  test('a vault named as the new primary stops being a secondary of itself', () => {
    const ctx = ctxFor({ vault: 'notes', also: ['work'] });
    const plan = planBindingWrite(ctx, {
      mode: BINDING_WRITE_MODE.REPAIR, primary: 'work', also: [], confirmedVia: 'repair-binding',
    });
    assert.deepEqual(plan.entry.also, []);
  });

  test('a SECONDARY made primary is reported as a promotion, tier included', () => {
    // Found by review round 3. `droppedSecondaries` cannot report this and
    // should not: "dropped" means "no longer declared", and the vault is very
    // much still declared — as the primary. But it DOES leave `also`, and its
    // local tier leaves with it, so a façade promising to drop no secondary
    // and no tier was saying something false.
    const ctx = ctxFor({ vault: 'notes', also: ['work'], alsoWritable: ['work'] });
    const plan = planBindingWrite(ctx, {
      mode: BINDING_WRITE_MODE.REPAIR, primary: 'work', also: [], confirmedVia: 'repair-binding',
    });
    assert.deepEqual(plan.promoted, { vault: 'work', tier: 'writable' });
    assert.deepEqual(plan.droppedSecondaries, [], 'and it is NOT counted twice as a drop');
    assert.deepEqual(plan.entry.alsoWritable, []);
    const [said] = describeBindingWriteEffects(plan, (s) => s);
    assert.match(said, /was a SECONDARY of this workspace and is now its PRIMARY/);
    assert.match(said, /writable tier RECORDED ON THIS BINDING leaves with it/);
  });

  test('a soft secondary promoted is reported too — the tier name is not only for the declared ones', () => {
    const ctx = ctxFor({ vault: 'notes', also: ['work'] });
    const plan = planBindingWrite(ctx, {
      mode: BINDING_WRITE_MODE.REPAIR, primary: 'work', also: [], confirmedVia: 'repair-binding',
    });
    assert.deepEqual(plan.promoted, { vault: 'work', tier: 'soft' });
  });

  test('binding a vault that was never a secondary is not a promotion', () => {
    const ctx = ctxFor({ vault: 'notes', also: [] });
    const plan = planBindingWrite(ctx, {
      mode: BINDING_WRITE_MODE.REPLACE, primary: 'work', also: [], confirmedVia: 'tool',
    });
    assert.equal(plan.promoted, null);
  });

  test('`confirmedAt` is ABSENT or usable — never silently degraded to the clock', () => {
    // The MCP tool passes none, and that is a real choice: it has no preview
    // to agree with, so `withBinding` stamping today is right for it. An empty
    // or malformed value is NOT a choice, and treating it as absence let a
    // sealed plan name a date the write did not use. (Codex, round 8.)
    const ctx = ctxFor({ vault: 'notes', also: [] });
    const base = { mode: BINDING_WRITE_MODE.REPAIR, primary: 'notes', also: [], confirmedVia: 'x' };
    assert.equal(Object.hasOwn(planBindingWrite(ctx, base).entry, 'confirmedAt'), false,
      'omitted stays omitted, so the tool keeps its behaviour');
    assert.equal(planBindingWrite(ctx, { ...base, confirmedAt: '2026-01-02' }).entry.confirmedAt, '2026-01-02');
    for (const bad of ['', '2026-1-2', 'yesterday', null, 7]) {
      assert.throws(() => planBindingWrite(ctx, { ...base, confirmedAt: bad }), /YYYY-MM-DD/,
        `confirmedAt=${JSON.stringify(bad)} must be refused`);
    }
  });

  test('an unknown mode is refused rather than silently treated as one of the two', () => {
    assert.throws(
      () => planBindingWrite(ctxFor({ vault: 'notes', also: [] }), { mode: 'repare', primary: 'notes' }),
      /unknown mode/,
    );
  });
});

describe('the write transform — how `locked` is derived', () => {
  test('an explicit `locked: true` locks; an explicit `false` unlocks', async () => {
    const config = onDisk({ entry: { vault: 'notes', also: [], locked: true } });
    const { written, seam } = seams(config);
    await confirmWorkspaceBinding(registryOf(), { vault: 'notes', locked: false }, seam);
    assert.equal(storedEntry(written).locked, false);

    const c2 = onDisk({ entry: { vault: 'notes', also: [] } });
    const s2 = seams(c2);
    await confirmWorkspaceBinding(registryOf(), { vault: 'notes', locked: true }, s2.seam);
    assert.equal(storedEntry(s2.written).locked, true);
  });

  test('ABSENT keeps the lock the entry already records for the SAME primary', async () => {
    // Round 2: `args.locked === true` meant that re-confirming a locked
    // workspace without mentioning the lock — the ordinary way of adding an
    // `also` — silently unlocked it on disk while the live guard stayed locked.
    const config = onDisk({ entry: { vault: 'notes', also: [], locked: true } });
    const { written, seam } = seams(config);
    await confirmWorkspaceBinding(registryOf(), { vault: 'notes', also: ['work'] }, seam);
    assert.equal(storedEntry(written).locked, true);
  });

  test('ABSENT does NOT carry a lock onto a DIFFERENT primary', async () => {
    // A lock belongs to the vault it names. Re-pointing the workspace
    // elsewhere without saying `locked` does not lock the new primary.
    const config = onDisk({ entry: { vault: 'notes', also: [], locked: true } });
    const { written, seam } = seams(config);
    await confirmWorkspaceBinding(registryOf(), { vault: 'work' }, seam);
    assert.equal(storedEntry(written).locked, false);
  });

  test('RED BEFORE THE LOT: the lock of an entry without a primary survives its repair', async () => {
    // THE REASON THIS LOT EXISTS. `locked` was derived from `previous` — the
    // REPAIRED reading — which is null for an entry that names no primary, so
    // the repair of such an entry dropped its lock. It did not drop it in
    // practice only because `describeBindingRepair` reads the RAW entry and
    // writes `locked: true` into the call it spells: the guarantee lived in a
    // SENTENCE, not in the code. Anyone writing their own repair call lost it.
    //
    // The tiers were given their `?? raw` in round 10; the lock never had one.
    const entry = { also: ['work'], alsoLocked: ['work'], locked: true };
    const config = onDisk({ entry });
    const { written, seam } = seams(config);
    await confirmWorkspaceBinding(
      registryOf(),
      { vault: 'notes', also: ['work'], ifBindingDigest: rawEntryDigest(entry) },
      seam,
    );
    assert.equal(storedEntry(written).locked, true,
      'a repair keeps what the entry held — the lock included');
  });

  test('an entry without a primary and WITHOUT a lock is not locked by its repair', async () => {
    // The other half of the pair: `?? raw` conserves, it does not invent.
    const entry = { also: ['work'], alsoLocked: ['work'] };
    const config = onDisk({ entry });
    const { written, seam } = seams(config);
    await confirmWorkspaceBinding(
      registryOf(),
      { vault: 'notes', also: ['work'], ifBindingDigest: rawEntryDigest(entry) },
      seam,
    );
    assert.equal(storedEntry(written).locked, false);
  });

  test('an explicit `locked: false` still wins over a lock the raw entry holds', async () => {
    const entry = { also: ['work'], locked: true };
    const config = onDisk({ entry });
    const { written, seam } = seams(config);
    await confirmWorkspaceBinding(
      registryOf(),
      { vault: 'notes', also: ['work'], locked: false, ifBindingDigest: rawEntryDigest(entry) },
      seam,
    );
    assert.equal(storedEntry(written).locked, false);
  });
});

describe('the write transform — the consequences the answer must state', () => {
  test('the tool SAYS the lock moved, and hands back where it landed', async () => {
    // Keeping `locked: true` while choosing a primary does not keep the lock
    // where it was — it points it at another vault, and every other vault
    // stops answering. Reporting a carried boolean would let the reader
    // believe nothing moved. (Decision of 2026-09-20: "ce déplacement
    // s'annonce".)
    const entry = { also: ['work'], locked: true };
    const { seam } = seams(onDisk({ entry }));
    const res = await confirmWorkspaceBinding(
      registryOf(),
      { vault: 'notes', also: ['work'], ifBindingDigest: rawEntryDigest(entry) },
      seam,
    );
    assert.equal(res.lockMovedTo, 'notes');
    assert.match(res.message, /keeping it MOVES it/);
  });

  test('the tool SAYS what a replacement dropped, and that dropping can PERMIT a write', () => {
    // The counter-intuitive fact the decision page records: `alsoWriteTierFor`
    // returns null the moment a name leaves `also` — BEFORE it consults the
    // global lists — and `assertVaultWritable` lets a null tier write. A vault
    // held as strict read-only, dropped here but still reachable another way,
    // comes out WRITABLE. "Access reduced" would be the wrong sentence.
    const config = onDisk({ entry: { vault: 'notes', also: ['work', 'remote'], alsoLocked: ['work'] } });
    const { seam } = seams(config);
    return confirmWorkspaceBinding(registryOf(), { vault: 'notes', also: ['remote'] }, seam).then((res) => {
      assert.deepEqual(res.droppedSecondaries, ['work']);
      assert.match(res.message, /becomes WRITABLE/);
    });
  });

  test('an ordinary confirmation that drops nothing says neither thing', () => {
    // A sentence that fires on every call is noise, and noise is how a real
    // warning stops being read.
    const { seam } = seams(onDisk({ entry: { vault: 'notes', also: ['work'] } }));
    return confirmWorkspaceBinding(registryOf(), { vault: 'notes', also: ['work'] }, seam).then((res) => {
      assert.deepEqual(res.droppedSecondaries, []);
      assert.equal(res.lockMovedTo, null);
      assert.doesNotMatch(res.message, /becomes WRITABLE/);
      assert.doesNotMatch(res.message, /keeping it MOVES it/);
    });
  });
});

describe('the write transform — the order of its guards', () => {
  test('the DIGEST is asked before the names are judged', async () => {
    // Round 14 put `assertBindable` before the digest, so a repair gone stale
    // (a sibling dropped a secondary this call was merely keeping) was refused
    // as "not a registered vault … register it first" — advice for a problem
    // the caller did not have. The digest would have said so one statement
    // later.
    const entry = { vault: 'notes', also: ['work'] };
    const config = onDisk({ entry });
    const { written, seam } = seams(config);
    await assert.rejects(
      () => confirmWorkspaceBinding(
        registryOf(),
        { vault: 'notes', also: ['ghost'], ifBindingDigest: rawEntryDigest({ vault: 'other' }) },
        seam,
      ),
      (e) => {
        assert.match(e.message, /binding entry now differs/);
        assert.doesNotMatch(e.message, /not a registered vault/);
        return true;
      },
    );
    assert.equal(written.length, 0);
  });

  test('the PROMOTION guard reads the raw tiers when the repaired reading is null', async () => {
    // Round 11: round 10 made the tiers of a primary-less entry survive the
    // repair, and left this guard reading `previous` — null for that very
    // entry. So the repair call could name a STRICT secondary as the new
    // primary, and the hard tier was lifted by the call the diagnostic spelled.
    const entry = { also: ['work'], alsoLocked: ['work'] };
    const config = onDisk({ entry });
    const { written, seam } = seams(config);
    await assert.rejects(
      () => confirmWorkspaceBinding(
        registryOf(),
        { vault: 'work', ifBindingDigest: rawEntryDigest(entry) },
        seam,
      ),
      /alsoLocked SECONDARY/,
    );
    assert.equal(written.length, 0);
  });

  test('a GLOBAL strict tier refuses the promotion too', async () => {
    const entry = { vault: 'notes', also: ['work'] };
    const config = onDisk({ entry, alsoLocked: ['work'] });
    const { written, seam } = seams(config);
    await assert.rejects(
      () => confirmWorkspaceBinding(registryOf(), { vault: 'work' }, seam),
      /alsoLocked SECONDARY/,
    );
    assert.equal(written.length, 0);
  });

  test('a secondary the ENTRY already holds is kept even when this session cannot resolve it', async () => {
    // Round 13, S3: what is in the entry as written stays allowed in the call;
    // this session simply cannot reach it. The PRIMARY is never exempt.
    const entry = { vault: 'notes', also: ['elsewhere'] };
    const config = onDisk({ entry });
    const { written, seam } = seams(config);
    const r = await confirmWorkspaceBinding(
      registryOf(),
      { vault: 'notes', also: ['elsewhere'], ifBindingDigest: rawEntryDigest(entry) },
      seam,
    );
    assert.deepEqual(storedEntry(written).also, ['elsewhere']);
    assert.deepEqual(r.notLoadedHere, ['elsewhere']);
  });

  test('an unregistered PRIMARY is refused even when the entry names it', async () => {
    const entry = { vault: 'elsewhere', also: [] };
    const config = onDisk({ entry });
    const { written, seam } = seams(config);
    await assert.rejects(
      () => confirmWorkspaceBinding(
        registryOf(),
        { vault: 'elsewhere', ifBindingDigest: rawEntryDigest(entry) },
        seam,
      ),
      /not a registered vault/,
    );
    assert.equal(written.length, 0);
  });
});

describe('the write transform — what the repaired reading says afterwards', () => {
  test('the entry written for a repair reads back as the binding that was asked for', async () => {
    const entry = { also: ['work'], alsoLocked: ['work'], locked: true, futureField: 7 };
    const config = onDisk({ entry });
    const { written, seam } = seams(config);
    await confirmWorkspaceBinding(
      registryOf(),
      { vault: 'notes', also: ['work'], ifBindingDigest: rawEntryDigest(entry) },
      seam,
    );
    const after = written[0].config;
    const binding = readBinding(after, CWD);
    assert.equal(binding.vault, 'notes');
    assert.deepEqual(binding.also, ['work']);
    assert.deepEqual(binding.alsoLocked, ['work']);
    assert.equal(binding.locked, true);
    assert.equal(rawBindingEntry(after, CWD).futureField, 7);
  });
});
