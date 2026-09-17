/**
 * get_wiki_context_pack — the temporal-validity annotation (roadmap 4a.2).
 *
 * WHAT THIS FILE IS ABOUT, AND IT IS NOT THE STATES. Whether a window means
 * `in-force` is settled three modules down and proved by its own suites. What
 * only shows up HERE is the wiring: that every note read in a call goes through
 * one door, that a page named by three collections is read once, that the
 * quotas are the declared ones and are separate, and that nothing is ever
 * dropped or hidden because of a window.
 *
 * SO NEARLY EVERY ASSERTION COUNTS READS. `getNote` is injected and records
 * every call it serves, because "one read per page" is not visible in the
 * envelope: a version that read each page four times would return exactly the
 * same JSON.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  COLLECTION_CHUNKS,
  COLLECTION_NEIGHBORS,
  COLLECTION_PRIMARY,
  NEIGHBOR_VALIDITY_READS,
  TOOL_DEFINITION,
  getWikiContextPack,
} from '../src/tools/get-wiki-context-pack.mjs';

const TODAY = '2026-06-15';

function makeRegistry() {
  return {
    resolveVault: (name) => ({
      name: name || 'test-vault',
      type: 'local',
      path: '/tmp/test-vault',
      baseUrl: 'http://127.0.0.1:27124',
    }),
  };
}

/** A catalogue naming exactly the pages a case cares about. */
function catalogueOf(names) {
  return `---\ntype: wiki-index\n---\n\n# Index\n\n## Trading\n${
    names.map((n) => `- [[${n}]] — a page about the archive storage tariff`).join('\n')
  }\n`;
}

function note(frontmatter, content = '# Page\n\nThe archive storage tariff.\n') {
  return { content, frontmatter };
}

/** Deps whose `getNote` remembers every path it was asked for. */
function makeDeps({ catalogue, notes = {}, chunks = [] } = {}) {
  const calls = [];
  const deps = {
    getFileContent: async (_vault, filePath) => {
      if (filePath === 'wiki-meta/catalog.md') return catalogue;
      throw Object.assign(new Error(`not_found: ${filePath}`), { kind: 'not_found' });
    },
    getNote: async (_vault, filePath) => {
      calls.push(filePath);
      if (Object.prototype.hasOwnProperty.call(notes, filePath)) return notes[filePath];
      throw Object.assign(new Error(`not_found: ${filePath}`), { kind: 'not_found' });
    },
    searchSmart: async () => ({ results: chunks }),
  };
  deps.calls = calls;
  deps.countFor = (p) => calls.filter((c) => c === p).length;
  return deps;
}

const QUERY = 'archive storage tariff';

// ---------------------------------------------------------------------------
describe('the parameter, and the day it fixes', () => {
  test('`asOf` is declared in the MCP schema', () => {
    const asOf = TOOL_DEFINITION.inputSchema.properties.asOf;
    assert.equal(asOf.type, 'string');
    assert.match(asOf.description, /YYYY-MM-DD/);
    assert.match(asOf.description, /ONCE/, 'the once-per-call rule belongs in the contract, not only in the code');
    assert.equal(TOOL_DEFINITION.inputSchema.additionalProperties, false);
  });

  test('an unreadable `asOf` FAILS THE CALL — it never falls back to today', async () => {
    // Invariant 8. Falling back would answer a question the caller did not ask,
    // with today's date, and look successful doing it.
    const deps = makeDeps({ catalogue: catalogueOf(['tariff']) });
    await assert.rejects(
      () => getWikiContextPack(makeRegistry(), { query: QUERY, asOf: 'next tuesday' }, deps),
      /temporal-validity/,
    );
  });

  test('and it fails BEFORE any note is read', async () => {
    // A bad argument is bad on its own terms. Discovering it halfway through
    // means the call has already spent I/O on a request that cannot succeed.
    const deps = makeDeps({ catalogue: catalogueOf(['tariff']), notes: { 'wiki/tariff.md': note({}) } });
    await getWikiContextPack(makeRegistry(), { query: QUERY, asOf: 'nope' }, deps).catch(() => {});
    assert.deepEqual(deps.calls, [], 'nothing was read');
  });

  test('the summary carries the day the caller asked for', async () => {
    const deps = makeDeps({ catalogue: catalogueOf(['tariff']), notes: { 'wiki/tariff.md': note({}) } });
    const pack = await getWikiContextPack(makeRegistry(), { query: QUERY, asOf: '2030-03-04' }, deps);
    assert.equal(pack.validitySummary.asOf, '2030-03-04');
  });
});

