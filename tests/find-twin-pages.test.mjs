/**
 * find_twin_pages — the I/O shell around `findTwinPages` (C11).
 *
 * The maths is pinned in twin-pages.test.mjs and the store reader in
 * smart-env-embeddings.test.mjs. Here the whole path runs against a REAL vault
 * written to a real temp directory: the real store reader, the real wiki walk,
 * the real frontmatter parse, the real projection rule. Nothing is stubbed,
 * because the exclusions this shell performs are exactly the part a stub would
 * hide — and one of them (unavailability) has to be observed at the WIRE, after
 * the router's normalization boundary, not before it.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  TOOL_NAME,
  TOOL_DEFINITION,
  findTwinPagesTool,
  UNAVAILABLE,
} from '../src/tools/find-twin-pages.mjs';
import {
  SIGNAL_NOT_ORDER,
  SENSITIVITY_K,
  UNAVAILABLE_REASONS,
  UNAVAILABLE_RESPONSE_REASONS,
} from '../src/helpers/twin-pages.mjs';
import { INDEX_SNAPSHOT_CAVEAT } from '../src/helpers/smart-env-embeddings.mjs';
import { projectionMarkerLine } from '../src/helpers/okf-projections.mjs';
import { _internals as ROUTER } from '../src/index.mjs';

const MODEL = 'TaylorAI/bge-micro-v2';

// --- deterministic vectors, same construction as twin-pages.test.mjs --------
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function vec(seed, dims = 16, shared = 0.55) {
  const rand = lcg(seed);
  const v = [];
  for (let i = 0; i < dims; i += 1) v.push(shared * Math.sin(i) + (rand() - 0.5));
  return v;
}

const TWIN_A = 'wiki/alpha/router-setup.md';
const TWIN_B = 'wiki/beta/setting-up-the-router.md';

/**
 * Write a throwaway vault. `mkdtempSync` in the OS temp dir — a fixture never
 * needs a real vault path to prove a property about vaults.
 */
function makeVault(spec = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c11-vault-'));
  const write = (rel, content) => {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  };

  const records = [];
  const addVector = (rel, v) => records.push(
    `${JSON.stringify(`smart_sources:${rel}`)}: ${JSON.stringify({
      path: rel, class_name: 'SmartSource', embeddings: { [MODEL]: { vec: v } },
    })},`,
  );

  // 12 unrelated pages.
  for (let i = 0; i < 12; i += 1) {
    const rel = `wiki/topic-${String(i).padStart(2, '0')}.md`;
    write(rel, `---\ntype: reference\n---\n\n# Topic ${i}\n\nSome prose. [[hub-${i % 3}]]\n`);
    addVector(rel, vec(1000 + i * 7919));
  }

  // The twins: different folders, no link between them.
  //
  // `isolatedTwins` is the case §2.17 names as the one a folder/link bound
  // loses: born in two sessions, so they share NO folder, NO link to each
  // other, and NO outgoing link in common. The default fixture keeps one shared
  // hub link instead, because that is what pins `sharedLinks` counting.
  if (spec.twins !== false) {
    const base = vec(424242);
    const [la, lb] = spec.isolatedTwins ? ['[[hub-alpha-only]]', '[[hub-beta-only]]'] : ['[[hub-0]]', '[[hub-0]]'];
    write(TWIN_A, `---\ntype: reference\n---\n\n# Router setup\n\nHow to set the router up. ${la}\n`);
    addVector(TWIN_A, base);
    write(TWIN_B, `---\ntype: reference\n---\n\n# Setting up the router\n\nThe same, written again. ${lb}\n`);
    addVector(TWIN_B, base.map((x, i) => x + (i % 5 === 0 ? 0.004 : -0.003)));
  }

  // A GHOST: indexed, but the page is gone from disk.
  if (spec.ghost !== false) addVector('wiki/deleted/old-router-setup.md', vec(424242));

  // GENERATED NAVIGATION: an index carrying the projection marker, plus a
  // second one that is a projection by PATH alone.
  if (spec.projections !== false) {
    const idx = `---\nokf_version: '0.1'\n---\n\n# Index\n\n${projectionMarkerLine()}\n\n* [a](a.md)\n`;
    write('wiki/index.md', idx);
    addVector('wiki/index.md', vec(555));
    write('wiki/alpha/index.md', idx);
    addVector('wiki/alpha/index.md', vec(555).map((x) => x + 0.001));
    // A projection recognisable BY PATH ALONE — the reserved `index.md`
    // basename, with no marker line. Without it the path rule was redundant
    // with the marker rule and a mutation that removed it left every test
    // green, which is a test suite claiming a guard it was not checking.
    write('wiki/beta/index.md', '# Beta\n\n* [x](x.md)\n');
    addVector('wiki/beta/index.md', vec(555).map((x) => x + 0.002));

    // …and the SYMMETRIC case, which was missing: two generated files carrying
    // the marker but NOT named `index.md`/`log.md`, so ONLY the marker rule can
    // catch them. Every projection fixture used to be called `index.md`, so the
    // path rule caught all three and the marker rule never decided anything —
    // deleting it left the suite green while the comment claimed it was tested.
    // Their vectors are near-identical, so if the marker rule stops firing they
    // do not merely change a count: they surface as a top-scoring pair.
    const genBase = vec(9090);
    write('wiki/Divers/generated-digest-a.md', `# A\n\n${projectionMarkerLine()}\n\n* [a](a.md)\n`);
    addVector('wiki/Divers/generated-digest-a.md', genBase);
    write('wiki/Divers/generated-digest-b.md', `# B\n\n${projectionMarkerLine()}\n\n* [b](b.md)\n`);
    addVector('wiki/Divers/generated-digest-b.md', genBase.map((x) => x + 0.001));
  }

  // A MIGRATION STUB PAIR: identical boilerplate, thin BY DESIGN.
  if (spec.redirects !== false) {
    const stub = (t) => `---\ntype: redirect\n---\n\n# Moved\n\nThis page moved to [[${t}]].\n`;
    write('wiki/_migrated/one.md', stub('one'));
    write('wiki/_migrated/two.md', stub('two'));
    addVector('wiki/_migrated/one.md', vec(777));
    addVector('wiki/_migrated/two.md', vec(777).map((x) => x + 0.0005));
  }

  // A page on disk that the last indexing pass never saw.
  if (spec.unembedded !== false) write('wiki/brand-new.md', '---\ntype: reference\n---\n\n# New\n');

  if (spec.embeddings !== false) {
    write('.smart-env/multi/store.ajson', `${records.join('\n')}\n`);
  }
  return root;
}

