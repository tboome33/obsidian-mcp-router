/**
 * OKF bundle exporter — turn a subset of a vault's wiki into a knowledge
 * bundle conforming to Google's Open Knowledge Format v0.1
 * (https://github.com/GoogleCloudPlatform/knowledge-catalog, okf/SPEC.md).
 *
 * OKF is the exchange format AT THE EDGES: the vault's internal structure
 * (wikilinks, wiki-meta/ scaffolds, newest-last log) never changes — this
 * module regenerates everything the standard requires on the way out:
 *
 *   - filenames slugified to the reference implementation's segment charset
 *     (`[A-Za-z0-9_][A-Za-z0-9_.\-]*` — no spaces, no accents), links remapped
 *   - `[[wikilinks]]` → relative markdown links with `.md` kept (the spec
 *     recommends bundle-root-absolute `/x.md` links, but Google's own
 *     reference agent forbids leading `/` because it breaks GitHub rendering
 *     — we side with the implementation and emit relative links)
 *   - frontmatter mapped to the FOUR keys Google's reference implementation
 *     requires in practice (`type`, `title`, `description`, `timestamp` —
 *     the spec itself only requires `type`), `url` → `resource`, extra keys
 *     preserved as legal OKF extensions
 *   - one `index.md` per directory (grouped by `type`, entries
 *     `* [Title](file.md) - description`) + a bundle-root `index.md` whose
 *     frontmatter carries only `okf_version: "0.1"` (§11 — the only place
 *     frontmatter is permitted in an index)
 *   - a newest-first `log.md` (§7) with a single Creation entry
 *   - reserved-name collisions (`index.md` / `log.md` used as content pages
 *     at any depth, §3.1) detected and renamed
 *
 * Broken links are NOT an error: a wikilink pointing at a page excluded from
 * the export is converted to a dangling markdown link and reported — the
 * spec explicitly tolerates links to "not-yet-written knowledge" (§5.3).
 *
 * Pure-functional: no I/O, no clock. The caller injects `now` and is
 * responsible for reading pages from the vault and writing the produced
 * files back. Same input always produces the same output, byte-for-byte.
 */

import { parseFrontmatter } from './llms-txt-exporter.mjs';

export const OKF_VERSION = '0.1';

/** Reserved filenames (§3.1) — never usable as concept documents. */
const RESERVED_BASENAMES = new Set(['index.md', 'log.md']);

// ---------------------------------------------------------------------------
// Slugification — reference-implementation compatible path segments
// ---------------------------------------------------------------------------

/**
 * Slugify one path segment (a folder name or a file stem) into the charset
 * Google's reference implementation accepts: `[A-Za-z0-9_][A-Za-z0-9_.\-]*`.
 * Accents are transliterated (é → e), anything else becomes `-`.
 *
 * `Cours 2 - Réseaux de neurones` → `cours-2-reseaux-de-neurones`
 *
 * @param {string} segment Raw folder/file-stem name
 * @returns {string} Slugified segment (never empty — falls back to 'page')
 */
export function slugifyOkfSegment(segment) {
  const slug = String(segment)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics (NFD)
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+/, '') // first char must be [A-Za-z0-9_]
    .replace(/[-.]+$/, '')
    .toLowerCase();
  return slug || 'page';
}

/**
 * Slugify a bundle-relative page path (each segment independently), keeping
 * the `.md` extension. A leading `wiki/` segment is stripped — the bundle
 * root replaces the vault's `wiki/` folder.
 *
 * @param {string} pagePath Vault-relative path (e.g. `wiki/Divers/Ma Page.md`)
 * @returns {string} Bundle-relative slugified path (e.g. `divers/ma-page.md`)
 */
export function slugifyOkfPath(pagePath) {
  const withoutExt = pagePath.replace(/\.md$/i, '');
  const segments = withoutExt.split('/').filter(Boolean);
  if (segments[0] === 'wiki') segments.shift();
  const slugged = segments.map(slugifyOkfSegment);
  return `${slugged.join('/')}.md`;
}

// ---------------------------------------------------------------------------
// Relative-path computation (pure posix, no node:path dependency)
// ---------------------------------------------------------------------------

