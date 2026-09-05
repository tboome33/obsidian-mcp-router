/**
 * End-to-end tests for the router-side ifMatch (C1) orchestration in
 * src/rest-client.mjs — writeFileIfMatch (atomic bridge tier + GET-compare
 * fallback) and assertContentMatches — plus the tool-layer input validation.
 *
 * Rather than mock undici (rest-client passes a per-vault dispatcher, so
 * setGlobalDispatcher wouldn't intercept), we stand up a tiny real HTTP server
 * that mimics the endpoints and point a fake vault at it. This exercises the
 * true request path: header/body wire format, 404→fallback feature detection,
 * 409 conflict propagation, and the fallback GET-compare-then-PUT.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { writeFileIfMatch, assertContentMatches, attemptAtomicCas } from '../src/rest-client.mjs';
import { getFile } from '../src/tools/get-file.mjs';
import { writeFileTool } from '../src/tools/write-file.mjs';
import { patchFileTool } from '../src/tools/patch-file.mjs';
import { deleteFileTool } from '../src/tools/delete-file.mjs';
import { moveFileTool } from '../src/tools/move-file.mjs';
import { mergeFrontmatterTool } from '../src/tools/merge-frontmatter.mjs';
import { appendToFileTool } from '../src/tools/append-to-file.mjs';
import { setFrontmatterTool } from '../src/tools/set-frontmatter.mjs';
import { contentSha256 } from '../src/helpers/content-hash.mjs';
import { preconditionState, IF_MATCH_EXEMPT } from '../src/helpers/vault-sharing.mjs';
import { _internals } from '../src/index.mjs';

// --- Controllable fake server (Local REST API core + bridge routes) ---------

/** Per-test programmable behaviour. Reset in beforeEach. */
let behaviour;
/** Records of what the server received, for assertions. */
let recorded;
let server;
let baseUrl;

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

before(async () => {
  server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    // rawUrl = the wire form BEFORE decoding — lets tests assert the router's
    // percent-encoding contract instead of the mock masking it (codex #8).
    const url = decodeURIComponent(req.url);
    recorded.requests.push({ method: req.method, url, rawUrl: req.url, body, headers: req.headers });

    // Atomic CAS route. A 2xx here IS a landed write — recorded, so that
    // `mutated()` sees it. The first version of the enforcement loop only
    // looked at the core verbs, which was blind for exactly the atomic tier
    // (harmless while every case left the route 404, and the shape round 3
    // had already paid for once with POST). (Fable 5.1 round.)
    if (req.method === 'PUT' && url.startsWith('/vault-cas/')) {
      const r = behaviour.vaultCas;
      if (r.status >= 200 && r.status < 300) recorded.cas = { url, body };
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.body ?? {}));
      return;
    }
    // Core GET.
    if (req.method === 'GET' && url.startsWith('/vault/')) {
      const r = behaviour.get;
      res.writeHead(r.status, { 'Content-Type': 'text/markdown' });
      res.end(r.body ?? '');
      return;
    }
    // Core PUT (fallback write target) + PATCH + DELETE.
    if (req.method === 'PUT' && url.startsWith('/vault/')) {
      recorded.corePut = { url, body };
      res.writeHead(200, { 'Content-Type': 'text/markdown' });
      res.end('');
      return;
    }
    if (req.method === 'PATCH' && url.startsWith('/vault/')) {
      recorded.corePatch = { url, body };
      res.writeHead(200, { 'Content-Type': 'text/markdown' });
      res.end('');
      return;
    }
    // Core POST — how `append_to_file` writes. Missing until the Phase 4
    // enforcement loop was added, which is why nothing had ever driven an
    // append through this harness: it answered 500 "unexpected".
    if (req.method === 'POST' && url.startsWith('/vault/')) {
      recorded.corePost = { url, body };
      res.writeHead(200, { 'Content-Type': 'text/markdown' });
      res.end('');
      return;
    }
    if (req.method === 'DELETE' && url.startsWith('/vault/')) {
      recorded.coreDelete = { url };
      res.writeHead(200);
      res.end('');
      return;
    }
    res.writeHead(500);
    res.end('unexpected');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(() => server.close());

beforeEach(() => {
  behaviour = {
    vaultCas: { status: 404 }, // default: bridge route absent
    get: { status: 404 },
  };
  recorded = { requests: [], corePut: null, corePatch: null, corePost: null, coreDelete: null, cas: null };
});

function vault() {
  return {
    name: 'testvault',
    baseUrl,
    apiKey: 'k',
    timeoutMs: 5000,
    tlsInsecure: false,
    extraHeaders: null,
  };
}

// A registry that resolves to the fake vault — drives the real tools end-to-end
// through the fake server (as opposed to explodingRegistry, used only to prove
// validation short-circuits before the vault is resolved).
function realRegistry() {
  return { resolveVault: () => vault(), defaultVault: 'testvault' };
}

