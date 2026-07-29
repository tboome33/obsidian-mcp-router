/**
 * OKF-safe AT-REST rename planner — bring a vault's EXISTING file and folder
 * names into the charset Google's OKF reference implementation accepts
 * (`[A-Za-z0-9_][A-Za-z0-9_.\-]*` — no spaces, no accents), WITHOUT breaking
 * a single link.
 *
 * Context (see vault note `wiki/Divers/okf/okf-interop.md` §4): the OKF v0.2
 * spec itself imposes NO filename charset — the constraint comes from
 * Google's tooling, and our exporter already slugifies at the boundary.
 * Roland's 2026-07-29 decision extends the constraint AT REST: vault names
 * are made OKF-safe once, in place, so exports become identity-preserving
 * and new notes are born conformant.
 *
 * Scope rules:
 *   - `.md` files: the STEM is slugified when non-conformant (extension kept).
 *   - Directories: the NAME is slugified when non-conformant.
 *   - Other files (images, pdf…): never renamed — but their PATH may change
 *     when an ancestor directory is renamed, so path-based references to
 *     them are rewritten too.
 *   - Dot-directories (`.obsidian`, `.trash`…) and `node_modules` are never
 *     walked nor renamed.
 *
 * What gets rewritten in content:
 *   - wikilinks and embeds `[[…]]` / `![[…]]` (basename-form and path-form,
 *     `#anchor` and `|alias` preserved). When a basename changes and the
 *     link had no alias (and is not an embed), the OLD target text becomes
 *     the alias so the rendered text the reader sees does not change.
 *   - markdown links `](…)` whose (URL-decoded, `.`/`..`-resolved) target is
 *     a renamed file — rebuilt relative to the citing note's NEW path.
 *   - `.canvas` / `.base` files: exact old-path string occurrences replaced.
 *
 * Collisions are resolved deterministically per directory (case-insensitive,
 * Windows-safe): first claimant (by old-name sort) keeps the slug, later
 * ones get `-2`, `-3`… Duplicate OLD stems that map to DIFFERENT new stems
 * make basename-form wikilinks ambiguous: those links are left untouched
 * and reported instead of guessed at.
 *
 * Pure module: no I/O — the CLI (`scripts/okf-safe-rename-vault.mjs`) walks
 * the filesystem, feeds paths/contents in, and applies the returned plan.
 */

import { slugifyOkfSegment, joinVaultRelativePath, relativeLink } from './okf-bundle-exporter.mjs';

/** Charset Google's reference implementation accepts for one path segment. */
const OKF_SAFE_SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

export function isOkfSafeSegment(segment) {
  return OKF_SAFE_SEGMENT_RE.test(String(segment));
}

const MD_EXT_RE = /\.md$/i;

function isMd(name) {
  return MD_EXT_RE.test(name);
}

function stemOf(mdName) {
  return mdName.replace(MD_EXT_RE, '');
}

/**
 * Propose the new name for one directory entry (no collision handling here).
 * Non-md files keep their name unconditionally.
 */
function proposeName(name, isDir) {
  if (isDir) return isOkfSafeSegment(name) ? name : slugifyOkfSegment(name);
  if (!isMd(name)) return name;
  const stem = stemOf(name);
  return isOkfSafeSegment(stem) ? name : `${slugifyOkfSegment(stem)}.md`;
}

/** `foo.md` + 2 → `foo-2.md` · `foo` (dir) + 2 → `foo-2` */
function suffixName(name, n, isDir) {
  if (!isDir && isMd(name)) return `${stemOf(name)}-${n}.md`;
  return `${name}-${n}`;
}

/**
 * Build the rename plan for a whole vault.
 *
 * @param {string[]} filePaths ALL file paths (any extension), vault-relative,
 *   posix separators, no leading `./`.
 * @returns {{
 *   renameOps: Array<{oldPath: string, newPath: string, isDir: boolean}>,
 *   fileMap: Map<string, string>,        // every FILE whose full path changes
 *   stemRenames: Array<{oldStem: string, newStem: string, oldPath: string, newPath: string}>,
 *   ambiguousStems: string[],            // old stems with >1 distinct new stem
 *   collisionsResolved: Array<{oldPath: string, newPath: string}>,
 * }}
 */
