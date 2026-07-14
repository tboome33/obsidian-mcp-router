/**
 * hot-size.mjs
 *
 * Pure logic for the hot-cache SIZE discipline (v0.44.0). Shared by:
 *   - `hooks/hot-cache-load.mjs`   (bounded injection + oversize banner)
 *   - `hooks/hot-cache-update-prompt.mjs` (Stop guard: demand compaction)
 *   - the `/obsidian-router:hot-compact` skill (target sizes)
 *
 * WHY. `wiki-meta/hot.md` is a recent-context CACHE whose own header rule
 * says "< 500 words, overwritten on update — a cache, not a journal". But
 * until v0.44.0 nothing enforced the size: the freshness guard pushed every
 * session to ADD an entry and nothing ever removed one — a ratchet. The
 * oldest vault's hot grew to 129 KB / ~17.8k words (35× the rule), silently
 * injected into EVERY session start on that vault. Diagnosed 2026-07-12,
 * design pressure-tested with codex the same day. The fix has three legs:
 * bounded injection at load, size enforcement at Stop, and a deterministic
 * compaction procedure — all measuring size through THIS single module so
 * the loader, the guard and the compactor can never disagree (a disagreement
 * would loop: loader says fine, guard blocks, compaction targets a third
 * number…).
 *
 * Thresholds (codex-reviewed):
 *   - trigger when words > 500 OR bytes > 6 KiB (OR — either overrun is bad:
 *     words track the semantic promise, bytes catch URL/id/code-heavy content
 *     where word counts lie);
 *   - compaction TARGETS ≤ 350 words AND ≤ 4 KiB (hysteresis: compacting to
 *     499 words would re-trigger almost immediately);
 *   - per-vault override via hot.md frontmatter (`hot-limit-words`,
 *     `hot-limit-bytes`), clamped to hard caps 1000 words / 12 KiB —
 *     an EXPLICIT exception, never implicit growth;
 *   - absolute injection cap 16 KiB whatever the config.
 *
 * Zero deps, no I/O — callers inject file contents.
 */

/** Byte length of a JS string in UTF-8 without Buffer (works everywhere). */
function utf8Bytes(text) {
  if (typeof text !== 'string' || !text) return 0;
  // TextEncoder is available in Node ≥ 11 and browsers alike.
  return new TextEncoder().encode(text).length;
}

export const DEFAULT_LIMITS = Object.freeze({
  maxWords: 500,
  maxBytes: 6 * 1024,
});

export const HARD_CAPS = Object.freeze({
  maxWords: 1000,
  maxBytes: 12 * 1024,
});

export const FLOORS = Object.freeze({
  maxWords: 100,
  maxBytes: 1024,
});

/** Absolute bound on what the loader may inject, overrides included. */
export const INJECTION_CAP_BYTES = 16 * 1024;

/** Compaction targets derived from the max: 70% words, ~66% bytes. */
export function targetsFor(limits = DEFAULT_LIMITS) {
  return {
    targetWords: Math.round(limits.maxWords * 0.7),
    targetBytes: Math.round(limits.maxBytes * (2 / 3)),
  };
}

/** Measure a hot.md: whitespace-separated words + UTF-8 bytes. */
export function countHotSize(text) {
  if (typeof text !== 'string' || !text.trim()) return { words: 0, bytes: utf8Bytes(text || '') };
  const words = text.trim().split(/\s+/).length;
  return { words, bytes: utf8Bytes(text) };
}

/**
 * Effective limits for one hot.md. Reads optional frontmatter overrides:
 *
 *   ---
 *   hot-limit-words: 800
 *   hot-limit-bytes: 10240
 *   ---
 *
 * Values are clamped to [FLOORS, HARD_CAPS]; anything unparsable is ignored.
 * Returns { maxWords, maxBytes, targetWords, targetBytes, overridden }.
 */