// ---------------------------------------------------------------------------
describe('the envelope', () => {
  test('validitySummary is ALWAYS there, even when nothing declares a window', async () => {
    // Its absence would be ambiguous: "no page is dated" and "this build does
    // not annotate" would look the same, and no consumer can tell them apart
    // after the fact.
    const deps = makeDeps({
      catalogue: catalogueOf(['tariff']),
      notes: { 'wiki/tariff.md': note({ title: 'Tariff' }) },
    });
    const pack = await getWikiContextPack(makeRegistry(), { query: QUERY, asOf: TODAY }, deps);
    assert.ok(pack.validitySummary);
    assert.equal(pack.validitySummary.annotatedEntries, 0);
    assert.equal(pack.validitySummary.revisionCoherence, 'not-verified');
    assert.equal(pack.validitySummary.budgetExhausted, false);
  });

  test('the version stays v1 — this is an additive field', async () => {
    const deps = makeDeps({ catalogue: catalogueOf(['tariff']), notes: { 'wiki/tariff.md': note({}) } });
    const pack = await getWikiContextPack(makeRegistry(), { query: QUERY, asOf: TODAY }, deps);
    assert.equal(pack.version, 'v1');
  });

  test('INVARIANT 6 — strip the additions and the envelope is what it always was', async () => {
    // The compatibility claim, pinned rather than asserted in prose. Everything
    // this phase adds is optional and additive; remove those three keys and a
    // consumer written before the phase must see byte-identical content. A
    // renamed key, a reordered array, a field that quietly became nullable
    // would all show up here.
    const deps = makeDeps({
      catalogue: catalogueOf(['tariff', 'hub']),
      notes: {
        'wiki/tariff.md': note({ title: 'Tariff', valid_through: '2025-12-31', source_type: 'extracted' }),
        'wiki/hub.md': note({ title: 'Hub' }, '# Hub\n\nThe archive storage tariff: see [[tariff]] and [[other]].\n'),
      },
      chunks: [{ path: 'wiki/tariff.md', text: 'archive storage tariff excerpt', score: 0.9 }],
    });
    const pack = await getWikiContextPack(makeRegistry(), { query: QUERY, asOf: TODAY }, deps);

    // Everything the phase adds, and nothing else.
    const { validitySummary, ...rest } = pack;
    assert.ok(validitySummary, 'the summary is one of the additions');
    const strip = (entry) => {
      const { validity, validityUnverified, ...plain } = entry;
      return plain;
    };
    const stripped = {
      ...rest,
      primaryPages: rest.primaryPages.map(strip),
      semanticChunks: rest.semanticChunks.map(strip),
      graphNeighbors: rest.graphNeighbors.map(strip),
    };

    // `folderExclusion` and `semanticFreshness` are earlier optional additions
    // and belong to the before-picture: this fixture happens to produce both,
    // and their presence here is what the phase must NOT have disturbed.
    assert.deepEqual(Object.keys(stripped).sort(), [
      'citations', 'folderExclusion', 'graphNeighbors', 'primaryPages', 'provenance',
      'query', 'semanticChunks', 'semanticFreshness', 'suggestedActions', 'vault', 'version', 'warnings',
    ], 'the v1 top-level keys, unchanged');

    assert.deepEqual(stripped.primaryPages.map((p) => Object.keys(p).sort()), [
      ['path', 'score', 'snippet', 'source', 'source_type', 'summary', 'title'],
      ['path', 'score', 'snippet', 'source', 'source_type', 'summary', 'title'],
    ], 'a primary page still carries exactly its v1 fields');

    assert.deepEqual(stripped.semanticChunks.map((c) => Object.keys(c).sort()), [
      ['breadcrumbs', 'path', 'score', 'source', 'text'],
    ]);
    assert.deepEqual(stripped.graphNeighbors.map((n) => Object.keys(n).sort()), [
      ['path', 'source', 'title', 'via'],
    ]);
  });

  test('a dated primary page carries its window', async () => {
    const deps = makeDeps({
      catalogue: catalogueOf(['tariff']),
      notes: { 'wiki/tariff.md': note({ title: 'Tariff', valid_through: '2025-12-31' }) },
    });
    const pack = await getWikiContextPack(makeRegistry(), { query: QUERY, asOf: TODAY }, deps);
    const page = pack.primaryPages.find((p) => p.path === 'wiki/tariff.md');
    assert.equal(page.validity.state, 'no-longer-in-force');
    assert.equal(page.validity.asOf, TODAY);
    assert.equal(pack.validitySummary.annotatedEntries, 1);
  });

  test('an undated page carries nothing, and is still returned', async () => {
    const deps = makeDeps({
      catalogue: catalogueOf(['tariff']),
      notes: { 'wiki/tariff.md': note({ title: 'Tariff' }) },
    });
    const pack = await getWikiContextPack(makeRegistry(), { query: QUERY, asOf: TODAY }, deps);
    const page = pack.primaryPages.find((p) => p.path === 'wiki/tariff.md');
    assert.equal('validity' in page, false);
    assert.equal('validityUnverified' in page, false);
  });

  test('NOTHING IS EVER FILTERED OUT for its window — decision D6', async () => {
    // The pack annotates; it does not choose. An expired page is exactly as
    // present as a current one.
    const deps = makeDeps({
      catalogue: catalogueOf(['tariff', 'tariff-old', 'tariff-future']),
      notes: {
        'wiki/tariff.md': note({ title: 'A', valid_from: '2026-01-01' }),
        'wiki/tariff-old.md': note({ title: 'B', valid_through: '2020-01-01' }),
        'wiki/tariff-future.md': note({ title: 'C', valid_from: '2099-01-01' }),
      },
    });
    const pack = await getWikiContextPack(makeRegistry(), { query: QUERY, asOf: TODAY }, deps);
    assert.equal(pack.primaryPages.length, 3, 'all three are in the envelope');
    const states = pack.primaryPages.map((p) => p.validity.state).sort();
    assert.deepEqual(states, ['in-force', 'no-longer-in-force', 'not-yet-in-force']);
  });
});