/**
 * Compute the relative link from one bundle file to another.
 *
 * @param {string} fromPath Bundle-relative path of the linking file
 * @param {string} toPath Bundle-relative path of the target file
 * @returns {string} Relative markdown-link target (e.g. `../tables/users.md`)
 */
export function relativeLink(fromPath, toPath) {
  const fromDir = fromPath.split('/').slice(0, -1);
  const toParts = toPath.split('/');
  let common = 0;
  while (
    common < fromDir.length &&
    common < toParts.length - 1 &&
    fromDir[common] === toParts[common]
  ) {
    common += 1;
  }
  const ups = fromDir.length - common;
  const down = toParts.slice(common);
  return [...Array(ups).fill('..'), ...down].join('/');
}

// ---------------------------------------------------------------------------
// Wikilink → relative markdown link rewriting
// ---------------------------------------------------------------------------

// Embeds first (![[...]]), then plain wikilinks. Target may carry
// `#heading`, `#^block-id`, and `|alias` decorations.
const EMBED_RE = /!\[\[([^\]]+)\]\]/g;
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

const ASSET_EXT_RE = /\.(png|jpe?g|gif|svg|webp|bmp|pdf|mp3|mp4|wav|ogg|mov|webm)$/i;

function splitWikiTarget(raw) {
  // `path/to/Page#Heading|Alias` → { target, anchor, alias }
  const pipeIdx = raw.indexOf('|');
  const alias = pipeIdx >= 0 ? raw.slice(pipeIdx + 1).trim() : null;
  const noAlias = pipeIdx >= 0 ? raw.slice(0, pipeIdx) : raw;
  const hashIdx = noAlias.indexOf('#');
  const anchor = hashIdx >= 0 ? noAlias.slice(hashIdx + 1).trim() : null;
  const target = (hashIdx >= 0 ? noAlias.slice(0, hashIdx) : noAlias).trim();
  return { target, anchor, alias };
}

/**
 * Build a resolver that maps a wikilink target string to the NEW
 * bundle-relative path of the page it designates.
 *
 * Resolution order (mirrors Obsidian's basename resolution):
 *   1. exact vault path (with or without `wiki/` prefix, with or without `.md`)
 *   2. basename, case-sensitive
 *   3. basename, case-insensitive
 *
 * @param {Array<{ path: string, newPath: string }>} mappings
 * @returns {(target: string) => string | null} New path, or null if not exported
 */