export function buildRenamePlan(filePaths) {
  // children(oldDirPath) → [{ name, isDir }]
  const children = new Map();
  const dirSet = new Set();
  const addChild = (parent, name, isDir) => {
    const key = parent;
    if (!children.has(key)) children.set(key, new Map());
    const sibs = children.get(key);
    const existing = sibs.get(name);
    if (!existing) sibs.set(name, { name, isDir });
    else if (isDir) existing.isDir = true;
  };
  for (const p of filePaths) {
    const segs = p.split('/').filter(Boolean);
    let parent = '';
    for (let i = 0; i < segs.length; i += 1) {
      const isDir = i < segs.length - 1;
      addChild(parent, segs[i], isDir);
      if (isDir) {
        parent = parent ? `${parent}/${segs[i]}` : segs[i];
        dirSet.add(parent);
      }
    }
  }

  const renameOps = [];
  const fileMap = new Map();
  const stemRenames = [];
  const collisionsResolved = [];

  const walk = (oldParent, newParent) => {
    const sibs = children.get(oldParent);
    if (!sibs) return;
    const entries = [...sibs.values()].sort((a, b) => a.name.localeCompare(b.name));
    const taken = new Set(); // lowercased FINAL names in this directory
    // Entries keeping their name claim it first — a renamed sibling must
    // never collide into an untouched one.
    const proposals = entries.map((e) => ({ ...e, proposed: proposeName(e.name, e.isDir) }));
    for (const e of proposals) if (e.proposed === e.name) taken.add(e.name.toLowerCase());
    for (const e of proposals) {
      let finalName = e.proposed;
      if (finalName !== e.name) {
        let n = 2;
        while (taken.has(finalName.toLowerCase())) {
          finalName = suffixName(e.proposed, n, e.isDir);
          n += 1;
        }
        taken.add(finalName.toLowerCase());
      }
      const oldPath = oldParent ? `${oldParent}/${e.name}` : e.name;
      const newPath = newParent ? `${newParent}/${finalName}` : finalName;
      if (finalName !== e.name) {
        renameOps.push({ oldPath, newPath, isDir: e.isDir });
        if (finalName !== e.proposed) collisionsResolved.push({ oldPath, newPath });
      }
      if (!e.isDir) {
        if (newPath !== oldPath) fileMap.set(oldPath, newPath);
        if (isMd(e.name) && finalName !== e.name) {
          stemRenames.push({
            oldStem: stemOf(e.name),
            newStem: stemOf(finalName),
            oldPath,
            newPath,
          });
        }
      } else {
        walk(oldPath, newPath);
      }
    }
  };
  walk('', '');

  // Basename-form wikilinks resolve by stem alone: an old stem shared by two
  // files that end up with DIFFERENT new stems cannot be rewritten safely.
  const byOldStem = new Map();
  for (const r of stemRenames) {
    const key = r.oldStem.toLowerCase();
    if (!byOldStem.has(key)) byOldStem.set(key, new Set());
    byOldStem.get(key).add(r.newStem);
  }
  const ambiguousStems = [...byOldStem.entries()]
    .filter(([, news]) => news.size > 1)
    .map(([stem]) => stem);

  return { renameOps, fileMap, stemRenames, ambiguousStems, collisionsResolved };
}

// ---------------------------------------------------------------------------
// Content rewriting
// ---------------------------------------------------------------------------

/**
 * Build the lookup context `rewriteNoteContent` needs, from a plan.
 */
export function buildRewriteContext(plan) {
  const ambiguous = new Set(plan.ambiguousStems.map((s) => s.toLowerCase()));
  const stemByOldLower = new Map();
  for (const r of plan.stemRenames) {
    const key = r.oldStem.toLowerCase();
    if (!ambiguous.has(key)) stemByOldLower.set(key, r.newStem);
  }
  const pathByOldLower = new Map();
  for (const [oldPath, newPath] of plan.fileMap) {
    pathByOldLower.set(oldPath.toLowerCase(), newPath);
  }
  return { stemByOldLower, pathByOldLower, ambiguous };
}

const WIKILINK_TOKEN_RE = /(!?)\[\[([^\]]+)\]\]/g;
const MD_LINK_TARGET_RE = /(\]\()([^()\s]+)(\))/g;
const EXTERNAL_TARGET_RE = /^[a-z][a-z0-9+.-]*:/i; // http:, https:, mailto:, obsidian:…

function splitWikiRaw(raw) {
  const pipeIdx = raw.indexOf('|');
  const alias = pipeIdx >= 0 ? raw.slice(pipeIdx + 1) : null;
  const noAlias = pipeIdx >= 0 ? raw.slice(0, pipeIdx) : raw;
  const hashIdx = noAlias.indexOf('#');
  const anchor = hashIdx >= 0 ? noAlias.slice(hashIdx) : '';
  const target = hashIdx >= 0 ? noAlias.slice(0, hashIdx) : noAlias;
  return { target, anchor, alias };
}

function tryDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Rewrite one note's content against the rename plan.
 *
 * @param {string} content The note's markdown source
 * @param {string} notePath The note's OLD vault-relative path (posix)
 * @param {object} ctx From `buildRewriteContext`
 * @returns {{content: string, edits: number, skippedAmbiguous: number}}
 */
