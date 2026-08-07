/**
 * llms.txt exporter — aggregate a vault's wiki into a single portable file
 * conforming to the llmstxt.org standard (a markdown index of all pages,
 * intended to be consumed by external LLMs to answer grounded questions
 * about the wiki without crawling page-by-page).
 *
 * Two modes:
 *   - 'index'  → llms.txt        : compact, links + descriptions only
 *   - 'full'   → llms-full.txt   : same structure + each page body inlined
 *
 * Pure-functional : no I/O. The caller (skill or future tool) is
 * responsible for reading index.md + pages from the vault and writing the
 * output back. Determinism is enforced — same input always produces same
 * output, byte-for-byte.
 *
 * Reference: https://llmstxt.org
 */

// ---------------------------------------------------------------------------
// Frontmatter parser (minimal — extract the YAML block at the top)
// ---------------------------------------------------------------------------

import { cmp } from './total-order.mjs';
import { safeForMessage } from './sanitize.mjs';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Parse the YAML frontmatter at the top of a markdown string.
 * Returns `{ frontmatter, body }` where frontmatter is a flat object of
 * scalar / array values. Does NOT handle nested objects (we don't need
 * them for the export use case).
 *
 * The parser is intentionally minimal — we just need `title`, `summary`,
 * `description`, `source_type`, `type`. Anything else is ignored.
 *
 * @param {string} content Raw markdown content (may or may not have frontmatter)
 * @returns {{ frontmatter: Record<string, any>, body: string }}
 */
/**
 * Scan ONE APPENDED CHUNK for the closing quote. Never touches the
 * accumulated value.
 *
 * Why a chunk and not an offset into the whole string. The continuation loop
 * below appends a line at a time; the original code re-scanned the entire
 * accumulator every iteration, so an UNTERMINATED quote cost O(n²) over the
 * frontmatter block (2000 lines = 151 ms … 16000 = 10041 ms). The first fix
 * carried a resume OFFSET so each character was examined once — and it was
 * still quadratic, because `value += chunk` builds a V8 cons-string and the
 * next `value[k]` forces a full flatten. Measured after that fix: 8000 lines
 * = 18 ms but 16000 = 233 ms, 32000 = 1338 ms, 64000 = 5233 ms — ~×4 per
 * doubling. The algorithm was fixed and the DATA STRUCTURE was not; the two
 * are separate mistakes and only the second one shows past 8000 lines, which
 * is exactly where the first measurement stopped.
 *
 * Scanning the chunk alone never indexes the accumulator, so nothing is ever
 * flattened: 64000 lines drops from 5233 ms to ~2 ms, ratio ~2.0 per doubling.
 *
 * The escape rule is a backslash consuming the next character, and a chunk
 * boundary can fall between the two — hence `pending`, the one bit of state
 * that has to cross. `pending: true` means the previous chunk ended on a
 * dangling backslash, so this chunk's first character is escaped.
 *
 * This is the shared parser: `build_wiki_graph`, `build_search_index`,
 * `search_smart`, `get_wiki_context_pack`, `refresh_okf_projections` and
 * `find_boundary_pages` all pay whatever it costs, on a long-lived stdio
 * server with no per-file byte cap.
 *
 * @param {string} chunk the newly appended text
 * @param {string} quote the opening quote character
 * @param {number} start index to begin at within `chunk`
 * @param {boolean} pending previous chunk ended with a dangling backslash
 * @returns {{closed: boolean, pending: boolean}}
 */
function scanChunk(chunk, quote, start, pending) {
  let k = start;
  if (pending) k += 1; // first character is escaped by the carried backslash
  for (; k < chunk.length; k += 1) {
    if (chunk[k] === '\\') {
      k += 1; // skip the escaped character
      if (k >= chunk.length) return { closed: false, pending: true };
      continue;
    }
    if (chunk[k] === quote) return { closed: true, pending: false };
  }
  return { closed: false, pending: false };
}

/** Whole-string question, no resume point. Kept for callers that ask once. */
function closesQuotedScalar(text, quote) {
  return scanChunk(text, quote, 1, false).closed;
}