export function parseHotLimits(text, defaults = DEFAULT_LIMITS) {
  let maxWords = defaults.maxWords;
  let maxBytes = defaults.maxBytes;
  let overridden = false;

  if (typeof text === 'string' && text.startsWith('---')) {
    const end = text.indexOf('\n---', 3);
    if (end !== -1) {
      const fm = text.slice(0, end);
      const mW = fm.match(/^hot-limit-words:\s*(\d+)\s*$/m);
      const mB = fm.match(/^hot-limit-bytes:\s*(\d+)\s*$/m);
      if (mW) {
        maxWords = Math.min(HARD_CAPS.maxWords, Math.max(FLOORS.maxWords, parseInt(mW[1], 10)));
        overridden = true;
      }
      if (mB) {
        maxBytes = Math.min(HARD_CAPS.maxBytes, Math.max(FLOORS.maxBytes, parseInt(mB[1], 10)));
        overridden = true;
      }
    }
  }

  return { maxWords, maxBytes, ...targetsFor({ maxWords, maxBytes }), overridden };
}

/** True when either dimension exceeds its limit (OR, per design). */
export function isOverLimit(size, limits) {
  if (!size || !limits) return false;
  return size.words > limits.maxWords || size.bytes > limits.maxBytes;
}

const DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/;

/**
 * Split a hot.md into { prologue, blocks }:
 *   - blocks = paragraphs (split on blank lines) from the first DATED
 *     paragraph onward — the "entries";
 *   - prologue = everything before that (frontmatter, title, conventions
 *     line, section headers) — always preserved by the bounded selection.
 * A file with no dated paragraph is all prologue (nothing to trim smartly).
 */
export function splitHotBlocks(text) {
  const paras = String(text || '').split(/\n{2,}/);
  let firstDated = -1;
  for (let i = 0; i < paras.length; i++) {
    if (DATE_RE.test(paras[i])) { firstDated = i; break; }
  }
  if (firstDated === -1) return { prologue: paras, blocks: [] };
  return { prologue: paras.slice(0, firstDated), blocks: paras.slice(firstDated) };
}

/** Extract the max date (as sortable string) mentioned in a block, or null. */
function blockDate(block) {
  let best = null;
  const re = new RegExp(DATE_RE.source, 'g');
  let m;
  while ((m = re.exec(block)) !== null) {
    const d = m[0];
    if (!best || d > best) best = d;
  }
  return best;
}

/**
 * True when the dated blocks read newest-first (top of file = most recent).
 * Decided by comparing the first dated block against the last one; ties and
 * undated edges default to newest-first (this repo's hot convention).
 */
export function isNewestFirst(blocks) {
  const dated = blocks.map(blockDate).filter(Boolean);
  if (dated.length < 2) return true;
  return dated[0] >= dated[dated.length - 1];
}

/**
 * Bounded selection for injection. Keeps the prologue, then whole entry
 * blocks starting from the MOST RECENT side (direction auto-detected), until
 * `budgetBytes` is spent. Blocks are re-emitted in their ORIGINAL order with
 * an omission marker where content was dropped — never a mid-line cut.
 *
 * Returns { content, truncated, totalBytes, keptBytes, omittedBlocks }.
 */
export function selectBoundedContent(text, budgetBytes) {
  const totalBytes = utf8Bytes(text);
  if (totalBytes <= budgetBytes) {
    return { content: text, truncated: false, totalBytes, keptBytes: totalBytes, omittedBlocks: 0 };
  }

  const { prologue, blocks } = splitHotBlocks(text);
  const SEP = '\n\n';
  const sepBytes = utf8Bytes(SEP);

  // Prologue first — if it alone busts the budget, hard-cut it at a line
  // boundary (degenerate case: a hot.md with no dated entries at all).
  let out = [];
  let spent = 0;
  const prologueText = prologue.join(SEP);
  const prologueBytes = utf8Bytes(prologueText);
  if (prologueBytes > budgetBytes) {
    const lines = prologueText.split('\n');
    const kept = [];
    let b = 0;
    for (const line of lines) {
      const lb = utf8Bytes(line) + 1;
      if (b + lb > budgetBytes) break;
      kept.push(line);
      b += lb;
    }
    const content = kept.join('\n') + '\n\n<!-- hot-cache-load: injection bornée — suite du fichier omise -->';
    return {
      content, truncated: true, totalBytes,
      keptBytes: utf8Bytes(content), omittedBlocks: blocks.length,
    };
  }
  if (prologueText) {
    out.push(prologueText);
    spent += prologueBytes + sepBytes;
  }

  // Then entries from the most recent side.
  const newestFirst = isNewestFirst(blocks);
  const order = blocks.map((_, i) => i);
  if (!newestFirst) order.reverse(); // walk from the recent END of the file
  const keptIdx = new Set();
  for (const i of order) {
    const b = utf8Bytes(blocks[i]) + sepBytes;
    if (spent + b > budgetBytes) break; // stop at first block that no longer fits
    keptIdx.add(i);
    spent += b;
  }

  const omittedBlocks = blocks.length - keptIdx.size;
  const marker = `<!-- hot-cache-load: injection bornée — ${omittedBlocks} bloc(s) plus ancien(s) omis -->`;
  const keptInOrder = blocks.filter((_, i) => keptIdx.has(i));
  const body = newestFirst
    ? [...keptInOrder, marker]
    : [marker, ...keptInOrder];
  const content = [...out, ...body].join(SEP);
  return { content, truncated: true, totalBytes, keptBytes: utf8Bytes(content), omittedBlocks };
}

