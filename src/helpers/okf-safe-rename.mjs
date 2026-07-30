/**
 * OKF-safe AT-REST rename planner — bring a vault's EXISTING file and folder
 * names into the charset Google's OKF reference implementation accepts
 * (`[A-Za-z0-9_][A-Za-z0-9_.\-]*` — no spaces, no accents), WITHOUT breaking
 * a single link.
 *
 * Two planning modes share the whole rewrite/verify machinery downstream:
 *   - CHARSET mode (`buildRenamePlan`) — every non-conformant name is
 *     slugified. The original 2026-07-29 fleet migration.
 *   - TABLE mode (`buildRenamePlanFromTable`) — an EXPLICIT list of
 *     oldPath→newPath pairs, for renames a charset rule can never derive:
 *     `wiki-meta/index.md` is perfectly OKF-safe, it just has to move out of
 *     the way because OKF *reserves* the basename (Roland's 2026-07-30
 *     `catalog`/`journal` decision). See `RENAME_PRESETS`.
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
 *     the alias so the rendered text the reader sees does not change — unless
 *     the caller opts out with `buildRewriteContext(plan, {preserveDisplay:
 *     false})`, which rewrites the visible text too. Opting out is right when
 *     the old display text is itself the problem: keeping `[[catalog|index]]`
 *     next to a real OKF `index.md` would preserve exactly the ambiguity the
 *     rename was meant to remove.
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
// Explicit rename-table mode
// ---------------------------------------------------------------------------

/**
 * Named rename tables shipped with the tool, so a fleet-wide rename is a
 * documented, testable artifact rather than an argument typed at a prompt.
 *
 * `preserveDisplay: false` is part of the preset's DEFINITION, not an
 * operator choice: see the module header.
 */
export const RENAME_PRESETS = {
  'okf-reserved-scaffolds': {
    description:
      "free the basenames OKF reserves (`index`, `log`) by renaming our private wiki-meta scaffolds — Roland's 2026-07-30 catalog/journal decision",
    preserveDisplay: false,
    renames: [
      { oldPath: 'wiki-meta/index.md', newPath: 'wiki-meta/catalog.md' },
      { oldPath: 'wiki-meta/log.md', newPath: 'wiki-meta/journal.md' },
    ],
    // A pure rename would leave `catalog.md` announcing itself as `# Index` —
    // the one word the rename exists to retire, still on screen. Word-level,
    // H1 and `title:` only, on the RENAMED file. `type:` is deliberately NOT
    // touched: it is a semantic key the lint/graph/context-pack consumers
    // match on, not a name.
    retitle: [
      { path: 'wiki-meta/catalog.md', words: [['Index', 'Catalog']] },
      { path: 'wiki-meta/journal.md', words: [['Log', 'Journal']] },
    ],
  },
};

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

/**
 * Retitle one scaffold: substitute whole words in its `title:` frontmatter
 * value and its first H1 — nothing else in the file. Idempotent, because the
 * old word is gone after the first pass.
 *
 * @param {string} content
 * @param {Array<[string, string]>} words `[[from, to], …]`, matched whole-word
 * @returns {{content: string, edits: number, changed: boolean}}
 */
export function retitleScaffold(content, words) {
  let edits = 0;
  const swap = (line) => {
    let out = line;
    for (const [from, to] of words) {
      const re = new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
      out = out.replace(re, () => {
        edits += 1;
        return to;
      });
    }
    return out;
  };

  const fm = content.match(FRONTMATTER_RE);
  let head = '';
  let rest = content;
  if (fm) {
    // Rewrite only the `title:` line, in place, so the block's original line
    // endings and every other key survive byte-for-byte.
    const block = fm[0].replace(/^([ \t]*title[ \t]*:[ \t]*)(.+)$/m, (_w, key, val) => `${key}${swap(val)}`);
    head = content.slice(0, fm.index) + block;
    rest = content.slice(fm.index + fm[0].length);
  }

  // First ATX H1 of the BODY only. Scanning the whole file would let a `#`
  // comment inside the frontmatter consume the "first H1" slot, leaving the
  // real title untouched with no signal.
  let h1Done = false;
  rest = rest.replace(/^# .*$/gm, (line) => {
    if (h1Done) return line;
    h1Done = true;
    return swap(line);
  });

  const out = head + rest;
  return { content: out, edits, changed: out !== content };
}

/** Accept `[{oldPath,newPath}]`, `[[old,new]]` or a `Map`. */
function normalizeTable(table) {
  const raw = table instanceof Map ? [...table.entries()] : Array.from(table ?? []);
  return raw.map((e) => {
    const [oldPath, newPath] = Array.isArray(e) ? e : [e.oldPath, e.newPath];
    const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
    return { oldPath: norm(oldPath), newPath: norm(newPath) };
  });
}