const vaults = [];
function vaultAt(spec) {
  const root = makeVault(spec);
  vaults.push(root);
  return { name: 'fixture-vault', type: 'local', path: root };
}
function registryFor(vault) {
  return { resolveVault: () => vault };
}

after(() => {
  for (const v of vaults) {
    try { fs.rmSync(v, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function hasPair(result, a, b) {
  return (result.pairs || []).some((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a));
}

// ---------------------------------------------------------------------------

describe('find_twin_pages — end to end on a real vault', () => {
  test('THE TWO QUASI-IDENTICAL PAGES ARE FLAGGED, and nothing else is', async () => {
    const result = await findTwinPagesTool(registryFor(vaultAt({})), {});
    assert.equal(result.available, true);
    assert.ok(hasPair(result, TWIN_A, TWIN_B), 'the near-identical pair must be reported');
    assert.equal(result.found, 1, 'and it must be the only one');
    assert.ok(result.pairs[0].similarity >= result.threshold.similarity);

    // The provenance the answer must carry to be auditable.
    assert.equal(result.source.kind, 'smart-connections');
    assert.equal(result.source.model, MODEL);
    assert.equal(result.source.dimensions, 16);
    assert.equal(result.threshold.sensitivity, SENSITIVITY_K);
    assert.equal(result.threshold.pairsSampled, result.corpus.pairs);
    assert.equal(result.note, SIGNAL_NOT_ORDER);
  });

  test('a distinct pair is not flagged', async () => {
    const result = await findTwinPagesTool(registryFor(vaultAt({})), { limit: 50 });
    for (const row of result.pairs) {
      assert.ok(
        (row.a === TWIN_A && row.b === TWIN_B) || (row.a === TWIN_B && row.b === TWIN_A),
        `unexpected pair: ${row.a} | ${row.b} at ${row.similarity}`,
      );
    }
    assert.ok(!hasPair(result, 'wiki/topic-00.md', 'wiki/topic-01.md'));
  });

  test('every exclusion is APPLIED and COUNTED', async () => {
    const result = await findTwinPagesTool(registryFor(vaultAt({})), { limit: 50 });

    // A ghost: the store still knows it, disk does not. Comparing it would
    // resurrect a page's own deleted predecessor and report it as its twin.
    assert.equal(result.excluded.notOnDisk, 1);
    assert.ok(
      !result.pairs.some((p) => p.a.includes('deleted/') || p.b.includes('deleted/')),
      'a page that no longer exists must never appear in a pair',
    );

    // Generated navigation, caught by BOTH rules independently: three files
    // named `index.md` (two markered, one recognised by the reserved basename
    // alone) plus two markered files whose names are ordinary — those last two
    // can ONLY be caught by the marker rule.
    assert.equal(result.excluded.generatedNavigation, 5);
    assert.ok(!result.pairs.some((p) => p.a.endsWith('/index.md') || p.b.endsWith('/index.md')));
    assert.ok(
      !result.pairs.some((p) => p.a.includes('generated-digest') || p.b.includes('generated-digest')),
      'the two markered non-reserved files are near-identical: if the marker rule stops firing '
      + 'they surface as a top-scoring pair, not merely as a changed count',
    );

    // Migration stubs: identical boilerplate, sameness by design.
    assert.deepEqual(result.excluded.byType, { redirect: 2 });
    assert.ok(!result.pairs.some((p) => p.a.includes('_migrated/') || p.b.includes('_migrated/')));

    // A page the last indexing pass never saw.
    assert.equal(result.excluded.withoutVector, 1);

    // The corpus is what is left, and it adds up.
    assert.equal(result.corpus.pages, 14, '12 topics + 2 twins');
    assert.equal(result.wikiPagesOnDisk, 22);
  });

  test('turning an exclusion off changes the answer — the counters are not decoration', async () => {
    const v = vaultAt({});
    const withStubs = await findTwinPagesTool(registryFor(v), { exemptTypes: [], limit: 50 });
    assert.deepEqual(withStubs.excluded.byType, {});
    assert.equal(withStubs.corpus.pages, 16);
    assert.ok(
      withStubs.pairs.some((p) => p.a.includes('_migrated/') && p.b.includes('_migrated/')),
      'with the exemption lifted, the identical stubs surface — which is why it is on by default',
    );
  });

  test('folders narrows the corpus AND the distribution the cut comes from', async () => {
    const v = vaultAt({});
    const all = await findTwinPagesTool(registryFor(v), {});
    const scoped = await findTwinPagesTool(registryFor(v), { folders: ['wiki/alpha', 'wiki/beta'] });
    assert.ok(scoped.excluded.outsideFolders > 0);
    assert.ok(scoped.corpus.pages < all.corpus.pages);
    // Two pages is below the sample a median+MAD needs: the honest answer is
    // "not answered", not "no twins".
    assert.equal(scoped.available, false);
    assert.equal(Object.prototype.hasOwnProperty.call(scoped, 'pairs'), false);
  });

  test('THE §2.17 CASE: twins sharing no folder, no link and no common outlink are found BY DEFAULT', async () => {
    // "deux vrais jumeaux nés dans deux sessions sont PRÉCISÉMENT ceux qui
    // risquent de ne partager ni dossier ni lien" — so the default must not
    // bound the combinatorics, or this pair is exactly what gets lost.
    const v = vaultAt({ isolatedTwins: true });
    const result = await findTwinPagesTool(registryFor(v), { limit: 50 });

    assert.equal(result.available, true);
    assert.equal(result.restrictTo, 'none', 'the DEFAULT must be unbounded');
    assert.ok(hasPair(result, TWIN_A, TWIN_B), 'the cross-folder, unlinked twins must be reported');

    const row = result.pairs.find((p) => p.a === TWIN_A || p.b === TWIN_A);
    assert.equal(row.sameFolder, false, 'different folders');
    assert.equal(row.sharedLinks, 0, 'no outgoing link in common');
    assert.equal(row.linked, false, 'neither links to the other');
    assert.equal(row.sameBasename, false, 'and not even the same filename');

    // The hardest background negative is genuinely closer than the rest, so the
    // pair is not winning by default in a field of near-orthogonal noise.
    const others = result.pairs.filter((p) => p !== row);
    assert.equal(others.length, 0, 'and it is the only pair above the derived threshold');

    // And the bound the spec proposed WOULD have lost it — measured here, not asserted from memory.
    const bounded = await findTwinPagesTool(registryFor(v), { limit: 50, restrictTo: 'folder-or-links' });
    assert.equal(bounded.found, 0, 'the folder-or-links bound discards precisely this pair');
    assert.equal(bounded.removedByRestriction, 1, 'and says so');
  });

  test('the row evidence is computed from the real page bodies', async () => {
    const result = await findTwinPagesTool(registryFor(vaultAt({})), {});
    const row = result.pairs[0];
    assert.equal(row.sameFolder, false, 'the twins live in wiki/alpha and wiki/beta');
    assert.equal(row.sameBasename, false);
    assert.equal(row.sharedLinks, 1, 'both bodies link [[hub-0]]');
    assert.equal(row.linked, false, 'neither links to the other — the shape §2.17 warns about');
  });
});

// ---------------------------------------------------------------------------
// The one that matters most: unavailable is a DIFFERENT ANSWER from zero.
// ---------------------------------------------------------------------------

describe('find_twin_pages — "unavailable here" is not "zero pairs"', () => {
  test('NO EMBEDDINGS → available:false with a reason, and NO pairs key at all', async () => {
    const result = await findTwinPagesTool(registryFor(vaultAt({ embeddings: false })), {});
    assert.equal(result.available, false);
    assert.equal(result.reason, UNAVAILABLE.NO_EMBEDDINGS);
    assert.equal(result.storeReason, 'store-missing');
    assert.equal(
      Object.prototype.hasOwnProperty.call(result, 'pairs'), false,
      'an empty pairs array here would let a consumer reading `pairs.length` report '
      + '"no twins found" for a vault that was never examined',
    );
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'found'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'threshold'), false);
    assert.match(result.detail, /NOT a finding/i);
    assert.match(result.detail, /smart-connections/i, 'and it must say what would make it available');
  });

  test('A REMOTE VAULT → its own reason, still no pairs key', async () => {
    const registry = { resolveVault: () => ({ name: 'remote', type: 'remote' }) };
    const result = await findTwinPagesTool(registry, {});
    assert.equal(result.available, false);
    assert.equal(result.reason, UNAVAILABLE.REMOTE_VAULT);
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'pairs'), false);
    assert.match(result.detail, /NOT a finding/i);
  });

  test('A VAULT WITH EMBEDDINGS AND NO TWINS → available:true, found:0, pairs:[]', async () => {
    const result = await findTwinPagesTool(
      registryFor(vaultAt({ twins: false, ghost: false, projections: false, redirects: false })), {},
    );
    assert.equal(result.available, true, 'this vault WAS examined');
    assert.equal(result.found, 0);
    assert.deepEqual(result.pairs, []);
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'pairs'), true);
    assert.ok(result.threshold.similarity > 0, 'a cut was derived and can be shown');
  });

  test('THE DISCRIMINATOR SURVIVES THE WIRE — checked after wrapResult, not before', async () => {
    // A guard observed only inside the tool is a guard blind to whatever the
    // router does to the payload afterwards. `wrapResult` is the single
    // normalization boundary every response crosses (v0.71.0), so the contract
    // is asserted on the bytes a client actually receives.
    const unavailable = await ROUTER.wrapResult(
      findTwinPagesTool(registryFor(vaultAt({ embeddings: false })), {}),
    );
    const zero = await ROUTER.wrapResult(
      findTwinPagesTool(
        registryFor(vaultAt({ twins: false, ghost: false, projections: false, redirects: false })), {},
      ),
    );

    const u = JSON.parse(unavailable.content[0].text);
    const z = JSON.parse(zero.content[0].text);

    assert.equal(u.available, false);
    assert.equal('pairs' in u, false, 'the unavailable answer must reach the client WITHOUT a pairs key');
    assert.equal(z.available, true);
    assert.equal('pairs' in z, true);
    assert.deepEqual(z.pairs, []);
    assert.notEqual('pairs' in u, 'pairs' in z, 'the two answers must remain distinguishable at the wire');

    // And the note travels with both, so no client ever renders a pair without it.
    assert.equal(u.note, SIGNAL_NOT_ORDER);
    assert.equal(z.note, SIGNAL_NOT_ORDER);
  });
});

