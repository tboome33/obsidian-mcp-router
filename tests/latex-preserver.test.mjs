import test from 'node:test';
import assert from 'node:assert/strict';
import { detectLatexInHtml, detectLatexInMarkdown } from '../src/helpers/latex-preserver.mjs';

// -----------------------------------------------------------------------------
// detectLatexInMarkdown
// -----------------------------------------------------------------------------

test('detectLatexInMarkdown: inline $...$ with LaTeX content is detected', () => {
  const md = 'The equation $x^2 + y^2 = z^2$ describes a circle.';
  const r = detectLatexInMarkdown(md);
  assert.equal(r.hasLatex, true);
  assert.equal(r.inlineCount, 1);
  assert.equal(r.blockCount, 0);
});

test('detectLatexInMarkdown: block $$...$$ is detected', () => {
  const md = 'See the formula:\n$$\\sum_{i=1}^n i = \\frac{n(n+1)}{2}$$\nQED.';
  const r = detectLatexInMarkdown(md);
  assert.equal(r.hasLatex, true);
  assert.equal(r.inlineCount, 0);
  assert.equal(r.blockCount, 1);
});

test('detectLatexInMarkdown: multiple blocks counted separately', () => {
  const md = '$$a+b$$ and $$c+d$$ and $$e+f$$';
  const r = detectLatexInMarkdown(md);
  assert.equal(r.blockCount, 3);
});

test('detectLatexInMarkdown: currency $5.99 is NOT detected as LaTeX', () => {
  const md = 'The book costs $5.99 and the magazine $12.';
  const r = detectLatexInMarkdown(md);
  assert.equal(r.hasLatex, false);
  assert.equal(r.inlineCount, 0);
});

test('detectLatexInMarkdown: $JPY and $USD are NOT detected', () => {
  const md = 'Prices in $JPY, $USD, and $EUR.';
  const r = detectLatexInMarkdown(md);
  assert.equal(r.hasLatex, false);
});

test('detectLatexInMarkdown: Greek letter inside $...$ counts as LaTeX', () => {
  const md = 'The angle $α$ is in radians.';
  const r = detectLatexInMarkdown(md);
  assert.equal(r.hasLatex, true);
  assert.equal(r.inlineCount, 1);
});

test('detectLatexInMarkdown: backslash command inside $...$ counts', () => {
  const md = 'Use $\\frac{1}{2}$ for fractions.';
  const r = detectLatexInMarkdown(md);
  assert.equal(r.inlineCount, 1);
});

test('detectLatexInMarkdown: subscript _ inside $...$ counts', () => {
  const md = 'The variable $x_n$ is indexed.';
  const r = detectLatexInMarkdown(md);
  assert.equal(r.inlineCount, 1);
});

test('detectLatexInMarkdown: superscript ^ inside $...$ counts', () => {
  const md = 'Compute $e^x$.';
  const r = detectLatexInMarkdown(md);
  assert.equal(r.inlineCount, 1);
});

test('detectLatexInMarkdown: $...$ inside fenced code block is ignored', () => {
  const md = '```\n$x^2$ in code\n```\nOutside: $y^2$ is math.';
  const r = detectLatexInMarkdown(md);
  assert.equal(r.inlineCount, 1, 'only the outside-code occurrence counts');
});

test('detectLatexInMarkdown: $$...$$ inside fenced code block is ignored', () => {
  const md = '```bash\n$$ # double dollar prompt\n```\nReal math: $$x+y$$';
  const r = detectLatexInMarkdown(md);
  assert.equal(r.blockCount, 1);
});

test('detectLatexInMarkdown: tilde-fenced (~~~) code block is ignored', () => {
  const md = '~~~\n$\\alpha$ in code\n~~~\nReal: $\\beta$';
  const r = detectLatexInMarkdown(md);
  assert.equal(r.inlineCount, 1);
});

test('detectLatexInMarkdown: empty/blank input returns false', () => {
  assert.equal(detectLatexInMarkdown('').hasLatex, false);
  assert.equal(detectLatexInMarkdown(null).hasLatex, false);
  assert.equal(detectLatexInMarkdown(undefined).hasLatex, false);
});

test('detectLatexInMarkdown: $$$$ empty block does not count', () => {
  const r = detectLatexInMarkdown('Before $$$$ after.');
  assert.equal(r.blockCount, 0);
});

test('detectLatexInMarkdown: mixed inline + block', () => {
  const md = 'Inline $\\pi$ and block $$\\int_0^1 x\\,dx$$ together.';
  const r = detectLatexInMarkdown(md);
  assert.equal(r.inlineCount, 1);
  assert.equal(r.blockCount, 1);
  assert.equal(r.hasLatex, true);
});

