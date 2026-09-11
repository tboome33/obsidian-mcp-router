/**
 * CONVENTION DRIFT — the same rule written twice, and what it takes to notice.
 *
 * WHY THIS EXISTS. A convention lives both as a snippet under
 * `skills/conventions/snippets/` and as a section inside a `CLAUDE.md` that an
 * agent reads at session start. Nothing compared the two until 2026-09-11, when
 * a measurement over the reference vault found FIVE of its eight installed
 * conventions drifted — including `default-vault-health-check`, which had lost
 * the entire "never fall back to the filesystem" rule added after a real
 * incident, and `heading-hierarchy`, frozen at roughly its v0.8.x state and
 * missing the whole frontmatter contract for decision pages.
 *
 * WHAT THESE TESTS MUST NOT DO is settle which side is right. The measurement
 * refutes that framing twice, in opposite directions: `path-disambiguation`
 * differs because the SNIPPET was anonymised for public distribution, and
 * `auto-enrichment` differs because the CONSIGNE is newer. So the module
 * reports a fact and the baseline records a human's judgement — and the tests
 * below pin the reporting, never a direction.
 *
 * THE ACCEPTANCE TEST is at the bottom: the checker run against this repository
 * as it actually is. That is the one that fails when somebody edits a snippet
 * and forgets the copy beside it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

import {
  DRIFT_STATUS,
  auditConventionDrift,
  compareConvention,
  conventionFingerprint,
  countDriftLines,
  normaliseConventionLines,
  normaliseTargetFile,
  readDriftBaseline,
} from '../src/helpers/convention-drift.mjs';
import {
  GOVERNED_TARGETS,
  DEFAULT_BASELINE,
  DEFAULT_SNIPPETS_DIR,
  driftSize,
  loadSnippetLibrary,
  locateVaultClaudeMd,
  statusLabel,
  summariseTarget,
} from '../scripts/conventions-drift.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A snippet as the audit consumes it. */
const snip = (id, heading, body) => ({ id, heading, text: `## ${heading}\n\n${body}\n` });

/** The library's shape, minus the disk. */
const ALPHA = snip('alpha', 'Alpha convention', 'One rule.\n\nAnd a second paragraph.');

describe('what a convention COMPARES AS', () => {
  test('a CRLF copy and an LF copy are the same text', () => {
    // Not cosmetic, and not hypothetical: this repository has already turned a
    // check red on Windows and vacuous everywhere else with a fixture that
    // assumed LF. Since the fingerprints are taken over this output, a checkout
    // with autocrlf on cannot move them.
    const lf = '## Alpha\n\nbody\n';
    const crlf = '## Alpha\r\n\r\nbody\r\n';
    assert.deepEqual(normaliseConventionLines(crlf), normaliseConventionLines(lf));
    assert.equal(conventionFingerprint(crlf), conventionFingerprint(lf));
  });

  test('a lone CR terminator is normalised too', () => {
    assert.deepEqual(normaliseConventionLines('a\r\nb'), ['a', 'b']);
  });

  test('trailing blank lines are dropped — a section carries its neighbour\'s separation', () => {
    // The section cut out of a CLAUDE.md runs to the line before the next
    // heading, so it ends with the blank lines that separate it. A snippet file
    // ends with one newline. Reporting that as drift would flag all eight
    // conventions of every vault forever.
    assert.equal(conventionFingerprint('## A\n\nbody\n'), conventionFingerprint('## A\n\nbody\n\n\n\n'));
  });

  test('an INTERIOR blank line is content, and is NOT normalised away', () => {
    // The witness for the real `wiki-query-first` drift: the whole divergence
    // between the snippet and the reference vault is one blank line before a
    // `### Anti-patterns` heading. A normaliser that collapsed interior blanks
    // would report that pair as identical and lose the finding.
    assert.notEqual(
      conventionFingerprint('## A\n\n### B\n- x\n'),
      conventionFingerprint('## A\n\n### B\n\n- x\n'),
    );
  });

  test('leading whitespace is content — an indented line is not the same line', () => {
    assert.notEqual(conventionFingerprint('## A\n\nbody\n'), conventionFingerprint('## A\n\n  body\n'));
  });

  test('a non-string is no lines, not a crash', () => {
    assert.deepEqual(normaliseConventionLines(null), []);
    assert.deepEqual(normaliseConventionLines(undefined), []);
    assert.deepEqual(normaliseConventionLines(42), []);
  });
});

describe('the drift SIZE', () => {
  test('identical texts differ by zero lines', () => {
    assert.deepEqual(countDriftLines(['a', 'b'], ['a', 'b']), { count: 0, exact: true });
  });

  test('one changed line counts as two — the one removed and the one added', () => {
    // What `diff` prints with a marker, which is the number the 2026-09-11
    // measurement recorded. A reader comparing this tool's output against that
    // table must get the same figures.
    assert.deepEqual(countDriftLines(['a', 'x'], ['a', 'y']), { count: 2, exact: true });
  });

  test('an inserted line counts as one', () => {
    assert.deepEqual(countDriftLines(['a', 'b'], ['a', 'new', 'b']), { count: 1, exact: true });
  });

  test('it uses the longest common subsequence, not a positional comparison', () => {
    // A positional zip would call these four changed lines; they are two
    // insertions around an unchanged body.
    const before = ['b', 'c'];
    const after = ['a', 'b', 'c', 'd'];
    assert.deepEqual(countDriftLines(before, after), { count: 2, exact: true });
  });

  test('an empty side counts every line of the other', () => {
    assert.deepEqual(countDriftLines([], ['a', 'b']), { count: 2, exact: true });
    assert.deepEqual(countDriftLines(['a'], []), { count: 1, exact: true });
  });

  test('a pathological pair degrades to an UNDER-estimate, and says so', () => {
    // The exact answer is a table of n*m cells. Past the budget the count falls
    // back to the multiset difference, which pairs lines across moves that
    // `diff` would not — so it can only under-report. `exact: false` is what
    // makes the caller print "at least"; a fallback that claimed exactness
    // would be worse than the slow path.
    const a = Array.from({ length: 2100 }, (_, i) => `line ${i}`);
    const b = a.slice().reverse();
    const result = countDriftLines(a, b);
    assert.equal(result.exact, false, 'the budget was exceeded, so the count is a lower bound');
    assert.equal(result.count, 0, 'every line still pairs up: reordering is invisible to a multiset');
  });

  test('a non-array is not a crash', () => {
    assert.deepEqual(countDriftLines(null, undefined), { count: 0, exact: true });
  });
});

