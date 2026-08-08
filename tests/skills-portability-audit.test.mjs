/**
 * Tests for the C12 skill-frontmatter portability audit.
 *
 * The audit's job is to answer "could this page leave Claude Code unedited?",
 * so the tests are built around synthetic skills whose answer is known in
 * advance — one fixture per way of being wrong. Asserting only that the live
 * repository is clean would test nothing but the live repository: a rule that
 * silently stopped firing would still report a clean run.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  parseFrontmatter, measuredDescriptionLength, listSkills, auditSkillFrontmatter,
} from '../src/helpers/agent-portability.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'skills-portability-audit.mjs');
const CONTRACT = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'contracts', 'agent-host-targets.json'), 'utf8'),
);

/** Build a throwaway repo holding only the skills a test cares about. */
function makeRepo(skills) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c12-audit-'));
  for (const [name, body] of Object.entries(skills)) {
    const dir = path.join(root, 'skills', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), body, 'utf8');
  }
  return root;
}

const clean = (name, extra = '') =>
  `---\nname: ${name}\ndescription: Does a thing, and says when to do it.\n${extra}---\n\nBody.\n`;

function codes(findings, skill) {
  return findings.filter((f) => f.skill === skill).map((f) => `${f.severity}:${f.code}`).sort();
}

describe('parseFrontmatter', () => {
  test('a wrapped value does not become extra keys', () => {
    // The failure this guards: a description that wraps over three lines being
    // read as three unknown keys, which would turn every long skill page into
    // a fake portability error.
    const fm = parseFrontmatter(
      '---\nname: x\ndescription: one line\n  and a continuation: with a colon in it\n  and another\n---\nbody\n',
    );
    assert.deepEqual(fm.keys, ['name', 'description']);
    assert.match(fm.values.description, /continuation: with a colon/);
  });

  test('reports absence rather than throwing', () => {
    assert.equal(parseFrontmatter('no frontmatter here\n').found, false);
  });

  test('keeps duplicate keys so they can be reported', () => {
    const fm = parseFrontmatter('---\nname: x\nname: y\ndescription: d\n---\n');
    assert.deepEqual(fm.keys, ['name', 'name', 'description']);
  });
});

describe('measuredDescriptionLength', () => {
  test('quoting is not payload', () => {
    assert.equal(measuredDescriptionLength('"abcd"'), 4);
    assert.equal(measuredDescriptionLength("'abcd'"), 4);
    assert.equal(measuredDescriptionLength('abcd'), 4);
  });

  test('a wrapped value is measured as the single line a host sees', () => {
    assert.equal(measuredDescriptionLength('ab\n   cd'), 5); // "ab cd"
  });
});

describe('auditSkillFrontmatter — one fixture per way of being wrong', () => {
  test('a spec-only skill produces no finding', () => {
    const root = makeRepo({ good: clean('good') });
    const { findings, counts } = auditSkillFrontmatter(root, CONTRACT);
    assert.deepEqual(findings, []);
    assert.equal(counts.skills, 1);
    assert.equal(counts.portable, 1);
  });

  test('an undeclared key is an error — nobody weighed its cost', () => {
    const root = makeRepo({ bad: clean('bad', 'model: opus\n') });
    const { findings, counts } = auditSkillFrontmatter(root, CONTRACT);
    assert.deepEqual(codes(findings, 'bad'), ['error:undeclared-key']);
    assert.equal(counts.errors, 1);
    assert.equal(counts.portable, 0);
  });

  test('a declared host extension is a warning, and an error under --strict', () => {
    const root = makeRepo({ hinted: clean('hinted', 'argument-hint: [page]\n') });

    const loose = auditSkillFrontmatter(root, CONTRACT);
    assert.deepEqual(codes(loose.findings, 'hinted'), ['warn:host-extension']);
    assert.equal(loose.counts.errors, 0);
    assert.equal(loose.counts.extensionUse['argument-hint'], 1);

    const strict = auditSkillFrontmatter(root, CONTRACT, { strict: true });
    assert.deepEqual(codes(strict.findings, 'hinted'), ['error:host-extension']);
    assert.equal(strict.counts.errors, 1);
  });

  test('name that disagrees with its directory is an error', () => {
    const root = makeRepo({ folder: clean('other') });
    const { findings } = auditSkillFrontmatter(root, CONTRACT);
    assert.deepEqual(codes(findings, 'folder'), ['error:name-directory-mismatch']);
  });

  test('name outside the portable charset is an error', () => {
    const root = makeRepo({ Bad_Name: clean('Bad_Name') });
    const { findings } = auditSkillFrontmatter(root, CONTRACT);
    assert.ok(codes(findings, 'Bad_Name').includes('error:name-format'));
  });

  test('a missing description is an error', () => {
    const root = makeRepo({ nodesc: '---\nname: nodesc\n---\n\nBody.\n' });
    const { findings } = auditSkillFrontmatter(root, CONTRACT);
    assert.deepEqual(codes(findings, 'nodesc'), ['error:required-field-missing']);
  });

  test('a description over the listing cap is an error, one character under it is not', () => {
    const budget = CONTRACT.portableFrontmatter.descriptionCharLimit;
    const over = makeRepo({ big: `---\nname: big\ndescription: ${'x'.repeat(budget + 1)}\n---\n\nB.\n` });
    const at = makeRepo({ big: `---\nname: big\ndescription: ${'x'.repeat(budget)}\n---\n\nB.\n` });

    assert.deepEqual(codes(auditSkillFrontmatter(over, CONTRACT).findings, 'big'),
      ['error:description-over-budget']);
    assert.deepEqual(auditSkillFrontmatter(at, CONTRACT).findings, []);
  });

  test('a duplicated key is an error — which value wins is parser-dependent', () => {
    const root = makeRepo({ dup: '---\nname: dup\nname: dup\ndescription: d\n---\n\nB.\n' });
    const { findings } = auditSkillFrontmatter(root, CONTRACT);
    assert.ok(codes(findings, 'dup').includes('error:duplicate-key'));
  });

  test('missing frontmatter is an error', () => {
    const root = makeRepo({ raw: 'no frontmatter at all\n' });
    const { findings } = auditSkillFrontmatter(root, CONTRACT);
    assert.deepEqual(codes(findings, 'raw'), ['error:frontmatter-missing']);
  });

  test('a directory without a SKILL.md is not counted as a skill', () => {
    const root = makeRepo({ real: clean('real') });
    fs.mkdirSync(path.join(root, 'skills', 'not-a-skill'), { recursive: true });
    fs.writeFileSync(path.join(root, 'skills', 'not-a-skill', 'README.md'), 'x', 'utf8');
    assert.deepEqual(listSkills(root).map((s) => s.name), ['real']);
    assert.equal(auditSkillFrontmatter(root, CONTRACT).counts.skills, 1);
  });
});

