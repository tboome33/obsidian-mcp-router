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
 * Does this partial scalar already close the quote it opened? Counts only
 * unescaped quotes after the opening one.
 */
function closesQuotedScalar(text, quote) {
  for (let k = 1; k < text.length; k += 1) {
    if (text[k] === '\\') { k += 1; continue; }
    if (text[k] === quote) return true;
  }
  return false;
}

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
        frontmatter[key] = items;
        i = j - 1; // skip the consumed item lines
        continue;
      }
      // else fall through — genuine empty scalar
    }

    // Quoted scalar folded over continuation lines — what Obsidian's YAML
    // writer produces for any long value (a `decision:` one-liner, a
    // `description:`, a long `title:`). Reading only the first line kept the
    // opening quote AND cut the value mid-sentence, so exports carried
    // truncated metadata. Consume the continuations until the quote closes.
    const opener = value[0];
    if ((opener === '"' || opener === "'") && !closesQuotedScalar(value, opener)) {
      let j = i + 1;
      while (j < lines.length) {
        value += ` ${lines[j].trim()}`;
        const closed = closesQuotedScalar(value, opener);
        j += 1;
        if (closed) break;
      }
      i = j - 1;
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
      frontmatter[key] = inner
        ? inner.split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''))
        : [];
      continue;
    }
    frontmatter[key] = value;
  }
  return { frontmatter, body };
}

// ---------------------------------------------------------------------------
// Wikilink → markdown link conversion
// ---------------------------------------------------------------------------

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

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
    throw new TypeError(`buildLlmsTxt: mode must be 'index' or 'full' (got ${mode})`);
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
    unindexed.push({ pageSlug: basename, description: '' });
  }
  unindexed.sort((a, b) => a.pageSlug.localeCompare(b.pageSlug));

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
