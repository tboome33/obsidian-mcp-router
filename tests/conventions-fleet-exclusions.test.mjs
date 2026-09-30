/**
 * FLEET EXCLUSIONS — the record that says "do not write here", and the two
 * fingerprints that stop it becoming a certificate.
 *
 * WHAT IS BEING PROTECTED. The decision `exclusions-de-propagation-des-conventions`
 * rules that three conventions must not be propagated into certain vaults,
 * because there the snippet holds the GENERIC text and the vault holds the
 * CONCRETE one. Its §3 then refuses the obvious implementation: an exemption
 * keyed on a convention's NAME would go on excusing the pair while the text
 * underneath it rotted. So an entry pins both texts, and editing either one
 * must bring the pair back for examination.
 *
 * THE TESTS THAT MATTER MOST ARE THE ONES ABOUT SILENCE, and they are grouped
 * at the bottom. This mechanism's whole failure mode is quiet: a record that
 * stops matching and says nothing, an excluded pair that disappears from the
 * render, an entry naming a vault that no longer exists. Each of those is a
 * separate witness here, because each would leave a green report over a
 * question nobody is answering.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  EXCLUSION_COVERAGE,
  FLEET_EXCLUSION,
  applyFleetExclusions,
  exclusionKey,
  normaliseRelativeFile,
  readFleetExclusions,
  annotatedSeverity,
} from '../src/helpers/conventions-fleet-exclusions.mjs';
import { summariseTarget } from '../scripts/conventions-drift.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRIFT_CLI = path.join(REPO, 'scripts', 'conventions-drift.mjs');

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

const entry = (over = {}) => ({
  vault: 'Tribu',
  file: 'CLAUDE.md',
  convention: 'tribu-routing',
  snippetSha256: SHA_A,
  targetSha256: SHA_B,
  reason: 'the vault names the family; the snippet writes [list]',
  ...over,
});

const finding = (over = {}) => ({
  rule: 'convention-drift',
  file: 'C:/VAULTS/Tribu/CLAUDE.md',
  label: 'Tribu — CLAUDE.md',
  convention: 'tribu-routing',
  heading: 'Tribu routing',
  status: 'drift',
  driftLines: 9,
  exactCount: true,
  line: 12,
  snippetSha256: SHA_A,
  targetSha256: SHA_B,
  declared: null,
  severity: 'warning',
  verdict: 'observed',
  reason: null,
  detail: null,
  ...over,
});

const LOCATIONS = [{ file: 'C:/VAULTS/Tribu/CLAUDE.md', vault: 'Tribu', relative: 'CLAUDE.md' }];

const run = (over = {}) => applyFleetExclusions({
  findings: [finding()],
  locations: LOCATIONS,
  entries: readFleetExclusions({ entries: [entry()] }).entries,
  ...over,
});

describe('reading the record', () => {
  test('a well-formed document yields one indexed entry', () => {
    const { entries, errors } = readFleetExclusions({ entries: [entry()] });
    assert.deepEqual(errors, []);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].key, exclusionKey('Tribu', 'CLAUDE.md', 'tribu-routing'));
  });

  test('`entries: []` is an empty record, and that is legal', () => {
    const { entries, errors } = readFleetExclusions({ entries: [] });
    assert.deepEqual(errors, []);
    assert.deepEqual(entries, []);
  });

  // THE SHAPES THAT COULD READ AS "NOTHING IS EXCLUDED" WITHOUT SAYING SO. Each
  // of these is a way for the record to be silently discharged — a typo in a
  // key, a hand edit that dropped the wrapper — and the whole list is here
  // because the repository's baseline shipped accepting three of them.
  for (const [what, doc] of [
    ['null', null],
    ['a bare array', [entry()]],
    ['a string', 'entries'],
    ['an object with no `entries`', { $comment: 'x' }],
    ['the misspelt key `entires`', { entires: [entry()] }],
    ['`entries: null`', { entries: null }],
    ['`entries` as an object', { entries: { 0: entry() } }],
  ]) {
    test(`a malformed document is refused, not read as empty: ${what}`, () => {
      const { entries, errors } = readFleetExclusions(doc);
      assert.deepEqual(entries, []);
      assert.ok(errors.length > 0, 'a malformed document must produce at least one error');
    });
  }

  for (const field of ['vault', 'file', 'convention', 'reason']) {
    test(`a missing \`${field}\` is an error and the entry is dropped`, () => {
      const { entries, errors } = readFleetExclusions({ entries: [entry({ [field]: '' })] });
      assert.deepEqual(entries, []);
      assert.ok(errors.some((e) => e.includes(field)), `errors should name ${field}: ${errors.join(' | ')}`);
    });
  }

  for (const field of ['snippetSha256', 'targetSha256']) {
    test(`a \`${field}\` that is not a sha256 is an error`, () => {
      const { errors } = readFleetExclusions({ entries: [entry({ [field]: 'deadbeef' })] });
      assert.ok(errors.some((e) => e.includes(field)));
    });
  }

  test('two identical fingerprints describe no divergence, so there is nothing to exclude', () => {
    const { errors } = readFleetExclusions({ entries: [entry({ targetSha256: SHA_A })] });
    assert.ok(errors.some((e) => /identical/.test(e)), errors.join(' | '));
  });

  test('an absolute `file` is refused — a record keyed on one machine\'s path matches nothing', () => {
    const { entries, errors } = readFleetExclusions({
      entries: [entry({ file: 'C:/VAULTS/Tribu/CLAUDE.md' })],
    });
    assert.deepEqual(entries, []);
    assert.ok(errors.some((e) => /vault-relative/.test(e)), errors.join(' | '));
  });

  test('the same pair twice is an error, not a last-one-wins', () => {
    const { entries, errors } = readFleetExclusions({
      entries: [entry(), entry({ reason: 'a second, different reason' })],
    });
    assert.equal(entries.length, 1);
    assert.ok(errors.some((e) => /duplicate/.test(e)));
  });

  test('a Windows-style path in the record keys the same pair as a POSIX one', () => {
    assert.equal(normaliseRelativeFile('Documentation\\CLAUDE.md'), 'Documentation/CLAUDE.md');
    assert.equal(
      exclusionKey('v', 'Documentation\\CLAUDE.md', 'x'),
      exclusionKey('v', 'Documentation/CLAUDE.md', 'x'),
    );
  });

  // A vault NAME is typed by a human; a file path is one of three exact strings
  // the scanner produced. The asymmetry is deliberate, and both halves of it
  // need a witness or a later "simplification" will fold them together.
  test('the vault name is matched case-insensitively', () => {
    assert.equal(exclusionKey('VALETTE', 'CLAUDE.md', 'x'), exclusionKey('valette', 'CLAUDE.md', 'x'));
  });

  test('the file path is NOT matched case-insensitively', () => {
    assert.notEqual(
      exclusionKey('v', 'Documentation/CLAUDE.md', 'x'),
      exclusionKey('v', 'documentation/CLAUDE.md', 'x'),
    );
  });
});

describe('applying the record to a fleet report', () => {
  test('a drifting pair whose two texts still match the record is excluded, with its reason', () => {
    const { findings, counts } = run();
    assert.equal(findings.length, 1);
    assert.equal(findings[0].verdict, FLEET_EXCLUSION.EXCLUDED);
    assert.equal(findings[0].severity, 'info');
    assert.match(findings[0].reason, /names the family/);
    assert.equal(counts.excluded, 1);
  });

  test('the excluded finding keeps the pair\'s own fields — it is annotated, not replaced', () => {
    const { findings } = run();
    assert.equal(findings[0].convention, 'tribu-routing');
    assert.equal(findings[0].driftLines, 9);
    assert.equal(findings[0].line, 12);
    assert.equal(findings[0].vault, 'Tribu');
    assert.equal(findings[0].relative, 'CLAUDE.md');
  });

  // THE MECHANISM ITSELF. One witness per side, because a matcher that compares
  // only one fingerprint passes every test that moves the other.
  test('the VAULT text moving makes the exclusion stale', () => {
    const { findings, counts } = run({ findings: [finding({ targetSha256: SHA_C })] });
    assert.equal(findings[0].verdict, FLEET_EXCLUSION.STALE);
    assert.equal(findings[0].severity, 'warning');
    assert.match(findings[0].detail, /vault's text has changed/);
    assert.equal(counts.stale, 1);
    assert.equal(counts.excluded, 0);
  });

  test('the SNIPPET moving makes the exclusion stale', () => {
    const { findings, counts } = run({ findings: [finding({ snippetSha256: SHA_C })] });
    assert.equal(findings[0].verdict, FLEET_EXCLUSION.STALE);
    assert.match(findings[0].detail, /snippet has changed/);
    assert.equal(counts.stale, 1);
  });

  test('both moving is reported as both, not as one of them', () => {
    const { findings } = run({
      findings: [finding({ snippetSha256: SHA_C, targetSha256: SHA_C })],
    });
    assert.match(findings[0].detail, /both texts have changed/);
  });

  test('a pair that is no longer divergent leaves an obsolete record behind', () => {
    const { findings, counts } = run({
      findings: [finding({ status: 'identical', targetSha256: SHA_A, severity: 'info', verdict: 'in-step' })],
    });
    assert.equal(findings[0].verdict, FLEET_EXCLUSION.OBSOLETE);
    assert.match(findings[0].detail, /no divergence left/);
    assert.equal(counts.obsolete, 1);
  });

  test('a convention that is gone from the file leaves an obsolete record behind', () => {
    const { findings } = run({
      findings: [finding({ status: 'absent', targetSha256: null, severity: 'info', verdict: 'not-installed' })],
    });
    assert.equal(findings[0].verdict, FLEET_EXCLUSION.OBSOLETE);
    assert.match(findings[0].detail, /no longer present/);
  });

  // A duplicated heading is the state in which the excluded text cannot even be
  // identified — so it is also the state in which a section could be replaced
  // wholesale behind the record's back. Reported, never passed over.
  test('a duplicated identity makes the record unverifiable, and says so', () => {
    const { findings, counts } = run({
      findings: [finding({ status: 'duplicate', targetSha256: null, verdict: 'duplicate-identity' })],
    });
    assert.equal(findings[0].verdict, FLEET_EXCLUSION.UNVERIFIABLE);
    assert.equal(findings[0].severity, 'warning');
    assert.equal(counts.unverifiable, 1);
  });

  test('a pair with no record is returned untouched', () => {
    const untouched = finding({ convention: 'bilingual' });
    const { findings, counts } = run({ findings: [untouched] });
    assert.deepEqual(findings[0], untouched);
    assert.equal(counts.excluded, 0);
  });

  test('a record for another vault does not match a same-named file elsewhere', () => {
    const { findings, counts } = run({
      locations: [{ file: 'C:/VAULTS/Tribu/CLAUDE.md', vault: 'roland', relative: 'CLAUDE.md' }],
    });
    assert.equal(findings[0].verdict, 'observed');
    assert.equal(counts.excluded, 0);
    assert.equal(counts.unmatched, 1);
  });

  test('a record for another FILE of the same vault does not match', () => {
    const { counts } = run({
      locations: [{ file: 'C:/VAULTS/Tribu/CLAUDE.md', vault: 'Tribu', relative: 'Documentation/CLAUDE.md' }],
    });
    assert.equal(counts.excluded, 0);
    assert.equal(counts.unmatched, 1);
  });

  test('a record naming something the scan never examined is reported', () => {
    const { findings, counts } = run({ findings: [], locations: [] });
    assert.equal(counts.unmatched, 1);
    assert.equal(counts.outside, 1);
    assert.equal(findings[0].verdict, FLEET_EXCLUSION.UNMATCHED);
    assert.equal(findings[0].coverage, EXCLUSION_COVERAGE.OUTSIDE);
    assert.match(findings[0].detail, /never examined/);
  });

  test('on a one-vault run an unexamined record is not called wrong', () => {
    const { findings } = run({ findings: [], locations: [], examinedWholeFleet: false });
    assert.equal(findings[0].verdict, FLEET_EXCLUSION.UNMATCHED);
    assert.match(findings[0].detail, /about another vault/);
    assert.doesNotMatch(findings[0].detail, /never examined/);
  });

  // THE THIRD ANSWER. A vault the run SELECTED but could not read produces no
  // location at all, so the first version filed its record under "about another
  // vault" — a statement that is simply false, and one that would send a reader
  // looking for a typo in a name that is perfectly correct.
  test('a record about a selected vault whose file could not be read says exactly that', () => {
    const { findings, counts } = run({
      findings: [],
      locations: [],
      selected: ['Tribu'],
      examinedWholeFleet: false,
    });
    assert.equal(findings[0].coverage, EXCLUSION_COVERAGE.UNREAD);
    assert.equal(findings[0].inScope, true, 'the run chose this vault — its record is in scope');
    assert.match(findings[0].detail, /could not read the conventions file/);
    assert.doesNotMatch(findings[0].detail, /not found in it/, 'coverage failed; nothing was proved about the record');
    assert.equal(counts.unread, 1);
    assert.equal(counts.outside, 0);
  });

  // THE POPULATION THIS DECISION IS ABOUT: eleven vaults carry TWO conventions
  // files. Read one, fail on the other, and a per-VAULT coverage lets the
  // readable sibling vouch for the file nobody could open — the record is told
  // "not found here, drop it" while the run's own error list says the file was
  // never read. Two outputs of one run contradicting each other.
  test('a readable sibling file does not vouch for an unreadable one', () => {
    const { findings, counts } = run({
      findings: [],
      locations: [{ file: 'C:/VAULTS/Tribu/Documentation/CLAUDE.md', vault: 'Tribu', relative: 'Documentation/CLAUDE.md' }],
      selected: ['Tribu'],
      unread: [{ vault: 'Tribu', relative: 'CLAUDE.md' }],
    });
    assert.equal(findings[0].coverage, EXCLUSION_COVERAGE.UNREAD);
    assert.match(findings[0].detail, /could not read the conventions file/);
    assert.doesNotMatch(findings[0].detail, /not found in it/);
    assert.equal(counts.unread, 1);
    assert.equal(counts.examined, 0);
  });

  test('a vault that WAS read, on a file it does not have, is still examined', () => {
    const { findings } = run({
      findings: [],
      locations: [{ file: 'C:/VAULTS/Tribu/Documentation/CLAUDE.md', vault: 'Tribu', relative: 'Documentation/CLAUDE.md' }],
      selected: ['Tribu'],
      unread: [],
    });
    assert.equal(findings[0].coverage, EXCLUSION_COVERAGE.EXAMINED);
    assert.match(findings[0].detail, /not found in it/);
  });

  test('a vault this run could not inspect at all marks every one of its records unread', () => {
    const { findings, counts } = run({
      findings: [],
      locations: [],
      selected: ['Tribu'],
      unread: [{ vault: 'Tribu' }],
    });
    assert.equal(findings[0].coverage, EXCLUSION_COVERAGE.UNREAD);
    assert.equal(counts.unread, 1);
  });

  // THE ALLOWLIST GOES STALE, AND THIS IS WHAT HAPPENS WHEN IT DOES. Rename a
  // comparison verdict upstream and the pair is neither annotated (not on the
  // list) nor reported unmatched (its identity WAS seen). Two silences
  // cancelling out. This finding is the third answer.
  test('a pair that was examined but produced no checkable comparison is reported', () => {
    const { findings, counts } = run({
      findings: [finding({ verdict: 'some-future-comparison-verdict' })],
    });
    assert.equal(findings.length, 2, 'the original finding, plus the record saying it could not be checked');
    assert.deepEqual(findings[0], finding({ verdict: 'some-future-comparison-verdict' }), 'the unknown finding is untouched');
    assert.equal(findings[1].verdict, FLEET_EXCLUSION.UNEVALUATED);
    assert.equal(findings[1].severity, 'warning');
    assert.match(findings[1].detail, /neither applied nor refuted/);
    assert.equal(counts.unevaluated, 1);
    assert.equal(counts.unmatched, 0, 'it is not unmatched — the identity was seen');
    assert.equal(counts.excluded, 0);
  });

  test('a pair that WAS evaluated produces no unevaluated finding', () => {
    const { findings, counts } = run();
    assert.equal(counts.unevaluated, 0);
    assert.equal(findings.length, 1);
  });

  // "WE LOOKED AND THERE IS NOTHING HERE" IS AN ANSWER, not a failure to look.
  // A vault the run enumerated successfully but which holds no conventions file
  // at all fell through to `selected` and came back as "could not be read",
  // sending the reader after a permissions problem that does not exist.
  test('a vault inspected and found to hold no conventions file is examined, not unread', () => {
    const { findings, counts } = run({
      findings: [],
      locations: [],
      selected: ['Tribu'],
      inspected: ['Tribu'],
    });
    assert.equal(findings[0].coverage, EXCLUSION_COVERAGE.EXAMINED);
    assert.equal(counts.examined, 1);
    assert.equal(counts.unread, 0);
  });

  // An entry naming a convention nothing compared was never searched for, so
  // "not found in this file" is an answer nobody established.
  test('a record naming a convention the library does not provide is told so', () => {
    const { findings, counts } = run({
      findings: [],
      locations: LOCATIONS,
      compared: ['bilingual', 'source-type'],
    });
    assert.equal(findings[0].coverage, EXCLUSION_COVERAGE.UNKNOWN_CONVENTION);
    assert.match(findings[0].detail, /the snippet library does not provide/);
    // AND THE SUMMARY MUST AGREE WITH THE DETAIL. A first version left the
    // coverage at EXAMINED, so the same entry was described as "the library
    // does not provide this" and counted under "examined and not found" — the
    // report contradicting itself, with the false half being the skimmable one.
    assert.equal(counts['unknown-convention'], 1);
    assert.equal(counts.examined, 0);
  });

  test('with the convention in the compared set, the ordinary sentence comes back', () => {
    const { findings } = run({
      findings: [],
      locations: LOCATIONS,
      compared: ['tribu-routing'],
    });
    assert.match(findings[0].detail, /was not found in it/);
  });

  test('the three coverage counts sum to unmatched', () => {
    const three = readFleetExclusions({
      entries: [
        entry({ vault: 'Tribu', file: 'Documentation/CLAUDE.md' }),
        entry({ vault: 'closed-vault' }),
        entry({ vault: 'never-heard-of-it' }),
      ],
    }).entries;
    const { counts } = applyFleetExclusions({
      findings: [],
      locations: LOCATIONS,
      entries: three,
      selected: ['Tribu', 'closed-vault'],
    });
    assert.equal(counts.unmatched, 3);
    assert.equal(
      counts.examined + counts.unread + counts.outside + counts['unknown-convention'],
      counts.unmatched,
    );
    assert.deepEqual(
      { examined: counts.examined, unread: counts.unread, outside: counts.outside },
      { examined: 1, unread: 1, outside: 1 },
    );
  });

  test('the input findings are not mutated in place', () => {
    const input = finding();
    const before = { ...input };
    run({ findings: [input] });
    assert.deepEqual(input, before);
  });
});

describe('the record can never buy silence', () => {
  // THE ONE INVARIANT THAT MAKES THE WHOLE THING SAFE TO LOSE. Fleet drift is a
  // warning by contract, so an exclusion only ever rewords a warning. If a
  // record could lower an ERROR, then deleting the file would change what the
  // report says about correctness — and every argument for treating an absent
  // file as "no exclusions" collapses.
  // THIS TEST WAS VACUOUS ONCE, and the way it was vacuous is worth keeping in
  // view: it carried this exact name and asserted only `findings.length === 1`.
  // It passed while the code it was named after did the opposite. A test must
  // assert the property in its title, not a neighbour of it.
  // A GOVERNED FILE'S DECLARATION ERROR IS SOMEBODY ELSE'S ANSWER. The record
  // is about whether two texts may differ; `undeclared` is about whether the
  // file was allowed to carry the section at all. The first version matched on
  // identity alone and overwrote that verdict, its reason AND its detail with
  // the exclusion's — replacing the diagnosis of one problem with the excuse
  // for another.
  test('a finding that answers a DIFFERENT question about the same pair is left alone', () => {
    const other = finding({
      severity: 'error',
      verdict: 'undeclared',
      reason: null,
      detail: 'propagate the change, or record the divergence in the baseline with a reason',
    });
    const { findings, counts } = run({ findings: [other] });
    assert.deepEqual(findings[0], other, 'the diagnosis is neither dropped nor rewritten by a record that is not about it');
    assert.equal(counts.excluded, 0, 'nor counted as an exclusion');
    // And because nothing comparable was produced for this pair, the record
    // itself is reported as uncheckable rather than silently ignored.
    assert.equal(findings.length, 2);
    assert.equal(findings[1].verdict, FLEET_EXCLUSION.UNEVALUATED);
  });

  test('the observation finding is annotated while its sibling diagnostic is not', () => {
    const declaration = finding({
      severity: 'error', verdict: 'unexpected-convention', detail: 'installed here but not declared',
    });
    const observation = finding();
    const { findings, counts } = run({ findings: [declaration, observation] });
    assert.deepEqual(findings[0], declaration, 'the declaration verdict survives intact');
    assert.equal(findings[1].verdict, FLEET_EXCLUSION.EXCLUDED);
    assert.equal(counts.excluded, 1, 'one pair, one exclusion — not one per finding');
  });

  // Belt and braces: even on a verdict the record IS about, an error keeps its
  // rank. `duplicate-identity` is an error on a governed file and an
  // observation verdict, so this branch is reachable.
  test('an error keeps its rank on a verdict the record may speak to', () => {
    const { findings } = run({
      findings: [finding({ severity: 'error', status: 'duplicate', verdict: 'duplicate-identity', targetSha256: null })],
    });
    assert.equal(findings[0].verdict, FLEET_EXCLUSION.UNVERIFIABLE);
    assert.equal(findings[0].severity, 'error');
  });

  test('the severity a finding arrived with stays readable after it is quietened', () => {
    const { findings } = run();
    assert.equal(findings[0].severity, 'info');
    assert.equal(findings[0].severityBefore, 'warning', 'a reader must be able to tell quietened from never-serious');
  });

  test('annotatedSeverity quietens a warning but never an error', () => {
    // Quieting a WARNING is the feature — an exclusion exists to say "settled".
    assert.equal(annotatedSeverity('warning', 'info'), 'info');
    assert.equal(annotatedSeverity('info', 'warning'), 'warning');
    // Quieting an ERROR is outside the record's jurisdiction, in both directions.
    assert.equal(annotatedSeverity('error', 'info'), 'error');
    assert.equal(annotatedSeverity('error', 'warning'), 'error');
    // An unknown incoming severity is treated as an ordinary observation, not
    // as an error: guessing the other way would let a malformed finding silence
    // the whole annotation.
    assert.equal(annotatedSeverity(undefined, 'warning'), 'warning');
  });

  // The record says WHICH decision authorised the exclusion. A reader who finds
  // a pair quietly excluded needs the page, not just the sentence — and nothing
  // else in this suite would notice if that field stopped being carried.
  test('the deciding document is carried onto the finding', () => {
    const decided = readFleetExclusions({
      entries: [entry({ decision: 'exclusions-de-propagation-des-conventions' })],
    }).entries;
    const { findings } = run({ entries: decided });
    assert.equal(findings[0].exclusionDecision, 'exclusions-de-propagation-des-conventions');

    const unmatchedRun = applyFleetExclusions({ findings: [], locations: [], entries: decided });
    assert.equal(unmatchedRun.findings[0].exclusionDecision, 'exclusions-de-propagation-des-conventions');
  });

  test('no finding is ever removed, whatever the record says', () => {
    const many = [finding(), finding({ convention: 'bilingual' }), finding({ convention: 'source-type' })];
    for (const over of [
      { findings: many },
      { findings: many.map((f) => ({ ...f, targetSha256: SHA_C })) },
      { findings: many.map((f) => ({ ...f, status: 'identical' })) },
    ]) {
      const { findings } = run(over);
      assert.ok(findings.length >= many.length, 'applying the record must never shrink the report');
    }
  });

  test('an empty record changes nothing at all', () => {
    const input = [finding(), finding({ convention: 'bilingual' })];
    const { findings, counts } = applyFleetExclusions({
      findings: input, locations: LOCATIONS, entries: [],
    });
    assert.deepEqual(findings, input);
    assert.deepEqual(counts, {
      excluded: 0, stale: 0, obsolete: 0, unverifiable: 0, unmatched: 0, unevaluated: 0,
      examined: 0, unread: 0, outside: 0, 'unknown-convention': 0,
    });
  });

  // THE RENDER IS PART OF THE MECHANISM. `summariseTarget` decides what a
  // reader actually sees, and it keeps only findings that are notable. An
  // `excluded` finding is info-severity and its status is `drift`, so it counts
  // as neither identical nor absent: drop it from `notable` and the pair is
  // reported NOWHERE — a live divergence, deliberately unfixed, invisible.
  test('an excluded pair stays visible in the per-file summary', () => {
    const { findings } = run();
    const { notable, identical, absent } = summariseTarget(findings);
    assert.equal(notable.length, 1, 'an excluded pair must appear in the rendered list');
    assert.equal(notable[0].verdict, FLEET_EXCLUSION.EXCLUDED);
    assert.equal(identical, 0);
    assert.equal(absent, 0);
  });

  for (const verdict of [FLEET_EXCLUSION.STALE, FLEET_EXCLUSION.OBSOLETE, FLEET_EXCLUSION.UNVERIFIABLE]) {
    test(`a ${verdict} pair stays visible in the per-file summary`, () => {
      const { notable } = summariseTarget([finding({ severity: 'warning', verdict })]);
      assert.equal(notable.length, 1);
    });
  }
});

/**
 * THE WIRING, not the helper. Everything above tests pure functions; none of it
 * can tell whether the CLI reads the record at all, whether a broken location
 * reaches the exit code, or whether an absent file is the ordinary state the
 * design claims. A review round found the ENOTDIR case sitting on the wrong
 * side of exactly that line, invisible to every unit test here.
 */
