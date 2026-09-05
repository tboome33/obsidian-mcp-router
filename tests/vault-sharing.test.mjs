/**
 * THE SHARED-VAULT PRECONDITION, IN ISOLATION.
 *
 * Phase 4 of `portee-ergonomie-refus-roadmap` (decision
 * `ergonomie-creation-liaison-vaults`, point 6): a vault SEVERAL workspaces
 * declare requires `ifMatch` (or `ifNew`) on every write, computed from the
 * binding registry rather than declared.
 *
 * This file proves the four pure pieces — who declares a vault, whether that
 * makes it shared, what a call brings, and the refusal — plus the freshness
 * reader. That the DISPATCHER actually calls them is a different claim, proven
 * end to end in `tests/shared-vault-precondition-e2e.test.mjs`: every
 * assertion here stays green if the gate is never wired in, which is exactly
 * the gap a private-function suite always has.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  workspacesDeclaring,
  sharingRequirement,
  preconditionState,
  assertSharedVaultPrecondition,
  createBindingsReader,
  SHARING_REASONS,
  IF_MATCH_EXEMPT,
} from '../src/helpers/vault-sharing.mjs';
import { _internals } from '../src/index.mjs';

const cfg = (bindings) => ({ workspaceBindings: bindings });

describe('workspacesDeclaring — the count that decides, read from the binding registry', () => {
  test('a vault counts a workspace whether it is the PRIMARY or a secondary', () => {
    const config = cfg({
      'i:\\a': { vault: 'ref', also: [] },
      'i:\\b': { vault: 'work', also: ['ref'] },
      'i:\\c': { vault: 'other', also: ['elsewhere'] },
    });
    assert.deepEqual(workspacesDeclaring('ref', config), ['i:\\a', 'i:\\b']);
    assert.deepEqual(workspacesDeclaring('work', config), ['i:\\b']);
    assert.deepEqual(workspacesDeclaring('nobody', config), []);
  });

  test('ONE directory under two spellings is ONE workspace — a false positive here is undiagnosable', () => {
    // A hand-edited config can hold the same directory twice; `readBinding`
    // already canonicalises both sides before comparing, and so must the
    // counter, or a vault only one project uses acquires a requirement meant
    // for shared ones and the message names two workspaces that are one.
    const config = cfg({
      'I:\\Work\\Repo\\': { vault: 'ref', also: [] },
      'i:/work/repo': { vault: 'ref', also: [] },
    });
    assert.equal(workspacesDeclaring('ref', config).length, 1);
  });

  test('a malformed binding is not a workspace, and neither is an unusable key', () => {
    const config = cfg({
      'i:\\a': { vault: 'ref' },
      'i:\\b': { also: ['ref'] },        // no primary → normalizeBinding rejects it
      'i:\\c': 'ref',                     // not an object
      'i:\\d': { vault: '   ', also: ['ref'] },
      '': { vault: 'ref' },               // key that cannot canonicalise
    });
    assert.deepEqual(workspacesDeclaring('ref', config), ['i:\\a']);
  });

  test('no config, an empty one, or a hand-broken workspaceBindings all mean "nothing declared"', () => {
    for (const bad of [null, undefined, {}, cfg(null), cfg([]), cfg('nope')]) {
      assert.deepEqual(workspacesDeclaring('ref', bad), []);
    }
  });

  test('the answer is SORTED, so the refusal message does not depend on JSON key order', () => {
    const a = workspacesDeclaring('ref', cfg({ 'i:\\z': { vault: 'ref' }, 'i:\\a': { vault: 'ref' } }));
    const b = workspacesDeclaring('ref', cfg({ 'i:\\a': { vault: 'ref' }, 'i:\\z': { vault: 'ref' } }));
    assert.deepEqual(a, b);
    assert.deepEqual(a, ['i:\\a', 'i:\\z']);
  });
});

describe('sharingRequirement — one workspace writes freely, two do not', () => {
  const reg = (openVaults = []) => ({ openVaults });

  test('a vault ONE workspace declares requires nothing — no behaviour change, which is the decision\'s condition', () => {
    const r = sharingRequirement('ref', reg(), cfg({ 'i:\\a': { vault: 'ref' } }));
    assert.equal(r.required, false);
    assert.equal(r.reason, null);
  });

  test('two workspaces make it required, and the reason names them', () => {
    const r = sharingRequirement('ref', reg(), cfg({ 'i:\\a': { vault: 'ref' }, 'i:\\b': { vault: 'w', also: ['ref'] } }));
    assert.equal(r.required, true);
    assert.equal(r.reason, SHARING_REASONS.MULTI_WORKSPACE);
    assert.deepEqual(r.workspaces, ['i:\\a', 'i:\\b']);
  });

  test('an openVaults vault is required BY HYPOTHESIS, even with zero declared workspaces', () => {
    // The count cannot see it: such a vault is reachable everywhere without
    // being declared anywhere, so the registry legitimately counts zero. The
    // decision names the answer — its readership is not knowable.
    const r = sharingRequirement('roland', reg(['roland']), cfg({}));
    assert.equal(r.required, true);
    assert.equal(r.reason, SHARING_REASONS.OPEN_VAULT);
  });

  test('with NO readable config, openVaults still answers and the multi-workspace half cannot', () => {
    assert.equal(sharingRequirement('roland', reg(['roland']), null).required, true);
    assert.equal(sharingRequirement('ref', reg(['roland']), null).required, false);
  });
});

describe('preconditionState — what a call brings to the table', () => {
  const CARRIES = { ifMatch: 'a'.repeat(64) };

  test('the seven per-file write tools: ifMatch present is carried, absent is missing', () => {
    for (const t of ['write_file', 'append_to_file', 'patch_file', 'set_frontmatter', 'merge_frontmatter', 'move_file', 'delete_file']) {
      assert.equal(preconditionState(t, CARRIES), 'carried', t);
      assert.equal(preconditionState(t, { path: 'x.md' }), 'missing', t);
      assert.equal(preconditionState(t, { ifMatch: '' }), 'missing', `${t} — an empty string names nothing`);
      assert.equal(preconditionState(t, { ifMatch: 12 }), 'missing', `${t} — a non-string is not a precondition`);
    }
  });

  test('write_file: ifNew is a precondition too — creating a note on a shared vault must stay possible', () => {
    // `ifNew: true` sends Apply-If-Content-Preexists: false, so the server
    // 409s if the file exists: a compare-and-swap against ABSENCE. Without
    // this, a shared vault could never receive a new note at all, since there
    // is no hash to pin for a file that does not exist yet.
    assert.equal(preconditionState('write_file', { ifNew: true }), 'carried');
    assert.equal(preconditionState('write_file', { ifNew: false }), 'missing');
    // Only write_file has it; the others must not be let through by it.
    assert.equal(preconditionState('append_to_file', { ifNew: true }), 'missing');
  });

  test('every exempt tool is not-applicable, whatever the arguments', () => {
    for (const t of IF_MATCH_EXEMPT.keys()) {
      assert.equal(preconditionState(t, {}), 'not-applicable', t);
      assert.equal(preconditionState(t, CARRIES), 'not-applicable', t);
    }
  });

  test('execute_template: a render is not-applicable, a createFile write is ALWAYS missing', () => {
    assert.equal(preconditionState('execute_template', { name: 't.md' }), 'not-applicable');
    assert.equal(preconditionState('execute_template', { createFile: true, targetPath: 'x.md' }), 'missing');
    // It declares no ifMatch, so passing one must not buy a way through: the
    // bridge would ignore it and the write would land unguarded.
    assert.equal(preconditionState('execute_template', { createFile: true, ...CARRIES }), 'missing');
  });

  describe('write_bundle — per step, because the bundle IS the other write tools', () => {
    const step = (extra = {}) => ({ op: 'write', path: 'a.md', content: 'x', ...extra });

    test('every step guarded is carried; ONE unguarded step makes the whole bundle missing', () => {
      assert.equal(preconditionState('write_bundle', { steps: [step(CARRIES), step({ ifNew: true })] }), 'carried');
      assert.equal(preconditionState('write_bundle', { steps: [step(CARRIES), step()] }), 'missing');
      assert.equal(preconditionState('write_bundle', { steps: [step()] }), 'missing');
    });

    test('ifNew counts only on a WRITE step — an append or a delete cannot be guarded by absence', () => {
      assert.equal(preconditionState('write_bundle', { steps: [{ op: 'append', path: 'a.md', ifNew: true }] }), 'missing');
      assert.equal(preconditionState('write_bundle', { steps: [{ op: 'delete', path: 'a.md', ifNew: true }] }), 'missing');
      assert.equal(preconditionState('write_bundle', { steps: [{ op: 'delete', path: 'a.md', ...CARRIES }] }), 'carried');
    });

    test('a RECOVERY RUN is not-applicable — it has its own, stronger guard', () => {
      // A recovery replays a journal and never restores over a file somebody
      // else changed; it applies no steps at all. Named explicitly, because
      // falling through the step loop would call "no steps" satisfied — a hole
      // that reads like a rule.
      assert.equal(preconditionState('write_bundle', { recover: 'op-123', confirm: true }), 'not-applicable');
    });

    test('a bundle with no steps writes nothing, so there is nothing to satisfy', () => {
      assert.equal(preconditionState('write_bundle', { steps: [] }), 'not-applicable');
      assert.equal(preconditionState('write_bundle', {}), 'not-applicable');
    });

    test('a malformed step is not a guarded one', () => {
      assert.equal(preconditionState('write_bundle', { steps: [null] }), 'missing');
      assert.equal(preconditionState('write_bundle', { steps: ['a.md'] }), 'missing');
    });
  });
});

describe('assertSharedVaultPrecondition — the refusal, and everything it must NOT refuse', () => {
  const shared = cfg({ 'i:\\a': { vault: 'ref' }, 'i:\\b': { vault: 'w', also: ['ref'] } });
  const reg = { openVaults: [] };
  const V = { name: 'ref' };

  test('a missing precondition on a shared vault is refused, and the message is actionable', () => {
    assert.throws(
      () => assertSharedVaultPrecondition(V, reg, 'write_file', { path: 'a.md' }, shared),
      (err) => {
        assert.match(err.message, /vault "ref" is SHARED/);
        assert.match(err.message, /2 workspaces declare it/, 'says how many');
        assert.match(err.message, /i:\\a/, 'names them, so the user can check');
        assert.match(err.message, /`ifMatch`/, 'names the argument that satisfies it');
        assert.match(err.message, /`ifNew: true`/, 'and the one for a new file');
        assert.match(err.message, /Honest limit/, 'the decision requires the limit to travel WITH the mechanism');
        return true;
      },
    );
  });

  test('the same call with a precondition passes, and so does any call on an unshared vault', () => {
    assert.doesNotThrow(() => assertSharedVaultPrecondition(V, reg, 'write_file', { ifMatch: 'a'.repeat(64) }, shared));
    assert.doesNotThrow(() => assertSharedVaultPrecondition(V, reg, 'write_file', { ifNew: true }, shared));
    const alone = cfg({ 'i:\\a': { vault: 'ref' } });
    assert.doesNotThrow(() => assertSharedVaultPrecondition(V, reg, 'write_file', { path: 'a.md' }, alone));
  });

  test('an openVaults vault refuses with its OWN reason — not a workspace count it does not have', () => {
    assert.throws(
      () => assertSharedVaultPrecondition({ name: 'roland' }, { openVaults: ['roland'] }, 'append_to_file', {}, cfg({})),
      /listed in `openVaults`/,
    );
  });

  test('an exempt tool is never refused, even on a shared vault', () => {
    for (const t of IF_MATCH_EXEMPT.keys()) {
      assert.doesNotThrow(() => assertSharedVaultPrecondition(V, reg, t, {}, shared), t);
    }
  });

  test('execute_template is refused with the way THROUGH, not just a "no"', () => {
    assert.throws(
      () => assertSharedVaultPrecondition(V, reg, 'execute_template', { createFile: true, targetPath: 'x.md' }, shared),
      /WITHOUT `createFile`.*write_file/s,
    );
  });

  test('move_file\'s refusal says its precondition guards the SOURCE — a half-understood guard is worse than none', () => {
    assert.throws(
      () => assertSharedVaultPrecondition(V, reg, 'move_file', { from: 'a.md', to: 'b.md' }, shared),
      /guards the source/,
    );
  });
});

describe('createBindingsReader — fresh enough for "the instant the second workspace declares it"', () => {
  function fakeFs(initial) {
    const state = { content: initial, mtimeMs: 1, size: initial.length, reads: 0, fail: null, statFail: null };
    const reader = createBindingsReader({
      configPath: '/cfg/config.json',
      readFile: () => { state.reads += 1; if (state.fail) throw new Error(state.fail); return state.content; },
      statFile: () => { if (state.statFail) throw new Error(state.statFail); return { mtimeMs: state.mtimeMs, size: state.size }; },
    });
    state.set = (content) => { state.content = content; state.mtimeMs += 1; state.size = content.length; };
    return { state, reader };
  }

  const ONE = JSON.stringify({ workspaceBindings: { 'i:\\a': { vault: 'ref' } } });
  const TWO = JSON.stringify({ workspaceBindings: { 'i:\\a': { vault: 'ref' }, 'i:\\b': { vault: 'ref' } } });

  test('it parses the file, and does NOT re-parse while mtime and size are unchanged', () => {
    const { state, reader } = fakeFs(ONE);
    assert.equal(workspacesDeclaring('ref', reader.current()).length, 1);
    reader.current(); reader.current();
    assert.equal(state.reads, 1, 'the stat guard is what keeps this cheap enough for every write');
  });

  test('a CHANGED file is picked up on the very next call — no restart, item 19 of the roadmap', () => {
    const { state, reader } = fakeFs(ONE);
    assert.equal(workspacesDeclaring('ref', reader.current()).length, 1);
    state.set(TWO);
    assert.equal(workspacesDeclaring('ref', reader.current()).length, 2);
    assert.equal(state.reads, 2);
  });

  test('a size change with the SAME mtime is still picked up', () => {
    // Coarse filesystem timestamps, or two atomic renames inside one
    // millisecond, can leave mtimeMs equal while the content differs.
    const { state, reader } = fakeFs(ONE);
    reader.current();
    state.content = TWO;
    state.size = TWO.length; // mtime deliberately NOT advanced
    assert.equal(workspacesDeclaring('ref', reader.current()).length, 2);
  });

  test('an unreadable or unparsable file keeps the LAST GOOD copy — a guard that fails open at the first hiccup is not a guard', () => {
    const { state, reader } = fakeFs(TWO);
    assert.equal(workspacesDeclaring('ref', reader.current()).length, 2);

    state.set('{ this is not json');
    assert.equal(workspacesDeclaring('ref', reader.current()).length, 2, 'a half-written file must not lift the requirement');

    state.set(ONE);
    state.fail = 'EBUSY';
    assert.equal(workspacesDeclaring('ref', reader.current()).length, 2, 'nor must a transient read error');

    state.statFail = 'EPERM';
    assert.equal(workspacesDeclaring('ref', reader.current()).length, 2, 'nor a failing stat');
  });

  test('a config that parses to a non-object is not adopted', () => {
    const { state, reader } = fakeFs(TWO);
    reader.current();
    state.set('[]');
    assert.equal(workspacesDeclaring('ref', reader.current()).length, 2);
  });

  test('with no good copy ever, it answers null rather than an empty config', () => {
    const { state, reader } = fakeFs('nope');
    state.fail = 'ENOENT';
    assert.equal(reader.current(), null);
    // And null is the documented degraded mode: openVaults still answers.
    assert.equal(sharingRequirement('roland', { openVaults: ['roland'] }, null).required, true);
  });

  test('no configPath at all is a no-op reader, not a crash', () => {
    assert.equal(createBindingsReader({}).current(), null);
  });
});

describe('THE PARTITION — no write tool can be silently ungated', () => {
  // The rule this repository keeps re-learning: a classification that is not
  // asserted TOTAL is a list that goes stale the first time somebody adds a
  // member. Three buckets, and every member of WRITE_TOOL_NAMES must be in
  // exactly one.
  const SATISFIABLE = new Set([
    'write_file', 'append_to_file', 'patch_file', 'set_frontmatter',
    'merge_frontmatter', 'move_file', 'delete_file', 'write_bundle',
  ]);
  /** Covered, and deliberately impossible to satisfy — it has a documented way through. */
  const NEVER_SATISFIABLE = new Set(['execute_template']);

  test('every write tool is exempt, satisfiable, or knowingly unsatisfiable — exactly one of the three', () => {
    const all = [..._internals.WRITE_TOOL_NAMES];
    const unclassified = all.filter(
      (n) => !IF_MATCH_EXEMPT.has(n) && !SATISFIABLE.has(n) && !NEVER_SATISFIABLE.has(n),
    );
    assert.deepEqual(
      unclassified, [],
      'a write tool exists that the shared-vault gate neither covers nor exempts. Classify it: '
      + 'add it to IF_MATCH_EXEMPT with a reason, or to SATISFIABLE here once it declares ifMatch.',
    );
    const overlap = all.filter(
      (n) => [IF_MATCH_EXEMPT.has(n), SATISFIABLE.has(n), NEVER_SATISFIABLE.has(n)].filter(Boolean).length > 1,
    );
    assert.deepEqual(overlap, [], 'a write tool is in two buckets — pick one');
  });

  test('the classification names real tools, and only real tools', () => {
    const all = new Set(_internals.WRITE_TOOL_NAMES);
    const ghosts = [...IF_MATCH_EXEMPT.keys(), ...SATISFIABLE, ...NEVER_SATISFIABLE].filter((n) => !all.has(n));
    assert.deepEqual(ghosts, [], 'the classification mentions tools that are not write tools');
  });

  test('every exemption carries a written reason', () => {
    const mute = [...IF_MATCH_EXEMPT.entries()].filter(([, why]) => !why || why.trim().length < 40);
    assert.deepEqual(mute.map(([n]) => n), [], 'an exemption without a reason is a coverage gap with a nicer name');
  });

  test('every SATISFIABLE tool really can be satisfied — or the gate bricks it on every shared vault', () => {
    const sample = {
      write_bundle: { steps: [{ op: 'write', path: 'a.md', ifMatch: 'a'.repeat(64) }] },
    };
    for (const name of SATISFIABLE) {
      const args = sample[name] || { ifMatch: 'a'.repeat(64) };
      assert.equal(preconditionState(name, args), 'carried', `${name} cannot be satisfied at all`);
    }
  });

  test('every SATISFIABLE tool DECLARES the argument the gate demands — a hint naming a field the schema lacks is a dead end', () => {
    // The gate's whole promise is "pass ifMatch and it goes through". If the
    // tool's own inputSchema does not declare it, `additionalProperties: false`
    // is a lie at runtime but the caller has no way to discover the field —
    // and the refusal message points at nothing.
    const byName = new Map(_internals.TOOLS.map((t) => [t.name, t]));
    for (const name of SATISFIABLE) {
      const props = byName.get(name)?.inputSchema?.properties || {};
      const declares = name === 'write_bundle'
        ? Boolean(props.steps?.items?.properties?.ifMatch)
        : Boolean(props.ifMatch);
      assert.ok(declares, `${name} does not declare ifMatch in its own schema`);
    }
  });
});
