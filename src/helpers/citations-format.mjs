/**
 * citations-format — W-C of [[Crawl4AI-roadmap]]: turn a captured page's inline
 * links into numbered footnotes with a reference list at the end.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS FOR
 * ---------------------------------------------------------------------------
 * A web page converted to markdown carries its hyperlinks inline, so a
 * paragraph of ordinary prose arrives studded with `[thing](https://…)`. Two
 * costs: the prose is harder to read, and the page's REFERENCES are scattered
 * through it instead of being a list anyone can scan. Crawl4AI emits a
 * "markdown with citations" variant for exactly that reason; this is the same
 * idea, applied to the markdown the router already holds — no re-fetch.
 *
 *     before:  See the [Local REST API](https://github.com/x/y) plugin.
 *     after:   See the Local REST API[^1] plugin.
 *              …
 *              [^1]: https://github.com/x/y
 *
 * ---------------------------------------------------------------------------
 * WHAT IT REFUSES TO TOUCH, AND WHY EACH ONE MATTERS
 * ---------------------------------------------------------------------------
 *  - ANYTHING INSIDE CODE OR AN HTML COMMENT. A `[text](url)` in a fenced block
 *    is being DISPLAYED, not linked; rewriting it corrupts the example. Handled
 *    by the shared `markdown-mask` rather than a second copy of the rule.
 *  - IMAGES (`![alt](url)`). An image is an embed, not a reference: footnoting
 *    it would delete the picture.
 *  - WIKILINKS (`[[page]]`) and reference-style links (`[text][ref]`). Neither
 *    is an inline URL, and both already have their own resolution.
 *  - NON-HTTP TARGETS — `#anchor`, `./relative.md`, `mailto:`. A citation is an
 *    external reference; an in-document anchor is navigation, and converting it
 *    would break the jump it exists to make.
 *
 * ---------------------------------------------------------------------------
 * ONE NUMBER PER DESTINATION
 * ---------------------------------------------------------------------------
 * A page that links the same URL five times gets ONE footnote, cited five
 * times — which is what a reference list is for. Numbering follows first
 * appearance, so the list reads in the order the document does.
 *
 * ---------------------------------------------------------------------------
 * AN EXISTING FOOTNOTE NAMESPACE IS NOT OURS TO OVERWRITE
 * ---------------------------------------------------------------------------
 * A converted page can already contain `[^1]` (many do — it is how Wikipedia
 * markdown arrives). Numbering from 1 regardless would silently merge our
 * references into the author's. The first free integer is found by scanning the
 * document's existing definitions, and the result says which base it used.
 */

import { maskCodeAndComments } from './markdown-mask.mjs';

/** Only an absolute web URL is a citation. See the header. */
const CITABLE_SCHEME = /^https?:\/\//i;

/**
 * An INLINE link, matched on the mask: `[text](target)` not preceded by `!`
 * (image) or `]` (the tail of a wikilink). The target stops at the first
 * unescaped `)` or at whitespace introducing a title — `[a](url "Title")` is
 * legal markdown.
 *
 * `[` IS EXCLUDED FROM THE LABEL CLASS, and that is not cosmetic: with it in,
 * a run of unmatched brackets makes the match quadratic — the "bracket bomb"
 * this repo has a standing guard against since v0.71.0, which caught this
 * regex on its first run (107 ms on the guard's input). The cost is that a
 * label containing a bracket (`[see [1]](url)`) is not converted; it is left
 * inline, which is the safe direction — markdown is ambiguous there anyway.
 */