// --- writeFileIfMatch: atomic tier -----------------------------------------

describe('writeFileIfMatch — atomic bridge tier', () => {
  test('bridge route present + match → 200 → casMode atomic; no core PUT', async () => {
    behaviour.vaultCas = { status: 200, body: { ok: true, path: 'a.md', contentSha256: 'x' } };
    const out = await writeFileIfMatch(vault(), 'a.md', 'new', contentSha256('old'));
    assert.equal(out.casMode, 'atomic');
    assert.equal(recorded.corePut, null); // atomic route did the write, not core PUT
    const casReq = recorded.requests.find((r) => r.url.startsWith('/vault-cas/'));
    assert.equal(casReq.headers['if-match-content-sha256'], contentSha256('old'));
    assert.equal(casReq.body, 'new');
  });

  test('bridge route present + conflict (409 content-changed) → throws, NEVER probes the fallback tier', async () => {
    behaviour.vaultCas = { status: 409, body: { kind: 'cas_conflict', reason: 'content-changed' } };
    await assert.rejects(
      () => writeFileIfMatch(vault(), 'a.md', 'new', contentSha256('old')),
      /precondition failed|changed since/i,
    );
    // Codex #4: a real conflict must not be retried through the weaker tier —
    // assert the COMPLETE traffic: one CAS PUT, zero core GET, zero core PUT.
    assert.equal(recorded.corePut, null);
    assert.equal(recorded.requests.filter((r) => r.method === 'GET').length, 0);
    assert.equal(recorded.requests.length, 1);
  });

  test('bridge 409 target-missing → throws with "no longer exists" phrasing, no fallback traffic', async () => {
    behaviour.vaultCas = { status: 409, body: { kind: 'cas_conflict', reason: 'target-missing' } };
    await assert.rejects(
      () => writeFileIfMatch(vault(), 'a.md', 'new', contentSha256('old')),
      /no longer exists/i,
    );
    assert.equal(recorded.corePut, null);
    assert.equal(recorded.requests.filter((r) => r.method === 'GET').length, 0);
  });
});

// --- writeFileIfMatch: fallback tier ---------------------------------------

describe('writeFileIfMatch — GET-compare fallback (bridge route 404)', () => {
  test('404 → GET matches → core PUT applied → casMode fallback', async () => {
    behaviour.vaultCas = { status: 404 };
    behaviour.get = { status: 200, body: 'current' };
    const out = await writeFileIfMatch(vault(), 'a.md', 'new', contentSha256('current'));
    assert.equal(out.casMode, 'fallback');
    assert.ok(recorded.corePut, 'core PUT should have been called');
    assert.equal(recorded.corePut.body, 'new');
  });

  test('404 → GET content differs → 409 conflict, NO core PUT', async () => {
    behaviour.vaultCas = { status: 404 };
    behaviour.get = { status: 200, body: 'DIFFERENT now' };
    await assert.rejects(
      () => writeFileIfMatch(vault(), 'a.md', 'new', contentSha256('current')),
      /changed since|precondition failed/i,
    );
    assert.equal(recorded.corePut, null);
  });

  test('404 → GET 404 (file gone) → target-missing conflict, NO core PUT', async () => {
    behaviour.vaultCas = { status: 404 };
    behaviour.get = { status: 404 };
    await assert.rejects(
      () => writeFileIfMatch(vault(), 'a.md', 'new', contentSha256('current')),
      /no longer exists/i,
    );
    assert.equal(recorded.corePut, null);
  });
});

// --- assertContentMatches ---------------------------------------------------

describe('assertContentMatches (guard for patch/delete/move/merge)', () => {
  test('match → resolves', async () => {
    behaviour.get = { status: 200, body: 'stable' };
    await assert.doesNotReject(() => assertContentMatches(vault(), 'a.md', contentSha256('stable')));
  });

  test('mismatch → 409 conflict', async () => {
    behaviour.get = { status: 200, body: 'stable' };
    await assert.rejects(
      () => assertContentMatches(vault(), 'a.md', contentSha256('was-different')),
      /changed since|precondition failed/i,
    );
  });

  test('missing file → target-missing conflict', async () => {
    behaviour.get = { status: 404 };
    await assert.rejects(
      () => assertContentMatches(vault(), 'a.md', contentSha256('stable')),
      /no longer exists/i,
    );
  });
});

// --- writeFileIfMatch: broadened fallback + edge content -------------------