/**
 * A YAML block-scalar header: `|` (literal) or `>` (folded), with an optional
 * explicit indentation digit and an optional chomping indicator (`-`/`+`) in
 * EITHER order (`|2-` and `|-2` are both legal), and an optional trailing
 * comment. Returns `{ folded, indent }` or null.
 */
function parseBlockScalarHeader(value) {
  // Indentation indicator is 1–9 (0 is invalid YAML), and a trailing comment
  // needs separating whitespace — otherwise `|0` and `|#x` were accepted and
  // silently swallowed the following lines as block content (Codex review).
  const m = /^([|>])(?:([1-9])([-+]?)|([-+]?)([1-9])?)(?:\s+#.*)?\s*$/.exec(value);
  if (!m) return null;
  const digit = m[2] ?? m[5];
  return { folded: m[1] === '>', indent: digit ? Number(digit) : null };
}

/**
 * Collect a block scalar's body, starting at `startIdx` (the line AFTER the
 * key line).
 *
 * Base indentation: an explicit digit is relative to the KEY's own indent;
 * otherwise the first non-empty body line defines it. The block ends at the
 * first non-empty line indented less than that.
 *
 * Joining follows YAML closely enough for prose metadata:
 *   - `|` (literal) keeps every line break AND the content's own relative
 *     indentation. The value is NOT trimmed as a whole: with an explicit
 *     indicator (`|2`) the block's leading spaces are real content, and
 *     trimming only stripped them from the FIRST line, yielding internally
 *     inconsistent indentation (Codex review).
 *   - `>` (folded) joins adjacent base-indented lines with a space, but a
 *     MORE-INDENTED line is not folded — it keeps its own line and relative
 *     indentation (YAML's "more indented" rule), and a run of k blank lines
 *     becomes k newlines rather than collapsing to one.
 * Chomping is normalized away (trailing blank lines dropped either way) —
 * these values feed prose fields, never byte-significant payloads.
 *
 * @returns {{ value: string, endIdx: number }} endIdx = last consumed line.
 */
function collectBlockScalar(lines, startIdx, keyIndent, header) {
  let baseIndent = header.indent === null ? null : keyIndent + header.indent;
  const collected = [];
  let j = startIdx;
  for (; j < lines.length; j += 1) {
    const line = lines[j];
    if (line.trim() === '') {
      collected.push('');
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent <= keyIndent) break; // dedented to a sibling key — block over
    if (baseIndent === null) baseIndent = indent;
    if (indent < baseIndent) break;
    collected.push(line.slice(baseIndent));
  }
  // Drop surrounding blank lines (accidental in practice); never touch the
  // leading whitespace of a CONTENT line.
  while (collected.length && collected[collected.length - 1] === '') collected.pop();
  while (collected.length && collected[0] === '') collected.shift();

  if (!header.folded) {
    return { value: collected.join('\n').replace(/[ \t]+$/, ''), endIdx: j - 1 };
  }

  // Folded: build pieces — folded paragraphs, literal (more-indented) lines,
  // and explicit blank runs — then assemble with the right separators.
  const pieces = [];
  let para = [];
  const flushPara = () => {
    if (para.length) pieces.push({ text: para.join(' ') });
    para = [];
  };
  for (let k = 0; k < collected.length; k += 1) {
    const l = collected[k];
    if (l === '') {
      let blanks = 0;
      while (k < collected.length && collected[k] === '') { blanks += 1; k += 1; }
      k -= 1;
      flushPara();
      pieces.push({ blanks });
      continue;
    }
    if (/^[ \t]/.test(l)) {
      flushPara();
      pieces.push({ text: l, literal: true });
      continue;
    }
    para.push(l.trim());
  }
  flushPara();

  let value = '';
  let afterText = false;
  for (const piece of pieces) {
    if (piece.blanks !== undefined) {
      value += '\n'.repeat(piece.blanks);
      afterText = false;
      continue;
    }
    if (afterText) value += '\n';
    value += piece.text;
    afterText = true;
  }
  return { value, endIdx: j - 1 };
}

// KNOWN LIMITATION (pre-dating the v0.70.x hardening, uniform across keys):
// this is a LINE-ORIENTED reader, not a YAML parser. A nested MAPPING —
//   parent:
//     child: value
// — is flattened: `parent` gets an empty string and `child` surfaces as a
// TOP-LEVEL key. That applies to every parent key, `__proto__` included, so a
// suppressed `__proto__:` with mapping children still yields those children
// at top level. This is NOT a privilege escalation: the page author writes
// their own frontmatter and could put `child: value` at top level directly —
// there is no boundary between "under __proto__" and "not". The round-2 P1
// (block-scalar lines leaking) was different and IS fixed: there the parser
// CLAIMS to consume the value, so leaking its lines contradicted its own
// contract. Teaching this reader real nesting is a separate decision with
// vault-wide consequences (today's flat behaviour is what every consumer and
// every existing digest was built against).
export function parseFrontmatter(content) {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return { frontmatter: {}, body: content };
  const yaml = match[1];
  const body = content.slice(match[0].length);
  const frontmatter = {};
  const lines = yaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // Block-sequence items (`  - item`) are consumed by their parent key's
    // look-ahead below — skip any stray ones reached directly.
    if (/^\s*-\s+/.test(line)) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx <= 0) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    if (!key) continue;
    // Refuse the one key whose assignment is not an assignment. On a plain
    // object, `frontmatter['__proto__'] = v` goes through Object.prototype's
    // inherited accessor: a string value was silently discarded (the key just
    // vanished), but an ARRAY value — the block-sequence and inline forms
    // below — REPARENTED the frontmatter object onto a page-chosen array, so
    // every consumer of this shared parser inherited `length` and numeric
    // indices from vault content. `constructor`/`prototype` stay allowed:
    // assigning those creates an ordinary own property.
    //
    // The suppression happens at the ASSIGNMENT, not as an early `continue`:
    // the first version of this fix skipped the key before the multiline
    // branches below had consumed its value, so the lines of a discarded
    // `__proto__: |` block were re-read as TOP-LEVEL keys — a page could
    // manufacture sibling metadata (`status: accepted`, …) out of a value the
    // parser claimed to have dropped. Worse than the bug it fixed; caught by
    // the round-2 adversarial review. The value must travel the exact same
    // parse path as any other key's, and only its last step differs.
    // (Same defect family as `safeFrontmatter`'s DANGEROUS_FM_KEYS in
    // wiki-graph-builder.mjs, which guards its own copy for the same reason.)
    const setKey = (v) => {
      if (key !== '__proto__') frontmatter[key] = v;
    };

    // Block-sequence form (what Obsidian's Properties UI writes):
    //   key:
    //     - a
    //     - b
    // The value on the key line is empty; items follow on `- x` lines.
    // Collect them into an array. (Without this, `sources:`/`tags:` authored
    // via the Obsidian UI parsed as an empty string — defeating source-node
    // extraction. Review IMPORTANT.)
    if (value === '') {
      const items = [];
      let j = i + 1;
      while (j < lines.length && /^\s*-\s+/.test(lines[j])) {
        items.push(
          lines[j].replace(/^\s*-\s+/, '').trim().replace(/^["']|["']$/g, ''),
        );
        j += 1;
      }
      if (items.length > 0) {
        setKey(items);
        i = j - 1; // skip the consumed item lines
        continue;
      }
      // else fall through — genuine empty scalar
    }

    // Block scalar (`key: |`, `key: >`, with optional indent digit / chomping /
    // comment) — what Obsidian writes for a multi-paragraph property, and what
    // every SKILL.md `description:` uses. The line-oriented reader used to keep
    // the INDICATOR as the value, so those pages carried a literal `"|"` as
    // their description: it surfaced verbatim in the generated OKF indexes
    // (`* [Title](file.md) - |`), in exports, and in the knowledge graph, while
    // the real text was silently dropped. Consume the block instead.
    const blockHeader = parseBlockScalarHeader(value);
    if (blockHeader) {
      const keyIndent = line.length - line.trimStart().length;
      const { value: blockValue, endIdx } = collectBlockScalar(lines, i + 1, keyIndent, blockHeader);
      setKey(blockValue);
      i = endIdx;
      continue;
    }

    // Quoted scalar folded over continuation lines — what Obsidian's YAML
    // writer produces for any long value (a `decision:` one-liner, a
    // `description:`, a long `title:`). Reading only the first line kept the
    // opening quote AND cut the value mid-sentence, so exports carried
    // truncated metadata. Consume the continuations until the quote closes.
    const opener = value[0];
    if (opener === '"' || opener === "'") {
      // Scan the APPENDED CHUNK only — never re-index `value`, which would
      // force V8 to flatten the cons-string and reintroduce the quadratic
      // cost. `pending` carries the dangling-backslash bit across the
      // boundary. See scanChunk.
      let scan = scanChunk(value, opener, 1, false);
      if (!scan.closed) {
        let j = i + 1;
        while (j < lines.length) {
          const chunk = ` ${lines[j].trim()}`;
          value += chunk;
          scan = scanChunk(chunk, opener, 0, scan.pending);
          j += 1;
          if (scan.closed) break;
        }
        i = j - 1;
      }
    }

    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Array inline form: [a, b, c]
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1).trim();
      setKey(inner
        ? inner.split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''))
        : []);
      continue;
    }
    setKey(value);
  }
  return { frontmatter, body };
}

