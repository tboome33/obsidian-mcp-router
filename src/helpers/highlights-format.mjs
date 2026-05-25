/**
 * Highlights formatter for the ingestion pipeline. Phase F (v0.14.x) of
 * the [[obsidian-clipper]] borrowing roadmap.
 *
 * What a "highlight" is:
 *   A user-selected text span on a web page that the user wants to
 *   preserve as a referenceable annotation in their wiki. Each highlight
 *   carries:
 *     - `text`       — the selected substring (mandatory)
 *     - `color`      — a label like `yellow`/`pink`/`blue` (default `yellow`)
 *     - `note`       — optional comment the user attached
 *     - `xpath`      — DOM path to the parent element (for future
 *                      re-hydration via a browser extension or Bridge)
 *     - `offset_start`, `offset_end` — character offsets inside the
 *                      `xpath`-pointed element (also for re-hydration)
 *     - `id`         — short stable id (we generate sha256(text|xpath)
 *                      slice if absent so callouts get a `^id` anchor
 *                      that lets Obsidian link to them)
 *
 * Dual format produced (both written to the source page):
 *
 *   1. **Inline callout** in the markdown body — Obsidian-native,
 *      human-readable, links elsewhere via `[[page#^id]]`:
 *      ```
 *      > [!highlight] color=yellow
 *      > Selected text appears here verbatim
 *      > (note: optional user comment)
 *      > ^h-abc123
 *      ```
 *
 *   2. **Frontmatter array** — machine-readable, schema-compatible with
 *      obsidian-clipper's `highlights:` field so future re-ingestion or
 *      bridge re-hydration can round-trip:
 *      ```yaml
 *      highlights:
 *        - id: h-abc123
 *          text: "Selected text appears here verbatim"
 *          color: yellow
 *          note: "optional user comment"
 *          xpath: "/html/body/article/p[3]"
 *          offset_start: 42
 *          offset_end: 96
 *      ```
 *
 * The two views are kept in sync: `serializeHighlights` writes both,
 * `parseHighlights` reads the frontmatter array (the callouts are
 * presentation, the frontmatter is the source of truth).
 *
 * Phase F MVP scope:
 *   - Pure formatting helpers. No bridge endpoint, no XPath rendering,
 *     no Obsidian overlay (all deferred to Phase G).
 *   - User feeds highlights manually (paste a structured list, or the
 *     wiki-ingest skill prompts for them). Automated extraction via a
 *     browser extension is the Phase #9 idea documented in the
 *     [[obsidian-clipper]] brainstorming page.
 *
 * @module highlights-format
 */

import crypto from 'node:crypto';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/**
 * Obsidian-renderable callout colors. These are the strings that
 * `[!highlight] color=<X>` accepts in the user's vault snippets (or
 * default highlight CSS). We don't enforce — we just use the value
 * the user passes — but the helper documents what's expected.
 *
 * Compat with obsidian-clipper schema: same labels.
 */
export const RECOGNIZED_COLORS = Object.freeze([
  'yellow',
  'pink',
  'blue',
  'green',
  'orange',
  'purple',
  'red',
]);

const DEFAULT_COLOR = 'yellow';

// -----------------------------------------------------------------------------
// Serialization — highlight object → callout markdown + frontmatter entry
// -----------------------------------------------------------------------------

/**
 * Normalize one user-supplied highlight into the canonical shape. Adds
 * derived fields:
 *   - `id` (generated from sha256 of `text|xpath` if missing — 8-char hex)
 *   - `color` defaults to `yellow`
 *
 * Throws if `text` is missing/blank (every other field is optional).
 *
 * @param {object} raw
 * @returns {{
 *   id: string,
 *   text: string,
 *   color: string,
 *   note: string|null,
 *   xpath: string|null,
 *   offset_start: number|null,
 *   offset_end: number|null,
 * }}
 */