describe('find_twin_pages — what the answer admits about itself', () => {
  test('FRESHNESS: every ranking says its vectors are an index snapshot', async () => {
    const result = await findTwinPagesTool(registryFor(vaultAt({})), {});
    assert.equal(result.available, true);
    assert.equal(result.freshness.basis, 'index-snapshot');
    assert.equal(
      result.freshness.perPageStaleness, 'unknown',
      'per-page staleness is UNKNOWN, not "fresh" — the store keeps no hash the router can recompute',
    );
    assert.equal(result.freshness.caveat, INDEX_SNAPSHOT_CAVEAT, 'one wording, shared with the store reader');
    assert.match(result.freshness.caveat, /snapshot/i);
    assert.match(result.freshness.caveat, /edited since/i);

    // It survives the wire, where a consumer actually reads it.
    const wired = JSON.parse((await ROUTER.wrapResult(
      findTwinPagesTool(registryFor(vaultAt({})), {}),
    )).content[0].text);
    assert.equal(wired.freshness.basis, 'index-snapshot');
    assert.equal(wired.freshness.perPageStaleness, 'unknown');
  });

  test('COVERAGE: "available: true" is never readable as "the whole vault was analysed"', async () => {
    const result = await findTwinPagesTool(registryFor(vaultAt({})), {});
    const c = result.coverage;

    // Numerator and denominator, both present, no arithmetic required.
    assert.equal(c.comparedPages, result.corpus.pages);
    // ALIGNED to the four-term identity. This assertion used to name only
    // `withoutVector`, and it passed on this fixture for the worst possible
    // reason: `incompatibleVector` happens to be 0 here, so the missing term
    // could be deleted from the product with nothing going red. The term is
    // pinned where it is NON-ZERO, in the cohort test below — an identity is
    // only a guard on a fixture that exercises every term in it.
    assert.equal(
      c.eligiblePages, c.comparedPages + c.withoutVector + c.incompatibleVector,
      'eligible = compared + carried-no-vector + carried-an-unusable-vector',
    );
    assert.equal(c.incompatibleVector, 0, 'this fixture has no rejected cohort — see the cohort test');
    assert.ok(c.withoutVector > 0, 'the fixture has an eligible page with no vector, so the gap is real');
    assert.ok(
      c.comparedPages < c.eligiblePages,
      'this fixture must NOT be able to claim full coverage — otherwise the assertion proves nothing',
    );
    assert.ok(c.eligiblePages < c.wikiPagesOnDisk, 'and eligible is itself narrower than what is on disk');
    assert.equal(c.heldOut, result.excluded.generatedNavigation
      + Object.values(result.excluded.byType).reduce((a, b) => a + b, 0)
      + result.excluded.outsideFolders + result.excluded.unreadable);
    assert.ok(Math.abs(c.fraction - c.comparedPages / c.eligiblePages) < 1e-12);

    // The sentence a report can quote verbatim — it must carry BOTH numbers.
    assert.match(c.statement, new RegExp(`\\b${c.comparedPages}\\b`));
    assert.match(c.statement, new RegExp(`\\b${c.eligiblePages}\\b`));
    assert.match(c.statement, new RegExp(`\\b${c.wikiPagesOnDisk}\\b`));
    assert.match(c.statement, / of /);

    // The confusion the field exists to prevent, stated as an assertion: a
    // vault where only a few pages are vectorised must not read as full coverage.
    assert.notEqual(c.fraction, 1, 'a partial index must not report fraction 1');
  });

  test('A VECTOR THAT CANNOT BE COMPARED IS NOT "NO VECTOR" — and the store says which', async () => {
    // Two distinct silences, one channel missing entirely. `mixedDimensions`
    // was COMPUTED by the reader and never copied into the response, so a store
    // split across two dimensionalities of the SAME model lost the minority with
    // nothing to show for it — unlike the multi-model case, which at least had
    // `otherModels`. And the pages of every rejected cohort landed in
    // `withoutVector`, whose sentence then claimed they "carried none" — false,
    // and contradicted by the store two fields away.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c11-cohort-'));
    vaults.push(root);
    const w = (rel, c) => {
      const abs = path.join(root, ...rel.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, c, 'utf8');
    };
    const recs = [];
    const add = (rel, v, model = MODEL) => recs.push(
      `${JSON.stringify(`smart_sources:${rel}`)}: ${JSON.stringify({ embeddings: { [model]: { vec: v } } })},`,
    );
    for (let i = 0; i < 12; i += 1) {
      w(`wiki/p${i}.md`, '---\ntype: reference\n---\n\n# p\n');
      add(`wiki/p${i}.md`, vec(1000 + i * 7919));
    }
    // Minority DIMENSION, same model — the case with no reporting channel.
    for (const n of ['dimA', 'dimB']) {
      w(`wiki/${n}.md`, '---\ntype: reference\n---\n\n# d\n');
      add(`wiki/${n}.md`, new Array(32).fill(0.1));
    }
    // Minority MODEL.
    w('wiki/modA.md', '---\ntype: reference\n---\n\n# m\n');
    add('wiki/modA.md', vec(5), 'SOME-OTHER-MODEL');
    // Zero norm: a vector that exists and can never match anything.
    w('wiki/zero.md', '---\ntype: reference\n---\n\n# z\n');
    add('wiki/zero.md', new Array(16).fill(0));
    // Genuinely un-indexed.
    w('wiki/new.md', '---\ntype: reference\n---\n\n# n\n');
    // An orphaned record keyed with BACKSLASHES — matched neither the `wiki/`
    // prefix test nor any page, so it escaped the orphan count entirely.
    add('wiki\\Ident\\ghost.md', vec(77));
    w('.smart-env/multi/store.ajson', `${recs.join('\n')}\n`);

    const r = await findTwinPagesTool(registryFor({ name: 'c', type: 'local', path: root }), {});
    assert.equal(r.available, true);

    // The dimension cohort now HAS a channel.
    assert.equal(r.source.mixedDimensions, 2, 'the minority dimension must be reportable, like otherModels');
    assert.equal(r.source.zeroNormVectors, 1);
    assert.equal(r.source.otherModels.length, 1);

    // …and the pages are classified apart from "no vector at all".
    assert.equal(r.excluded.incompatibleVector, 4);
    assert.deepEqual(r.excluded.incompatibleByReason, {
      'minority-dimension': 2, 'minority-model': 1, 'zero-norm': 1,
    });
    assert.equal(r.excluded.withoutVector, 1, 'only the genuinely un-indexed page');

    // The sentence must not claim absence for pages that had a vector.
    assert.doesNotMatch(
      r.coverage.statement, /carried none/,
      'a page whose vector sits in a rejected cohort DID carry one',
    );
    assert.match(r.coverage.statement, /could not be compared/);
    assert.match(r.coverage.statement, /minority-dimension/);
    assert.equal(r.coverage.incompatibleVector, 4);

    // The backslash-keyed orphan is counted now.
    assert.equal(r.excluded.notOnDisk, 1, 'a record keyed with backslashes is still an orphan');

    // And the books balance with the new bucket in them.
    assert.equal(
      r.coverage.comparedPages + r.coverage.withoutVector + r.coverage.incompatibleVector + r.coverage.heldOut,
      r.coverage.wikiPagesOnDisk,
    );
    assert.equal(r.coverage.accountsFor, r.coverage.wikiPagesOnDisk);

    // ---- THE DENOMINATOR THE READER ACTUALLY SEES ------------------------
    // `accountsFor` balancing is not enough: it is a separate field, and
    // dropping `incompatibleVector` from `eligiblePages` left it — and the whole
    // suite — green while the DISPLAYED coverage jumped from 12/17 (70.6%) to
    // 12/13 (92.3%). That is a 21.7-point over-report of exactly the kind this
    // check exists to prevent, so `eligiblePages`, `fraction` and the sentence
    // are pinned here, on the one fixture where the term is non-zero.
    const c = r.coverage;
    assert.ok(c.incompatibleVector > 0, 'VACUITY GUARD: this fixture must exercise the term, or the '
      + 'assertions below prove nothing — that is precisely how the gap was introduced');
    assert.equal(c.comparedPages, 12);
    assert.equal(c.withoutVector, 1);
    assert.equal(c.incompatibleVector, 4);
    assert.equal(
      c.eligiblePages, 17,
      'the displayed denominator must count the pages whose vector could not be used; '
      + 'dropping that term reports 13 and over-states coverage',
    );
    assert.ok(
      Math.abs(c.fraction - 12 / 17) < 1e-12,
      `the displayed fraction must be ${(12 / 17).toFixed(4)}, not ${(12 / 13).toFixed(4)} (got ${c.fraction})`,
    );
    assert.ok(c.fraction < 0.75, 'an over-reporting fraction must not be able to pass');
    assert.match(c.statement, /\b12 of 17\b/, 'and the quotable sentence carries the honest denominator');
  });

  test('the STORE diagnostic counts every record it rejected and every file it could not open', async () => {
    const result = await findTwinPagesTool(registryFor(vaultAt({})), {});
    // Present on every ranking, so a store that is quietly half-unread cannot
    // look like a store that was fully read.
    for (const key of ['unreadableFiles', 'unusableRecords', 'malformedLines', 'mixedDimensions', 'zeroNormVectors']) {
      assert.equal(typeof result.source[key], 'number', `source.${key} must always be reported`);
    }
    assert.equal(result.source.unreadableFiles, 0, 'the healthy fixture has nothing unreadable');
  });

  test('an UNAVAILABLE answer carries no coverage or freshness — it compared nothing', async () => {
    const r = await findTwinPagesTool(registryFor(vaultAt({ embeddings: false })), {});
    assert.equal(r.available, false);
    assert.equal(Object.prototype.hasOwnProperty.call(r, 'coverage'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(r, 'freshness'), false);
  });

  test('THE FULL SET of ways this check declines to answer is enumerable, and named', async () => {
    // A caller writing `result.pairs?.length ?? 0` would read EVERY one of
    // these as "no twins". The set is pinned so a seventh way cannot appear
    // undocumented.
    assert.deepEqual(
      Object.values(UNAVAILABLE_REASONS).sort(),
      ['corpus-too-small', 'no-embeddings', 'no-spread', 'too-many-pages'],
    );
    assert.deepEqual(
      Object.values(UNAVAILABLE).sort(),
      ['no-embeddings', 'no-wiki', 'remote-vault'],
    );
    // Response-shaped reasons vs the thrown one.
    assert.equal(UNAVAILABLE_RESPONSE_REASONS.includes('too-many-pages'), false);

    // The thrown refusal really carries its machine-readable name, all the way
    // through the tool's re-wrap (which rebuilt the error from its message and
    // dropped the reason before this was pinned).
    await assert.rejects(
      () => findTwinPagesTool(registryFor(vaultAt({})), { maxPages: 3 }),
      (err) => {
        assert.equal(err.kind, 'validation');
        assert.equal(err.reason, UNAVAILABLE_REASONS.TOO_MANY_PAGES);
        return true;
      },
    );

    // And the tool's own description points the reader at `available`.
    assert.match(TOOL_DEFINITION.description, /BRANCH ON `available`/);
    for (const reason of ['no-embeddings', 'remote-vault', 'no-wiki', 'corpus-too-small', 'no-spread', 'too-many-pages']) {
      assert.ok(
        TOOL_DEFINITION.description.includes(reason),
        `the description does not enumerate \`${reason}\``,
      );
    }
  });
});

describe('find_twin_pages — the tool contract', () => {
  test('is read-only: the vault is byte-identical after a run', async () => {
    const v = vaultAt({});
    const snapshot = (dir) => {
      const out = [];
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else out.push(`${path.relative(dir, p)}:${fs.readFileSync(p, 'utf8').length}`);
        }
      };
      walk(dir);
      return out;
    };
    const before = snapshot(v.path);
    await findTwinPagesTool(registryFor(v), {});
    assert.deepEqual(snapshot(v.path), before);
  });

  test('is not a write tool and is registered exactly once', () => {
    assert.equal(TOOL_NAME, 'find_twin_pages');
    assert.equal(ROUTER.WRITE_TOOL_NAMES.has(TOOL_NAME), false);
    assert.equal(ROUTER.TOOLS.filter((t) => t.name === TOOL_NAME).length, 1);
    assert.equal(typeof ROUTER.TOOL_HANDLERS[TOOL_NAME], 'function');
  });

  test('the description states the threshold is derived, not fixed', () => {
    assert.match(TOOL_DEFINITION.description, /derived/i);
    assert.match(TOOL_DEFINITION.description, /available: false/);
    assert.equal(TOOL_DEFINITION.inputSchema.additionalProperties, false);
  });

  test('two runs over the same vault produce identical bytes', async () => {
    const v = vaultAt({});
    const a = await findTwinPagesTool(registryFor(v), { limit: 50 });
    const b = await findTwinPagesTool(registryFor(v), { limit: 50 });
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });

  test('a corpus over the ceiling refuses with an actionable, one-line message', async () => {
    await assert.rejects(
      () => findTwinPagesTool(registryFor(vaultAt({})), { maxPages: 3 }),
      (err) => {
        assert.equal(err.kind, 'validation');
        assert.doesNotMatch(err.message, /\n/, 'refusals are single-line — a newline can fabricate a status line');
        assert.match(err.message, /folders|maxPages/);
        return true;
      },
    );
  });
});
