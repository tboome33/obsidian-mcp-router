/**
 * smart-env-embeddings — read the per-page vectors Smart Connections keeps on
 * disk, so C11 (`find_twin_pages`) can compare pages by cosine.
 *
 * ---------------------------------------------------------------------------
 * WHY DISK AND NOT `search_smart`
 * ---------------------------------------------------------------------------
 * `search_smart` is a QUERY interface: you hand it a string, it hands back a
 * ranking. C11 needs the vectors themselves — every page against every other —
 * and no query can produce that. Smart Connections stores them under
 * `<vault>/.smart-env/multi/`, a DOT-directory Obsidian's Local REST API does
 * not serve, so the only way in is the local filesystem. Same precedent as
 * `click-to-open.mjs` (reads the plugin's `data.json` off disk) and
 * `resolve-vault-path.mjs` (stats the vault directly): filesystem-only, works
 * offline, adds no network dependency — and REMOTE VAULTS ARE OUT OF REACH,
 * which the caller must report rather than paper over.
 *
 * ---------------------------------------------------------------------------
 * THE FILE FORMAT, AND THE THREE THINGS ABOUT IT THAT BITE
 * ---------------------------------------------------------------------------
 * `multi/<flattened_path>.ajson` is NOT valid JSON. It is an APPEND LOG of
 * fragments, one per line, each shaped `"<key>": {…},` — a bare object body
 * with a trailing comma and no enclosing braces. Parsing one line means
 * wrapping it: `JSON.parse('{' + line-without-trailing-comma + '}')`.
 *
 *   1. KEYS REPEAT, AND LAST WINS. Measured on the router's own vault: 803
 *      files, 64 395 lines, 1 310 of them `smart_sources:` records for 805
 *      distinct paths — so a path is rewritten every time the note changes.
 *      Reading first-wins would return embeddings of superseded page versions.
 *   2. `null` IS A TOMBSTONE. A record whose value is `null` retracts the key.
 *      Treating it as "no embeddings, skip" would leave the DELETED page's last
 *      vector standing.
 *   3. TWO COLLECTIONS SHARE THE FILE. `smart_sources:<path>` (whole note) and
 *      `smart_blocks:<path>#<heading>` (one chunk, and it carries the chunk's
 *      raw `text`). Blocks are ~96% of the lines and all of the bulk; skipping
 *      them by line PREFIX before `JSON.parse` — not after — took the router
 *      vault's 165 MB from 1091 ms to 505 ms (measured, 54%).
 *
 * Vectors live at `.embeddings[<modelKey>].vec` — plain float arrays, already
 * unit-length in practice (measured |v| = 1.000000) but NOT assumed to be here.
 *
 * ---------------------------------------------------------------------------
 * ONE MODEL, OR NO ANSWER
 * ---------------------------------------------------------------------------
 * Cosine between vectors from two different embedding models is a number
 * without a meaning. When a store carries more than one model, the reader picks
 * the one covering the most pages and REPORTS the others rather than silently
 * mixing them — the same "never blend two score scales" rule `search_smart`
 * applies to its semantic and BM25 tiers.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Smart Connections' on-disk root inside a vault. */
export const SMART_ENV_DIR = '.smart-env';
/** Where the per-note append logs live under it. */
export const SMART_ENV_MULTI = 'multi';
/** The collection prefix of a whole-note record. */
export const SOURCE_KEY_PREFIX = 'smart_sources:';

/**
 * WHAT A VECTOR FROM THIS STORE IS, TEMPORALLY — carried into every answer that
 * uses one, because the answer otherwise reads as a statement about the pages as
 * they are NOW, and it is not.
 *
 * The store is written by Smart Connections on its own schedule. A page edited
 * since the last indexing pass still carries its OLD vector, and there is no way
 * from here to tell which pages those are: the records hold a `last_embed.hash`,
 * but it is the plugin's own content hash over its own extraction, not something
 * this router can recompute from the page to compare. So per-page staleness is
 * genuinely UNKNOWN, not merely unmeasured — and saying so is the only honest
 * option. (Wholesale drift IS observable and is reported separately: an indexed
 * path with no page on disk shows up in `excluded.notOnDisk`.)
 */
export const INDEX_SNAPSHOT_CAVEAT =
  'These similarities come from a Smart Connections index SNAPSHOT, not from the pages as they are '
  + 'right now: a page edited since the last indexing pass still carries its previous vector, and '
  + 'per-page staleness cannot be determined from here (the store keeps no hash this router can '
  + 'recompute). Re-index the vault in Obsidian for an up-to-date answer.';

/** The freshness descriptor every answer built on this store must carry. */
export const INDEX_SNAPSHOT_FRESHNESS = Object.freeze({
  basis: 'index-snapshot',
  perPageStaleness: 'unknown',
  caveat: INDEX_SNAPSHOT_CAVEAT,
});

/**
 * Pick the path library matching the STYLE of the stored vault path rather
 * than the runtime's — the registry keeps Windows paths verbatim even on a
 * POSIX runtime (CI matrix). Same detection as `resolve-vault-path.mjs`.
 */