function makeTargetResolver(mappings) {
  const byVaultPath = new Map();
  const byBasename = new Map();
  const byBasenameLower = new Map();
  for (const m of mappings) {
    const noExt = m.path.replace(/\.md$/i, '');
    byVaultPath.set(noExt, m.newPath);
    byVaultPath.set(noExt.replace(/^wiki\//, ''), m.newPath);
    const basename = noExt.split('/').pop();
    if (!byBasename.has(basename)) byBasename.set(basename, m.newPath);
    const lower = basename.toLowerCase();
    if (!byBasenameLower.has(lower)) byBasenameLower.set(lower, m.newPath);
  }
  return (target) => {
    const clean = target.replace(/\.md$/i, '');
    return (
      byVaultPath.get(clean) ??
      byBasename.get(clean.split('/').pop()) ??
      byBasenameLower.get(clean.split('/').pop().toLowerCase()) ??
      null
    );
  };
}

/**
 * Rewrite every `[[wikilink]]` / `![[embed]]` in a page body into relative
 * markdown links between the bundle's slugified paths.
 *
 * Policies (all reported, never silent):
 *   - heading/block anchors are dropped (no OKF equivalent) → `anchorsDropped`
 *   - links to pages outside the export set become dangling links to the
 *     slugified guess of where the page WOULD live → `dangling`
 *   - embeds of markdown pages are demoted to plain links; embeds of assets
 *     become standard image links (assets are not exported) → `embeds`
 *
 * @param {string} body Page body (frontmatter already removed)
 * @param {string} fromNewPath Bundle-relative path of the page being rewritten
 * @param {(target: string) => string | null} resolve Target resolver
 * @param {{ anchorsDropped: string[], dangling: string[], embeds: string[] }} report
 * @returns {string} Body with all Obsidian link syntax converted
 */
export function rewriteWikilinks(body, fromNewPath, resolve, report) {
  const convertTarget = (raw, { isEmbed }) => {
    const { target, anchor, alias } = splitWikiTarget(raw);
    if (anchor) report.anchorsDropped.push(`${fromNewPath}: [[${raw}]]`);
    const label = alias || target.split('/').pop().replace(/\.md$/i, '');
    if (isEmbed && ASSET_EXT_RE.test(target)) {
      // Asset embed — keep image syntax, point at the slugified basename
      // (assets are not exported; the link is knowingly dangling).
      const assetName = target.split('/').pop();
      const ext = assetName.match(ASSET_EXT_RE)[0];
      const stem = assetName.slice(0, -ext.length);
      report.embeds.push(`${fromNewPath}: ![[${raw}]] (asset, not exported)`);
      return `![${label}](${slugifyOkfSegment(stem)}${ext.toLowerCase()})`;
    }
    const resolved = resolve(target);
    let linkPath;
    if (resolved) {
      linkPath = relativeLink(fromNewPath, resolved);
    } else {
      // Dangling — legal per §5.3 ("not-yet-written knowledge"). Point at the
      // slugified path the page would have if it were exported.
      const guess = slugifyOkfPath(target.includes('/') ? target : `${target}.md`);
      linkPath = relativeLink(fromNewPath, guess);
      report.dangling.push(`${fromNewPath}: [[${raw}]] → ${guess}`);
    }
    if (isEmbed && !ASSET_EXT_RE.test(target)) {
      report.embeds.push(`${fromNewPath}: ![[${raw}]] (demoted to plain link)`);
    }
    return `[${label}](${linkPath})`;
  };

  return body
    .replace(EMBED_RE, (_m, raw) => convertTarget(raw, { isEmbed: true }))
    .replace(WIKILINK_RE, (_m, raw) => convertTarget(raw, { isEmbed: false }));
}

// ---------------------------------------------------------------------------
// Frontmatter mapping
// ---------------------------------------------------------------------------

/** Keys consumed by the mapping itself — everything else is preserved. */
const MAPPED_KEYS = new Set([
  'type', 'title', 'description', 'tags', 'url', 'resource',
  'timestamp', 'ingested_at', 'saved_at', 'answered_at', 'generated_at',
  'updated', 'created',
]);

function newestDateString(frontmatter) {
  const candidates = [
    'timestamp', 'updated', 'ingested_at', 'saved_at', 'answered_at',
    'generated_at', 'created',
  ];
  let best = null;
  let bestMs = -Infinity;
  for (const key of candidates) {
    const value = frontmatter[key];
    if (typeof value !== 'string' || !value) continue;
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) continue;
    if (ms > bestMs) {
      bestMs = ms;
      best = value;
    }
  }
  return best;
}

function firstSentenceOfBody(body) {
  const para = body
    .split(/\r?\n\r?\n/)
    .map((p) => p.trim())
    .find((p) => p && !p.startsWith('#') && !p.startsWith('```') && !p.startsWith('|'));
  if (!para) return null;
  let text = para
    .split(/\r?\n/)
    .map((l) => l.replace(/^>\s?/, '').replace(/^[-*]\s+/, '').trim())
    .join(' ')
    .replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, t, a) => a || t.split('/').pop())
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  const sentenceEnd = text.search(/[.!?]\s/);
  if (sentenceEnd > 20) text = text.slice(0, sentenceEnd + 1);
  if (text.length > 200) text = `${text.slice(0, 197).replace(/\s+\S*$/, '')}…`;
  return text;
}

function stripWikilinkBrackets(value) {
  return String(value)
    .replace(/^"?\[\[([^\]|]+)(?:\|[^\]]+)?\]\]"?$/, '$1')
    .trim();
}

/**
 * Map a router page's frontmatter to OKF frontmatter.
 *
 * Emits the four keys Google's reference implementation requires
 * (`type`, `title`, `description`, `timestamp`) plus `resource` (from `url`)
 * and `tags` when available, then preserves every unmapped key as an OKF
 * extension (arrays of `[[wikilinks]]` are flattened to bare slugs, the way
 * the Cole Medin bundle does with `related_videos`).
 *
 * @param {Record<string, any>} frontmatter Parsed source frontmatter
 * @param {string} body Page body (for description synthesis)
 * @param {string} basename Page basename (title fallback)
 * @param {string} now Injected ISO date/datetime (timestamp fallback)
 * @param {string[]} warnings Mutated — human-readable warnings
 * @returns {Record<string, any>} Ordered OKF frontmatter object
 */