/**
 * Bilingual oversize banner injected ABOVE the (bounded) hot content, and
 * reused by the Stop guard's message. Plain text — hooks print to stdout.
 */
export function buildOversizeBanner({ words, bytes, limits, vaultLabel = '' }) {
  const kib = (n) => (n / 1024).toFixed(1);
  const label = vaultLabel ? ` (${vaultLabel})` : '';
  return [
    `⚠️ [hot-cache] wiki-meta/hot.md${label} est HORS LIMITE : ${words} mots / ${kib(bytes)} Kio`,
    `   (règle : ≤ ${limits.maxWords} mots ET ≤ ${kib(limits.maxBytes)} Kio — c'est un cache, pas un journal).`,
    `   Seul un extrait borné est injecté ci-dessous. Compaction requise :`,
    `   /obsidian-router:hot-compact — backup intégral puis réécriture ≤ ${limits.targetWords} mots / ${kib(limits.targetBytes)} Kio.`,
    `   EN — hot.md is OVER LIMIT (${words} words / ${kib(bytes)} KiB; rule ≤ ${limits.maxWords} words AND ≤ ${kib(limits.maxBytes)} KiB).`,
    `   Only a bounded excerpt is injected. Run /obsidian-router:hot-compact (full backup, then rewrite ≤ ${limits.targetWords} words).`,
  ].join('\n');
}

// ===========================================================================
// Sober dynamic token budget (v0.46.0)
// ===========================================================================
//
// WHY a second layer over the words|bytes OR above. That OR is a STATIC,
// two-unit test: it blocks as soon as EITHER dimension overruns a fixed
// threshold, and it mixes a 500-word default trigger, a 1000-word hard cap
// and a bytes dimension — three numbers in two units that are not directly
// comparable (Hermès flagged the incoherence: 1000 words ≈ 750 tokens, so a
// token-denominated soft target and a word-denominated hard cap describe
// different, contradictory spaces). This layer collapses the SEMANTIC size
// decision onto ONE unit — estimated tokens, which is what context actually
// costs — and lets the ENFORCED limit breathe within a NARROW band around the
// proven ~500-word anchor, driven by only two defensible signals: the vault's
// role and the number of active threads. The anti-drift guarantee is kept by
// an absolute never-exceed cap (~1000 words) that no dynamic term can lift.
//
// Deliberately NOT used: raw edit velocity (measures editorial noise, not the
// facts worth caching) and a session-frequency term (its sign is disputed —
// Codex reads it as budget-decreasing, Hermès as budget-increasing, so it is
// omitted rather than hard-coded in either direction). Rationale in the router
// vault design note "hot-cache-dynamic-limit-design" (Claude+Codex+Hermès).
//
// This is the SOBER Phase-1 prototype: a single-unit token cap plus a small,
// bounded active-threads bump. Richer ideas (per-block score/token eviction,
// LLM-bounded compaction, retrieval-cost weighting) are staged as follow-ups
// in that note, NOT implemented here.

