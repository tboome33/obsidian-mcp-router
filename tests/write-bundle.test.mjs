/**
 * C2 — unit tests for the PURE rules of the journaled write bundle
 * (src/helpers/write-bundle.mjs): step validation, plan derivation for the C3
 * seal, the journal shape, and above all the rollback decision table, which is
 * the one place that decides "may this rollback write here?".
 *
 * The orchestration (backups, journal I/O, apply, undo) is covered end-to-end in
 * write-bundle-integration.test.mjs.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUNDLE_JOURNAL_DIR,
  BundleError,
  JOURNAL_VERSION,
  MAX_STEPS,
  STEP_OPS,
  backupBytes,
  buildBundlePlan,
  buildJournal,
  canonicalVaultPath,
  derivePostImage,
  isCleanRollback,
  isJournalPath,
  isOperationId,
  isVerifiedRollback,
  journalPathFor,
  newOperationId,
  outcomeMessage,
  parseJournal,
  planRestore,
  uniquePaths,
  validateSteps,
} from '../src/helpers/write-bundle.mjs';
import { contentSha256 } from '../src/helpers/content-hash.mjs';
import { computePlanSeal } from '../src/helpers/plan-seal.mjs';
import { classifyError } from '../src/error-classify.mjs';

const sha = (s) => contentSha256(s);

// ---------------------------------------------------------------------------
// validateSteps — the pre-flight gate. Everything it rejects, it rejects BEFORE
// the bundle has written anything, which is what makes all-or-nothing real.
// ---------------------------------------------------------------------------

describe('validateSteps', () => {
  test('accepts a well-formed list and splits op/path from the tool arguments', () => {
    const steps = validateSteps([
      { op: 'write', path: 'a.md', content: 'A' },
      { op: 'append', path: 'log.md', content: '- line\n' },
    ]);
    assert.equal(steps.length, 2);
    assert.deepEqual(steps[0], { index: 0, op: 'write', path: 'a.md', args: { content: 'A' } });
    assert.deepEqual(steps[1], { index: 1, op: 'append', path: 'log.md', args: { content: '- line\n' } });
  });

  test('refuses a missing / empty / non-array step list', () => {
    for (const bad of [undefined, null, [], 'write', {}]) {
      assert.throws(() => validateSteps(bad), /Missing or empty argument: steps/);
    }
  });

  test('refuses more steps than the bound, naming the count and the limit', () => {
    const many = Array.from({ length: MAX_STEPS + 1 }, (_, i) => ({ op: 'write', path: `f${i}.md`, content: 'x' }));
    assert.throws(() => validateSteps(many), new RegExp(`${MAX_STEPS + 1} steps.*limit of ${MAX_STEPS}`));
  });

  test('refuses an unknown op and names the supported set', () => {
    assert.throws(
      () => validateSteps([{ op: 'rename', path: 'a.md' }]),
      (err) => err instanceof BundleError && err.message.includes(STEP_OPS.join(', ')),
    );
  });

  test('refuses `move` with the reason it is unsupported, not a generic "unknown op"', () => {
    assert.throws(
      () => validateSteps([{ op: 'move', path: 'a.md' }]),
      /deliberately not supported.*delete \+ a write/s,
    );
  });

  test('refuses a missing or blank path', () => {
    assert.throws(() => validateSteps([{ op: 'write', content: 'x' }]), /steps\[0\]\.path is required/);
    assert.throws(() => validateSteps([{ op: 'write', path: '   ', content: 'x' }]), /steps\[0\]\.path is required/);
  });

  test('refuses a step that targets the journal directory (a bundle cannot write its own recovery record)', () => {
    assert.throws(
      () => validateSteps([{ op: 'write', path: `${BUNDLE_JOURNAL_DIR}/op-0123456789abcdef.json`, content: '{}' }]),
      /may not write its own recovery record/,
    );
  });

  test('refuses a per-step `vault` — a bundle is single-vault by construction', () => {
    assert.throws(
      () => validateSteps([{ op: 'write', path: 'a.md', content: 'x', vault: 'other' }]),
      /steps\[0\]\.vault is not allowed.*single-vault/s,
    );
  });

  test('refuses per-step two-phase flags — the seal belongs to the bundle', () => {
    assert.throws(
      () => validateSteps([{ op: 'delete', path: 'a.md', confirm: true, preview: true }]),
      /steps\[0\]\.preview is not allowed/,
    );
    assert.throws(
      () => validateSteps([{ op: 'delete', path: 'a.md', confirm: true, approvedPlanSha256: 'x' }]),
      /steps\[0\]\.approvedPlanSha256 is not allowed/,
    );
  });

  test('refuses a step missing an argument its op requires', () => {
    assert.throws(() => validateSteps([{ op: 'write', path: 'a.md' }]), /missing required argument: content/);
    assert.throws(() => validateSteps([{ op: 'append', path: 'a.md' }]), /missing required argument: content/);
    assert.throws(
      () => validateSteps([{ op: 'patch', path: 'a.md', operation: 'append', targetType: 'heading' }]),
      /missing required argument: target/,
    );
    assert.throws(() => validateSteps([{ op: 'set_frontmatter', path: 'a.md', key: 'k' }]), /missing required argument: value/);
    assert.throws(() => validateSteps([{ op: 'merge_frontmatter', path: 'a.md' }]), /missing required argument: values/);
  });

  test('a set_frontmatter step may set a FALSY value (null / false / 0 / "")', () => {
    for (const value of [null, false, 0, '']) {
      const [s] = validateSteps([{ op: 'set_frontmatter', path: 'a.md', key: 'k', value }]);
      assert.equal(s.args.value, value);
    }
  });

  test('a delete step still needs confirm:true — bundling does not relax the guard', () => {
    assert.throws(() => validateSteps([{ op: 'delete', path: 'a.md' }]), /requires confirm:true/);
    assert.throws(() => validateSteps([{ op: 'delete', path: 'a.md', confirm: 'yes' }]), /requires confirm:true/);
    const [ok] = validateSteps([{ op: 'delete', path: 'a.md', confirm: true }]);
    assert.equal(ok.op, 'delete');
  });

  test('refuses argument TYPES the delegated tool would reject mid-bundle', () => {
    // Everything knowable before the first write must be refused before the
    // first write — otherwise a typo on step 4 becomes a rollback, dragging the
    // bundle through every attribution ambiguity for nothing.
    assert.throws(() => validateSteps([{ op: 'write', path: 'a.md', content: 42 }]), /needs its content argument to be a string/);
    assert.throws(() => validateSteps([{ op: 'append', path: 'a.md', content: {} }]), /needs its content argument to be a string/);
    assert.throws(() => validateSteps([{ op: 'set_frontmatter', path: 'a.md', key: '  ', value: 1 }]), /needs a non-empty key/);
    assert.throws(() => validateSteps([{ op: 'merge_frontmatter', path: 'a.md', values: ['a'] }]), /needs values to be a key\/value object/);
    assert.throws(
      () => validateSteps([{ op: 'patch', path: 'a.md', operation: 'nonsense', targetType: 'heading', target: 'T', content: 'x' }]),
      /needs operation to be one of: append, prepend, replace/,
    );
    assert.throws(
      () => validateSteps([{ op: 'patch', path: 'a.md', operation: 'append', targetType: 'weird', target: 'T', content: 'x' }]),
      /needs targetType to be one of: heading, block, frontmatter/,
    );
    assert.throws(
      () => validateSteps([{ op: 'patch', path: 'a.md', operation: 'append', targetType: 'heading', target: '', content: 'x' }]),
      /needs a non-empty target/,
    );
    assert.throws(
      () => validateSteps([{ op: 'write', path: 'a.md', content: 'x', ifNew: true, ifMatch: '0'.repeat(64) }]),
      /cannot both be true/,
    );
  });

  test('refuses a boolean option given as a string — "false" is truthy and reverses the intent', () => {
    // append_to_file does `createTargetIfMissing: requireExisting ? false : undefined`,
    // so requireExisting:"false" makes it refuse to create the very file the
    // caller asked it to create.
    assert.throws(() => validateSteps([{ op: 'append', path: 'a.md', content: 'x', requireExisting: 'false' }]), /must be a boolean/);
    assert.throws(() => validateSteps([{ op: 'write', path: 'a.md', content: 'x', ifNew: 'true' }]), /must be a boolean/);
    assert.throws(
      () => validateSteps([{ op: 'patch', path: 'a.md', operation: 'append', targetType: 'heading', target: 'T', content: 'x', createTargetIfMissing: 1 }]),
      /must be a boolean/,
    );
    // The delete guard keeps its own, more specific message.
    assert.throws(() => validateSteps([{ op: 'delete', path: 'a.md', confirm: 'yes' }]), /requires confirm:true/);
  });

  test('every refusal classifies as a non-retryable validation error', () => {
    try {
      validateSteps([{ op: 'nope', path: 'a.md' }]);
      assert.fail('expected a throw');
    } catch (err) {
      assert.deepEqual(classifyError(err), { errorCategory: 'validation', isRetryable: false });
    }
  });
});

// ---------------------------------------------------------------------------
// Paths + bounds
// ---------------------------------------------------------------------------

describe('uniquePaths / backupBytes', () => {
  test('deduplicates while keeping first-appearance order', () => {
    const steps = validateSteps([
      { op: 'write', path: 'b.md', content: '1' },
      { op: 'append', path: 'a.md', content: '2' },
      { op: 'append', path: 'b.md', content: '3' },
    ]);
    assert.deepEqual(uniquePaths(steps), ['b.md', 'a.md']);
  });

  test('counts only the bytes of files that actually existed', () => {
    const backups = new Map([
      ['a.md', { existed: true, content: 'hello' }],
      ['b.md', { existed: false, content: null }],
      ['c.md', { existed: true, content: 'é' }], // 2 bytes in utf-8
    ]);
    assert.equal(backupBytes(backups), 7);
  });
});

// ---------------------------------------------------------------------------
// buildBundlePlan — what the C3 seal actually pins.
// ---------------------------------------------------------------------------

describe('buildBundlePlan', () => {
  const backups = new Map([
    ['a.md', { existed: true, contentSha256: sha('A') }],
    ['b.md', { existed: false, contentSha256: null }],
  ]);

  test('lists the ordered steps and the targets sorted by path', () => {
    const steps = validateSteps([
      { op: 'append', path: 'b.md', content: 'x' },
      { op: 'write', path: 'a.md', content: 'y' },
    ]);
    const plan = buildBundlePlan(steps, backups);
    assert.deepEqual(plan.steps.map((s) => [s.index, s.op, s.path]), [[0, 'append', 'b.md'], [1, 'write', 'a.md']]);
    assert.deepEqual(plan.targets, [
      { path: 'a.md', exists: true, contentSha256: sha('A') },
      { path: 'b.md', exists: false, contentSha256: null },
    ]);
  });

  test('is deterministic and insensitive to the key order the caller happened to use', () => {
    const one = buildBundlePlan(validateSteps([{ op: 'write', path: 'a.md', content: 'y', ifMatch: undefined }]), backups);
    const two = buildBundlePlan(validateSteps([{ path: 'a.md', content: 'y', op: 'write' }]), backups);
    assert.deepEqual(one, two);
  });

  test('the step fingerprint covers the FULL arguments — same op+path, different body ⇒ different seal', () => {
    const identity = { name: 'v', baseUrl: 'http://v' };
    const sealFor = (content) =>
      computePlanSeal({
        op: 'write_bundle',
        identity,
        plan: buildBundlePlan(validateSteps([{ op: 'write', path: 'a.md', content }]), backups),
      });
    assert.notEqual(sealFor('body one'), sealFor('body two'));
    assert.equal(sealFor('body one'), sealFor('body one'));
  });

  test('a target that drifted changes the seal even when the steps are identical', () => {
    const identity = { name: 'v', baseUrl: 'http://v' };
    const steps = validateSteps([{ op: 'write', path: 'a.md', content: 'y' }]);
    const before = computePlanSeal({ op: 'write_bundle', identity, plan: buildBundlePlan(steps, backups) });
    const drifted = new Map([['a.md', { existed: true, contentSha256: sha('A-changed') }]]);
    const after = computePlanSeal({ op: 'write_bundle', identity, plan: buildBundlePlan(steps, drifted) });
    assert.notEqual(before, after);
  });
});

// ---------------------------------------------------------------------------
// planRestore — the rollback decision table, branch by branch.
// ---------------------------------------------------------------------------

describe('planRestore', () => {
  const existed = { existed: true, contentSha256: sha('ORIGINAL') };
  const absent = { existed: false, contentSha256: null };
  /** A DERIVED post-image: the bundle knows the exact bytes it sent. */
  const derived = (s) => ({ exists: true, contentSha256: sha(s), source: 'derived' });
  const derivedGone = { exists: false, contentSha256: null, source: 'derived' };
  /** An OBSERVED post-image: read back after a step whose result we cannot predict. */
  const observed = (s) => ({ exists: true, contentSha256: sha(s), source: 'observed' });
  const at = (s) => ({ exists: true, contentSha256: sha(s) });
  const gone = { exists: false, contentSha256: null };

  test('already back at the before-image → nothing to do (file existed)', () => {
    assert.deepEqual(planRestore(existed, derived('OURS'), at('ORIGINAL')), { action: 'none', status: 'already-clean' });
  });

  test('already back at the before-image → nothing to do (file was absent)', () => {
    assert.deepEqual(planRestore(absent, derivedGone, gone), { action: 'none', status: 'already-clean' });
  });

  test('our own DERIVED content is still there → restore, attributed "ours"', () => {
    assert.deepEqual(planRestore(existed, derived('OURS'), at('OURS')), {
      action: 'restore', status: 'restored', attribution: 'ours',
    });
  });

  test('an OBSERVED post-image restores too, but says so — the read-back window is not zero', () => {
    assert.deepEqual(planRestore(existed, observed('OURS'), at('OURS')), {
      action: 'restore', status: 'restored', attribution: 'observed',
    });
  });

  test('a PROVEN foreign write is never touched, whatever the current state', () => {
    const foreign = { foreign: true };
    assert.equal(planRestore(existed, foreign, at('THEIRS')).status, 'left-modified');
    assert.equal(planRestore(existed, foreign, gone).status, 'left-deleted');
    assert.equal(planRestore(absent, foreign, at('THEIRS')).status, 'left-created');
    for (const current of [at('THEIRS'), gone]) {
      assert.equal(planRestore(existed, foreign, current).action, 'skip');
    }
  });

  test('a proven foreign write that happens to leave the before-image needs no action', () => {
    assert.deepEqual(planRestore(existed, { foreign: true }, at('ORIGINAL')), {
      action: 'none', status: 'already-clean',
    });
  });

  test('SOMEONE ELSE overwrote what we wrote → left alone, never clobbered', () => {
    const v = planRestore(existed, derived('OURS'), at('THEIRS'));
    assert.equal(v.action, 'skip');
    assert.equal(v.status, 'left-modified');
    assert.match(v.reason, /would destroy that edit/);
  });

  test('a step failed before any post-image was confirmed → restore, honestly unverified', () => {
    assert.deepEqual(planRestore(existed, null, at('HALF-WRITTEN')), {
      action: 'restore', status: 'restored', attribution: 'unverified',
    });
  });

  test('we deleted the file → re-create it from the backup', () => {
    assert.deepEqual(planRestore(existed, derivedGone, gone), {
      action: 'restore', status: 'restored', attribution: 'ours',
    });
  });

  test('someone else deleted a file we had left in place → do not resurrect it', () => {
    const v = planRestore(existed, derived('OURS'), gone);
    assert.equal(v.action, 'skip');
    assert.equal(v.status, 'left-deleted');
  });

  test('we created the file → delete it', () => {
    assert.deepEqual(planRestore(absent, derived('OURS'), at('OURS')), {
      action: 'delete', status: 'removed', attribution: 'ours',
    });
  });

  test('the file we created now holds someone else\'s content → do not delete it', () => {
    const v = planRestore(absent, derived('OURS'), at('THEIRS'));
    assert.equal(v.action, 'skip');
    assert.equal(v.status, 'left-created');
  });

  test('a file appeared where we left none → left alone (we did not create it)', () => {
    const v = planRestore(absent, derivedGone, at('SOMEONE'));
    assert.equal(v.action, 'skip');
    assert.equal(v.status, 'left-created');
  });

  test('a file appeared after an unconfirmed step on an absent target → removed, unverified', () => {
    assert.deepEqual(planRestore(absent, null, at('MAYBE-OURS')), {
      action: 'delete', status: 'removed', attribution: 'unverified',
    });
  });

  test('a file that vanished after an unconfirmed step → restored, unverified', () => {
    assert.deepEqual(planRestore(existed, null, gone), {
      action: 'restore', status: 'restored', attribution: 'unverified',
    });
  });

  test('NO branch ever writes over content it attributes to a third party', () => {
    const foreignCases = [
      planRestore(existed, derived('OURS'), at('THEIRS')),
      planRestore(existed, derived('OURS'), gone),
      planRestore(absent, derived('OURS'), at('THEIRS')),
      planRestore(absent, derivedGone, at('SOMEONE')),
      planRestore(existed, { foreign: true }, at('THEIRS')),
      planRestore(absent, { foreign: true }, at('THEIRS')),
    ];
    for (const v of foreignCases) assert.equal(v.action, 'skip');
  });
});

