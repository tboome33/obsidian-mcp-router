/**
 * A3 — agentic-first guardrails on `get_wiki_context_pack`.
 *
 * Two things are being defended:
 *   1. PROVENANCE SURVIVES FLATTENING. The envelope separated navigation from
 *      augmentation by array; a consumer that merges the arrays lost it, and a
 *      middling semantic chunk then reads like a page reached by navigating.
 *   2. AN ANSWER WITH NO NAVIGATIONAL ANCHOR SAYS SO. Ordering is a convention
 *      a consumer can ignore; an empty navigational half is a fact.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  getWikiContextPack,
  SOURCE_INDEX,
  SOURCE_GRAPH,
  SOURCE_SEMANTIC,
} from '../src/tools/get-wiki-context-pack.mjs';

const VAULT = { name: 'v', type: 'local', path: '/vault' };
const registry = { resolveVault: () => VAULT, vaults: [VAULT], lockedVault: null };
/** No Smart Connections store — freshness declines, which is A1's business, not A3's. */
const noStore = { readdirSync: () => { throw new Error('ENOENT'); }, readFileSync: () => '', statSync: () => ({ size: 0 }) };

const deps = (extra = {}) => ({
  getFileContent: async () => '# Catalog\n\n- [[plugins]] — the plugins page\n',
  getNote: async () => ({ content: 'about plugins, see [[neighbour-page]]', frontmatter: {} }),
  searchSmart: async () => ({ results: [{ path: 'wiki/s.md', text: 'a chunk', score: 0.8 }] }),
  fs: noStore,
  ...extra,
});

describe('A3 — provenance on every item', () => {
  test('a catalogue-ranked page is labelled `index`', async () => {
    const out = await getWikiContextPack(registry, { query: 'plugins' }, deps());
    assert.equal(out.primaryPages.length, 1);
    assert.equal(out.primaryPages[0].source, SOURCE_INDEX);
  });

  test('a wikilink neighbour is labelled `graph`, not `index`', async () => {
    const out = await getWikiContextPack(registry, { query: 'plugins' }, deps());
    assert.ok(out.graphNeighbors.length >= 1);
    assert.equal(out.graphNeighbors[0].source, SOURCE_GRAPH);
  });

  test('a semantic chunk is labelled `semantic`', async () => {
    const out = await getWikiContextPack(registry, { query: 'plugins' }, deps());
    assert.equal(out.semanticChunks[0].source, SOURCE_SEMANTIC);
  });

  test('a DEAD catalogue link keeps its provenance — a gap is still shown, not lost', async () => {
    const out = await getWikiContextPack(registry, { query: 'plugins' }, deps({
      getNote: async () => { throw Object.assign(new Error('not found'), { kind: 'not_found' }); },
    }));
    assert.equal(out.primaryPages.length, 1);
    assert.equal(out.primaryPages[0].source, SOURCE_INDEX);
  });

  test('EVERY item in the pack carries a source — the labelling has no holes', async () => {
    const out = await getWikiContextPack(registry, { query: 'plugins' }, deps());
    for (const arr of ['primaryPages', 'graphNeighbors', 'semanticChunks']) {
      for (const item of out[arr]) {
        assert.ok(item.source, `${arr} item without a source: ${JSON.stringify(item)}`);
        assert.ok(out.provenance.values.includes(item.source), `${item.source} is outside the declared vocabulary`);
      }
    }
  });

  test('the vocabulary is DECLARED, not left to be inferred from what happened to appear', async () => {
    const out = await getWikiContextPack(registry, { query: 'plugins' }, deps());
    assert.deepEqual(out.provenance.values, [SOURCE_INDEX, SOURCE_GRAPH, SOURCE_SEMANTIC]);
    assert.deepEqual(out.provenance.navigational, [SOURCE_INDEX, SOURCE_GRAPH]);
    assert.deepEqual(out.provenance.augmentation, [SOURCE_SEMANTIC]);
    assert.match(out.provenance.note, /never the sole support/i);
  });

  test('`hot` and `plain-search` are NOT declared — a vocabulary lists what is produced', async () => {
    // The roadmap sketched them; they are tiers of the `wiki-query` skill, not
    // of this tool. Declaring values nothing emits teaches a consumer to branch
    // on cases that never arrive.
    const out = await getWikiContextPack(registry, { query: 'plugins' }, deps());
    assert.equal(out.provenance.values.includes('hot'), false);
    assert.equal(out.provenance.values.includes('plain-search'), false);
  });
});

