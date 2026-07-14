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
  // Sober dynamic token budget (v0.46.0)
  TOKENS_PER_WORD,
  BASE_LIMIT_TOKENS,
  ABSOLUTE_CAP_TOKENS,
  LIMIT_FLOOR_TOKENS,
  LIMIT_CEIL_TOKENS,
  MAX_THREADS_COUNTED,
  tokensToWords,
  estimateTokens,
  parseHotMode,
  countActiveThreads,
  parseTokenOverride,
  computeHotBudget,
  hotStatus,
  buildHotBanner,
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

// ===========================================================================
// Sober dynamic token budget (v0.46.0)
// ===========================================================================

describe('estimateTokens', () => {
  test('short prose: max(chars/4, words×1.3)', () => {
    // 'un deux trois' → chars 13/4=3.25 ; words 3×1.3=3.9 → ceil(3.9)=4
    assert.equal(estimateTokens('un deux trois'), 4);
  });

  test('empty / whitespace-only → 0', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens('   \n\t '), 0);
    assert.equal(estimateTokens(null), 0);
  });

  test('URL/id-dense content: chars/4 dominates words×1.3 (bytes-catch role)', () => {
    // One "word", many chars → the char proxy must win, catching what the old
    // bytes dimension caught.
    const dense = 'http://127.0.0.1:27150/open/wiki%2FProjects%2FKIVIRI%2Fkiviri-v2-secrets.md';
    const words = dense.trim().split(/\s+/).length;
    assert.equal(words, 1);
    assert.ok(estimateTokens(dense) >= Math.ceil(dense.length / 4));
    assert.ok(estimateTokens(dense) > words * 1.3); // char proxy beats the word floor
  });

  test('accented FR text counts CHARS not UTF-8 bytes (no over-count)', () => {
    // 'café à é' and an ASCII string of the same char length must estimate the
    // same — proves we use text.length, not the (larger) UTF-8 byte length.
    const fr = 'café à é été';
    const ascii = 'cafe a e ete'; // same length in code units
    assert.equal(fr.length, ascii.length);
    assert.equal(estimateTokens(fr), estimateTokens(ascii));
  });
});

describe('tokensToWords', () => {
  test('inverse of the token→word density, rounded', () => {
    assert.equal(tokensToWords(BASE_LIMIT_TOKENS), Math.round(BASE_LIMIT_TOKENS / TOKENS_PER_WORD));
    assert.equal(tokensToWords(0), 0);
    assert.equal(tokensToWords(null), 0);
  });
});

describe('parseHotMode', () => {
  test('mode: project → project', () => {
    assert.equal(parseHotMode('---\nmode: project\ntype: hot\n---\n# Hot'), 'project');
  });
  test('mode absent, type: hot → default (unknown role)', () => {
    assert.equal(parseHotMode('---\ntype: hot\n---\n# Hot'), 'default');
  });
  test('type: reference (no mode) → reference', () => {
    assert.equal(parseHotMode('---\ntype: reference\n---\n'), 'reference');
  });
  test('type: wiki-personal fallback strips the wiki- prefix → personal', () => {
    assert.equal(parseHotMode('---\ntype: wiki-personal\n---\n'), 'personal');
  });
  test('no frontmatter → default', () => {
    assert.equal(parseHotMode('# Hot\n\ncontenu'), 'default');
  });
  test('mode wins over type', () => {
    assert.equal(parseHotMode('---\nmode: reference\ntype: project\n---\n'), 'reference');
  });
});

describe('countActiveThreads', () => {
  const HOT = [
    '# Hot',
    '',
    '## Key Recent Facts',
    '- pas un thread (autre section)',
    '',
    '## Active Threads',
    '- thread un',
    '- [ ] thread deux (checkbox)',
    '- [x] thread trois (done checkbox)',
    '',
    '## Recent Changes',
    '- pas un thread non plus',
  ].join('\n');

  test('counts bullets + checkboxes under the Active Threads heading only', () => {
    assert.equal(countActiveThreads(HOT), 3);
  });
  test('the _(empty …)_ placeholder counts as 0', () => {
    const t = '## Active Threads\n\n_(empty — populated as the wiki grows)_\n';
    assert.equal(countActiveThreads(t), 0);
  });
  test('a renamed/absent heading → 0 (safe degradation)', () => {
    const t = '## Fils en cours\n- un\n- deux\n';
    assert.equal(countActiveThreads(t), 0);
  });
  test('bullets before any heading → 0', () => {
    assert.equal(countActiveThreads('- orphan\n- bullet\n'), 0);
  });
});

describe('parseTokenOverride', () => {
  test('hot-limit-tokens honored + clamped to the absolute cap', () => {
    assert.equal(parseTokenOverride('---\nhot-limit-tokens: 900\n---\n'), 900);
    assert.equal(parseTokenOverride('---\nhot-limit-tokens: 99999\n---\n'), ABSOLUTE_CAP_TOKENS);
    assert.equal(parseTokenOverride('---\nhot-limit-tokens: 1\n---\n'), LIMIT_FLOOR_TOKENS);
  });
  test('legacy hot-limit-words converted ×density (back-compat)', () => {
    // 800 words × 1.8 = 1440, within [floor, cap]
    assert.equal(parseTokenOverride('---\nhot-limit-words: 800\n---\n'), Math.round(800 * TOKENS_PER_WORD));
  });
  test('tokens override wins over legacy words', () => {
    // 950 is inside [floor, cap]; the words key must be ignored when tokens present.
    assert.equal(parseTokenOverride('---\nhot-limit-tokens: 950\nhot-limit-words: 999\n---\n'), 950);
  });
  test('garbage / no frontmatter → null', () => {
    assert.equal(parseTokenOverride('---\nhot-limit-tokens: beaucoup\n---\n'), null);
    assert.equal(parseTokenOverride('# Hot\n'), null);
  });
});