describe('derivePostImage', () => {
  test('a write is derivable from the bytes the bundle sends', () => {
    assert.deepEqual(derivePostImage('write', { content: 'BODY' }), { exists: true, contentSha256: sha('BODY') });
  });

  test('a delete is derivable: the file is gone', () => {
    assert.deepEqual(derivePostImage('delete', { confirm: true }), { exists: false, contentSha256: null });
  });

  test('a write is fingerprinted as it will READ BACK, not as it was sent', () => {
    // The transport's decoder strips one leading BOM and contentSha256 strips
    // one more, so hashing the sent bytes directly mismatches for content that
    // starts with two — and a mismatch means "foreign", which would make the
    // bundle refuse to clean up after its own write.
    assert.equal(derivePostImage('write', { content: '﻿body' }).contentSha256, sha('body'));
    assert.equal(derivePostImage('write', { content: '﻿﻿body' }).contentSha256, sha('﻿body'));
    assert.equal(derivePostImage('write', { content: '' }).contentSha256, sha(''));
  });

  test('everything Obsidian computes is deliberately NOT derived', () => {
    // Guessing a heading patch or a YAML re-emission wrong would read as a
    // foreign write and stop the bundle cleaning up after itself.
    for (const op of ['append', 'patch', 'set_frontmatter', 'merge_frontmatter']) {
      assert.equal(derivePostImage(op, { content: 'x', key: 'k', value: 1, values: {} }), null, op);
    }
  });
});

