/**
 * missing-read-guard — the ONE definition of "was the graph never built, or did
 * something else go wrong?", shared by the four tools that read
 * `wiki-meta/graph/knowledge-graph.json`.
 *
 * It exists because three copies of that decision drifted into the same bug,
 * and C10 fixed only its own. Every assertion here is a case one of those
 * copies got wrong.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { isMissingReadError, graphMissingError } from '../src/helpers/missing-read-guard.mjs';
import { getPageNeighborsTool } from '../src/tools/get-page-neighbors.mjs';
import { wikiPathTool } from '../src/tools/wiki-path.mjs';
import { buildWikiTourTool } from '../src/tools/build-wiki-tour.mjs';
import { findBoundaryPagesTool } from '../src/tools/find-boundary-pages.mjs';

const withKind = (message, kind, extra = {}) => Object.assign(new Error(message), { kind, ...extra });

describe('isMissingReadError — a structured kind is authoritative', () => {
  test('only kind "not_found" means the graph is absent', () => {
    assert.equal(isMissingReadError(withKind('Not Found', 'not_found')), true);
    for (const kind of ['unreachable', 'timeout', 'unauthorized', 'forbidden', 'conflict', 'validation', 'unknown']) {
      assert.equal(isMissingReadError(withKind('whatever', kind)), false, `kind ${kind} must not read as missing`);
    }
  });

  test('PIN: ENOTFOUND is NOT a missing graph — the bug this helper exists for', () => {
    // The rest-client reports a dead host as kind:'unreachable' with a message
    // ending "(ENOTFOUND)". A bare /not.?found/ matched the NOTFOUND *inside*
    // ENOTFOUND, so an offline vault was told to rebuild a graph it already
    // has. Three tools shipped that bug simultaneously.
    const err = withKind(
      '[roland] unreachable at https://127.0.0.1:27126/vault/wiki-meta/graph/knowledge-graph.json (ENOTFOUND)',
      'unreachable',
    );
    assert.equal(isMissingReadError(err), false);
  });

  test('PIN: a structured kind WINS over a misleading message', () => {
    // Even a message literally containing "not found" must not override an
    // explicit non-404 classification.
    assert.equal(isMissingReadError(withKind('credential not found in keyring', 'unauthorized', { status: 401 })), false);
    assert.equal(isMissingReadError(withKind('user not found', 'validation')), false);
    // ...and the converse: kind:'not_found' wins even with an odd message.
    assert.equal(isMissingReadError(withKind('boom', 'not_found')), true);
  });
});

describe('isMissingReadError — the message sniff is the LAST resort, and narrow', () => {
  test('an explicit 404 status, with no kind, reads as missing — number OR string', () => {
    for (const v of [404, '404']) {
      assert.equal(isMissingReadError(Object.assign(new Error('nope'), { status: v })), true, `status ${JSON.stringify(v)}`);
      assert.equal(isMissingReadError(Object.assign(new Error('nope'), { statusCode: v })), true, `statusCode ${JSON.stringify(v)}`);
    }
    // ...but only a real 404.
    for (const v of [500, '404abc', '', null, true, 'four-oh-four']) {
      assert.equal(isMissingReadError(Object.assign(new Error('nope'), { status: v })), false, `status ${JSON.stringify(v)}`);
    }
  });

  test('canonical missing-file and 404 phrasings are recognised', () => {
    for (const m of [
      "ENOENT: no such file or directory, open 'knowledge-graph.json'",
      'no such file',
      'HTTP 404',
      'HTTP/1.1 404 Not Found',
      '404 Not Found',
      'Error 404',
      'Request failed with status code 404',
      'Response code 404 (Not Found)',
      'server responded with 404',
      '404 (Not Found)',
      'File not found',
    ]) {
      assert.equal(isMissingReadError(new Error(m)), true, `"${m}" should read as missing`);
    }
  });

  test('PIN: a bare 404 anywhere is NOT enough — a port number is not a status', () => {
    for (const m of [
      'connect ECONNREFUSED 127.0.0.1:404',
      'listening on 0.0.0.0:404',
      'read 4040 bytes',
      'connect ENOTFOUND vault.example.invalid',
      'connect enotfound vault.example.invalid',
      'credential not found in keyring',
      'user not found',
      // A 404 inside a FILENAME or a HASH is not a status code.
      "cannot open 'Error 404.md'",
      'hash code 404-deadbeef mismatch',
      "cannot read 'graph-404.json'",
      'sha 9f404abc mismatch',
    ]) {
      assert.equal(isMissingReadError(new Error(m)), false, `"${m}" must NOT read as missing`);
    }
  });

  test('PIN: junk input, and INSPECTION THAT THROWS, never throws and never claims "missing"', () => {
    for (const bad of [null, undefined, 'a string', 42, {}, [], new Error('')]) {
      assert.equal(isMissingReadError(bad), false);
    }
    // This runs inside a `catch`: a throwing getter must not become the error
    // the user sees in place of the real failure.
    for (const prop of ['kind', 'status', 'statusCode', 'message']) {
      const hostile = Object.defineProperty({}, prop, { get() { throw new Error('boom'); } });
      assert.equal(isMissingReadError(hostile), false, `a throwing \`${prop}\` getter must be survivable`);
    }
    assert.equal(
      isMissingReadError({ message: { toString() { throw new Error('boom'); } } }),
      false,
      'a throwing toString must be survivable',
    );
  });

  test('PIN: a PRESENT but empty kind fails closed — it does not re-enable the heuristics', () => {
    // `if (kind)` let `kind: ''` fall through to sniffing, so a malformed
    // structured error could still be talked into "missing" by its message.
    assert.equal(isMissingReadError(Object.assign(new Error('HTTP 404'), { kind: '' })), false);
    // null/undefined mean "no classification available" — sniffing is correct there.
    assert.equal(isMissingReadError(Object.assign(new Error('HTTP 404'), { kind: null })), true);
    assert.equal(isMissingReadError(Object.assign(new Error('HTTP 404'), { kind: undefined })), true);
  });
});

describe('graphMissingError — one wording, classified as actionable', () => {
  test('names the path and the fix, and carries kind "validation"', () => {
    const err = graphMissingError('wiki-meta/graph/knowledge-graph.json');
    assert.match(err.message, /wiki-meta\/graph\/knowledge-graph\.json/);
    assert.match(err.message, /build_wiki_graph/);
    assert.equal(err.kind, 'validation', 'an actionable refusal must not surface as Category: unknown');
  });
});

describe('all four graph-reading tools share the guard — no copy left behind', () => {
  const registry = { resolveVault: () => ({ name: 'roland' }) };
  const throwing = (err) => ({ getFileContent: async () => { throw err; } });
  const TOOLS = [
    ['get_page_neighbors', (deps) => getPageNeighborsTool(registry, { page: 'x' }, deps)],
    ['wiki_path', (deps) => wikiPathTool(registry, { from: 'a', to: 'b' }, deps)],
    ['build_wiki_tour', (deps) => buildWikiTourTool(registry, {}, deps)],
    ['find_boundary_pages', (deps) => findBoundaryPagesTool(registry, {}, deps)],
  ];

  test('PIN: an unreachable vault is never reported as a missing graph', async () => {
    const dead = () => Object.assign(
      new Error('[roland] unreachable at https://127.0.0.1:27126/vault/wiki-meta/graph/knowledge-graph.json (ENOTFOUND)'),
      { kind: 'unreachable' },
    );
    for (const [name, run] of TOOLS) {
      await assert.rejects(
        () => run(throwing(dead())),
        (err) => {
          assert.doesNotMatch(err.message, /No knowledge graph/, `${name} misreported a dead host`);
          assert.match(err.message, /ENOTFOUND/, `${name} must surface the real failure`);
          return true;
        },
      );
    }
  });

  test('a genuinely absent graph still gets the helpful message, from every tool', async () => {
    for (const [name, run] of TOOLS) {
      await assert.rejects(
        () => run(throwing(Object.assign(new Error('Not Found'), { kind: 'not_found' }))),
        (err) => {
          assert.match(err.message, /No knowledge graph[\s\S]*build_wiki_graph/, `${name} lost the actionable message`);
          assert.equal(err.kind, 'validation', `${name} must classify the refusal`);
          return true;
        },
      );
    }
  });

  test('PIN: other operational failures pass through as the SAME OBJECT, from every tool', async () => {
    // Identity, not just equal fields: a passthrough that rebuilt the error
    // would drop whatever the caller attached to it (cause chains, hints).
    const cases = [
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:27126'), { kind: 'transient', status: 503 }),
      Object.assign(new Error('unauthorized'), { kind: 'unauthorized', status: 401 }),
      Object.assign(new Error('request timed out'), { kind: 'timeout' }),
    ];
    for (const [name, run] of TOOLS) {
      for (const err of cases) {
        await assert.rejects(
          () => run(throwing(err)),
          (thrown) => {
            assert.equal(thrown, err, `${name} must rethrow the ORIGINAL error object (${err.kind})`);
            return true;
          },
        );
      }
    }
  });
});