export function normalizeHighlight(raw = {}) {
  if (raw == null || typeof raw !== 'object') {
    throw new Error('normalizeHighlight: input must be an object');
  }
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (!text) {
    throw new Error('normalizeHighlight: `text` is required and must be non-empty');
  }

  const xpath = typeof raw.xpath === 'string' && raw.xpath.trim() ? raw.xpath.trim() : null;

  // Stable id: prefix `h-` to make it greppable + Obsidian-block-id
  // friendly (block ids can't start with a digit alone — `h-…` always
  // satisfies the `[A-Za-z][A-Za-z0-9-]*` shape).
  let id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(id)) {
    // Fall back to hash of (text + xpath) — same inputs always produce
    // the same id, so re-ingestion is idempotent. 8 hex chars = 32 bits,
    // collision probability is negligible for the dozen-to-hundred
    // highlights a single page would have.
    const seed = `${text}|${xpath || ''}`;
    id = `h-${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 8)}`;
  }

  const color = typeof raw.color === 'string' && raw.color.trim()
    ? raw.color.trim().toLowerCase()
    : DEFAULT_COLOR;

  const note = typeof raw.note === 'string' && raw.note.trim() ? raw.note.trim() : null;

  const offset_start = Number.isInteger(raw.offset_start) && raw.offset_start >= 0
    ? raw.offset_start
    : null;
  const offset_end = Number.isInteger(raw.offset_end) && raw.offset_end >= 0
    ? raw.offset_end
    : null;

  return { id, text, color, note, xpath, offset_start, offset_end };
}

/**
 * Render one normalized highlight as an Obsidian `[!highlight]` callout.
 *
 * Format:
 *   ```
 *   > [!highlight] color=<color>
 *   > <text line 1>
 *   > <text line 2…>
 *   > (note: <user note>)        ← only if note non-null
 *   > ^<id>
 *   ```
 *
 * Multi-line text: each line gets its own `> ` prefix, preserving the
 * original line breaks the user selected. Blank lines inside the
 * selection are emitted as `>` (empty quoted line) so Obsidian renders
 * them as paragraph breaks inside the callout instead of terminating it.
 *
 * @param {object} highlight — already-normalized via `normalizeHighlight`
 * @returns {string} — markdown callout, NO trailing newline
 */
export function renderCallout(highlight) {
  const lines = [`> [!highlight] color=${highlight.color}`];
  for (const line of String(highlight.text).split(/\r?\n/)) {
    lines.push(line === '' ? '>' : `> ${line}`);
  }
  if (highlight.note) {
    lines.push(`> (note: ${highlight.note})`);
  }
  lines.push(`> ^${highlight.id}`);
  return lines.join('\n');
}

/**
 * Render an array of highlights as a YAML-array suitable for the
 * source page's `highlights:` frontmatter field.
 *
 * Returns the YAML lines as a string ready to drop into the frontmatter
 * block — the caller is responsible for placing it inside the `---`
 * fences and aligning with other keys. Example output:
 *
 *   ```
 *   highlights:
 *     - id: h-abc12345
 *       text: "First selected span"
 *       color: yellow
 *       xpath: "/html/body/article/p[3]"
 *       offset_start: 42
 *       offset_end: 96
 *     - id: h-def67890
 *       text: "Second span\nwith line break"
 *       color: pink
 *       note: "matches lecture point"
 *   ```
 *
 * Compat: same field shape as obsidian-clipper schema, so a future
 * round-trip (export → import) preserves the structure.
 *
 * @param {object[]} highlights — array of normalized highlight objects
 * @returns {string} — YAML lines (no leading/trailing newline)
 */
export function renderFrontmatterArray(highlights) {
  if (!Array.isArray(highlights) || highlights.length === 0) return 'highlights: []';

  const lines = ['highlights:'];
  for (const h of highlights) {
    lines.push(`  - id: ${h.id}`);
    lines.push(`    text: ${yamlScalar(h.text)}`);
    lines.push(`    color: ${h.color}`);
    if (h.note) lines.push(`    note: ${yamlScalar(h.note)}`);
    if (h.xpath) lines.push(`    xpath: ${yamlScalar(h.xpath)}`);
    if (h.offset_start !== null) lines.push(`    offset_start: ${h.offset_start}`);
    if (h.offset_end !== null) lines.push(`    offset_end: ${h.offset_end}`);
  }
  return lines.join('\n');
}