/** `a/b/c.md` → `a/b` · `c.md` → `''` */
function dirOf(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

/**
 * A table entry is only allowed to change the NAME of something, never its
 * location, and must stay inside the vault.
 *
 * Why refuse the move rather than implement it: the apply step renames by
 * basename within the entry's own parent directory — which is *required* in
 * charset mode, where ancestors still carry their old names when files are
 * renamed. A `newPath` in a different directory would silently lose its
 * directory component: the file would land next to the original while links
 * and the manifest recorded the intended destination, and verification would
 * still pass (file count stable, old path gone). Freeing a reserved basename
 * never needs a move, so the honest answer is to refuse one.
 *
 * @returns {string | null} a collision reason, or null when the entry is fine
 */
function tableEntryRejection(oldPath, newPath) {
  const hasDotDot = (p) => p.split('/').includes('..');
  if (hasDotDot(oldPath) || hasDotDot(newPath)) {
    return 'path escapes the vault (`..` segment) — refusing';
  }
  if (dirOf(oldPath) !== dirOf(newPath)) {
    return `cross-directory move is not supported (rename in place): "${dirOf(oldPath) || '<root>'}" → "${dirOf(newPath) || '<root>'}"`;
  }
  return null;
}

/**
 * Build a rename plan from an EXPLICIT oldPath→newPath table.
 *
 * Same output shape as `buildRenamePlan` (so every downstream helper —
 * `buildRewriteContext`, `rewriteNoteContent`, `buildExactPathMap`,
 * `rewriteExactPaths`, `orderRenameOps` — works unchanged), plus two fields
 * that only make sense when a human dictated the names:
 *
 *   - `collisions` — BLOCKING. Unlike charset mode, we never invent a `-2`
 *     suffix: the operator asked for `catalog.md`, so silently producing
 *     `catalog-2.md` would be a worse outcome than refusing.
 *   - `missing` — table entries with no match in this vault. Not an error:
 *     the same table runs against 24 vaults and not all carry every file.
 *
 * `ambiguousStems` is stricter here than in charset mode. Charset mode only
 * has to worry about two RENAMED files whose old stem collides; a table also
 * has to worry about a renamed file whose old stem is shared by a file it is
 * NOT renaming — `[[index]]` cannot be retargeted to `catalog` if some other
 * `Index.md` in the vault might be what the author meant. Those links are
 * left untouched and reported (`ambiguityDetail` says which files clashed).
 *
 * @param {string[]} filePaths ALL file paths, vault-relative, posix.
 * @param {Array<{oldPath: string, newPath: string}>|Map<string,string>} table
 */
export function buildRenamePlanFromTable(filePaths, table) {
  const all = filePaths.map((p) => String(p).replace(/\\/g, '/'));
  const allLower = new Set(all.map((p) => p.toLowerCase()));
  const entries = normalizeTable(table);

  const renameOps = [];
  const fileMap = new Map();
  const stemRenames = [];
  const collisions = [];
  const missing = [];
  const claimedLower = new Map(); // newPath lower → oldPath that claimed it

  // PASS 1 — entry-level validity: shape, escape, in-place, existence.
  const viable = [];
  for (const entry of entries) {
    const { oldPath, newPath } = entry;
    if (!oldPath || !newPath) {
      collisions.push({ oldPath, newPath, reason: 'incomplete table entry (empty oldPath or newPath)' });
      continue;
    }
    if (oldPath === newPath) continue; // no-op — keeps re-runs idempotent

    const rejection = tableEntryRejection(oldPath, newPath);
    if (rejection) {
      collisions.push({ oldPath, newPath, reason: rejection });
      continue;
    }

    const isFile = allLower.has(oldPath.toLowerCase());
    const descendants = all.filter((p) => p.toLowerCase().startsWith(`${oldPath.toLowerCase()}/`));
    const isDir = !isFile && descendants.length > 0;
    if (!isFile && !isDir) {
      missing.push(oldPath);
      continue;
    }
    viable.push({ oldPath, newPath, isDir, descendants });
  }

  // PASS 2 — two entries cannot claim the same destination. Independent of
  // vacancy, so it is settled once, first claimant wins (table order).
  let survivors = [];
  for (const e of viable) {
    const targetLower = e.newPath.toLowerCase();
    const alreadyClaimed = claimedLower.get(targetLower);
    if (alreadyClaimed) {
      collisions.push({
        oldPath: e.oldPath,
        newPath: e.newPath,
        reason: `two table entries target the same path (also claimed by "${alreadyClaimed}")`,
      });
      continue;
    }
    claimedLower.set(targetLower, e.oldPath);
    survivors.push(e);
  }

  // PASS 3 — chains and swaps. An entry whose destination is another entry's
  // SOURCE (`A→B, B→C`, or the swap `A→B, B→A`) is refused outright.
  //
  // Treating such a target as "free because the table vacates it" makes the
  // plan look clean while the apply destroys a file: renames execute in table
  // order with no topological sort, so `A→B` overwrites B before `B→C` ever
  // reads it. Verified by review — the dry-run printed a perfect plan and the
  // run ended with one file where there had been two, caught only after the
  // fact by the file-count check. Ordering them correctly (and detecting
  // cycles, which have no correct order at all) is real machinery for a case
  // no preset needs: freeing a reserved basename never chains. Refuse instead,
  // consistent with the cross-directory rule.
  const sourcesLower = new Set(survivors.map((e) => e.oldPath.toLowerCase()));
  survivors = survivors.filter((e) => {
    if (!sourcesLower.has(e.newPath.toLowerCase())) return true;
    collisions.push({
      oldPath: e.oldPath,
      newPath: e.newPath,
      reason:
        'target is the source of another table entry (chain or swap) — refusing: renames apply in table order, so one of the two files would be overwritten',
    });
    return false;
  });

  // PASS 4 — occupancy. With chains gone, a destination is simply free or not:
  // no entry can vacate another's target, so this needs no fixpoint.
  for (const e of survivors) {
    const targetLower = e.newPath.toLowerCase();
    const occupiedByFile = allLower.has(targetLower);
    const occupiedByDir = all.some((p) => p.toLowerCase().startsWith(`${targetLower}/`));
    if (occupiedByFile || occupiedByDir) {
      collisions.push({
        oldPath: e.oldPath,
        newPath: e.newPath,
        reason: `target already exists in the vault (${occupiedByFile ? 'file' : 'directory'}) — refusing to overwrite or auto-suffix`,
      });
    }
  }
  survivors = survivors.filter(
    (e) => !collisions.some((c) => c.oldPath === e.oldPath && c.newPath === e.newPath),
  );

  // PASS 5 — build the plan from what survived.
  for (const { oldPath, newPath, isDir, descendants } of survivors) {
    renameOps.push({ oldPath, newPath, isDir });
    if (isDir) {
      for (const p of descendants) {
        fileMap.set(p, newPath + p.slice(oldPath.length));
      }
    } else {
      fileMap.set(oldPath, newPath);
      const oldName = oldPath.split('/').pop();
      const newName = newPath.split('/').pop();
      if (isMd(oldName) && stemOf(oldName) !== stemOf(newName)) {
        stemRenames.push({ oldStem: stemOf(oldName), newStem: stemOf(newName), oldPath, newPath });
      }
    }
  }

  // --- Ambiguity: which basename-form wikilinks cannot be retargeted safely.
  const byOldStem = new Map();
  for (const r of stemRenames) {
    const key = r.oldStem.toLowerCase();
    if (!byOldStem.has(key)) byOldStem.set(key, { newStems: new Set(), renamed: [] });
    const slot = byOldStem.get(key);
    slot.newStems.add(r.newStem);
    slot.renamed.push(r.oldPath);
  }
  const renamedLower = new Set(stemRenames.map((r) => r.oldPath.toLowerCase()));
  const ambiguityDetail = [];
  for (const [stemKey, slot] of byOldStem) {
    // (a) the charset-mode rule: one old stem, several destinations.
    if (slot.newStems.size > 1) {
      ambiguityDetail.push({
        stem: stemKey,
        reason: 'the same old stem is renamed to several different new stems',
        renamed: slot.renamed,
        conflicting: [],
      });
      continue;
    }
    // (b) table-only rule: a same-stem file the table leaves in place.
    const conflicting = all.filter(
      (p) =>
        isMd(p) &&
        !renamedLower.has(p.toLowerCase()) &&
        stemOf(p.split('/').pop()).toLowerCase() === stemKey,
    );
    if (conflicting.length > 0) {
      ambiguityDetail.push({
        stem: stemKey,
        reason: 'another file in the vault shares this basename and is not renamed',
        renamed: slot.renamed,
        conflicting,
      });
    }
  }
  const ambiguousStems = ambiguityDetail.map((d) => d.stem);

  return {
    renameOps,
    fileMap,
    stemRenames,
    ambiguousStems,
    ambiguityDetail,
    collisionsResolved: [], // table mode never auto-suffixes
    collisions,
    missing,
  };
}

// ---------------------------------------------------------------------------
// Content rewriting
// ---------------------------------------------------------------------------

/**
 * Build the lookup context `rewriteNoteContent` needs, from a plan.
 *
 * @param {object} plan From `buildRenamePlan` or `buildRenamePlanFromTable`
 * @param {{preserveDisplay?: boolean}} [opts] `preserveDisplay: false` stops
 *   un-aliased wikilinks from gaining the old target as an alias — the
 *   rendered text changes with the target. Defaults to true (display-safe).
 */
export function buildRewriteContext(plan, opts = {}) {
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
  return {
    stemByOldLower,
    pathByOldLower,
    ambiguous,
    preserveDisplay: opts.preserveDisplay !== false,
  };
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
    // un-aliased non-embed link gets the OLD target text as its alias —
    // unless the caller asked for the display text to follow the target
    // (`preserveDisplay: false`), in which case nothing is injected. An
    // alias the AUTHOR wrote is kept either way: it is a deliberate
    // display choice, not a migration artefact.
    const addAlias = ctx.preserveDisplay !== false && !bang;
    const keptAlias = alias !== null ? `|${alias}` : addAlias ? `|${trimmed}` : '';
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
