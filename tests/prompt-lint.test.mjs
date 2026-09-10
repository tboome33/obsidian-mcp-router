/**
 * The prompt lifecycle contract — `status` on `type: prompt` pages.
 *
 * WHY THIS EXISTS. A prompt page is a WORK ORDER: a brief written to be pasted
 * into a fresh session and executed once. Nothing in this repo ever creates one
 * — they are written by hand — so there was no authoring gate, and 18 pages of
 * the fleet drifted into four different words for the same state (`ready` ×9,
 * `done` ×7, `shipped` ×1, `executed` ×1). The vocabulary now lives in a
 * CLAUDE.md convention snippet (where an author reads it) and this module
 * catches the drift afterwards.
 *
 * THE ONE THING THESE TESTS MUST NOT DO is assert that a word means what its
 * spelling suggests. The migration map below is not a guess: each entry was
 * established by reading the pages that carry it. `done` and `shipped` were
 * confirmed to describe the RUN — one page states its own protocol ("passer
 * `status:` à `in-progress` en commençant, à `done` en livrant"), another calls
 * itself "ARCHIVE — prompt de handoff exécuté". Words whose meaning was NOT
 * established (`wip`, `todo`) are deliberately absent: an adversarial review
 * pointed out that `wip` may well mean "someone is executing it", which is the
 * opposite of the `draft` a naive reading would map it to.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROMPT_TYPES,
  VALID_PROMPT_STATUSES,
  LEGACY_PROMPT_STATUS_MAP,
  normalizePromptStatus,
  lintPrompts,
} from '../src/helpers/prompt-lint.mjs';

/** A page as the linter consumes it. */
const page = (path, frontmatter) => ({ path, frontmatter });

describe('the prompt lifecycle vocabulary', () => {
  test('the five states are exactly those the convention documents', () => {
    assert.deepEqual(VALID_PROMPT_STATUSES, ['draft', 'ready', 'in-progress', 'executed', 'abandoned']);
  });

  test('the vocabulary is ordered by lifecycle, not alphabetically', () => {
    // The order is load-bearing for anything that renders the list to a human:
    // it teaches the sequence. Alphabetical would put `abandoned` first, which
    // reads as the normal outcome.
    const i = (s) => VALID_PROMPT_STATUSES.indexOf(s);
    assert.ok(i('draft') < i('ready'), 'a brief is written before it is pasteable');
    assert.ok(i('ready') < i('in-progress'), 'it is pasteable before a session runs it');
    assert.ok(i('in-progress') < i('executed'), 'it runs before it is delivered');
  });

  test('it shares no token with the decision vocabulary', async () => {
    // Not a style rule: a reader who confuses the two vocabularies would read a
    // work order as a verdict. `type` is the discriminator, but keeping the
    // token sets disjoint means a misread is impossible rather than merely
    // unlikely.
    const { VALID_STATUSES } = await import('../src/helpers/decision-lint.mjs');
    const shared = VALID_PROMPT_STATUSES.filter((s) => VALID_STATUSES.includes(s));
    assert.deepEqual(shared, [], `these tokens mean two different things: ${shared.join(', ')}`);
  });

  test('every legacy alias resolves to a canonical state', () => {
    const entries = Object.entries(LEGACY_PROMPT_STATUS_MAP);
    assert.ok(entries.length >= 2, 'denominator: an empty alias table would pass every test below vacuously');
    for (const [alias, target] of entries) {
      assert.ok(
        VALID_PROMPT_STATUSES.includes(target),
        `alias ${alias} points at ${target}, which is not a canonical state`,
      );
      assert.ok(!VALID_PROMPT_STATUSES.includes(alias), `${alias} is canonical — it must not also be an alias`);
    }
  });

  test('only aliases whose meaning was ESTABLISHED are mapped', () => {
    // `done` and `shipped` were read on the pages that carry them and both
    // described the run. `wip`/`todo`/`in progress` were left out on purpose:
    // their meaning is genuinely ambiguous, and inventing a mapping would
    // manufacture an execution history the pages do not support.
    assert.equal(LEGACY_PROMPT_STATUS_MAP.done, 'executed');
    assert.equal(LEGACY_PROMPT_STATUS_MAP.shipped, 'executed');
    for (const guess of ['wip', 'todo', 'active', 'pending', 'open']) {
      assert.equal(LEGACY_PROMPT_STATUS_MAP[guess], undefined, `${guess} has no established meaning here`);
    }
  });
});

