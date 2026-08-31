/**
 * resolve-vault-path — verify/repair a vault-relative path against the LOCAL
 * vault on disk, so build_open_link never emits a URL for a file that isn't
 * there.
 *
 * The click-to-open URL builder (`buildClickToOpenUrl`) URL-encodes whatever
 * path it's handed — garbage in, garbage out. That let a wrong path (e.g. an
 * invented sub-folder) produce a well-formed URL that 404s at the bridge. This
 * helper closes that gap deterministically: build_open_link calls it first and
 * either gets a verified path, an auto-corrected one (unique basename match),
 * or a clear miss it can surface as an error — but never a dead URL.
 *
 * TWO BACKENDS, ONE SET OF VERDICTS (v0.80.0). Until now this was
 * filesystem-only, and a vault with no local disk got `unverifiable` — which
 * did not matter while such a vault got a null URL anyway. Lot 2 changed that:
 * a diskless vault now DOES get a click-to-open URL, so an unverified one is
 * exactly the "well-formed URL that 404s at the bridge" this helper exists to
 * prevent.
 *
 * The fix is not to accept the gap. THE VERIFICATION NEVER NEEDED A DISK — it
 * needs to know whether a file exists, and the Local REST API answers that. So
 * `resolveVaultPathViaRest` mirrors the same five verdicts over
 * `listFilesIn`, and `unverifiable` shrinks from "this vault is remote"
 * (permanent) to "this vault did not answer" (transient).
 *
 * WHAT IT COSTS, stated honestly because an earlier estimate of mine was wrong.
 * The exact-path check is ONE listing of the parent directory — cheap, and it
 * is the overwhelmingly common case. The basename fallback is a bounded REST
 * WALK, which is dearer than the local `readdir` it mirrors; there is no
 * filename-search endpoint to lean on (`/search/simple/` searches CONTENT, so
 * it would return notes that MENTION the basename, not the file that bears it).
 * Callers resolving several paths in one operation must therefore share one
 * walk — see `makeRestWalker`.
 *
 * Verdicts:
 *   { status: 'ok',                   path }         exact path exists
 *   { status: 'corrected',            path, from }   exact miss, UNIQUE basename match
 *   { status: 'ambiguous',            matches }      exact miss, >1 basename match
 *   { status: 'not_found' }                          exact miss, PROVEN absent
 *   { status: 'resolution_incomplete' }              scan hit its budget before
 *                                                    uniqueness could be proven
 *   { status: 'unverifiable' }                       nothing to check against:
 *                                                    no path AND no REST answer
 *
 * `resolution_incomplete` matters for correctness: if the basename walk is
 * truncated (huge vault), a "0 matches so far" is NOT proof of absence and a
 * "1 match so far" is NOT proof of uniqueness — so we must not claim not_found
 * or corrected. Only a DEFINITIVE ≥2 match (ambiguity settled early) or a
 * COMPLETE scan yields those verdicts.
 */

import fs from 'node:fs';
import path from 'node:path';

// Directories never worth walking for a user-facing note basename. `.`-prefixed
// dirs (`.obsidian`, `.git`, `.trash`) are skipped wholesale.
const EXCLUDED_DIRS = new Set(['node_modules']);
// Hard cap on files scanned during a basename walk — a runaway-vault backstop.
// A miss is already the slow path (rare); this bounds worst case.
const MAX_SCAN = 20000;

/**
 * Pick the path library (win32 vs posix) matching the STYLE of the stored
 * vault path, not the runtime's. The registry stores Windows paths verbatim
 * even on a POSIX runtime (CI matrix) — same structural detection as
 * click-to-open.mjs::readInsecurePortConfig.
 */
function libFor(vaultPath) {
  const isWindowsStyle = /^[A-Za-z]:[\\/]/.test(vaultPath) || /^\\\\/.test(vaultPath);
  return isWindowsStyle ? path.win32 : path.posix;
}

function toAbs(lib, root, relPosix) {
  // relPosix uses '/'; convert to the target lib's separator before joining.
  return lib.join(root, relPosix.split('/').join(lib.sep));
}