// ---------------------------------------------------------------------------
// Wikilink → markdown link conversion
// ---------------------------------------------------------------------------

// `[` and `\n` excluded from both classes: without them a run of `[` drives
// this regex quadratic (see the note on WIKILINK_RE in wiki-graph-builder.mjs,
// which carries the measurements). A link target never legitimately contains
// either character.
const WIKILINK_RE = /\[\[([^\]|\n[]+)(?:\|([^\]\n[]+))?\]\]/g;

/**
 * Convert Obsidian `[[wikilinks]]` into standard markdown `[label](path)`.
 *
 * The result is a relative anchor — we don't try to resolve to absolute
 * vault URLs (those would depend on deployment context the exporter
 * doesn't know about).
 *
 * `[[Foo]]`         → `[Foo](Foo.md)`
 * `[[Foo|Bar]]`     → `[Bar](Foo.md)`
 * `[[concepts/Foo]]` → `[Foo](concepts/Foo.md)`
 *
 * @param {string} text Markdown text potentially containing wikilinks
 * @returns {string} Same text with wikilinks normalised
 */
export function normaliseWikilinks(text) {
  return text.replace(WIKILINK_RE, (_match, target, label) => {
    const cleanTarget = target.trim();
    const displayLabel = (label ?? cleanTarget.split('/').pop()).trim();
    // Path already has .md? leave it. Otherwise add it.
    const path = cleanTarget.endsWith('.md') ? cleanTarget : `${cleanTarget}.md`;
    return `[${displayLabel}](${path})`;
  });
}