describe('writeFileIfMatch — fallback breadth & edge content', () => {
  test('bridge 400 (route present, cannot service shape) → falls back, not a hard error', async () => {
    // e.g. an empty body the parser turned into {}, or a proxy 415. The
    // always-present core PUT can service it, so degrade rather than fail.
    behaviour.vaultCas = { status: 400, body: { kind: 'cas_bad_request', reason: 'body-not-text' } };
    behaviour.get = { status: 200, body: 'current' };
    const out = await writeFileIfMatch(vault(), 'a.md', 'new', contentSha256('current'));
    assert.equal(out.casMode, 'fallback');
    assert.ok(recorded.corePut, 'core PUT should have serviced the write after fallback');
  });

  test('empty-content write via fallback → core PUT with empty body', async () => {
    behaviour.vaultCas = { status: 404 };
    behaviour.get = { status: 200, body: '' }; // file currently empty
    const out = await writeFileIfMatch(vault(), 'a.md', '', contentSha256(''));
    assert.equal(out.casMode, 'fallback');
    assert.equal(recorded.corePut.body, '');
  });

  test('non-ASCII / spaced path round-trips to the CAS route intact', async () => {
    behaviour.vaultCas = { status: 200, body: { ok: true } };
    const p = 'wiki/café notes/Motörhead.md';
    await writeFileIfMatch(vault(), p, 'x', contentSha256('y'));
    const casReq = recorded.requests.find((r) => r.url.startsWith('/vault-cas/'));
    // server decodes req.url — the decoded path must equal the original.
    assert.equal(casReq.url, `/vault-cas/${p}`);
    // Codex #8: assert the WIRE form too — the mock's decode was masking the
    // encoding contract (per-segment encodeURIComponent, slashes intact).
    assert.equal(casReq.rawUrl, '/vault-cas/wiki/caf%C3%A9%20notes/Mot%C3%B6rhead.md');
  });

  test('fallback STATUS MATRIX: 400/404/413/415 degrade — 401/403/500 hard-fail (codex #6)', async () => {
    // Degrading group: the fallback GET fires and the core PUT services the write.
    for (const status of [400, 404, 413, 415]) {
      recorded = { requests: [], corePut: null, corePatch: null, corePost: null, coreDelete: null, cas: null };
      behaviour.vaultCas = { status, body: {} };
      behaviour.get = { status: 200, body: 'current' };
      const out = await writeFileIfMatch(vault(), 'a.md', 'new', contentSha256('current'));
      assert.equal(out.casMode, 'fallback', `status ${status} must degrade`);
      assert.ok(recorded.corePut, `status ${status}: core PUT must service the write`);
    }
    // Hard-error group: no fallback GET, no core PUT — the error surfaces.
    for (const status of [401, 403, 500]) {
      recorded = { requests: [], corePut: null, corePatch: null, corePost: null, coreDelete: null, cas: null };
      behaviour.vaultCas = { status, body: {} };
      behaviour.get = { status: 200, body: 'current' };
      await assert.rejects(
        () => writeFileIfMatch(vault(), 'a.md', 'new', contentSha256('current')),
        undefined,
        `status ${status} must hard-fail`,
      );
      assert.equal(recorded.corePut, null, `status ${status}: no core PUT`);
      assert.equal(
        recorded.requests.filter((r) => r.method === 'GET').length,
        0,
        `status ${status}: no fallback GET`,
      );
    }
  });
});

// --- attemptAtomicCas: the F3-b reserved-path building block ----------------

describe('attemptAtomicCas — tight feature detection (codex H2)', () => {
  test('CAS applies → { ok: true }', async () => {
    behaviour.vaultCas = { status: 200, body: { ok: true } };
    const out = await attemptAtomicCas(vault(), 'a.md', 'new', contentSha256('cur'));
    assert.equal(out.ok, true);
    assert.equal(recorded.corePut, null, 'no core PUT — the CAS route serviced it');
  });

  test('409 content-changed → THROWS conflict, NEVER routeUnusable', async () => {
    behaviour.vaultCas = { status: 409, body: { kind: 'cas_conflict', reason: 'content-changed' } };
    await assert.rejects(
      () => attemptAtomicCas(vault(), 'a.md', 'new', contentSha256('cur')),
      (err) => err.kind === 'conflict' && /changed/.test(err.message),
    );
    assert.equal(recorded.corePut, null);
  });

  test('404 (absent bridge) → { routeUnusable: true, status: 404 }', async () => {
    behaviour.vaultCas = { status: 404 };
    const out = await attemptAtomicCas(vault(), 'a.md', 'new', contentSha256('cur'));
    assert.deepEqual(out, { routeUnusable: true, status: 404 });
  });

  test('400 body-not-text → routeUnusable (a shape the route cannot service)', async () => {
    behaviour.vaultCas = { status: 400, body: { kind: 'cas_bad_request', reason: 'body-not-text' } };
    const out = await attemptAtomicCas(vault(), 'a.md', 'new', contentSha256('cur'));
    assert.equal(out.routeUnusable, true);
  });

  test('400 BAD-PRECONDITION → THROWS, never degrades (a masked bug is worse)', async () => {
    // The tightening (codex H2): a malformed-precondition 400 is a real bug — we
    // compute the sha ourselves — so it must surface, not silently fall through
    // to a weaker path where the same bug would pass.
    behaviour.vaultCas = { status: 400, body: { kind: 'cas_bad_request', reason: 'bad-precondition' } };
    await assert.rejects(
      () => attemptAtomicCas(vault(), 'a.md', 'new', contentSha256('cur')),
      (err) => err.status === 400,
    );
  });

  test('413 / 415 → routeUnusable (route present, cannot service this shape)', async () => {
    for (const status of [413, 415]) {
      behaviour.vaultCas = { status, body: {} };
      const out = await attemptAtomicCas(vault(), 'a.md', 'new', contentSha256('cur'));
      assert.equal(out.routeUnusable, true, `status ${status}`);
      assert.equal(out.status, status);
    }
  });

  test('401 / 403 / 500 → hard-fail (throws), no degrade', async () => {
    for (const status of [401, 403, 500]) {
      behaviour.vaultCas = { status, body: {} };
      await assert.rejects(() => attemptAtomicCas(vault(), 'a.md', 'new', contentSha256('cur')));
    }
  });
});