describe('locating the section — the fence is the whole difficulty', () => {
  test('a fenced `## ` inside a convention does NOT end it', () => {
    // Both the `bilingual` and `path-disambiguation` snippets contain fenced
    // `## ` lines. A line-based splitter cuts them in half and then reports the
    // halves as drift — inventing a divergence in somebody's rules, which is as
    // bad as missing one.
    const body = [
      'Intro.',
      '',
      '```markdown',
      '## 🇫🇷 Version française',
      '',
      '## 🇬🇧 English version',
      '```',
      '',
      'Outro.',
    ].join('\n');
    const snippet = snip('bilingualish', 'Bilingual convention', body);
    const file = `# Vault\n\n${snippet.text}\n## Next section\n\nother\n`;
    const result = compareConvention(snippet, file);
    assert.equal(result.status, DRIFT_STATUS.IDENTICAL, 'the whole section, fence included, must round-trip');
  });

  test('a HALF-captured section reports as drift — the failure this guards against', () => {
    // The inverse witness. If the extraction ever stops at the fenced heading,
    // the comparison sees a truncated section and reports drift. Asserting the
    // truncated text really is drift is what makes the test above mean
    // something: without it, a broken extractor could satisfy the first test by
    // reporting `identical` for everything.
    const truncated = '## Bilingual convention\n\nIntro.\n\n```markdown\n';
    const snippet = snip('bilingualish', 'Bilingual convention', 'Intro.\n\n```markdown\n## Inner\n```\n\nOutro.');
    const result = compareConvention(snippet, `${truncated}`);
    assert.equal(result.status, DRIFT_STATUS.DRIFT);
    assert.ok(result.driftLines > 0);
  });

  test('a convention merely SHOWN inside a fence is not installed', () => {
    const snippet = ALPHA;
    const file = '# Doc\n\nHere is what it looks like:\n\n```markdown\n## Alpha convention\n\nOne rule.\n```\n';
    assert.equal(compareConvention(snippet, file).status, DRIFT_STATUS.ABSENT);
  });

  test('a subsection belongs to the convention; a sibling H2 ends it', () => {
    const snippet = snip('alpha', 'Alpha convention', 'Body.\n\n### Detail\n\nMore.');
    const file = `${snippet.text}\n## Something else\n\nnot mine\n`;
    assert.equal(compareConvention(snippet, file).status, DRIFT_STATUS.IDENTICAL);
  });
});

describe('absent is not a weak drift', () => {
  test('a convention that was never installed reports ABSENT, with no line count', () => {
    // The reference vault deliberately carries eight of the twelve. Folding
    // "never installed" into "drifted" turns every uninstalled convention into
    // a repair task and buries the real ones.
    const result = compareConvention(ALPHA, '# Doc\n\n## Other\n\nbody\n');
    assert.equal(result.status, DRIFT_STATUS.ABSENT);
    assert.equal(result.driftLines, 0);
    assert.equal(result.targetSha256, null, 'there is no target text to fingerprint');
  });

  test('and the audit files it as info, never as a finding to act on', () => {
    const { findings, counts } = auditConventionDrift({
      snippets: [ALPHA],
      targets: [{ file: 'x.md', content: '# Doc\n', governed: true }],
    });
    assert.equal(counts.errors, 0, 'a governed file may legitimately carry a subset');
    assert.equal(findings[0].severity, 'info');
    assert.equal(findings[0].verdict, 'not-installed');
  });

  test('a heading that only RESEMBLES the identity is absent, not a match', () => {
    // The picker fix paid for this one: `## Alpha convention — mes ajouts` is
    // the user's own section. A prefix or substring match would compare their
    // writing against a snippet and report it as drifted library text.
    const file = '## Alpha convention — mes ajouts\n\nmine\n';
    assert.equal(compareConvention(ALPHA, file).status, DRIFT_STATUS.ABSENT);
  });

  test('the same identity twice is DUPLICATE — there is no single section to compare', () => {
    const file = `${ALPHA.text}\n## Other\n\nx\n\n${ALPHA.text}`;
    const result = compareConvention(ALPHA, file);
    assert.equal(result.status, DRIFT_STATUS.DUPLICATE);
    assert.equal(result.occurrences, 2);
    assert.equal(result.targetSha256, null, 'a fingerprint here would be a verdict about bytes the reader cannot locate');
  });
});