describe('computeHotBudget', () => {
  test('default role, 0 threads → base limit, in-band', () => {
    const b = computeHotBudget('---\ntype: hot\n---\n# Hot\n\nun peu de texte');
    assert.equal(b.role, 'default');
    assert.equal(b.activeThreads, 0);
    assert.equal(b.limitTokens, BASE_LIMIT_TOKENS); // 650 within [559,884]
    assert.equal(b.overridden, false);
  });

  test('project role + 5 threads → modestly higher, still in the narrow band', () => {
    const threads = '\n## Active Threads\n' + '- t\n'.repeat(6); // >MAX_THREADS_COUNTED
    const b = computeHotBudget('---\nmode: project\n---\n# Hot' + threads);
    assert.equal(b.role, 'project');
    assert.equal(b.activeThreads, MAX_THREADS_COUNTED); // capped at 5
    // 900×1.1 + 5×20 = 1090, within [774,1224]
    assert.equal(b.limitTokens, Math.round(BASE_LIMIT_TOKENS * 1.1) + MAX_THREADS_COUNTED * 20);
    assert.ok(b.limitTokens <= LIMIT_CEIL_TOKENS);
  });

  test('reference role → lower base', () => {
    const b = computeHotBudget('---\nmode: reference\n---\n# Hot');
    assert.equal(b.limitTokens, Math.round(BASE_LIMIT_TOKENS * 0.9)); // 585
  });

  test('INVARIANT: enforced limit always within the band and strictly under the absolute cap', () => {
    const roles = ['project', 'personal', 'reference', 'default'];
    for (const r of roles) {
      for (let n = 0; n <= 8; n++) {
        const t = `---\nmode: ${r}\n---\n## Active Threads\n` + '- x\n'.repeat(n);
        const b = computeHotBudget(t);
        assert.ok(b.limitTokens >= LIMIT_FLOOR_TOKENS, `${r}/${n}: ${b.limitTokens} < floor`);
        assert.ok(b.limitTokens <= LIMIT_CEIL_TOKENS, `${r}/${n}: ${b.limitTokens} > ceil`);
        assert.ok(b.limitTokens < ABSOLUTE_CAP_TOKENS, `${r}/${n}: ${b.limitTokens} ≥ absolute cap`);
      }
    }
  });

  test('explicit override may exceed the dynamic band, capped at the absolute cap', () => {
    const b = computeHotBudget('---\nmode: reference\nhot-limit-tokens: 1500\n---\n# Hot');
    assert.equal(b.overridden, true);
    assert.ok(b.limitTokens > LIMIT_CEIL_TOKENS); // beyond the dynamic band…
    assert.ok(b.limitTokens < ABSOLUTE_CAP_TOKENS); // …but under the absolute cap
    assert.equal(b.limitTokens, 1500);
  });

  test('targetTokens is 70% of the limit (hysteresis: below the limit)', () => {
    const b = computeHotBudget('---\ntype: hot\n---\n# Hot');
    assert.equal(b.targetTokens, Math.round(b.limitTokens * 0.7));
    assert.ok(b.targetTokens < b.limitTokens);
  });
});

describe('hotStatus', () => {
  test('under the enforced limit → not over', () => {
    const st = hotStatus('---\ntype: hot\n---\n# Hot\n\npetit');
    assert.equal(st.over, false);
  });

  test('above the enforced limit → over', () => {
    // ~4000 chars ≈ 1000 tokens > any dynamic band ceiling (884)
    const big = '---\ntype: hot\n---\n# Hot\n\n' + 'mot '.repeat(1200);
    const st = hotStatus(big);
    assert.ok(st.tokens > st.limitTokens);
    assert.equal(st.over, true);
  });

  test('a realistic ~400-word pointer-dense FR hot stays ok (no false positive)', () => {
    // ~400 words of dense FR content (the KIVIRI/DEDIBOX regime, ~1.8 t/w):
    // must stay under the ~900-token anchor — the calibration that keeps every
    // healthy on-disk hot from being false-flagged.
    const prose = 'référence activité vault contexte récent '.repeat(80); // ~400 words
    const st = hotStatus('---\ntype: hot\n---\n# Hot\n\n' + prose);
    assert.ok(st.tokens < st.limitTokens, `tokens=${st.tokens} limit=${st.limitTokens}`);
    assert.equal(st.over, false);
  });
});

describe('buildHotBanner', () => {
  test('speaks tokens (words as an indicative parenthesis) + FR/EN + command', () => {
    const b = buildHotBanner({ tokens: 1000, limitTokens: 700, targetTokens: 490, vaultLabel: 'mon-vault' });
    assert.match(b, /~1000 tokens/);
    assert.match(b, /~700 tokens/);
    assert.match(b, /~490 tokens/);
    assert.match(b, /mon-vault/);
    assert.match(b, /hot-compact/);
    assert.match(b, /OVER LIMIT/);
    assert.match(b, /mots/); // indicative word parenthesis present
  });
});