describe('isCleanRollback / isVerifiedRollback', () => {
  test('clean only when every path is verifiably back', () => {
    assert.equal(isCleanRollback([{ status: 'already-clean' }, { status: 'restored' }, { status: 'removed' }]), true);
    assert.equal(isCleanRollback([{ status: 'restored' }, { status: 'left-modified' }]), false);
    assert.equal(isCleanRollback([{ status: 'restored', error: 'boom' }]), false);
    assert.equal(isCleanRollback([{ status: 'unknown', error: 'unreadable' }]), false);
  });

  test('verified only when no ACTION was taken on unattributable content', () => {
    assert.equal(isVerifiedRollback([{ action: 'restore', attribution: 'ours' }]), true);
    assert.equal(isVerifiedRollback([{ action: 'restore', attribution: 'observed' }]), true);
    assert.equal(isVerifiedRollback([{ action: 'none' }, { action: 'skip' }]), true);
    assert.equal(isVerifiedRollback([{ action: 'restore', attribution: 'unverified' }]), false);
    assert.equal(isVerifiedRollback([{ action: 'delete', attribution: 'unverified' }]), false);
  });

  test('the two are independent: a rollback can put everything back yet be unproven', () => {
    const paths = [{ action: 'restore', status: 'restored', attribution: 'unverified' }];
    assert.equal(isCleanRollback(paths), true);
    assert.equal(isVerifiedRollback(paths), false);
  });
});

