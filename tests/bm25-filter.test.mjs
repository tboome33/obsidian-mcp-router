/**
 * Tests for src/helpers/bm25-filter.mjs — the pure BM25 relevance filter behind
 * the filter_relevant_blocks tool and webpage_to_markdown's relevanceQuery.
 * No I/O, no mocks. Run with `npm test`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  segmentBlocks,
  bm25FilterBlocks,
  DEFAULT_THRESHOLD,
  MAX_DROP_FRACTION,
  MIN_SCORED_BLOCKS,
} from '../src/helpers/bm25-filter.mjs';

// A realistic multi-block doc: 1 heading + several on-topic and off-topic paras.
const WG_DOC = [
  '# WireGuard setup',
  '',
  'WireGuard is a fast VPN tunnel using modern cryptography. Configure the wireguard interface with a private key.',
  '',
  'Subscribe to our newsletter for weekly lifestyle tips, recipes, and travel photography inspiration.',
  '',
  'The author enjoys hiking and mountain photography in their spare time on quiet weekends.',
  '',
  'To bring up the wireguard tunnel run wg-quick up wg0 and verify the handshake with wg show.',
].join('\n');

describe('segmentBlocks', () => {
  test('splits prose on blank lines and pulls headings into their own block', () => {
    const blocks = segmentBlocks(WG_DOC);
    assert.equal(blocks[0].type, 'heading');
    assert.equal(blocks[0].text, '# WireGuard setup');
    const prose = blocks.filter((b) => b.type === 'prose');
    assert.equal(prose.length, 4);
  });

  test('a fenced code block is ONE block, internal blank lines included', () => {
    const md = [
      'Intro paragraph.',
      '',
      '```js',
      'const a = 1;',
      '',
      'const b = 2;',
      '```',
      '',
      'Outro paragraph.',
    ].join('\n');
    const blocks = segmentBlocks(md);
    const code = blocks.filter((b) => b.type === 'code');
    assert.equal(code.length, 1);
    assert.match(code[0].text, /const a = 1/);
    assert.match(code[0].text, /const b = 2/);
    // The blank line inside the fence did NOT split it.
    assert.match(code[0].text, /const a = 1;\n\nconst b = 2;/);
  });

  test('leading YAML frontmatter is captured verbatim as one block', () => {
    const md = ['---', 'title: X', 'tags: [a, b]', '---', '', 'Body paragraph here.'].join('\n');
    const blocks = segmentBlocks(md);
    assert.equal(blocks[0].type, 'frontmatter');
    assert.equal(blocks[0].text, '---\ntitle: X\ntags: [a, b]\n---');
  });

  test('#hashtag and 7+ hashes are NOT headings', () => {
    const md = ['#notaheading is a tag', '', '####### seven hashes not a heading'].join('\n');
    const blocks = segmentBlocks(md);
    assert.ok(blocks.every((b) => b.type !== 'heading'));
  });
});

describe('bm25FilterBlocks — relevance', () => {
  test('keeps on-topic blocks, drops off-topic, preserves order + heading', () => {
    const r = bm25FilterBlocks({ markdown: WG_DOC, query: 'wireguard tunnel configuration' });
    assert.equal(r.filtered, true);
    assert.equal(r.stats.scoredBlocks, 4);
    assert.equal(r.stats.kept, 2);
    assert.equal(r.stats.dropped, 2);
    // Heading survives, both wireguard paras survive, in original order.
    assert.match(r.markdown, /# WireGuard setup/);
    assert.match(r.markdown, /fast VPN tunnel/);
    assert.match(r.markdown, /wg-quick up wg0/);
    // Off-topic dropped.
    assert.doesNotMatch(r.markdown, /newsletter/);
    assert.doesNotMatch(r.markdown, /hiking/);
    // Kept blocks are joined by exactly one blank line.
    assert.ok(r.markdown.includes('\n\n'));
  });

  test('includeScores returns per-block raw/normalized/kept', () => {
    const r = bm25FilterBlocks({
      markdown: WG_DOC,
      query: 'wireguard tunnel',
      includeScores: true,
    });
    assert.equal(r.scores.length, 4);
    for (const s of r.scores) {
      assert.ok(typeof s.raw === 'number' && typeof s.normalized === 'number');
      assert.ok(typeof s.kept === 'boolean');
      assert.ok(s.normalized >= 0 && s.normalized <= 1);
    }
    // The top block normalizes to exactly 1.
    assert.ok(r.scores.some((s) => s.normalized === 1));
  });
});

describe('bm25FilterBlocks — guards', () => {
  test('empty / whitespace / sub-3-char query → strict no-op, byte-identical', () => {
    for (const q of ['', '   ', 'a b', '!! ??']) {
      const r = bm25FilterBlocks({ markdown: WG_DOC, query: q });
      assert.equal(r.filtered, false, `query=${JSON.stringify(q)}`);
      assert.equal(r.stats.reason, 'empty-query');
      assert.equal(r.markdown, WG_DOC); // byte-identical
    }
  });

  test('query matching nothing → over-filter-guard, original intact', () => {
    const r = bm25FilterBlocks({ markdown: WG_DOC, query: 'kubernetes helm istio' });
    assert.equal(r.filtered, false);
    assert.equal(r.stats.usedFallback, true);
    assert.equal(r.stats.reason, 'over-filter-guard');
    assert.equal(r.markdown, WG_DOC);
  });

  test('fewer than MIN_SCORED_BLOCKS scored blocks → too-few-blocks no-op', () => {
    const small = ['# H', '', 'wireguard tunnel one.', '', 'wireguard tunnel two.'].join('\n');
    // 2 scored prose blocks < 4.
    const r = bm25FilterBlocks({ markdown: small, query: 'wireguard' });
    assert.ok(r.stats.scoredBlocks < MIN_SCORED_BLOCKS);
    assert.equal(r.filtered, false);
    assert.equal(r.stats.reason, 'too-few-blocks');
    assert.equal(r.markdown, small);
  });

  test('over-filter guard fires above the MAX_DROP_FRACTION threshold', () => {
    // 5 scored blocks, only 1 relevant → would drop 80% > 70%.
    const md = [
      'wireguard tunnel setup here.',
      '',
      'cooking pasta recipes for dinner.',
      '',
      'gardening tips for spring flowers.',
      '',
      'movie reviews and cinema news.',
      '',
      'stock market trends this quarter.',
    ].join('\n');
    const r = bm25FilterBlocks({ markdown: md, query: 'wireguard' });
    assert.equal(r.stats.usedFallback, true);
    assert.equal(r.stats.reason, 'over-filter-guard');
    assert.ok(r.stats.dropFraction > MAX_DROP_FRACTION);
    assert.equal(r.markdown, md);
  });
});

describe('bm25FilterBlocks — structure preservation', () => {
  test('frontmatter and all headings are kept even when their section is dropped', () => {
    const md = [
      '---',
      'title: Doc',
      '---',
      '',
      '## Relevant section',
      '',
      'wireguard tunnel details and configuration steps for the interface.',
      '',
      '## Off-topic section',
      '',
      'a long digression about cooking, gardening, and weekend hiking trips.',
      '',
      'more unrelated prose about photography and travel and lifestyle choices.',
      '',
      'wireguard handshake troubleshooting with wg show and journalctl logs.',
    ].join('\n');
    const r = bm25FilterBlocks({ markdown: md, query: 'wireguard configuration' });
    assert.equal(r.filtered, true);
    assert.match(r.markdown, /^---\ntitle: Doc\n---/);
    // Both headings survive even though the off-topic section body is gone.
    assert.match(r.markdown, /## Relevant section/);
    assert.match(r.markdown, /## Off-topic section/);
    assert.doesNotMatch(r.markdown, /cooking, gardening/);
  });

  test('a code block follows the relevance of the prose that introduces it', () => {
    const md = [
      'To configure the wireguard tunnel, edit wg0.conf as follows:',
      '',
      '```ini',
      '[Interface]',
      'PrivateKey = <key>',
      '```',
      '',
      'Here is a totally unrelated recipe for chocolate chip cookies with butter and sugar.',
      '',
      '```text',
      'mix flour and sugar',
      '```',
      '',
      'Bring up the wireguard interface and check the handshake status regularly.',
    ].join('\n');
    const r = bm25FilterBlocks({ markdown: md, query: 'wireguard tunnel', includeScores: true });
    assert.equal(r.filtered, true);
    // The wireguard config block survives with its intro prose.
    assert.match(r.markdown, /\[Interface\]/);
    // The cookie recipe code block falls with its off-topic intro prose.
    assert.doesNotMatch(r.markdown, /mix flour and sugar/);
  });
});

describe('bm25FilterBlocks — parameters & determinism', () => {
  test('deterministic: same input → identical output twice', () => {
    const a = bm25FilterBlocks({ markdown: WG_DOC, query: 'wireguard tunnel' });
    const b = bm25FilterBlocks({ markdown: WG_DOC, query: 'wireguard tunnel' });
    assert.deepEqual(a, b);
  });

  test('Unicode/French tokens score (no stemming — exact tokens only)', () => {
    const md = [
      "Les équations différentielles décrivent l'évolution des systèmes physiques complexes.",
      '',
      'La recette de cuisine préférée du chef pour le dîner de famille du dimanche.',
      '',
      'Une méthode numérique résout les équations différentielles par discrétisation fine.',
      '',
      'Le paysage montagneux offre une vue imprenable pour les amateurs de randonnée.',
    ].join('\n');
    const r = bm25FilterBlocks({ markdown: md, query: 'équations différentielles' });
    assert.equal(r.filtered, true);
    assert.match(r.markdown, /systèmes physiques/);
    assert.match(r.markdown, /méthode numérique/);
    assert.doesNotMatch(r.markdown, /recette de cuisine/);
  });

  test('default threshold is 0.2 and is reported in stats', () => {
    const r = bm25FilterBlocks({ markdown: WG_DOC, query: 'wireguard' });
    assert.equal(r.stats.threshold, DEFAULT_THRESHOLD);
  });

  test('threshold is clamped into [0,1]; threshold 0 keeps every positive-score block', () => {
    const r = bm25FilterBlocks({ markdown: WG_DOC, query: 'wireguard tunnel', threshold: -5 });
    assert.equal(r.stats.threshold, 0);
  });

  test('BM25 score is numerically pinned: b=0, single hit → final === smoothed IDF', () => {
    // 4 scored blocks, the term "wireguard" present in exactly 1 of them.
    // With b=0 the length-norm term is 1, and for a single hit (f=1):
    //   raw = idf * (1*(k1+1)) / (1 + k1*1) = idf * (k1+1)/(k1+1) = idf.
    // Smoothed IDF (repo formula) with N=4, df=1: log(1 + 4/(1+1)) = log(3).
    const md = [
      'the wireguard interface handles the tunnel.',
      '',
      'cooking pasta recipes for a family dinner.',
      '',
      'gardening tips for spring flowers and herbs.',
      '',
      'movie reviews and cinema news this weekend.',
    ].join('\n');
    const r = bm25FilterBlocks({ markdown: md, query: 'wireguard', b: 0, includeScores: true });
    const hit = r.scores.find((s) => s.index === 0);
    const expectedIdf = Math.log(1 + 4 / (1 + 1)); // = log(3)
    assert.ok(Math.abs(hit.raw - expectedIdf) < 1e-9, `raw=${hit.raw} expected=${expectedIdf}`);
  });

  test('guard boundary: exactly MIN_SCORED_BLOCKS-1 (=3) scored blocks → too-few no-op', () => {
    const md = [
      'wireguard tunnel one details here.',
      '',
      'wireguard tunnel two details here.',
      '',
      'wireguard tunnel three details here.',
    ].join('\n');
    const r = bm25FilterBlocks({ markdown: md, query: 'wireguard' });
    assert.equal(r.stats.scoredBlocks, MIN_SCORED_BLOCKS - 1);
    assert.equal(r.filtered, false);
    assert.equal(r.stats.reason, 'too-few-blocks');
  });

  test('guard boundary: a drop of EXACTLY 70% filters (strict >, not >=)', () => {
    // 10 scored blocks; 3 on-topic, 7 off-topic → dropFraction 0.70, not > 0.70.
    const on = 'wireguard tunnel configuration interface details.';
    const off = [
      'cooking pasta recipes for dinner tonight.',
      'gardening spring flowers and herb beds.',
      'movie reviews and cinema news roundup.',
      'stock market trends for the quarter ahead.',
      'travel photography tips for mountain hikes.',
      'best coffee brewing methods at home.',
      'weekend woodworking project for beginners.',
    ];
    const md = [on, on, on, ...off].join('\n\n');
    const r = bm25FilterBlocks({ markdown: md, query: 'wireguard tunnel' });
    assert.equal(r.stats.scoredBlocks, 10);
    assert.equal(r.stats.dropped, 7);
    assert.ok(Math.abs(r.stats.dropFraction - MAX_DROP_FRACTION) < 1e-9);
    assert.equal(r.filtered, true, 'exactly 70% must filter, not fall back');
    assert.equal(r.stats.usedFallback, false);
  });

  test('nothing-dropped: threshold 0 keeps every block → no-op, byte-identical', () => {
    const r = bm25FilterBlocks({ markdown: WG_DOC, query: 'wireguard tunnel', threshold: 0 });
    assert.equal(r.filtered, false);
    assert.equal(r.stats.reason, 'nothing-dropped');
    assert.equal(r.markdown, WG_DOC); // byte-identical, no whitespace churn
  });

  test('code does NOT inherit relevance across a heading boundary (S2 refinement)', () => {
    const md = [
      'The wireguard tunnel setup is described in detail below with configuration.',
      '',
      '## Unrelated cooking section',
      '',
      '```text',
      'preheat oven and mix the batter',
      '```',
      '',
      'wireguard interface handshake verification steps and troubleshooting guide.',
      '',
      'more wireguard tunnel configuration notes for the interface and keys.',
    ].join('\n');
    // The code block sits under an off-topic heading with NO prose before it in
    // that section → it must use its own (near-zero) score and be dropped, not
    // inherit the on-topic intro above the heading.
    const r = bm25FilterBlocks({ markdown: md, query: 'wireguard tunnel', includeScores: true });
    assert.doesNotMatch(r.markdown, /preheat oven/);
  });

  test('threshold accepts a numeric string (lax client) instead of defaulting', () => {
    const strict = bm25FilterBlocks({ markdown: WG_DOC, query: 'wireguard tunnel', threshold: '0.9' });
    assert.equal(strict.stats.threshold, 0.9);
  });

  test('degrades (never throws) on null / undefined / non-object params', () => {
    for (const bad of [null, undefined, {}]) {
      const r = bm25FilterBlocks(bad);
      assert.equal(r.filtered, false);
      assert.equal(typeof r.markdown, 'string');
    }
  });

  test('b=0 disables length normalization (short and long block score by raw tf)', () => {
    // Two blocks with the SAME single query hit but very different lengths.
    const shortB = 'wireguard.';
    const longB =
      'wireguard ' + 'filler word here and there among many other unrelated tokens '.repeat(8);
    const md = [shortB, '', longB, '', 'cooking recipes', '', 'gardening tips'].join('\n');
    const withNorm = bm25FilterBlocks({ markdown: md, query: 'wireguard', b: 0.75, includeScores: true });
    const noNorm = bm25FilterBlocks({ markdown: md, query: 'wireguard', b: 0, includeScores: true });
    // Consecutive block indices: 0=short, 1=long, 2=cooking, 3=gardening.
    const shortNorm = (r) => r.scores.find((s) => s.index === 0).final;
    const longNorm = (r) => r.scores.find((s) => s.index === 1).final;
    // With normalization the short block outscores the long one; with b=0 they tie.
    assert.ok(shortNorm(withNorm) > longNorm(withNorm));
    assert.equal(shortNorm(noNorm), longNorm(noNorm));
  });
});
