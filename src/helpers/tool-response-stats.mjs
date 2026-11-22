/**
 * HOW HEAVY ARE THE ROUTER'S ANSWERS, TOOL BY TOOL — measured, not guessed.
 *
 * Phase 0 of the RTK borrowing roadmap (vault page `rtk-roadmap`). Every later
 * phase — compact JSON, lighter search responses, a budget for fan-out
 * searches, a shorter tool catalogue — is a bet on where the bytes go. This
 * module answers that question from the record the client already keeps: a
 * Claude Code transcript holds every tool call and the exact text the model
 * received back. Nothing has to be added to the server to start measuring.
 *
 * WHAT IT NEVER DOES: return, log or store the CONTENT of a response. It reads
 * text in order to count it and keeps only numbers. A summary built here can
 * be pasted into a note or an issue without carrying a single word of a vault.
 *
 * THE UNIT IS THE BYTE, NOT THE TOKEN. No tokenizer for the target model is
 * available offline, and a token figure derived from bytes would read as a
 * measurement while being an assumption. Sizes are UTF-8 bytes of the text the
 * model received; a token count is a separate measurement this module does not
 * pretend to make.
 *
 * Pure functions only: no filesystem, no clock. The CLI that walks the
 * transcript store is `scripts/measure-tool-responses.mjs`.
 */

import { cmp } from './total-order.mjs';

/**
 * The two names the router's tools reach a Claude Code model under: the
 * plugin's (`mcp__plugin_obsidian-router_router__search`) and a hand-declared
 * server called `obsidian-router` (`mcp__obsidian-router__search`). Anything
 * else — another MCP server, a built-in tool — is not the router's to count.
 */
export const DEFAULT_TOOL_MATCHER = /^mcp__(?:plugin_obsidian-router_router|obsidian-router)__(.+)$/;

/**
 * The short tool name (`search`) for a full tool-use name, or null when the
 * name is not one of the router's.
 *
 * @param {string} name
 * @param {RegExp} [matcher] must capture the short name in group 1
 * @returns {string | null}
 */
export function routerToolName(name, matcher = DEFAULT_TOOL_MATCHER) {
  if (typeof name !== 'string') return null;
  const m = matcher.exec(name);
  return m && m[1] ? m[1] : null;
}

// Claude Code's own message when a result is too large to show: the text the
// model receives instead of the result. The count is printed with the
// machine's locale, so the digits may be grouped by a space, a no-break space
// (U+00A0), a narrow no-break space (U+202F), a comma or a dot.
const DIVERTED_RE = /^Error: result \(([\d\s  ,.]+) characters? across [\d\s  ,.]+ lines?\) exceeds maximum allowed tokens\b/;
const SAVED_PATH_RE = /Output has been saved to (.+?\.txt)\b/;

/**
 * Recognises the client's "this result was too large, it is in a file" stand-in.
 *
 * @param {string} text
 * @returns {{ originalChars: number, savedPath: string | null } | null}
 */
export function parseDiverted(text) {
  if (typeof text !== 'string') return null;
  const m = DIVERTED_RE.exec(text);
  if (!m) return null;
  const digits = m[1].replace(/\D/g, '');
  const saved = SAVED_PATH_RE.exec(text);
  return {
    originalChars: digits ? Number(digits) : NaN,
    savedPath: saved ? saved[1] : null,
  };
}

/**
 * The text a model received from one tool result, and how many non-text blocks
 * (images, mostly) came with it. A result's `content` is either one string or
 * an array of typed blocks.
 *
 * @param {unknown} content
 * @returns {{ text: string, otherBlocks: number }}
 */
export function resultText(content) {
  if (typeof content === 'string') return { text: content, otherBlocks: 0 };
  if (!Array.isArray(content)) return { text: '', otherBlocks: 0 };
  let text = '';
  let otherBlocks = 0;
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') text += block.text;
    else otherBlocks += 1;
  }
  return { text, otherBlocks };
}

/**
 * Measures one response text. `compactBytes` is what the same JSON would weigh
 * serialised without indentation — the Phase 1 question — and is null when the
 * text is not a JSON object or array, because then there is nothing to compact.
 * `pretty` says whether the text is exactly the router's 2-space rendering of
 * its own value, which is how the router serialises today.
 *
 * @param {string} text
 * @returns {{ bytes: number, compactBytes: number | null, pretty: boolean }}
 */
