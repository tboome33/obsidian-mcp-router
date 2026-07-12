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