// -----------------------------------------------------------------------------
// detectLatexInHtml
// -----------------------------------------------------------------------------

test('detectLatexInHtml: <math> MathML tag is detected', () => {
  const html = '<p>Before</p><math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi></math><p>After</p>';
  const r = detectLatexInHtml(html);
  assert.equal(r.hasLatex, true);
  assert.equal(r.signals.mathml, 1);
});

test('detectLatexInHtml: multiple <math> tags counted', () => {
  const html = '<math><mi>a</mi></math> + <math><mi>b</mi></math> = <math><mi>c</mi></math>';
  const r = detectLatexInHtml(html);
  assert.equal(r.signals.mathml, 3);
});

test('detectLatexInHtml: KaTeX script src triggers katex signal', () => {
  const html = '<script src="https://cdn.jsdelivr.net/npm/katex@0.16.0/dist/katex.min.js"></script>';
  const r = detectLatexInHtml(html);
  assert.equal(r.signals.katex, true);
  assert.equal(r.hasLatex, true);
});

test('detectLatexInHtml: KaTeX class hook triggers katex signal', () => {
  const html = '<span class="katex-mathml">…</span>';
  const r = detectLatexInHtml(html);
  assert.equal(r.signals.katex, true);
});

test('detectLatexInHtml: MathJax script src triggers mathjax signal', () => {
  const html = '<script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>';
  const r = detectLatexInHtml(html);
  assert.equal(r.signals.mathjax, true);
});

test('detectLatexInHtml: window.MathJax config triggers mathjax signal', () => {
  const html = '<script>window.MathJax = { tex: { inlineMath: [["$", "$"]] } };</script>';
  const r = detectLatexInHtml(html);
  assert.equal(r.signals.mathjax, true);
});

test('detectLatexInHtml: data-latex attribute counted', () => {
  const html = '<span data-latex="\\frac{1}{2}">½</span><span data-tex="x^2">x²</span>';
  const r = detectLatexInHtml(html);
  assert.equal(r.signals.dataLatex, 2);
});

test('detectLatexInHtml: $...$ in body text contributes signals (heuristic)', () => {
  const html = '<p>Equation $x^2$ and $y^2$ and $z^2$ are squares.</p>';
  const r = detectLatexInHtml(html);
  assert.equal(r.signals.dollarInline, 3);
  assert.equal(r.hasLatex, true);
});

test('detectLatexInHtml: 1 isolated dollar pair is NOT enough alone', () => {
  // Just `$x^2$` without other signals shouldn't flag — could be a stray
  // mention. Our threshold is ≥2 distinct inline pairs OR ≥1 block.
  const html = '<p>Maybe math: $x^2$ here.</p>';
  const r = detectLatexInHtml(html);
  // We have 1 inline only, no block, no mathml/katex/mathjax/data → not enough
  assert.equal(r.signals.dollarInline, 1);
  assert.equal(r.hasLatex, false);
});

test('detectLatexInHtml: $...$ in <script> is stripped before scan', () => {
  const html = '<script>let price = "$5.99"; let other = "$10";</script><p>Plain text.</p>';
  const r = detectLatexInHtml(html);
  assert.equal(r.signals.dollarInline, 0);
});

test('detectLatexInHtml: $...$ in <style> is stripped before scan', () => {
  const html = '<style>.foo { content: "$x^2$"; }</style><p>Plain text.</p>';
  const r = detectLatexInHtml(html);
  assert.equal(r.signals.dollarInline, 0);
});

test('detectLatexInHtml: empty input returns hasLatex: false', () => {
  const r = detectLatexInHtml('');
  assert.equal(r.hasLatex, false);
  assert.equal(r.signals.mathml, 0);
  assert.equal(r.signals.katex, false);
});

test('detectLatexInHtml: combined signals — Wikipedia-style page', () => {
  // Wikipedia renders math as MathML inside the body.
  const html = `
    <html lang="en">
      <head><title>Eigenvalue</title></head>
      <body>
        <p>The characteristic equation</p>
        <math xmlns="http://www.w3.org/1998/Math/MathML">
          <mrow><mo>det</mo><mo>(</mo><mi>A</mi><mo>-</mo><mi>λ</mi><mi>I</mi><mo>)</mo></mrow>
        </math>
        <p>is solved for λ.</p>
      </body>
    </html>
  `;
  const r = detectLatexInHtml(html);
  assert.equal(r.hasLatex, true);
  assert.equal(r.signals.mathml, 1);
});