describe('the baseline is a signed photograph, not an exemption', () => {
  const drifted = { file: 'a.md', content: '## Alpha convention\n\nOne rule.\n\nEDITED.\n', governed: true };
  const shas = () => {
    const r = compareConvention(ALPHA, drifted.content);
    return { snippetSha256: r.snippetSha256, targetSha256: r.targetSha256 };
  };
  const entry = (over = {}) => ({
    file: 'a.md', convention: 'alpha', reason: 'deliberate, because X', ...shas(), ...over,
  });

  test('an undeclared drift in a GOVERNED file is an error', () => {
    const audit = auditConventionDrift({ snippets: [ALPHA], targets: [drifted] });
    assert.equal(audit.ok, false);
    assert.equal(audit.findings[0].verdict, 'undeclared');
    assert.equal(audit.findings[0].severity, 'error');
  });

  test('the same drift in an OBSERVED vault is a warning, and never fails the run', () => {
    // A vault's CLAUDE.md belongs to its owner, who may have edited a section
    // on purpose. The fleet report informs; it does not accuse.
    const audit = auditConventionDrift({
      snippets: [ALPHA],
      targets: [{ ...drifted, governed: false }],
    });
    assert.equal(audit.ok, true);
    assert.equal(audit.findings[0].severity, 'warning');
    assert.equal(audit.findings[0].verdict, 'observed');
  });

  test('a matching entry accepts it, and carries the reason into the report', () => {
    const audit = auditConventionDrift({
      snippets: [ALPHA], targets: [drifted], baseline: { entries: [entry()] },
    });
    assert.equal(audit.ok, true);
    assert.equal(audit.findings[0].verdict, 'accepted');
    assert.equal(audit.findings[0].reason, 'deliberate, because X');
    assert.equal(audit.counts.accepted, 1);
  });

  test('editing the TARGET breaks the acceptance', () => {
    const audit = auditConventionDrift({
      snippets: [ALPHA],
      targets: [{ ...drifted, content: `${drifted.content}one more line\n` }],
      baseline: { entries: [entry()] },
    });
    assert.equal(audit.ok, false);
    assert.equal(audit.findings[0].verdict, 'baseline-stale');
    assert.match(audit.findings[0].detail, /the target has changed/);
  });

  test('editing the SNIPPET breaks the acceptance — this is the CI gate', () => {
    // The requirement in one test: changing a snippet without propagating it
    // must turn something red, even where a divergence was already accepted.
    const edited = { ...ALPHA, text: `${ALPHA.text}a new rule\n` };
    const audit = auditConventionDrift({
      snippets: [edited], targets: [drifted], baseline: { entries: [entry()] },
    });
    assert.equal(audit.ok, false);
    assert.equal(audit.findings[0].verdict, 'baseline-stale');
    assert.match(audit.findings[0].detail, /the snippet has changed/);
  });

  test('an entry whose pair is now IN STEP is obsolete, and is an error', () => {
    // A stale acceptance is a loaded gun: the day the pair drifts again, a
    // matching entry could silently bless it.
    const audit = auditConventionDrift({
      snippets: [ALPHA],
      targets: [{ file: 'a.md', content: ALPHA.text, governed: true }],
      baseline: { entries: [entry()] },
    });
    assert.equal(audit.ok, false);
    assert.equal(audit.findings[0].verdict, 'baseline-obsolete');
  });

  test('an entry whose convention is no longer in the file is obsolete too', () => {
    const audit = auditConventionDrift({
      snippets: [ALPHA],
      targets: [{ file: 'a.md', content: '# nothing\n', governed: true }],
      baseline: { entries: [entry()] },
    });
    assert.equal(audit.ok, false);
    assert.equal(audit.findings[0].verdict, 'baseline-obsolete');
  });

  test('an entry naming a file the audit never examined is an error, not silence', () => {
    // A typo in `file` would otherwise read as a passing acceptance forever.
    const audit = auditConventionDrift({
      snippets: [ALPHA], targets: [drifted],
      baseline: { entries: [entry(), entry({ file: 'typo.md' })] },
    });
    const unmatched = audit.findings.filter((f) => f.verdict === 'baseline-unmatched');
    assert.equal(unmatched.length, 1);
    assert.equal(unmatched[0].file, 'typo.md');
    assert.equal(audit.ok, false);
  });

  test('a baseline entry never applies to an observed vault', () => {
    // Otherwise one accepted divergence would bless the same bytes across 27
    // vaults that nobody looked at.
    const audit = auditConventionDrift({
      snippets: [ALPHA],
      targets: [{ ...drifted, governed: false }],
      baseline: { entries: [entry()] },
    });
    assert.equal(audit.findings[0].verdict, 'observed');
    const unmatched = audit.findings.filter((f) => f.verdict === 'baseline-unmatched');
    assert.equal(unmatched.length, 1, 'and the entry is reported as never examined');
  });

  test('an entry with no reason is refused at read time', () => {
    const { entries, errors } = readDriftBaseline({ entries: [{ ...entry(), reason: '   ' }] });
    assert.equal(entries.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /must say why/);
  });

  test('an entry whose fingerprint is not a sha256 is refused', () => {
    const { errors } = readDriftBaseline({ entries: [entry({ targetSha256: 'nope' })] });
    assert.ok(errors.some((e) => /targetSha256. is not a sha256/.test(e)));
  });

  test('two entries for one pair are refused — the second would be unreachable', () => {
    const { entries, errors } = readDriftBaseline({ entries: [entry(), entry()] });
    assert.equal(entries.length, 1);
    assert.ok(errors.some((e) => /duplicate entry/.test(e)));
  });

  test('a refused baseline makes the audit fail rather than run unguarded', () => {
    const audit = auditConventionDrift({
      snippets: [ALPHA], targets: [drifted],
      baseline: { entries: [{ ...entry(), reason: '' }] },
    });
    assert.equal(audit.ok, false, 'a malformed baseline must not read as an empty one');
  });

  test('a fingerprint is matched case-insensitively but structurally', () => {
    const e = entry();
    const audit = auditConventionDrift({
      snippets: [ALPHA], targets: [drifted],
      baseline: { entries: [{ ...e, targetSha256: e.targetSha256.toUpperCase() }] },
    });
    assert.equal(audit.findings[0].verdict, 'accepted');
  });

  test('a Windows-keyed entry matches a POSIX-keyed target', () => {
    const audit = auditConventionDrift({
      snippets: [ALPHA],
      targets: [{ ...drifted, file: 'templates\\wiki\\CLAUDE.md' }],
      baseline: { entries: [entry({ file: 'templates/wiki/CLAUDE.md' })] },
    });
    assert.equal(audit.findings[0].verdict, 'accepted');
  });
});

describe('every pair produces exactly one finding', () => {
  test('including the pairs that are in step', () => {
    // The first version emitted nothing for a pair in step, and the very first
    // real run printed "0 identical" for a file whose convention it had just
    // verified — the renderer counts from the findings.
    const audit = auditConventionDrift({
      snippets: [ALPHA, snip('beta', 'Beta convention', 'x')],
      targets: [
        { file: 'a.md', content: ALPHA.text, governed: true },
        { file: 'b.md', content: '# empty\n', governed: false },
      ],
    });
    assert.equal(audit.findings.length, 4, '2 snippets x 2 targets');
    const inStep = audit.findings.filter((f) => f.verdict === 'in-step');
    assert.equal(inStep.length, 1);
    assert.equal(inStep[0].status, DRIFT_STATUS.IDENTICAL);
  });

  test('a caller can find a target\'s findings using the same normaliser', () => {
    // The defect this pins: the fleet report built its filter key from a raw
    // `C:\…` path while the findings were keyed `C:/…`. Fifteen vaults, 75
    // drifting conventions, nothing printed, exit code 0. A silent empty report
    // is the worst outcome for a tool whose job is to end a silence.
    const raw = 'C:\\VAULTS\\x\\Documentation\\CLAUDE.md';
    const audit = auditConventionDrift({
      snippets: [ALPHA], targets: [{ file: raw, content: ALPHA.text, governed: false }],
    });
    const mine = audit.findings.filter((f) => f.file === normaliseTargetFile(raw));
    assert.equal(mine.length, 1, 'the exported normaliser is the one key both sides must use');
  });

  test('the counts and the findings agree', () => {
    const audit = auditConventionDrift({
      snippets: [ALPHA],
      targets: [
        { file: 'a.md', content: ALPHA.text, governed: true },
        { file: 'b.md', content: '# empty\n', governed: true },
        { file: 'c.md', content: '## Alpha convention\n\nedited\n', governed: false },
      ],
    });
    assert.equal(audit.counts.identical, 1);
    assert.equal(audit.counts.absent, 1);
    assert.equal(audit.counts.drift, 1);
    assert.equal(
      audit.counts.identical + audit.counts.absent + audit.counts.drift + audit.counts.duplicate,
      audit.findings.length,
    );
  });

  test('no targets and no snippets is an empty, passing audit', () => {
    const audit = auditConventionDrift({});
    assert.deepEqual(audit.findings, []);
    assert.equal(audit.ok, true);
  });
});