/**
 * @param {object} vault - registry vault descriptor (needs type:'local' + path).
 * @param {string} relPath - vault-relative path (slashes `/` or `\`).
 * @returns {{status:string, path?:string, from?:string, matches?:string[]}}
 */
export function resolveVaultPathOnDisk(vault, relPath) {
  if (!vault || vault.type !== 'local' || !vault.path || !relPath || typeof relPath !== 'string') {
    return { status: 'unverifiable' };
  }
  const rel = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel) return { status: 'unverifiable' };

  const lib = libFor(vault.path);

  // 1. Exact path (file OR folder — folders are openable too).
  try {
    if (fs.existsSync(toAbs(lib, vault.path, rel))) {
      return { status: 'ok', path: rel };
    }
  } catch {
    // stat error (permissions, bad path) → treat as a miss, try basename.
  }

  // 2. Basename fallback — find files sharing the leaf name anywhere in the vault.
  const slash = rel.lastIndexOf('/');
  const basename = slash === -1 ? rel : rel.slice(slash + 1);
  if (!basename) return { status: 'not_found' };

  let matches;
  let truncated;
  try {
    ({ matches, truncated } = findByBasename(vault.path, lib, basename));
  } catch {
    return { status: 'resolution_incomplete' };
  }
  // ≥2 is definitive ambiguity regardless of truncation. Otherwise a truncated
  // scan can't prove uniqueness (1) or absence (0) → resolution_incomplete.
  if (matches.length >= 2) return { status: 'ambiguous', matches };
  if (truncated) return { status: 'resolution_incomplete' };
  if (matches.length === 1) return { status: 'corrected', path: matches[0], from: rel };
  return { status: 'not_found' };
}

/**
 * Iterative DFS over the vault, collecting vault-relative paths of files whose
 * basename === `basename`. Skips dot-dirs and node_modules; does not follow
 * symlinked directories (readdirSync withFileTypes reports symlinks as
 * symlinks, not directories, so they're never recursed into). Stops early once
 * a second match is found (ambiguity is decided) or MAX_SCAN is hit.
 *
 * @returns {{ matches: string[], truncated: boolean }} `truncated` is true when
 *   the MAX_SCAN budget was exhausted before the walk finished — the caller
 *   must then treat a <2-match result as `resolution_incomplete`, not proof.
 */
function findByBasename(root, lib, basename) {
  const out = [];
  const stack = ['']; // vault-relative directories to visit
  let scanned = 0;
  while (stack.length) {
    const relDir = stack.pop();
    const absDir = relDir ? toAbs(lib, root, relDir) : root;
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++scanned > MAX_SCAN) return { matches: out, truncated: true };
      const name = e.name;
      const relChild = relDir ? `${relDir}/${name}` : name;
      if (e.isDirectory()) {
        if (!name.startsWith('.') && !EXCLUDED_DIRS.has(name)) stack.push(relChild);
      } else if (name === basename) {
        out.push(relChild);
        if (out.length >= 2) return { matches: out, truncated: false }; // ambiguity settled
      }
    }
  }
  return { matches: out, truncated: false };
}

// ---------------------------------------------------------------------------
// The REST backend (v0.80.0)
// ---------------------------------------------------------------------------

/**
 * A walker shared by every path resolved in ONE operation.
 *
 * The basename fallback needs the vault's file list. Resolving a 200-path batch
 * where 3 paths miss must not walk the vault 3 times — and, worse, must not
 * straddle a vault edit so that two entries in one answer disagree about what
 * exists. Same lesson, same shape, as the port resolution in `click-to-open.mjs`:
 * ONE snapshot per operation, freshness between operations.
 *
 * Lazy on purpose: an operation whose paths all hit exactly never walks at all,
 * which is the overwhelmingly common case and the reason this stays cheap.
 *
 * @param {object} vault
 * @param {{listFilesIn: Function, collectMarkdown: Function}} deps
 * @returns {() => Promise<{paths: string[], truncated: boolean, listFailures: number}>}
 */