/**
 * Top-level serializer — takes raw user input, returns both views.
 *
 * Use from `wiki-ingest` skill when the user provides highlights:
 *   ```js
 *   const { calloutBlocks, frontmatterYaml } = serializeHighlights(userInput);
 *   // Insert calloutBlocks under a "## Highlights" H2 in the body.
 *   // Insert frontmatterYaml between the --- fences.
 *   ```
 *
 * @param {object[]} rawHighlights
 * @returns {{
 *   normalized: object[],          // canonical-shape array
 *   calloutBlocks: string,         // markdown blocks separated by blank lines
 *   frontmatterYaml: string,       // YAML lines for `highlights:` field
 * }}
 */
export function serializeHighlights(rawHighlights) {
  const normalized = (Array.isArray(rawHighlights) ? rawHighlights : []).map(normalizeHighlight);
  const calloutBlocks = normalized.map(renderCallout).join('\n\n');
  const frontmatterYaml = renderFrontmatterArray(normalized);
  return { normalized, calloutBlocks, frontmatterYaml };
}

// -----------------------------------------------------------------------------
// Parsing — read the frontmatter array back (round-trip support)
// -----------------------------------------------------------------------------

/**
 * Parse a frontmatter `highlights:` value back into normalized objects.
 *
 * The frontmatter array is the source of truth; the body callouts are
 * regenerated from it. So this is the "load" side for any operation
 * that wants to inspect or modify existing highlights.
 *
 * Accepts the value the YAML parser hands us — either an array of
 * objects (the normal case) or `null`/`undefined`/empty (no highlights
 * filed yet). Coerces each entry through `normalizeHighlight` so the
 * caller always gets the canonical shape, even if a raw write skipped
 * some derived fields.
 *
 * @param {Array<object>|null|undefined} value
 * @returns {object[]}
 */
export function parseHighlights(value) {
  if (!value) return [];
  if (!Array.isArray(value)) {
    throw new Error('parseHighlights: expected an array, got ' + typeof value);
  }
  return value.map(normalizeHighlight);
}

// -----------------------------------------------------------------------------
// YAML scalar helper (single-line strings only — multiline → escaped)
// -----------------------------------------------------------------------------

/**
 * Render a string as a YAML scalar. Strategy:
 *   - If the string is "safe" (no `: # & * ! | > ' " % @`, no leading/
 *     trailing whitespace, no newlines), emit unquoted.
 *   - Otherwise quote with `"..."`, escape `\\` `"` `\n` `\r` `\t`.
 *
 * We don't use YAML's block-scalar `|` form because it complicates
 * round-trip — the offset_start/offset_end need to point into a
 * deterministic representation. The double-quoted-with-escape form
 * is unambiguous.
 */
function yamlScalar(s) {
  const str = String(s);
  if (str === '') return '""';

  // Conservative "safe unquoted" allowlist: only emit bare if the entire
  // string is letters/digits/dots/underscores/hyphens/spaces (and doesn't
  // start with a reserved indicator). Anything else is double-quoted.
  //
  // Why so strict: YAML's unquoted plain-scalar rules are exception-heavy
  // (special handling for `:`, `#`, leading indicators, ambiguity with
  // flow indicators `[]{}`, etc.). Trying to enumerate "what's safe
  // unquoted" produces footguns — the v0.14.4 author originally allowed
  // strings containing `\` and `"`, which YAML parsers either reject or
  // interpret as literal characters (so `"hi"` round-trips as `"hi"`
  // WITH the quotes, not without). Allowlisting a tame character class
  // is safer than denylisting hostile chars.
  if (
    /^[A-Za-z0-9_.\/\- ]+$/.test(str) &&
    !/^[\s\-?:]/.test(str) &&
    !/[\s]$/.test(str)
  ) {
    return str;
  }

  // Double-quoted form with standard escapes.
  return (
    '"' +
    str
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t') +
    '"'
  );
}