describe('the two ways a gate can be walked around — both found by review', () => {
  const dup = (body) => `## Alpha convention\n\n${body}\n\n## Alpha convention\n\nanother one\n`;

  test('a DUPLICATED identity is an error on a governed file', () => {
    // Duplicating the heading produced no comparable section, so neither
    // fingerprint was checked — and because the baseline entry had been looked
    // up and consumed, it raised no `baseline-stale` and no
    // `baseline-unmatched` either. Duplicating a heading was a way to replace
    // an accepted section with arbitrary text and keep the gate green.
    const audit = auditConventionDrift({
      snippets: [ALPHA],
      targets: [{ file: 'a.md', content: dup('arbitrary replacement'), governed: true }],
    });
    assert.equal(audit.ok, false);
    assert.equal(audit.findings[0].verdict, 'duplicate-identity');
    assert.equal(audit.findings[0].severity, 'error');
  });

  test('and it stays a warning on an observed vault', () => {
    // A vault with two copies is its owner's business, and already the state
    // `removeConvention` refuses on.
    const audit = auditConventionDrift({
      snippets: [ALPHA],
      targets: [{ file: 'a.md', content: dup('theirs'), governed: false }],
    });
    assert.equal(audit.ok, true);
    assert.equal(audit.findings[0].severity, 'warning');
  });

  test('a duplicate does not silently consume its baseline entry', () => {
    const drifted = '## Alpha convention\n\nOne rule.\n\nEDITED.\n';
    const r = compareConvention(ALPHA, drifted);
    const entry = {
      file: 'a.md',
      convention: 'alpha',
      reason: 'accepted for a stated reason',
      snippetSha256: r.snippetSha256,
      targetSha256: r.targetSha256,
    };
    const audit = auditConventionDrift({
      snippets: [ALPHA],
      targets: [{ file: 'a.md', content: dup('arbitrary replacement'), governed: true }],
      baseline: { entries: [entry] },
    });
    assert.equal(audit.ok, false, 'an acceptance that could not be validated must not read as validated');
    assert.match(audit.findings[0].detail, /could not be validated/);
  });

  test('a DECLARED convention that has vanished is an error', () => {
    // Delete an installed section, or rename a snippet's heading without
    // touching the copy, and the pair becomes "never installed" — green. The
    // two texts cannot tell those cases apart, so the declaration does.
    const audit = auditConventionDrift({
      snippets: [ALPHA],
      targets: [{ file: 'a.md', content: '# Doc\n\n## Something else\n\nx\n', governed: true, expects: ['alpha'] }],
    });
    assert.equal(audit.ok, false);
    assert.equal(audit.findings[0].verdict, 'missing-convention');
    assert.equal(audit.findings[0].severity, 'error');
  });

  test('renaming a snippet\'s heading is caught as the same disappearance', () => {
    // The second half of the hole, and the one no target-side edit explains:
    // the file is untouched, the LIBRARY moved.
    const renamed = { ...ALPHA, heading: 'Alpha convention, revised', text: '## Alpha convention, revised\n\nOne rule.\n' };
    const audit = auditConventionDrift({
      snippets: [renamed],
      targets: [{ file: 'a.md', content: ALPHA.text, governed: true, expects: ['alpha'] }],
    });
    assert.equal(audit.ok, false);
    assert.equal(audit.findings[0].verdict, 'missing-convention');
  });

  test('an UNDECLARED convention that is present is an error, and is still compared', () => {
    const audit = auditConventionDrift({
      snippets: [ALPHA],
      targets: [{ file: 'a.md', content: ALPHA.text, governed: true, expects: [] }],
    });
    assert.equal(audit.ok, false);
    assert.equal(audit.findings[0].verdict, 'unexpected-convention');
    assert.equal(audit.findings[0].severity, 'error');
    assert.equal(audit.findings[1].verdict, 'in-step', 'the comparison still happens — two questions, two answers');
  });

  test('neither declared nor present stays quiet', () => {
    const audit = auditConventionDrift({
      snippets: [ALPHA],
      targets: [{ file: 'a.md', content: '# Doc\n', governed: true, expects: [] }],
    });
    assert.equal(audit.ok, true);
    assert.equal(audit.findings[0].verdict, 'not-installed');
  });

  test('NO declaration means that half of the check is not performed, not that it passed', () => {
    // `declared: null` is the honest report of "nobody said". An empty Set
    // here would make every convention of an undeclared file "unexpected".
    const audit = auditConventionDrift({
      snippets: [ALPHA],
      targets: [{ file: 'a.md', content: ALPHA.text, governed: true }],
    });
    assert.equal(audit.ok, true);
    assert.equal(audit.findings[0].declared, null);
  });

  test('a declaration never applies to an observed vault', () => {
    const audit = auditConventionDrift({
      snippets: [ALPHA],
      targets: [{ file: 'a.md', content: '# Doc\n', governed: false, expects: ['alpha'] }],
    });
    assert.equal(audit.ok, true);
    assert.equal(audit.findings[0].declared, null);
  });

  test('a vanished convention that still has a baseline entry reports BOTH', () => {
    const r = compareConvention(ALPHA, '## Alpha convention\n\nEDITED\n');
    const audit = auditConventionDrift({
      snippets: [ALPHA],
      targets: [{ file: 'a.md', content: '# Doc\n', governed: true, expects: ['alpha'] }],
      baseline: {
        entries: [{
          file: 'a.md', convention: 'alpha', reason: 'accepted for a stated reason',
          snippetSha256: r.snippetSha256, targetSha256: r.targetSha256,
        }],
      },
    });
    const verdicts = audit.findings.map((f) => f.verdict);
    assert.deepEqual(verdicts, ['missing-convention', 'baseline-obsolete']);
  });
});