// ---------------------------------------------------------------------------
// Operation ids + journal paths — an id is a path component, so its shape is a
// security check, not a cosmetic one.
// ---------------------------------------------------------------------------

describe('operation ids', () => {
  test('accepts only the op- + 16 lowercase hex form', () => {
    assert.equal(isOperationId('op-0123456789abcdef'), true);
    for (const bad of ['op-0123456789ABCDEF', 'op-short', 'op-0123456789abcdefg', '0123456789abcdef', '', null, 42]) {
      assert.equal(isOperationId(bad), false);
    }
  });

  test('journalPathFor refuses an id that would escape the journal directory', () => {
    for (const evil of ['../../wiki/index', 'op-../../../etc/passwd', 'op-0123456789abcdef/../..']) {
      assert.throws(() => journalPathFor(evil), /Invalid operationId/);
    }
    assert.equal(journalPathFor('op-0123456789abcdef'), `${BUNDLE_JOURNAL_DIR}/op-0123456789abcdef.json`);
  });

  test('newOperationId refuses an id source that does not yield 16 hex chars', () => {
    assert.equal(newOperationId(() => 'a1b2c3d4e5f60718'), 'op-a1b2c3d4e5f60718');
    assert.throws(() => newOperationId(() => 'nope'), /16 lowercase hex/);
  });
});

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