export function rewriteNoteContent(content, notePath, ctx) {
  let edits = 0;
  let skippedAmbiguous = 0;
  const noteNewPath = ctx.pathByOldLower.get(notePath.toLowerCase()) ?? notePath;
  const noteOldDir = notePath.split('/').slice(0, -1).join('/');

  let out = content.replace(WIKILINK_TOKEN_RE, (whole, bang, raw) => {
    const { target, anchor, alias } = splitWikiRaw(raw);
    const trimmed = target.trim();
    if (!trimmed) return whole;
    let newTarget = null;
    if (trimmed.includes('/')) {
      // Path-form wikilink — vault-root relative in Obsidian. Try the raw
      // target first (assets, or md written with its extension), then `.md`.
      const lower = trimmed.toLowerCase();
      let mapped = ctx.pathByOldLower.get(lower);
      let extWritten = true;
      if (!mapped && !isMd(trimmed)) {
        mapped = ctx.pathByOldLower.get(`${lower}.md`);
        extWritten = false;
      }
      if (mapped) newTarget = extWritten ? mapped : mapped.replace(MD_EXT_RE, '');
    } else {
      const stemKey = stemOf(trimmed).toLowerCase();
      if (ctx.ambiguous.has(stemKey)) {
        skippedAmbiguous += 1;
        return whole;
      }
      const mappedStem = ctx.stemByOldLower.get(stemKey);
      if (mappedStem) newTarget = isMd(trimmed) ? `${mappedStem}.md` : mappedStem;
    }
    if (newTarget === null || newTarget === trimmed) return whole;
    edits += 1;
    // Preserve what the reader sees: aliased links keep their alias; an
    // un-aliased non-embed link gets the OLD target text as its alias.
    const keptAlias = alias !== null ? `|${alias}` : bang ? '' : `|${trimmed}`;
    return `${bang}[[${newTarget}${anchor}${keptAlias}]]`;
  });

  out = out.replace(MD_LINK_TARGET_RE, (whole, open, rawTarget, close) => {
    if (EXTERNAL_TARGET_RE.test(rawTarget) || rawTarget.startsWith('#')) return whole;
    const decoded = tryDecode(rawTarget);
    const resolved = decoded.startsWith('/')
      ? joinVaultRelativePath('', decoded)
      : joinVaultRelativePath(noteOldDir, decoded);
    const mapped = ctx.pathByOldLower.get(resolved.toLowerCase());
    if (!mapped) return whole;
    edits += 1;
    const newTarget = decoded.startsWith('/') ? `/${mapped}` : relativeLink(noteNewPath, mapped);
    return `${open}${newTarget}${close}`;
  });

  return { content: out, edits, skippedAmbiguous, changed: out !== content };
}

/**
 * Combine every exact old→new path string a vault can contain: full FILE
 * paths (including files merely carried along by a directory rename) plus
 * DIRECTORY paths themselves — session journals and docs cite bare folder
 * paths too. Used for the raw-text replacement pass.
 */
export function buildExactPathMap(plan) {
  const map = new Map(plan.fileMap);
  for (const op of plan.renameOps) {
    if (op.isDir) map.set(op.oldPath, op.newPath);
  }
  return map;
}

/**
 * Rewrite exact old-path occurrences anywhere in a text file (`.canvas`,
 * `.base`, and the raw-text pass over `.md` — session journals, CLAUDE.md…).
 * Longest paths first so nested paths never partially match.
 *
 * @param {string} content
 * @param {Map<string, string>} pathMap old → new exact strings
 */
export function rewriteExactPaths(content, pathMap) {
  let out = content;
  let edits = 0;
  const entries = [...pathMap.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [oldPath, newPath] of entries) {
    if (out.includes(oldPath)) {
      edits += out.split(oldPath).length - 1;
      out = out.split(oldPath).join(newPath);
    }
  }
  return { content: out, edits, changed: out !== content };
}

/**
 * Ingestion-time guard (Roland's 2026-07-29 decision): new notes are born
 * OKF-safe. Returns `null` when the path conforms (or is not a `.md`, or
 * lives under a hidden directory) — otherwise the suggested conformant
 * path, every offending segment slugified.
 *
 * @param {string} filePath Vault-relative path, `/` separators
 * @returns {string | null}
 */
export function okfSafePathSuggestion(filePath) {
  if (!isMd(filePath)) return null;
  const segs = String(filePath).split('/').filter(Boolean);
  if (segs.some((s) => s.startsWith('.'))) return null;
  let dirty = false;
  const fixed = segs.map((seg, i) => {
    const isLast = i === segs.length - 1;
    const stem = isLast ? stemOf(seg) : seg;
    if (isOkfSafeSegment(stem)) return seg;
    dirty = true;
    return isLast ? `${slugifyOkfSegment(stem)}.md` : slugifyOkfSegment(stem);
  });
  return dirty ? fixed.join('/') : null;
}

/**
 * Order rename operations for safe filesystem application:
 * files first (their parent dirs still exist under old names), then
 * directories DEEPEST first (each dir rename happens while its own parent
 * path is still the old one).
 */
export function orderRenameOps(renameOps) {
  const files = renameOps.filter((r) => !r.isDir);
  const dirs = renameOps
    .filter((r) => r.isDir)
    .sort((a, b) => b.oldPath.split('/').length - a.oldPath.split('/').length);
  return [...files, ...dirs];
}
