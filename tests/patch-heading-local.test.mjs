/**
 * Wire-level tests for the router-side heading patch path in
 * src/rest-client.mjs patchFile():
 *
 *   targetType heading   → GET /vault/… + PUT /vault/… (NEVER a PATCH — the
 *                          plugin's offset-based heading engine corrupts CRLF
 *                          files, see tests/heading-patch.test.mjs)
 *   targetType block     → still forwarded as PATCH (plugin path unchanged)
 *   targetType frontmatter → still forwarded as PATCH
 *
 * Uses the same tiny real-HTTP-server pattern as if-match-writes.test.mjs.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { patchFile, RestApiError } from '../src/rest-client.mjs';
import { patchFileTool } from '../src/tools/patch-file.mjs';

let behaviour;
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
    const url = decodeURIComponent(req.url);
    recorded.requests.push({ method: req.method, url, body, headers: req.headers });
    if (req.method === 'GET' && url.startsWith('/vault/')) {
      const r = behaviour.get;
      res.writeHead(r.status, { 'Content-Type': 'text/markdown' });
      res.end(r.body ?? '');
      return;
    }
    if (req.method === 'PUT' && url.startsWith('/vault/')) {
      recorded.corePut = { url, body };
      res.writeHead(200, { 'Content-Type': 'text/markdown' });
      res.end('');
      return;
    }
    if (req.method === 'PATCH' && url.startsWith('/vault/')) {
      recorded.corePatch = { url, body, headers: req.headers };
      res.writeHead(200, { 'Content-Type': 'text/markdown' });
      res.end('');
      return;
    }
    res.writeHead(500);
    res.end('unexpected');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

beforeEach(() => {
  behaviour = { get: { status: 404 } };
  recorded = { requests: [], corePut: null, corePatch: null };
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

const registry = { resolveVault: () => vault(), defaultVault: 'testvault' };

const CRLF = '\r\n';
const CRLF_DOC = ['# Racine', '', '## Phase W3 · Frontends ✅', '', '- [x] item un', ''].join(CRLF);

describe('patchFile — heading goes through GET + local engine + PUT', () => {
  test('CRLF file: no PATCH on the wire; PUT body is the correctly patched CRLF content', async () => {
    behaviour.get = { status: 200, body: CRLF_DOC };
    await patchFile(vault(), 'note.md', {
      operation: 'append',
      targetType: 'heading',
      target: 'Racine::Phase W3 · Frontends ✅',
      content: '- [x] item deux',
    });
    assert.equal(recorded.corePatch, null, 'heading patch must NEVER hit the plugin PATCH');
    assert.ok(recorded.corePut, 'the patched file must be written back with PUT');
    assert.equal(
      recorded.corePut.body,
      ['# Racine', '', '## Phase W3 · Frontends ✅', '', '- [x] item un', '- [x] item deux', ''].join(CRLF),
    );
    const methods = recorded.requests.map((r) => r.method);
    assert.deepEqual(methods, ['GET', 'PUT']);
  });

  test('missing heading → RestApiError kind not_found with invalid-target message, no PUT', async () => {
    behaviour.get = { status: 200, body: '# Autre\n' };
    await assert.rejects(
      () =>
        patchFile(vault(), 'note.md', {
          operation: 'append',
          targetType: 'heading',
          target: 'Inexistant',
          content: 'x',
        }),
      (err) => err instanceof RestApiError && err.kind === 'not_found' && /invalid-target/.test(err.message),
    );
    assert.equal(recorded.corePut, null);
    assert.equal(recorded.corePatch, null);
  });

  test('missing FILE → the GET 404 propagates (file creation is write_file territory)', async () => {
    behaviour.get = { status: 404 };
    await assert.rejects(
      () =>
        patchFile(vault(), 'absent.md', {
          operation: 'append',
          targetType: 'heading',
          target: 'H',
          content: 'x',
          createTargetIfMissing: true,
        }),
      (err) => err instanceof RestApiError && err.kind === 'not_found',
    );
    assert.equal(recorded.corePut, null);
  });

  test('applyIfContentPreexists skip → NO write at all, tool reports patched:false', async () => {
    behaviour.get = { status: 200, body: '# H\ndéjà là\n' };
    const out = await patchFileTool(registry, {
      path: 'note.md',
      operation: 'append',
      targetType: 'heading',
      target: 'H',
      content: 'déjà là',
      applyIfContentPreexists: true,
    });
    assert.equal(recorded.corePut, null, 'skipped patch must not rewrite the file');
    assert.equal(out.patched, false);
    assert.equal(out.skippedReason, 'content-preexists');
  });

  test('createTargetIfMissing → created heading reported by the tool', async () => {
    behaviour.get = { status: 200, body: '# H\n' };
    const out = await patchFileTool(registry, {
      path: 'note.md',
      operation: 'append',
      targetType: 'heading',
      target: 'H::Nouvelle section',
      content: 'x',
      createTargetIfMissing: true,
    });
    assert.equal(out.patched, true);
    assert.equal(out.createdTarget, true);
    assert.match(recorded.corePut.body, /## Nouvelle section\nx\n/);
  });

  test('non-string content on a heading target is refused before any traffic', async () => {
    await assert.rejects(
      () =>
        patchFile(vault(), 'note.md', {
          operation: 'append',
          targetType: 'heading',
          target: 'H',
          content: { not: 'a string' },
        }),
      /content must be a string/,
    );
    assert.equal(recorded.requests.length, 0);
  });
});

describe('patchFile — block and frontmatter still forward to the plugin PATCH', () => {
  test('block target → PATCH with the original headers, no GET/PUT', async () => {
    await patchFile(vault(), 'note.md', {
      operation: 'replace',
      targetType: 'block',
      target: 'blockid',
      content: 'nouveau',
    });
    assert.ok(recorded.corePatch, 'block patch must still go through the plugin');
    assert.equal(recorded.corePatch.headers['target-type'], 'block');
    assert.equal(recorded.corePatch.headers.operation, 'replace');
    assert.equal(recorded.corePatch.body, 'nouveau');
    assert.equal(recorded.corePut, null);
    assert.equal(recorded.requests.filter((r) => r.method === 'GET').length, 0);
  });

  test('frontmatter target with JSON value → PATCH application/json', async () => {
    await patchFile(vault(), 'note.md', {
      operation: 'replace',
      targetType: 'frontmatter',
      target: 'tags',
      content: ['a', 'b'],
    });
    assert.ok(recorded.corePatch);
    assert.match(recorded.corePatch.headers['content-type'], /application\/json/);
    assert.equal(recorded.corePatch.body, JSON.stringify(['a', 'b']));
    assert.equal(recorded.corePut, null);
  });
});