describe('the hash precondition — BOM / EOL cross-contract (codex H5)', () => {
  // These pin what the precondition hash treats as identical vs different, so
  // the reduced GET-compare and the bridge CAS agree on both sides. The known
  // vector (tests/content-hash.test.mjs) pins the exact digest the bridge mirror
  // must also produce.
  const h = contentSha256;

  test('CRLF vs LF are DIFFERENT (no line-ending normalization)', () => {
    assert.notEqual(h('a\r\nb'), h('a\nb'));
  });

  test('a trailing newline is significant', () => {
    assert.notEqual(h('x'), h('x\n'));
  });

  test('the empty file has a stable hash', () => {
    assert.equal(h(''), h(''));
    assert.notEqual(h(''), h('\n'));
  });

  test('unicode outside the BMP round-trips (emoji, surrogate pairs)', () => {
    assert.equal(h('a\u{1F4A9}b'), h('a\u{1F4A9}b'));
    assert.notEqual(h('a\u{1F4A9}b'), h('ab'));
  });

  test('a mid-content BOM (U+FEFF) IS significant — only a LEADING one is stripped', () => {
    assert.notEqual(h('a﻿b'), h('ab'));
  });

  test('DOCUMENTED BLIND SPOT: a LEADING-BOM-only difference is INVISIBLE to the hash', () => {
    // The leading BOM is stripped before hashing (so the two read paths — core
    // GET which drops it, bridge adapter.read which keeps it — agree). The cost:
    // two files that differ ONLY by a leading BOM hash identically, so a
    // BOM-only change is not detected by the precondition. This is a deliberate,
    // known limitation — asserted here so no future doc can claim otherwise.
    assert.equal(h('﻿hello'), h('hello'));
  });
});

// --- get_file: the contentSha256 contract (codex #3) ------------------------

describe('get_file — contentSha256 is the RAW hash, content is sanitized', () => {
  test('sanitizable content: displayed content differs, hash equals the raw bytes', async () => {
    // The contract is unchanged and still the point: the hash must match what
    // is ON DISK (what the bridge's adapter.read will hash), while what the
    // model READS is neutralized. What moved in v0.71.0 is WHERE the second
    // half happens — the tool now returns raw and `wrapResult` normalizes once
    // at the wire boundary, so this test follows the invariant to its new home
    // instead of asserting the old address.
    //
    // Checking both halves in one place is deliberate: the danger in this pair
    // has always been someone "fixing" the hash to match the displayed text,
    // which would make every replayed `ifMatch` a guaranteed mismatch.
    const { _internals } = await import('../src/index.mjs');
    const raw = 'avant <system-reminder> après';
    behaviour.get = { status: 200, body: raw };

    const out = await getFile(realRegistry(), { path: 'a.md' });
    assert.equal(out.content, raw, 'the TOOL now returns raw — normalization is the boundary\'s job');
    assert.equal(out.contentSha256, contentSha256(raw), 'hash must be of the RAW content');

    const wire = await _internals.wrapResult(Promise.resolve(out));
    const shown = wire.content[0].text;
    assert.ok(!shown.includes('<system-reminder'), 'the model must not receive the live marker');
    assert.match(shown, /&lt;system-reminder/);
    // The hash travels intact through the boundary — it is hex, nothing to neutralize.
    assert.match(shown, new RegExp(contentSha256(raw)));
  });

  test('plain content: hash present and equals the served bytes', async () => {
    behaviour.get = { status: 200, body: 'contenu ordinaire é🙂' };
    const out = await getFile(realRegistry(), { path: 'a.md' });
    assert.equal(out.content, 'contenu ordinaire é🙂');
    assert.equal(out.contentSha256, contentSha256('contenu ordinaire é🙂'));
  });
});

