/**
 * Tests for src/helpers/ingest-state.mjs — hash-based incremental ingest.
 * Run with `npm test`.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  computeSourceHash,
  normaliseUrl,
  checkSourceFreshness,
  recordIngest,
} from '../src/helpers/ingest-state.mjs';
// The disk half lives in its own module since v0.79.0 — see the note there.
import {
  getStatePath,
  loadIngestState,
  saveIngestState,
} from '../src/helpers/ingest-state-fs.mjs';

// ---------------------------------------------------------------------------
// computeSourceHash
// ---------------------------------------------------------------------------

describe('computeSourceHash', () => {
  test('deterministic — same input always produces same hash', () => {
    const h1 = computeSourceHash('hello world');
    const h2 = computeSourceHash('hello world');
    assert.equal(h1, h2);
  });

  test('different input produces different hash', () => {
    const h1 = computeSourceHash('hello world');
    const h2 = computeSourceHash('hello worle');
    assert.notEqual(h1, h2);
  });

  test('returns 64-char lowercase hex', () => {
    const h = computeSourceHash('test');
    assert.match(h, /^[0-9a-f]{64}$/);
  });

  test('empty string is valid input', () => {
    const h = computeSourceHash('');
    assert.match(h, /^[0-9a-f]{64}$/);
    // sha256 of empty string is well-known
    assert.equal(h, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  test('throws on non-string input', () => {
    assert.throws(() => computeSourceHash(null), /must be a string/);
    assert.throws(() => computeSourceHash(42), /must be a string/);
    assert.throws(() => computeSourceHash({}), /must be a string/);
  });

  test('utf-8 handles unicode consistently', () => {
    const h1 = computeSourceHash('café');
    const h2 = computeSourceHash('café');
    assert.equal(h1, h2);
    assert.match(h1, /^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// normaliseUrl
// ---------------------------------------------------------------------------

describe('normaliseUrl', () => {
  test('strips utm_* tracking params', () => {
    const input = 'https://example.com/article?utm_source=newsletter&utm_campaign=spring';
    assert.equal(normaliseUrl(input), 'https://example.com/article');
  });

  test('strips fbclid, gclid, msclkid', () => {
    assert.equal(
      normaliseUrl('https://example.com/x?fbclid=abc'),
      'https://example.com/x',
    );
    assert.equal(
      normaliseUrl('https://example.com/x?gclid=abc&msclkid=def'),
      'https://example.com/x',
    );
  });

  test('keeps legitimate query params', () => {
    assert.equal(
      normaliseUrl('https://example.com/search?q=oauth&page=2'),
      'https://example.com/search?page=2&q=oauth',
    );
  });

  test('sorts query params for stable hashing', () => {
    const a = normaliseUrl('https://example.com/x?b=2&a=1');
    const b = normaliseUrl('https://example.com/x?a=1&b=2');
    assert.equal(a, b);
  });

  test('lowercases host', () => {
    assert.equal(
      normaliseUrl('https://Example.COM/path'),
      'https://example.com/path',
    );
  });

  test('strips default port', () => {
    assert.equal(normaliseUrl('http://example.com:80/x'), 'http://example.com/x');
    assert.equal(normaliseUrl('https://example.com:443/x'), 'https://example.com/x');
  });

  test('keeps non-default port', () => {
    assert.equal(normaliseUrl('http://example.com:8080/x'), 'http://example.com:8080/x');
  });

  test('strips fragment', () => {
    assert.equal(
      normaliseUrl('https://example.com/x#section'),
      'https://example.com/x',
    );
  });

  test('normalises trailing slash on non-root path', () => {
    assert.equal(normaliseUrl('https://example.com/foo/'), 'https://example.com/foo');
    assert.equal(normaliseUrl('https://example.com/foo'), 'https://example.com/foo');
  });

  test('preserves trailing slash on root path', () => {
    const result = normaliseUrl('https://example.com/');
    // URL parser normalises to either / or empty path; both are OK as long as deterministic
    assert.match(result, /^https:\/\/example\.com\/?$/);
  });

  test('returns input unchanged on parse failure', () => {
    assert.equal(normaliseUrl('not a url'), 'not a url');
    assert.equal(normaliseUrl(''), '');
  });

  test('non-string input returned as-is', () => {
    assert.equal(normaliseUrl(null), null);
    assert.equal(normaliseUrl(undefined), undefined);
  });

  test('case-insensitive tracking param match', () => {
    assert.equal(
      normaliseUrl('https://example.com/x?UTM_SOURCE=newsletter'),
      'https://example.com/x',
    );
  });

  // -------------------------------------------------------------------------
  // Security : URL credentials and secret params MUST NOT persist
  // (review+ pass 2 regressions for Reviewer B IMPORTANT #2)
  // -------------------------------------------------------------------------

  test('strips basic-auth username/password from userinfo', () => {
    assert.equal(
      normaliseUrl('https://alice:hunter2@example.com/x'),
      'https://example.com/x',
    );
    assert.equal(
      normaliseUrl('https://token123@api.example.com/v1/data'),
      'https://api.example.com/v1/data',
    );
  });

  test('strips access_token / api_key / signature / secret', () => {
    const url = 'https://example.com/x?access_token=abc&api_key=def&signature=ghi&secret=jkl&keep=ok';
    assert.equal(normaliseUrl(url), 'https://example.com/x?keep=ok');
  });

  test('strips OAuth params (code / state / nonce)', () => {
    const url = 'https://example.com/cb?code=auth_code&state=csrf&nonce=xyz&q=keep';
    assert.equal(normaliseUrl(url), 'https://example.com/cb?q=keep');
  });

  test('strips session cookies in query (sessionid, jsessionid, phpsessid)', () => {
    assert.equal(
      normaliseUrl('https://example.com/x?sessionid=abc'),
      'https://example.com/x',
    );
    assert.equal(
      normaliseUrl('https://example.com/x?JSESSIONID=xyz'),
      'https://example.com/x',
    );
  });

  test('strips X-Amz-* signed-URL params (prefix match)', () => {
    const url = 'https://bucket.s3.amazonaws.com/file?X-Amz-Algorithm=AWS4&X-Amz-Signature=abc&X-Amz-Credential=def&X-Amz-Date=20260527';
    // All X-Amz-* should be stripped; nothing else is in the URL.
    assert.equal(normaliseUrl(url), 'https://bucket.s3.amazonaws.com/file');
  });

  test('strips utm_* family via prefix (not just hard-coded names)', () => {
    // utm_brand_unknown_variant is a hypothetical future utm_ param.
    const url = 'https://example.com/x?utm_source=a&utm_brand_unknown_variant=b&keep=ok';
    assert.equal(normaliseUrl(url), 'https://example.com/x?keep=ok');
  });

  test('strips Marketo, Klaviyo, Adobe analytics params', () => {
    const url = 'https://example.com/x?mkt_tok=marketo&_kx=klaviyo&s_cid=adobe&keep=ok';
    assert.equal(normaliseUrl(url), 'https://example.com/x?keep=ok');
  });

  test('case-insensitive secret strip', () => {
    assert.equal(
      normaliseUrl('https://example.com/x?ACCESS_TOKEN=abc'),
      'https://example.com/x',
    );
    assert.equal(
      normaliseUrl('https://example.com/x?API_KEY=abc'),
      'https://example.com/x',
    );
  });

  test('keeps unrelated legitimate params', () => {
    assert.equal(
      normaliseUrl('https://example.com/search?q=oauth&page=2&lang=fr'),
      'https://example.com/search?lang=fr&page=2&q=oauth',
    );
  });

  // -------------------------------------------------------------------------
  // Parse-failure credential safety (review+ pass 3 fix)
  // -------------------------------------------------------------------------

  test('returns null on protocol-relative URL with basic auth (no leak)', () => {
    // Reviewer B Pass 2 finding : `//user:pass@example.com/x?token=...`
    // doesn't parse as URL → old code returned raw → leak. New code
    // returns null so the caller MUST handle it (no silent persistence).
    assert.equal(
      normaliseUrl('//user:pass@example.com/x'),
      null,
    );
  });

  test('returns null on parse-fail string containing access_token', () => {
    assert.equal(
      normaliseUrl('garbled?access_token=secret'),
      null,
    );
  });

  test('returns null on parse-fail string with signature param', () => {
    assert.equal(
      normaliseUrl('bad_url?signature=abc&keep=ok'),
      null,
    );
  });

  // -------------------------------------------------------------------------
  // Pass 4 regressions — parse-fail leak detector must align with
  // SECRET_PARAMS (Pass 3 used a narrower hand-curated regex that let
  // refresh_token / client_secret / authorization / etc. through).
  // -------------------------------------------------------------------------

  test('parse-fail: refresh_token detected (was leaking pre-pass 4)', () => {
    assert.equal(
      normaliseUrl('//example.com/x?refresh_token=rt'),
      null,
    );
  });

  test('parse-fail: client_secret detected', () => {
    assert.equal(
      normaliseUrl('//example.com/x?client_secret=cs'),
      null,
    );
  });

  test('parse-fail: authorization detected', () => {
    assert.equal(
      normaliseUrl('//example.com/x?authorization=bearer-xyz'),
      null,
    );
  });

  test('parse-fail: id_token / apptoken / passwd / pwd / sid / phpsessid', () => {
    // All keys in SECRET_PARAMS that were NOT in the Pass 3 hand-curated regex.
    for (const key of ['id_token', 'apptoken', 'passwd', 'pwd', 'sid', 'phpsessid']) {
      assert.equal(
        normaliseUrl(`//example.com/x?${key}=value`),
        null,
        `parse-fail leak detector should catch ${key}=`,
      );
    }
  });

  test('parse-fail: case-insensitive secret detection', () => {
    assert.equal(normaliseUrl('//x?REFRESH_TOKEN=abc'), null);
    assert.equal(normaliseUrl('//x?Client_Secret=abc'), null);
  });

  test('benign non-URL string still returned unchanged', () => {
    // No secrets, no userinfo — caller can use as opaque ID.
    assert.equal(normaliseUrl('not a url'), 'not a url');
    assert.equal(normaliseUrl('plain-text-id'), 'plain-text-id');
  });
});

// ---------------------------------------------------------------------------
// State file I/O (uses tmp directory)
// ---------------------------------------------------------------------------

describe('state file I/O', () => {
  let tmpVault;

  before(() => {
    tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-state-test-'));
  });

  after(() => {
    fs.rmSync(tmpVault, { recursive: true, force: true });
  });

  test('getStatePath returns wiki-meta/ingest-state.json under vault', () => {
    const p = getStatePath(tmpVault);
    assert.equal(p, path.join(tmpVault, 'wiki-meta', 'ingest-state.json'));
  });

  test('getStatePath throws on invalid vaultPath', () => {
    assert.throws(() => getStatePath(''), /non-empty string/);
    assert.throws(() => getStatePath(null), /non-empty string/);
  });

  test('loadIngestState returns {} when file absent', () => {
    const state = loadIngestState(tmpVault);
    assert.deepEqual(state, {});
  });

  test('saveIngestState creates wiki-meta dir if missing', () => {
    const state = { 'https://example.com/a': { hash: 'a'.repeat(64), ingestedAt: '2026-01-01T00:00:00Z', page: 'a.md' } };
    saveIngestState(tmpVault, state);
    assert.ok(fs.existsSync(path.join(tmpVault, 'wiki-meta')));
    assert.ok(fs.existsSync(path.join(tmpVault, 'wiki-meta', 'ingest-state.json')));
  });

  test('roundtrip save → load is identity', () => {
    const state = {
      'https://example.com/article': {
        hash: 'a'.repeat(64),
        ingestedAt: '2026-05-27T12:34:56Z',
        page: 'wiki/Refs/article.md',
      },
      '/absolute/path/to/local.md': {
        hash: 'b'.repeat(64),
        ingestedAt: '2026-05-27T13:00:00Z',
        page: 'wiki/Misc/local.md',
      },
    };
    saveIngestState(tmpVault, state);
    const loaded = loadIngestState(tmpVault);
    assert.deepEqual(loaded, state);
  });

  test('saveIngestState writes pretty-printed JSON ending with newline', () => {
    const state = { 'k': { hash: 'c'.repeat(64), ingestedAt: '2026-05-27T00:00:00Z', page: 'p' } };
    saveIngestState(tmpVault, state);
    const raw = fs.readFileSync(getStatePath(tmpVault), 'utf8');
    assert.match(raw, /\n$/);
    assert.match(raw, /^\{\n/);
  });

  test('loadIngestState returns {} on corrupted JSON + backs up file', () => {
    // Suppress stderr noise during the assertion run.
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    try {
      fs.writeFileSync(getStatePath(tmpVault), 'not valid json{{{', 'utf8');
      const state = loadIngestState(tmpVault);
      assert.deepEqual(state, {});
      // review+ pass 2 fix for Reviewer A IMP-6 — the corrupted file
      // MUST be backed up to .corrupted-<ts>, not silently overwritten.
      const files = fs.readdirSync(path.join(tmpVault, 'wiki-meta'));
      const backups = files.filter((f) => f.includes('.corrupted-'));
      assert.ok(
        backups.length >= 1,
        `expected at least one .corrupted-* backup file, got ${JSON.stringify(files)}`,
      );
      // The original state file should be gone (renamed).
      assert.equal(fs.existsSync(getStatePath(tmpVault)), false);
      // Cleanup the backup so subsequent tests don't accumulate.
      for (const b of backups) {
        fs.rmSync(path.join(tmpVault, 'wiki-meta', b));
      }
    } finally {
      process.stderr.write = origStderr;
    }
  });

  test('loadIngestState returns {} + backs up when file content is an array', () => {
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    try {
      fs.writeFileSync(getStatePath(tmpVault), '[]', 'utf8');
      const state = loadIngestState(tmpVault);
      assert.deepEqual(state, {});
      const files = fs.readdirSync(path.join(tmpVault, 'wiki-meta'));
      const backups = files.filter((f) => f.includes('.corrupted-'));
      assert.ok(backups.length >= 1, `expected backup, got ${JSON.stringify(files)}`);
      for (const b of backups) {
        fs.rmSync(path.join(tmpVault, 'wiki-meta', b));
      }
    } finally {
      process.stderr.write = origStderr;
    }
  });

  test('saveIngestState throws on non-object state', () => {
    assert.throws(() => saveIngestState(tmpVault, null), /plain object/);
    assert.throws(() => saveIngestState(tmpVault, []), /plain object/);
    assert.throws(() => saveIngestState(tmpVault, 'string'), /plain object/);
  });

  test('atomic write — partial-state file does not exist after save', () => {
    const state = { 'k': { hash: 'd'.repeat(64), ingestedAt: '2026-05-27T00:00:00Z', page: 'p' } };
    saveIngestState(tmpVault, state);
    // After successful save, no tmp file should remain in wiki-meta/
    const wikiMeta = path.join(tmpVault, 'wiki-meta');
    const files = fs.readdirSync(wikiMeta);
    const tmpFiles = files.filter((f) => f.includes('.tmp'));
    assert.deepEqual(tmpFiles, []);
  });
});

// ---------------------------------------------------------------------------
// checkSourceFreshness
// ---------------------------------------------------------------------------

describe('checkSourceFreshness', () => {
  const validHash = 'a'.repeat(64);
  const otherHash = 'b'.repeat(64);

  test('"new" when source ID absent from state', () => {
    const result = checkSourceFreshness({
      state: {},
      sourceId: 'https://example.com/x',
      hash: validHash,
    });
    assert.equal(result, 'new');
  });

  test('"unchanged" when hash matches stored', () => {
    const result = checkSourceFreshness({
      state: { 'https://example.com/x': { hash: validHash } },
      sourceId: 'https://example.com/x',
      hash: validHash,
    });
    assert.equal(result, 'unchanged');
  });

  test('"changed" when hash differs from stored', () => {
    const result = checkSourceFreshness({
      state: { 'https://example.com/x': { hash: validHash } },
      sourceId: 'https://example.com/x',
      hash: otherHash,
    });
    assert.equal(result, 'changed');
  });

  test('throws on missing state', () => {
    assert.throws(
      () => checkSourceFreshness({ sourceId: 'x', hash: validHash }),
      /state must be an object/,
    );
  });

  test('throws on missing sourceId', () => {
    assert.throws(
      () => checkSourceFreshness({ state: {}, hash: validHash }),
      /sourceId must be a non-empty string/,
    );
  });

  test('throws on invalid hash format', () => {
    assert.throws(
      () => checkSourceFreshness({ state: {}, sourceId: 'x', hash: 'short' }),
      /64-char hex string/,
    );
    assert.throws(
      () => checkSourceFreshness({ state: {}, sourceId: 'x', hash: 'z'.repeat(64) }),
      /64-char hex string/,
    );
  });
});

// ---------------------------------------------------------------------------
// recordIngest
// ---------------------------------------------------------------------------

describe('recordIngest', () => {
  test('adds new entry to state', () => {
    const state = {};
    recordIngest({
      state,
      sourceId: 'https://example.com/x',
      hash: 'a'.repeat(64),
      page: 'wiki/Refs/x.md',
      ingestedAt: '2026-05-27T00:00:00Z',
    });
    assert.deepEqual(state, {
      'https://example.com/x': {
        hash: 'a'.repeat(64),
        ingestedAt: '2026-05-27T00:00:00Z',
        page: 'wiki/Refs/x.md',
      },
    });
  });

  test('overwrites existing entry for same source ID', () => {
    const state = {
      'https://example.com/x': {
        hash: 'a'.repeat(64),
        ingestedAt: '2026-01-01T00:00:00Z',
        page: 'wiki/old.md',
      },
    };
    recordIngest({
      state,
      sourceId: 'https://example.com/x',
      hash: 'b'.repeat(64),
      page: 'wiki/new.md',
      ingestedAt: '2026-05-27T00:00:00Z',
    });
    assert.equal(state['https://example.com/x'].hash, 'b'.repeat(64));
    assert.equal(state['https://example.com/x'].page, 'wiki/new.md');
  });

  test('defaults ingestedAt to now when omitted', () => {
    const state = {};
    const before = new Date().toISOString();
    recordIngest({
      state,
      sourceId: 'k',
      hash: 'a'.repeat(64),
      page: 'p',
    });
    const after = new Date().toISOString();
    const recorded = state.k.ingestedAt;
    assert.ok(recorded >= before && recorded <= after, `recorded=${recorded} before=${before} after=${after}`);
  });

  test('returns the state for chaining', () => {
    const state = {};
    const result = recordIngest({
      state,
      sourceId: 'k',
      hash: 'a'.repeat(64),
      page: 'p',
    });
    assert.equal(result, state);
  });

  test('throws on missing state', () => {
    assert.throws(
      () => recordIngest({ sourceId: 'k', hash: 'a'.repeat(64), page: 'p' }),
      /state must be an object/,
    );
  });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// The HTTP-only boundary (lot 2, v0.79.0)
// ---------------------------------------------------------------------------
//
// Lot 2 was estimated as including "port ingest-state to REST". Measurement said
// there was nothing to port: the state file is read and written only by the
// `wiki-ingest` skill, which runs on the machine that has the disks, and by
// these tests. No MCP tool touches it, so a diskless router never calls it.
//
// TWO EARLIER VERSIONS OF THIS TEST WERE WRONG, and the way they were wrong is
// the reason the code moved. The first grepped for the three function names in
// `import { … } from '…ingest-state.mjs'`. A review walked through it with
// `import * as ingest from '…'`, which names none of them. The second inverted
// the rule to a whitelist of allowed import forms; a third review walked through
// THAT with a template-literal specifier, a computed specifier and a `?query`
// suffix, and also showed it would reject a legitimate import carrying a comment
// between its braces. A regex over source text cannot settle a question about
// module boundaries — it can only enumerate the evasions its author imagined.
//
// So the boundary became STRUCTURAL: the disk functions live in
// `ingest-state-fs.mjs`, which nothing under `src/` imports, and the invariant
// is now a SUBSTRING no router source file may contain.
//
// WHAT THIS TEST IS FOR, stated so nobody over-trusts it. It catches the
// ACCIDENT — a future maintainer wiring the state file back into a tool because
// it was convenient. It is not proof against an author deliberately hiding an
// import: `'ingest-state-' + 'fs.mjs'` passed to a dynamic `import()` would
// evade any substring rule, and settling that would need a real parsed import
// graph. A fourth review named those evasions; they are left unclosed on
// purpose, because the threat here is forgetfulness, not malice, and a test
// that pretends to more than it does is worse than one that says its limits.
describe('ingest-state disk I/O stays out of the tool surface', () => {
  const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  // Every source extension, not just `.mjs`: a `.js`/`.cjs` file under `src/`
  // would have been invisible to the walk (fourth review).
  const SOURCE_EXT = ['.mjs', '.js', '.cjs'];
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs, out);
      else if (SOURCE_EXT.some((ext) => e.name.endsWith(ext))) out.push(abs);
    }
    return out;
  };

  // Two files may name it: the module itself, and its pure sibling, whose
  // docblock has to be able to say where the disk half went. The sibling is
  // separately proven not to IMPORT it, below — so this exemption buys a
  // readable pointer, not a hole.
  const MAY_NAME_IT = [
    `helpers${path.sep}ingest-state-fs.mjs`,
    `helpers${path.sep}ingest-state.mjs`,
  ];

  test('no router source file so much as mentions ingest-state-fs', () => {
    const offenders = walk(srcRoot)
      .map((abs) => [path.relative(srcRoot, abs), abs])
      .filter(([rel]) => !MAY_NAME_IT.includes(rel))
      .filter(([, abs]) => fs.readFileSync(abs, 'utf8').includes('ingest-state-fs'))
      .map(([rel]) => rel);
    assert.deepEqual(
      offenders, [],
      'the disk half must stay unreachable from the router — port the state to REST instead, '
      + 'and update the lot-2 note in the CHANGELOG',
    );
  });

  // WITHOUT THIS, the test above passes for a vault-sized reason: it would also
  // be green if `ingest-state-fs.mjs` had been deleted, or renamed, or emptied.
  test('the module exists and really is the disk half', () => {
    const diskModule = path.join(srcRoot, 'helpers', 'ingest-state-fs.mjs');
    assert.ok(fs.existsSync(diskModule), 'the disk module must exist for the rule above to mean anything');
    const text = fs.readFileSync(diskModule, 'utf8');
    assert.match(text, /from 'node:fs'/, 'it is the half that touches a disk');
    for (const fn of ['getStatePath', 'loadIngestState', 'saveIngestState']) {
      assert.match(text, new RegExp(`export function ${fn}\\b`), `${fn} must live here`);
    }
  });

  // The pure half stays importable BY the router — and stays pure. If `node:fs`
  // ever reappears here, every importer silently re-acquires a disk dependency.
  test('the pure half imports no filesystem module', () => {
    const pure = fs.readFileSync(path.join(srcRoot, 'helpers', 'ingest-state.mjs'), 'utf8');
    assert.ok(!/from 'node:fs'/.test(pure), 'ingest-state.mjs must not import node:fs');
    assert.ok(!/from 'node:path'/.test(pure), 'ingest-state.mjs must not import node:path');

    // ONE RULE INSTEAD OF THREE REGEXES, and the reason is instructive. The
    // pure module is exempt from the repo-wide substring rule so its docblock
    // can say where the disk half went — which makes THIS the check carrying
    // the weight. Three successive drafts each named a form and each missed
    // one: `from '…'` missed dynamic imports; adding a dynamic-import check
    // missed an indirect specifier; both missed a bare side-effect
    // `import './ingest-state-fs.mjs';`, which needs no `from` at all (fifth
    // review). Enumerating import syntaxes is the losing move.
    //
    // So: strip the comments, and require the CODE to contain no occurrence of
    // the name at all. No import form can name a module without naming it.
    const code = pure
      .replace(/\/\*[\s\S]*?\*\//g, ' ')   // block comments
      .replace(/^\s*\/\/.*$/gm, ' ');      // line comments
    assert.ok(
      !code.includes('ingest-state-fs'),
      'ingest-state.mjs may point AT the disk half in prose, never name it in code',
    );
    assert.match(pure, /export function computeSourceHash\b/, 'the pure exports stay where importers expect them');
  });
});