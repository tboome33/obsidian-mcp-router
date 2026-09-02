/**
 * _source-scan.mjs — source-text helpers shared by the GUARD tests.
 *
 * `blankStringsAndComments` lived inside tests/security-invariants.test.mjs.
 * The subprocess-environment guard (tests/subprocess-env.test.mjs) needed the
 * same thing, and a copy is how a fix lands in one file and not the other —
 * this repository's recorded failure mode. A test file cannot be imported for
 * its helpers (importing it registers its tests a second time), so the helper
 * moved here, unchanged.
 *
 * NOT itself a test file (no `.test.mjs` suffix), so the dark-test guard does
 * not expect it in `npm test`.
 */

/**
 * Blank every comment and every string/template literal, replacing each byte
 * with a space and keeping newlines, so offsets and line numbers survive.
 * `${...}` spans inside template literals are KEPT as code — a call can live in
 * one just as well as anywhere else, and their braces stay balanced so callers
 * can brace-match on the result.
 *
 * Two textual guards below needed this and would otherwise have grown a copy
 * each, in the file whose whole subject is "the same fix, six times, under four
 * names". `neutralizeInjection` was counting the word inside a `//` comment;
 * the dotenv guard needs to brace-match function bodies without tripping over a
 * `{` inside a string.
 */
export function blankStringsAndComments(src) {
  const out = src.split('');
  const blank = (k) => { if (out[k] !== '\n') out[k] = ' '; };
  let i = 0;
  const n = src.length;
  let prev = '';
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') blank(i++); continue; }
    if (c === '/' && d === '*') {
      blank(i++); blank(i++);
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) blank(i++);
      blank(i++); blank(i++);
      continue;
    }
    if (c === "'" || c === '"') {
      const q = c; blank(i++);
      while (i < n && src[i] !== q) { if (src[i] === '\\') blank(i++); if (i < n) blank(i++); }
      blank(i++); prev = 'x'; continue;
    }
    if (c === '`') {
      blank(i++);
      while (i < n) {
        if (src[i] === '\\') { blank(i++); blank(i++); continue; }
        if (src[i] === '`') { blank(i++); break; }
        if (src[i] === '$' && src[i + 1] === '{') {
          i += 2;
          let depth = 1;
          while (i < n && depth) {
            if (src[i] === '{') depth += 1;
            else if (src[i] === '}') depth -= 1;
            i += 1;
          }
          continue;
        }
        blank(i++);
      }
      prev = 'x'; continue;
    }
    // A `/` after an operator opens a REGEX, not a division — and a regex may
    // contain `//` inside a character class, which would otherwise swallow the
    // rest of the line as a comment.
    if (c === '/' && /[(,=:[!&|?{};+\-*%~^\n]/.test(prev || '\n')) {
      const start = i; blank(i++);
      let inClass = false; let closed = false;
      while (i < n && src[i] !== '\n') {
        if (src[i] === '\\') { blank(i++); blank(i++); continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) { blank(i++); closed = true; break; }
        blank(i++);
      }
      if (!closed) { for (let k = start; k < i; k += 1) out[k] = src[k]; }
      prev = 'x'; continue;
    }
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return out.join('');
}