export function measureText(text) {
  const bytes = Buffer.byteLength(text, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { bytes, compactBytes: null, pretty: false };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { bytes, compactBytes: null, pretty: false };
  }
  return {
    bytes,
    compactBytes: Buffer.byteLength(JSON.stringify(parsed), 'utf8'),
    pretty: JSON.stringify(parsed, null, 2) === text,
  };
}

/**
 * Pulls the router's tool calls and their results out of transcript lines.
 *
 * One record per tool-use id, the first one seen: a resumed session copies
 * earlier lines into its file again, and counting a copy twice would inflate
 * the very numbers this exists to make honest. The caller passes ONE `state`
 * through every file so the de-duplication spans the whole store.
 *
 * @param {Iterable<string>} lines raw JSONL lines of one transcript
 * @param {object} state shared across files: `{ pending: Map, seen: Set, records: [], unparsable: number }`
 * @param {{ matcher?: RegExp }} [opts]
 */
export function collectFromLines(lines, state, { matcher = DEFAULT_TOOL_MATCHER } = {}) {
  for (const line of lines) {
    // Cheap filter before the parse: a transcript is mostly lines that are
    // neither a tool call nor a tool result.
    const maybeUse = line.includes('"tool_use"');
    const maybeResult = line.includes('"tool_result"');
    if (!maybeUse && !maybeResult) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      state.unparsable += 1;
      continue;
    }
    const blocks = entry?.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block?.type === 'tool_use') {
        const tool = routerToolName(block.name, matcher);
        if (tool && typeof block.id === 'string' && !state.seen.has(block.id)) {
          state.pending.set(block.id, tool);
        }
      } else if (block?.type === 'tool_result') {
        const id = block.tool_use_id;
        const tool = state.pending.get(id);
        if (!tool) continue;
        state.pending.delete(id);
        state.seen.add(id);
        const { text, otherBlocks } = resultText(block.content);
        state.records.push({
          tool,
          isError: block.is_error === true,
          otherBlocks,
          diverted: parseDiverted(text),
          ...measureText(text),
        });
      }
    }
  }
  return state;
}

/** A fresh accumulator for `collectFromLines`. */
export function newState() {
  return { pending: new Map(), seen: new Set(), records: [], unparsable: 0 };
}

function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, i)];
}

/**
 * Per-tool totals, heaviest first. A diverted result is counted at the size
 * the model actually received (the short stand-in), and separately at the size
 * it would have had, when the caller could recover it (`fullBytes`, set by the
 * CLI from the saved file). Both are reported because both matter: the first
 * is what the conversation paid, the second is what the tool produced.
 *
 * @param {Array<object>} records
 * @returns {Array<object>}
 */
export function summarize(records) {
  const byTool = new Map();
  for (const r of records) {
    if (!byTool.has(r.tool)) byTool.set(r.tool, []);
    byTool.get(r.tool).push(r);
  }
  const rows = [];
  for (const [tool, list] of byTool) {
    const sizes = list.map((r) => r.bytes).sort((a, b) => a - b);
    const json = list.filter((r) => r.compactBytes !== null);
    const diverted = list.filter((r) => r.diverted);
    rows.push({
      tool,
      calls: list.length,
      errors: list.filter((r) => r.isError).length,
      diverted: diverted.length,
      divertedRecovered: diverted.filter((r) => Number.isFinite(r.fullBytes)).length,
      divertedFullBytes: diverted.reduce((n, r) => n + (Number.isFinite(r.fullBytes) ? r.fullBytes : 0), 0),
      // Compact size of the recovered diverted results that are JSON — the
      // Phase 1 question asked about the responses too large to be shown.
      divertedFullCompactBytes: diverted.reduce(
        (n, r) => n + (Number.isFinite(r.fullCompactBytes) ? r.fullCompactBytes : 0), 0),
      divertedFullJsonBytes: diverted.reduce(
        (n, r) => n + (Number.isFinite(r.fullCompactBytes) ? r.fullBytes : 0), 0),
      bytes: sizes.reduce((n, b) => n + b, 0),
      median: quantile(sizes, 0.5),
      p95: quantile(sizes, 0.95),
      max: sizes.length ? sizes[sizes.length - 1] : 0,
      jsonCalls: json.length,
      prettyCalls: json.filter((r) => r.pretty).length,
      jsonBytes: json.reduce((n, r) => n + r.bytes, 0),
      compactBytes: json.reduce((n, r) => n + r.compactBytes, 0),
    });
  }
  // Ties broken by the repository's one total order, never by a locale: the
  // same record must print the same table on every machine.
  return rows.sort((a, b) => b.bytes - a.bytes || cmp(a.tool, b.tool));
}