// --- write_file tool: end-to-end atomic path (codex #5 + #9) ----------------

describe('write_file tool — atomic ifMatch end-to-end', () => {
  test('forwards ifMatch on the wire, reports if-match:atomic, returns the NEW-content hash', async () => {
    behaviour.vaultCas = { status: 200, body: { ok: true } };
    const oldHash = contentSha256('ancien contenu');
    const newContent = 'nouveau contenu é🙂';
    const out = await writeFileTool(realRegistry(), {
      path: 'note.md',
      content: newContent,
      ifMatch: oldHash,
    });
    // Result contract.
    assert.equal(out.mode, 'if-match:atomic');
    assert.equal(out.contentSha256, contentSha256(newContent), 'chaining token = hash of the NEW content');
    assert.notEqual(out.contentSha256, oldHash);
    // Wire contract (codex #9): CAS PUT with the exact header, text/plain, and
    // byte-identical non-ASCII body; and NO unconditional core PUT.
    const casReq = recorded.requests.find((r) => r.rawUrl.startsWith('/vault-cas/'));
    assert.ok(casReq, 'the CAS route must be used');
    assert.equal(casReq.headers['if-match-content-sha256'], oldHash);
    assert.match(casReq.headers['content-type'], /^text\/plain/);
    assert.equal(casReq.body, newContent);
    assert.equal(recorded.corePut, null, 'no unconditional core PUT');
  });

  test('without ifMatch: the plain core PUT path is used, mode unchanged', async () => {
    const out = await writeFileTool(realRegistry(), { path: 'note.md', content: 'x' });
    assert.equal(out.mode, 'create-or-replace');
    assert.ok(recorded.corePut, 'plain write goes through core PUT');
    assert.equal(recorded.requests.filter((r) => r.rawUrl.startsWith('/vault-cas/')).length, 0);
  });
});

// --- Guard → operation SEQUENCE (mismatch must SUPPRESS the underlying op) --

/**
 * EVERY TOOL THE SHARED-VAULT GATE CALLS "SATISFIABLE" REALLY ENFORCES THE
 * PRECONDITION — proved by a LOOP over the producers, not by an assertion per
 * site.
 *
 * Phase 4 (`helpers/vault-sharing.mjs`) refuses a write to a vault several
 * workspaces share unless the call carries `ifMatch`. That gate's whole promise
 * is "pass it and you are protected". A tool that ACCEPTED `ifMatch` and
 * ignored it would satisfy the gate while offering nothing — the gate would
 * then be worse than absent, because callers would rely on it. That exact
 * regression has happened here before: `set_frontmatter` accepted the argument
 * and ignored it until the C2 review, and its source still carries the note.
 *
 * The per-tool suite below covered four of the seven (patch, delete, move,
 * merge) — `append_to_file` and `set_frontmatter` were enforced in the source
 * and pinned by nothing. A denominator that is not asserted is a list that
 * goes stale, so the set is DERIVED from the gate itself and checked total.
 */
