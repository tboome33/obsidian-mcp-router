/**
 * TWO FOLDERS NAMED "Sessions" — detecting the scaffold collision.
 *
 * THE INCIDENT. A `code`-mode vault (`racontemoi.kiviri.fr`) ended up with two
 * unrelated directories holding "session" content and no cross-reference
 * between them:
 *
 *   - `wiki-meta/Sessions/`  the raw chronological journals the
 *                            `session-auto-journal` hook writes, one file per
 *                            Claude Code session. This has been their home
 *                            since v0.12.8, which MOVED them out of `wiki/`
 *                            precisely so generated logs would stop sitting
 *                            among the user's content pages. It is also what
 *                            `journal.md`'s own auto-generated header points
 *                            at, what the `save` skill refuses to write to,
 *                            and what `DEFAULT_EXCLUDE_FOLDERS` keeps out of
 *                            the search corpus.
 *   - `wiki/Sessions/`       an *area* of the catalogue, because the `code`
 *                            wiki-mode seeded `## Sessions` into `catalog.md`.
 *
 * An agent reading `catalog.md` — the documented way to find where a note
 * belongs — was told a `Sessions` area exists under `wiki/`, and filed a
 * session recap there. Nothing was broken enough to raise an error; the two
 * folders simply drifted apart until a human noticed.
 *
 * WHY A DETECTOR AND NOT ONLY A SEED FIX. Removing `Sessions` from the seed
 * stops NEW vaults from being born with the collision, and `isWikiMetaOwnedArea`
 * below stops any future mode list — including the `domain` mode's sections,
 * which an LLM composes at runtime and which no static review covers — from
 * reintroducing it. Neither helps the vaults that already have it, and neither
 * catches the *other* way in: a vault still carrying the pre-v0.12.8
 * `wiki/sessions/` folder whose files the migration merged only partially.
 * A fleet scan of 30 vaults found four such vaults, only one of which came
 * from the `code`-mode seed. So the seed fix and the detector answer different
 * halves of the same defect, and shipping only the first would have read as
 * closed while three vaults stayed wrong.
 *
 * This module is PURE — vault-relative paths in, findings out. The caller does
 * the I/O, so the same rules serve a disk walk (`scripts/okf-projections.mjs`)
 * and a router `list_files` enumeration without a second implementation to
 * keep in sync.
 */

/**
 * Area names under `wiki/` that `wiki-meta/` already owns.
 *
 * An entry here means: a directory of this name under `wiki/` is a collision,
 * not a legitimate content area, because a directory of that name under
 * `wiki-meta/` is the canonical home of that content type. Matching is
 * case-insensitive — Windows filesystems treat `Sessions` and `sessions` as
 * one directory, and vaults in the fleet carry both spellings.
 */
export const WIKI_META_OWNED_AREAS = Object.freeze(['Sessions']);

const OWNED_LOWER = new Set(WIKI_META_OWNED_AREAS.map((a) => a.toLowerCase()));

/**
 * Basenames the OKF projections reserve. Exported so a caller knows which files
 * are worth reading the generated-marker out of; the detector itself does NOT
 * use this list to skip anything — a reserved basename is not proof a file was
 * generated, and treating it as such was a real defect (see
 * `detectSessionFolderCollision`).
 */
export const PROJECTION_BASENAMES = Object.freeze(['index.md', 'log.md']);

/**
 * Would a catalogue area of this name collide with a `wiki-meta/` folder?
 *
 * Tolerant on purpose: seeds arrive as human-facing headings, and a `domain`
 * mode's list comes from an LLM, so `" sessions/"` and `"Sessions"` must both
 * be caught. Anything that is not a non-empty string is NOT owned — a caller
 * passing junk gets its junk back rather than a silent drop.
 *
 * @param {unknown} name candidate area/section name
 * @returns {boolean}
 */
export function isWikiMetaOwnedArea(name) {
  if (typeof name !== 'string') return false;
  return OWNED_LOWER.has(normaliseAreaName(name));
}