describe('buildJournal / parseJournal', () => {
  const steps = validateSteps([
    { op: 'write', path: 'a.md', content: 'new A' },
    { op: 'write', path: 'new.md', content: 'brand new' },
  ]);
  const backups = new Map([
    ['a.md', { existed: true, content: 'old A', contentSha256: sha('old A') }],
    ['new.md', { existed: false, content: null, contentSha256: null }],
  ]);

  const journalOf = (extra = {}) =>
    JSON.stringify({
      version: 1,
      operationId: 'op-0123456789abcdef',
      state: 'pending',
      backups: { 'a.md': { existed: false, content: null, contentSha256: null } },
      ...extra,
    });

  test('records the before-image of every target, existing or not', () => {
    const j = buildJournal({ operationId: 'op-0123456789abcdef', vaultName: 'v', startedAt: 'T', steps, backups });
    assert.equal(j.version, JOURNAL_VERSION);
    assert.equal(j.state, 'pending');
    assert.deepEqual(j.backups['a.md'], { existed: true, content: 'old A', contentSha256: sha('old A') });
    assert.deepEqual(j.backups['new.md'], { existed: false, content: null, contentSha256: null });
    assert.deepEqual(j.steps, [
      { index: 0, op: 'write', path: 'a.md' },
      { index: 1, op: 'write', path: 'new.md' },
    ]);
  });

  test('the path-keyed backup map has a null prototype (vault paths are attacker-influenced keys)', () => {
    const j = buildJournal({ operationId: 'op-0123456789abcdef', vaultName: 'v', startedAt: 'T', steps, backups });
    assert.equal(Object.getPrototypeOf(j.backups), null);
  });

  test('round-trips through JSON', () => {
    const j = buildJournal({ operationId: 'op-0123456789abcdef', vaultName: 'v', startedAt: 'T', steps, backups });
    const back = parseJournal(JSON.stringify(j), 'p.json');
    assert.equal(back.operationId, 'op-0123456789abcdef');
    assert.equal(back.backups['a.md'].content, 'old A');
    assert.equal(back.backups['new.md'].existed, false);
  });

  test('refuses a journal it cannot fully trust', () => {
    assert.throws(() => parseJournal('{not json', 'p.json'), /not readable JSON/);
    assert.throws(() => parseJournal('[]', 'p.json'), /not an object/);
    assert.throws(() => parseJournal(JSON.stringify({ version: 99 }), 'p.json'), /version 99.*version 1/s);
    assert.throws(
      () => parseJournal(JSON.stringify({ version: 1, operationId: 'nope', backups: {} }), 'p.json'),
      /no valid operationId/,
    );
    assert.throws(
      () => parseJournal(JSON.stringify({ version: 1, operationId: 'op-0123456789abcdef', state: 'pending' }), 'p.json'),
      /no backups map/,
    );
    assert.throws(
      () => parseJournal(journalOf({ backups: { 'a.md': 3 } }), 'p.json'),
      /malformed backup for "a\.md"/,
    );
    assert.throws(() => parseJournal(journalOf({ state: 'weird' }), 'p.json'), /unrecognised state "weird"/);
  });

  test('refuses a journal filed under a DIFFERENT operation id than it carries', () => {
    // A renamed or planted record must not be obeyed: the filename is what the
    // caller asked to recover, the embedded id is what the record claims to be.
    assert.throws(
      () => parseJournal(journalOf(), 'p.json', { expectOperationId: 'op-ffffffffffffffff' }),
      /is filed under "op-ffffffffffffffff".*renamed or planted/s,
    );
    assert.doesNotThrow(() => parseJournal(journalOf(), 'p.json', { expectOperationId: 'op-0123456789abcdef' }));
  });

  test('refuses to RECOVER from a journal that already reached a terminal state', () => {
    // A successful bundle whose journal deletion failed leaves the record behind.
    // Replaying it would UNDO an operation that succeeded. Only the two PROVEN
    // ends are terminal — a partial or unprovable rollback stays `pending`, so
    // the `recover` its own message advertises actually works.
    for (const state of ['applied', 'rolled-back']) {
      assert.throws(
        () => parseJournal(journalOf({ state }), 'p.json', { requirePending: true }),
        new RegExp(`already "${state}".*Replaying its backups would UNDO it`, 's'),
      );
      // …but it still PARSES for the read-only listing, which reports the state.
      assert.equal(parseJournal(journalOf({ state }), 'p.json').state, state);
    }
  });

  test('a `rolled-back-partial` journal stays PENDING, so the recover its message advertises is not refused', () => {
    const raw = journalOf({ state: 'pending', lastOutcome: 'rolled-back-partial' });
    const back = parseJournal(raw, 'p.json', { requirePending: true });
    assert.equal(back.state, 'pending');
    assert.throws(() => parseJournal(journalOf({ state: 'rolled-back-partial' }), 'p.json'), /unrecognised state/);
  });

  test('preserves the salvage map across a re-read — a second partial recovery must not erase the first copy', () => {
    const raw = journalOf({ salvage: { 'a.md': { content: 'WHAT WAS OVERWRITTEN' } } });
    const back = parseJournal(raw, 'p.json');
    assert.equal(back.salvage['a.md'].content, 'WHAT WAS OVERWRITTEN');
    assert.equal(back.salvage['a.md'].contentSha256, sha('WHAT WAS OVERWRITTEN'));
  });

  test('drops salvage entries whose path is not canonical, contained, or well-formed', () => {
    const back = parseJournal(
      journalOf({
        salvage: {
          'ok.md': { content: 'keep' },
          '/not-canonical.md': { content: 'drop' },
          [`${BUNDLE_JOURNAL_DIR}/op-ffffffffffffffff.json`]: { content: 'drop' },
          'no-content.md': { existed: true },
        },
      }),
      'p.json',
    );
    assert.deepEqual(Object.keys(back.salvage), ['ok.md']);
  });

  test('refuses backup keys that escape the vault or target the journal directory', () => {
    assert.throws(
      () => parseJournal(journalOf({ backups: { '../../etc/passwd': { existed: false } } }), 'p.json'),
      /contains a "\.\." segment/,
    );
    assert.throws(
      () => parseJournal(journalOf({ backups: { [`${BUNDLE_JOURNAL_DIR}/op-ffffffffffffffff.json`]: { existed: false } } }), 'p.json'),
      /A recovery never writes into the journal directory/,
    );
  });

  test('refuses a non-canonical backup key rather than silently normalising it', () => {
    assert.throws(
      () => parseJournal(journalOf({ backups: { '/a.md': { existed: false } } }), 'p.json'),
      /not the canonical spelling of "a\.md".*this router did not write/s,
    );
  });

  test('refuses a backup that claims the file existed but stores no content — it cannot restore what it does not hold', () => {
    const raw = journalOf({ backups: { 'a.md': { existed: true, content: null, contentSha256: sha('x') } } });
    assert.throws(() => parseJournal(raw, 'p.json'), /records "a\.md" as existing but stores no content/);
  });

  test('re-derives the fingerprint instead of trusting the stored one', () => {
    const raw = journalOf({ backups: { 'a.md': { existed: true, content: 'real', contentSha256: sha('a lie') } } });
    const back = parseJournal(raw, 'p.json');
    assert.equal(back.backups['a.md'].contentSha256, sha('real'));
  });

  test('a __proto__ key in a stored journal does not pollute the parsed map', () => {
    const raw = `{"version":1,"operationId":"op-0123456789abcdef","state":"pending","backups":{"__proto__":{"existed":false},"a.md":{"existed":false}}}`;
    const back = parseJournal(raw, 'p.json');
    assert.equal(Object.getPrototypeOf(back.backups), null);
    assert.equal({}.existed, undefined);
  });
});