describe('the shared-vault gate\'s promise: satisfying it really does protect', () => {
  const STALE = contentSha256('STALE');
  const CASES = {
    write_file: { path: 'a.md', content: 'x' },
    append_to_file: { path: 'a.md', content: 'x' },
    patch_file: { path: 'a.md', operation: 'replace', targetType: 'block', target: 'b', content: 'c' },
    set_frontmatter: { path: 'a.md', key: 'k', value: 'v' },
    merge_frontmatter: { path: 'a.md', values: { k: 'v' } },
    move_file: { from: 'a.md', to: 'b.md' },
    delete_file: { path: 'a.md', confirm: true },
  };
  const RUN = {
    write_file: writeFileTool,
    append_to_file: appendToFileTool,
    patch_file: patchFileTool,
    set_frontmatter: setFrontmatterTool,
    merge_frontmatter: mergeFrontmatterTool,
    move_file: moveFileTool,
    delete_file: deleteFileTool,
  };
  // EVERY mutating method, POST included. The round-3 lesson of the also-tier
  // gate was exactly this: a "no write landed" assertion that ignores one verb
  // is blind, not green — there, it was the audit line's POST.
  const mutated = () => Boolean(recorded.corePut || recorded.corePatch || recorded.corePost || recorded.coreDelete || recorded.cas);
  // `move_file` refuses an existing destination unless told otherwise, and this
  // fake answers 200 for every GET — so the destination always "exists". The
  // precondition under test guards the SOURCE either way.
  const MATCH_EXTRA = { move_file: { overwrite: true } };

  test('the loop covers EVERY per-file write tool the gate expects a precondition from', () => {
    // Derived from the gate, so a tool that gains `ifMatch` later cannot be
    // enforced-in-theory and unproven here. `write_bundle` is excluded because
    // it is a composite that runs these very handlers (its own suite covers
    // it), and `execute_template` because the gate refuses it outright — it
    // declares no precondition at all.
    // Excluded by name, each with its reason: `write_bundle` is a composite
    // that runs these very handlers (its own suite covers it);
    // `execute_template` and `download_page_assets` are satisfiable by a
    // precondition that is not `ifMatch` (`createFile`, create-only at the
    // bridge; `createOnly`, the `wx` flag) and are proved in their own suites.
    const NOT_IF_MATCH = new Set(['write_bundle', 'execute_template', 'download_page_assets']);
    const expected = [..._internals.WRITE_TOOL_NAMES].filter((n) => !IF_MATCH_EXEMPT.has(n) && !NOT_IF_MATCH.has(n));
    assert.deepEqual(
      expected.filter((n) => !(n in CASES)), [],
      'a write tool the gate calls satisfiable is not exercised by this loop',
    );
    for (const name of expected) {
      // The tool's own required arguments come with it: `delete_file` is not a
      // write at all without `confirm: true`, and the gate stands aside for a
      // call that cannot write.
      assert.equal(
        preconditionState(name, { ...CASES[name], ifMatch: STALE }), 'carried',
        `${name} is not satisfiable by ifMatch`,
      );
    }
  });

  for (const name of Object.keys(CASES)) {
    test(`${name}: a STALE ifMatch rejects and nothing reaches the vault`, async () => {
      behaviour.get = { status: 200, body: 'current' };
      await assert.rejects(
        () => RUN[name](realRegistry(), { ...CASES[name], ifMatch: STALE }),
        /changed since|precondition failed|no longer exists/i,
        `${name} accepted a stale precondition`,
      );
      assert.equal(mutated(), false, `${name} mutated the vault despite a stale precondition`);
    });

    test(`${name}: a MATCHING ifMatch lets the write through`, async () => {
      // Without this half the test above would pass for a tool that always
      // throws — "refuses everything" is not "enforces the precondition".
      behaviour.get = { status: 200, body: 'current' };
      await RUN[name](realRegistry(), { ...CASES[name], ...(MATCH_EXTRA[name] || {}), ifMatch: contentSha256('current') });
      assert.equal(mutated(), true, `${name} did not write even though the precondition held`);
    });
  }
});

/**
 * `ifNew` / `applyIfContentPreexists: false` IS ENFORCED BY THE ROUTER — the
 * header never did it.
 *
 * Verified against the installed Local REST API 4.0.2 (the whole fleet): its
 * bundle contains zero occurrences of `Apply-If-Content-Preexists`; the only
 * related header it reads is `Reject-If-Content-Preexists`, in PATCH. So every
 * "must not exist yet" PUT — write_file's ifNew, the bundle's journal creation
 * and restore-if-absent, the source ledger's first write, the reserved-path
 * writer — was a plain overwrite, and the Phase 4 gate credited `ifNew: true`
 * with a compare-and-swap against absence that did not exist. (Fable 5.1
 * round, verifying the gate's assumptions about existing code.)
 */
describe('create-only writes are enforced in the router, not by a header the server ignores', () => {
  test('write_file ifNew on an EXISTING file: refused 409 by the router, no PUT reaches the vault', async () => {
    behaviour.get = { status: 200, body: 'already here' };
    await assert.rejects(
      () => writeFileTool(realRegistry(), { path: 'a.md', content: 'x', ifNew: true }),
      /already exists/,
    );
    assert.equal(recorded.corePut, null, 'nothing was written');
    assert.equal(recorded.requests.filter((r) => r.method === 'PUT').length, 0);
  });

  test('write_file ifNew on an ABSENT file: one probe GET, then the PUT lands', async () => {
    behaviour.get = { status: 404 };
    const r = await writeFileTool(realRegistry(), { path: 'a.md', content: 'x', ifNew: true });
    assert.equal(r.mode, 'create-only');
    assert.ok(recorded.corePut, 'the create landed');
    assert.deepEqual(recorded.requests.map((q) => q.method), ['GET', 'PUT']);
    // The header still travels, harmlessly, for a server that may honour it one day.
    assert.equal(recorded.corePut && recorded.requests[1].headers['apply-if-content-preexists'], 'false');
  });

  test('every internal caller of applyIfContentPreexists:false gets the same guard — it lives in writeFile itself', async () => {
    // The bundle's journal creation, its restore-if-absent, the source ledger's
    // first write and the reserved-path writer all call rest-client's
    // `writeFile(..., { applyIfContentPreexists: false })`. One fix, four
    // callers — proved at the sink they share, not per site.
    const { writeFile } = await import('../src/rest-client.mjs');
    behaviour.get = { status: 200, body: 'taken' };
    await assert.rejects(() => writeFile(vault(), 'x.json', '{}', { applyIfContentPreexists: false }), /already exists/);
    assert.equal(recorded.corePut, null);
    behaviour.get = { status: 404 };
    await writeFile(vault(), 'x.json', '{}', { applyIfContentPreexists: false });
    assert.ok(recorded.corePut);
  });

  test('a probe that fails for a reason other than 404 surfaces unchanged — never treated as "absent"', async () => {
    const { writeFile } = await import('../src/rest-client.mjs');
    behaviour.get = { status: 500, body: 'boom' };
    await assert.rejects(() => writeFile(vault(), 'x.md', 'x', { applyIfContentPreexists: false }), (err) => err.kind !== 'not_found');
    assert.equal(recorded.corePut, null, 'an unknown state must not become a write');
  });

  test('patch_file sends the header the plugin actually reads, with the inverted spelling', async () => {
    // 4.0.2's PATCH handler: `req.get("Reject-If-Content-Preexists") == "true"`.
    // `applyIfContentPreexists: false` = "reject if preexists: true".
    behaviour.get = { status: 200, body: 'current' };
    await patchFileTool(realRegistry(), {
      path: 'a.md', operation: 'append', targetType: 'block', target: 'b1', content: 'c', applyIfContentPreexists: false,
    });
    assert.ok(recorded.corePatch);
    const h = recorded.requests.find((q) => q.method === 'PATCH').headers;
    assert.equal(h['reject-if-content-preexists'], 'true');
    assert.equal(h['apply-if-content-preexists'], undefined, 'the dead header is gone from PATCH');
  });
});

