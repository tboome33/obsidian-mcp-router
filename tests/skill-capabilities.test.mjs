/**
 * Tests for src/helpers/skill-capabilities.mjs — the C8 capability contracts
 * and their validator.
 *
 * TWO LAYERS, on purpose.
 *
 * 1. FIXTURE TESTS. Each failure mode the roadmap names is proven by a
 *    synthetic repo on disk that the validator must REJECT — an undeclared
 *    skill, an orphan declaration, a false doc counter. A test that only
 *    asserted the happy path would pass just as well if the check were
 *    deleted, which is the failure mode this whole feature exists to stop.
 *    Every fixture test therefore asserts a specific issue CODE, and several
 *    also assert the inverse (fix the fixture → the issue disappears), so a
 *    validator that flagged everything unconditionally would fail too.
 *
 * 2. THE LIVE REPO. The last describe() runs the validator against the real
 *    checkout and demands zero issues. That is what makes `npm test` a gate:
 *    add a skill without declaring it, rename one, or let a README counter
 *    rot, and the suite goes red here.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SCHEMA_VERSION, DECLARATIONS_PATH, BOOTSTRAP_SENTINEL,
  READ_ATOMS, WRITE_ATOMS, WRITE_MODES, VERIFICATION_STATUSES, COUNTER_RULES,
  splitFrontmatter, frontmatterScalar, bareToolName,
  discoverSkills, discoverAgents, mentionedTools,
  validateDeclarations, checkAgentAllowlists, checkDocCounters, checkToolBreakdown,
  countArtifacts, runCapabilityValidation, renderIssues, stripEmphasis, mentionedSkills,
  checkQuickReferenceFreshness, checkQuickReferenceVersion,
} from '../src/helpers/skill-capabilities.mjs';
import {
  QUICK_REFERENCE_MANIFEST, QUICK_REFERENCE_PAGES, sha256OfFile, quickReferenceFreshness,
} from '../src/helpers/quick-reference.mjs';
import { _internals } from '../src/index.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_TOOL_NAMES = new Set(_internals.TOOLS.map((t) => t.name));
/** A fixture's version — arbitrary, but the fixture's package.json and its
 *  quick-reference mastheads must agree on it, which is what the pin checks. */
const REPO_VERSION = '9.9.9';
const REAL_WRITE_TOOLS = _internals.WRITE_TOOL_NAMES;

// ---------------------------------------------------------------------------
// Fixture repo builder
// ---------------------------------------------------------------------------

const TMP_ROOTS = [];

/** A minimal but complete entry that passes every check. */
function goodEntry(over = {}) {
  return {
    summary: 'does a thing',
    reads: ['vault:content'],
    writes: [],
    tools: ['get_file'],
    toolsMentionedNotCalled: [],
    writeMode: 'read-only',
    requires: { shell: false, network: false, python: false, obsidianPlugins: [], binaries: [] },
    verification: { status: 'declared', reason: 'nothing executes a skill' },
    ...over,
  };
}

/** How many sites a README rule is required to guard, from the real rules. */
function minMatchesFor(ruleId) {
  const rule = COUNTER_RULES.find((r) => r.id === ruleId);
  return Number.isFinite(rule && rule.minMatches) ? rule.minMatches : 1;
}

/**
 * A fixture README that satisfies each README rule's `minMatches` BY
 * CONSTRUCTION.
 *
 * Deriving the repetition count from COUNTER_RULES rather than hard-coding
 * it means raising a rule's guarded-site count cannot leave the fixtures
 * quietly failing for an unrelated reason — the baseline follows the
 * production rules automatically.
 *
 * `sites` shrinks a specific counter below its minimum, which is how the
 * "guards fewer sites" test breaks exactly one thing.
 */
function defaultReadme({ commands, skills, hooks, sites = {} }) {
  const rep = (ruleId, sentence) => {
    const n = sites[ruleId] !== undefined ? sites[ruleId] : minMatchesFor(ruleId);
    return Array.from({ length: n }, () => sentence).join('\n');
  };
  return [
    rep('readme-commands', `The plugin exposes ${commands} slash commands.`),
    rep('readme-skills', `It ships ${skills} skills.`),
    rep('readme-hooks', `There are ${hooks} hooks Node cross-platform.`),
    '',
  ].join('\n');
}

/**
 * The two quick-reference pages, each stating its three counts at BOTH sites
 * the real pages use (masthead + section heading), so a fixture exercises the
 * `minMatches: 2` rules rather than passing on one lucky occurrence.
 *
 * `sites` shrinks a single rule's occurrences, the way `defaultReadme` does,
 * so "the rule still matches but guards fewer sites" is testable here too.
 */
function defaultQuickReference({ commands, tools, skills, sites = {}, version = REPO_VERSION }) {
  const rep = (ruleId, sentence) => {
    const n = sites[ruleId] !== undefined ? sites[ruleId] : minMatchesFor(ruleId);
    return Array.from({ length: n }, () => `<p>${sentence}</p>`).join('\n');
  };
  // The masthead AND a historical mention, because the pair is the point: the
  // first must track the repo's version, the second names the release that
  // shipped a feature and must never be advanced.
  const masthead = version === null
    ? '<div class="meta">no version here</div>'
    : `<div class="meta">v${version} · the card</div>\n<p>binding (v0.1.0) shipped it</p>`;
  return {
    en: [
      masthead,
      rep('quick-reference-en-commands', `${commands} slash commands`),
      rep('quick-reference-en-tools', `${tools} MCP tools`),
      rep('quick-reference-en-skills', `${skills} skills`),
      '',
    ].join('\n'),
    fr: [
      masthead,
      rep('quick-reference-fr-commands', `${commands} slash commands`),
      rep('quick-reference-fr-tools', `${tools} outils MCP`),
      rep('quick-reference-fr-skills', `${skills} skills`),
      '',
    ].join('\n'),
  };
}

/**
 * Record each page's CURRENT hash, i.e. "the PDFs were rendered from exactly
 * these bytes". `override` replaces the recorded value for a page so a test
 * can say "this one is stale" without needing a Chrome to prove it.
 */
function writeQuickReferenceManifest(root, langs, override = {}) {
  const renderedFrom = {};
  for (const lang of langs) {
    const rel = `docs/quick-reference-${lang}.html`;
    renderedFrom[rel] = Object.prototype.hasOwnProperty.call(override, rel)
      ? override[rel]
      : sha256OfFile(path.join(root, rel));
  }
  fs.writeFileSync(
    path.join(root, QUICK_REFERENCE_MANIFEST),
    `${JSON.stringify({ renderedFrom }, null, 2)}\n`,
    'utf8',
  );
}

/**
 * Build a throwaway repo on disk.
 *
 * `skills` maps skill name → SKILL.md body. `declarations` is the parsed
 * object written to contracts/. Counter files are generated to be CORRECT
 * for the fixture's own artifact counts unless a test overrides them, so a
 * counter test fails for the reason it claims and not by accident.
 */
