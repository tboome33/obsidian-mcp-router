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
 * not serve — measured, Obsidian's own file index does not carry it either, so
 * that refusal is structural rather than a setting. On the machine that has the
 * vault, the way in is therefore the filesystem, same precedent as
 * `click-to-open.mjs` (reads the plugin's `data.json` off disk) and
 * `resolve-vault-path.mjs` (stats the vault directly).
 *
 * A VAULT ON ANOTHER MACHINE used to be out of reach for exactly that reason.
 * Since v0.82.0 the bridge — an Obsidian plugin, so it has `vault.adapter` and
 * can read what the REST API will not — serves those records at
 * `GET /smart-env/sources`, and {@link readSmartEnvEmbeddingsViaRest} reads them.
 * Both backends converge on {@link reconcileSmartEnvStore}: the transport
 * changes, the meaning of the bytes does not.
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
 * Parse ONE `.ajson` append log into an ORDERED LIST of record events.
 *
 * ---------------------------------------------------------------------------
 * WHY EVENTS AND NOT A MAP — AND IT IS NOT A STYLE PREFERENCE
 * ---------------------------------------------------------------------------
 * A Map collapses repeats inside whatever text it was handed, which makes the
 * result depend on WHERE THE TEXT WAS CUT. That was invisible while the only
 * caller read one file at a time; it stopped being invisible when a second
 * backend arrived that receives the whole store as ONE blob.
 *
 * Concretely (found in adversarial review, 2026-08-31): file A holds a record
 * for page `p` under model X and file B holds one for `p` under model Y. Read as
 * two chunks, both survive — one per model — and the model tallies see `p`
 * twice. Read as one chunk, only Y survives. The winning model could differ
 * between the two backends for the same store, which is exactly the divergence
 * "parity by construction" was supposed to make impossible. The claim was
 * false, and no measurement here would have caught it: this fleet's vaults all
 * carry a single model.
 *
 * Emitting events in file order and letting the RECONCILER apply them makes the
 * cut irrelevant: the same sequence of events arrives whether it came as one
 * blob or eight hundred. `records`, `tombstones` and the model tallies then all
 * count the same things on both paths.
 *
 * Pure and total: a malformed line is counted and skipped, never thrown on.
 * These files are written by a third-party plugin and truncated writes happen;
 * one bad line must not cost the other 63 000.
 *
 * @param {string} text Raw file content.
 * @returns {{ events: Array<{path: string, models: Map<string, number[]>|null}>,
 *             lines: number, malformed: number, unusable: number }}
 *   ONE event per source record. `models` is every usable model→vector the
 *   record declares, together, because a record is one statement about the page.
 *   `models: null` is a TOMBSTONE and retracts the path.
 */
export function parseAjsonRecordEvents(text) {
  const events = [];
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
  if (typeof text !== 'string' || !text) return { events, lines, malformed, unusable };

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
      // ONE SPELLING PER PAGE. The store is written by a plugin running on
      // Windows, and it does key records `wiki\Ident\x.md` — measured on this
      // vault. Left as-is, `wiki\p.md` and `wiki/p.md` are two different pages
      // to every Map here: the tombstone for one does not retract the other, and
      // the backslash record's vector can never be looked up (every consumer
      // asks in forward-slash form). Folded once, at the boundary, so nothing
      // downstream has to remember (review round 3, 2026-08-31).
      //
      // THE TRADE-OFF IS KNOWN AND TAKEN. On a POSIX filesystem a backslash is a
      // legal character in a filename, so a page genuinely named `a\b.md` folds
      // onto `a/b.md` (review round 4). It is taken because these keys are
      // OBSIDIAN VAULT-RELATIVE PATHS, and Obsidian normalises those to forward
      // slashes everywhere it exposes them: a literal backslash is not a shape
      // Obsidian produces, whereas the OS-style keys this recovers were measured
      // on a real vault. Folding restores the intended key far more often than
      // it could merge two real ones.
      const pagePath = key.slice(SOURCE_KEY_PREFIX.length).replace(/\\/g, '/');
      if (!pagePath) { unusable += 1; continue; }
      // TOMBSTONE. Emitted, not skipped — see the return contract.
      if (value === null) {
        events.push({ path: pagePath, models: null });
        continue;
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) { unusable += 1; continue; }
      const embeddings = value.embeddings;
      if (!embeddings || typeof embeddings !== 'object' || Array.isArray(embeddings)) {
        unusable += 1;
        continue;
      }
      // ONE EVENT PER RECORD, CARRYING EVERY MODEL IT DECLARES — not one event
      // per model. A record listing two models is one statement about the page
      // ("here are its vectors"), not two competing ones, and splitting it made
      // the reconciler's cross-model retraction eat the record's own siblings:
      // the second model deleted the page from the first, so which vector
      // survived depended on JSON key order (review round 2, 2026-08-31).
      const models = new Map();
      // EVERY MODEL THE RECORD MENTIONS, usable or not. The reconciler retracts
      // the page from models the record does not mention — and a model whose
      // slot is present but CORRUPT has not been dropped by the store, it just
      // cannot be read. Retracting it would turn one bad sibling slot into a
      // deliberate-looking removal, silently changing model coverage and
      // possibly the winning model (review round 3, 2026-08-31).
      const declared = new Set();
      for (const [model, slot] of Object.entries(embeddings)) {
        const name = String(model);
        declared.add(name);
        if (!slot || typeof slot !== 'object') continue;
        const vec = slot.vec;
        if (!Array.isArray(vec) || vec.length === 0) continue;
        // A vector with a non-finite component cannot take part in a cosine —
        // one NaN turns every similarity involving this page into NaN, and NaN
        // compares false against every threshold, so the page would vanish from
        // the ranking WITHOUT being counted anywhere. Refuse it here so it is
        // counted as "no usable vector" instead.
        if (!vec.every((x) => typeof x === 'number' && Number.isFinite(x))) continue;
        models.set(name, vec);
      }
      // An `embeddings` object that yielded nothing usable is a rejected record
      // too — the commonest real shape of it being `vec` present but not an array.
      //
      // IT IS STILL EMITTED. Dropping it entirely meant a record that says "this
      // page is now model A only" was ignored when A's vector happened to be
      // corrupt, leaving a model B the store had just stopped listing still
      // claiming the page — and possibly winning the coverage tie with it
      // (review round 4, 2026-08-31). The event carries no usable vector, so it
      // writes nothing; what it does is let the reconciler retract the models
      // this record no longer mentions.
      if (models.size === 0) unusable += 1;
      events.push({ path: pagePath, models, declared });
    }
  }
  return { events, lines, malformed, unusable };
}