/**
 * What a section name RENDERS as, lowercased — the thing a reader (or an agent
 * reading the catalogue) actually sees.
 *
 * Comparing the raw string was a second review round's finding. A section named
 * `Sessions ##` passed the guard and the seeder emitted `## Sessions ##`, which
 * Markdown renders as a heading called **Sessions**: the collision, spelled so
 * the check could not see it. The template sweep shared the blind spot exactly,
 * because it captures the heading text and asks this same question — so a guard
 * and its supposedly independent scan were blind together, which is the worst
 * shape a pair of checks can have.
 *
 * Stripped, in order: surrounding whitespace, a trailing path separator, ATX
 * closing hashes, and a wrapping run of emphasis markers (`**Sessions**`,
 * `_Sessions_`, `` `Sessions` ``). Only WRAPPING markup goes — a legitimate area
 * called `Sessions de travail` or `Session Notes` survives untouched, because
 * nothing here removes interior characters.
 */
function normaliseAreaName(name) {
  let s = String(name).trim();
  s = s.replace(/[/\\]+$/, '').trim();       // trailing path separator
  s = s.replace(/\s*#+\s*$/, '').trim();     // ATX closing hashes
  // Peel matched emphasis wrappers, innermost last: `**_x_**` → `x`.
  for (let i = 0; i < 4; i += 1) {
    const peeled = s.replace(/^(\*{1,3}|_{1,3}|`{1,3})([\s\S]+?)\1$/, '$2').trim();
    if (peeled === s) break;
    s = peeled;
  }
  return s.toLowerCase();
}

/**
 * Split a seeded section list into the areas that may be laid out and the ones
 * a `wiki-meta/` folder already owns.
 *
 * Used by the catalogue seeder as the single funnel every mode passes through,
 * so a reserved name cannot re-enter via a new static mode list OR via the
 * `domain` mode's runtime sections. Returns rather than throws: the caller
 * decides whether to warn or fail, and a rejected section must never silently
 * vanish — `rejected` exists so it can be reported.
 *
 * @param {string[]} sections
 * @returns {{areas: string[], rejected: string[]}}
 */
export function partitionSeededAreas(sections) {
  const areas = [];
  const rejected = [];
  for (const section of Array.isArray(sections) ? sections : []) {
    (isWikiMetaOwnedArea(section) ? rejected : areas).push(section);
  }
  return { areas, rejected };
}

/** Normalise a vault-relative path to lowercase `/`-joined segments. */
function segments(p) {
  if (typeof p !== 'string') return null;
  const parts = p.split(/[/\\]+/).filter((s) => s && s !== '.');
  return parts.length ? parts : null;
}

/**
 * Scan a vault's file list for the two-`Sessions`-folders drift.
 *
 * @param {Array<string | {path: string, generated?: boolean}>} entries
 *   vault-relative paths (any separator, any case). Pass an OBJECT when the
 *   caller knows whether a file is a generated projection — see below.
 * @returns {{findings: Array<{rule: string, severity: string, area: string,
 *   wikiDirs: string[], metaDirs: string[], wikiFiles: string[],
 *   metaFiles: string[], detail: string}>}}
 *
 * Two rules, because the two states need different repairs:
 *
 *   `session-folder-collision` — both `wiki/<area>/` and `wiki-meta/<area>/`
 *     hold content. This is the incident: two homes, no cross-reference. The
 *     repair is a judgement call about the `wiki/` files (they may be curated
 *     syntheses that belong in a real content area, NOT raw logs to be merged
 *     into `wiki-meta/`), so the detector reports and never proposes a move.
 *
 *   `session-folder-stray` — only `wiki/<area>/` holds content. Either a
 *     pre-v0.12.8 vault whose migration never ran, or a fresh misfile in a
 *     vault the auto-journal hook has not written to yet. Reported at a lower
 *     severity because there is nothing to reconcile against, but it is the
 *     same wrong location.
 *
 * WHAT COUNTS AS CONTENT, and why a basename is not enough. Generated OKF
 * projections (`index.md`, `log.md`) do not count: they are written BY the
 * router because content was there, and they outlive it, so counting them would
 * flag exactly the vaults whose misfiled note was just moved away. But the rest
 * of this repo is emphatic that the reserved BASENAME does not make a file
 * generated — `planProjectionWrites` treats an UNMARKED file at a reserved path
 * as a user-owned conflict and refuses to touch it. A review round showed the
 * cost of forgetting that here: a hand-written `wiki/Sessions/index.md` beside a
 * canonical journal produced NO finding, and a hand-written
 * `wiki-meta/Sessions/log.md` downgraded a real collision to a warning.
 *
 * So the marker decides, and the caller supplies it: pass
 * `{path, generated: true}` for a file whose body carries the
 * `> Generated by obsidian-mcp-router` line. A bare string means "not known to
 * be generated", i.e. content — the safe default, because over-reporting a
 * generated file is a false positive a human dismisses in one glance, while
 * under-reporting a hand-written one is the silence this whole module exists to
 * end. `explicit: false` on the object says the same thing louder.
 */
export function detectSessionFolderCollision(entries) {
  /** @type {Map<string, {wiki: {dirs: Set<string>, files: string[]}, meta: {dirs: Set<string>, files: string[]}}>} */
  const areas = new Map();

  for (const raw of Array.isArray(entries) ? entries : []) {
    const isObject = raw !== null && typeof raw === 'object' && !Array.isArray(raw);
    const p = isObject ? raw.path : raw;
    const generated = isObject ? raw.generated === true : false;
    if (generated) continue;

    const segs = segments(p);
    if (!segs || segs.length < 3) continue;
    const root = segs[0].toLowerCase();
    if (root !== 'wiki' && root !== 'wiki-meta') continue;
    const areaLower = segs[1].toLowerCase();
    if (!OWNED_LOWER.has(areaLower)) continue;
    if (!segs[segs.length - 1].toLowerCase().endsWith('.md')) continue;

    if (!areas.has(areaLower)) {
      areas.set(areaLower, {
        wiki: { dirs: new Set(), files: [] },
        meta: { dirs: new Set(), files: [] },
      });
    }
    const entry = areas.get(areaLower);
    const side = root === 'wiki' ? entry.wiki : entry.meta;
    // The FULL vault-relative path, not a directory plus a relative tail. The
    // two spellings `wiki/Sessions/` and `wiki/sessions/` can coexist on a
    // case-sensitive filesystem, and the earlier shape kept one `dir` per side —
    // overwritten by whichever file came last — so a file's reported location
    // depended on input order and could name a directory it is not in.
    side.dirs.add(`${segs[0]}/${segs[1]}`);
    side.files.push(segs.join('/'));
  }

  const findings = [];
  for (const [areaLower, entry] of [...areas.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (entry.wiki.files.length === 0) continue; // wiki-meta alone is the correct state
    const canonical = WIKI_META_OWNED_AREAS.find((a) => a.toLowerCase() === areaLower) || areaLower;
    const collision = entry.meta.files.length > 0;
    const wikiDirs = [...entry.wiki.dirs].sort();
    const metaDirs = [...entry.meta.dirs].sort();
    const where = (dirs, fallback) => (dirs.length ? dirs.map((d) => `${d}/`).join(' + ') : `${fallback}/`);
    findings.push({
      rule: collision ? 'session-folder-collision' : 'session-folder-stray',
      severity: collision ? 'error' : 'warning',
      area: canonical,
      wikiDirs,
      metaDirs,
      wikiFiles: entry.wiki.files.sort(),
      metaFiles: entry.meta.files.sort(),
      detail: collision
        ? `${entry.wiki.files.length} file(s) under ${where(wikiDirs)} and ${entry.meta.files.length} under ${where(metaDirs)} — `
          + `two homes for "${canonical}" content with no cross-reference. `
          // The CANONICAL spelling, deliberately, not the on-disk one: a vault
          // whose folder is `wiki-meta/sessions/` should still be told the name
          // to converge on.
          + `wiki-meta/${canonical}/ is the canonical one (session-auto-journal writes there since v0.12.8); `
          + `decide per file whether the wiki/ ones are curated pages that belong in a real content area.`
        : `${entry.wiki.files.length} file(s) under ${where(wikiDirs)} — `
          + `session content belongs under wiki-meta/${canonical}/ (v0.12.8 layout), not under wiki/.`,
    });
  }

  return { findings };
}