// ---------------------------------------------------------------------------
describe('one read door — the property the envelope cannot show', () => {
  test('A PAGE NAMED BY THREE COLLECTIONS IS READ ONCE', async () => {
    // The exit criterion, stated as a count. `tariff` is a primary page, the
    // target of a wikilink from another primary page, and the path of a
    // semantic chunk. Before the context existed, that was three round trips
    // for one page — and the drill's read could not have been deduplicated
    // afterwards, because it had already left.
    const deps = makeDeps({
      catalogue: catalogueOf(['tariff', 'hub']),
      notes: {
        'wiki/tariff.md': note({ title: 'Tariff', valid_through: '2025-12-31' }),
        'wiki/hub.md': note({ title: 'Hub' }, '# Hub\n\nThe archive storage tariff: see [[tariff]].\n'),
      },
      chunks: [{ path: 'wiki/tariff.md', text: 'archive storage tariff excerpt', score: 0.9 }],
    });
    const pack = await getWikiContextPack(makeRegistry(), { query: QUERY, asOf: TODAY }, deps);

    assert.equal(deps.countFor('wiki/tariff.md'), 1, 'one read, three consumers');
    assert.equal(pack.validitySummary.inspectedPages, 2, 'tariff and hub');

    // And all three surfaces still got the annotation.
    const primary = pack.primaryPages.find((p) => p.path === 'wiki/tariff.md');
    assert.equal(primary.validity.state, 'no-longer-in-force');
    const chunk = pack.semanticChunks.find((c) => c.path === 'wiki/tariff.md');
    assert.equal(chunk.validity.state, 'no-longer-in-force');
  });

  test('a wikilink neighbour is resolved by two spellings, and counted as one page', async () => {
    const deps = makeDeps({
      catalogue: catalogueOf(['hub']),
      notes: {
        'wiki/hub.md': note({ title: 'Hub' }, '# Hub\n\nThe archive storage tariff: see [[rootpage]].\n'),
        'rootpage.md': note({ title: 'Root', valid_from: '2099-01-01' }),
      },
    });
    const pack = await getWikiContextPack(makeRegistry(), { query: QUERY, asOf: TODAY }, deps);

    const neighbour = pack.graphNeighbors.find((n) => n.path === 'rootpage.md');
    assert.equal(neighbour.validity.state, 'not-yet-in-force', 'found on the fallback spelling');
    assert.equal(deps.countFor('wiki/rootpage.md'), 1, 'the first spelling was tried once');
    assert.equal(deps.countFor('rootpage.md'), 1, 'and the second answered');
    assert.equal(pack.validitySummary.unverifiedPages, 0, 'one page, read — not one probe failed');
  });

  test('a page the drill could not read is marked, never silently undated', async () => {
    // A dead catalogue link already produces a placeholder. The placeholder now
    // says the window could not be established either, rather than looking like
    // a page that simply declares nothing.
    const deps = makeDeps({ catalogue: catalogueOf(['ghost']), notes: {} });
    const pack = await getWikiContextPack(makeRegistry(), { query: QUERY, asOf: TODAY }, deps);

    const placeholder = pack.primaryPages.find((p) => /ghost/.test(p.path));
    assert.ok(placeholder, 'the gap is still shown');
    assert.equal(placeholder.validityUnverified, true);
    assert.equal('validity' in placeholder, false);
  });

  test('and a dead link tried under two spellings is ONE unverified page', async () => {
    const deps = makeDeps({ catalogue: catalogueOf(['ghost']), notes: {} });
    const pack = await getWikiContextPack(makeRegistry(), { query: QUERY, asOf: TODAY }, deps);
    assert.equal(deps.calls.filter((c) => /ghost/.test(c)).length, 2, 'both spellings were really tried');
    assert.equal(pack.validitySummary.unverifiedPages, 1, 'but that is one page, not two');
  });

  test('the placeholder does NOT send the annotator after the page again', async () => {
    // Handing a placeholder's path to the annotator would chase a file the
    // drill has already proved unreadable, under a spelling it never tried.
    const deps = makeDeps({ catalogue: catalogueOf(['ghost']), notes: {} });
    await getWikiContextPack(makeRegistry(), { query: QUERY, asOf: TODAY }, deps);
    assert.equal(deps.calls.length, 2, 'exactly the drill\'s two attempts, and no third');
  });

  test('THE THIRD SPELLING — a placeholder keeps the PRE-canonical path, and it differs', async () => {
    // The witness the first version of this file was missing, found by mutating
    // the guard away and watching every test stay green.
    //
    // The placeholder is built from `candidateToVaultPath(label)`, but the drill
    // tries `canonicalVaultPath(...)` of that. For an ordinary label the two are
    // the same string, so removing the guard changed nothing and no test noticed.
    // A label that canonicalisation REWRITES — here a leading slash — separates
    // them: the placeholder says `/ghost.md` while the drill tried `wiki/ghost.md`
    // and `ghost.md`. Without the guard the annotator goes after a third
    // spelling of a page already proved dead.
    const deps = makeDeps({ catalogue: catalogueOf(['/ghost']), notes: {} });
    const pack = await getWikiContextPack(makeRegistry(), { query: QUERY, asOf: TODAY }, deps);

    const placeholder = pack.primaryPages.find((p) => /ghost/.test(p.path));
    assert.ok(placeholder, 'the catalogue entry produced a placeholder');
    assert.equal(placeholder.validityUnverified, true);

    assert.deepEqual(deps.calls, ['wiki/ghost.md', 'ghost.md'],
      'the drill\'s two attempts, and NOT a third under the placeholder\'s own spelling');
    assert.equal(pack.validitySummary.unverifiedPages, 1, 'still one page, not two');
  });
});