describe('the atomic CAS tier is proved too, not only the fallback (Fable 5.1 round)', () => {
  test('bridge route present + matching hash: the write lands through /vault-cas/ and mutated() sees it', async () => {
    behaviour.vaultCas = { status: 200, body: { ok: true } };
    const r = await writeFileTool(realRegistry(), { path: 'a.md', content: 'x', ifMatch: contentSha256('current') });
    assert.equal(r.mode, 'if-match:atomic');
    assert.ok(recorded.cas, 'the CAS write is recorded as a mutation');
    assert.equal(recorded.corePut, null, 'no fallback PUT');
  });

  test('bridge route present + server says 409: refused, and NOTHING landed anywhere', async () => {
    behaviour.vaultCas = { status: 409, body: { error: 'conflict', reason: 'content-changed' } };
    await assert.rejects(
      () => writeFileTool(realRegistry(), { path: 'a.md', content: 'x', ifMatch: contentSha256('stale') }),
      /changed since|precondition failed/i,
    );
    assert.equal(recorded.cas, null);
    assert.equal(recorded.corePut, null);
  });
});

describe('ifMatch guard suppresses the operation on mismatch (patch/delete/move/merge)', () => {
  test('delete_file: mismatch → rejects AND no core DELETE fires', async () => {
    behaviour.get = { status: 200, body: 'current' };
    await assert.rejects(
      () => deleteFileTool(realRegistry(), { path: 'a.md', confirm: true, ifMatch: contentSha256('STALE') }),
      /changed since|precondition failed/i,
    );
    assert.equal(recorded.coreDelete, null);
  });

  test('delete_file: match → the DELETE fires', async () => {
    behaviour.get = { status: 200, body: 'current' };
    await deleteFileTool(realRegistry(), { path: 'a.md', confirm: true, ifMatch: contentSha256('current') });
    assert.ok(recorded.coreDelete, 'DELETE should fire when the hash matches');
  });

  test('patch_file: mismatch → rejects AND no write fires (neither PATCH nor PUT)', async () => {
    behaviour.get = { status: 200, body: '# H\ncurrent' };
    await assert.rejects(
      () =>
        patchFileTool(realRegistry(), {
          path: 'a.md',
          operation: 'append',
          targetType: 'heading',
          target: 'H',
          content: 'c',
          ifMatch: contentSha256('STALE'),
        }),
      /changed since|precondition failed/i,
    );
    assert.equal(recorded.corePatch, null);
    assert.equal(recorded.corePut, null);
  });

  test('patch_file heading: match → the router-side GET+PUT patch fires (headings never PATCH)', async () => {
    behaviour.get = { status: 200, body: '# H\ncurrent' };
    await patchFileTool(realRegistry(), {
      path: 'a.md',
      operation: 'append',
      targetType: 'heading',
      target: 'H',
      content: 'c',
      ifMatch: contentSha256('# H\ncurrent'),
    });
    // Heading patches are applied router-side since the CRLF corruption fix:
    // guard GET → patch GET → core PUT. The plugin PATCH must not be touched.
    assert.equal(recorded.corePatch, null, 'heading patch must not hit the plugin PATCH');
    assert.ok(recorded.corePut, 'the locally patched content is written back via PUT');
    assert.deepEqual(recorded.requests.map((r) => r.method), ['GET', 'GET', 'PUT']);
  });

  test('patch_file block: match → the plugin PATCH fires (forward path unchanged)', async () => {
    behaviour.get = { status: 200, body: 'current' };
    await patchFileTool(realRegistry(), {
      path: 'a.md',
      operation: 'replace',
      targetType: 'block',
      target: 'blockid',
      content: 'c',
      ifMatch: contentSha256('current'),
    });
    assert.ok(recorded.corePatch, 'PATCH should fire when the hash matches');
  });

  test('merge_frontmatter: mismatch → rejects AND no frontmatter PATCH fires', async () => {
    behaviour.get = { status: 200, body: 'current' };
    await assert.rejects(
      () => mergeFrontmatterTool(realRegistry(), { path: 'a.md', values: { status: 'done' }, ifMatch: contentSha256('STALE') }),
      /changed since|precondition failed/i,
    );
    assert.equal(recorded.corePatch, null);
  });

  test('merge_frontmatter: match + two keys → ONE guard GET before TWO PATCHes, all applied (codex #7)', async () => {
    behaviour.get = { status: 200, body: 'current' };
    const out = await mergeFrontmatterTool(realRegistry(), {
      path: 'a.md',
      values: { status: 'done', outcome: 'ok' },
      ifMatch: contentSha256('current'),
    });
    assert.equal(out.applied, 2);
    assert.equal(out.failed, 0);
    // The guard is checked ONCE, before the first mutation — moving it inside
    // the per-key loop (or after) would change this sequence.
    const seq = recorded.requests.map((r) => r.method);
    assert.deepEqual(seq, ['GET', 'PATCH', 'PATCH']);
  });

  test('move_file: source mismatch → rejects AND neither PUT nor DELETE fires', async () => {
    behaviour.get = { status: 200, body: 'current' };
    await assert.rejects(
      () => moveFileTool(realRegistry(), { from: 'a.md', to: 'b.md', overwrite: true, ifMatch: contentSha256('STALE') }),
      /changed since|precondition failed/i,
    );
    assert.equal(recorded.corePut, null);
    assert.equal(recorded.coreDelete, null);
  });

  test('move_file: source match (overwrite) → PUT dest + DELETE source both fire', async () => {
    behaviour.get = { status: 200, body: 'current' };
    await moveFileTool(realRegistry(), { from: 'a.md', to: 'b.md', overwrite: true, ifMatch: contentSha256('current') });
    assert.ok(recorded.corePut, 'PUT (dest) should fire');
    assert.ok(recorded.coreDelete, 'DELETE (source) should fire');
  });
});

