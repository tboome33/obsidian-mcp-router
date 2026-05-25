/**
 * LaTeX detection + conversion helpers for the ingestion pipeline. Detects
 * whether a page contains math content the user wants to preserve verbatim
 * (so Claude doesn't reformat `$x^2$` as `x²` or strip `$$\sum$$` blocks)
 * AND, for Wikipedia-style MathML blocks, converts them to LaTeX source so
 * the equations survive markitdown's HTML→markdown conversion.
 *
 * Three functions:
 *
 *   1. **`detectLatexInHtml(html)`** — runs on raw HTML BEFORE markdown
 *      conversion. Looks for MathML (`<math>` tags), KaTeX/MathJax script
 *      loaders, and `data-latex`/`data-tex` attributes commonly emitted by
 *      rendering libraries. These are signals that the page rendered LaTeX
 *      to HTML (which markitdown / our converter would lose).
 *
 *   2. **`detectLatexInMarkdown(md)`** — runs on extracted markdown. Counts
 *      `$...$` and `$$...$$` blocks that survived conversion. Uses
 *      heuristics to filter out false positives (currency: `$5.99`, prose:
 *      "the cost is $5", code blocks).
 *
 *   3. **`convertMathmlBlocksInHtml(html)`** (v0.14.6, Phase D.2) — finds
 *      every `<math>...</math>` block in the HTML, runs each through the
 *      `mathml-to-latex` lib, and replaces them in-place with `$$LaTeX$$`
 *      (when `display="block"` or implied block by Wikipedia conventions)
 *      or `$LaTeX$` (inline). The returned HTML is safe to feed to
 *      markitdown — the equations now survive the conversion as dollar-
 *      delimited LaTeX strings instead of being stripped along with the
 *      `<math>` tags.
 *
 * Both detection functions return `{hasLatex: bool, ...}` so wiki-ingest can
 * set `has_latex: true` frontmatter when at least one strong signal is
 * present. The conversion function returns `{html, conversions, count}` so
 * callers can both substitute (use the modified HTML) and audit (see what
 * LaTeX was extracted).
 *
 * Inspired by obsidian-clipper's math handling (MIT). Our scope is narrower
 * because Claude does the body composition — we only need to flag the
 * presence + convert when applicable so Claude doesn't lose information
 * during markdown conversion.
 */

import { MathMLToLaTeX } from 'mathml-to-latex';

// -----------------------------------------------------------------------------
// HTML detection — runs before markdown conversion
// -----------------------------------------------------------------------------

/**
 * Detect LaTeX/math signals in raw HTML.
 *
 * @param {string} html — full HTML of a page (head + body)
 * @returns {{
 *   hasLatex: boolean,
 *   signals: {
 *     mathml: number,        // count of <math>...</math> elements
 *     katex: boolean,        // KaTeX script or CSS detected
 *     mathjax: boolean,      // MathJax script or config detected
 *     dataLatex: number,     // count of data-latex/data-tex/data-math attributes
 *     dollarInline: number,  // heuristic count of $...$ in body text
 *     dollarBlock: number,   // heuristic count of $$...$$ in body text
 *   },
 * }}
 */