// ---------------------------------------------------------------------------
// Wording — a partial rollback must never read like a clean one.
// ---------------------------------------------------------------------------

describe('outcomeMessage', () => {
  const journalPath = `${BUNDLE_JOURNAL_DIR}/op-0123456789abcdef.json`;

  test('a full rollback claims restoration to what the bundle READ — not to the raw bytes', () => {
    const m = outcomeMessage({ outcome: 'rolled-back', operationId: 'op-0123456789abcdef', applied: 2, total: 4, failedStep: 2 });
    assert.match(m, /rolled back completely/);
    assert.match(m, /the content the bundle read/);
    // "byte-identical" would be a lie on a BOM-prefixed file: the read path
    // strips a leading BOM (content-hash.mjs), so the restore writes it back
    // without one. The wording must not promise what the transport cannot give.
    assert.doesNotMatch(m, /byte-identical/);
    assert.doesNotMatch(m, /applied all/);
  });

  test('step numbers are 1-based in prose (the machine field stays zero-based)', () => {
    const m = outcomeMessage({ outcome: 'rolled-back', operationId: 'op-x', applied: 0, total: 3, failedStep: 0 });
    assert.match(m, /FAILED at step 1 of 3/);
  });

  test('an UNVERIFIED rollback never reads like a proven one, and points at the salvaged content', () => {
    const m = outcomeMessage({
      outcome: 'rolled-back-unverified',
      operationId: 'op-0123456789abcdef',
      applied: 1, total: 2, failedStep: 1,
      unverified: ['a.md'],
      journalPath,
    });
    assert.doesNotMatch(m, /rolled back completely|Nothing partial remains/);
    assert.match(m, /could NOT be proven/);
    assert.match(m, /a\.md/);
    assert.match(m, /saved into the journal kept at/);
  });

  test('a partial rollback names the residue and the journal, and never says "rolled back completely"', () => {
    const m = outcomeMessage({
      outcome: 'rolled-back-partial',
      operationId: 'op-0123456789abcdef',
      applied: 2,
      total: 4,
      failedStep: 2,
      residue: ['a.md', 'b.md'],
      journalPath,
    });
    assert.doesNotMatch(m, /rolled back completely|byte-identical/);
    assert.match(m, /could NOT be fully rolled back/);
    assert.match(m, /a\.md, b\.md/);
    assert.match(m, /journal was KEPT/);
    assert.match(m, /recover:"op-0123456789abcdef"/);
  });

  test('a success that skipped no-op steps says so instead of "applied all"', () => {
    const plain = outcomeMessage({ outcome: 'applied', operationId: 'op-x', applied: 3, skipped: 0, total: 3 });
    assert.equal(plain.includes('no-op'), false);
    const withSkips = outcomeMessage({ outcome: 'applied', operationId: 'op-x', applied: 2, skipped: 1, total: 3 });
    assert.match(withSkips, /1 of them a no-op the target already satisfied/);
  });
});