describe('a malformed baseline is not an empty baseline', () => {
  // Each of these read as "no accepted divergences" in the first version, so a
  // typo in a key silently discharged every acceptance — including the duty to
  // remove one that had become obsolete.
  for (const [label, doc] of [
    ['a null `entries`', { entries: null }],
    ['a misspelled key', { entires: [] }],
    ['a bare array', []],
    ['null', null],
    ['a string', 'entries'],
    ['an `entries` object', { entries: { a: 1 } }],
  ]) {
    test(`${label} is refused with an error`, () => {
      const { entries, errors } = readDriftBaseline(doc);
      assert.deepEqual(entries, []);
      assert.equal(errors.length, 1, `${label} must produce exactly one error`);
    });
  }

  test('an explicitly empty baseline is valid and silent', () => {
    const { entries, errors } = readDriftBaseline({ entries: [] });
    assert.deepEqual(entries, []);
    assert.deepEqual(errors, []);
  });

  test('only an OMITTED baseline means "none supplied" — a falsy one is a document', () => {
    // `baseline ?` read `null`, `false`, `0` and `''` as "no baseline", so a
    // file containing literal JSON `null` skipped validation entirely and
    // passed as an intentional absence. The malformed-shape tests above could
    // not catch it: they call the reader directly, and this branch is in the
    // audit.
    const target = { file: 'a.md', content: ALPHA.text, governed: true };
    for (const falsy of [null, false, 0, '']) {
      const audit = auditConventionDrift({ snippets: [ALPHA], targets: [target], baseline: falsy });
      assert.equal(audit.ok, false, `baseline: ${JSON.stringify(falsy)} must be validated, not skipped`);
      assert.equal(audit.baselineErrors.length, 1);
    }
    const omitted = auditConventionDrift({ snippets: [ALPHA], targets: [target] });
    assert.equal(omitted.ok, true);
    assert.deepEqual(omitted.baselineErrors, []);
  });
});

describe('a declaration the library cannot answer', () => {
  test('a declared convention whose snippet is GONE is an error', () => {
    // The second-order version of the disappearance hole, hiding inside its own
    // repair: the declaration was only ever checked inside the per-snippet
    // loop, so deleting a snippet stopped its declaration from being evaluated
    // at all. The shipped template kept a section nothing compared, and the
    // check stayed green.
    const audit = auditConventionDrift({
      snippets: [],
      targets: [{ file: 'a.md', content: ALPHA.text, governed: true, expects: ['alpha'] }],
    });
    assert.equal(audit.ok, false);
    assert.equal(audit.findings[0].verdict, 'declared-snippet-missing');
    assert.equal(audit.findings[0].severity, 'error');
  });

  test('it fires per declared id, and not for the ones the library does provide', () => {
    const audit = auditConventionDrift({
      snippets: [ALPHA],
      targets: [{ file: 'a.md', content: ALPHA.text, governed: true, expects: ['alpha', 'ghost'] }],
    });
    const missing = audit.findings.filter((f) => f.verdict === 'declared-snippet-missing');
    assert.deepEqual(missing.map((f) => f.convention), ['ghost']);
  });

  test('an observed vault declares nothing, so it can never trip this', () => {
    const audit = auditConventionDrift({
      snippets: [],
      targets: [{ file: 'a.md', content: ALPHA.text, governed: false, expects: ['alpha'] }],
    });
    assert.equal(audit.ok, true);
    assert.deepEqual(audit.findings, []);
  });
});