function makeRepo({
  skills = { alpha: 'Call the `get_file` MCP tool.' },
  agents = {},
  commands = ['one'],
  hooks = ['h1'],
  declarations,
  readme,
  architecture,
  pluginJson,
  marketplaceJson,
  quickReferenceHtml,
  quickReferenceManifest,
  packageVersion,
  omit = [],
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c8-fixture-'));
  TMP_ROOTS.push(root);

  for (const [name, body] of Object.entries(skills)) {
    const dir = path.join(root, 'skills', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n\n${body}\n`);
  }
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  for (const [name, tools] of Object.entries(agents)) {
    fs.writeFileSync(path.join(root, 'agents', `${name}.md`), `---\nname: ${name}\ntools: ${tools}\n---\n\nbody\n`);
  }
  fs.mkdirSync(path.join(root, 'commands'), { recursive: true });
  for (const c of commands) fs.writeFileSync(path.join(root, 'commands', `${c}.md`), 'x');
  fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
  for (const h of hooks) fs.writeFileSync(path.join(root, 'hooks', `${h}.mjs`), 'x');

  const nSkills = Object.keys(skills).length;
  const nTools = REAL_TOOL_NAMES.size;

  if (!omit.includes('contracts')) {
    fs.mkdirSync(path.join(root, 'contracts'), { recursive: true });
    const decl = declarations ?? {
      schemaVersion: SCHEMA_VERSION,
      skills: Object.fromEntries(Object.keys(skills).map((n) => [n, goodEntry()])),
    };
    fs.writeFileSync(path.join(root, DECLARATIONS_PATH), JSON.stringify(decl, null, 2));
  }

  if (!omit.includes('README.md')) {
    fs.writeFileSync(path.join(root, 'README.md'),
      readme ?? defaultReadme({ commands: commands.length, skills: nSkills, hooks: hooks.length }));
  }
  if (!omit.includes('docs')) {
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'architecture.md'),
      architecture ?? `Holds **${nTools} MCP tools**: everything (${nTools}).\n`);
  }
  // The two quick-reference pages, their PDFs, and the record tying one to the
  // other. A fixture without them is a fixture the freshness check reports on,
  // so the harness builds a CLEAN pair by default and each test breaks the one
  // thing it is about.
  // The version the quick-reference mastheads are checked against.
  if (!omit.includes('package.json')) {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'fixture', version: packageVersion ?? REPO_VERSION }, null, 2),
    );
  }
  if (!omit.includes('quick-reference')) {
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    const pages = quickReferenceHtml
      ?? defaultQuickReference({ commands: commands.length, tools: nTools, skills: nSkills });
    for (const [lang, body] of Object.entries(pages)) {
      fs.writeFileSync(path.join(root, `docs/quick-reference-${lang}.html`), body);
      if (!omit.includes('quick-reference-pdf')) {
        fs.writeFileSync(path.join(root, `docs/quick-reference-${lang}.pdf`), `%PDF-1.4 ${lang}\n`);
      }
    }
    if (!omit.includes('quick-reference-manifest')) {
      writeQuickReferenceManifest(root, Object.keys(pages), quickReferenceManifest);
    }
  }
  if (!omit.includes('plugin')) {
    fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'),
      pluginJson ?? JSON.stringify({
        description: `${commands.length} /obsidian-router:* commands. Plus ${nSkills} skills and ${Object.keys(agents).length} parallel sub-agents.`,
      }, null, 2));
    fs.writeFileSync(path.join(root, '.claude-plugin', 'marketplace.json'),
      marketplaceJson ?? JSON.stringify({
        metadata: { description: `${commands.length} commands total.` },
        plugins: [{ description: `${commands.length} /obsidian-router:* commands.` }],
      }, null, 2));
  }
  return root;
}

function validateRepo(root) {
  return runCapabilityValidation(root, {
    toolNames: REAL_TOOL_NAMES, writeToolNames: REAL_WRITE_TOOLS,
  });
}

const codes = (issues) => issues.map((i) => i.code);

/** Overwrite a fixture repo's declarations with `skills`, return the root. */
function withDecl(root, skills, extra = {}) {
  fs.writeFileSync(path.join(root, DECLARATIONS_PATH),
    JSON.stringify({ schemaVersion: SCHEMA_VERSION, skills, ...extra }, null, 2));
  return root;
}

after(() => {
  for (const r of TMP_ROOTS) {
    try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ---------------------------------------------------------------------------
// Sanity: the fixture harness itself produces a CLEAN repo
// ---------------------------------------------------------------------------

describe('fixture harness', () => {
  test('a well-formed fixture repo validates clean', () => {
    // Load-bearing. Every failure test below mutates this baseline by exactly
    // one thing; if the baseline were dirty, those tests would "pass" while
    // proving nothing.
    const { issues } = validateRepo(makeRepo());
    assert.deepEqual(issues, [], renderIssues(issues));
  });
});

// ---------------------------------------------------------------------------
// The three failure modes §2.17 names
// ---------------------------------------------------------------------------

describe('§2.17 case 1 — the validator catches an UNDECLARED SKILL', () => {
  test('a skill that ships with no entry is an error', () => {
    const root = makeRepo({
      skills: { alpha: 'Call `get_file`.', beta: 'Call `get_file`.' },
      declarations: { schemaVersion: SCHEMA_VERSION, skills: { alpha: goodEntry() } },
    });
    const { issues } = validateRepo(root);
    assert.ok(codes(issues).includes('undeclared-skill'), renderIssues(issues));
    const found = issues.find((i) => i.code === 'undeclared-skill');
    assert.match(found.message, /`beta`/);
    // The finding must point at the skill, not at the manifest — that is
    // where the reader has to look to write the entry.
    assert.equal(found.where, path.join('skills', 'beta', 'SKILL.md'));
  });

  test('...and declaring it clears the issue', () => {
    const root = makeRepo({
      skills: { alpha: 'Call `get_file`.', beta: 'Call `get_file`.' },
      declarations: { schemaVersion: SCHEMA_VERSION, skills: { alpha: goodEntry(), beta: goodEntry() } },
    });
    assert.deepEqual(validateRepo(root).issues, []);
  });

  test('a skills/ subdirectory WITHOUT a SKILL.md is not a skill', () => {
    // Guards the discovery rule: leftover directories must not be demanded
    // in the manifest, or every stray folder becomes a CI failure.
    const root = makeRepo();
    fs.mkdirSync(path.join(root, 'skills', 'leftover'), { recursive: true });
    fs.writeFileSync(path.join(root, 'skills', 'leftover', 'notes.md'), 'x');
    assert.deepEqual(validateRepo(root).issues, []);
  });
});

describe('§2.17 case 2 — the validator catches an ORPHAN DECLARATION', () => {
  test('an entry with no matching skill directory is an error', () => {
    const root = makeRepo({
      skills: { alpha: 'Call `get_file`.' },
      declarations: {
        schemaVersion: SCHEMA_VERSION,
        skills: { alpha: goodEntry(), ghost: goodEntry() },
      },
    });
    const { issues } = validateRepo(root);
    assert.ok(codes(issues).includes('orphan-declaration'), renderIssues(issues));
    assert.match(issues.find((i) => i.code === 'orphan-declaration').message, /`ghost`/);
  });

  test('a RENAMED skill trips both halves at once', () => {
    // The realistic shape of this drift: someone renames skills/alpha to
    // skills/alpha2 and forgets the manifest. Both directions must fire, or
    // the rename looks like a clean swap.
    const root = makeRepo({
      skills: { alpha2: 'Call `get_file`.' },
      declarations: { schemaVersion: SCHEMA_VERSION, skills: { alpha: goodEntry() } },
    });
    const c = codes(validateRepo(root).issues);
    assert.ok(c.includes('undeclared-skill'));
    assert.ok(c.includes('orphan-declaration'));
  });
});

describe('§2.17 case 3 — the validator catches a FALSE DOC COUNTER', () => {
  test('a README that undercounts the skills is an error', () => {
    const root = makeRepo({
      skills: { alpha: 'Call `get_file`.', beta: 'Call `get_file`.' },
      declarations: {
        schemaVersion: SCHEMA_VERSION,
        skills: { alpha: goodEntry(), beta: goodEntry() },
      },
      // Two skills ship; every guarded sentence still says one.
      readme: defaultReadme({ commands: 1, skills: 1, hooks: 1 }),
    });
    const { issues } = validateRepo(root);
    const counter = issues.filter((i) => i.code === 'doc-counter');
    assert.ok(counter.length > 0, renderIssues(issues));
    assert.ok(counter.some((i) => /claims 1 skills; the repo has 2/.test(i.message)),
      renderIssues(issues));
  });

  test('EVERY occurrence is checked, not just the first', () => {
    // The counters repeat across a long README. Checking only the first
    // match would let a stale duplicate survive indefinitely — the correct
    // opening sentence would vouch for a rotted one further down.
    const good = defaultReadme({ commands: 2, skills: 1, hooks: 1 });
    const root = makeRepo({
      commands: ['a', 'b'],
      readme: `${good}\nElsewhere, an older paragraph still says 7 slash commands.\n`,
    });
    const { issues } = validateRepo(root);
    const m = issues.find((i) => i.code === 'doc-counter' && /slash commands/.test(i.message));
    assert.ok(m, renderIssues(issues));
    assert.match(m.message, /claims 7 slash commands; the repo has 2/);
  });

  test('a number wrapped in markdown emphasis is NOT invisible', () => {
    // `**9** skills` slipped past a pattern expecting `9 skills`, so a wrong
    // published number survived while a correct plain sentence elsewhere
    // kept the rule from reporting that it had stopped matching.
    const good = defaultReadme({ commands: 1, skills: 1, hooks: 1 });
    const root = makeRepo({ readme: `${good}\nWe now ship **9** skills.\n` });
    const { issues } = validateRepo(root);
    assert.ok(issues.some((i) => i.code === 'doc-counter' && /claims 9 skills/.test(i.message)),
      renderIssues(issues));
  });

  test('a counter rule that matches NOTHING is itself an error', () => {
    // A check that quietly stops matching is a check that has switched
    // itself off. That must be louder than a wrong number, not quieter.
    //
    // Exactly ONE rule is broken here, and the assertion names it. An
    // earlier version wiped every counter out of the README, which left
    // three counter-site-missing findings — so the test passed even if the
    // rule it claims to exercise had been deleted.
    const root = makeRepo({
      readme: defaultReadme({ commands: 1, skills: 1, hooks: 1, sites: { 'readme-hooks': 0 } }),
    });
    const { issues } = validateRepo(root);
    const missing = issues.filter((i) => i.code === 'counter-site-missing');
    assert.equal(missing.length, 1, renderIssues(issues));
    assert.equal(missing[0].ruleId, 'readme-hooks');
    assert.match(missing[0].message, /matched nothing/);
  });

  test('a rule that still matches but guards FEWER sites is an error', () => {
    // The README states its command count in several places. Losing all but
    // one of them to a rewrite must not pass silently — the number is still
    // right, but the guarded surface shrank, and next time only one sentence
    // is watched.
    const min = minMatchesFor('readme-commands');
    if (min < 2) return; // nothing to shrink
    const root = makeRepo({
      readme: defaultReadme({ commands: 1, skills: 1, hooks: 1, sites: { 'readme-commands': min - 1 } }),
    });
    const { issues } = validateRepo(root);
    const found = issues.find((i) => i.ruleId === 'readme-commands' && i.code === 'counter-site-missing');
    assert.ok(found, renderIssues(issues));
    assert.match(found.message, new RegExp(`down from the ${min} it is meant to guard`));
  });

  test('a quick-reference page that undercounts is an error, in EITHER language', () => {
    // The regression this whole rule set exists for: both pages sat at
    // "51 slash commands · 51 MCP tools · 47 skills" for a whole release while
    // the README — which WAS pinned — stayed correct. Each language is
    // asserted separately: one shared assertion would pass while the other
    // page rotted.
    for (const lang of QUICK_REFERENCE_PAGES) {
      const pages = defaultQuickReference({ commands: 1, tools: REAL_TOOL_NAMES.size, skills: 1 });
      pages[lang] = pages[lang].replace(/\b1 slash commands/g, '99 slash commands');
      const root = makeRepo({ quickReferenceHtml: pages });
      const { issues } = validateRepo(root);
      const found = issues.find((i) => i.ruleId === `quick-reference-${lang}-commands`);
      assert.ok(found, `${lang}: ${renderIssues(issues)}`);
      assert.equal(found.code, 'doc-counter');
      assert.match(found.message, /claims 99 slash commands; the repo has 1/);
    }
  });

  test('a quick-reference rule that matches NOTHING is itself an error', () => {
    // A page reworded so the rule stops matching must be LOUD: that is a
    // check switching itself off, which is how the PDFs drifted unnoticed.
    for (const lang of QUICK_REFERENCE_PAGES) {
      const pages = defaultQuickReference({ commands: 1, tools: REAL_TOOL_NAMES.size, skills: 1 });
      pages[lang] = pages[lang].replace(/\d+ skills/g, 'lots of skills');
      const root = makeRepo({ quickReferenceHtml: pages });
      const { issues } = validateRepo(root);
      const found = issues.find((i) => i.ruleId === `quick-reference-${lang}-skills`);
      assert.ok(found, `${lang}: ${renderIssues(issues)}`);
      assert.equal(found.code, 'counter-site-missing');
      assert.match(found.message, /matched nothing/);
    }
  });

  test('a quick-reference page that states its count ONCE instead of twice is an error', () => {
    // Both real pages carry each count at the masthead AND the section
    // heading. Losing one leaves a correct number under half the guard.
    for (const lang of QUICK_REFERENCE_PAGES) {
      const id = `quick-reference-${lang}-tools`;
      const min = minMatchesFor(id);
      assert.ok(min >= 2, `${id} should guard at least two sites`);
      const pages = defaultQuickReference({
        commands: 1, tools: REAL_TOOL_NAMES.size, skills: 1, sites: { [id]: min - 1 },
      });
      const root = makeRepo({ quickReferenceHtml: pages });
      const { issues } = validateRepo(root);
      const found = issues.find((i) => i.ruleId === id && i.code === 'counter-site-missing');
      assert.ok(found, `${lang}: ${renderIssues(issues)}`);
      assert.match(found.message, new RegExp(`down from the ${min} it is meant to guard`));
    }
  });

  test('a missing counter FILE is an error, not a silent skip', () => {
    const root = makeRepo({ omit: ['README.md'] });
    const { issues } = validateRepo(root);
    const found = issues.filter((i) => i.code === 'counter-site-missing');
    assert.ok(found.some((i) => i.where === 'README.md'), renderIssues(issues));
  });

  test('the architecture breakdown must sum to its own total', () => {
    const root = makeRepo({
      architecture: `Holds **${REAL_TOOL_NAMES.size} MCP tools**: a (1), b (2).\n`,
    });
    const { issues } = validateRepo(root);
    assert.ok(issues.some((i) => i.code === 'doc-counter' && /breakdown sums to 3/.test(i.message)),
      renderIssues(issues));
  });
});

// ---------------------------------------------------------------------------
// The honesty rule
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The published PDF must have been rendered from the page as it stands
// ---------------------------------------------------------------------------

describe('quick-reference freshness — pinning the SOURCE is only half the guard', () => {
  test('a clean fixture is fresh in both languages', () => {
    const root = makeRepo();
    const rows = quickReferenceFreshness(root);
    assert.deepEqual(rows.map((r) => r.lang), [...QUICK_REFERENCE_PAGES]);
    assert.deepEqual(rows.map((r) => r.state), rows.map(() => 'fresh'), JSON.stringify(rows));
    assert.deepEqual(checkQuickReferenceFreshness(root), []);
  });

  test('editing a page without re-rendering is an error — the whole point', () => {
    // The failure this closes: someone fixes a counter in the HTML, the
    // COUNTER_RULES above go green, and the PDF everyone actually reads still
    // carries the old number. One page is touched at a time so the message
    // has to name the right one.
    for (const lang of QUICK_REFERENCE_PAGES) {
      const root = makeRepo();
      fs.appendFileSync(path.join(root, `docs/quick-reference-${lang}.html`), '<p>edited after the render</p>\n');
      const rows = quickReferenceFreshness(root);
      assert.equal(rows.find((r) => r.lang === lang).state, 'stale');
      for (const other of QUICK_REFERENCE_PAGES.filter((l) => l !== lang)) {
        assert.equal(rows.find((r) => r.lang === other).state, 'fresh');
      }
      const issues = checkQuickReferenceFreshness(root);
      assert.equal(issues.length, 1, JSON.stringify(issues));
      assert.equal(issues[0].code, 'quick-reference-stale');
      assert.match(issues[0].message, new RegExp(`quick-reference-${lang}\\.html has changed`));
      assert.match(issues[0].fix, /npm run docs:quick-reference/);
    }
  });

  test('a page nothing has ever recorded is an error, not a pass', () => {
    // "No hash for it" must never read as "nothing to check" — a check that
    // skips what it cannot see is the shape that let this drift happen.
    const root = makeRepo({ omit: ['quick-reference-manifest'] });
    const rows = quickReferenceFreshness(root);
    assert.deepEqual(rows.map((r) => r.state), rows.map(() => 'unrecorded'));
    const issues = checkQuickReferenceFreshness(root);
    assert.equal(issues.length, QUICK_REFERENCE_PAGES.length);
    for (const i of issues) assert.equal(i.code, 'quick-reference-stale');
  });

  test('a manifest that records only ONE page leaves the other reported', () => {
    // A half-written manifest is the plausible accident: it must not buy
    // silence for the page it omits.
    const root = makeRepo();
    const only = QUICK_REFERENCE_PAGES[0];
    const rel = `docs/quick-reference-${only}.html`;
    fs.writeFileSync(
      path.join(root, QUICK_REFERENCE_MANIFEST),
      JSON.stringify({ renderedFrom: { [rel]: sha256OfFile(path.join(root, rel)) } }, null, 2),
    );
    const rows = quickReferenceFreshness(root);
    assert.equal(rows.find((r) => r.lang === only).state, 'fresh');
    for (const other of QUICK_REFERENCE_PAGES.slice(1)) {
      assert.equal(rows.find((r) => r.lang === other).state, 'unrecorded');
    }
  });

  test('a published PDF that has gone missing is an error', () => {
    const root = makeRepo({ omit: ['quick-reference-pdf'] });
    const issues = checkQuickReferenceFreshness(root);
    assert.equal(issues.length, QUICK_REFERENCE_PAGES.length, JSON.stringify(issues));
    for (const i of issues) assert.equal(i.code, 'quick-reference-missing');
    assert.match(issues[0].message, /the page nobody can read is the published one/);
  });

  test('a missing SOURCE page is an error, not a silent skip', () => {
    const root = makeRepo();
    fs.rmSync(path.join(root, `docs/quick-reference-${QUICK_REFERENCE_PAGES[0]}.html`));
    const issues = checkQuickReferenceFreshness(root);
    const found = issues.find((i) => i.code === 'quick-reference-missing');
    assert.ok(found, JSON.stringify(issues));
    assert.match(found.message, /does not exist, but the validator watches it/);
  });

  test('a freshness helper that reports NOTHING is itself an error', () => {
    // The check's own kill-switch. If QUICK_REFERENCE_PAGES were ever emptied,
    // every per-page assertion above would vacuously pass and the gate would
    // be off while reading green — the exact failure mode this module exists
    // to prevent, so it is asserted rather than assumed.
    const issues = checkQuickReferenceFreshness(makeRepo(), () => []);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, 'quick-reference-unreadable');
    assert.match(issues[0].message, /reported no pages at all/);
  });

  test('a freshness helper that THROWS is reported, never swallowed', () => {
    const issues = checkQuickReferenceFreshness(makeRepo(), () => { throw new Error('disk gone'); });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, 'quick-reference-unreadable');
    assert.match(issues[0].message, /disk gone/);
  });

  test('a CRLF checkout of the SAME page is still fresh — the hash is content, not bytes', () => {
    // The defect this closes, found by the first CI run that used the check:
    // this repo checks out LF (`core.autocrlf=input`), a GitHub Windows runner
    // checks out CRLF (`core.autocrlf=true`). Same commit, same content,
    // different bytes — and `validate` failed on Windows while passing on
    // Linux, reporting every page as stale. Chrome renders both identically,
    // so the recorded hash must be a property of the page, not of whoever
    // checked it out.
    const root = makeRepo();
    for (const lang of QUICK_REFERENCE_PAGES) {
      const p = path.join(root, `docs/quick-reference-${lang}.html`);
      const lf = fs.readFileSync(p, 'utf8');
      assert.equal(lf.includes('\r\n'), false, 'the fixture must start out LF');
      fs.writeFileSync(p, lf.replace(/\n/g, '\r\n'));
    }
    const rows = quickReferenceFreshness(root);
    assert.deepEqual(
      rows.map((r) => r.state),
      rows.map(() => 'fresh'),
      `a CRLF checkout must not read as stale: ${JSON.stringify(rows)}`,
    );
    assert.deepEqual(checkQuickReferenceFreshness(root), []);
  });

  test('runCapabilityValidation actually RUNS the check — not just exports it', () => {
    // Every other test in this block calls checkQuickReferenceFreshness
    // directly, so deleting its one line in runCapabilityValidation would
    // leave them all green while `npm run validate` stopped checking. A
    // check that exists and is never called is the same as no check.
    const root = makeRepo();
    fs.appendFileSync(path.join(root, `docs/quick-reference-${QUICK_REFERENCE_PAGES[0]}.html`), '<p>drift</p>\n');
    const { issues } = validateRepo(root);
    const found = issues.find((i) => i.code === 'quick-reference-stale');
    assert.ok(found, `the validator did not surface the stale page: ${renderIssues(issues)}`);
  });

  test('the LIVE repo ships PDFs rendered from the current pages', () => {
    // Not a fixture: the real docs/, the artifact that actually ships.
    assert.deepEqual(checkQuickReferenceFreshness(REPO_ROOT), []);
  });
});

// ---------------------------------------------------------------------------
// The masthead must name the release the repo is at — and only the masthead
// ---------------------------------------------------------------------------

describe('quick-reference version — the counters were pinned, the version was not', () => {
  test('a clean fixture agrees with its package.json', () => {
    assert.deepEqual(checkQuickReferenceVersion(makeRepo(), REPO_VERSION), []);
  });

  test('a masthead one release behind is an error, in EITHER language', () => {
    // v0.91.0 nearly shipped exactly this: `npm run bump` syncs five spots and
    // had never touched these two pages.
    for (const lang of QUICK_REFERENCE_PAGES) {
      const pages = defaultQuickReference({ commands: 1, tools: REAL_TOOL_NAMES.size, skills: 1 });
      pages[lang] = pages[lang].replace(`class="meta">v${REPO_VERSION}`, 'class="meta">v9.9.8');
      const root = makeRepo({ quickReferenceHtml: pages });
      const issues = checkQuickReferenceVersion(root, REPO_VERSION);
      assert.equal(issues.length, 1, `${lang}: ${JSON.stringify(issues)}`);
      assert.equal(issues[0].code, 'quick-reference-version');
      assert.match(issues[0].message, new RegExp(`quick-reference-${lang}\\.html states v9\\.9\\.8`));
    }
  });

  test('the HISTORICAL version in the page is left alone', () => {
    // Each page names a version twice and they mean opposite things. A check
    // that matched a bare `v<x.y.z>` would demand rewriting the past to make
    // the present pass — the trap this anchor exists to avoid.
    const root = makeRepo();
    for (const lang of QUICK_REFERENCE_PAGES) {
      const body = fs.readFileSync(path.join(root, `docs/quick-reference-${lang}.html`), 'utf8');
      assert.match(body, /binding \(v0\.1\.0\) shipped it/, 'the fixture must carry a historical mention');
    }
    assert.deepEqual(checkQuickReferenceVersion(root, REPO_VERSION), []);
  });

  test('a page whose masthead was reworded away is an error, not a silent pass', () => {
    const root = makeRepo({
      quickReferenceHtml: defaultQuickReference({
        commands: 1, tools: REAL_TOOL_NAMES.size, skills: 1, version: null,
      }),
    });
    const issues = checkQuickReferenceVersion(root, REPO_VERSION);
    assert.equal(issues.length, QUICK_REFERENCE_PAGES.length, JSON.stringify(issues));
    assert.match(issues[0].message, /has no `class="meta">v<x\.y\.z>` masthead/);
  });

  test('two mastheads on one page is an error — which one states the release is ambiguous', () => {
    const pages = defaultQuickReference({ commands: 1, tools: REAL_TOOL_NAMES.size, skills: 1 });
    pages.en += `\n<div class="meta">v9.9.8 · a second card</div>\n`;
    const issues = checkQuickReferenceVersion(makeRepo({ quickReferenceHtml: pages }), REPO_VERSION);
    const found = issues.find((i) => /quick-reference-en/.test(i.message));
    assert.ok(found, JSON.stringify(issues));
    assert.match(found.message, /has 2 mastheads/);
  });

  test('a missing repo version is reported, never compared against nothing', () => {
    // Comparing every masthead against `undefined` would make them all wrong,
    // or — worse, with a loose check — all right.
    const issues = checkQuickReferenceVersion(makeRepo(), undefined);
    assert.equal(issues.length, 1);
    assert.match(issues[0].message, /version was not supplied/);
  });

  test('a version helper that reports NOTHING is itself an error', () => {
    const issues = checkQuickReferenceVersion(makeRepo(), REPO_VERSION, () => []);
    assert.equal(issues.length, 1);
    assert.match(issues[0].message, /reported no pages at all/);
  });

  test('runCapabilityValidation actually RUNS the version check', () => {
    // Same reasoning as the freshness wiring test: every case above calls the
    // function directly, so deleting its call site would leave them all green.
    const pages = defaultQuickReference({ commands: 1, tools: REAL_TOOL_NAMES.size, skills: 1 });
    pages.en = pages.en.replace(`class="meta">v${REPO_VERSION}`, 'class="meta">v9.9.8');
    const { issues } = validateRepo(makeRepo({ quickReferenceHtml: pages }));
    assert.ok(
      issues.find((i) => i.code === 'quick-reference-version'),
      `the validator did not surface the stale masthead: ${renderIssues(issues)}`,
    );
  });

  test('the LIVE repo mastheads name the version in its package.json', () => {
    const version = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
    assert.deepEqual(checkQuickReferenceVersion(REPO_ROOT, version), []);
  });
});

describe('honesty rule — a tier must be substantiated or admitted', () => {
  const base = { skills: { alpha: 'Call `get_file`.' } };
  const withVerification = (verification) => makeRepo({
    ...base,
    declarations: { schemaVersion: SCHEMA_VERSION, skills: { alpha: goodEntry({ verification }) } },
  });

  test('`declared` with no reason is REFUSED', () => {
    const { issues } = validateRepo(withVerification({ status: 'declared' }));
    assert.ok(codes(issues).includes('honesty'), renderIssues(issues));
    assert.match(issues.find((i) => i.code === 'honesty').message, /no written reason/);
  });

  test('`declared` with an EMPTY reason is REFUSED (whitespace is not a reason)', () => {
    const { issues } = validateRepo(withVerification({ status: 'declared', reason: '   ' }));
    assert.ok(codes(issues).includes('honesty'), renderIssues(issues));
  });

  test('`verified` with no evidence is REFUSED', () => {
    const { issues } = validateRepo(withVerification({ status: 'verified' }));
    assert.ok(codes(issues).includes('honesty'), renderIssues(issues));
    assert.match(issues.find((i) => i.code === 'honesty').message, /no `evidence`/);
  });

  test('`verified` with an EMPTY evidence array is REFUSED', () => {
    const { issues } = validateRepo(withVerification({ status: 'verified', evidence: [] }));
    assert.ok(codes(issues).includes('honesty'), renderIssues(issues));
  });

  test('`verified` citing a file that does not exist is REFUSED', () => {
    const { issues } = validateRepo(withVerification({ status: 'verified', evidence: ['tests/nope.test.mjs'] }));
    assert.ok(issues.some((i) => i.code === 'honesty' && /does not exist/.test(i.message)),
      renderIssues(issues));
  });

  test('`verified` citing a REAL file that never mentions the skill is REFUSED', () => {
    // The subtle cheat this closes: point `evidence` at any large existing
    // suite and the badge looks substantiated. It must actually exercise
    // the skill it vouches for.
    const root = makeRepo(base);
    fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tests', 'unrelated.test.mjs'), 'nothing about that skill here');
    fs.writeFileSync(path.join(root, DECLARATIONS_PATH), JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      skills: {
        alpha: goodEntry({ verification: { status: 'verified', evidence: ['tests/unrelated.test.mjs'] } }),
      },
    }));
    const { issues } = validateRepo(root);
    assert.ok(issues.some((i) => i.code === 'honesty' && /never names/.test(i.message)),
      renderIssues(issues));
  });

  test('`verified` citing a file OUTSIDE tests/ is REFUSED', () => {
    // Without containment, the manifest could cite the README, the SKILL.md,
    // or itself — each contains the skill name, so each would satisfy a
    // naive substring check.
    const root = makeRepo(base);
    const { issues } = validateRepo(withDecl(root, {
      alpha: goodEntry({ verification: { status: 'verified', evidence: ['README.md'] } }),
    }));
    assert.ok(issues.some((i) => i.code === 'honesty' && /outside `tests\/`/.test(i.message)),
      renderIssues(issues));
  });

  test('`verified` citing a path that ESCAPES the repo is REFUSED', () => {
    const root = makeRepo(base);
    const { issues } = validateRepo(withDecl(root, {
      alpha: goodEntry({ verification: { status: 'verified', evidence: ['../../elsewhere.test.mjs'] } }),
    }));
    assert.ok(issues.some((i) => i.code === 'honesty'), renderIssues(issues));
  });

  test('`verified` citing an ABSOLUTE path is REFUSED', () => {
    const root = makeRepo(base);
    const { issues } = validateRepo(withDecl(root, {
      alpha: goodEntry({ verification: { status: 'verified', evidence: [path.join(root, 'tests', 'x.test.mjs')] } }),
    }));
    assert.ok(issues.some((i) => i.code === 'honesty' && /absolute path/.test(i.message)),
      renderIssues(issues));
  });

  test('`verified` citing a non-test file inside tests/ is REFUSED', () => {
    const root = makeRepo(base);
    fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tests', 'alpha-notes.md'), 'all about alpha');
    const { issues } = validateRepo(withDecl(root, {
      alpha: goodEntry({ verification: { status: 'verified', evidence: ['tests/alpha-notes.md'] } }),
    }));
    assert.ok(issues.some((i) => i.code === 'honesty' && /not a `\*\.test\.mjs` file/.test(i.message)),
      renderIssues(issues));
  });

  test('a SUBSTRING match does not count as naming the skill', () => {
    // `save` is a substring of "unsaved", "saves", "saved" — almost any
    // file would have vouched for it under a plain includes() check.
    const root = makeRepo({ skills: { save: 'Call `get_file`.' } });
    fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tests', 'other.test.mjs'), 'assert(unsaved === saved);');
    const { issues } = validateRepo(withDecl(root, {
      save: goodEntry({ verification: { status: 'verified', evidence: ['tests/other.test.mjs'] } }),
    }));
    assert.ok(issues.some((i) => i.code === 'honesty' && /never names/.test(i.message)),
      renderIssues(issues));
  });

  test('a non-string evidence element is a finding, not a crash', () => {
    // `path.join(root, {…})` used to throw, turning a malformed manifest
    // into a broken-looking validator.
    const root = makeRepo(base);
    assert.doesNotThrow(() => {
      const { issues } = validateRepo(withDecl(root, {
        alpha: goodEntry({ verification: { status: 'verified', evidence: [{ file: 'x' }] } }),
      }));
      assert.ok(codes(issues).includes('schema'), renderIssues(issues));
    });
  });

  test('an unknown key inside `verification` is REFUSED', () => {
    const { issues } = validateRepo(withVerification({
      status: 'declared', reason: 'nothing executes a skill', confidence: 'high',
    }));
    assert.ok(issues.some((i) => i.code === 'honesty' && /does not allow/.test(i.message)),
      renderIssues(issues));
  });

  test('`verified` citing a real file that DOES mention the skill is accepted', () => {
    // The rung must be reachable — a tier nobody can ever claim is not a
    // standard, it is decoration.
    const root = makeRepo(base);
    fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tests', 'alpha.test.mjs'), 'exercises the alpha skill end to end');
    fs.writeFileSync(path.join(root, DECLARATIONS_PATH), JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      skills: {
        alpha: goodEntry({ verification: { status: 'verified', evidence: ['tests/alpha.test.mjs'] } }),
      },
    }));
    assert.deepEqual(validateRepo(root).issues, []);
  });

  test('an unknown status is REFUSED (no inventing a comfortable tier)', () => {
    const { issues } = validateRepo(withVerification({ status: 'probably-fine', reason: 'trust me' }));
    assert.ok(codes(issues).includes('honesty'), renderIssues(issues));
  });

  test('a missing verification block is REFUSED', () => {
    const root = makeRepo(base);
    const entry = goodEntry();
    delete entry.verification;
    fs.writeFileSync(path.join(root, DECLARATIONS_PATH),
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, skills: { alpha: entry } }));
    assert.ok(codes(validateRepo(root).issues).includes('honesty'));
  });

  test('there is no tier between `verified` and `declared`', () => {
    // Pinned deliberately: "enforced by the sub-agent allowlist" was
    // considered and rejected, because the allowlist binds only the batch
    // path. If someone re-adds a middle rung, this test forces them to
    // re-argue it here.
    assert.deepEqual([...VERIFICATION_STATUSES], ['verified', 'declared']);
  });
});

describe('honesty rule — an unreviewed bootstrap cannot pass', () => {
  test('the sentinel in a reason is an error even though the entry is well-formed', () => {
    const root = makeRepo({
      skills: { alpha: 'Call `get_file`.' },
      declarations: {
        schemaVersion: SCHEMA_VERSION,
        skills: {
          alpha: goodEntry({
            verification: { status: 'declared', reason: `${BOOTSTRAP_SENTINEL}: generated, review me` },
          }),
        },
      },
    });
    const { issues } = validateRepo(root);
    assert.ok(codes(issues).includes('unreviewed-bootstrap'), renderIssues(issues));
  });

  test('the shipped declarations carry no sentinel anywhere', () => {
    const raw = fs.readFileSync(path.join(REPO_ROOT, DECLARATIONS_PATH), 'utf8');
    assert.ok(!raw.includes(BOOTSTRAP_SENTINEL),
      'contracts/skill-capabilities.json still holds an unreviewed bootstrap entry');
  });
});

// ---------------------------------------------------------------------------
// doc ↔ manifest ↔ code: the tool triangle
// ---------------------------------------------------------------------------

describe('tool declarations', () => {
  test('a declared tool that is not in the router catalog is an error', () => {
    const root = makeRepo({
      declarations: {
        schemaVersion: SCHEMA_VERSION,
        skills: { alpha: goodEntry({ tools: ['get_file', 'teleport_file'] }) },
      },
    });
    const { issues } = validateRepo(root);
    assert.ok(codes(issues).includes('unknown-tool'), renderIssues(issues));
    assert.match(issues.find((i) => i.code === 'unknown-tool').message, /teleport_file/);
  });

  test('a tool the SKILL.md names but the contract ignores is an error', () => {
    // This is the check that fires when a skill quietly gains a tool call.
    const root = makeRepo({
      skills: { alpha: 'Call `get_file`, then `delete_file` to clean up.' },
      declarations: { schemaVersion: SCHEMA_VERSION, skills: { alpha: goodEntry() } },
    });
    const { issues } = validateRepo(root);
    assert.ok(codes(issues).includes('unaccounted-tool-mention'), renderIssues(issues));
    assert.match(issues.find((i) => i.code === 'unaccounted-tool-mention').message, /delete_file/);
  });

  test('...and accounting for it as a PROSE mention clears it without granting it', () => {
    const root = makeRepo({
      skills: { alpha: 'Call `get_file`. Never use `delete_file` here.' },
      declarations: {
        schemaVersion: SCHEMA_VERSION,
        skills: { alpha: goodEntry({ toolsMentionedNotCalled: ['delete_file'] }) },
      },
    });
    assert.deepEqual(validateRepo(root).issues, []);
  });

  test('a tool in BOTH lists is a contradiction', () => {
    // Without this, the lazy fix for the check above is to paste the tool
    // into both lists, which neutralizes it forever.
    const root = makeRepo({
      declarations: {
        schemaVersion: SCHEMA_VERSION,
        skills: { alpha: goodEntry({ toolsMentionedNotCalled: ['get_file'] }) },
      },
    });
    const { issues } = validateRepo(root);
    assert.ok(issues.some((i) => i.code === 'inconsistent' && /BOTH/.test(i.message)),
      renderIssues(issues));
  });

  test('a fully-qualified mcp__ reference counts as a mention', () => {
    const root = makeRepo({
      skills: { alpha: 'Call `get_file`, then mcp__obsidian-router__patch_file.' },
      declarations: { schemaVersion: SCHEMA_VERSION, skills: { alpha: goodEntry() } },
    });
    const { issues } = validateRepo(root);
    assert.ok(issues.some((i) => i.code === 'unaccounted-tool-mention' && /patch_file/.test(i.message)),
      renderIssues(issues));
  });
});

describe('a contract may never be gentler than the tools it declares', () => {
  const withTools = (over) => makeRepo({
    skills: { alpha: 'Call `get_file`.' },
    declarations: { schemaVersion: SCHEMA_VERSION, skills: { alpha: goodEntry(over) } },
  });

  test('declaring a WRITE tool while claiming read-only is refused', () => {
    // The most direct understatement bypass: list delete_file, claim
    // read-only, and a permission engine grants a reader.
    const { issues } = validateRepo(withTools({
      tools: ['get_file', 'write_file'], toolsMentionedNotCalled: [],
    }));
    assert.ok(issues.some((i) => i.code === 'understated' && /read-only.*write tool/s.test(i.message)),
      renderIssues(issues));
  });

  test('declaring delete_file while claiming `mutating` is refused', () => {
    const { issues } = validateRepo(withTools({
      tools: ['get_file', 'delete_file'], writes: ['vault:content'], writeMode: 'mutating',
    }));
    assert.ok(issues.some((i) => i.code === 'understated' && /delete_file/.test(i.message)),
      renderIssues(issues));
  });

  test('declaring a NETWORK tool while claiming network: false is refused', () => {
    const { issues } = validateRepo(withTools({
      tools: ['get_file', 'webpage_to_markdown'], reads: ['vault:content'],
    }));
    assert.ok(issues.some((i) => i.code === 'understated' && /requires\.network/.test(i.message)),
      renderIssues(issues));
  });

  test('declaring a PYTHON tool while claiming python: false is refused', () => {
    const { issues } = validateRepo(withTools({ tools: ['get_file', 'pdf_to_markdown'] }));
    assert.ok(issues.some((i) => i.code === 'understated' && /requires\.python/.test(i.message)),
      renderIssues(issues));
  });

  test('every write tool has a MINIMUM writeMode, not just the extremes', () => {
    // The first version only caught `read-only` and empty `writes`, so a
    // contract could call `write_file` and still claim `cache` ("only
    // regenerable artifacts") — an understatement a permission engine acts on.
    const tooGentle = [
      ['write_file', 'read-only'],
      ['patch_file', 'cache'],
      ['write_bundle', 'mutating'],
      ['merge_frontmatter', 'cache'],
    ];
    for (const [tool, mode] of tooGentle) {
      const { issues } = validateRepo(withTools({
        tools: ['get_file', tool],
        writes: mode === 'read-only' ? [] : ['vault:content', 'vault:frontmatter', 'vault:derived'],
        writeMode: mode,
      }));
      assert.ok(issues.some((i) => i.code === 'understated' && i.message.includes(tool)),
        `${tool} + ${mode} should be refused\n${renderIssues(issues)}`);
    }
  });

  test('`cache` may not cover authored writes', () => {
    // `cache` is defined as "only regenerable derived artifacts". Pairing it
    // with `vault:content` passed, because the consistency check only
    // compared EMPTY writes against `read-only` — so a contract could tell a
    // permission engine that authored notes were safe from a skill holding
    // `write_file`, which can replace them.
    const { issues } = validateRepo(withTools({
      tools: ['get_file', 'write_file'], writes: ['vault:content'], writeMode: 'cache',
    }));
    assert.ok(issues.some((i) => i.code === 'understated' && /not regenerable derived data/.test(i.message)),
      renderIssues(issues));
  });

  test('`cache` with only derived writes is accepted', () => {
    const { issues } = validateRepo(withTools({
      tools: ['get_file', 'build_search_index'], writes: ['vault:derived'], writeMode: 'cache',
    }));
    assert.ok(!issues.some((i) => i.code === 'understated'), renderIssues(issues));
  });

  test('a write tool with a specific target must declare that write atom', () => {
    const { issues } = validateRepo(withTools({
      tools: ['get_file', 'set_frontmatter'], writes: ['vault:content'], writeMode: 'mutating',
    }));
    assert.ok(issues.some((i) => i.code === 'understated' && /vault:frontmatter/.test(i.message)),
      renderIssues(issues));
  });

  test('a read tool must declare the read atom it implies', () => {
    // The mirror image: calling `get_file` while declaring `reads: []`.
    const { issues } = validateRepo(withTools({ tools: ['get_file'], reads: [] }));
    assert.ok(issues.some((i) => i.code === 'understated' && /vault:content/.test(i.message)),
      renderIssues(issues));
  });

  test('the PRODUCTION entry point refuses a missing write-tool set', () => {
    // The round-1 guard lived in validateDeclarations, and this suite only
    // tested it there — so the wrapper `runCapabilityValidation` was free to
    // normalise `undefined` into `new Set()` before the call, silently
    // disarming every write-understatement check in the path that actually
    // runs. Testing the guard at the layer callers use is the whole point.
    const root = makeRepo({
      skills: { alpha: 'Call `get_file`.' },
      declarations: {
        schemaVersion: SCHEMA_VERSION,
        skills: { alpha: goodEntry({ tools: ['get_file', 'write_file'] }) },
      },
    });
    const { issues } = runCapabilityValidation(root, { toolNames: REAL_TOOL_NAMES });
    assert.ok(issues.some((i) => i.code === 'schema' && /write-tool classification/.test(i.message)),
      renderIssues(issues));
  });

  test('the check DISARMS ITSELF LOUDLY when the write-tool set is missing', () => {
    // It used to default to an empty Set "harmlessly", which silently
    // switched off the flagship understatement check for any caller that
    // forgot the argument — including every fixture in this file.
    const issues = validateDeclarations({
      skills: [{ name: 'a', skillMdPath: 'skills/a/SKILL.md', text: '' }],
      agents: new Map(),
      toolNames: new Set(['get_file']),
      declarations: { schemaVersion: SCHEMA_VERSION, skills: { a: goodEntry() } },
      repoRoot: REPO_ROOT,
    });
    assert.ok(issues.some((i) => i.code === 'schema' && /write-tool classification/.test(i.message)),
      JSON.stringify(issues, null, 1));
  });

  test('a SKILL.md that shells out while the contract says shell: false is refused', () => {
    const root = makeRepo({
      skills: { alpha: 'Call `get_file`, then run this:\n\n```bash\nnode scripts/x.mjs\n```\n' },
      declarations: { schemaVersion: SCHEMA_VERSION, skills: { alpha: goodEntry() } },
    });
    const { issues } = validateRepo(root);
    assert.ok(issues.some((i) => i.code === 'understated' && /requires\.shell/.test(i.message)),
      renderIssues(issues));
  });

  test('a SKILL.md that uses WebFetch while claiming network: false is refused', () => {
    const root = makeRepo({
      skills: { alpha: 'Call `get_file`. Use WebFetch to grab the page.' },
      declarations: { schemaVersion: SCHEMA_VERSION, skills: { alpha: goodEntry() } },
    });
    const { issues } = validateRepo(root);
    assert.ok(issues.some((i) => i.code === 'understated' && /requires\.network/.test(i.message)),
      renderIssues(issues));
  });

  test('a BARE (unbackticked) tool name is still a mention', () => {
    // Dropping the backticks must not erase a permission-relevant mention:
    // formatting cannot change what a capability scan sees.
    const root = makeRepo({
      skills: { alpha: 'Call `get_file`, then delete_file to clean up.' },
      declarations: { schemaVersion: SCHEMA_VERSION, skills: { alpha: goodEntry() } },
    });
    const { issues } = validateRepo(root);
    assert.ok(issues.some((i) => i.code === 'unaccounted-tool-mention' && /delete_file/.test(i.message)),
      renderIssues(issues));
  });

  test('a tool name inside a fenced code block is still a mention', () => {
    const root = makeRepo({
      skills: { alpha: 'Call `get_file`.\n\n```js\ncallTool("delete_file")\n```\n' },
      declarations: { schemaVersion: SCHEMA_VERSION, skills: { alpha: goodEntry() } },
    });
    const { issues } = validateRepo(root);
    assert.ok(issues.some((i) => i.code === 'unaccounted-tool-mention' && /delete_file/.test(i.message)),
      renderIssues(issues));
  });
});

describe('delegation may not launder reach', () => {
  const twoSkills = (parentEntry, childEntry, parentBody = 'Call `get_file`.') => makeRepo({
    skills: { parent: parentBody, child: 'Call `get_file`.' },
    declarations: {
      schemaVersion: SCHEMA_VERSION,
      skills: { parent: goodEntry(parentEntry), child: goodEntry(childEntry) },
    },
  });

  test('a parent weaker than its delegate is refused', () => {
    const { issues } = validateRepo(twoSkills(
      { delegatesTo: ['child'] },
      { writes: ['vault:content'], writeMode: 'destructive', tools: ['get_file'] },
    ));
    assert.ok(issues.some((i) => i.code === 'understated' && /delegates to `child`, which is `destructive`/.test(i.message)),
      renderIssues(issues));
  });

  test('a parent that omits a delegate requirement is refused', () => {
    const { issues } = validateRepo(twoSkills(
      { delegatesTo: ['child'] },
      { requires: { shell: true, network: false, python: false, obsidianPlugins: [], binaries: [] } },
    ));
    assert.ok(issues.some((i) => i.code === 'understated' && /requires\.shell: false but delegates/.test(i.message)),
      renderIssues(issues));
  });

  test('a parent that omits a delegate read atom is refused', () => {
    const { issues } = validateRepo(twoSkills(
      { delegatesTo: ['child'] },
      { reads: ['vault:content', 'web'] },
    ));
    assert.ok(issues.some((i) => i.code === 'understated' && /omits 1 read atom\(s\).*web/.test(i.message)),
      renderIssues(issues));
  });

  test('an UNDECLARED delegation edge is refused', () => {
    // Without this, `delegatesTo` becomes a way to HIDE reach: omit the edge
    // and the whole closure machinery never runs.
    const { issues } = validateRepo(twoSkills(
      {}, {}, 'Call `get_file`, then invoke the `child` skill.',
    ));
    assert.ok(issues.some((i) => i.code === 'unaccounted-delegation' && /child/.test(i.message)),
      renderIssues(issues));
  });

  test('an INVERTED mention ("invoked from X") is not a delegation edge', () => {
    // Read as one it points the edge backwards, and a read-only fetcher
    // would inherit the closure of whatever calls it.
    const { issues } = validateRepo(twoSkills(
      {}, {}, 'Call `get_file`. If invoked from `child`, return the object.',
    ));
    assert.ok(!codes(issues).includes('unaccounted-delegation'), renderIssues(issues));
  });

  test('a bare cross-reference is not a delegation edge', () => {
    // `lock` inside "block", `wiki` inside `["wiki/"]`, `call` inside
    // "deterministically" — every one of these produced a false edge before
    // the matcher required an addressable handle and a word boundary.
    const { issues } = validateRepo(twoSkills(
      {}, {}, 'Call `get_file`. This runs deterministically; see child for details, and note the block returns ["child/"].',
    ));
    assert.ok(!codes(issues).includes('unaccounted-delegation'), renderIssues(issues));
  });

  test('mentionedSkills: each supported phrase, and each excluded one', () => {
    // The suite used to pin exactly the one phrasing that worked, so it
    // could not notice the matcher missing or over-matching anything else.
    // Every row here is a decision the matcher makes, stated out loud.
    const names = ['wiki-ingest', 'wiki-lint', 'conventions'];
    const cases = [
      // detected — an invocation verb plus an addressable handle
      ['invoke the `wiki-ingest` skill.', 'wiki-ingest', true],
      ['delegate to `wiki-ingest` for each source.', 'wiki-ingest', true],
      ['hand off to `wiki-ingest`.', 'wiki-ingest', true],
      ['fan out via the wiki-ingest sub-agent.', 'wiki-ingest', true],
      ['invoke the `/obsidian-router:conventions` command.', 'conventions', true],
      // NOT detected — and each for a reason
      ['The caller of the `wiki-lint` skill must pass X.', 'wiki-lint', false],   // "call" inside "caller"
      ['Register a callback for the `wiki-ingest` sub-agent.', 'wiki-ingest', false],
      ['Never invoke the `wiki-ingest` skill yourself.', 'wiki-ingest', false],   // prohibition
      ['Do not call `wiki-ingest` here.', 'wiki-ingest', false],
      ['If invoked from `wiki-ingest`, return early.', 'wiki-ingest', false],     // inverted edge
      ['This runs deterministically; see wiki-lint docs.', 'wiki-lint', false],
      // KNOWN BLIND SPOT, pinned so it is a decision and not a surprise:
      // weak verbs are excluded because "→ use `wiki` skill" is a redirect
      // to the USER, and counting those produced six false edges per true one.
      ['Use the `wiki-ingest` skill to file it.', 'wiki-ingest', false],
      ['For each source, run the `wiki-ingest` skill.', 'wiki-ingest', false],
    ];
    for (const [text, target, expected] of cases) {
      assert.equal(mentionedSkills(text, names, 'self').has(target), expected,
        `${expected ? 'should' : 'should NOT'} detect ${target} in: ${text}`);
    }
  });

  test('a delegation CYCLE is refused', () => {
    const root = makeRepo({
      skills: { a: 'x', b: 'x' },
      declarations: {
        schemaVersion: SCHEMA_VERSION,
        skills: {
          a: goodEntry({ delegatesTo: ['b'], tools: [] }),
          b: goodEntry({ delegatesTo: ['a'], tools: [] }),
        },
      },
    });
    const { issues } = validateRepo(root);
    assert.ok(issues.some((i) => i.code === 'inconsistent' && /delegation cycle/.test(i.message)),
      renderIssues(issues));
  });
});

describe('sub-agent allowlists must not exceed their skill contract', () => {
  test('an agent granted a tool the contract omits is an error', () => {
    const root = makeRepo({
      skills: { alpha: 'Call `get_file`.' },
      agents: { alpha: 'Read, mcp__obsidian-router__get_file, mcp__obsidian-router__delete_file' },
      declarations: { schemaVersion: SCHEMA_VERSION, skills: { alpha: goodEntry() } },
    });
    const { issues } = validateRepo(root);
    assert.ok(codes(issues).includes('agent-exceeds-contract'), renderIssues(issues));
    assert.match(issues.find((i) => i.code === 'agent-exceeds-contract').message, /delete_file/);
  });

  test('an agent granted LESS than the contract is fine', () => {
    // The batch path is legitimately a subset of what the skill can do
    // in-process. Flagging that direction would be noise.
    const root = makeRepo({
      skills: { alpha: 'Call `get_file`.' },
      agents: { alpha: 'Read, Glob' },
      declarations: { schemaVersion: SCHEMA_VERSION, skills: { alpha: goodEntry() } },
    });
    assert.deepEqual(validateRepo(root).issues, []);
  });

  test('harness tools in an allowlist are ignored, not reported', () => {
    const root = makeRepo({
      skills: { alpha: 'Call `get_file`.' },
      agents: { alpha: 'Read, Glob, Grep, WebFetch, mcp__obsidian-router__get_file' },
      declarations: { schemaVersion: SCHEMA_VERSION, skills: { alpha: goodEntry() } },
    });
    assert.deepEqual(validateRepo(root).issues, []);
  });

  test('both MCP namespace spellings collapse to the same tool', () => {
    const root = makeRepo({
      skills: { alpha: 'Call `get_file`.' },
      agents: { alpha: 'mcp__obsidian-router__get_file, mcp__plugin_obsidian-router_router__get_file' },
      declarations: { schemaVersion: SCHEMA_VERSION, skills: { alpha: goodEntry() } },
    });
    assert.deepEqual(validateRepo(root).issues, []);
  });

  test('a namespaced grant naming no catalog tool is refused', () => {
    // The harness-tool filter (which correctly ignores `Read`, `WebFetch`)
    // used to swallow `delete_flie` too — a typo'd or renamed-away router
    // grant, invisible.
    const root = makeRepo({
      skills: { alpha: 'Call `get_file`.' },
      agents: { alpha: 'Read, mcp__obsidian-router__get_file, mcp__obsidian-router__delete_flie' },
    });
    const { issues } = validateRepo(root);
    assert.ok(issues.some((i) => i.code === 'unknown-tool' && /delete_flie/.test(i.message)),
      renderIssues(issues));
  });

  test('an agent whose allowlist cannot be parsed is refused, not treated as empty', () => {
    // A block-style YAML list silently yielded an EMPTY allowlist, which
    // made "the agent grants nothing beyond its contract" trivially true —
    // the cross-check switching itself off for the one file whose format
    // changed.
    const root = makeRepo({ skills: { alpha: 'Call `get_file`.' } });
    fs.writeFileSync(path.join(root, 'agents', 'alpha.md'),
      '---\nname: alpha\ntools:\n  - Read\n  - mcp__obsidian-router__get_file\n---\n\nbody\n');
    const { issues } = validateRepo(root);
    assert.ok(codes(issues).includes('agent-allowlist-unreadable'), renderIssues(issues));
  });

  test('an agent with no same-named skill is not checked', () => {
    const root = makeRepo({
      agents: { standalone: 'mcp__obsidian-router__delete_file' },
    });
    assert.deepEqual(validateRepo(root).issues, []);
  });
});

// ---------------------------------------------------------------------------
// Schema + internal consistency
// ---------------------------------------------------------------------------

describe('entry schema', () => {
  const withEntry = (over) => makeRepo({
    declarations: { schemaVersion: SCHEMA_VERSION, skills: { alpha: goodEntry(over) } },
  });

  test('an unknown top-level key is refused', () => {
    assert.ok(codes(validateRepo(withEntry({ mood: 'cheerful' })).issues).includes('schema'));
  });

  test('an unknown read atom is refused', () => {
    assert.ok(codes(validateRepo(withEntry({ reads: ['vault:vibes'] })).issues).includes('schema'));
  });

  test('an unknown write atom is refused', () => {
    assert.ok(codes(validateRepo(withEntry({ writes: ['everything'], writeMode: 'mutating' })).issues).includes('schema'));
  });

  test('an unknown writeMode is refused', () => {
    assert.ok(codes(validateRepo(withEntry({ writeMode: 'yolo' })).issues).includes('schema'));
  });

  test('a non-boolean requires flag is refused', () => {
    const issues = validateRepo(withEntry({
      requires: { shell: 'maybe', network: false, python: false, obsidianPlugins: [], binaries: [] },
    })).issues;
    assert.ok(issues.some((i) => i.code === 'schema' && /must be a boolean/.test(i.message)));
  });

  test('an unknown requires key is refused', () => {
    const issues = validateRepo(withEntry({
      requires: { shell: false, network: false, python: false, obsidianPlugins: [], binaries: [], gpu: true },
    })).issues;
    assert.ok(issues.some((i) => i.code === 'schema' && /unknown key `gpu`/.test(i.message)));
  });

  test('a missing summary is refused', () => {
    assert.ok(codes(validateRepo(withEntry({ summary: '  ' })).issues).includes('schema'));
  });

  test('writes with writeMode read-only is a contradiction', () => {
    const issues = validateRepo(withEntry({ writes: ['vault:content'] })).issues;
    assert.ok(issues.some((i) => i.code === 'inconsistent' && /but declares write atoms/.test(i.message)),
      renderIssues(issues));
  });

  test('no writes with a writing writeMode is a contradiction', () => {
    const issues = validateRepo(withEntry({ writes: [], writeMode: 'mutating' })).issues;
    assert.ok(issues.some((i) => i.code === 'inconsistent' && /no write atoms/.test(i.message)));
  });

  test('delegatesTo pointing at a non-skill is refused', () => {
    assert.ok(codes(validateRepo(withEntry({ delegatesTo: ['nowhere'] })).issues).includes('unknown-delegate'));
  });

  test('delegatesTo pointing at itself is refused', () => {
    assert.ok(codes(validateRepo(withEntry({ delegatesTo: ['alpha'] })).issues).includes('inconsistent'));
  });

  test('a future schemaVersion is refused outright, not parsed optimistically', () => {
    const root = makeRepo({
      declarations: { schemaVersion: SCHEMA_VERSION + 1, skills: {} },
    });
    const { issues } = validateRepo(root);
    assert.ok(codes(issues).includes('schema'));
    // It must NOT then go on to report every skill as undeclared — that
    // buries the one finding that matters under 46 noisy ones.
    assert.ok(!codes(issues).includes('undeclared-skill'), renderIssues(issues));
  });

  test('a missing declarations file is one clear finding', () => {
    const root = makeRepo({ omit: ['contracts'] });
    const { issues } = validateRepo(root);
    assert.ok(issues.some((i) => i.code === 'schema' && /missing file/.test(i.message)));
  });

  test('invalid JSON is reported, not thrown', () => {
    const root = makeRepo();
    fs.writeFileSync(path.join(root, DECLARATIONS_PATH), '{ nope');
    const { issues } = validateRepo(root);
    assert.ok(issues.some((i) => i.code === 'schema' && /invalid JSON/.test(i.message)));
  });

  test('a DUPLICATE skill key is refused, not silently last-wins', () => {
    // JSON.parse resolves duplicates last-wins without a word. A botched
    // merge that left two `alpha` blocks would quietly discard the first —
    // and if the survivor is the gentler one, the manifest now understates
    // a skill with nothing on screen to say so.
    const root = makeRepo({ skills: { alpha: 'Call `get_file`.' } });
    const strict = JSON.stringify(goodEntry({
      tools: ['get_file', 'delete_file'], writes: ['vault:content'], writeMode: 'destructive',
    }));
    const gentle = JSON.stringify(goodEntry());
    fs.writeFileSync(path.join(root, DECLARATIONS_PATH),
      `{"schemaVersion":${SCHEMA_VERSION},"skills":{"alpha":${strict},"alpha":${gentle}}}`);
    const { issues } = validateRepo(root);
    assert.ok(issues.some((i) => i.code === 'schema' && /more than once/.test(i.message)),
      renderIssues(issues));
  });

  test('a SKILL.md claiming another skill\'s name is refused', () => {
    // The page could identify itself as a different skill while the
    // contract, keyed on the directory, stayed green — page and manifest
    // describing different things.
    const root = makeRepo();
    fs.writeFileSync(path.join(root, 'skills', 'alpha', 'SKILL.md'),
      '---\nname: beta\ndescription: d\n---\n\nCall `get_file`.\n');
    const { issues } = validateRepo(root);
    assert.ok(issues.some((i) => i.code === 'inconsistent' && /declares `name: beta`/.test(i.message)),
      renderIssues(issues));
  });
});

// ---------------------------------------------------------------------------
// Parsing units
// ---------------------------------------------------------------------------

describe('parsing helpers', () => {
  test('splitFrontmatter handles LF, CRLF and a leading BOM', () => {
    assert.equal(splitFrontmatter('---\nname: a\n---\nbody').body, 'body');
    assert.equal(splitFrontmatter('---\r\nname: a\r\n---\r\nbody').body, 'body');
    assert.equal(splitFrontmatter('﻿---\nname: a\n---\nbody').body, 'body');
  });

  test('a file with no frontmatter is all body', () => {
    const { raw, body } = splitFrontmatter('# just a title');
    assert.equal(raw, '');
    assert.equal(body, '# just a title');
  });

  test('frontmatterScalar strips quotes and returns null when absent', () => {
    assert.equal(frontmatterScalar('name: "x"', 'name'), 'x');
    assert.equal(frontmatterScalar("name: 'x'", 'name'), 'x');
    assert.equal(frontmatterScalar('other: 1', 'name'), null);
  });

  test('bareToolName strips both MCP namespace spellings', () => {
    assert.equal(bareToolName('mcp__obsidian-router__get_file'), 'get_file');
    assert.equal(bareToolName('mcp__plugin_obsidian-router_router__get_file'), 'get_file');
    assert.equal(bareToolName('  Read '), 'Read');
  });

  test('mentionedTools only reports names that are real tools', () => {
    const known = new Set(['get_file', 'write_file']);
    const found = mentionedTools('use `get_file` and `frobnicate` and `write_file`', known);
    assert.deepEqual([...found].sort(), ['get_file', 'write_file']);
  });

  test('mentionedTools ignores an unbackticked bare word', () => {
    // Otherwise the word "search" in ordinary prose would be a tool mention
    // on almost every page, and the check would be pure noise.
    const found = mentionedTools('you may want to search the vault', new Set(['search']));
    assert.equal(found.size, 0);
  });
});

// ---------------------------------------------------------------------------
// The live repo — this is what makes `npm test` the gate
// ---------------------------------------------------------------------------

describe('the live repo', () => {
  let result;
  before(() => { result = validateRepo(REPO_ROOT); });

  test('every shipped skill is declared, every declaration ships, doc counters are true', () => {
    assert.deepEqual(result.issues, [], '\n' + renderIssues(result.issues));
  });

  // `npm test` is an explicit list of files, and CI runs exactly that script.
  // A test file that exists but is missing from the list is DARK: it passes
  // locally when invoked by hand and never runs in CI at all. That is the same
  // class as "the C8 gate would never have run in CI" (v0.67.1) and the C9 gate
  // scoped to one matrix leg (v0.68.0) — and it happened again in C10, whose
  // two new files were absent from the list while the changelog claimed +52
  // tests. Both reviewers reported it as their top finding.
  //
  // The guard's reach is stated honestly rather than oversold: it lives INSIDE
  // the list it audits, so deleting this file from `scripts.test` would also
  // remove the check that would have noticed. It catches the realistic mistake
  // — adding a test file and forgetting the list — not a deliberate removal of
  // the guard itself.
  test('every test file on disk actually runs in `npm test` (no dark tests)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    const script = String(pkg.scripts?.test ?? '');
    const listed = new Set(
      script.split(/\s+/).filter((t) => t.startsWith('tests/') && t.endsWith('.test.mjs')),
    );
    // RECURSIVE: a plain readdirSync would make any test in a `tests/`
    // subdirectory invisible to the very check meant to find dark tests.
    const onDisk = fs
      .readdirSync(path.join(REPO_ROOT, 'tests'), { recursive: true })
      .map((f) => String(f).split(path.sep).join('/'))
      .filter((f) => f.endsWith('.test.mjs'))
      .map((f) => `tests/${f}`)
      .sort();
    const dark = onDisk.filter((f) => !listed.has(f));
    assert.deepEqual(
      dark,
      [],
      `these test files exist but never run in CI — add them to package.json "scripts.test":\n  ${dark.join('\n  ')}`,
    );
    // And the mirror: a listed file that no longer exists would make `npm test`
    // die on a missing path, which is loud, but naming it here is cheaper.
    const ghosts = [...listed].filter((f) => !fs.existsSync(path.join(REPO_ROOT, f))).sort();
    assert.deepEqual(ghosts, [], `listed in "scripts.test" but absent from disk:\n  ${ghosts.join('\n  ')}`);
  });

  test('countArtifacts reports what is really on disk', () => {
    // The previous version of this test compared countArtifacts to itself
    // (`counts.skills === discoverSkills(...).length` — the former CALLS the
    // latter) and echoed back its own argument for `tools`. It held for the
    // repo, for an empty temp dir, and for a path that does not exist, so
    // deleting either side's logic could not have failed it. Fixtures with
    // known contents give it teeth.
    const root = makeRepo({
      skills: { a: 'x', b: 'x', c: 'x' },
      commands: ['one', 'two'],
      hooks: ['h1', 'h2', 'h3', 'h4'],
      agents: { ag: 'Read' },
    });
    // `_shared.mjs` must not count as a hook: underscore files are libraries.
    fs.writeFileSync(path.join(root, 'hooks', '_shared.mjs'), 'x');
    const counts = countArtifacts(root, { toolCount: 7 });
    assert.equal(counts.skills, 3);
    assert.equal(counts.commands, 2);
    assert.equal(counts.hooks, 4);
    assert.equal(counts.agents, 1);
    assert.equal(counts.tools, 7);
    assert.deepEqual(counts.errors, []);
  });

  test('an unreadable artifact directory is UNKNOWN, never zero', () => {
    // A count of 0 is a claim; a missing directory is an absence of one.
    // Conflating them means a doc that also said 0 would "agree" with a
    // check that had stopped working.
    const root = makeRepo();
    fs.rmSync(path.join(root, 'commands'), { recursive: true, force: true });
    const counts = countArtifacts(root, { toolCount: 1 });
    assert.equal(counts.commands, null);
    assert.equal(counts.errors.length, 1);
    const issues = checkDocCounters(root, counts);
    assert.ok(issues.some((i) => i.code === 'artifact-count-unreadable'), renderIssues(issues));
  });

  test('the exact set of counter rules is pinned', () => {
    // Iterating COUNTER_RULES and asserting each one matches is VACUOUS
    // against deletion: shrink the production list and the test shrinks with
    // it, so a whole documented counter could stop being guarded in silence.
    // The expected ids live here so removing one is a deliberate edit in two
    // places.
    assert.deepEqual(COUNTER_RULES.map((r) => r.id).sort(), [
      'architecture-tools',
      'marketplace-commands',
      'marketplace-commands-total',
      'plugin-agents',
      'plugin-commands',
      'plugin-skills',
      'quick-reference-en-commands',
      'quick-reference-en-skills',
      'quick-reference-en-tools',
      'quick-reference-fr-commands',
      'quick-reference-fr-skills',
      'quick-reference-fr-tools',
      'readme-commands',
      'readme-hooks',
      'readme-skills',
    ]);
  });

  test('every counter rule still matches its file, at full strength', () => {
    for (const rule of COUNTER_RULES) {
      const text = fs.readFileSync(path.join(REPO_ROOT, rule.file), 'utf8');
      // The PRODUCTION function, not a copy of its regex. A second copy here
      // would keep "passing" against a production regex that had changed.
      const flat = stripEmphasis(text);
      const m = [...flat.matchAll(new RegExp(rule.pattern.source, rule.pattern.flags))];
      assert.ok(m.length >= (rule.minMatches || 1),
        `counter rule ${rule.id} matches ${m.length} site(s) in ${rule.file}, below its minMatches of ${rule.minMatches}`);
    }
  });

  test('every declared tool exists in the router catalog', () => {
    const decl = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, DECLARATIONS_PATH), 'utf8'));
    for (const [name, entry] of Object.entries(decl.skills)) {
      for (const t of [...entry.tools, ...(entry.toolsMentionedNotCalled || [])]) {
        assert.ok(REAL_TOOL_NAMES.has(t), `${name} declares unknown tool ${t}`);
      }
    }
  });

  test('every entry admits it is unverified, with a written reason', () => {
    // The state of the world today, pinned. If a future entry claims
    // `verified`, this test is where someone has to come and say so — and
    // the validator will already have demanded real evidence for it.
    const decl = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, DECLARATIONS_PATH), 'utf8'));
    for (const [name, entry] of Object.entries(decl.skills)) {
      // Asserting membership in the vocabulary was not enough: a `verified`
      // entry passed a test whose name promised the opposite. Pin the real
      // state of the world — flipping any entry to `verified` must be a
      // deliberate edit HERE as well as in the manifest.
      assert.equal(entry.verification.status, 'declared',
        `${name} claims ${entry.verification.status}; no skill has a behavioral harness yet`);
      assert.ok(entry.verification.reason.trim().length > 40,
        `${name}: the reason must say something specific, not just "unverified"`);
    }
  });

  test('the vocabularies stay closed sets', () => {
    for (const v of [READ_ATOMS, WRITE_ATOMS, WRITE_MODES, VERIFICATION_STATUSES]) {
      assert.ok(Object.isFrozen(v));
      assert.equal(new Set(v).size, v.length, 'duplicate entry in a vocabulary');
    }
  });
});

// ---------------------------------------------------------------------------
// Pure-function entry points (drivable without a repo on disk)
// ---------------------------------------------------------------------------

describe('pure entry points', () => {
  test('validateDeclarations works on injected facts', () => {
    const issues = validateDeclarations({
      skills: [{ name: 'a', skillMdPath: 'skills/a/SKILL.md', text: 'call `get_file`' }],
      agents: new Map(),
      toolNames: new Set(['get_file']),
      writeToolNames: new Set(),
      declarations: { schemaVersion: SCHEMA_VERSION, skills: { a: goodEntry() } },
      repoRoot: REPO_ROOT,
    });
    assert.deepEqual(issues, []);
  });

  test('checkAgentAllowlists ignores an agent with no contract', () => {
    const issues = checkAgentAllowlists({
      agents: new Map([['x', { file: 'agents/x.md', tools: new Set(['delete_file']) }]]),
      declarations: { schemaVersion: SCHEMA_VERSION, skills: {} },
      toolNames: new Set(['delete_file']),
    });
    assert.deepEqual(issues, []);
  });

  test('checkDocCounters reports an undeterminable count instead of passing it', () => {
    const root = makeRepo();
    const issues = checkDocCounters(root, { commands: 1, skills: 1, hooks: 1, agents: 0, tools: null });
    assert.ok(issues.some((i) => i.code === 'counter-site-missing' && /could not determine/.test(i.message)));
  });

  test('renderIssues says so plainly when there is nothing to report', () => {
    assert.match(renderIssues([]), /no drift/);
  });

  test('discoverAgents reads the real agent allowlists', () => {
    const agents = discoverAgents(REPO_ROOT);
    assert.ok(agents.size >= 2);
    for (const [, a] of agents) assert.ok(a.tools.size > 0);
  });
});
