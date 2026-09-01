/**
 * search-exclusions — C4 of [[claude-code-large-codebases-roadmap]]: a DEFAULT
 * set of folders the semantic search leaves out, so the caller does not have to
 * remember the same exclusion on every call.
 *
 * ---------------------------------------------------------------------------
 * THE DEFAULT WAS MEASURED, NOT GUESSED — AND THE GUESS WAS WRONG
 * ---------------------------------------------------------------------------
 * The roadmap suggested `.trash` and `Templates`. Neither exists on this fleet:
 * a sweep of all 23 configured vaults (two levels deep) found no `Templates`
 * directory and no `.trash` anywhere, so both would have shipped as decoration.
 * Two other candidates that *sounded* right — `wiki-meta/graph`,
 * `wiki-meta/digests`, `wiki-meta/presence` — turned out to hold nothing the
 * index carries (JSON and machine state, not markdown): measured contribution,
 * zero pages on zero vaults. They are not shipped either. A default that
 * excludes nothing is worse than no default: it reads as protection.
 *
 * What the measurement DID find is one folder, and it is large.
 * `wiki-meta/Sessions/` — the chronological session journals the
 * `log-discipline` convention parks there — accounts for **1212 of the 2915
 * indexed pages across the fleet (41.6 %)**, and 498 of 803 on the router's own
 * vault. They are raw logs by construction: the durable knowledge is supposed to
 * be promoted into `wiki/`, and every navigational path (hot → catalog → page)
 * ignores them. Left in, they are the single biggest source of chronological
 * noise in a conceptual search.
 *
 * ---------------------------------------------------------------------------
 * BECAUSE IT IS 41.6 %, IT IS NEVER SILENT
 * ---------------------------------------------------------------------------
 * A cut that big applied invisibly would be exactly the "quietly narrowed
 * corpus" this codebase keeps refusing. So the response says which folders were
 * excluded, WHO chose them (`caller` or `default`), and how many hits it cost.
 * Opting out is one argument: pass `excludeFolders` explicitly — including `[]`,
 * which means "exclude nothing" and is deliberately distinct from omitting it.
 *
 * ---------------------------------------------------------------------------
 * FILTERED ROUTER-SIDE, ON PURPOSE
 * ---------------------------------------------------------------------------
 * `excludeFolders` is also forwarded to the bridge, but the guarantee does not
 * rest on it: whether Smart Connections honours the filter could not be verified
 * here (the plugin was offline during this work), and a default whose effect
 * depends on an unverified remote behaviour is not a default, it is a hope. The
 * cut is therefore applied to the results the router holds — the same shape
 * `filterArchiveResults` has used for archived deliberation since v0.54.0,
 * overfetch included.
 */

/**
 * The shipped default. ONE entry, because one is what measured non-zero.
 * @see the header for the fleet numbers behind it.
 */
export const DEFAULT_EXCLUDE_FOLDERS = Object.freeze(['wiki-meta/Sessions']);

/** Environment override — comma-separated; empty string disables the default. */
export const EXCLUDE_ENV = 'OBSIDIAN_ROUTER_DEFAULT_EXCLUDE_FOLDERS';

/**
 * Normalise a folder prefix: trimmed, forward slashes, no leading or trailing
 * slash. Trimming matters most for the comma-separated env form (`a, b`), and
 * is applied to the argument form too — a caller writing `' Drafts '` means
 * `Drafts`, and a folder whose name really begins or ends with a space is not a
 * shape Obsidian produces.
 */