describe('A3 — the semantic-only guard', () => {
  test('no navigational anchor + semantic chunks → the warning fires, with an action', async () => {
    const out = await getWikiContextPack(registry, { query: 'utterlyunrelatedtoken' }, deps());
    assert.equal(out.primaryPages.length, 0);
    assert.ok(out.semanticChunks.length > 0);
    assert.ok(out.warnings.includes('answer-relies-on-semantic-only'));
    assert.ok(out.suggestedActions.some((a) => /pointers to verify/i.test(a)));
  });

  test('a navigational anchor silences it', async () => {
    const out = await getWikiContextPack(registry, { query: 'plugins' }, deps());
    assert.equal(out.warnings.includes('answer-relies-on-semantic-only'), false);
  });

  test('A PLACEHOLDER IS NOT AN ANCHOR — a page that could not be read anchors nothing', async () => {
    // `primaryPages` carries placeholders for dead catalogue links. Counting
    // those as navigation would silence the guard with an entry that names a
    // gap and carries no content.
    const out = await getWikiContextPack(registry, { query: 'plugins' }, deps({
      getNote: async () => { throw Object.assign(new Error('not found'), { kind: 'not_found' }); },
      // No body ⇒ no wikilinks ⇒ no graph neighbours either.
    }));
    assert.equal(out.primaryPages.length, 1, 'the gap is still reported');
    assert.equal(out.graphNeighbors.length, 0);
    assert.ok(out.warnings.includes('answer-relies-on-semantic-only'));
  });

  test('a GRAPH neighbour counts as an anchor — navigation is not only the catalogue', async () => {
    const out = await getWikiContextPack(registry, { query: 'plugins' }, deps());
    assert.ok(out.graphNeighbors.length > 0);
    assert.equal(out.warnings.includes('answer-relies-on-semantic-only'), false);
  });

  test('no semantic chunks at all → no warning: there is nothing to over-weight', async () => {
    const out = await getWikiContextPack(registry, { query: 'utterlyunrelatedtoken' }, deps({
      searchSmart: async () => ({ results: [] }),
    }));
    assert.equal(out.semanticChunks.length, 0);
    assert.equal(out.warnings.includes('answer-relies-on-semantic-only'), false);
  });

  test('the action is PERFORMABLE — a pathless chunk is not "a page you can open"', async () => {
    // Found in review: some bridge payloads carry text with no path. Telling the
    // reader to "open the pages they name" then prescribes something impossible,
    // which reads as though verification were available when it is not.
    const out = await getWikiContextPack(registry, { query: 'utterlyunrelatedtoken' }, deps({
      searchSmart: async () => ({ results: [{ text: 'orphan chunk', score: 0.9 }] }),
    }));
    assert.ok(out.warnings.includes('answer-relies-on-semantic-only'));
    const action = out.suggestedActions.find((a) => /pointers to verify/i.test(a));
    assert.match(action, /none of them names a page to open/);
    assert.match(action, /do not cite them/);
    assert.equal(/open the \d+ page\(s\) they name/.test(action), false);
  });

  test('a WHITESPACE path is not "a page you can open" either', async () => {
    // Found in review: `{path: "   "}` is truthy, so it counted as named and the
    // action told the reader to open one page — put back one shape narrower.
    const out = await getWikiContextPack(registry, { query: 'utterlyunrelatedtoken' }, deps({
      searchSmart: async () => ({ results: [{ path: '   ', text: 'orphan', score: 0.9 }] }),
    }));
    const action = out.suggestedActions.find((a) => /pointers to verify/i.test(a));
    assert.match(action, /none of them names a page to open/);
  });

  test('a link inside CODE or an HTML COMMENT is not a graph edge', async () => {
    // A3 labels graph neighbours as authoritative navigation, so emitting a
    // link shown as an EXAMPLE would turn a long-standing looseness into a
    // false claim about what the vault points at.
    const out = await getWikiContextPack(registry, { query: 'plugins' }, deps({
      getNote: async () => ({
        content: [
          'Real: [[real-neighbour]]',
          '```',
          'Example: [[fenced-example]]',
          '```',
          'Inline: `[[inline-example]]`',
          '<!-- [[commented-example]] -->',
        ].join('\n'),
        frontmatter: {},
      }),
    }));
    const targets = out.graphNeighbors.map((n) => n.title);
    assert.ok(targets.includes('real-neighbour'));
    for (const ghost of ['fenced-example', 'inline-example', 'commented-example']) {
      assert.equal(targets.includes(ghost), false, `${ghost} is not an edge`);
    }
  });

  test('the delimiters are COUNTED — a 4-backtick fence and a ``double`` span too', async () => {
    // Found in review: matching exactly ``` and exactly ` let both real
    // CommonMark shapes leak. A four-backtick fence legitimately CONTAINS a
    // triple one, and an inline span of N backticks closes only on N.
    const out = await getWikiContextPack(registry, { query: 'plugins' }, deps({
      getNote: async () => ({
        content: [
          'Real: [[real-neighbour]]',
          '````',
          '```',
          'Example: [[quad-fenced]]',
          '```',
          '````',
          'Double span: ``[[double-span]]``',
        ].join('\n'),
        frontmatter: {},
      }),
    }));
    const targets = out.graphNeighbors.map((n) => n.title);
    assert.ok(targets.includes('real-neighbour'));
    assert.equal(targets.includes('quad-fenced'), false);
    assert.equal(targets.includes('double-span'), false);
  });

  test('the v1 envelope keeps every mandatory field, and the addition is additive', async () => {
    const out = await getWikiContextPack(registry, { query: 'plugins' }, deps());
    for (const k of ['version', 'query', 'vault', 'primaryPages', 'semanticChunks',
      'graphNeighbors', 'citations', 'warnings', 'suggestedActions']) {
      assert.ok(k in out, `v1 mandatory field ${k} still present`);
    }
    assert.equal(out.version, 'v1');
  });
});