// ---------------------------------------------------------------------------
describe('the quotas — declared, separate, and reported when reached', () => {
  test('the neighbour ceiling is a named constant, not a magic number', () => {
    assert.equal(NEIGHBOR_VALIDITY_READS, 50);
    assert.equal(COLLECTION_PRIMARY, 'primaryPages');
    assert.equal(COLLECTION_CHUNKS, 'semanticChunks');
    assert.equal(COLLECTION_NEIGHBORS, 'graphNeighbors');
  });

  test('beyond the neighbour ceiling, entries are KEPT, marked, and the summary says so', async () => {
    // `graphNeighbors[]` has no cap of its own — every wikilink of every primary
    // page lands in it. Annotating without a ceiling would let one densely
    // linked page turn a context pack into hundreds of reads.
    const links = Array.from({ length: NEIGHBOR_VALIDITY_READS + 5 }, (_, i) => `[[n${i}]]`).join(' ');
    const notes = { 'wiki/hub.md': note({ title: 'Hub' }, `# Hub\n\nThe archive storage tariff: ${links}\n`) };
    for (let i = 0; i < NEIGHBOR_VALIDITY_READS + 5; i += 1) {
      notes[`wiki/n${i}.md`] = note({ valid_through: '2025-12-31' });
    }
    const deps = makeDeps({ catalogue: catalogueOf(['hub']), notes });
    const pack = await getWikiContextPack(makeRegistry(), { query: QUERY, asOf: TODAY }, deps);

    assert.equal(pack.graphNeighbors.length, NEIGHBOR_VALIDITY_READS + 5, 'every neighbour is still there');
    const annotated = pack.graphNeighbors.filter((n) => n.validity).length;
    const marked = pack.graphNeighbors.filter((n) => n.validityUnverified).length;
    assert.equal(annotated, NEIGHBOR_VALIDITY_READS);
    assert.equal(marked, 5, 'the rest say they could not be verified — they are not silently undated');
    assert.equal(pack.validitySummary.budgetExhausted, true);

    const neighbourReads = deps.calls.filter((c) => /\/n\d+\.md$/.test(c)).length;
    assert.equal(neighbourReads, NEIGHBOR_VALIDITY_READS, 'and no read was spent past the ceiling');
  });

  test('the chunk quota is the caller\'s effective cap, so every chunk returned is annotatable', async () => {
    const chunks = Array.from({ length: 4 }, (_, i) => ({
      path: `wiki/c${i}.md`, text: 'archive storage tariff', score: 1 - i / 10,
    }));
    const notes = { 'wiki/hub.md': note({ title: 'Hub' }) };
    for (let i = 0; i < 4; i += 1) notes[`wiki/c${i}.md`] = note({ valid_through: '2025-12-31' });

    const deps = makeDeps({ catalogue: catalogueOf(['hub']), notes, chunks });
    const pack = await getWikiContextPack(
      makeRegistry(), { query: QUERY, asOf: TODAY, maxSemanticChunks: 2 }, deps,
    );

    assert.equal(pack.semanticChunks.length, 2, 'the cap applies to the array as before');
    assert.equal(pack.semanticChunks.every((c) => c.validity), true, 'and every returned chunk is annotated');
    assert.equal(pack.validitySummary.budgetExhausted, false, 'the quota matched the cut — nothing was refused');
  });

  test('a chunk carrying no path is marked, and counted as no page', async () => {
    const deps = makeDeps({
      catalogue: catalogueOf(['hub']),
      notes: { 'wiki/hub.md': note({ title: 'Hub' }) },
      chunks: [{ text: 'archive storage tariff with no path at all', score: 0.5 }],
    });
    const pack = await getWikiContextPack(makeRegistry(), { query: QUERY, asOf: TODAY }, deps);
    assert.equal(pack.semanticChunks.length, 1);
    assert.equal(pack.semanticChunks[0].validityUnverified, true);
    assert.equal(pack.validitySummary.unverifiedPages, 0, 'no page was named, so no page went unverified');
  });

  test('a chunk whose page vanished between index and read is marked, never dropped', async () => {
    const deps = makeDeps({
      catalogue: catalogueOf(['hub']),
      notes: { 'wiki/hub.md': note({ title: 'Hub' }) },
      chunks: [{ path: 'wiki/deleted.md', text: 'archive storage tariff', score: 0.9 }],
    });
    const pack = await getWikiContextPack(makeRegistry(), { query: QUERY, asOf: TODAY }, deps);
    assert.equal(pack.semanticChunks.length, 1, 'the hit stays — invariant 3');
    assert.equal(pack.semanticChunks[0].validityUnverified, true);
    assert.equal(pack.validitySummary.unverifiedPages, 1);
  });
});