/**
 * The same parse, collapsed to a last-wins Map for callers that want one file's
 * final state. Kept because it is the shape the store reader's own tests speak,
 * and because "what does THIS file say" is a legitimate question.
 *
 * It is NOT what {@link reconcileSmartEnvStore} uses: collapsing per file is
 * precisely the chunk-dependence that made the two backends divergent. See the
 * note on {@link parseAjsonRecordEvents}.
 *
 * @param {string} text
 * @returns {{ records: Map<string, {vec: number[], model: string}|null>,
 *             lines: number, malformed: number, unusable: number }}
 */
export function parseAjsonSources(text) {
  const { events, lines, malformed, unusable } = parseAjsonRecordEvents(text);
  const records = new Map();
  for (const { path: p, models, declared } of events) {
    if (models === null) { records.set(p, null); continue; }
    // A record that yielded NO usable vector writes nothing here — but it can
    // still INVALIDATE what is held, and skipping it outright let this view
    // disagree with the reconciler: an all-corrupt record declaring only B left
    // a stale A vector standing where reconciliation correctly retracted it
    // (review round 5, 2026-08-31). It is not written as `null`, which would
    // make an unreadable slot indistinguishable from a tombstone.
    if (models.size === 0) {
      if (records.has(p)) {
        const held = records.get(p);
        // `null` held here is a TOMBSTONE, and this record un-retracts the page:
        // it says the page exists, just with a slot we cannot read. Leaving the
        // tombstone would report a live page as deleted (review round 6). And a
        // held vector whose model this record does not declare is stale. Either
        // way the honest answer is ABSENT — no vector, and no retraction.
        if (held === null || !declared.has(held.model)) records.delete(p);
      }
      continue;
    }
    // The Map view carries ONE vector per path, so a record declaring several
    // models is represented by its last — which is what this view has always
    // returned. The reconciler keeps them all; this shape simply cannot.
    let last = null;
    for (const [model, vec] of models) last = { vec, model };
    records.set(p, last);
  }
  return { records, lines, malformed, unusable };
}