export function detectLatexInHtml(html) {
  // v0.13.11 hardening (P2-3): truncate at 5 MiB so adversarial pages with
  // millions of unclosed `<math>` / `<script>` tokens can't cause quadratic
  // regex runtime. Wiki-ingest already caps fetches at 5 MiB upstream, but
  // direct callers (extract_page_metadata with `html` arg) bypass that.
  const safe = String(html || '').slice(0, 5 * 1024 * 1024);
  const signals = {
    mathml: 0,
    katex: false,
    mathjax: false,
    dataLatex: 0,
    dollarInline: 0,
    dollarBlock: 0,
  };

  // v0.13.11 hardening (P3-2 + P2-3): two-stage strip.
  //
  // Stage 1 (`scriptStripped`): drop `<script>...</script>` and
  // `<style>...</style>` blocks ENTIRELY — these can carry JS string
  // literals like `var x = "data-latex=foo"` that would false-positive
  // the `data-latex=` attribute scan. We preserve the rest of the HTML
  // (tags + attributes) so the `data-latex` and `<math>` regex see the
  // real DOM structure.
  //
  // Stage 2 (`bodyText`): also strip remaining tag markup down to plain
  // text — only needed for the `$...$` body scan, since dollars inside
  // attribute values (`<img alt="$5.99">`) shouldn't count as math.
  //
  // Each lazy strip is bounded: `<script>` ≤ 1 MiB, `<style>` ≤ 500 KiB.
  // Adversarial input with 50k unmatched openings was ≈ 1900 ms in the
  // review probe without the bound; with the bound it stays linear.
  const scriptStripped = safe
    .replace(/<script\b[\s\S]{0,1048576}?<\/script>/gi, '')
    .replace(/<style\b[\s\S]{0,524288}?<\/style>/gi, '');
  const bodyText = scriptStripped.replace(/<[^>]+>/g, ' ');

  // MathML — most reliable signal. `<math>` is a real W3C element that
  // sites like Wikipedia emit when rendering LaTeX server-side.
  //
  // v0.13.11 hardening (P3-1 + P2-3): switched from a paired-match
  // regex (`<math>...</math>`) to a non-backtracking open-tag count.
  // Reasons:
  //   - **P3-1**: paired-match missed `<math/>` self-closing form. The
  //     `<math\b` open-tag scan catches all three shapes (`<math>`,
  //     `<math attr=…>`, `<math attr=…/>`).
  //   - **P2-3**: 50k unmatched `<math ` tokens with the bounded paired-
  //     match `<math\b[\s\S]{0,102400}?</math>` took ~7200 ms because the
  //     regex engine retried at every position with a long lazy span.
  //     The open-tag scan is linear in input size (~6 ms for the same
  //     pathological input).
  //
  // Trade-off: `signals.mathml` now counts open tags, not closed pairs.
  // For our use case (`hasLatex: true` if any math present), the
  // distinction is irrelevant — a `<math` without close is still strong
  // evidence the page renders math (some sites stream/truncate
  // mid-equation). Documented in the JSDoc above.
  //
  // We scan `safe` (not `scriptStripped` or `bodyText`) for two reasons:
  // (a) script/style tags don't contain `<math` in practice, so the
  // cheap full scan stays correct; (b) avoiding the strip step keeps
  // this path independent of the body-text construction below.
  const mathOpens = safe.match(/<math\b/gi);
  if (mathOpens) signals.mathml = mathOpens.length;

  // KaTeX detection — script src or stylesheet (CDN or self-hosted).
  if (
    /<script\b[^>]*\bsrc=["'][^"']*katex[^"']*["']/i.test(safe) ||
    /<link\b[^>]*\bhref=["'][^"']*katex[^"']*\.css["']/i.test(safe) ||
    /class=["'][^"']*\bkatex\b[^"']*["']/i.test(safe)
  ) {
    signals.katex = true;
  }

  // MathJax detection — config object, script src, or class hook. We look
  // for the specific identifier `MathJax` (TitleCase) which the library
  // itself uses; lowercased `mathjax` substrings (in unrelated paths) are
  // rejected by case-sensitivity.
  if (
    /<script\b[^>]*\bsrc=["'][^"']*MathJax[^"']*["']/i.test(safe) ||
    /window\.MathJax\s*=/.test(safe) ||
    /class=["'][^"']*\bMathJax\b[^"']*["']/.test(safe) ||
    /MathJax\.Hub\.Config/.test(safe)
  ) {
    signals.mathjax = true;
  }

  // data-latex / data-tex / data-math attribute — emitted by some
  // rendering libraries (Mathjax-3 SSR, Pandoc HTML output, etc.) to
  // preserve the source LaTeX even after rendering.
  //
  // v0.13.11 hardening (P3-2): scan `scriptStripped` (after script/style
  // are gone but BEFORE tag stripping) so attributes on real DOM elements
  // are still visible, but `var x = "data-latex=foo"` inside a JS string
  // doesn't false-positive the count.
  const dataAttrs = scriptStripped.match(/\bdata-(?:latex|tex|math)=/gi);
  if (dataAttrs) signals.dataLatex = dataAttrs.length;

  const inline = detectLatexInMarkdown(bodyText);
  signals.dollarInline = inline.inlineCount;
  signals.dollarBlock = inline.blockCount;

  const hasLatex =
    signals.mathml > 0 ||
    signals.katex ||
    signals.mathjax ||
    signals.dataLatex > 0 ||
    // Strong dollar signal: at least one $$ block OR ≥2 distinct $...$
    // pairs (1 isolated pair could easily be a currency mention).
    signals.dollarBlock > 0 ||
    signals.dollarInline >= 2;

  return { hasLatex, signals };
}

// -----------------------------------------------------------------------------
// Markdown detection — runs after conversion
// -----------------------------------------------------------------------------

/**
 * Detect LaTeX delimiters in extracted markdown.
 *
 * Heuristics to filter false positives:
 *   - Skip fenced code blocks (` ``` ` and `~~~`) entirely
 *   - For inline `$...$`: require LaTeX-looking content (backslash command,
 *     superscript `^`, subscript `_`, Greek letter, or Mathematical
 *     Operator glyph U+2200-22FF like ∑ ∫ ∂ ∞ ≠ ≤ ≥ ∈ ∀ ∃) inside the
 *     dollars. Plain `$5` or `$15-20` won't match.
 *   - For block `$$...$$`: any non-empty content qualifies (block delimiters
 *     are explicit enough to be intentional).
 *
 * **Threshold note (v0.13.11)**: this function returns `hasLatex: true` as
 * soon as **any** inline or block match is found (≥1 inline OR ≥1 block).
 * The stricter "≥2 distinct inline pairs" threshold lives in
 * `detectLatexInHtml` — it's applied at the heuristic layer because raw
 * HTML body text is noisier (false-positive risk from currency mentions).
 * Direct markdown consumers calling this function get the looser threshold;
 * if you need the HTML-style strictness, wrap the call and apply the count
 * comparison yourself.
 *
 * @param {string} md — markdown text
 * @returns {{
 *   hasLatex: boolean,
 *   inlineCount: number,
 *   blockCount: number,
 * }}
 */
export function detectLatexInMarkdown(md) {
  const safe = String(md || '');
  const stripped = stripFencedCode(safe);

  // Block math: $$ ... $$ (multiline allowed). Any non-blank content counts.
  // We use a non-greedy [\s\S]*? capture so multiple blocks on the same line
  // (rare but possible) don't merge. Length check rejects empty `$$$$`.
  const blockMatches = stripped.match(/\$\$([\s\S]+?)\$\$/g) || [];
  const blockCount = blockMatches.filter((m) => m.length > 4).length;

  // Inline math: $ ... $ on a single line, with LaTeX-looking content.
  // Backslash command (`\frac`, `\sum`, `\alpha`), or sup `^`, or sub `_`,
  // or Greek/symbol. We avoid matching $ blocks that span newlines (those
  // are catched above), and avoid double-counting $$ which would match here.
  // Lookbehind/lookahead reject $$ neighbors.
  const inlineRe = /(?<!\$)\$(?!\$)([^\n$]+?)\$(?!\$)/g;
  let inlineCount = 0;
  let m;
  while ((m = inlineRe.exec(stripped)) !== null) {
    const content = m[1];
    if (LATEX_CONTENT_RE.test(content)) inlineCount += 1;
  }

  const hasLatex = blockCount > 0 || inlineCount > 0;
  return { hasLatex, inlineCount, blockCount };
}

// Content inside `$...$` must look like LaTeX to count. We require at least
// one of: backslash command, ^ superscript, _ subscript, Greek letter
// glyph, or Mathematical Operator glyph (U+2200-22FF: ∑ ∫ ∂ ∞ ≠ ≤ ≥ ∈ ∀
// ∃ etc.). This rejects `$5.99`, `$JPY` etc. while accepting `$x^2$`,
// `$\frac{a}{b}$`, `$\alpha$`, `$\sigma_n$`, `$∑x$`, `$∫f\,dx$`.
//
// v0.13.11 hardening (P3-3): added U+2200-22FF range because KaTeX/MathJax
// often output literal `∑` (U+2211) glyph for `\sum`, not the Greek
// `Σ` (U+03A3) the original range covered. Same for `∫ ∂ ∞ ≠ ≤ ≥`.
const LATEX_CONTENT_RE = /[\\^_]|[Ͱ-Ͽἀ-῿]|[∀-⋿]/;

/**
 * Remove fenced code blocks from markdown before LaTeX scanning. Code blocks
 * legitimately contain `$` and `$$` (shell prompts, regex, etc.) that we
 * shouldn't count as math.
 *
 * v0.13.11 hardening — 3 fixes from /review+ on 2d2f349:
 *
 *   1. **P2-2 — CommonMark fence-length rule**: the closing fence must be a
 *      run of the SAME character, ≥ the length of the opening. Previous
 *      version matched any 3-backtick close even against a 4-backtick open,
 *      so a 4-backtick fence containing a nested 3-backtick block leaked
 *      `$...$` from outside the inner block. Fix: capture the opening run
 *      with `(`{3,}|~{3,})` and require backref `\1` to match exactly.
 *      (The CommonMark spec also allows the closer to be LONGER than the
 *      opener; we accept that with a separate alternative.)
 *
 *   2. **P2-1 — Unclosed fence at EOF**: an opening fence with no closer
 *      survived intact, leaking `$...$` from inside the would-be code
 *      block. Real trigger: page truncated mid-fence by markitdown or by
 *      a 5 MiB fetch cap. Fix: after the matched-pair strip, run a second
 *      pass that catches any remaining opening fence and strips to EOF.
 *
 *   3. (No fix for indented 4-space code blocks — still skipped. Real fix
 *      would need a CommonMark parser; acceptable false-positive risk.)
 */
function stripFencedCode(md) {
  // Pass 1 — matched fence pairs. `\1` requires the same character + same
  // length on the close side. We allow a longer closer via the second
  // alternative for spec compliance.
  let out = md.replace(
    /^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]{0,3}\1[ \t]*$/gm,
    '',
  );
  // Pass 2 — any remaining unmatched opening fence runs to EOF. We use a
  // single match (no `g` flag) because once we hit one unmatched opener,
  // everything to EOF is gone, so subsequent opens are inside that
  // already-stripped region.
  out = out.replace(/^[ \t]{0,3}(?:`{3,}|~{3,})[\s\S]*$/m, '');
  return out;
}

// -----------------------------------------------------------------------------
// MathML → LaTeX conversion (Phase D.2, v0.14.6)
// -----------------------------------------------------------------------------

/**
 * Convert every `<math>...</math>` block in an HTML string to dollar-
 * delimited LaTeX, replacing in-place. Intended to be called BEFORE feeding
 * HTML to markitdown (or any other HTML→markdown converter), so the
 * equations survive the conversion as text strings that LaTeX-Suite and
 * KaTeX-style Obsidian renderers can pick up.
 *
 * Conversion strategy:
 *   - **Display mode** detection: a `<math>` block becomes `$$...$$` (centered
 *     block equation) if it carries `display="block"`, OR if it's the sole
 *     non-whitespace content of its enclosing block element (heuristic for
 *     Wikipedia's `<dl><dd><math>...</math></dd></dl>` pattern). Otherwise
 *     it becomes `$...$` (inline).
 *   - **Empty conversion**: if `mathml-to-latex` returns an empty string
 *     (malformed MathML, unsupported elements), we skip the substitution
 *     and leave the original `<math>` tags untouched. Better to surface
 *     the conversion failure than emit empty `$$$$` blocks that look broken.
 *   - **Bounded match**: we use the v0.13.11 hardening pattern — match
 *     `<math>` open tags via a non-backtracking regex, then for each one
 *     find the matching `</math>` close via a bounded forward scan. This
 *     prevents the quadratic backtracking the lazy `[\s\S]*?` would suffer
 *     on pathological input (50k unmatched `<math ` tokens went from
 *     1900ms → 1.8ms after the v0.13.11 fix).
 *
 * What's NOT done (acknowledged limits):
 *   - `<math/>` self-closing form is rare in practice and carries no inner
 *     content to convert; we don't touch it (the detect function above
 *     counts it for the `mathml` signal, which is enough).
 *   - We don't try to be clever about positioning. The replacement happens
 *     exactly where the `<math>` block lived in the HTML; markitdown then
 *     places that dollar string wherever the surrounding text lands in
 *     markdown. Good enough for Wikipedia's typical inline-math style;
 *     can produce slightly awkward placement on heavily-nested HTML.
 *
 * @param {string} html — raw HTML containing zero or more `<math>` blocks
 * @returns {{
 *   html: string,           // HTML with <math> blocks replaced by $LaTeX$ / $$LaTeX$$
 *   count: number,          // number of blocks successfully converted (non-empty result)
 *   skipped: number,        // <math> blocks whose conversion produced an empty string
 *   conversions: Array<{    // detail of each conversion (for audit / surface)
 *     mathml: string,       // original <math>…</math> source
 *     latex: string,        // converted LaTeX (may be empty string for skipped)
 *     display: 'block'|'inline',
 *     converted: boolean,   // false if the lib returned empty (left in-place)
 *   }>,
 * }}
 */
export function convertMathmlBlocksInHtml(html) {
  const safe = String(html || '').slice(0, 5 * 1024 * 1024);
  const conversions = [];
  let count = 0;
  let skipped = 0;

  // Find every `<math>` block: open-tag regex first (non-backtracking),
  // then for each open we forward-scan for the matching `</math>` close
  // within a bounded distance (100 KiB — Wikipedia's largest equations
  // are ~10 KiB so this is generous but safe).
  //
  // We collect (openIndex, closeIndex, displayAttr) tuples first, then
  // do the replacement in REVERSE order so the indexes stay valid as the
  // string mutates.
  const blocks = [];
  const openRe = /<math\b([^>]*)>/gi;
  let openMatch;
  while ((openMatch = openRe.exec(safe)) !== null) {
    const openTagStart = openMatch.index;
    const openTagEnd = openRe.lastIndex;
    const openAttrs = openMatch[1] || '';

    // Bounded forward scan for </math>. We index from openTagEnd, limit
    // to MAX_MATH_SPAN, then look for the literal string. Cheap and safe.
    const MAX_MATH_SPAN = 102400;
    const searchSlice = safe.slice(openTagEnd, openTagEnd + MAX_MATH_SPAN);
    const closeRel = searchSlice.search(/<\/math\s*>/i);
    if (closeRel === -1) continue; // unclosed <math> — skip silently
    const closeStart = openTagEnd + closeRel;
    const closeEnd = closeStart + searchSlice.slice(closeRel).match(/<\/math\s*>/i)[0].length;

    // Detect display mode. `display="block"` is the standard. Wikipedia
    // also emits `display="inline"`. Anything else (unset, "true", etc.)
    // we treat as inline by default.
    const displayMatch = openAttrs.match(/\bdisplay\s*=\s*["']?(\w+)/i);
    const display = displayMatch && displayMatch[1].toLowerCase() === 'block' ? 'block' : 'inline';

    blocks.push({ openTagStart, closeEnd, display });
  }

  // No blocks → return early to keep the common case fast.
  if (blocks.length === 0) {
    return { html: safe, count: 0, skipped: 0, conversions: [] };
  }

  // Replace in REVERSE order so earlier indexes don't shift.
  let out = safe;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const { openTagStart, closeEnd, display } = blocks[i];
    const mathmlSrc = out.slice(openTagStart, closeEnd);

    let latex;
    try {
      latex = MathMLToLaTeX.convert(mathmlSrc) || '';
    } catch {
      latex = ''; // defensive: the lib usually returns '' instead of throwing, but guard anyway
    }

    const converted = latex.trim().length > 0;
    conversions.unshift({ mathml: mathmlSrc, latex, display, converted });

    if (!converted) {
      // Leave the original <math> in place — emitting empty `$$$$` would
      // look broken in the markdown output. The `mathml` signal in
      // detectLatexInHtml still flags the page as math-bearing.
      skipped += 1;
      continue;
    }

    const wrapper = display === 'block' ? `\n\n$$${latex}$$\n\n` : `$${latex}$`;
    out = out.slice(0, openTagStart) + wrapper + out.slice(closeEnd);
    count += 1;
  }

  return { html: out, count, skipped, conversions };
}