export function buildOkfFrontmatter(frontmatter, body, basename, now, warnings = []) {
  const out = {};
  let type = frontmatter.type;
  if (typeof type !== 'string' || !type.trim()) {
    type = 'note';
    warnings.push(`${basename}: missing \`type\` — defaulted to 'note'`);
  }
  out.type = type.trim();

  const resource = frontmatter.resource || frontmatter.url;
  if (typeof resource === 'string' && resource.trim()) out.resource = resource.trim();

  out.title =
    (typeof frontmatter.title === 'string' && frontmatter.title.trim()) || basename;

  const description =
    (typeof frontmatter.description === 'string' && frontmatter.description.trim()) ||
    firstSentenceOfBody(body) ||
    out.title;
  out.description = description;

  if (Array.isArray(frontmatter.tags) && frontmatter.tags.length > 0) {
    out.tags = frontmatter.tags.map(String);
  }

  out.timestamp = newestDateString(frontmatter) || now;

  // Preserve everything else as OKF extension keys.
  for (const [key, value] of Object.entries(frontmatter)) {
    if (MAPPED_KEYS.has(key)) continue;
    if (Array.isArray(value)) {
      out[key] = value.map(stripWikilinkBrackets);
    } else {
      out[key] = stripWikilinkBrackets(value);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Minimal YAML serializer (matches the reference implementation's shape:
// scalars inline, arrays as block lists, timestamp quoted)
// ---------------------------------------------------------------------------

const ALWAYS_QUOTED_KEYS = new Set(['timestamp', 'okf_version']);

function yamlScalar(value, key) {
  const s = String(value);
  const needsQuotes =
    ALWAYS_QUOTED_KEYS.has(key) ||
    s === '' ||
    /[:#{}[\],&*?|>%@`"']/.test(s) ||
    /^[\s-]|[\s]$/.test(s) ||
    /^(true|false|null|~|yes|no|on|off)$/i.test(s) ||
    /^[\d.+-]+$/.test(s);
  if (!needsQuotes) return s;
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Serialize an OKF frontmatter object to a YAML block (with `---` fences).
 * @param {Record<string, any>} fm
 * @returns {string}
 */
export function serializeOkfFrontmatter(fm) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fm)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`- ${yamlScalar(item, key)}`);
    } else {
      lines.push(`${key}: ${yamlScalar(value, key)}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Index generation (§6) — one index.md per directory, grouped by type
// ---------------------------------------------------------------------------

function indexEntryLine(title, linkPath, description) {
  const desc = String(description || '').replace(/\s+/g, ' ').trim();
  return `* [${title}](${linkPath})${desc ? ` - ${desc}` : ''}`;
}

function buildDirectoryIndexes({ documents, vaultName, summary }) {
  // Collect the directory tree from the produced document paths.
  const dirs = new Map(); // dir ('' = root) → { docs: [], subdirs: Set }
  const ensureDir = (dir) => {
    if (!dirs.has(dir)) dirs.set(dir, { docs: [], subdirs: new Set() });
    return dirs.get(dir);
  };
  ensureDir('');
  for (const doc of documents) {
    const parts = doc.newPath.split('/');
    const dir = parts.slice(0, -1).join('/');
    ensureDir(dir).docs.push(doc);
    // Register every ancestor chain so intermediate dirs get indexes too.
    for (let i = parts.length - 1; i > 0; i -= 1) {
      const parent = parts.slice(0, i - 1).join('/');
      const child = parts.slice(0, i).join('/');
      if (child.includes('.md')) continue;
      ensureDir(parent).subdirs.add(child);
    }
  }

  const files = [];
  const sortedDirs = [...dirs.keys()].sort();
  for (const dir of sortedDirs) {
    const { docs, subdirs } = dirs.get(dir);
    const lines = [];

    if (dir === '') {
      // Bundle-root index — the ONLY index allowed frontmatter, and only to
      // declare the spec version (§11).
      lines.push('---', `okf_version: '${OKF_VERSION}'`, '---', '');
      lines.push(`# ${vaultName}`, '');
      if (summary) lines.push(`> ${summary.replace(/\s+/g, ' ').trim()}`, '');
    }

    // Group this directory's documents by type → one `# Type` section each.
    const byType = new Map();
    for (const doc of docs) {
      const type = doc.okfFrontmatter.type;
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type).push(doc);
    }
    const typeNames = [...byType.keys()].sort((a, b) => a.localeCompare(b));
    for (const type of typeNames) {
      const heading = type.charAt(0).toUpperCase() + type.slice(1);
      lines.push(`# ${heading}`, '');
      const entries = byType.get(type).slice().sort((a, b) =>
        a.okfFrontmatter.title.toLowerCase().localeCompare(b.okfFrontmatter.title.toLowerCase()),
      );
      for (const doc of entries) {
        const filename = doc.newPath.split('/').pop();
        lines.push(
          indexEntryLine(doc.okfFrontmatter.title, filename, doc.okfFrontmatter.description),
        );
      }
      lines.push('');
    }

    const sortedSubdirs = [...subdirs].sort();
    if (sortedSubdirs.length > 0) {
      lines.push('# Subdirectories', '');
      for (const sub of sortedSubdirs) {
        const name = sub.split('/').pop();
        const subDocs = documents.filter(
          (d) => d.newPath.startsWith(`${sub}/`),
        );
        const firstTitles = subDocs
          .slice()
          .sort((a, b) => a.newPath.localeCompare(b.newPath))
          .slice(0, 3)
          .map((d) => d.okfFrontmatter.title);
        const desc = `Contains ${subDocs.length} document${subDocs.length === 1 ? '' : 's'}${
          firstTitles.length ? `: ${firstTitles.join(', ')}` : ''
        }`;
        lines.push(indexEntryLine(name, `${name}/index.md`, desc));
      }
      lines.push('');
    }

    const content = `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
    files.push({ path: dir === '' ? 'index.md' : `${dir}/index.md`, content });
  }
  return files;
}

// ---------------------------------------------------------------------------
// Agent-facing README (optional, à la Cole Medin)
// ---------------------------------------------------------------------------

function buildAgentReadme({ vaultName, summary, documentCount }) {
  return `# ${vaultName} (OKF Bundle)

An [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog) bundle${
    summary ? ` — ${summary.replace(/\s+/g, ' ').trim()}` : ''
  }

This bundle contains ${documentCount} markdown knowledge documents, each with a
small YAML frontmatter block, navigated via \`index.md\` files. You read it
**directly**: no database, no embeddings, no API, no special tooling.

## For the agent setting this up

1. Read \`index.md\` at the root — it is the table of contents.
2. To answer a question, locate the relevant section in the root index, open
   that folder's \`index.md\`, then read **only the specific pages you need**
   (progressive disclosure — never load the whole bundle).
3. Follow the relative markdown links between documents to gather context.
4. Ground your answers in those pages and cite each source document by its
   frontmatter \`title\` (and \`resource\` URL when present).

This is read-only reference knowledge — don't modify the bundle.

---
Generated by [obsidian-mcp-router](https://github.com/tboome/obsidian-mcp-router) \`wiki-export --target okf\`.
`;
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

/**
 * Build a complete OKF v0.1 bundle from a set of wiki pages.
 *
 * @param {object} input
 * @param {string} input.vaultName Vault display name (bundle title)
 * @param {Array<{ path: string, content: string }>} input.pages
 *   The pages to export (already filtered by the caller — by folder, tags,
 *   whatever policy). `wiki-meta/` paths are excluded defensively.
 * @param {string} input.now ISO date or datetime — injected clock (required
 *   for determinism; used for the log entry and as timestamp fallback)
 * @param {string} [input.summary] One-sentence bundle blurb for the root
 *   index. Falls back to a generic sentence.
 * @param {boolean} [input.includeAgentReadme=false] Also emit a README.md
 *   with agent onboarding instructions (Cole Medin pattern).
 * @returns {{
 *   files: Array<{ path: string, content: string }>,
 *   report: {
 *     documentCount: number,
 *     renamed: Array<{ from: string, to: string }>,
 *     dangling: string[],
 *     anchorsDropped: string[],
 *     embeds: string[],
 *     warnings: string[],
 *   }
 * }}
 */
export function buildOkfBundle({
  vaultName,
  pages,
  now,
  summary,
  includeAgentReadme = false,
}) {
  if (!vaultName || typeof vaultName !== 'string') {
    throw new TypeError('buildOkfBundle: vaultName is required (string)');
  }
  if (!Array.isArray(pages)) {
    throw new TypeError('buildOkfBundle: pages is required (array)');
  }
  if (typeof now !== 'string' || Number.isNaN(Date.parse(now))) {
    throw new TypeError('buildOkfBundle: now is required (ISO date string)');
  }

  const report = {
    documentCount: 0,
    renamed: [],
    dangling: [],
    anchorsDropped: [],
    embeds: [],
    warnings: [],
  };

  // 1. Filter + deterministic order.
  const exportable = pages
    .filter((p) => p && typeof p.path === 'string' && typeof p.content === 'string')
    .filter((p) => p.path.endsWith('.md'))
    .filter((p) => !p.path.startsWith('wiki-meta/'))
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path));

  // 2. Path mapping: slugify + reserved-name & collision handling.
  const taken = new Set();
  const mappings = [];
  for (const page of exportable) {
    let newPath = slugifyOkfPath(page.path);
    const parts = newPath.split('/');
    let basename = parts.pop();
    // §3.1 — reserved filenames must not be concept documents. README.md is
    // reserved by us when the agent README is emitted.
    const reserved = new Set(RESERVED_BASENAMES);
    if (includeAgentReadme) reserved.add('readme.md');
    if (reserved.has(basename.toLowerCase())) {
      const renamedBase = basename.replace(/\.md$/i, '-page.md');
      report.renamed.push({
        from: page.path,
        to: [...parts, renamedBase].join('/'),
      });
      basename = renamedBase;
    }
    newPath = [...parts, basename].join('/');
    // Slug collision (two source pages mapping to the same slug).
    if (taken.has(newPath)) {
      let i = 2;
      const stem = newPath.replace(/\.md$/, '');
      while (taken.has(`${stem}-${i}.md`)) i += 1;
      report.renamed.push({ from: page.path, to: `${stem}-${i}.md` });
      newPath = `${stem}-${i}.md`;
    }
    taken.add(newPath);
    mappings.push({ path: page.path, content: page.content, newPath });
  }

  const resolve = makeTargetResolver(mappings);

  // 3. Transform each page: frontmatter mapping + link rewriting.
  const documents = [];
  for (const m of mappings) {
    const { frontmatter, body } = parseFrontmatter(m.content);
    const basename = m.newPath.split('/').pop().replace(/\.md$/, '');
    const okfFrontmatter = buildOkfFrontmatter(
      frontmatter, body, basename, now, report.warnings,
    );
    const newBody = rewriteWikilinks(body, m.newPath, resolve, report).trim();
    const content = `${serializeOkfFrontmatter(okfFrontmatter)}\n\n${newBody}\n`;
    documents.push({ ...m, okfFrontmatter, content });
  }
  report.documentCount = documents.length;

  // 4. Assemble output files: documents + indexes + log (+ optional README).
  const resolvedSummary =
    (typeof summary === 'string' && summary.trim()) ||
    `Knowledge bundle exported from the "${vaultName}" Obsidian vault.`;

  const files = documents.map((d) => ({ path: d.newPath, content: d.content }));

  files.push(
    ...buildDirectoryIndexes({ documents, vaultName, summary: resolvedSummary }),
  );

  const logDate = now.slice(0, 10);
  files.push({
    path: 'log.md',
    content: [
      '# Update Log',
      '',
      `## ${logDate}`,
      `* **Creation**: Exported ${documents.length} document${
        documents.length === 1 ? '' : 's'
      } from the "${vaultName}" Obsidian vault by obsidian-mcp-router (wiki-export, OKF v${OKF_VERSION} target).`,
      '',
    ].join('\n'),
  });

  if (includeAgentReadme) {
    files.push({
      path: 'README.md',
      content: buildAgentReadme({
        vaultName,
        summary: resolvedSummary,
        documentCount: documents.length,
      }),
    });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, report };
}