// --- Tool-layer input validation (throws BEFORE any network call) ----------

// A registry whose resolveVault would BLOW UP if reached — proves validation
// happens before the vault is ever resolved / the network is touched.
const explodingRegistry = {
  resolveVault() {
    throw new Error('resolveVault must not be reached in a validation test');
  },
  defaultVault: 'x',
};
const VALID_HASH = contentSha256('x');

describe('tool-layer ifMatch validation', () => {
  test('write_file rejects a malformed ifMatch', async () => {
    await assert.rejects(
      () => writeFileTool(explodingRegistry, { path: 'a.md', content: 'c', ifMatch: 'nope' }),
      /Invalid ifMatch/,
    );
  });

  test('write_file rejects ifNew + ifMatch together', async () => {
    await assert.rejects(
      () => writeFileTool(explodingRegistry, { path: 'a.md', content: 'c', ifMatch: VALID_HASH, ifNew: true }),
      /mutually exclusive/,
    );
  });

  test('patch_file rejects a malformed ifMatch', async () => {
    await assert.rejects(
      () =>
        patchFileTool(explodingRegistry, {
          path: 'a.md',
          operation: 'append',
          targetType: 'heading',
          target: 'H',
          content: 'c',
          ifMatch: 'nope',
        }),
      /Invalid ifMatch/,
    );
  });

  test('delete_file rejects a malformed ifMatch (with confirm:true)', async () => {
    await assert.rejects(
      () => deleteFileTool(explodingRegistry, { path: 'a.md', confirm: true, ifMatch: 'nope' }),
      /Invalid ifMatch/,
    );
  });

  test('move_file rejects a malformed ifMatch', async () => {
    await assert.rejects(
      () => moveFileTool(explodingRegistry, { from: 'a.md', to: 'b.md', ifMatch: 'nope' }),
      /Invalid ifMatch/,
    );
  });

  test('merge_frontmatter rejects a malformed ifMatch', async () => {
    await assert.rejects(
      () => mergeFrontmatterTool(explodingRegistry, { path: 'a.md', values: { a: 1 }, ifMatch: 'nope' }),
      /Invalid ifMatch/,
    );
  });
});
