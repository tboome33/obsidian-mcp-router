/**
 * Link extractor for the `wiki-ingest` link-following ingestion pipeline
 * (Phase C of the obsidian-clipper feature-borrowing roadmap, v0.13.3).
 *
 * Given the HTML of a webpage (defuddled or raw) and its base URL,
 * return the list of `<a href>` candidates worth proposing to the user
 * for recursive ingestion, ranked by a heuristic score.
 *
 * Scoring (additive):
 *   +2  same eTLD+1 / hostname as `baseUrl` (publisher-internal link)
 *   +3  link sits inside a section whose heading matches "Related" /
 *       "See also" / "Further reading" / "Voir aussi" / "Liens connexes"
 *       and variants (case-insensitive substring on the heading text)
 *   -5  hostname matches the social/boilerplate blocklist (twitter,
 *       facebook, linkedin, etc.) — these almost never want ingesting
 *
 * Hard skips (return excluded from output):
 *   - Schemes other than `http:` / `https:` (mailto, tel, javascript, …)
 *   - Fragment-only hrefs (`#section`)
 *   - Empty hrefs / hrefs that don't parse as URLs (relative resolved
 *     against `baseUrl`, but invalid combos still drop)
 *   - Links inside `<nav>`, `<footer>`, `<aside>`, `<header>` blocks
 *     (semantic HTML5 boilerplate — these get stripped before scan)
 *
 * Dedup: by canonical href (normalized: lowercase hostname, no fragment,
 * no trailing `/` on the path beyond root, query string preserved as-is
 * because it CAN carry article identity — e.g. `?p=42` on WordPress).
 *
 * Output: array sorted by score descending, capped at `maxCandidates`
 * (default 30 — wiki-ingest skill UI typically shows top 10-15).
 *
 * Design lessons from Phase A:
 *   - Quote-aware tag matching (cf. finding E): `(?:[^>"']|"[^"]*"|'[^']*')*`
 *     so `>` inside `content="…"` doesn't truncate a tag
 *   - Per-tag size cap (cf. A#4 defense-in-depth): 4 KB per `<a>` tag is
 *     plenty for real anchors and bounds catastrophic-backtracking risk
 *   - HTML entity decode on display text (cf. finding B#C): `&amp;` →
 *     `&` so the context snippet shows real characters
 *   - Injection neutralizer on display text (cf. finding A#15): `&lt;`-
 *     encode `<system-reminder>` etc. that a malicious publisher could
 *     stuff in anchor text — that text flows into Claude's context when
 *     the candidate list is rendered
 *
 * Why pure regex (no DOMParser): same rationale as `meta-extractor.mjs`
 * — Node has no native DOMParser, and the only consumer cares about a
 * focused subset (anchor tags + their text). A real HTML parser
 * (`jsdom`/`cheerio`/`linkedom`) would add ~1-2 MiB of deps for
 * marginal gain. Sectioning by H1-H6 is approximate but robust on
 * real-world publisher HTML.
 *
 * @param {string} html — input HTML (defuddled or raw)
 * @param {string} baseUrl — absolute URL of the page (for relative
 *                          href resolution + same-domain scoring)
 * @param {object} [opts]
 * @param {number} [opts.maxCandidates=30]
 * @returns {Array<{href: string, text: string, contextSnippet: string,
 *                   score: number, sourceSection: string|null,
 *                   sameDomain: boolean}>}
 */
export function extractLinks(html, baseUrl, opts = {}) {
  const { maxCandidates = 30 } = opts;
  const safe = String(html || '');
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    // Without a parseable base, we can't resolve relative URLs or score
    // same-domain. Bail with empty rather than producing garbage.
    return [];
  }

  // Strip semantic boilerplate blocks BEFORE link extraction. Class-based
  // nav/footer/sidebar (e.g. `<div class="navbar">`) is NOT stripped —
  // detecting it reliably requires a real DOM parser. Acceptable miss
  // rate in practice.
  const stripped = safe
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside\b[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<header\b[\s\S]*?<\/header>/gi, ' ');

  // Section-by-heading split. Each section knows its preceding heading
  // (null for content before any heading). The Related-section bonus is
  // applied per-section based on a substring match on the heading text.
  const sections = splitByHeadings(stripped);

  // Dedup-MAX-wins (cf. v0.13.4 review+ finding P2): the same canonical
  // href can appear in body AND in a Related section. Pre-v0.13.4 used
  // a Set-based "first-wins" dedup, which dropped the higher-scoring
  // Related occurrence. Now: keep the candidate with the highest score
  // per canonical href.
  const byCanonical = new Map();
  for (const section of sections) {
    const isRelated =
      section.heading != null && headingMatchesRelated(section.heading);

    for (const anchor of iterateAnchors(section.content)) {
      const resolved = resolveAndNormalize(anchor.href, base);
      if (!resolved) continue;

      let score = 0;
      const sameDomain = resolved.hostname === base.hostname;
      if (sameDomain) score += 2;
      if (isRelated) score += 3;
      if (matchesSocialBlocklist(resolved.hostname)) score -= 5;

      const candidate = {
        href: resolved.canonical,
        text: anchor.text,
        contextSnippet: anchor.contextSnippet,
        score,
        sourceSection: section.heading,
        sameDomain,
      };

      const prev = byCanonical.get(resolved.canonical);
      if (!prev || prev.score < score) {
        byCanonical.set(resolved.canonical, candidate);
      }
    }
  }

  const out = [...byCanonical.values()];
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, maxCandidates);
}

