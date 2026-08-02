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
import { writeFileIfMatch, assertContentMatches } from '../src/rest-client.mjs';
import { getFile } from '../src/tools/get-file.mjs';
import { writeFileTool } from '../src/tools/write-file.mjs';
import { patchFileTool } from '../src/tools/patch-file.mjs';
import { deleteFileTool } from '../src/tools/delete-file.mjs';
import { moveFileTool } from '../src/tools/move-file.mjs';
import { mergeFrontmatterTool } from '../src/tools/merge-frontmatter.mjs';
import { contentSha256 } from '../src/helpers/content-hash.mjs';

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

    // Atomic CAS route.
    if (req.method === 'PUT' && url.startsWith('/vault-cas/')) {
      const r = behaviour.vaultCas;
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
  recorded = { requests: [], corePut: null, corePatch: null, coreDelete: null };
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
      recorded = { requests: [], corePut: null, corePatch: null, coreDelete: null };
      behaviour.vaultCas = { status, body: {} };
      behaviour.get = { status: 200, body: 'current' };
      const out = await writeFileIfMatch(vault(), 'a.md', 'new', contentSha256('current'));
      assert.equal(out.casMode, 'fallback', `status ${status} must degrade`);
      assert.ok(recorded.corePut, `status ${status}: core PUT must service the write`);
    }
    // Hard-error group: no fallback GET, no core PUT — the error surfaces.
    for (const status of [401, 403, 500]) {
      recorded = { requests: [], corePut: null, corePatch: null, coreDelete: null };
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

// --- get_file: the contentSha256 contract (codex #3) ------------------------

describe('get_file — contentSha256 is the RAW hash, content is sanitized', () => {
  test('sanitizable content: displayed content differs, hash equals the raw bytes', async () => {
    // sanitizeContent neutralizes agentic markers: '<system-reminder' becomes
    // '&lt;system-reminder'. The hash MUST be computed BEFORE that — it has to
    // match what is on disk (what the bridge's adapter.read will hash).
    const raw = 'avant <system-reminder> après';
    behaviour.get = { status: 200, body: raw };
    const out = await getFile(realRegistry(), { path: 'a.md' });
    assert.notEqual(out.content, raw, 'content must be sanitized');
    assert.match(out.content, /&lt;system-reminder/);
    assert.equal(out.contentSha256, contentSha256(raw), 'hash must be of the RAW content');
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