describe('normalizePromptStatus', () => {
  test('a canonical value normalizes to itself', () => {
    for (const s of VALID_PROMPT_STATUSES) assert.equal(normalizePromptStatus(s), s);
  });

  test('surrounding whitespace and casing are accepted', () => {
    assert.equal(normalizePromptStatus('  Ready '), 'ready');
    assert.equal(normalizePromptStatus('IN-PROGRESS'), 'in-progress');
  });

  test('a known older spelling resolves to its canonical state', () => {
    assert.equal(normalizePromptStatus('done'), 'executed');
    assert.equal(normalizePromptStatus('Shipped'), 'executed');
  });

  test('an unknown value resolves to null rather than to a guess', () => {
    for (const junk of ['wip', 'todo', 'finished-ish', '']) {
      assert.equal(normalizePromptStatus(junk), null);
    }
  });

  test('a non-string never throws and never resolves', () => {
    for (const junk of [null, undefined, 42, {}, ['ready'], true]) {
      assert.equal(normalizePromptStatus(junk), null);
    }
  });
});

describe('lintPrompts', () => {
  test('a page with a canonical status produces no finding', () => {
    const findings = lintPrompts([page('wiki/p/a.md', { type: 'prompt', status: 'ready' })]);
    assert.deepEqual(findings, []);
  });

  test('a prompt with no status is reported', () => {
    const findings = lintPrompts([page('wiki/p/a.md', { type: 'prompt' })]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].rule, 'prompt-status-missing');
    assert.equal(findings[0].path, 'wiki/p/a.md');
    assert.match(findings[0].detail, /draft/, 'the message names the vocabulary');
    assert.equal(findings[0].suggestion, undefined, 'absence is not evidence of any state — never suggest one');
  });

  test('an unknown status is reported WITHOUT a suggestion', () => {
    const findings = lintPrompts([page('wiki/p/a.md', { type: 'prompt', status: 'wip' })]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].rule, 'prompt-status-invalid');
    assert.equal(findings[0].suggestion, undefined, 'an unestablished word gets a diagnostic, not invented certainty');
  });

  test('a known older spelling is reported WITH its migration target', () => {
    const findings = lintPrompts([page('wiki/p/a.md', { type: 'prompt', status: 'done' })]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].rule, 'prompt-status-invalid');
    assert.equal(findings[0].suggestion, 'executed');
    assert.match(findings[0].detail, /executed/);
  });

  test('a status that is not a scalar string is invalid, not silently coerced', () => {
    // A one-element YAML list (`status: [ready]`) parses to an array. Coercing
    // it with String() would read "ready" and accept a malformed page.
    for (const value of [['ready'], { value: 'ready' }, 42, true]) {
      const findings = lintPrompts([page('wiki/p/a.md', { type: 'prompt', status: value })]);
      assert.equal(findings.length, 1, `${JSON.stringify(value)} must be reported`);
      assert.equal(findings[0].rule, 'prompt-status-invalid');
    }
  });

  test('casing and padding are accepted rather than reported', () => {
    // Deliberate: the vocabulary is for humans writing frontmatter by hand, and
    // reporting `Ready` as a defect would be noise. The linter normalizes.
    assert.deepEqual(lintPrompts([page('wiki/p/a.md', { type: 'prompt', status: ' Ready ' })]), []);
  });

  test('a page of any other type is not inspected', () => {
    const pages = [
      page('wiki/d/a.md', { type: 'decision', status: 'accepted' }),
      page('wiki/s/b.md', { type: 'session' }),
      page('wiki/c/c.md', { type: 'concept', status: 'whatever' }),
    ];
    assert.deepEqual(lintPrompts(pages), []);
  });

  test('a page with no type at all is not inspected', () => {
    // Owning "this page has no type" belongs to a generic frontmatter check.
    // Guessing from the filename would silently widen this rule's scope.
    assert.deepEqual(lintPrompts([page('wiki/p/prompt-session-x.md', { status: 'wip' })]), []);
    assert.deepEqual(lintPrompts([page('wiki/p/a.md', {})]), []);
  });

  test('the type match tolerates casing and padding', () => {
    const findings = lintPrompts([page('wiki/p/a.md', { type: ' Prompt ', status: 'wip' })]);
    assert.equal(findings.length, 1, 'a page is a prompt whatever the case of its type');
  });

  test('backup directories are excluded, so a snapshot cannot generate findings forever', () => {
    // Measured: one vault carries `.okf-rename-backup/<timestamp>/wiki/...`, a
    // frozen copy. Linting it reports a page nobody can fix without editing a
    // backup — a finding that would return on every run.
    const pages = [
      page('.okf-rename-backup/2026-07-30-00-09-54/wiki/p/a.md', { type: 'prompt', status: 'wip' }),
      page('wiki/p/.trash/old.md', { type: 'prompt', status: 'wip' }),
      page('wiki/p/live.md', { type: 'prompt', status: 'wip' }),
    ];
    const findings = lintPrompts(pages);
    assert.deepEqual(findings.map((f) => f.path), ['wiki/p/live.md']);
  });

  test('several pages are all reported, in input order', () => {
    const findings = lintPrompts([
      page('wiki/p/a.md', { type: 'prompt', status: 'done' }),
      page('wiki/p/b.md', { type: 'prompt', status: 'ready' }),
      page('wiki/p/c.md', { type: 'prompt' }),
    ]);
    assert.deepEqual(findings.map((f) => f.path), ['wiki/p/a.md', 'wiki/p/c.md']);
  });

  test('junk input yields no findings rather than throwing', () => {
    for (const junk of [null, undefined, 'pages', 42, {}]) {
      assert.deepEqual(lintPrompts(junk), []);
    }
    // And junk ENTRIES inside a real array are skipped, not fatal.
    assert.deepEqual(lintPrompts([null, 42, {}, { frontmatter: null }]), []);
  });

  test('every finding carries the fields a report needs', () => {
    const findings = lintPrompts([
      page('wiki/p/a.md', { type: 'prompt' }),
      page('wiki/p/b.md', { type: 'prompt', status: 'done' }),
    ]);
    assert.equal(findings.length, 2, 'denominator');
    for (const f of findings) {
      assert.equal(typeof f.rule, 'string');
      assert.equal(typeof f.path, 'string');
      assert.equal(typeof f.detail, 'string');
      assert.equal(f.severity, 'warning', 'both rules are warnings — nothing here blocks a run');
    }
  });
});

describe('the convention snippet and the code agree', () => {
  test('the snippet documents exactly the five canonical states', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const snippet = fs.readFileSync(
      path.join(repoRoot, 'skills', 'conventions', 'snippets', 'prompt-status.md'), 'utf8',
    );
    // The table rows spell each value in backticks at the start of a row.
    const documented = [...snippet.matchAll(/^\|\s*`([a-z-]+)`\s*\|/gm)].map((m) => m[1]);
    assert.ok(documented.length >= 5, `only ${documented.length} states found in the snippet — an empty parse would pass`);
    assert.deepEqual(
      [...documented].sort(),
      [...VALID_PROMPT_STATUSES].sort(),
      'the snippet an author reads and the code that lints them must not drift',
    );
  });
});