// ---------------------------------------------------------------------------
describe('the requirement phase 4a inherited, end to end', () => {
  test('a bound holding a BLOCK reaches the helper intact, and reads UNREADABLE', async () => {
    // Measured on 2026-09-11: Obsidian hands this over as an object. The
    // router's line parser flattens it to an empty string, which normalises to
    // absent, so the page would read as a tidy open-ended window IN FORCE — a
    // confident wrong answer about a malformed page. The whole read path must
    // carry the object through untouched.
    const deps = makeDeps({
      catalogue: catalogueOf(['tariff']),
      notes: {
        'wiki/tariff.md': note({
          title: 'Tariff', valid_from: { date: '2026-01-01' }, valid_through: '2026-12-31',
        }),
      },
    });
    const pack = await getWikiContextPack(makeRegistry(), { query: QUERY, asOf: TODAY }, deps);
    const page = pack.primaryPages.find((p) => p.path === 'wiki/tariff.md');
    assert.equal(page.validity.state, 'unreadable',
      'if this says in-force, something on the read path flattened the bound');
    assert.deepEqual(page.validity.problems, ['valid_from:not-a-string']);
  });

  test('a window nested under a parent declares nothing, and the page stays silent', async () => {
    const deps = makeDeps({
      catalogue: catalogueOf(['tariff']),
      notes: { 'wiki/tariff.md': note({ title: 'Tariff', validity: { valid_from: '2099-01-01' } }) },
    });
    const pack = await getWikiContextPack(makeRegistry(), { query: QUERY, asOf: TODAY }, deps);
    const page = pack.primaryPages.find((p) => p.path === 'wiki/tariff.md');
    assert.equal('validity' in page, false, 'top level only — a nested key is not a declaration');
  });
});