function normaliseFolder(f) {
  return String(f ?? '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

/** Is `path` inside one of these folder prefixes? */
export function underAnyFolder(path, folders) {
  const p = String(path ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  return folders.some((f) => f && (p === f || p.startsWith(`${f}/`)));
}

/**
 * Decide which folders this call excludes, and record WHO decided.
 *
 * The three cases are genuinely different and are kept apart:
 *   - `caller`  — an explicit array was passed. It wins entirely, and an EMPTY
 *                 array is a legitimate explicit answer meaning "nothing".
 *                 Treating `[]` as "unset" would make opting out impossible.
 *   - `default` — nothing was passed; the measured default applies.
 *   - `none`    — nothing was passed and the default is disabled (env set to an
 *                 empty value), or the caller passed `[]`.
 *
 * @param {*} requested the caller's `excludeFolders` argument, as received
 * @param {object} [env] process env (injectable for tests)
 * @returns {{folders: string[], source: 'caller'|'default'|'none'}}
 */
export function resolveExcludeFolders(requested, env = process.env) {
  if (Array.isArray(requested)) {
    const folders = requested.map(normaliseFolder).filter(Boolean);
    return { folders, source: folders.length ? 'caller' : 'none' };
  }
  const raw = env?.[EXCLUDE_ENV];
  if (typeof raw === 'string') {
    // A SET-BUT-EMPTY VALUE IS AN ANSWER, not an absent one: it is how a vault
    // whose conventions differ from this fleet's turns the default off without
    // having to pass an argument on every call.
    const folders = raw.split(',').map(normaliseFolder).filter(Boolean);
    return { folders, source: folders.length ? 'default' : 'none' };
  }
  return { folders: [...DEFAULT_EXCLUDE_FOLDERS], source: 'default' };
}

/**
 * The path of a search hit, in EVERY shape the payloads use.
 *
 * `path` is the bridge's usual key, but `filename` is the Local REST API's, and
 * both are already recognised by `click-to-open-walker` and by the context
 * pack's own chunk mapper. Reading only `path` here meant a hit shaped
 * `{filename: 'wiki-meta/Sessions/a.md'}` sailed through the exclusion while the
 * BM25 tier and the context pack removed its equivalent — a bridge that ignores
 * the forwarded hint could therefore defeat the router-side guarantee, which is
 * exactly what enforcing it here is for. (Found in review.)
 */
export function hitPath(r) {
  const p = r?.path ?? r?.filename ?? r?.file;
  return typeof p === 'string' ? p : '';
}

/**
 * Split `results` into what survives the exclusion and what it cost.
 *
 * A result carrying NO usable path is kept: it cannot be shown to be inside an
 * excluded folder, and dropping it would turn "I cannot tell" into "it is
 * excluded" — the inversion this codebase keeps having to undo. A path that is
 * only whitespace counts as none.
 *
 * @param {Array} results
 * @param {string[]} folders
 * @param {(r:any)=>string} [pathOf]
 * @returns {{kept: Array, excluded: number}}
 */
export function partitionByFolders(results, folders, pathOf = hitPath) {
  if (!Array.isArray(results) || !folders.length) {
    return { kept: Array.isArray(results) ? results : [], excluded: 0 };
  }
  const kept = results.filter((r) => {
    const p = pathOf(r);
    if (typeof p !== 'string' || !p.trim()) return true;
    return !underAnyFolder(p, folders);
  });
  return { kept, excluded: results.length - kept.length };
}

/**
 * How many hits to ask the backend for so a router-side cut still fills the page.
 *
 * A CONSTANT MARGIN IS NOT ENOUGH AND THE MEASUREMENT SAYS SO. The default
 * exclusion removes 41.6% of the indexed corpus; the old flat +10 was sized for
 * the archive filter, which removes a handful of pages. With a `limit` of 5 and
 * the first eleven hits under the excluded folder, a +10 margin returns four
 * results while eligible matches sit just past the window. Scaling with the
 * limit makes the common case whole.
 *
 * IT IS STILL NOT A GUARANTEE, and the caller is told so rather than left to
 * assume: no backend here takes an offset, so a page cannot be refilled by
 * paging. When the result is short AND something was cut, the response says the
 * page is short and why — a short page that admits it beats a full-looking one.
 */
export function overfetchLimit(limit, { excluding = false, archives = false } = {}) {
  const base = Number.isFinite(limit) && limit > 0 ? limit : 10;
  if (!excluding && !archives) return base;
  if (!excluding) return base + ARCHIVE_MARGIN;
  // 2× covers a corpus where up to half of what comes back is excluded — the
  // fleet's measured worst case is 62% on one vault, hence the flat margin on
  // top rather than a bare multiple.
  return Math.min(base * 2 + ARCHIVE_MARGIN, MAX_OVERFETCH);
}

/** The margin the archive filter has used since v0.54.0. */
export const ARCHIVE_MARGIN = 10;
/** Never ask a backend for an unbounded page just to survive a filter. */
export const MAX_OVERFETCH = 120;

/**
 * The block a response carries so the cut is legible: what was excluded, who
 * chose it, what it cost, and how to turn it off. Returns `null` when nothing
 * was excluded AND no default was in force — there is then nothing to say.
 */
export function exclusionReport({ folders, source, excluded, shortPage = false }) {
  if (!folders.length) return null;
  return {
    folders: [...folders],
    chosenBy: source,
    // NAMED FOR WHAT IT COUNTS, because it is easy to read as more. It is the
    // number of hits THIS filter removed from what the backend handed back —
    // not the cost of the exclusion overall. A backend that honoured the
    // forwarded hint and dropped them itself leaves this at 0, and a hit that
    // the archive filter would have removed anyway is still counted here.
    excludedHits: excluded,
    ...(shortPage
      ? {
        shortPage: true,
        shortPageNote:
            'Fewer results are returned than `limit` asked for, and this filter removed some: the '
            + 'backend was over-fetched but no backend here takes an offset, so a page cannot be '
            + 'refilled. Raise `limit`, or pass `excludeFolders: []` to see what was cut.',
      }
      : {}),
    note: source === 'default'
      ? 'Applied by DEFAULT because the call passed no `excludeFolders`. These folders hold '
        + 'chronological session logs, not durable notes — measured at 41.6% of the indexed pages '
        + 'across this fleet. Pass `excludeFolders` explicitly to change it, or `excludeFolders: []` '
        + 'to exclude nothing.'
      : 'Chosen by the caller via `excludeFolders`.',
  };
}