/**
 * Merge parsed store text into the answer both backends return.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE FUNCTION
 * ---------------------------------------------------------------------------
 * There are two ways to reach this store: the local filesystem, and the
 * bridge's `GET /smart-env/sources` for a vault whose disk this machine does
 * not have. Everything that gives the bytes MEANING — last-wins, tombstones,
 * choosing one model, rejecting a minority dimension, rejecting a zero norm —
 * happens HERE, once, for both. The backends differ only in where the text came
 * from, so they cannot disagree about what it says. That is a stronger
 * guarantee than a parity test, which can only notice a divergence after
 * someone writes it.
 *
 * `texts` is consumed LAZILY and must stay that way: the local backend yields
 * one file at a time so a 166 MB store is never resident all at once.
 *
 * `meta` is read AFTER `texts` is exhausted, so a generator may fill in
 * `files` / `unreadableFiles` as it goes.
 *
 * @param {Iterable<string>} texts Raw `.ajson` text, in the order to merge.
 * @param {{storePath?: string, files?: number, unreadableFiles?: number}} meta
 * @returns {object} the store shape documented on {@link readSmartEnvEmbeddings}
 */
export function reconcileSmartEnvStore(texts, meta = {}) {
  // model → path → vec. Kept per-model so the winner is chosen on coverage
  // rather than on which file happened to be read first.
  const byModel = new Map();
  let malformed = 0;
  let unusable = 0;
  let tombstones = 0;
  let records = 0;

  // path → the models that currently claim it. Kept so a retraction touches
  // ONLY those models instead of sweeping every model map on every event, which
  // was quadratic in the number of distinct models and left empty maps behind
  // (review round 2, 2026-08-31).
  const modelsOf = new Map();

  for (const text of texts) {
    // EVENTS, not a per-text Map: collapsing inside each chunk makes the answer
    // depend on where the text was cut, and the two backends cut it differently
    // (803 files vs one blob). See parseAjsonRecordEvents.
    const parsed = parseAjsonRecordEvents(text);
    malformed += parsed.malformed;
    unusable += parsed.unusable;
    for (const { path: pagePath, models, declared } of parsed.events) {
      records += 1;
      const previous = modelsOf.get(pagePath);

      if (models === null) {
        tombstones += 1;
        if (previous) {
          for (const m of previous) byModel.get(m)?.delete(pagePath);
          modelsOf.delete(pagePath);
        }
        continue;
      }

      // A RECORD IS THE PAGE'S CURRENT STATE, NOT AN ADDITION TO IT. Re-indexing
      // a note under a new model rewrites its record, and the models the new
      // record does NOT list no longer claim the page. Adding without retracting
      // left it counted under both, inflating the losing model's coverage and
      // able to hand the tie to the wrong one — and only when the two records
      // sat in different FILES, which is exactly why one blob and many files
      // used to disagree.
      if (previous) {
        // Retract only from models this record does not MENTION. A mentioned
        // model whose slot could not be read keeps whatever it had: the store
        // did not drop it, we merely could not parse it (review round 3).
        for (const m of previous) if (!declared.has(m)) byModel.get(m)?.delete(pagePath);
      }
      for (const [model, vec] of models) {
        if (!byModel.has(model)) byModel.set(model, new Map());
        byModel.get(model).set(pagePath, vec);
      }
      // The index must say what byModel actually holds: the models just written,
      // PLUS any previously-held model this record mentioned but could not be
      // read for (left standing above). Recording only `models` would leave the
      // page in that model's map with no index entry pointing at it, so a later
      // tombstone would not retract it.
      const now = new Set(models.keys());
      if (previous) for (const m of previous) if (declared.has(m)) now.add(m);
      // A path that ends up claimed by NO model has no index entry to keep, and
      // storing an empty Set would grow this map by one useless entry per
      // distinct corrupt record (review round 5, 2026-08-31).
      if (now.size === 0) modelsOf.delete(pagePath);
      else modelsOf.set(pagePath, now);
    }
  }

  // A model every one of whose pages was retracted is not a model with zero
  // pages — it is a model this store no longer uses, and listing it in
  // `otherModels` would report a competitor that does not exist.
  for (const [model, map] of [...byModel]) if (map.size === 0) byModel.delete(model);

  // Read only now — see the contract above.
  const storePath = meta.storePath || `${SMART_ENV_DIR}/${SMART_ENV_MULTI}`;
  const files = Number.isInteger(meta.files) ? meta.files : 0;
  const unreadableFiles = Number.isInteger(meta.unreadableFiles) ? meta.unreadableFiles : 0;

  if (byModel.size === 0) {
    return { ok: false, reason: 'no-vectors', storePath, files, malformed, unusable, unreadableFiles };
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
    files,
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

/**
 * Read every whole-note vector a vault's Smart Connections store holds, OFF THE
 * LOCAL DISK. The remote twin is {@link readSmartEnvEmbeddingsViaRest}; both
 * hand their text to {@link reconcileSmartEnvStore}, which is the only place
 * that decides what the text means.
 *
 * @param {string} vaultPath Absolute path of the local vault root.
 * @param {object} [deps] Injectable `fs` (readdirSync/readFileSync) for tests.
 * @returns {{
 *   ok: boolean,
 *   reason?: string,
 *   storePath: string,
 *   vectors?: Map<string, number[]>,
 *   incompatible?: Map<string, string>,
 *   model?: string,
 *   dimensions?: number,
 *   files?: number,
 *   unreadableFiles?: number,
 *   records?: number,
 *   malformed?: number,
 *   unusable?: number,
 *   tombstones?: number,
 *   otherModels?: Array<{ model: string, pages: number }>,
 *   mixedDimensions?: number,
 *   zeroNorm?: number,
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

  // Filled DURING iteration and read by the reconciler afterwards.
  const meta = { storePath, files: files.length, unreadableFiles: 0 };

  // A generator, not an array: the largest store on this fleet is 166 MB and
  // materialising every file's text at once would hold all of it.
  //
  // Sorted so the read order — and therefore any last-wins tie between two
  // FILES claiming the same page — is the same on every machine, and the same
  // as the order the bridge sends. (Within one file, order is the file's own
  // and is the update history.)
  function* readEach() {
    for (const file of [...files].sort()) {
      try {
        yield io.readFileSync(lib.join(dir, file), 'utf8');
      } catch {
        // A FILE WE COULD NOT OPEN IS NOT A FILE WITH NOTHING IN IT. Reachable
        // without anything being broken — `ERR_STRING_TOO_LONG` on a store past
        // V8's string cap, or Obsidian holding the file while it writes — and an
        // uncounted skip reported `files: 2, vectors: 1, malformed: 0` for a run
        // that had opened exactly one of them.
        meta.unreadableFiles += 1;
      }
    }
  }

  return reconcileSmartEnvStore(readEach(), meta);
}

/**
 * The same store, for a vault whose disk this machine does not have.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS COSTS AND WHY IT IS STILL THE RIGHT SHAPE
 * ---------------------------------------------------------------------------
 * The bridge sends the store's whole-note record lines and nothing else. It
 * does not parse a record or look at a vector: the filter it applies is the
 * router's own first step (`parseAjsonSources` skips every line without the
 * `"smart_sources:` prefix), so the meaning of the bytes is still decided here
 * and only here. Measured over 1046 store files on four vaults, parsing the
 * full text and parsing the filtered text produce identical record maps.
 *
 * The transfer is real but bounded: 166 MB of store filters to 22 MB, and 4.3 MB
 * on the wire once gzip is negotiated — which undici does for us, transparently.
 *
 * ---------------------------------------------------------------------------
 * THE THREE WAYS THIS CAN DECLINE, AND WHY THEY ARE NOT ONE
 * ---------------------------------------------------------------------------
 *  - `bridge-route-absent` — a 404. The route did not answer. The route itself
 *    never returns 404 (it reports an empty store as a 200), so from the
 *    router's side the likeliest cause by far is a bridge older than 0.9.0 — but
 *    a 404 is produced by whatever is BETWEEN here and the bridge too, and a
 *    proxy that masks authorisation failures or strips this path looks exactly
 *    the same from here. The message says both rather than asserting the one it
 *    cannot prove (review, 2026-08-31).
 *  - `store-missing` / `store-empty` — the bridge answered, and this vault has
 *    no Smart Connections index. An ordinary fact, nothing to fix.
 *  - `store-truncated` — the bridge hit its budget and sent a PREFIX of the
 *    store. A partial corpus must never be compared as if it were whole: it
 *    would report "no twins" about pages it never saw. Refused here rather than
 *    silently narrowed.
 *
 * @param {object} vault registry vault descriptor
 * @param {{getSmartEnvSources?: Function, timeoutMs?: number}} [deps]
 * @returns {Promise<object>} the shape {@link readSmartEnvEmbeddings} returns
 */
export async function readSmartEnvEmbeddingsViaRest(vault, deps = {}) {
  const storePath = `${SMART_ENV_DIR}/${SMART_ENV_MULTI}`;
  const fetchSources = deps.getSmartEnvSources;
  if (typeof fetchSources !== 'function') {
    return { ok: false, reason: 'no-transport', storePath };
  }

  let body;
  try {
    body = await fetchSources(vault, { timeoutMs: deps.timeoutMs });
  } catch (err) {
    if (err && (err.status === 404 || err.kind === 'not_found')) {
      return { ok: false, reason: 'bridge-route-absent', storePath };
    }
    return {
      ok: false,
      reason: 'transport-failed',
      storePath,
      transportError: err && err.message ? String(err.message) : String(err),
    };
  }

  if (typeof body !== 'string' || !body) {
    return { ok: false, reason: 'malformed-response', storePath };
  }

  // The header is the FIRST LINE and nothing else parses it. Note that the body
  // could be handed to the reconciler whole — the header cannot be read as a
  // record — but its counts are needed, so it is split off deliberately.
  const nl = body.indexOf('\n');
  let header;
  try {
    header = JSON.parse(nl === -1 ? body : body.slice(0, nl));
  } catch {
    return { ok: false, reason: 'malformed-response', storePath };
  }
  if (!header || typeof header !== 'object' || header.kind !== 'smart-env-sources') {
    return { ok: false, reason: 'malformed-response', storePath };
  }

  if (header.available !== true) {
    const reason = typeof header.reason === 'string' ? header.reason : 'no-vectors';
    return { ok: false, reason, storePath: header.storePath || storePath };
  }
  if (header.truncated === true) {
    return {
      ok: false,
      reason: 'store-truncated',
      storePath: header.storePath || storePath,
      files: Number.isInteger(header.files) ? header.files : 0,
      filesRead: Number.isInteger(header.filesRead) ? header.filesRead : 0,
      truncatedBy: typeof header.truncatedBy === 'string' ? header.truncatedBy : undefined,
    };
  }

  // THE HEADER IS A CLAIM ABOUT THE BODY, AND IT IS CHECKED AGAINST IT.
  //
  // Trusting `truncated: false` on its own means a response that says "803 files,
  // 1310 records, complete" while carrying twenty record lines is reconciled and
  // ranked as though it were the whole store. Nothing in the answer would look
  // wrong — it would simply be a comparison of a fifth of the vault reported as
  // a comparison of the vault. That is this codebase's recurring defect class
  // (a 200 with the wrong shape read as valid data), so the counts are verified
  // rather than believed (review, 2026-08-31).
  const records = nl === -1 ? '' : body.slice(nl + 1);
  const inconsistent = (detail) => ({ ok: false, reason: 'store-inconsistent', storePath, detail });

  if (typeof header.truncated !== 'boolean') {
    return inconsistent('the header does not state whether it was truncated');
  }
  // A COUNT MUST BE A COUNT. `Number.isInteger` alone admits `-1`, and a header
  // reading `files: -1, filesRead: -1, unreadableFiles: 0` satisfies the balance
  // below and would be reported to the user as a vault with minus one store file
  // (review round 2, 2026-08-31).
  const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
  const files = count(header.files);
  const filesRead = count(header.filesRead);
  const unreadableFiles = count(header.unreadableFiles);
  const claimedLines = count(header.recordLines);
  const claimedBytes = count(header.bytes);
  if (files === null || filesRead === null || unreadableFiles === null
    || claimedLines === null || claimedBytes === null) {
    return inconsistent(
      'the header is missing, or does not state as a count, one of files / filesRead / '
      + 'unreadableFiles / recordLines / bytes',
    );
  }
  if (filesRead > files || unreadableFiles > files) {
    return inconsistent(
      `the header counts more files than it has: read ${filesRead}, unreadable ${unreadableFiles}, of ${files}`,
    );
  }
  // An untruncated read accounts for every file it listed.
  if (filesRead + unreadableFiles !== files) {
    return inconsistent(
      `the header does not balance: filesRead ${filesRead} + unreadable ${unreadableFiles} ≠ files ${files}`,
    );
  }
  // …the body carries exactly as many record lines as it claims…
  let seenLines = 0;
  for (const l of records.split('\n')) if (l.startsWith(`"${SOURCE_KEY_PREFIX}`)) seenLines += 1;
  if (seenLines !== claimedLines) {
    return inconsistent(
      `the body carries ${seenLines} record line(s) but the header claims ${claimedLines}`,
    );
  }
  // …AND WEIGHS WHAT IT CLAIMS TO WEIGH. The line count alone does not catch a
  // body cut in the middle of its last record: the truncated line still starts
  // with the prefix, so it still counts, and it would simply be tallied as
  // `malformed` while the rest was ranked as a complete corpus (review round 2).
  const seenBytes = Buffer.byteLength(records, 'utf8');
  if (seenBytes !== claimedBytes) {
    return inconsistent(
      `the body weighs ${seenBytes} byte(s) but the header claims ${claimedBytes}`,
    );
  }

  return reconcileSmartEnvStore([records], {
    storePath: header.storePath || storePath,
    files,
    unreadableFiles,
  });
}

export const _internals = { libFor };