function libFor(vaultPath) {
  return /^[A-Za-z]:[\\/]/.test(vaultPath) || /^\\\\/.test(vaultPath) ? path.win32 : path.posix;
}

/**
 * Parse ONE `.ajson` append log into whole-note records.
 *
 * Pure and total: a malformed line is counted and skipped, never thrown on.
 * These files are written by a third-party plugin and truncated writes happen;
 * one bad line must not cost the other 63 000.
 *
 * @param {string} text Raw file content.
 * @returns {{ records: Map<string, {vec: number[], model: string}|null>, lines: number, malformed: number }}
 *   `null` values are TOMBSTONES and must be honoured by the caller — they are
 *   kept in the map (rather than deleted) so that merging several files keeps
 *   the retraction visible regardless of file order.
 */
export function parseAjsonSources(text) {
  const records = new Map();
  let lines = 0;
  let malformed = 0;
  // EVERY REJECTED RECORD IS COUNTED, not only the unparseable ones. Before
  // this, seven deliberately faulty lines were reported as ONE: a value that is
  // an array, a value that is a string, an empty page path, `vec: "notanarray"`
  // and friends are all VALID JSON, so they sailed past `malformed` and left
  // through an uncounted `continue`. The per-page arithmetic stayed right — the
  // pages simply had no vector — but the STORE DIAGNOSTIC lied about how much
  // of the store it had failed to read.
  let unusable = 0;
  if (typeof text !== 'string' || !text) return { records, lines, malformed, unusable };

  for (const rawLine of text.split('\n')) {
    // PREFIX FILTER BEFORE PARSE — this is the 54% (see header). A leading
    // quote is part of the test: `smart_blocks:` records also contain the
    // substring `smart_sources:` inside their `key` field, so a bare
    // `includes()` would re-admit every block line.
    if (!rawLine.startsWith(`"${SOURCE_KEY_PREFIX}`)) continue;
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    lines += 1;
    const body = trimmed.endsWith(',') ? trimmed.slice(0, -1) : trimmed;
    let parsed;
    try {
      parsed = JSON.parse(`{${body}}`);
    } catch {
      malformed += 1;
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      malformed += 1;
      continue;
    }
    // `Object.entries` on a parsed object is safe (JSON.parse never sets a real
    // prototype), but a key literally named `__proto__` would still be an
    // ordinary own property here and lands in a Map — never an object — below.
    for (const [key, value] of Object.entries(parsed)) {
      if (!key.startsWith(SOURCE_KEY_PREFIX)) continue;
      const pagePath = key.slice(SOURCE_KEY_PREFIX.length);
      if (!pagePath) { unusable += 1; continue; }
      // TOMBSTONE. Recorded, not skipped — see the return contract.
      if (value === null) {
        records.set(pagePath, null);
        continue;
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) { unusable += 1; continue; }
      const embeddings = value.embeddings;
      if (!embeddings || typeof embeddings !== 'object' || Array.isArray(embeddings)) {
        unusable += 1;
        continue;
      }
      let took = 0;
      for (const [model, slot] of Object.entries(embeddings)) {
        if (!slot || typeof slot !== 'object') continue;
        const vec = slot.vec;
        if (!Array.isArray(vec) || vec.length === 0) continue;
        // A vector with a non-finite component cannot take part in a cosine —
        // one NaN turns every similarity involving this page into NaN, and NaN
        // compares false against every threshold, so the page would vanish from
        // the ranking WITHOUT being counted anywhere. Refuse it here so it is
        // counted as "no usable vector" instead.
        if (!vec.every((x) => typeof x === 'number' && Number.isFinite(x))) continue;
        // LAST WINS — later lines overwrite earlier ones, which is exactly the
        // append log's update semantics.
        records.set(pagePath, { vec, model: String(model) });
        took += 1;
      }
      // An `embeddings` object that yielded nothing usable is a rejected record
      // too — the commonest real shape of it being `vec` present but not an array.
      if (took === 0) unusable += 1;
    }
  }
  return { records, lines, malformed, unusable };
}

/**
 * Read every whole-note vector a vault's Smart Connections store holds.
 *
 * @param {string} vaultPath Absolute path of the local vault root.
 * @param {object} [deps] Injectable `fs` (readdirSync/readFileSync) for tests.
 * @returns {{
 *   ok: boolean,
 *   reason?: string,
 *   storePath: string,
 *   vectors?: Map<string, number[]>,
 *   model?: string,
 *   dimensions?: number,
 *   files?: number,
 *   records?: number,
 *   malformed?: number,
 *   tombstones?: number,
 *   otherModels?: Array<{ model: string, pages: number }>,
 *   mixedDimensions?: number,
 * }}
 */