const INLINE_LINK = /(?<![!\]])(?<!\\)\[([^\]\n[]*)\]\(\s*(<[^<>\n]*>|(?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\s*\)/g;

/**
 * WHAT THE PATTERN DELIBERATELY DOES NOT MATCH, and why each is safe.
 *
 * Every gap below leaves a link INLINE — the shape it already had — so the cost
 * is a reference not collected, never a document corrupted. That asymmetry is
 * the whole reason to stop here rather than grow a CommonMark parser:
 *
 *   - a label containing `[` (`[see [1]](url)`) — excluded to keep the match
 *     linear (see above);
 *   - a label spanning a line break;
 *   - a destination with more than one level of nested parentheses;
 *   - a destination that is a reference (`[a][ref]`) or an autolink (`<url>`
 *     with no label).
 *
 * A `\[` escaped by the author is NOT a link and is now refused outright: it
 * used to be converted, turning `\[not-a-link](url)` into `\not-a-link[^1]`.
 */

/**
 * Existing footnote definitions, so a new one never lands on a used number.
 * Matched on the MASK, so a `[^99]:` merely displayed inside a code block does
 * not push our numbering to 100 and make the stats claim a namespace the page
 * never used.
 */
const EXISTING_DEFINITION = /^\[\^(\d+)\]:/gm;

/**
 * Rewrite inline links as footnotes.
 *
 * @param {string} markdown
 * @param {{heading?: string|null}} [opts] heading for the reference list;
 *   `null` emits the definitions with no heading above them.
 * @returns {{markdown: string, converted: number, references: number,
 *            skipped: number, startedAt: number}}
 *   `converted` counts link OCCURRENCES rewritten, `references` the distinct
 *   destinations they collapsed to, `skipped` the inline links left alone
 *   (non-http targets — those inside code never enter the count, because the
 *   mask means they were never seen).
 */
export function linksToFootnotes(markdown, opts = {}) {
  const heading = opts.heading === undefined ? '## References' : opts.heading;
  const empty = { markdown: typeof markdown === 'string' ? markdown : '', converted: 0, references: 0, skipped: 0, startedAt: 1 };
  if (typeof markdown !== 'string' || markdown === '') return empty;

  // Run the pattern over the MASK; cut the ORIGINAL at the offsets it reports.
  // A link inside code has been blanked, so it cannot match — no second check.
  const mask = maskCodeAndComments(markdown);

  // The first number that is free in THIS document, not necessarily 1.
  let startedAt = 1;
  for (const m of mask.matchAll(EXISTING_DEFINITION)) {
    const n = Number(m[1]);
    if (Number.isSafeInteger(n) && n >= startedAt) startedAt = n + 1;
  }

  const numberOf = new Map(); // url → footnote number
  const order = []; // url, in first-seen order
  let out = '';
  let cursor = 0;
  let converted = 0;
  let skipped = 0;

  INLINE_LINK.lastIndex = 0;
  let m;
  while ((m = INLINE_LINK.exec(mask)) !== null) {
    const [whole, , rawTarget] = m;
    const start = m.index;
    // The TEXT is taken from the original: the mask has blanked any code inside
    // the label, and the label is what gets emitted.
    const original = markdown.slice(start, start + whole.length);
    const label = original.slice(1, original.indexOf(']('));
    // An angle-bracket destination (<https://x/a b>) is the CommonMark way to
    // carry a space; the brackets are syntax, not part of the URL.
    let target = rawTarget.trim();
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1).trim();

    if (!CITABLE_SCHEME.test(target)) {
      skipped += 1;
      continue; // left byte-for-byte alone — `cursor` is not advanced past it
    }
    let n = numberOf.get(target);
    if (n === undefined) {
      n = startedAt + order.length;
      numberOf.set(target, n);
      order.push(target);
    }
    out += markdown.slice(cursor, start) + `${label}[^${n}]`;
    cursor = start + whole.length;
    converted += 1;
  }
  out += markdown.slice(cursor);

  if (order.length === 0) return { ...empty, markdown, skipped };

  const definitions = order.map((url) => `[^${numberOf.get(url)}]: ${url}`).join('\n');
  const block = heading ? `${heading}\n\n${definitions}` : definitions;
  // Exactly one blank line before the block, whatever the document ended with —
  // a converted page's trailing whitespace is not something to reproduce.
  const body = out.replace(/\s+$/, '');
  return {
    markdown: `${body}\n\n${block}\n`,
    converted,
    references: order.length,
    skipped,
    startedAt,
  };
}