/**
 * Empirical density of REAL hot.md content: ~1.8 estimated tokens per word.
 * Markdown, FR accents and [[wikilink]]/URL pointers push hot content well
 * above generic prose's ~1.3 t/w. Measured on live vault hots (398 w → 728 t,
 * 492 w → 889 t ⇒ ~1.8). Used to derive the token anchors from the proven
 * ~500-word rule and to display an indicative word count.
 *
 * CALIBRATION NOTE. The old fixed "500 words" limit, re-expressed HONESTLY in
 * tokens, is therefore ~900 tokens — NOT 650. A healthy 500-word pointer-dense
 * hot really costs ~900 tokens; anchoring at 500×1.3=650 would false-flag every
 * healthy hot on disk (both live sample vaults measured over such a cap). So the
 * anchor is 500 × this density, keeping the enforced block point where the
 * proven word rule always put it.
 */
export const TOKENS_PER_WORD = 1.8;

/** Convert an estimated-token count back to an indicative word count. */
export function tokensToWords(tokens) {
  return Math.round((Number(tokens) || 0) / TOKENS_PER_WORD);
}

/**
 * Deterministic, dependency-free token estimate — the SINGLE measurement unit
 * for the semantic size decision. tokens ≈ ceil(max(chars/4, words×1.3)):
 *   - chars/4 is the standard cheap proxy and DOMINATES on real hot content
 *     (markdown + accents + URLs/ids), collapsing the old words+bytes pair
 *     into one unit;
 *   - words×1.3 is only a conservative FLOOR for the degenerate char-sparse
 *     case, so such text is never under-counted; max() takes the worse of two.
 *     (This is an internal lower bound, distinct from TOKENS_PER_WORD, which is
 *     the measured density of actual hot content used to set the limits.)
 *   - chars = text.length (JS code units), NOT UTF-8 bytes: a French "é" is
 *     one char but two bytes, and tokenizers track characters — counting bytes
 *     would massively over-count accented FR text (the robustness fix vs the
 *     old byte counting).
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || !text.trim()) return 0;
  const chars = text.length;
  const words = text.trim().split(/\s+/).length;
  return Math.ceil(Math.max(chars / 4, words * 1.3));
}

/** The proven ~500-word cache rule, expressed once in tokens (see TOKENS_PER_WORD). */
export const BASE_LIMIT_TOKENS = Math.round(500 * TOKENS_PER_WORD); // 900
/** Absolute never-exceed ceiling (ulimit): ~1000 words. Clamps overrides. */
export const ABSOLUTE_CAP_TOKENS = Math.round(1000 * TOKENS_PER_WORD); // 1800
/** Narrow band the dynamic enforced limit may move within (~430–680 words). */
export const LIMIT_FLOOR_TOKENS = Math.round(430 * TOKENS_PER_WORD); // 774
export const LIMIT_CEIL_TOKENS = Math.round(680 * TOKENS_PER_WORD); // 1224
/** The two — and only two — dynamic signals, both modest and bounded. */
export const ROLE_MULT = Object.freeze({ project: 1.1, personal: 1.0, reference: 0.9, default: 1.0 });
export const PER_THREAD_TOKENS = 20;
export const MAX_THREADS_COUNTED = 5; // bump capped at +100 tokens (~+56 words)