test('detectLatexInHtml: combined signals — KaTeX-rendered blog page', () => {
  const html = `
    <html>
      <head>
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16/dist/katex.min.css">
      </head>
      <body>
        <span class="katex-display"><span class="katex-mathml" data-latex="\\sum_n x_n">∑</span></span>
      </body>
    </html>
  `;
  const r = detectLatexInHtml(html);
  assert.equal(r.hasLatex, true);
  assert.equal(r.signals.katex, true);
  assert.equal(r.signals.dataLatex, 1);
});

// -----------------------------------------------------------------------------
// v0.13.11 hardening — 6 negative-case regressions from /review+ on 2d2f349
// -----------------------------------------------------------------------------

test('HARDENING P2-1: unclosed fence at EOF strips $...$ from inside', () => {
  // Page truncated mid-fence by markitdown or by a 5 MiB fetch cap. The
  // opening fence has no closer — pre-fix the regex matched-pair strip
  // skipped it, leaking `$x^2$` to the dollar scan.
  const md = '```\n$x^2$\nno close';
  const r = detectLatexInMarkdown(md);
  assert.equal(r.inlineCount, 0, 'inline inside unclosed fence must NOT count');
});

test('HARDENING P2-2: nested 4-backtick outer + 3-backtick inner fence — outer body fully stripped', () => {
  // CommonMark requires the closer to be a run of the SAME character ≥
  // length of the opener. A 4-backtick outer fence should NOT be closed
  // by a 3-backtick run inside it. Pre-fix the loose regex used the
  // inner ``` as the outer closer, leaking `$x^2$` after the inner block.
  const md = '````\nouter\n```\ninner\n```\nstill-outer $x^2$\n````\noutside: $\\beta$';
  const r = detectLatexInMarkdown(md);
  assert.equal(r.inlineCount, 1, 'only the outside-fence $\\beta$ counts; the outer-fence-body $x^2$ does not');
});

test('HARDENING P3-1: <math/> self-closing tag is detected', () => {
  // XHTML / SVG-MathML can emit `<math/>` self-closing. The original
  // `<math>...</math>` regex missed this entirely.
  const html = '<p>Before</p><math xmlns="http://www.w3.org/1998/Math/MathML"/><p>After</p>';
  const r = detectLatexInHtml(html);
  assert.equal(r.signals.mathml, 1);
  assert.equal(r.hasLatex, true);
});

test('HARDENING P3-2: data-latex= literal inside <script> string does NOT trigger dataLatex signal', () => {
  // A JS snippet that string-literals `data-latex=...` would false-
  // positive the attribute count pre-fix (raw `safe` matched it before
  // any script strip ran). Post-fix, `data-latex=` is scanned only on
  // the script/style-stripped HTML.
  const html = '<script>var x = "data-latex=foo"; var y = "data-tex=bar";</script><p>plain prose.</p>';
  const r = detectLatexInHtml(html);
  assert.equal(r.signals.dataLatex, 0);
  assert.equal(r.hasLatex, false);
});

test('HARDENING P3-3: math operator glyphs (∑ ∫ ∂ ∞) inside $...$ count as LaTeX', () => {
  // KaTeX/MathJax output the literal U+2211 ∑ glyph for `\sum`, not the
  // Greek Σ (U+03A3) the original LATEX_CONTENT_RE covered. Same for
  // ∫ ∂ ∞ ≠ ≤ ≥ ∈ ∀ ∃ (Mathematical Operators block U+2200-22FF).
  assert.equal(detectLatexInMarkdown('Sum: $∑x_n$').inlineCount, 1, '∑ should count');
  assert.equal(detectLatexInMarkdown('Integral: $∫f$').inlineCount, 1, '∫ should count');
  assert.equal(detectLatexInMarkdown('Partial: $∂y$').inlineCount, 1, '∂ should count');
  assert.equal(detectLatexInMarkdown('Infinity: $∞$').inlineCount, 1, '∞ should count');
  assert.equal(detectLatexInMarkdown('Not equal: $a ≠ b$').inlineCount, 1, '≠ should count');
});

test('HARDENING P2-3: pathological input (50k unmatched <math> tokens) finishes < 500ms', () => {
  // Pre-fix this took ~1900ms because the lazy `[\s\S]*?` backtracked
  // through each failed close attempt. Post-fix, each lazy span is
  // bounded to 100 KiB, keeping runtime linear.
  const adversarial = '<math '.repeat(50000) + '<p>plain</p>';
  const start = Date.now();
  const r = detectLatexInHtml(adversarial);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 500, `pathological input should finish quickly; took ${elapsed}ms`);
  // Whatever the count, the function must return without hanging.
  assert.equal(typeof r.signals.mathml, 'number');
});