// ---------------------------------------------------------------------------
describe('the dependence on the helper is OBSERVABLE from the tool', () => {
  async function stateOf(frontmatter) {
    const deps = makeDeps({
      catalogue: catalogueOf(['tariff']),
      notes: { 'wiki/tariff.md': note({ title: 'Tariff', ...frontmatter }) },
    });
    const pack = await getWikiContextPack(makeRegistry(), { query: QUERY, asOf: TODAY }, deps);
    return pack.primaryPages.find((p) => p.path === 'wiki/tariff.md')?.validity?.state ?? null;
  }

  test('a window ending today is in force — the end bound is included', async () => {
    assert.equal(await stateOf({ valid_from: '2026-01-01', valid_through: TODAY }), 'in-force');
  });

  test('a window starting today is in force — the start bound is included', async () => {
    assert.equal(await stateOf({ valid_from: TODAY }), 'in-force');
  });

  test('an inverted window is unreadable, never a future one', async () => {
    assert.equal(await stateOf({ valid_from: '2099-01-01', valid_through: '2020-01-01' }), 'unreadable');
  });
});

// ---------------------------------------------------------------------------
describe('a semantic chunk names a BLOCK, and its window is its page\'s', () => {
  // Roadmap phase 4c.3, swept back onto the 4a site. Smart Connections
  // addresses a chunk as `Page.md#Heading#{1}`, which is not a file: handed to
  // `getNote` it is a 404, so every chunk of the pack came back
  // `validityUnverified` on a real vault. Measured on TradingView, 2026-09-15.
  const PAGE = 'wiki/modules.md';
  const BLOCK = `${PAGE}#Modules — comment l'indicateur fonctionne#L'idée en une phrase#{1}`;

  const packWith = (chunks, notes) => getWikiContextPack(
    makeRegistry(),
    { query: QUERY, asOf: TODAY },
    makeDeps({ catalogue: catalogueOf(['tariff']), notes, chunks }),
  );

  test('the chunk carries its page window instead of being unverifiable', async () => {
    const deps = makeDeps({
      catalogue: catalogueOf(['tariff']),
      notes: {
        'wiki/tariff.md': note({}),
        [PAGE]: note({ valid_through: '2025-12-31' }),
      },
      chunks: [{ path: BLOCK, text: 'un extrait', score: 0.9 }],
    });
    const pack = await getWikiContextPack(makeRegistry(), { query: QUERY, asOf: TODAY }, deps);
    const chunk = pack.semanticChunks[0];
    assert.equal(chunk.path, BLOCK, 'the chunk keeps its own anchored path');
    assert.equal(chunk.validity?.state, 'no-longer-in-force');
    assert.equal(chunk.validityUnverified, undefined);
    assert.equal(deps.countFor(PAGE), 1, 'one read, of the page');
    assert.equal(deps.countFor(BLOCK), 0, 'and no probe at the block key');
  });

  test('several chunks of one page are read once and counted once', async () => {
    const deps = makeDeps({
      catalogue: catalogueOf(['tariff']),
      notes: { 'wiki/tariff.md': note({}), [PAGE]: note({ valid_from: '2026-01-01' }) },
      chunks: Array.from({ length: 6 }, (_, i) => ({
        path: `${PAGE}#Section ${i}#{${i}}`, text: `extrait ${i}`, score: 1 - i / 100,
      })),
    });
    const pack = await getWikiContextPack(makeRegistry(), { query: QUERY, asOf: TODAY }, deps);
    assert.equal(deps.countFor(PAGE), 1);
    assert.equal(pack.semanticChunks.length, 6);
    assert.equal(pack.semanticChunks.every((c) => c.validity?.state === 'in-force'), true);
  });

  test('the PAGE IDENTITY is what the quota buys — not the block key', async () => {
    // Round 3 asked whether a wrong `pageOf` alone was observable here. It is,
    // through the quota: six blocks of one page are ONE page, so a quota of one
    // covers them. If the identity were the block key they would be six pages,
    // five would be refused for budget, and the pack would report five chunks
    // unverified while the page had been read. That is exactly the defect the
    // phase-4b measurement found on the real vault, in its other form.
    const deps = makeDeps({
      catalogue: catalogueOf(['tariff']),
      notes: { 'wiki/tariff.md': note({}), [PAGE]: note({ valid_from: '2026-01-01' }) },
      chunks: Array.from({ length: 6 }, (_, i) => ({
        path: `${PAGE}#Section ${i}#{${i}}`, text: `extrait ${i}`, score: 1 - i / 100,
      })),
    });
    const pack = await getWikiContextPack(
      makeRegistry(), { query: QUERY, asOf: TODAY, chunkLimit: 6 }, deps,
    );
    assert.equal(pack.semanticChunks.length, 6);
    assert.equal(
      pack.semanticChunks.filter((c) => c.validityUnverified).length, 0,
      'no chunk was refused for a budget the page had already paid',
    );
    assert.equal(pack.validitySummary.budgetExhausted, false);
    assert.equal(pack.validitySummary.inspectedPages, 2, 'the catalogue page and the chunk page');
  });

  test('a pathless chunk is still marked, and still names no page', async () => {
    // The branch the repair must not have eaten: no candidates at all is not
    // the same as a candidate that failed.
    const pack = await packWith(
      [{ path: '', text: 'un extrait sans chemin', score: 0.9 }],
      { 'wiki/tariff.md': note({}) },
    );
    assert.equal(pack.semanticChunks[0].validityUnverified, true);
    assert.equal(pack.semanticChunks[0].validity, undefined);
  });
});