export function readSmartEnvEmbeddings(vaultPath, deps = {}) {
  const io = deps.fs || fs;
  const lib = libFor(String(vaultPath || ''));
  const storePath = `${SMART_ENV_DIR}/${SMART_ENV_MULTI}`;
  if (!vaultPath || typeof vaultPath !== 'string') {
    return { ok: false, reason: 'no-vault-path', storePath };
  }
  const dir = lib.join(vaultPath, SMART_ENV_DIR, SMART_ENV_MULTI);

  let entries;
  try {
    entries = io.readdirSync(dir);
  } catch {
    // Absent OR unreadable. Both mean the same thing to the caller — there are
    // no embeddings to be had here — and neither is an error worth throwing:
    // most of the fleet simply has no Smart Connections.
    return { ok: false, reason: 'store-missing', storePath };
  }
  const files = entries.filter((f) => typeof f === 'string' && f.endsWith('.ajson'));
  if (files.length === 0) return { ok: false, reason: 'store-empty', storePath };

  // model → path → vec. Kept per-model so the winner is chosen on coverage
  // rather than on which file happened to be read first.
  const byModel = new Map();
  let malformed = 0;
  let unusable = 0;
  let tombstones = 0;
  let records = 0;
  // A FILE WE COULD NOT OPEN IS NOT A FILE WITH NOTHING IN IT. This is reachable
  // without anything being broken — `ERR_STRING_TOO_LONG` on a store larger than
  // V8's string cap, or Obsidian holding the file while it writes — and an
  // uncounted `continue` reported `files: 2, vectors: 1, malformed: 0` for a run
  // that had opened exactly one of them.
  let unreadableFiles = 0;
  // Sorted so the read order — and therefore any last-wins tie between two
  // FILES claiming the same page — is the same on every machine. (Within one
  // file, order is the file's own and is the update history.)
  for (const file of [...files].sort()) {
    let text;
    try {
      text = io.readFileSync(lib.join(dir, file), 'utf8');
    } catch {
      unreadableFiles += 1;
      continue;
    }
    const parsed = parseAjsonSources(text);
    malformed += parsed.malformed;
    unusable += parsed.unusable;
    for (const [pagePath, rec] of parsed.records) {
      records += 1;
      if (rec === null) {
        tombstones += 1;
        for (const m of byModel.values()) m.delete(pagePath);
        continue;
      }
      if (!byModel.has(rec.model)) byModel.set(rec.model, new Map());
      byModel.get(rec.model).set(pagePath, rec.vec);
    }
  }

  if (byModel.size === 0) {
    return { ok: false, reason: 'no-vectors', storePath, files: files.length, malformed, unusable, unreadableFiles };
  }

  // ONE MODEL WINS — most pages covered; ties broken by model name so the
  // choice is a function of the data, not of enumeration order.
  const ranked = [...byModel.entries()]
    .map(([model, m]) => ({ model, pages: m.size }))
    .sort((a, b) => b.pages - a.pages || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
  const winner = ranked[0];
  const vectorsRaw = byModel.get(winner.model);

  // ---- the cohort that cannot be compared, PAGE BY PAGE --------------------
  // Every page dropped for a reason of its own is recorded here with that
  // reason, because the caller has to be able to tell "this page had NO vector"
  // from "this page had a vector we could not use". Reporting only aggregate
  // counts was the hole: a page dropped for a minority dimension landed in the
  // caller's `withoutVector` bucket, whose sentence then told the reader it
  // "carried none" — false, and contradicted by the store two fields away.
  const incompatible = new Map();
  for (const [model, m] of byModel) {
    if (model === winner.model) continue;
    for (const p of m.keys()) if (!vectorsRaw.has(p)) incompatible.set(p, 'minority-model');
  }

  // One model can still yield two dimensionalities if the model was re-indexed
  // with different settings mid-history. A dot product over mismatched lengths
  // is silently truncated garbage, so the minority is DROPPED and counted.
  const dimTally = new Map();
  for (const vec of vectorsRaw.values()) dimTally.set(vec.length, (dimTally.get(vec.length) || 0) + 1);
  const dimensions = [...dimTally.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  const vectors = new Map();
  let mixedDimensions = 0;
  let zeroNorm = 0;
  for (const [p, vec] of vectorsRaw) {
    if (vec.length !== dimensions) {
      mixedDimensions += 1;
      incompatible.set(p, 'minority-dimension');
      continue;
    }
    // A ZERO VECTOR IS NOT A POSITION. `normalise` cannot scale it, so it stays
    // zero and its cosine with EVERY page — including a byte-identical twin — is
    // 0. Left in, such a page is counted as "compared" while being structurally
    // incapable of ever matching: coverage said 14 of 14 for a corpus where two
    // of them could not participate. It is a page WITH a vector, so it does not
    // belong in "carried none" either.
    let sq = 0;
    for (const x of vec) sq += x * x;
    if (!(Math.sqrt(sq) > 0)) {
      zeroNorm += 1;
      incompatible.set(p, 'zero-norm');
      continue;
    }
    vectors.set(p, vec);
  }

  return {
    ok: true,
    storePath,
    vectors,
    // Path → why it could not join the comparison. The caller needs the REASON
    // per page, not just a total, to classify its own exclusions honestly.
    incompatible,
    model: winner.model,
    dimensions,
    files: files.length,
    unreadableFiles,
    records,
    malformed,
    unusable,
    tombstones,
    otherModels: ranked.slice(1),
    mixedDimensions,
    zeroNorm,
  };
}

export const _internals = { libFor };