// -----------------------------------------------------------------------------
// HTML splitting + iteration
// -----------------------------------------------------------------------------

/**
 * Split HTML into sections separated by `<h1>`-`<h6>` headings. Each
 * section carries its preceding heading text (or null for the leading
 * pre-heading content).
 *
 * @returns {Array<{heading: string|null, content: string}>}
 */
function splitByHeadings(html) {
  // Quote-aware heading tag matcher (cf. Phase A finding E lesson). Caps
  // each opening tag at 1 KB to bound regex work.
  const HEADING_RE = /<h([1-6])\b(?:[^>"']|"[^"]*"|'[^']*'){0,1024}>([\s\S]*?)<\/h\1>/gi;
  const sections = [];
  let lastEnd = 0;
  let currentHeading = null;
  for (const m of html.matchAll(HEADING_RE)) {
    const before = html.slice(lastEnd, m.index);
    sections.push({ heading: currentHeading, content: before });
    currentHeading = cleanText(m[2]);
    lastEnd = m.index + m[0].length;
  }
  sections.push({ heading: currentHeading, content: html.slice(lastEnd) });
  return sections;
}

// Quote-aware `<a>` tag matcher, capped at 4 KB per tag.
const A_TAG_RE = /<a\b(?:[^>"']|"[^"]*"|'[^']*'){0,4096}>([\s\S]*?)<\/a>/gi;
// Quote-aware opening-tag matcher (no inner, no closing) for slicing
// the opening tag out of an A_TAG_RE match without falling on a quoted
// `>` (cf. v0.13.4 review+ finding P2: `<a title="2 > 1" href="/x">`
// was truncated at the inner `>` by the previous `indexOf('>')` approach).
const A_OPEN_RE = /<a\b(?:[^>"']|"[^"]*"|'[^']*'){0,4096}>/i;

/**
 * Yield each `<a>` anchor in `content` with its href, display text,
 * and ~80-char context snippet (text around the anchor in the section).
 */
function* iterateAnchors(content) {
  for (const m of content.matchAll(A_TAG_RE)) {
    // Slice the opening tag using a quote-aware sub-match so a quoted
    // `>` in an attribute before `href` doesn't truncate the slice.
    const openMatch = A_OPEN_RE.exec(m[0]);
    if (!openMatch) continue; // shouldn't happen if A_TAG_RE matched, defensive
    const tagOpen = openMatch[0];
    const innerHtml = m[1];
    const rawHref = extractAttr(tagOpen, 'href');
    if (!rawHref) continue;
    // Decode HTML entities in href BEFORE URL normalization (cf. v0.13.4
    // review+ finding P2: `<a href="/search?q=a&amp;b=2">` was producing
    // a canonical URL with literal `&amp;b=2` query param, breaking the
    // downstream request).
    const href = decodeEntities(rawHref);
    const text = cleanText(innerHtml);
    if (!text) continue; // skip image-only or empty-text anchors
    const contextSnippet = buildContextSnippet(content, m.index, m[0].length);
    yield { href, text, contextSnippet };
  }
}

/**
 * Attribute extractor with backreference quote-delimiter (cf. Phase A
 * finding E). The leading `(?:^|\s)` (not `\b`) avoids matching the
 * suffix of `data-href` / `xlink:href` etc.
 */
function extractAttr(tagText, attrName) {
  const re = new RegExp(
    `(?:^|\\s)${attrName}\\s*=\\s*(["'])((?:(?!\\1).)*)\\1`,
    'i',
  );
  const m = re.exec(tagText);
  return m ? m[2] : null;
}

/**
 * Build a context snippet showing ~80 chars of text around the anchor.
 * Uses the section content (already known to be in-body, not nav/footer).
 */
function buildContextSnippet(sectionHtml, anchorStart, anchorLen) {
  const PRE = 50;
  const POST = 50;
  const start = Math.max(0, anchorStart - PRE);
  const end = Math.min(sectionHtml.length, anchorStart + anchorLen + POST);
  const slice = sectionHtml.slice(start, end);
  // Strip all tags (including the anchor itself) for readable context.
  return cleanText(slice);
}

// -----------------------------------------------------------------------------
// URL resolution + canonicalization
// -----------------------------------------------------------------------------

/**
 * Resolve a (possibly relative) href against the base URL, hard-reject
 * non-http(s) and fragment-only links, and return a canonical form for
 * dedup. Returns null if the resolved href is unusable for ingestion.
 */
function resolveAndNormalize(href, base) {
  if (!href) return null;
  const trimmed = String(href).trim();
  if (!trimmed) return null;
  // Fragment-only links don't navigate anywhere new.
  if (trimmed.startsWith('#')) return null;
  // Hard reject non-http(s) schemes.
  if (/^(mailto|tel|javascript|file|ftp|data|vbscript):/i.test(trimmed)) return null;

  let resolved;
  try {
    resolved = new URL(trimmed, base);
  } catch {
    return null;
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;

  // Canonical form: drop fragment, lowercase hostname, drop trailing `/`
  // on pathnames longer than root, preserve query string verbatim
  // (WordPress's `?p=42` actually carries article identity).
  const canonicalUrl = new URL(resolved.href);
  canonicalUrl.hash = '';
  if (canonicalUrl.hostname) {
    canonicalUrl.hostname = canonicalUrl.hostname.toLowerCase();
  }
  let canonical = canonicalUrl.href;
  // Strip trailing `/` from the pathname when it's more than just `/`.
  // `https://example.com/` stays; `https://example.com/foo/` becomes
  // `https://example.com/foo` for dedup purposes.
  if (canonicalUrl.pathname.length > 1 && canonicalUrl.pathname.endsWith('/')) {
    const idx = canonical.indexOf(canonicalUrl.pathname);
    if (idx >= 0) {
      canonical =
        canonical.slice(0, idx) +
        canonicalUrl.pathname.slice(0, -1) +
        canonical.slice(idx + canonicalUrl.pathname.length);
    }
  }
  return { canonical, hostname: canonicalUrl.hostname };
}

// -----------------------------------------------------------------------------
// Scoring helpers
// -----------------------------------------------------------------------------

const RELATED_HEADING_KEYWORDS = [
  'related',
  'see also',
  'further reading',
  'voir aussi',
  'liens connexes',
  'related posts',
  'related articles',
  'related work',
  'similar',
  'pour aller plus loin',
  'à lire aussi',
  'a lire aussi',
];

function headingMatchesRelated(heading) {
  // NFC normalize before case-folding so a heading like "À lire aussi"
  // (which can arrive as NFD with the combining-grave detached) matches
  // the NFC keyword "à lire aussi" in the lookup table. Real-world
  // impact is small (most sites serve NFC) but zero-cost defense.
  // v0.13.4 review+ finding P3 (Reviewer A).
  const norm = heading.normalize('NFC').toLowerCase();
  return RELATED_HEADING_KEYWORDS.some((kw) => norm.includes(kw));
}

// Social platforms + a couple of common boilerplate hosts that almost
// never carry ingest-worthy content from a typical article body. NOT
// including `github.com` here — GitHub repos referenced inline CAN be
// worth ingesting via `git_repo_to_markdown`, so let the user decide.
const SOCIAL_BLOCKLIST = new Set([
  'twitter.com',
  'mobile.twitter.com',
  'x.com',
  't.co',
  'facebook.com',
  'm.facebook.com',
  'fb.com',
  'fb.me',
  'linkedin.com',
  'lnkd.in',
  'instagram.com',
  'tiktok.com',
  'reddit.com',
  'old.reddit.com',
  'pinterest.com',
  'youtube.com',
  'youtu.be',
  'discord.gg',
  'discord.com',
  't.me', // telegram
]);

function matchesSocialBlocklist(hostname) {
  if (!hostname) return false;
  // Normalize common subdomain prefixes (www.*, m.*, mobile.*) before
  // lookup so `www.twitter.com` matches the blocklist entry `twitter.com`.
  // Pre-v0.13.4 only the bare host was matched, so users who wrote
  // `https://www.twitter.com/x` got score 0 instead of -5.
  // v0.13.4 review+ finding P3 (Reviewer A).
  const stripped = hostname.toLowerCase().replace(/^(www|m|mobile)\./, '');
  return SOCIAL_BLOCKLIST.has(stripped);
}

// -----------------------------------------------------------------------------
// Text cleanup
// -----------------------------------------------------------------------------

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};
function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named !== undefined ? named : match;
  });
}

// Subset of `src/helpers/sanitize.mjs` agentic-marker blocklist. Inlined
// to keep this helper dep-free (cf. Phase A finding A#15 rationale).
const INJECTION_NEUTRALIZE =
  /<(\/?(?:system-reminder|system|tool_use|tool_call|tool_result|antml:[a-z_-]+|function_calls|function_results|invoke|parameter|env|claudeMd|currentDate|userEmail|cc-instructions|commands|command-name|command-message|command-args|assistant|user))/gi;

/**
 * Strip HTML tags, decode entities, neutralize injection markers, and
 * collapse whitespace. Output is safe to flow into Claude's context
 * (the candidate list is rendered for user review in chat).
 */
function cleanText(html) {
  if (html == null) return '';
  let s = String(html);
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(INJECTION_NEUTRALIZE, '&lt;$1');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// Exposed for tests.
export const _internals = {
  splitByHeadings,
  iterateAnchors: (content) => [...iterateAnchors(content)],
  extractAttr,
  resolveAndNormalize,
  headingMatchesRelated,
  matchesSocialBlocklist,
  cleanText,
  decodeEntities,
  RELATED_HEADING_KEYWORDS,
  SOCIAL_BLOCKLIST,
};