function clampInt(n, lo, hi) {
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/**
 * Vault role from the hot.md frontmatter: `mode:` first, `type:` as fallback.
 * One of project | personal | reference; anything else → 'default'. Reuses the
 * same frontmatter-slice pattern as parseHotLimits.
 */
export function parseHotMode(text) {
  if (typeof text !== 'string' || !text.startsWith('---')) return 'default';
  const end = text.indexOf('\n---', 3);
  if (end === -1) return 'default';
  const fm = text.slice(0, end);
  const m = fm.match(/^mode:\s*([A-Za-z]+)/m) || fm.match(/^type:\s*(?:wiki-)?([A-Za-z]+)/m);
  const v = m && m[1].toLowerCase();
  return (v === 'project' || v === 'personal' || v === 'reference') ? v : 'default';
}

/**
 * Count the bullets under the `## Active Threads` heading — the ONE dynamic
 * work signal we trust (a proxy for "how many threads of work are actually in
 * flight", NOT how many files churned). Simple bullets and checkboxes count;
 * the `_(empty …)_` placeholder does not. Any other heading ends the section.
 * A renamed/translated heading → 0 (safe degradation: lower limit, never
 * higher).
 */
export function countActiveThreads(text) {
  let inSection = false;
  let n = 0;
  for (const line of String(text || '').split('\n')) {
    const h = line.match(/^(#{2,6})\s+(.*)$/);
    if (h) { inSection = /active\s+threads/i.test(h[2]); continue; }
    if (inSection && /^\s*[-*+]\s+(?:\[[ xX]\]\s+)?\S/.test(line) && !/^\s*[-*+]\s+_\(/.test(line)) n++;
  }
  return n;
}

/**
 * Optional per-vault override. Prefers `hot-limit-tokens`; falls back to the
 * legacy `hot-limit-words` (× conversion) for back-compat. Clamped to
 * [LIMIT_FLOOR_TOKENS, ABSOLUTE_CAP_TOKENS] — an EXPLICIT exception may exceed
 * the dynamic band, up to the absolute cap, but never past it. Returns null
 * when no valid override is present.
 */
export function parseTokenOverride(text) {
  if (typeof text !== 'string' || !text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  const fm = text.slice(0, end);
  const mT = fm.match(/^hot-limit-tokens:\s*(\d+)\s*$/m);
  if (mT) return clampInt(parseInt(mT[1], 10), LIMIT_FLOOR_TOKENS, ABSOLUTE_CAP_TOKENS);
  const mW = fm.match(/^hot-limit-words:\s*(\d+)\s*$/m);
  if (mW) return clampInt(parseInt(mW[1], 10) * TOKENS_PER_WORD, LIMIT_FLOOR_TOKENS, ABSOLUTE_CAP_TOKENS);
  return null;
}

/**
 * The central deterministic budget. Produces:
 *   - tokens:        measured size of the hot;
 *   - limitTokens:   the ENFORCED (blocking) limit — dynamic within a narrow
 *                    band around BASE_LIMIT_TOKENS, or an explicit override;
 *   - targetTokens:  compaction target (70% of the limit — hysteresis so a
 *                    fresh compaction doesn't re-trigger);
 *   - role, activeThreads, absoluteCapTokens, overridden: metadata.
 * No LLM, no I/O — a pure, auditable function of the file text.
 */
export function computeHotBudget(text) {
  const tokens = estimateTokens(text);
  const role = parseHotMode(text);
  const threads = Math.min(countActiveThreads(text), MAX_THREADS_COUNTED);
  const mult = ROLE_MULT[role] ?? 1.0;
  const dynamic = BASE_LIMIT_TOKENS * mult + threads * PER_THREAD_TOKENS;
  const override = parseTokenOverride(text);
  const limitTokens = override != null ? override : clampInt(dynamic, LIMIT_FLOOR_TOKENS, LIMIT_CEIL_TOKENS);
  const targetTokens = Math.round(limitTokens * 0.7);
  return {
    tokens,
    role,
    activeThreads: threads,
    limitTokens,
    targetTokens,
    absoluteCapTokens: ABSOLUTE_CAP_TOKENS,
    overridden: override != null,
  };
}

/** Budget + an `over` flag (tokens strictly above the enforced limit). */
export function hotStatus(text) {
  const b = computeHotBudget(text);
  return { over: b.tokens > b.limitTokens, ...b };
}

/**
 * Bilingual oversize banner in TOKEN language (words kept as an indicative
 * parenthesis). Injected above the bounded hot content by the loader and
 * echoed by the Stop guard's message.
 */
export function buildHotBanner({ tokens, limitTokens, targetTokens, vaultLabel = '' }) {
  const w = (t) => tokensToWords(t);
  const label = vaultLabel ? ` (${vaultLabel})` : '';
  return [
    `⚠️ [hot-cache] wiki-meta/hot.md${label} est HORS LIMITE : ~${tokens} tokens (~${w(tokens)} mots)`,
    `   (règle : ≤ ~${limitTokens} tokens (~${w(limitTokens)} mots) — c'est un cache, pas un journal).`,
    `   Seul un extrait borné est injecté ci-dessous. Compaction requise :`,
    `   /obsidian-router:hot-compact — backup intégral puis réécriture ≤ ~${targetTokens} tokens (~${w(targetTokens)} mots).`,
    `   EN — hot.md is OVER LIMIT (~${tokens} tokens / ~${w(tokens)} words; rule ≤ ~${limitTokens} tokens).`,
    `   Only a bounded excerpt is injected. Run /obsidian-router:hot-compact (full backup, then rewrite ≤ ~${targetTokens} tokens).`,
  ].join('\n');
}