describe('the snippet library', () => {
  test('a preamble above the heading does not manufacture drift', () => {
    // The target side is a SECTION extracted at its heading; the snippet side
    // was the whole file. A snippet carrying a distribution comment therefore
    // reported drift against a copy of its own bytes.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snips-pre-'));
    fs.writeFileSync(
      path.join(dir, 'alpha.md'),
      '<!-- distribution metadata -->\n## Alpha convention\n\nOne rule.\n',
    );
    const { snippets, errors } = loadSnippetLibrary(dir);
    assert.deepEqual(errors, []);
    const installed = `# Vault\n\n${snippets[0].text}\n## Next\n\nx\n`;
    assert.equal(compareConvention(snippets[0], installed).status, DRIFT_STATUS.IDENTICAL);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a snippet carrying TWO conventions is refused rather than left to drift forever', () => {
    // `install` appends the whole file while the target-side extractor stops at
    // the second heading, so the pair could never be in step.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snips-two-'));
    fs.writeFileSync(path.join(dir, 'two.md'), '## One\n\na\n\n## Two\n\nb\n');
    const { snippets, errors } = loadSnippetLibrary(dir);
    assert.deepEqual(snippets, []);
    assert.match(errors[0], /exactly one convention/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a fenced `## ` in a snippet is not a second convention', () => {
    // The refusal above must not fire on `bilingual`, which shows headings
    // inside a fenced example.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snips-fence-'));
    fs.writeFileSync(path.join(dir, 'b.md'), '## Bilingual\n\n```markdown\n## 🇫🇷 FR\n\n## 🇬🇧 EN\n```\n');
    const { snippets, errors } = loadSnippetLibrary(dir);
    assert.deepEqual(errors, []);
    assert.equal(snippets.length, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('a count that is a floor never prints as a figure', () => {
  test('the formatter honours exactCount and pluralises', () => {
    assert.equal(driftSize({ driftLines: 0, exactCount: false }), 'at least 0 lines');
    assert.equal(driftSize({ driftLines: 1, exactCount: true }), '1 line');
    assert.equal(driftSize({ driftLines: 4198, exactCount: true }), '4198 lines');
  });

  test('and so does the ACCEPTED label, which is a different call site', () => {
    // Testing the formatter alone does not protect its caller: the accepted
    // branch had its own inline formatting, and a mutation that restores it
    // passes every test that only calls `driftSize`. So the label itself is
    // asserted — a large reordering, where the degraded fallback returns a
    // lower bound of 0, must not print "accepted (0 lines)".
    const label = statusLabel({
      verdict: 'accepted', status: 'drift', driftLines: 0, exactCount: false, severity: 'info',
    });
    assert.match(label, /accepted \(at least 0 lines\)/);
  });

  test('a diagnostic does not inflate the comparison totals', () => {
    // One convention, two findings (an undeclared section is reported AND
    // still compared) printed "2 identical" for a file carrying one.
    const findings = [
      { convention: 'alpha', status: 'identical', severity: 'error', verdict: 'unexpected-convention' },
      { convention: 'alpha', status: 'identical', severity: 'info', verdict: 'in-step' },
    ];
    const summary = summariseTarget(findings);
    assert.equal(summary.identical, 1);
    assert.equal(summary.notable.length, 1);
  });
});

describe('the snippet library, as shipped', () => {
  test('every shipped snippet loads, with a level-2 identity', () => {
    const { snippets, errors } = loadSnippetLibrary(path.join(REPO, ...DEFAULT_SNIPPETS_DIR.split('/')));
    assert.deepEqual(errors, []);
    assert.ok(snippets.length >= 12, `expected the shipped library, got ${snippets.length}`);
    for (const s of snippets) {
      assert.ok(s.heading.length > 0, `${s.id} has no identity`);
      assert.ok(s.text.startsWith('## '), `${s.id} must open on its identity`);
    }
  });

  test('each identity is unique — it is what `remove` cuts on', () => {
    const { snippets } = loadSnippetLibrary(path.join(REPO, ...DEFAULT_SNIPPETS_DIR.split('/')));
    const seen = new Map();
    for (const s of snippets) {
      assert.equal(seen.has(s.heading), false, `${s.id} and ${seen.get(s.heading)} share an identity`);
      seen.set(s.heading, s.id);
    }
  });

  test('a snippet whose first heading is not a level-2 one is refused, not guessed at', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snips-'));
    fs.writeFileSync(path.join(dir, 'bad.md'), '# Not a convention\n\nbody\n');
    fs.writeFileSync(path.join(dir, 'good.md'), '## Good convention\n\nbody\n');
    const { snippets, errors } = loadSnippetLibrary(dir);
    assert.equal(snippets.length, 1);
    assert.equal(snippets[0].id, 'good');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /not a convention snippet/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a missing library is an error, not an empty success', () => {
    const { snippets, errors } = loadSnippetLibrary(path.join(os.tmpdir(), 'no-such-dir-ever'));
    assert.deepEqual(snippets, []);
    assert.equal(errors.length, 1);
  });

  test('a snippet round-trips against a file that contains exactly it', () => {
    // The end-to-end shape of the whole check, over the real library: install a
    // snippet verbatim and the detector must call it identical. A detector that
    // cannot do this reports every vault in the fleet as drifted.
    const { snippets } = loadSnippetLibrary(path.join(REPO, ...DEFAULT_SNIPPETS_DIR.split('/')));
    for (const s of snippets) {
      const file = `# Vault rules\n\n${s.text}\n## Afterwards\n\nsomething else\n`;
      const result = compareConvention(s, file);
      assert.equal(result.status, DRIFT_STATUS.IDENTICAL, `${s.id} did not round-trip`);
    }
  });
});

describe('the repository as it actually is', () => {
  test('--check is green: no undeclared drift in the files this repo ships', () => {
    // THE ACCEPTANCE TEST. It fails when somebody edits a snippet and forgets
    // the copy beside it, which is the whole point of the lot. The CLI is run
    // as a subprocess rather than re-implemented here: what CI runs and what
    // this test asserts must be the same code path, including the exit code.
    const out = execFileSync(
      process.execPath,
      [path.join(REPO, 'scripts', 'conventions-drift.mjs'), '--check', '--json'],
      { encoding: 'utf8', cwd: REPO },
    );
    const report = JSON.parse(out);
    const errors = report.findings.filter((f) => f.severity === 'error');
    assert.deepEqual(
      errors.map((f) => `${f.file}: ${f.convention} (${f.verdict})`),
      [],
      'propagate the change, or record the divergence in the baseline with a reason',
    );
    assert.deepEqual(report.baselineErrors, []);
    assert.equal(report.ok, true);
  });

  test('every governed file exists, and its declaration is true of the file', () => {
    const { snippets } = loadSnippetLibrary(path.join(REPO, ...DEFAULT_SNIPPETS_DIR.split('/')));
    const byId = new Map(snippets.map((s) => [s.id, s]));
    for (const { file: rel, expects } of GOVERNED_TARGETS) {
      const abs = path.join(REPO, ...rel.split('/'));
      assert.ok(fs.existsSync(abs), `${rel} is governed by the drift check but is not in the repo`);
      const content = fs.readFileSync(abs, 'utf8');
      // The declaration is only a gate if it is EXHAUSTIVE — checked in both
      // directions, so neither a forgotten entry nor an invented one survives.
      const installed = snippets
        .filter((s) => compareConvention(s, content).status !== DRIFT_STATUS.ABSENT)
        .map((s) => s.id)
        .sort();
      assert.deepEqual([...expects].sort(), installed, `${rel}: the declaration does not match the file`);
      for (const id of expects) assert.ok(byId.has(id), `${rel} declares "${id}", which is not a snippet`);
    }
  });

  test('an unreadable baseline fails the check ON ITS OWN', () => {
    // Deleting the baseline, or breaking its JSON, must not silently discharge
    // every acceptance it held. Run through the CLI: the fallback that made
    // this a silent pass lived there, not in the helper.
    //
    // ISOLATED ON PURPOSE, and it took two attempts. Pointed at the repo's real
    // library, the run fails anyway — the accepted divergence becomes an
    // undeclared one the moment the baseline is gone — so the first version
    // passed with the exit-code guard removed. The second version used a
    // library of one UNRELATED convention, which was worse: it was green only
    // because a declared convention whose snippet is missing was not being
    // checked at all, so this witness was quietly locking in the very hole the
    // next review round found.
    //
    // The control WAS built from the governed files: a temporary library whose
    // snippets were the sections those files carried. That fixture is gone with
    // its subject — the decision `conventions-livrees-par-le-modele` (2026-09-11)
    // took the stylistic conventions out of everything that seeds a new vault,
    // so no governed file carries one and the loop built an EMPTY library, whose
    // run is not green. The isolation the fixture existed for is now a property
    // of the repository itself: with nothing installed anywhere, there is no
    // drift to report, so a run against the real library is green for a reason
    // that has nothing to do with the baseline — which is exactly what the
    // fixture was simulating. The witnesses below can therefore only be red
    // because of the baseline, and the control asserts it before they run.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-'));
    const run = (file) => {
      const r = spawnSync(
        process.execPath,
        [path.join(REPO, 'scripts', 'conventions-drift.mjs'), '--check', '--json', '--baseline', file],
        { encoding: 'utf8', cwd: REPO },
      );
      return { status: r.status, report: JSON.parse(r.stdout) };
    };

    const empty = path.join(dir, 'empty.json');
    fs.writeFileSync(empty, JSON.stringify({ entries: [] }));
    const control = run(empty);
    assert.equal(control.status, 0, 'the control must be green, or the witnesses below prove nothing');

    const absent = run(path.join(dir, 'no-such-file.json'));
    assert.equal(absent.status, 1);
    assert.equal(absent.report.ok, false);
    assert.match(absent.report.baselineErrors.join('\n'), /cannot read the baseline/);

    const broken = path.join(dir, 'broken.json');
    fs.writeFileSync(broken, '{ this is not json');
    const invalid = run(broken);
    assert.equal(invalid.status, 1);
    assert.match(invalid.report.baselineErrors.join('\n'), /not valid JSON/);

    const malformed = path.join(dir, 'malformed.json');
    fs.writeFileSync(malformed, JSON.stringify({ entires: [] }));
    const typo = run(malformed);
    assert.equal(typo.status, 1, 'a misspelled `entries` key must not read as an empty baseline');

    // A file whose CONTENT is `null` is a document, and it is refused by the
    // audit — a different guard from the one above, deliberately kept separate.
    const nulled = path.join(dir, 'null.json');
    fs.writeFileSync(nulled, 'null');
    const nullDoc = run(nulled);
    assert.equal(nullDoc.status, 1);
    assert.match(nullDoc.report.baselineErrors.join('\n'), /must be a JSON object/);
    assert.equal(
      nullDoc.report.baselineErrors.some((e) => /cannot read the baseline/.test(e)),
      false,
      'a file that exists and parses is not an I/O failure — the two verdicts must not blur',
    );

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('the baseline on disk is well-formed, and every entry states a reason', () => {
    const doc = JSON.parse(fs.readFileSync(path.join(REPO, ...DEFAULT_BASELINE.split('/')), 'utf8'));
    const { entries, errors } = readDriftBaseline(doc);
    assert.deepEqual(errors, []);
    for (const e of entries) {
      assert.ok(e.reason.length > 40, `${e.convention} in ${e.file}: the reason must be usable by a reader who was not there`);
    }
  });

  test('nothing that seeds a new vault carries a library convention any more', () => {
    // This assertion REPLACES "the shipped skeleton carries the CURRENT
    // heading-hierarchy", and the reversal is a decision, not a regression.
    // That test pinned a repair: the skeleton's copy had frozen at roughly
    // v0.8.x, 23 lines against 61, and was brought back in step. Hours later
    // `conventions-livrees-par-le-modele` (2026-09-11) settled the question one
    // level up — a vault is not born carrying the stylistic conventions at all,
    // it is offered them by a picker that shows them pre-checked. A copy that
    // must not exist cannot be required to be current.
    //
    // So the invariant moves from "this copy is up to date" to "there is no
    // copy", asserted over EVERY governed file and EVERY snippet rather than
    // the one pair the old test named — a convention creeping back into a
    // second file would have walked straight past that one.
    const { snippets } = loadSnippetLibrary(path.join(REPO, ...DEFAULT_SNIPPETS_DIR.split('/')));
    assert.ok(snippets.length >= 12, `expected the shipped library, got ${snippets.length}`);
    assert.ok(GOVERNED_TARGETS.length >= 2, 'the sweep must have files to look at');

    for (const { file: rel } of GOVERNED_TARGETS) {
      const content = fs.readFileSync(path.join(REPO, ...rel.split('/')), 'utf8');
      const carried = snippets
        .filter((s) => compareConvention(s, content).status !== DRIFT_STATUS.ABSENT)
        .map((s) => s.id);
      assert.deepEqual(carried, [], `${rel} still ships ${carried.join(', ')}`);
    }
  });
});

describe('the fleet report never writes', () => {
  test('a --fleet run leaves every byte of every vault untouched', () => {
    // There is deliberately no --fix and no --all. This asserts the absence
    // rather than trusting it: a fixture fleet is hashed before and after.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-'));
    const vault = path.join(root, 'vault-one');
    fs.mkdirSync(path.join(vault, 'Documentation'), { recursive: true });
    const claudeMd = path.join(vault, 'Documentation', 'CLAUDE.md');
    fs.writeFileSync(claudeMd, '# Rules\n\n## Bilingual convention (FR + EN, FR primary)\n\ndrifted on purpose\n');
    const configPath = path.join(root, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ portRegistry: { [vault]: { port: 1 } } }));

    const before = fs.readFileSync(claudeMd);
    const out = execFileSync(
      process.execPath,
      [path.join(REPO, 'scripts', 'conventions-drift.mjs'), '--fleet', '--config', configPath, '--json'],
      { encoding: 'utf8', cwd: REPO },
    );
    const after = fs.readFileSync(claudeMd);

    assert.deepEqual(after, before, 'the fleet report must not touch a vault');
    const report = JSON.parse(out);
    const drifted = report.findings.filter((f) => f.status === 'drift');
    assert.equal(drifted.length, 1, 'and it must still have found the drift it was asked about');
    assert.equal(drifted[0].severity, 'warning');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('a vault carrying TWO conventions files has both examined', () => {
    // `resolveClaudeMd` refuses to choose between two candidates, and is right
    // to for an installer. Honouring that refusal HERE reported nothing at all
    // for eleven of the twenty-eight vaults on this machine, while looking like
    // a clean run.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet2-'));
    const vault = path.join(root, 'two-files');
    fs.mkdirSync(path.join(vault, 'Documentation'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'CLAUDE.md'), '## Bilingual convention (FR + EN, FR primary)\n\nA\n');
    fs.writeFileSync(path.join(vault, 'Documentation', 'CLAUDE.md'), '## Bilingual convention (FR + EN, FR primary)\n\nB\n');
    const configPath = path.join(root, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ portRegistry: { [vault]: { port: 1 } } }));

    const out = execFileSync(
      process.execPath,
      [path.join(REPO, 'scripts', 'conventions-drift.mjs'), '--fleet', '--config', configPath, '--json'],
      { encoding: 'utf8', cwd: REPO },
    );
    const report = JSON.parse(out);
    assert.equal(report.files, 2, 'both conventions files must be examined');
    assert.equal(report.multipleConventionsFiles.length, 1, 'and the ambiguity itself must be reported');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('the reference vault is scanned even though it is not in the registry', () => {
    // `referenceVault` is a separate config field. A report that walked the
    // registry alone would omit the single file this whole lot is about — the
    // template every other vault is cloned from.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-ref-'));
    const ref = path.join(root, 'reference');
    const other = path.join(root, 'other');
    fs.mkdirSync(ref, { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(ref, 'CLAUDE.md'), '## Bilingual convention (FR + EN, FR primary)\n\ndrifted\n');
    fs.writeFileSync(path.join(other, 'CLAUDE.md'), '# nothing\n');
    const configPath = path.join(root, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ referenceVault: ref, portRegistry: { [other]: { port: 1 } } }));

    const out = execFileSync(
      process.execPath,
      [path.join(REPO, 'scripts', 'conventions-drift.mjs'), '--fleet', '--config', configPath, '--json'],
      { encoding: 'utf8', cwd: REPO },
    );
    const report = JSON.parse(out);
    assert.equal(report.files, 2, 'the reference vault and the registered one');
    const labels = report.findings.map((f) => f.label ?? '').join(' ');
    assert.match(labels, /\(reference\)/, 'and it is labelled as the reference');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('"could not look" and "nothing to report" do not share an exit code', () => {
    // Otherwise a broken invocation reads as a clean fleet.
    const run = (args) => spawnSync(
      process.execPath,
      [path.join(REPO, 'scripts', 'conventions-drift.mjs'), '--fleet', ...args],
      { encoding: 'utf8', cwd: REPO },
    ).status;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-exit-'));
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ portRegistry: {} }));

    assert.equal(run(['--config', path.join(dir, 'nope.json')]), 1, 'an unreadable config is a failure to scan');
    assert.equal(run(['--config', configPath, '--vault', 'no-such-vault']), 1, 'a selector matching nothing is too');
    assert.equal(run(['--config', configPath, '--json']), 0, 'an empty fleet is not');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a PARTIALLY unloadable library is a failed scan, not a smaller one', () => {
    // One refused snippet among twelve used to print a warning and then report
    // on the eleven — a clean-looking run that had silently stopped checking a
    // convention. An empty library was the same failure with no message.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-lib-'));
    const vault = path.join(root, 'v');
    fs.mkdirSync(vault, { recursive: true });
    fs.writeFileSync(path.join(vault, 'CLAUDE.md'), '# nothing\n');
    const configPath = path.join(root, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ portRegistry: { [vault]: { port: 1 } } }));

    const good = path.join(root, 'good');
    fs.mkdirSync(good);
    fs.writeFileSync(path.join(good, 'a.md'), '## A convention\n\nbody\n');
    const partial = path.join(root, 'partial');
    fs.mkdirSync(partial);
    fs.writeFileSync(path.join(partial, 'a.md'), '## A convention\n\nbody\n');
    fs.writeFileSync(path.join(partial, 'bad.md'), '# Not a convention\n\nbody\n');
    const empty = path.join(root, 'empty');
    fs.mkdirSync(empty);

    const run = (lib) => spawnSync(
      process.execPath,
      [path.join(REPO, 'scripts', 'conventions-drift.mjs'), '--fleet', '--config', configPath,
        '--snippets', lib, '--json'],
      { encoding: 'utf8', cwd: REPO },
    ).status;

    assert.equal(run(good), 0, 'the control must be green, or the two below prove nothing');
    assert.equal(run(partial), 1, 'one refused snippet means this run did not check everything');
    assert.equal(run(empty), 1, 'zero comparisons is not "no drift"');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('an absent CLAUDE.md and an unreadable one are different answers', () => {
    // `catch { return false }` turned a permission error into "this vault has
    // no CLAUDE.md" — a vault silently dropped from the report, exit 0. Only
    // the errors that MEAN absence are absence.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'locate-'));
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    assert.deepEqual(locateVaultClaudeMd(plain), { files: [], ambiguous: false, unreadable: [] });

    // A FILE where a directory is expected: ENOTDIR, which genuinely means the
    // candidate is not there.
    const notdir = path.join(root, 'notdir');
    fs.mkdirSync(notdir);
    fs.writeFileSync(path.join(notdir, 'Documentation'), 'not a directory');
    const located = locateVaultClaudeMd(notdir);
    assert.deepEqual(located.unreadable, [], 'ENOTDIR is absence, not a failure to look');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('a vault path the OS cannot even examine is a failure, not an absence', () => {
    // Portable on every platform, which the permission witness below is not: a
    // registry key carrying a NUL byte makes `statSync` reject the argument
    // outright, with no errno at all. That is emphatically not "this vault has
    // no CLAUDE.md", and a hand-edited config is exactly where such a string
    // comes from.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-bad-'));
    const configPath = path.join(root, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ portRegistry: { [`${root} broken`]: { port: 1 } } }));

    const r = spawnSync(
      process.execPath,
      [path.join(REPO, 'scripts', 'conventions-drift.mjs'), '--fleet', '--config', configPath, '--json'],
      { encoding: 'utf8', cwd: REPO },
    );
    const report = JSON.parse(r.stdout);
    assert.ok(report.unreadable.length >= 1, 'it must be named, not silently dropped');
    assert.deepEqual(report.skipped, [], 'and it is not "nothing there to read"');
    assert.equal(report.ok, false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('and that failure reaches the exit code', () => {
    // Split from the classification above on purpose: dropping the exit-code
    // guard and misclassifying the error are two different defects, and a
    // single test cannot tell a reader which one it caught.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-bad-exit-'));
    const configPath = path.join(root, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ portRegistry: { [`${root} broken`]: { port: 1 } } }));
    const r = spawnSync(
      process.execPath,
      [path.join(REPO, 'scripts', 'conventions-drift.mjs'), '--fleet', '--config', configPath, '--json'],
      { encoding: 'utf8', cwd: REPO },
    );
    assert.equal(r.status, 1, 'a subject this run could not examine must not report as a clean fleet');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('a vault whose CLAUDE.md cannot be read fails the run', {
    // POSIX only: Windows ignores a mode of 0 for the owner, so the read
    // succeeds and there is nothing to witness. CI runs ubuntu as well as
    // windows, which is where this branch gets measured.
    skip: process.platform === 'win32' ? 'chmod does not restrict the owner on Windows' : false,
  }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-perm-'));
    const vault = path.join(root, 'v');
    fs.mkdirSync(vault, { recursive: true });
    const file = path.join(vault, 'CLAUDE.md');
    fs.writeFileSync(file, '## Bilingual convention (FR + EN, FR primary)\n\ndrifted\n');
    fs.chmodSync(file, 0o000);
    const configPath = path.join(root, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ portRegistry: { [vault]: { port: 1 } } }));

    const r = spawnSync(
      process.execPath,
      [path.join(REPO, 'scripts', 'conventions-drift.mjs'), '--fleet', '--config', configPath, '--json'],
      { encoding: 'utf8', cwd: REPO },
    );
    assert.equal(r.status, 1, 'a subject this run could not read must not report as a clean fleet');
    const report = JSON.parse(r.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.unreadable.length, 1);
    fs.chmodSync(file, 0o600);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('--fleet exits 0 even when vaults diverge', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet3-'));
    const vault = path.join(root, 'v');
    fs.mkdirSync(vault, { recursive: true });
    fs.writeFileSync(path.join(vault, 'CLAUDE.md'), '## Bilingual convention (FR + EN, FR primary)\n\ndrifted\n');
    const configPath = path.join(root, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ portRegistry: { [vault]: { port: 1 } } }));
    // execFileSync throws on a non-zero exit; reaching the assertion is the test.
    execFileSync(
      process.execPath,
      [path.join(REPO, 'scripts', 'conventions-drift.mjs'), '--fleet', '--config', configPath, '--json'],
      { encoding: 'utf8', cwd: REPO },
    );
    fs.rmSync(root, { recursive: true, force: true });
  });
});