// ---------------------------------------------------------------------------
// Path identity + containment — the same string can be several map keys while
// addressing ONE file, and `..` survives percent-encoding.
// ---------------------------------------------------------------------------

describe('canonicalVaultPath', () => {
  test('collapses every spelling that reaches the same URL', () => {
    for (const spelling of ['a/b.md', 'a//b.md', '/a/b.md', 'a/b.md/', '//a//b.md//']) {
      assert.equal(canonicalVaultPath(spelling), 'a/b.md', spelling);
    }
  });

  test('refuses "." and ".." segments — encodeURIComponent leaves them intact on the wire', () => {
    for (const evil of ['../outside.md', 'a/../../b.md', './a.md', 'a/./b.md']) {
      assert.throws(() => canonicalVaultPath(evil), /contains a "\.\.?" segment|contains a "\." segment|contains a "\.\." segment/);
    }
  });

  test('refuses backslash spellings — this canonicaliser splits on "/" only, so it cannot vouch for them', () => {
    // `..\outside.md` would survive as ONE innocent-looking segment and reach the
    // wire percent-encoded, on a fleet whose servers run on Windows.
    for (const evil of ['..\\outside.md', 'a\\..\\..\\b.md', `${BUNDLE_JOURNAL_DIR.replace(/\//g, '\\')}\\op-0123456789abcdef.json`]) {
      assert.throws(() => canonicalVaultPath(evil), /contains a backslash/);
    }
    assert.throws(() => canonicalVaultPath('C:/vault/a.md'), /absolute filesystem path/);
    assert.throws(() => canonicalVaultPath('a\0b.md'), /NUL character/);
  });

  test('the journal-directory guard matches the directory ITSELF, not just what is inside it', () => {
    assert.equal(isJournalPath(BUNDLE_JOURNAL_DIR), true);
    assert.throws(
      () => validateSteps([{ op: 'delete', path: BUNDLE_JOURNAL_DIR, confirm: true }]),
      /may not write its own recovery record/,
    );
  });

  test('refuses what does not name a file', () => {
    for (const empty of ['', '   ', '/', '///', null, 42]) {
      assert.throws(() => canonicalVaultPath(empty), /is required|does not name a file/);
    }
  });

  test('the journal-directory guard is applied to the CANONICAL form, so a leading slash cannot slip past it', () => {
    const sneaky = `/${BUNDLE_JOURNAL_DIR}/op-0123456789abcdef.json`;
    assert.equal(isJournalPath(sneaky), false, 'the raw string does not look like a journal path…');
    assert.equal(isJournalPath(canonicalVaultPath(sneaky)), true, '…but its canonical form does');
    assert.throws(
      () => validateSteps([{ op: 'write', path: sneaky, content: 'x' }]),
      /may not write its own recovery record/,
    );
  });

  test('a step list gives ONE backup per file, whatever spelling each step used', () => {
    const steps = validateSteps([
      { op: 'write', path: 'a/b.md', content: '1' },
      { op: 'append', path: '/a//b.md', content: '2' },
    ]);
    assert.deepEqual(steps.map((s) => s.path), ['a/b.md', 'a/b.md']);
    assert.deepEqual(uniquePaths(steps), ['a/b.md']);
  });

  test('a traversal path is refused at the step list, before anything is read or written', () => {
    assert.throws(
      () => validateSteps([{ op: 'write', path: '../../outside.md', content: 'x' }]),
      /may not walk outside it/,
    );
  });
});
