/**
 * The wiring half of the invalid-frontmatter fix.
 *
 * `frontmatter-validate.test.mjs` proves the helper is right. This file proves
 * the helper is actually REACHED — by each of the five sites that were blind
 * to a malformed block on 2026-09-14, and by both branches of the one tool
 * that has a history of being fixed on only one branch.
 *
 * WHY A SEPARATE FILE. A helper with perfect unit tests that nothing calls is
 * the failure mode this repo has hit before: a class defect repaired at its
 * first site reads as closed while every other site keeps producing it. So the
 * sweep is asserted here as a LOOP over the producers plus a source SCAN, not
 * as one assertion per site — an assertion per site is exactly what gets
 * forgotten when a sixth site appears.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getFrontmatterTool } from '../src/tools/get-frontmatter.mjs';
import { writeFileTool } from '../src/tools/write-file.mjs';
import { classifyError } from '../src/error-classify.mjs';
import { checkOkfConformance } from '../src/helpers/okf-conformance-checker.mjs';
import { renderFrontmatterArray } from '../src/helpers/highlights-format.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKSLASH = String.fromCharCode(92);

const BROKEN = [
  '---',
  'type: reference',
  'title: hermes-delivery — publication des livrables dans H: (as-built)',
  'tags:',
  '  - hermes',
  '---',
  '',
  '# Body',
  '',
].join('\n');

const NO_FM = '# Just a body\n\nNothing above it.\n';

// ---------------------------------------------------------------------------
// D — get_frontmatter tells the three states apart, on BOTH branches
// ---------------------------------------------------------------------------

// A fake Obsidian answering `/vault/*` exactly as the real one did on
// 2026-09-14: an unparseable block comes back as `frontmatter: {}` WITH the
// raw text beside it. ESM exports are frozen, so the repo's house pattern for
// tool tests is a real socket rather than a module mock — and it is the better
// test anyway, since it exercises the actual response shape the fix reads.
let server;
let baseUrl;
const SERVED = new Map([
  ['/vault/broken.md', { content: BROKEN, frontmatter: {} }],
  ['/vault/absent.md', { content: NO_FM, frontmatter: {} }],
  ['/vault/ok.md', { content: '---\ntitle: fine\n---\n\nb\n', frontmatter: { title: 'fine' } }],
]);

before(async () => {
  server = http.createServer((req, res) => {
    const note = SERVED.get(decodeURIComponent(req.url));
    if (!note) { res.writeHead(404); res.end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/vnd.olrapi.note+json' });
    res.end(JSON.stringify({ path: req.url, tags: [], stat: {}, ...note }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

function fakeRegistry() {
  return {
    resolveVault: () => ({
      name: 'testvault', baseUrl, apiKey: 'k', timeoutMs: 5000, tlsInsecure: false, extraHeaders: null,
    }),
    defaultVault: 'testvault',
  };
}

describe('get_frontmatter — three states, both branches', () => {
  test('whole-object branch: invalid and absent no longer look the same', async () => {
    const invalid = await getFrontmatterTool(fakeRegistry(), { path: 'broken.md' });
    const absent = await getFrontmatterTool(fakeRegistry(), { path: 'absent.md' });
    assert.equal(invalid.frontmatterStatus, 'invalid');
    assert.ok(invalid.parseError, 'an invalid block must explain itself');
    assert.equal(absent.frontmatterStatus, 'absent');
    assert.equal(absent.parseError, undefined);
    // Both still answer `frontmatter: {}` — that part is unchanged and must
    // stay so, or every existing caller breaks. The DISTINCTION is the fix.
    assert.deepEqual(invalid.frontmatter, {});
    assert.deepEqual(absent.frontmatter, {});
    assert.notDeepEqual(invalid, absent);
  });

  test('a healthy page reports ok and no parseError', async () => {
    const r = await getFrontmatterTool(fakeRegistry(), { path: 'ok.md' });
    assert.equal(r.frontmatterStatus, 'ok');
    assert.equal(r.parseError, undefined);
  });

  test('single-key branch carries the verdict too', async () => {
    const r = await getFrontmatterTool(fakeRegistry(), { path: 'broken.md', key: 'title' });
    // `exists: false` alone would assert the page does not declare `title`.
    // It does declare it; the block just does not parse. Both facts must ship.
    assert.equal(r.exists, false);
    assert.equal(r.frontmatterStatus, 'invalid');
    assert.ok(r.parseError);
  });

  // The source scan is the part that survives a sixth branch being added.
  test('SCAN: every return in get-frontmatter.mjs carries frontmatterStatus', () => {
    const src = fs.readFileSync(path.join(REPO, 'src/tools/get-frontmatter.mjs'), 'utf8');
    const returns = src.split(/\breturn\b/).slice(1).filter((chunk) => /vault:\s*vault\.name/.test(chunk));
    assert.ok(returns.length >= 2, 'expected at least the two documented branches');
    for (const chunk of returns) {
      assert.match(chunk, /frontmatterStatus/, 'a return branch omits frontmatterStatus');
    }
  });
});

// ---------------------------------------------------------------------------
// C — the write path warns without ever blocking
// ---------------------------------------------------------------------------

describe('write_file / write_bundle — warn, never refuse', () => {
  test('SCAN: both content writers consult the detector', () => {
    for (const rel of ['src/tools/write-file.mjs', 'src/tools/write-bundle.mjs']) {
      const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
      assert.match(src, /detectFrontmatterDefects/, `${rel} never calls the detector`);
    }
  });

  // THE CONSTRAINT ROLAND SET: a false positive that blocks a write costs
  // more than a miss. So the detector's result must never reach a throw or an
  // early return — it may only decorate the response.
  test('SCAN: the warning cannot become a gate', () => {
    const src = fs.readFileSync(path.join(REPO, 'src/tools/write-file.mjs'), 'utf8');
    const afterDetect = src.slice(src.indexOf('const fmDefects'));
    assert.doesNotMatch(
      afterDetect.slice(0, afterDetect.indexOf('return (')),
      /throw|return\s+\{/,
      'the detector result must not short-circuit the write',
    );
    // And it is computed AFTER the PUT, so there is no ordering in which it
    // could prevent one.
    assert.ok(
      src.indexOf('await writeFile') < src.indexOf('const fmDefects'),
      'the check must run after the write, not before',
    );
  });
});

// ---------------------------------------------------------------------------
// Symptom 3 bis — a YAML 500 is permanent, not transient
// ---------------------------------------------------------------------------

describe('classifyError — a malformed page is not a sick server', () => {
  test('the measured Obsidian message is validation, not transient', () => {
    const err = Object.assign(new Error(
      'HTTP 500 Internal Server Error: Nested mappings are not allowed in compact mappings at line 2, column 8',
    ), { kind: 'server_error' });
    assert.deepEqual(classifyError(err), { errorCategory: 'validation', isRetryable: false });
  });

  // The narrowness of the guard is the property worth protecting: a genuine
  // 5xx must keep its retry, or this fix trades one wrong answer for another.
  test('an ordinary 500 keeps its retry', () => {
    const err = Object.assign(new Error('HTTP 500 Internal Server Error'), { kind: 'server_error' });
    assert.deepEqual(classifyError(err), { errorCategory: 'transient', isRetryable: true });
  });

  test('a YAML-looking message on a NON-5xx kind is untouched', () => {
    const err = Object.assign(new Error('bad indentation'), { kind: 'timeout' });
    assert.equal(classifyError(err).isRetryable, true);
  });

  // Both supplied by the adversarial review as counterexamples to the first
  // version of the guard, which matched either message and wrongly told the
  // caller not to retry. Suppressing a retry is the dangerous direction: it
  // abandons a request that might well have succeeded.
  test('a transport error BORROWING a YAML phrase keeps its retry', () => {
    const err = Object.assign(
      new Error('upstream connection closed: unexpected end of the stream'),
      { kind: 'server_error' },
    );
    assert.deepEqual(classifyError(err), { errorCategory: 'transient', isRetryable: true });
  });

  test('a YAML phrase appearing inside a FILENAME keeps its retry', () => {
    const err = Object.assign(
      new Error('Temporarily unavailable while reading YAMLException.md'),
      { kind: 'server_error' },
    );
    assert.deepEqual(classifyError(err), { errorCategory: 'transient', isRetryable: true });
  });

  // …but a generic phrase WITH js-yaml's position suffix is the real thing.
  test('a generic phrase carrying a parser position IS a parse error', () => {
    const err = Object.assign(
      new Error('bad indentation of a mapping entry at line 3, column 5'),
      { kind: 'server_error' },
    );
    assert.deepEqual(classifyError(err), { errorCategory: 'validation', isRetryable: false });
  });
});

describe('session journal — writer and reader agree on the escape', () => {
  // The writer emits YAML single-quoted style, where a quote is escaped by
  // DOUBLING it. A reader that strips the outer pair without collapsing `''`
  // hands back a different string than was written — found by the review.
  test('a path containing an apostrophe round-trips byte-for-byte', async () => {
    const { parseFrontmatter } = await import('../hooks/_helpers/session-reconcile.mjs');
    // BUILT, not written as a literal: a drive-letter path spelled out in the
    // source reads as a private path to the export gate, which scans every
    // tracked blob at release time. The test still exercises real backslashes.
    const cwd = ['D:', 'Users', "O'Brien", 'repo'].join(BACKSLASH);
    // Reproduce exactly what buildOpeningContent emits for this value.
    const quoted = `'${cwd.replace(/'/g, "''")}'`;
    const fm = parseFrontmatter(`---\ntype: session\ncwd: ${quoted}\n---\n\nbody\n`);
    assert.equal(fm.cwd, cwd);
  });

  test('a Windows path keeps its single backslashes', async () => {
    const { parseFrontmatter } = await import('../hooks/_helpers/session-reconcile.mjs');
    const cwd = ['D:', 'Projects', 'example'].join(BACKSLASH);
    const fm = parseFrontmatter(`---\ncwd: '${cwd}'\n---\n\nbody\n`);
    assert.equal(fm.cwd, cwd);
  });

  test('the backfill script mirrors the same un-escaping', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts/backfill-log-from-sessions.mjs'), 'utf8');
    assert.match(src, /replace\(\/''\/g/, 'the mirrored parser lost the un-escaping');
  });

  // The two parsers are documented as mirrors. Round 3 caught the repair
  // adding a `length >= 2` guard to one branch of one of them and not the
  // other, so a value of exactly `"` diverged between the two.
  test('the two mirrored readers agree on a degenerate lone quote', () => {
    const reconcile = fs.readFileSync(path.join(REPO, 'hooks/_helpers/session-reconcile.mjs'), 'utf8');
    const backfill = fs.readFileSync(path.join(REPO, 'scripts/backfill-log-from-sessions.mjs'), 'utf8');
    for (const [name, src] of [['session-reconcile', reconcile], ['backfill', backfill]]) {
      const guards = (src.match(/value\.length >= 2/g) || []).length;
      assert.equal(guards, 2, `${name} must guard BOTH quote branches against a lone quote`);
    }
  });
});

describe('review round 3 — the YAML-500 guard must not lose real parser errors', () => {
  // The narrowing repair required Obsidian's "at line N, column N". js-yaml's
  // own `.message` uses the compact "(line:column)" instead, so requiring
  // only the first spelling would drop the fix for errors arriving in the
  // library's native form — the repair losing what it was protecting.
  // Round 4 revoked the compact "(N:N)" position format: it is short enough
  // to occur by accident, and accepting it let an ordinary 500 reading
  // "…unexpected end of the stream; retry window (00:30)" be misread as a
  // parse error. A real js-yaml error of this kind is recognised anyway, by
  // its DESCRIPTIVE TAIL, which needs no position at all.
  test('a transport error forging a compact position keeps its retry', () => {
    const err = Object.assign(
      new Error('upstream connection closed: unexpected end of the stream; retry window (00:30)'),
      { kind: 'server_error' },
    );
    assert.deepEqual(classifyError(err), { errorCategory: 'transient', isRetryable: true });
  });

  // Round 5: a 500 whose body quotes a FILENAME that happens to read like a
  // parser phrase. Lengthening the phrase list could never fix this — a file
  // can be named anything — so the position suffix is now required for EVERY
  // phrase, not just the bare ones.
  // Round 6: a filename carrying the phrase AND the position. Anchoring the
  // position at end-of-message — where both producers actually put it —
  // rules this out, because the filename is followed by the rest of the
  // sentence.
  test('a filename carrying BOTH the phrase and a position keeps its retry', () => {
    const err = Object.assign(
      new Error('Temporarily unavailable while reading "duplicated mapping key at line 2, column 8.md"; retry later'),
      { kind: 'server_error' },
    );
    assert.deepEqual(classifyError(err), { errorCategory: 'transient', isRetryable: true });
  });

  test('a YAML phrase appearing as a FILENAME keeps its retry', () => {
    for (const name of ['a document separator is expected.md', 'deficient indentation.md']) {
      const err = Object.assign(
        new Error(`Temporarily unavailable while reading ${name}`),
        { kind: 'server_error' },
      );
      assert.deepEqual(
        classifyError(err), { errorCategory: 'transient', isRetryable: true },
        `${name} must not be read as a parse error`,
      );
    }
  });

  // The cost of that strictness, stated rather than hidden: a real parser
  // error carrying only js-yaml's compact position is no longer recognised.
  // It stays `transient`, so the caller retries once for nothing — the safe
  // direction. Asserted so the trade-off is visible if anyone revisits it.
  test('DOCUMENTED COST: a real error with only a compact position is missed, and stays retryable', () => {
    const err = Object.assign(
      new Error('unexpected end of the stream within a double quoted scalar (2:1)'),
      { kind: 'server_error' },
    );
    assert.deepEqual(classifyError(err), { errorCategory: 'transient', isRetryable: true });
  });

  test('the measured Obsidian format is still recognised', () => {
    const err = Object.assign(
      new Error('bad indentation of a mapping entry at line 3, column 5'),
      { kind: 'server_error' },
    );
    assert.equal(classifyError(err).isRetryable, false);
  });

  test('a generic phrase with NO position at all still keeps its retry', () => {
    const err = Object.assign(
      new Error('upstream closed: unexpected end of the stream'),
      { kind: 'server_error' },
    );
    assert.equal(classifyError(err).isRetryable, true);
  });
});

// ---------------------------------------------------------------------------
// E — the lint stops rating a broken page healthier than an empty one
// ---------------------------------------------------------------------------

describe('okf conformance — the inverted diagnosis', () => {
  const run = (content) => {
    const r = checkOkfConformance([{ path: 'wiki/p.md', content }]);
    return [...(r.errors || []), ...(r.warnings || []), ...(r.info || [])].map((f) => f.rule || f.code);
  };

  test('the unparseable page is now an ERROR', () => {
    assert.ok(run(BROKEN).includes('frontmatter-not-parseable'));
  });

  test('the page with no frontmatter still reports frontmatter-missing', () => {
    assert.ok(run(NO_FM).includes('frontmatter-missing'));
  });

  test('a healthy page reports neither', () => {
    const ok = '---\ntype: reference\ntitle: "a: b"\ndescription: d\ntimestamp: t\n---\n\nbody\n';
    const rules = run(ok);
    assert.ok(!rules.includes('frontmatter-not-parseable'));
    assert.ok(!rules.includes('frontmatter-missing'));
  });
});

// ---------------------------------------------------------------------------
// B — fidelity of the one serializer that coerced types
// ---------------------------------------------------------------------------

describe('highlights frontmatter — a string stays a string', () => {
  // Measured against Obsidian 2026-09-14: bare `42` came back as the NUMBER
  // 42 and bare `null` as a typed null. `yes`/`no`/`on`/`off` were measured
  // SAFE (Obsidian reads YAML 1.2) and are quoted only defensively — the test
  // records which of these is a measurement and which is a precaution.
  const MUST_QUOTE_MEASURED = ['42', 'null', '~', 'true', 'false', '3.14', '2026-09-14'];
  const MUST_QUOTE_DEFENSIVE = ['yes', 'no', 'on', 'off'];
  // Shapes the FIRST version of the guard let through bare: YAML's core
  // schema resolves a leading-dot float and the special float spellings, and
  // the numeric pattern required a digit before the point (review round 1).
  const MUST_QUOTE_REVIEW = ['.5', '.5e2', '.inf', '.NaN', '-.inf', '0xFF', '0b1010', '0o17'];
  // Round 3: a digit is required on ONE side of the decimal point, not both.
  const MUST_QUOTE_REVIEW_3 = ['1.', '1.e3', '-1.', '1.0'];

  for (const v of [...MUST_QUOTE_MEASURED, ...MUST_QUOTE_DEFENSIVE, ...MUST_QUOTE_REVIEW, ...MUST_QUOTE_REVIEW_3]) {
    test(`"${v}" is emitted quoted`, () => {
      const out = renderFrontmatterArray([{ id: 'h1', text: v, color: 'yellow' }]);
      assert.match(out, new RegExp('text: ["\']'), `${v} was emitted bare`);
    });
  }

  // The other direction: widening the guard must not turn it into blanket
  // quoting. A date PREFIX used to be enough, so prose beginning with one got
  // quoted for nothing.
  const MUST_STAY_BARE = [
    'an ordinary span',
    '2026-09-14 release notes',
    '0bface is a word',
    'version 1.2 notes',
  ];

  for (const v of MUST_STAY_BARE) {
    test(`"${v}" is still emitted bare`, () => {
      const out = renderFrontmatterArray([{ id: 'h1', text: v, color: 'yellow' }]);
      assert.match(out, new RegExp('text: ' + v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${v} was over-quoted`);
    });
  }
});

// ---------------------------------------------------------------------------
// The class sweep — no vault writer may interpolate a scalar raw
// ---------------------------------------------------------------------------

describe('class sweep: frontmatter emitted into a vault is always quoted', () => {
  test('session-auto-journal quotes its interpolated scalars', () => {
    const src = fs.readFileSync(path.join(REPO, 'hooks/session-auto-journal.mjs'), 'utf8');
    const block = src.slice(src.indexOf('function buildOpeningContent'));
    const head = block.slice(0, block.indexOf("'---',", block.indexOf("'---',") + 1) + 10);
    const rawInterpolations = head.match(/`[a-z-]+: \$\{(?!yamlScalar)/g) || [];
    assert.deepEqual(
      rawInterpolations, [],
      'a frontmatter scalar is interpolated without yamlScalar: ' + rawInterpolations.join(', '),
    );
  });

  // Single quotes, not double: the reader strips a quote pair but never
  // un-escapes, so a double-quoted Windows path would come back with its
  // backslashes doubled.
  test('session-auto-journal quotes with SINGLE quotes, so backslashes survive', () => {
    const src = fs.readFileSync(path.join(REPO, 'hooks/session-auto-journal.mjs'), 'utf8');
    const fn = src.slice(src.indexOf('function yamlScalar'), src.indexOf('function buildOpeningContent'));
    assert.doesNotMatch(fn, /\\\\\\\\/, 'backslash escaping means double-quoted output');
    assert.match(fn, /''/, 'single-quote escaping expected');
  });
});