// ---------------------------------------------------------------------------
// Index parser — extract sections + bullets from wiki-meta/catalog.md
// ---------------------------------------------------------------------------

/**
 * Parse a wiki-meta/catalog.md content string into a sectioned structure.
 *
 * Expected input shape (the convention this project uses):
 *
 *   ## Section Name
 *   - [[page-slug]] — description text
 *   - [[other-slug]] — another description
 *
 *   ## Another Section
 *   - [[third]] — ...
 *
 * Returns `[{ title: 'Section Name', bullets: [{ pageSlug, description }] }, ...]`
 * in source order. Bullets that don't match the expected `- [[x]] — y` form
 * are skipped silently (we're not trying to be a general markdown parser).
 *
 * The function strips frontmatter and skips the H1 of the index itself.
 *
 * @param {string} indexMd Content of wiki-meta/catalog.md
 * @returns {Array<{ title: string, bullets: Array<{ pageSlug: string, description: string }> }>}
 */
export function parseIndex(indexMd) {
  const { body } = parseFrontmatter(indexMd);
  const sections = [];
  let currentSection = null;
  const lines = body.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    // Skip H1 (index title itself)
    if (line.startsWith('# ') && !line.startsWith('## ')) continue;
    // H2 starts a new section
    if (line.startsWith('## ')) {
      const title = line.slice(3).trim();
      currentSection = { title, bullets: [] };
      sections.push(currentSection);
      continue;
    }
    // Bullet under current section. Accept these wikilink forms :
    //   - [[page-slug]] description-separator description-text
    //   - [[page-slug|Display Alias]] — description
    //   - [[page-slug#Heading]] — description
    //   - [[page-slug#Heading|Display]] — description
    //   - [[page-slug^block-ref|Display]] — description
    //   - [[page-slug]] (no description)
    // Description separator is one of `—` (em-dash), `-` (hyphen),
    // `:` (colon). The raw target may carry `|alias` / `#section` /
    // `^block-ref` decorations — split them off, keep only the page
    // slug as the structural identifier. (review+ pass 2 fix for
    // Reviewer B IMPORTANT #7 — previously `[[foo|Alias]]` was
    // silently dropped because the regex used `[^\]|]+?`.)
    if (currentSection && line.startsWith('- ')) {
      const bulletContent = line.slice(2).trim();
      const match = /^\[\[([^\]]+?)\]\](?:\s*[—\-:]\s*(.*))?$/.exec(bulletContent);
      if (!match) continue;
      const rawTarget = match[1].trim();
      // Strip `|alias` / `#section` / `^block-ref` decorations.
      const pageSlug = rawTarget.split(/[|#^]/)[0].trim();
      if (!pageSlug) continue;
      const description = (match[2] ?? '').trim();
      currentSection.bullets.push({ pageSlug, description });
    }
  }
  return sections;
}

