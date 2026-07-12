/**
 * Tests for src/helpers/hot-size.mjs (v0.44.0 — hot-cache size discipline).
 *
 * Pure helper: counting (words + UTF-8 bytes), per-vault limit overrides
 * (clamped), OR-based over-limit test, block splitting (prologue vs dated
 * entries), ordering detection, bounded selection (newest side kept, block
 * boundaries respected, omission marker), oversize banner.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LIMITS,
  HARD_CAPS,
  FLOORS,
  INJECTION_CAP_BYTES,
  targetsFor,
  countHotSize,
  parseHotLimits,
  isOverLimit,
  splitHotBlocks,
  isNewestFirst,
  selectBoundedContent,
  buildOversizeBanner,
} from '../src/helpers/hot-size.mjs';

// ---------------------------------------------------------------------------
// countHotSize
// ---------------------------------------------------------------------------

describe('countHotSize', () => {
  test('counts whitespace-separated words and UTF-8 bytes', () => {
    const s = countHotSize('un deux trois');
    assert.equal(s.words, 3);
    assert.equal(s.bytes, 13);
  });

  test('multi-byte characters count once as words, fully as bytes', () => {
    const s = countHotSize('café ☕');
    assert.equal(s.words, 2);
    assert.ok(s.bytes > 6); // é = 2 bytes, ☕ = 3 bytes
  });

  test('empty and whitespace-only → 0 words', () => {
    assert.equal(countHotSize('').words, 0);
    assert.equal(countHotSize('   \n\t ').words, 0);
  });
});

// ---------------------------------------------------------------------------
// parseHotLimits / targetsFor
// ---------------------------------------------------------------------------

describe('parseHotLimits', () => {
  test('no frontmatter → defaults, not overridden', () => {
    const l = parseHotLimits('# Hot\n\ncontenu');
    assert.equal(l.maxWords, DEFAULT_LIMITS.maxWords);
    assert.equal(l.maxBytes, DEFAULT_LIMITS.maxBytes);
    assert.equal(l.overridden, false);
  });

  test('frontmatter override within range is honored', () => {
    const l = parseHotLimits('---\nhot-limit-words: 800\nhot-limit-bytes: 10240\n---\n# Hot\n');
    assert.equal(l.maxWords, 800);
    assert.equal(l.maxBytes, 10240);
    assert.equal(l.overridden, true);
  });

  test('override is clamped to hard caps', () => {
    const l = parseHotLimits('---\nhot-limit-words: 99999\nhot-limit-bytes: 999999\n---\n');
    assert.equal(l.maxWords, HARD_CAPS.maxWords);
    assert.equal(l.maxBytes, HARD_CAPS.maxBytes);
  });

  test('override is clamped to floors', () => {
    const l = parseHotLimits('---\nhot-limit-words: 1\nhot-limit-bytes: 1\n---\n');
    assert.equal(l.maxWords, FLOORS.maxWords);
    assert.equal(l.maxBytes, FLOORS.maxBytes);
  });

  test('garbage values are ignored', () => {
    const l = parseHotLimits('---\nhot-limit-words: beaucoup\n---\n');
    assert.equal(l.maxWords, DEFAULT_LIMITS.maxWords);
    assert.equal(l.overridden, false);
  });

  test('targets derive from the effective max (hysteresis)', () => {
    const t = targetsFor(DEFAULT_LIMITS);
    assert.equal(t.targetWords, 350);
    assert.equal(t.targetBytes, 4096);
    const l = parseHotLimits('---\nhot-limit-words: 1000\n---\n');
    assert.equal(l.targetWords, 700);
  });
});

// ---------------------------------------------------------------------------
// isOverLimit — OR semantics
// ---------------------------------------------------------------------------

describe('isOverLimit', () => {
  const limits = { maxWords: 500, maxBytes: 6144 };

  test('under both → false', () => {
    assert.equal(isOverLimit({ words: 400, bytes: 5000 }, limits), false);
  });

  test('words over only → true', () => {
    assert.equal(isOverLimit({ words: 501, bytes: 100 }, limits), true);
  });

  test('bytes over only → true (URL/id-heavy content)', () => {
    assert.equal(isOverLimit({ words: 100, bytes: 7000 }, limits), true);
  });

  test('exactly at the limits → false (limits are inclusive)', () => {
    assert.equal(isOverLimit({ words: 500, bytes: 6144 }, limits), false);
  });
});

// ---------------------------------------------------------------------------
// splitHotBlocks / isNewestFirst
// ---------------------------------------------------------------------------

const NEWEST_FIRST = [
  '---',
  'type: wiki-hot',
  '---',
  '',
  '# Hot',
  '',
  '> 🆕 **Fait récent** (2026-07-12) — le plus frais TOKEN-NEWEST',
  '',
  '> 🆕 **Fait médian** (2026-07-05) — au milieu',
  '',
  '> 🆕 **Fait ancien** (2026-06-10) — le plus vieux TOKEN-OLDEST',
].join('\n');

const OLDEST_FIRST = [
  '# Hot',
  '',
  '> **Fait ancien** (2026-06-10) — le plus vieux TOKEN-OLDEST',
  '',
  '> **Fait médian** (2026-07-05) — au milieu',
  '',
  '> **Fait récent** (2026-07-12) — le plus frais TOKEN-NEWEST',
].join('\n');

describe('splitHotBlocks', () => {
  test('prologue = everything before the first dated paragraph', () => {
    const { prologue, blocks } = splitHotBlocks(NEWEST_FIRST);
    assert.ok(prologue.join(' ').includes('# Hot'));
    assert.equal(blocks.length, 3);
    assert.match(blocks[0], /2026-07-12/);
  });

  test('file without any dated paragraph is all prologue', () => {
    const { prologue, blocks } = splitHotBlocks('# Hot\n\njuste du texte\n\nsans date');
    assert.equal(blocks.length, 0);
    assert.equal(prologue.length, 3);
  });
});

describe('isNewestFirst', () => {
  test('descending dates → newest-first', () => {
    assert.equal(isNewestFirst(splitHotBlocks(NEWEST_FIRST).blocks), true);
  });

  test('ascending dates → oldest-first (append-at-bottom journal)', () => {
    assert.equal(isNewestFirst(splitHotBlocks(OLDEST_FIRST).blocks), false);
  });

  test('fewer than two dated blocks defaults to newest-first', () => {
    assert.equal(isNewestFirst(['> un seul bloc (2026-07-12)']), true);
    assert.equal(isNewestFirst([]), true);
  });
});

// ---------------------------------------------------------------------------
// selectBoundedContent
// ---------------------------------------------------------------------------

describe('selectBoundedContent', () => {
  test('content within budget is returned verbatim, untruncated', () => {
    const r = selectBoundedContent(NEWEST_FIRST, 100000);
    assert.equal(r.truncated, false);
    assert.equal(r.content, NEWEST_FIRST);
    assert.equal(r.omittedBlocks, 0);
  });

  test('newest-first file: keeps the top (recent) entries, omits the old ones', () => {
    // Budget: prologue + first entry only.
    const budget = Buffer.byteLength(NEWEST_FIRST, 'utf8') - 60;
    const r = selectBoundedContent(NEWEST_FIRST, budget);
    assert.equal(r.truncated, true);
    assert.match(r.content, /TOKEN-NEWEST/);
    assert.doesNotMatch(r.content, /TOKEN-OLDEST/);
    assert.match(r.content, /omis/); // omission marker present
    assert.ok(r.omittedBlocks >= 1);
  });

  test('oldest-first file: keeps the bottom (recent) entries, marker before them', () => {
    const budget = Buffer.byteLength(OLDEST_FIRST, 'utf8') - 40;
    const r = selectBoundedContent(OLDEST_FIRST, budget);
    assert.equal(r.truncated, true);
    assert.match(r.content, /TOKEN-NEWEST/);
    assert.doesNotMatch(r.content, /TOKEN-OLDEST/);
    const markerPos = r.content.indexOf('omis');
    const newestPos = r.content.indexOf('TOKEN-NEWEST');
    assert.ok(markerPos < newestPos, 'marker should precede the kept tail');
  });

  test('never cuts mid-block: kept blocks are whole', () => {
    const budget = Buffer.byteLength(NEWEST_FIRST, 'utf8') - 60;
    const r = selectBoundedContent(NEWEST_FIRST, budget);
    // The newest entry must be present IN FULL (its trailing token intact).
    assert.match(r.content, /le plus frais TOKEN-NEWEST/);
  });

  test('keptBytes ≤ budget + marker allowance', () => {
    const budget = 300;
    const r = selectBoundedContent(NEWEST_FIRST, budget);
    // Marker + separators may add a little; keep a sane upper bound.
    assert.ok(r.keptBytes <= budget + 200, `${r.keptBytes} > ${budget + 200}`);
  });

  test('degenerate: prologue alone exceeds budget → line-bounded cut', () => {
    const longProse = '# Hot\n\n' + 'ligne sans date assez longue pour peser\n'.repeat(50);
    const r = selectBoundedContent(longProse, 400);
    assert.equal(r.truncated, true);
    assert.ok(Buffer.byteLength(r.content, 'utf8') <= 400 + 120);
    assert.match(r.content, /omise/);
  });
});

// ---------------------------------------------------------------------------
// buildOversizeBanner + constants
// ---------------------------------------------------------------------------

describe('buildOversizeBanner', () => {
  test('mentions sizes, limits, and the compaction command (FR + EN)', () => {
    const limits = { ...DEFAULT_LIMITS, ...targetsFor(DEFAULT_LIMITS) };
    const b = buildOversizeBanner({ words: 17800, bytes: 129561, limits, vaultLabel: 'mon-vault' });
    assert.match(b, /17800 mots/);
    assert.match(b, /126\.5 Kio/);
    assert.match(b, /hot-compact/);
    assert.match(b, /mon-vault/);
    assert.match(b, /OVER LIMIT/);
  });
});

describe('constants', () => {
  test('injection cap is above the hard byte cap (overrides still fit)', () => {
    assert.ok(INJECTION_CAP_BYTES > HARD_CAPS.maxBytes);
  });
});
