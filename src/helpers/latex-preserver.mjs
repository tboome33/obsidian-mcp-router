/**
 * LaTeX detection helpers for the ingestion pipeline. Detects whether a page
 * contains math content the user will want to preserve verbatim (so Claude
 * doesn't reformat `$x^2$` as `x²` or strip `$$\sum$$` blocks).
 *
 * Two complementary detectors:
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
 * Both return a structured object with `hasLatex: bool` plus signal counts so
 * the caller can decide policy (e.g. wiki-ingest setting `has_latex: true`
 * frontmatter only when at least one strong signal is present).
 *
 * **What this MVP does NOT do** (deferred to Phase D.2 if user demand):
 *   - MathML → LaTeX conversion (would need `mathml-to-latex` npm dep)
 *   - Equation image substitution (need to walk `<img alt="$..."` patterns)
 *   - Markdown post-processing to re-inject dropped LaTeX
 *
 * The MVP is detection-only because the wiki-ingest skill is the consumer:
 * if `has_latex: true` is set in frontmatter, the skill instructs Claude to
 * preserve `$...$` / `$$...$$` verbatim in the body, which is the 80% case.
 * MathML/image equations are a 20% case (Wikipedia, arxiv) that needs more
 * infrastructure.
 *
 * Inspired by obsidian-clipper's math handling (MIT). Our scope is narrower
 * because Claude does the body composition — we only need to flag the
 * presence so Claude knows not to reformat.
 */

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
  const safe = String(html || '');
  const signals = {
    mathml: 0,
    katex: false,
    mathjax: false,
    dataLatex: 0,
    dollarInline: 0,
    dollarBlock: 0,
  };

  // MathML — most reliable signal. `<math>` is a real W3C element that
  // sites like Wikipedia emit when rendering LaTeX server-side. Match with
  // or without namespace.
  const mathTags = safe.match(/<math\b[\s\S]*?<\/math>/gi);
  if (mathTags) signals.mathml = mathTags.length;

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
  const dataAttrs = safe.match(/\bdata-(?:latex|tex|math)=/gi);
  if (dataAttrs) signals.dataLatex = dataAttrs.length;

  // Dollar-delimited LaTeX in body text — heuristic. We strip tags + scripts
  // first to avoid false positives in stylesheets / data URIs.
  const bodyText = safe
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ');

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
 *     superscript `^`, subscript `_`, or Greek letter) inside the dollars.
 *     Plain `$5` or `$15-20` won't match.
 *   - For block `$$...$$`: any non-empty content qualifies (block delimiters
 *     are explicit enough to be intentional).
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
// one of: backslash command, ^ superscript, _ subscript, or Greek letter
// glyph. This rejects `$5.99`, `$JPY` etc. while accepting `$x^2$`,
// `$\frac{a}{b}$`, `$\alpha$`, `$\sigma_n$`.
const LATEX_CONTENT_RE = /[\\^_]|[Ͱ-Ͽἀ-῿]/;

/**
 * Remove fenced code blocks from markdown before LaTeX scanning. Code blocks
 * legitimately contain `$` and `$$` (shell prompts, regex, etc.) that we
 * shouldn't count as math.
 */
function stripFencedCode(md) {
  // ``` and ~~~ fences, any length ≥3, with optional language tag.
  return md
    .replace(/^[ \t]{0,3}```[\s\S]*?^[ \t]{0,3}```[ \t]*$/gm, '')
    .replace(/^[ \t]{0,3}~~~[\s\S]*?^[ \t]{0,3}~~~[ \t]*$/gm, '')
    // Indented (4-space) code blocks — harder to detect deterministically
    // without a real parser; we skip them. False positives there are
    // acceptable for this MVP.
    ;
}