// ---------------------------------------------------------------------------
// Page body cleanup — strip the H1 + leading blank line
// ---------------------------------------------------------------------------

/**
 * Strip the leading H1 from a page body (because the link/section already
 * provides the title) and any leading blank lines. Returns the body with
 * its first non-trivial content as the first line.
 *
 * @param {string} body Page body (after frontmatter removal)
 * @returns {string} Body without leading H1 + blanks
 */
function stripLeadingH1(body) {
  // Match optional leading whitespace + first H1 + rest
  return body.replace(/^\s*#\s+[^\n]*\n+/, '');
}

// ---------------------------------------------------------------------------
// Main aggregator
// ---------------------------------------------------------------------------

/**
 * Build the llms.txt or llms-full.txt content for a vault.
 *
 * @param {object} input
 * @param {string} input.vaultName Vault title (becomes the H1)
 * @param {string} input.indexMd Content of wiki-meta/catalog.md
 * @param {Array<{ path: string, content: string }>} input.pages
 *   All wiki pages, each with vault-relative path + raw content (with
 *   frontmatter intact). The exporter handles frontmatter parsing +
 *   wikilink normalisation internally.
 * @param {'index' | 'full'} [input.mode='index'] Output format
 * @param {string} [input.summary] Optional 1-2 sentence blurb under the H1.
 *   When omitted, the function looks for a summary in the first page that
 *   has `type: overview` in its frontmatter; if none, falls back to a generic.
 * @returns {string} The aggregated llms.txt content (UTF-8 markdown)
 */
export function buildLlmsTxt({ vaultName, indexMd, pages, mode = 'index', summary }) {
  if (!vaultName || typeof vaultName !== 'string') {
    throw new TypeError('buildLlmsTxt: vaultName is required (string)');
  }
  if (typeof indexMd !== 'string') {
    throw new TypeError('buildLlmsTxt: indexMd is required (string)');
  }
  if (!Array.isArray(pages)) {
    throw new TypeError('buildLlmsTxt: pages is required (array)');
  }
  if (mode !== 'index' && mode !== 'full') {
    throw new TypeError(`buildLlmsTxt: mode must be 'index' or 'full' (got ${safeForMessage(mode, 80)})`);
  }

  // Build a lookup of pages by basename for index resolution
  // Index bullets reference pages by basename (e.g. [[project-router]]),
  // not full paths. Build basename → page map so we can find content.
  const pageByBasename = new Map();
  for (const page of pages) {
    const basename = page.path.split('/').pop().replace(/\.md$/, '');
    pageByBasename.set(basename, page);
  }

  // Resolve summary — explicit > overview page > generic fallback
  let resolvedSummary = summary;
  if (!resolvedSummary) {
    const overviewPage = pages.find((p) => {
      const { frontmatter } = parseFrontmatter(p.content);
      return frontmatter.type === 'overview' || /overview/i.test(p.path);
    });
    if (overviewPage) {
      const { body } = parseFrontmatter(overviewPage.content);
      // First non-empty, non-heading paragraph
      const para = body
        .split(/\r?\n\r?\n/)
        .find((p) => p.trim() && !p.trim().startsWith('#'));
      if (para) resolvedSummary = para.trim().split(/\r?\n/).join(' ');
    }
  }
  if (!resolvedSummary) {
    resolvedSummary = `Knowledge base for ${vaultName}.`;
  }

  // Parse the index
  const sections = parseIndex(indexMd);

  // Track pages referenced by index → leftovers go to "Unindexed"
  const indexed = new Set();
  for (const section of sections) {
    for (const bullet of section.bullets) {
      indexed.add(bullet.pageSlug);
    }
  }

  // Build the unindexed section
  const skipMetaFiles = new Set(['hot', 'log', 'index', 'overview']);
  const unindexed = [];
  for (const page of pages) {
    const basename = page.path.split('/').pop().replace(/\.md$/, '');
    if (indexed.has(basename)) continue;
    if (skipMetaFiles.has(basename)) continue;
    if (page.path.startsWith('wiki-meta/')) continue;
    // NOTE (v0.59.0): the generated OKF projections (wiki/index.md,
    // per-directory index.md, wiki/log.md) are excluded here by the
    // `skipMetaFiles` basename test above — `index` and `log` have been
    // skipped since this exporter existed, marker or no marker. Pinned by
    // the "MARKED OKF projection never lands in Unindexed" test.
    unindexed.push({ pageSlug: basename, description: '' });
  }
  // The shared comparator, not a hand-inlined ternary: satisfying the rule by
  // construction rather than by compliance means the next edit here has
  // nothing to copy from.
  unindexed.sort((a, b) => cmp(a.pageSlug, b.pageSlug));

  // ----------------------------------------------------------------
  // Render
  // ----------------------------------------------------------------

  const lines = [];
  lines.push(`# ${vaultName}`);
  lines.push('');
  lines.push(`> ${resolvedSummary}`);
  lines.push('');

  for (const section of sections) {
    if (section.bullets.length === 0) continue;
    lines.push(`## ${section.title}`);
    lines.push('');
    for (const bullet of section.bullets) {
      const page = pageByBasename.get(bullet.pageSlug);
      const path = page ? page.path : `${bullet.pageSlug}.md`;
      const description = bullet.description
        ? `: ${normaliseWikilinks(bullet.description)}`
        : '';
      lines.push(`- [${bullet.pageSlug}](${path})${description}`);
      if (mode === 'full' && page) {
        const { body } = parseFrontmatter(page.content);
        const cleaned = normaliseWikilinks(stripLeadingH1(body)).trimEnd();
        if (cleaned) {
          lines.push('');
          lines.push(cleaned);
          lines.push('');
        }
      }
    }
    lines.push('');
  }

  if (unindexed.length > 0) {
    lines.push('## Unindexed');
    lines.push('');
    for (const bullet of unindexed) {
      const page = pageByBasename.get(bullet.pageSlug);
      const path = page ? page.path : `${bullet.pageSlug}.md`;
      lines.push(`- [${bullet.pageSlug}](${path})`);
      if (mode === 'full' && page) {
        const { body } = parseFrontmatter(page.content);
        const cleaned = normaliseWikilinks(stripLeadingH1(body)).trimEnd();
        if (cleaned) {
          lines.push('');
          lines.push(cleaned);
          lines.push('');
        }
      }
    }
    lines.push('');
  }

  // Collapse runs of empty lines, ensure trailing newline
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