describe('the --fleet wiring', () => {
  const fleet = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'excl-fleet-'));
    const vault = path.join(root, 'vault-one');
    fs.mkdirSync(path.join(vault, 'Documentation'), { recursive: true });
    fs.writeFileSync(
      path.join(vault, 'Documentation', 'CLAUDE.md'),
      '# Rules\n\n## Languages convention (declared per vault)\n\ndrifted on purpose\n',
    );
    const configPath = path.join(root, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ portRegistry: { [vault]: { port: 1 } } }));
    return { root, vault, configPath };
  };

  const run = (configPath, exclusionsPath) => {
    const r = spawnSync(
      process.execPath,
      [DRIFT_CLI, '--fleet', '--config', configPath, '--exclusions', exclusionsPath, '--json'],
      { encoding: 'utf8', cwd: REPO },
    );
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { /* left null on purpose */ }
    return { status: r.status, json, stderr: r.stderr };
  };

  test('an absent record is an ordinary state: exit 0, and the report says so', () => {
    const { root, configPath } = fleet();
    try {
      const r = run(configPath, path.join(root, 'no-such-record.json'));
      assert.equal(r.status, 0);
      assert.equal(r.json.exclusions.present, false);
      assert.equal(r.json.exclusions.entries, 0);
      assert.deepEqual(r.json.exclusions.ioErrors, []);
      assert.equal(r.json.ok, true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  // A PATH WHOSE PARENT IS A FILE IS A MALFORMED LOCATION, NOT A MISSING
  // RECORD. `locateVaultClaudeMd` accepts ENOTDIR as absence — rightly, a
  // missing directory means the candidate is not there — and the first version
  // of this wiring copied that rule to a path the caller NAMED. It reported "no
  // exclusions" and exited 0.
  // OBSERVABLE EVERYWHERE: a directory where the record should be gives EISDIR
  // on every platform, so this is the witness that "any read failure that is
  // not ENOENT fails the run" cannot go vacuous on any CI runner.
  test('a directory where the record should be fails the run', () => {
    const { root, configPath } = fleet();
    try {
      const asDir = path.join(root, 'exclusions.json');
      fs.mkdirSync(asDir);
      const r = run(configPath, asDir);
      assert.equal(r.status, 1, 'a location that is not a file must not read as an absent record');
      assert.ok(r.json.exclusions.ioErrors.length > 0, JSON.stringify(r.json.exclusions));
      assert.equal(r.json.ok, false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  // NO PLATFORM SPLIT, AND THAT IS THE POINT. Measured 2026-09-14: reading
  // `<a regular file>/x.json` raises ENOTDIR on POSIX and ENOENT on Windows, so
  // an implementation that trusts the error code can only be right on one of
  // them. A first version skipped this test on win32 and left the behaviour
  // broken there; the ancestor walk answers the same question on both, so the
  // witness runs everywhere — a skipped test is a test that does not run.
  test('a record path whose parent is a regular file fails the run', () => {
    const { root, configPath } = fleet();
    try {
      const notADir = path.join(root, 'not-a-directory');
      fs.writeFileSync(notADir, 'i am a file\n');
      const r = run(configPath, path.join(notADir, 'exclusions.json'));
      assert.equal(r.status, 1, 'a malformed location must not read as an absent optional record');
      assert.ok(r.json.exclusions.ioErrors.length > 0, JSON.stringify(r.json.exclusions));
      assert.equal(r.json.ok, false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  // THE BLOCKER CAN BE ARBITRARILY FAR UP. A first version walked at most 64
  // ancestors and then returned the same answer as a verified-empty tree — "I
  // gave up" and "I looked everywhere" sharing a return value. 80 components is
  // comfortably past that budget and still a legal path length here.
  test('a blocking file far above the record path still fails the run', () => {
    const { root, configPath } = fleet();
    try {
      const blocker = path.join(root, 'blocker');
      fs.writeFileSync(blocker, 'i am a file\n');
      const deep = path.join(blocker, ...Array.from({ length: 80 }, (_, i) => `d${i}`), 'exclusions.json');
      const r = run(configPath, deep);
      assert.equal(r.status, 1, 'depth must not turn a malformed location into an absent record');
      assert.ok(r.json.exclusions.ioErrors.length > 0, JSON.stringify(r.json.exclusions));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  // A DANGLING LINK AT THE RECORD PATH ALSO READS ENOENT, and the ancestor walk
  // starts at the PARENT, so it never looks at the link itself. Something is
  // there; it just does not resolve — which is not the same as nobody having
  // put a record there.
  //
  // GATED ON A CAPABILITY, NOT ON A PLATFORM, and the difference matters: an
  // unprivileged Windows session cannot create a symlink at all, so the case
  // cannot be expressed there rather than behaving differently. The probe says
  // which it is, and CI's Linux runners exercise the witness for real.
  // UNAVAILABLE IS NOT GREEN. A first version returned normally after asserting
  // the setup error, so a run that never invoked the CLI counted as a pass and
  // "0 skipped" said nothing about whether the witness had executed. It now
  // marks itself SKIPPED with the reason, which is the honest report: an
  // unprivileged Windows session cannot create a symlink, so the case cannot be
  // expressed there. CI's Linux runners execute it for real.
  for (const [what, make] of [
    ['the record path itself', (root, rec) => fs.symlinkSync(path.join(root, 'no-such-target.json'), rec)],
    // The ANCESTOR case needs `lstat` in the walk: a plain `stat` FOLLOWS the
    // dead link and fails exactly like a component that never existed, so the
    // walk climbs past it and reports absence for a location that plainly
    // exists and is broken.
    ['an ancestor of it', (root, rec) => {
      const home = path.join(root, 'record-home');
      fs.symlinkSync(path.join(root, 'no-such-directory'), home, 'dir');
      return path.join(home, path.basename(rec));
    }],
  ]) {
    test(`a link that does not resolve fails the run: ${what}`, (t) => {
      const { root, configPath } = fleet();
      let target = path.join(root, 'exclusions.json');
      try {
        target = make(root, target) ?? target;
      } catch (err) {
        fs.rmSync(root, { recursive: true, force: true });
        t.skip(`this environment cannot create a symlink (${err.code}) — the case cannot be expressed here`);
        return;
      }
      try {
        const r = run(configPath, target);
        assert.equal(r.status, 1, 'something is at that path — it is not an absent record');
        assert.ok(r.json.exclusions.ioErrors.length > 0, JSON.stringify(r.json.exclusions));
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
  }

  for (const [what, body] of [
    ['invalid JSON', '{ not json'],
    ['a zero-byte file', ''],
    ['literal null', 'null'],
    ['an object with no entries', '{}'],
    ['a misspelt entries key', '{"entires": []}'],
  ]) {
    test(`a malformed record fails the run: ${what}`, () => {
      const { root, configPath } = fleet();
      try {
        const rec = path.join(root, 'exclusions.json');
        fs.writeFileSync(rec, body);
        const r = run(configPath, rec);
        assert.equal(r.status, 1, `${what} must fail the run`);
        assert.equal(r.json.ok, false);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
  }

  test('an empty record is legal and changes nothing', () => {
    const { root, configPath } = fleet();
    try {
      const rec = path.join(root, 'exclusions.json');
      fs.writeFileSync(rec, '{"entries": []}');
      const r = run(configPath, rec);
      assert.equal(r.status, 0);
      assert.equal(r.json.exclusions.present, true);
      assert.equal(r.json.counts.drift, 1);
      assert.equal(r.json.exclusions.counts.excluded, 0);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  // THE FULL LOOP, with fingerprints taken from the run itself rather than
  // hardcoded: record the pair, see it excluded; move one text, see it stale.
  test('a recorded pair renders as excluded, and editing the vault text makes it stale', () => {
    const { root, vault, configPath } = fleet();
    try {
      const rec = path.join(root, 'exclusions.json');
      const first = run(configPath, path.join(root, 'absent.json'));
      const drift = first.json.findings.find((f) => f.status === 'drift');
      assert.ok(drift, 'the fixture must drift before anything is recorded');

      fs.writeFileSync(rec, JSON.stringify({
        entries: [{
          vault: 'vault-one',
          file: 'Documentation/CLAUDE.md',
          convention: drift.convention,
          snippetSha256: drift.snippetSha256,
          targetSha256: drift.targetSha256,
          reason: 'the fixture keeps its own text on purpose',
        }],
      }));

      const excluded = run(configPath, rec);
      assert.equal(excluded.status, 0);
      assert.equal(excluded.json.exclusions.counts.excluded, 1);
      assert.equal(excluded.json.exclusions.counts.unmatched, 0);
      const hit = excluded.json.findings.find((f) => f.verdict === FLEET_EXCLUSION.EXCLUDED);
      assert.match(hit.reason, /keeps its own text/);

      // Now move the vault's side. The record must stop matching — this is the
      // whole mechanism, exercised end to end rather than in a unit.
      fs.appendFileSync(path.join(vault, 'Documentation', 'CLAUDE.md'), '\none more rule the owner added\n');
      const stale = run(configPath, rec);
      assert.equal(stale.json.exclusions.counts.excluded, 0);
      assert.equal(stale.json.exclusions.counts.stale, 1, 'an edited vault text must bring the pair back');
      const back = stale.json.findings.find((f) => f.verdict === FLEET_EXCLUSION.STALE);
      assert.match(back.detail, /text has changed/);
      // Still a WARNING, and still exit 0: what a vault says never fails the run.
      assert.equal(back.severity, 'warning');
      assert.equal(stale.status, 0);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('a record naming a file the examined vault does not have is reported in scope', () => {
    const { root, configPath } = fleet();
    try {
      const rec = path.join(root, 'exclusions.json');
      fs.writeFileSync(rec, JSON.stringify({
        entries: [{
          vault: 'vault-one',
          file: 'wiki-meta/CLAUDE.md',
          convention: 'languages',
          snippetSha256: SHA_A,
          targetSha256: SHA_B,
          reason: 'points at a location this vault does not use',
        }],
      }));
      const r = run(configPath, rec);
      assert.equal(r.json.exclusions.counts.unmatched, 1);
      const f = r.json.findings.find((x) => x.verdict === FLEET_EXCLUSION.UNMATCHED);
      assert.equal(f.inScope, true, 'the vault WAS examined — this is a real finding, not an out-of-scope record');
      assert.match(f.detail, /WAS examined/);
      assert.equal(r.status, 0, 'but it is still only a warning');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