export function makeRestWalker(vault, deps) {
  let pending = null;
  return () => {
    if (!pending) pending = collectEveryPath(deps.listFilesIn, vault);
    return pending;
  };
}

/**
 * Enumerate EVERY file in the vault, not only the markdown.
 *
 * `collectMarkdown` (the walker `build_search_index` and the OKF projections
 * share) filters to `*.md`, which is right for them and wrong here: the disk
 * backend's `findByBasename` matches ANY file, so leaning on the markdown walker
 * made the two backends disagree. Measured before the push: a bare `image.png`
 * came back `corrected` on disk and `not_found` over REST — a FABRICATED verdict
 * for a file that exists, and one that makes single mode THROW. The right fix is
 * to walk like the disk does, not to narrow the claim.
 *
 * Bounds mirror the shared walker's so a pathological vault cannot hang a tool,
 * and `truncated` / `listFailures` are reported for the same reason they are
 * there: an incomplete enumeration proves neither uniqueness nor absence.
 */
async function collectEveryPath(listFilesIn, vault) {
  // DIRECTORIES ARE NOT COLLECTED, and that is parity, not an oversight. The
  // disk walk matches FILES only (`findByBasename` pushes a directory onto its
  // stack and never into `matches`), so a bare folder basename answers
  // `not_found` on BOTH backends. A review argued the disk said `corrected`
  // here; measured, it does not. The parity table pins the case.
  const MAX_FILES = 5000;
  const MAX_VISITS = 20000;
  const MAX_DEPTH = 12;
  const paths = [];
  let truncated = false;
  let listFailures = 0;
  // The FIRST reason a listing failed, kept so the caller can say WHY instead
  // of reporting a bare count. A walk that failed with `unauthorized` and one
  // that hit its budget are different facts (review, 2026-08-31).
  let failureReason = null;
  let listingsRead = 0;
  let visited = 0;
  const stack = [{ dir: '', depth: 0 }];
  while (stack.length > 0) {
    if (paths.length >= MAX_FILES || visited >= MAX_VISITS) { truncated = true; break; }
    const { dir, depth } = stack.pop();
    if (depth > MAX_DEPTH) { truncated = true; continue; }
    let listing;
    try {
      listing = await listFilesIn(vault, dir);
    } catch (err) {
      // A 404 on a SUBDIRECTORY is normal: we only queued it because a parent
      // listing named it, so a 404 means it vanished between the two calls —
      // nothing to enumerate, nothing to report.
      //
      // A 404 ON THE ROOT IS NOT THE SAME THING, and treating it as one let this
      // walker prove an empty vault from a route that simply did not answer:
      // a wrong endpoint, a proxy, an API version without `/vault/`. The
      // resulting `not_found` was decisive and unearned. (Found in review,
      // 2026-08-31 — and it corrects a conclusion I had drawn from measuring
      // that the DISK backend agrees here: agreement between two backends is
      // not proof, it is agreement. On disk a missing root really is an absent
      // vault; over REST it is only an unanswered request.)
      if (dir === '') {
        listFailures += 1;
        failureReason ??= err?.kind === 'not_found' ? 'root-listing-not-found' : (err?.kind || 'list-failed');
        continue;
      }
      if (err?.kind !== 'not_found') {
        listFailures += 1;
        failureReason ??= err?.kind || 'list-failed';
      }
      continue;
    }
    // A 200 WITH THE WRONG SHAPE IS NOT AN EMPTY DIRECTORY — the same rule the
    // exact-path branch applies. Coercing it to `[]` here would have let the
    // fallback fabricate `not_found` from an unreadable response: the very
    // defect that rule exists to close, moved one function down (review,
    // 2026-08-31).
    if (!Array.isArray(listing?.files)) {
      listFailures += 1;
      failureReason ??= 'malformed-listing';
      continue;
    }
    listingsRead += 1;
    const files = listing.files;
    // AN UNREADABLE ENTRY IS UNREADABLE DATA, not a missing file. Checking only
    // that `files` is an ARRAY left `{files: [null, {path: 'x'}]}` to be skipped
    // member by member, yielding an empty enumeration and, from it, a decisive
    // `not_found`. Same defect class as the non-array case, one level finer
    // (review, 2026-08-31). Valid members are still used — dropping them would
    // discard real data — but the listing is marked failed, so the verdict
    // degrades to `resolution_incomplete`, or to `unverifiable` if nothing else
    // was readable.
    if (files.some((e) => typeof e !== 'string' || !e)) {
      listFailures += 1;
      failureReason ??= 'malformed-listing';
    }
    for (const entry of files) {
      if (typeof entry !== 'string' || !entry) continue;
      if (paths.length >= MAX_FILES || visited >= MAX_VISITS) { truncated = true; break; }
      visited += 1;
      const name = entry.replace(/\/+$/, '');
      const full = dir ? `${dir}/${name}` : name;
      // Dot-directories are skipped, exactly as the disk walk skips them: the
      // REST API does not serve them anyway, and a basename match inside
      // `.obsidian` is never what the caller meant.
      if (entry.endsWith('/')) {
        if (!name.startsWith('.')) stack.push({ dir: full, depth: depth + 1 });
      } else {
        paths.push(full);
      }
    }
  }
  return { paths, truncated, listFailures, failureReason, listingsRead };
}