describe('the live repository', () => {
  test('every skill passes the audit, and the denominator is counted not quoted', () => {
    const { findings, counts } = auditSkillFrontmatter(REPO_ROOT, CONTRACT);
    const errors = findings.filter((f) => f.severity === 'error');
    assert.deepEqual(errors, [], `portability errors: ${JSON.stringify(errors, null, 2)}`);

    // The count must come from the same walk the audit used, and must be
    // non-trivial — a bug that made listSkills() return [] would otherwise
    // make this suite green by finding nothing to complain about.
    const onDisk = fs.readdirSync(path.join(REPO_ROOT, 'skills'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(REPO_ROOT, 'skills', e.name, 'SKILL.md')))
      .length;
    assert.equal(counts.skills, onDisk);
    assert.ok(counts.skills > 20, `expected a populated skills tree, counted ${counts.skills}`);
    assert.ok(counts.longestDescription <= CONTRACT.portableFrontmatter.descriptionCharLimit);
  });

  test('the figure the README publishes is the figure the audit measures', () => {
    // The README states a portability ratio. Left unchecked it is a number
    // someone typed once — exactly the kind of stale count this work exists to
    // stop quoting. Bind it to the live audit instead.
    const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
    const m = readme.match(/\*\*(\d+)\/(\d+) skills carry spec-only frontmatter\*\*/);
    assert.ok(m, 'README no longer states the portability ratio — remove this test or restore the sentence');
    const { counts } = auditSkillFrontmatter(REPO_ROOT, CONTRACT);
    assert.equal(Number(m[1]), counts.portable);
    assert.equal(Number(m[2]), counts.skills);

    // Same for the longest-description figure and the limit it is measured against.
    const d = readme.match(/longest description \*\*(\d+)\/(\d+)\*\*/);
    assert.ok(d, 'README no longer states the longest description — remove this test or restore the sentence');
    assert.equal(Number(d[1]), counts.longestDescription);
    assert.equal(Number(d[2]), CONTRACT.portableFrontmatter.descriptionCharLimit);
  });

  test('the pinned description limit is the one the cited specification states', () => {
    // The number that decides every description verdict must carry its source,
    // and the source must be the OPEN SPEC — not the Claude Code listing
    // truncation, which is a different measurement and 512 characters looser.
    const fm = CONTRACT.portableFrontmatter;
    assert.equal(fm.descriptionCharLimit, 1024);
    assert.equal(fm.authority, 'https://agentskills.io/specification');
    assert.ok(fm.authorityAccessed, 'the citation needs an access date');
    assert.match(fm.budgetSource, /1-1024 characters/);
    assert.equal(fm.claudeCodeListingTruncation.chars, 1536);
    assert.ok(
      fm.claudeCodeListingTruncation.chars > fm.descriptionCharLimit,
      'the listing budget is recorded only to document that it is the looser, non-binding number',
    );
  });

  test('CLI exits 0, and --strict names every non-portable skill', () => {
    const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

    const loose = run(['--json']);
    assert.equal(loose.status, 0, loose.stdout + loose.stderr);
    const loosePayload = JSON.parse(loose.stdout);
    assert.equal(loosePayload.ok, true);

    const strict = run(['--strict', '--json']);
    const strictPayload = JSON.parse(strict.stdout);
    const nonPortable = strictPayload.counts.skills - strictPayload.counts.portable;
    // Whatever the number is, the two runs must agree about which skills it is,
    // and --strict must exit non-zero exactly when there are any.
    assert.equal(strict.status, nonPortable > 0 ? 1 : 0);
    assert.equal(
      new Set(strictPayload.findings.map((f) => f.skill)).size,
      nonPortable,
      'strict findings must cover exactly the non-portable skills',
    );
  });
});