/** Vault-relative parent directory of a posix path ('' at the root). */
function parentOf(rel) {
  const i = rel.lastIndexOf('/');
  return i === -1 ? '' : rel.slice(0, i);
}

/** Basename of a posix vault path. */
function basenameOf(rel) {
  const i = rel.lastIndexOf('/');
  return i === -1 ? rel : rel.slice(i + 1);
}

/**
 * The same five verdicts as `resolveVaultPathOnDisk`, answered over REST.
 *
 * @param {object} vault - registry vault descriptor (any type; needs no `path`).
 * @param {string} relPath - vault-relative path (slashes `/` or `\`).
 * @param {object} deps - `{ listFilesIn, collectMarkdown, walk? }`. Pass `walk`
 *   (from `makeRestWalker`) to share one enumeration across a batch.
 * @returns {Promise<{status:string, path?:string, from?:string, matches?:string[]}>}
 */
export async function resolveVaultPathViaRest(vault, relPath, deps = {}) {
  if (!vault || !relPath || typeof relPath !== 'string') return { status: 'unverifiable' };
  // `listFilesIn` is always required. A shared `walk` makes `collectMarkdown`
  // unnecessary — demanding both made the injection point unusable on its own
  // (found while probing this resolver before the push).
  if (typeof deps.listFilesIn !== 'function') return { status: 'unverifiable' };
  const rel = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel) return { status: 'unverifiable' };

  // 1. THE EXACT PATH — one listing of its parent directory. This is the whole
  //    cost in the common case. `listFilesIn` reports folders with a trailing
  //    slash, so a folder target is matched too (folders are openable).
  //
  //    TRAILING SLASHES ARE STRIPPED FOR THE LOOKUP, not from the answer. A
  //    caller asking for `wiki/deep/` means the folder; leaving the slash on
  //    made `basenameOf` return '' and the whole call `unverifiable`, where the
  //    disk backend answers `ok` (measured before the push).
  const lookup = rel.replace(/\/+$/, '');
  if (!lookup) return { status: 'unverifiable' };
  const base = basenameOf(lookup);
  if (!base) return { status: 'unverifiable' };
  try {
    const listing = await deps.listFilesIn(vault, parentOf(lookup));
    // A 200 WITH THE WRONG SHAPE IS NOT AN EMPTY DIRECTORY. Coercing
    // `{files: null}` to `[]` turned a schema violation into proof of absence,
    // and `not_found` would then be fabricated from a response nobody could
    // read (review, 2026-08-31). An unreadable answer is not an answer.
    if (!Array.isArray(listing?.files)) {
      return { status: 'unverifiable', reason: 'malformed-listing' };
    }
    if (listing.files.includes(base) || listing.files.includes(`${base}/`)) {
      return { status: 'ok', path: rel };
    }
  } catch (err) {
    // A 404 means the parent directory is simply absent — a normal miss, and the
    // basename fallback below is exactly what it is for.
    //
    // ANYTHING ELSE gives `unverifiable`, NOT `resolution_incomplete`. The
    // distinction decides what the caller does:
    //   - `resolution_incomplete` — the vault ANSWERED and was scanned, but not
    //     exhaustively. Actionable (pass the exact full path), so single mode
    //     throws rather than hand back a guess.
    //   - `unverifiable` — we could not check. Nothing the caller can rephrase,
    //     so throwing would withdraw a usable link for a reason they cannot act
    //     on. That is precisely what `pathVerified: false` exists to carry.
    //
    // BUT "COULD NOT CHECK" IS NOT ONE THING, and an earlier draft called every
    // one of them "the vault did not answer" (review, 2026-08-31). A 401 IS an
    // answer — a decisive one. The verdict stays the same because the caller's
    // options are the same, but the REASON travels so the message can stop
    // guessing: `rest-client.mjs` already classifies these
    // (`unreachable`, `timeout`, `unauthorized`, `forbidden`, `cf_access`,
    // `server_error`, `conflict`, `unknown`).
    if (err?.kind !== 'not_found') {
      return { status: 'unverifiable', reason: err?.kind || 'error' };
    }
  }

  // 2. THE BASENAME FALLBACK, for ANY extension — the disk backend matches any
  //    file, and a backend that quietly narrowed itself to markdown would answer
  //    `not_found` for a `.png` that exists. It did, and the divergence was
  //    caught by comparing the two backends case by case rather than by reading
  //    either of them.
  const walk = typeof deps.walk === 'function' ? deps.walk : makeRestWalker(vault, deps);
  let enumerated;
  try {
    enumerated = await walk();
  } catch (err) {
    // The enumeration could not run at all — same reading as above: nothing is
    // provable and nothing is actionable, and the reason travels.
    return { status: 'unverifiable', reason: err?.kind || 'walk-failed' };
  }
  // Same rule as the parent listing: a walk that did not produce an array of
  // paths has not proven an empty vault.
  if (!Array.isArray(enumerated?.paths)) {
    return { status: 'unverifiable', reason: 'malformed-walk' };
  }
  const paths = enumerated.paths;
  // NOT capped at 2. The disk walk stops early once ambiguity is settled, so it
  // reports two candidates; this one has the whole list and naming every
  // candidate is more useful to the caller who must now disambiguate. The
  // VERDICT is what has to match between backends, not the length of a
  // diagnostic array.
  const matches = paths.filter((p) => basenameOf(p) === base);

  // Same three-way reading as the disk walk. ≥2 settles ambiguity whatever the
  // budget did. Below that, an incomplete enumeration proves NEITHER uniqueness
  // NOR absence — and `listFailures` is part of "incomplete": a directory that
  // failed to answer is not a directory known to be empty.
  if (matches.length >= 2) return { status: 'ambiguous', matches };

  // A WALK THAT NEVER GOT OFF THE GROUND is not a partial scan. If not one
  // listing was read, there is no enumeration to be incomplete — that is
  // `unverifiable`, and the reason the walker captured says which failure it
  // was (`unauthorized` reads very differently from "the vault is huge").
  // Reporting both as `resolution_incomplete` told the caller to pass an exact
  // path, which fixes nothing when the answer was 401 (review, 2026-08-31).
  if ((enumerated?.listingsRead ?? 0) === 0 && (enumerated?.listFailures ?? 0) > 0) {
    return { status: 'unverifiable', reason: enumerated.failureReason || 'walk-failed' };
  }
  if (enumerated?.truncated || (enumerated?.listFailures ?? 0) > 0) {
    return { status: 'resolution_incomplete' };
  }
  if (matches.length === 1) return { status: 'corrected', path: matches[0], from: rel };
  return { status: 'not_found' };
}
