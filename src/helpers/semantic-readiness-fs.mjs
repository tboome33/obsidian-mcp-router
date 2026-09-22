/**
 * semantic-readiness-fs — is this vault's semantic tier actually going to answer?
 *
 * `search_smart` computes no embeddings of its own: it reads the store Smart
 * Connections builds under `<vault>/.smart-env/`. So a vault can be perfectly
 * reachable, perfectly writable, and still have no semantic search at all —
 * and the way you learn it today is by asking a question and getting a labelled
 * BM25 degrade back. That is detection at the moment of the loss, which is the
 * one moment it is least useful.
 *
 * This module answers the same question BEFORE the question is asked, from the
 * vault's own disk. Two consequences of reading disk rather than HTTP, both
 * deliberate:
 *
 *  - It works with Obsidian CLOSED. That is the whole point: the vault you have
 *    not opened is exactly the vault whose semantic tier you cannot probe over
 *    HTTP, and exactly the one you are least likely to know is broken.
 *  - It therefore belongs to HOOKS, never to the server. The router proper is
 *    HTTP-only by doctrine — its test suite runs under `node --permission` with
 *    the vault's disk refused, to prove no tool needs it. This module ENFORCES
 *    that rather than hoping for it: in the server process it throws before
 *    touching the disk (src/helpers/server-process.mjs).
 *
 * WHAT IT MEASURES, AND NOTHING MORE. It looks for regular files named
 * `*.ajson` in the store directory — the shape Smart Connections writes, one
 * per page (measured on 3 vaults of 3). It does not open them: an empty or
 * corrupt `x.ajson` counts, so `ready` means "the store is not empty", not
 * "semantic search is verified to work". `unindexed` means no such file — not
 * "the index is incomplete", and not "was never indexed": a store that was
 * cleared reads the same as one never built. A vault indexed to 10% reads as
 * `ready`. That threshold was chosen
 * (Roland, 2026-09-22) over comparing the store against the vault's note count,
 * which is accurate but imposes a full directory walk at every session start —
 * measured as the dominant cost on the network-mounted vaults, which is where
 * the probe is already slowest.
 *
 * NOT NETWORK-FREE IN EVERY SENSE. It makes no network call of its own, but a
 * vault on a mapped or UNC drive is read over the network by the OS, and a
 * synchronous read there can block for as long as the OS lets it. The time
 * budget below bounds how many such reads are STARTED; it cannot interrupt one.
 */

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { safeForMessage } from './sanitize.mjs';
import { isServerProcess } from './server-process.mjs';

/**
 * Refuse to run inside the router server. The server is HTTP-only by doctrine;
 * this module reads vault disk. Whatever imported it, in the server process, a
 * worker it created or a child it spawned (src/helpers/server-process.mjs says
 * how, and what is NOT covered), every EXPORTED function that can reach the
 * disk throws BEFORE the first filesystem call — `probeSemanticReadiness`
 * (and so `probeBoundVaults`) and `_internals.whyMissing`. The internal
 * helpers do not check on their own; they are reachable only through those.
 * A doctrine breach becomes a loud, immediate failure instead of a silent read.
 */
function assertNotServerProcess() {
  if (isServerProcess()) {
    throw new Error(
      'semantic-readiness-fs: refusing to read a vault\'s disk inside the router server process. '
      + 'The server is HTTP-only (tests/no-vault-disk.test.mjs); this probe belongs to the session hook.',
    );
  }
}

/**
 * Quote a vault name for text that lands in the MODEL'S session context.
 *
 * A vault name comes from a hand-editable config file. Every other line of the
 * same briefing quotes it through `safeForMessage` — injection neutralised,
 * CR/LF/tab flattened, length capped — and this module's first version did
 * not: a name carrying a newline could open a fresh line of "instructions"
 * inside the block the model reads first. Same helper, same cap (80), so the
 * two halves of one briefing cannot quote the same name two different ways.
 */
const q = (name) => `"${safeForMessage(String(name), 80)}"`;

/** Smart Connections' store, at the vault root. A dot-directory. */
const SMART_ENV_MULTI = ['.smart-env', 'multi'];
/** The file shape Smart Connections writes into its store — measured on 3 vaults of 3. */
const STORE_RECORD = /\.ajson$/i;
/** The plugin id, as Obsidian writes it in both places we read. */
export const SMART_CONNECTIONS_ID = 'smart-connections';

/**
 * The states a vault's semantic tier can be in.
 *
 *  - `disabled`  — the plugin's manifest is on disk but its id is absent from a
 *                  readable `community-plugins.json`. Obsidian will not load
 *                  it, so the store will never be built. This is the state that
 *                  reads as working and is not: the folder is there, the sync
 *                  reported success, and nothing indexes.
 *  - `unindexed` — enabled, but the store directory holds no `*.ajson` file,
 *                  or does not exist yet.
 *  - `absent`    — no plugin manifest (the plugin folder, or its manifest, does
 *                  not exist).
 *  - `ready`     — enabled, and the store holds at least one `*.ajson` file
 *                  (present, not verified usable).
 *  - `unknown`   — something that should have been readable was not: the
 *                  plugin list, the manifest, or the store directory answered
 *                  with an error other than "does not exist" (a permission
 *                  refusal, a disconnected mount, a FILE where a directory
 *                  belongs). NOT a problem report: this module cannot see, and
 *                  says so rather than guessing.
 */
export const SEMANTIC_STATES = Object.freeze(['disabled', 'unindexed', 'absent', 'ready', 'unknown']);

/**
 * The states the RECURRING session reminder speaks about.
 *
 * `absent` is deliberately NOT here. A vault that never had Smart Connections
 * may simply not want it, and a reminder that fires on a choice is a reminder
 * the reader learns to skip — which costs us the two that matter.
 */
export const REMINDER_STATES = new Set(['disabled', 'unindexed']);

/**
 * Parse a vault's `community-plugins.json`.
 * @returns {string[]|null} the list, or null when it cannot be read or is not an array
 */
function enabledPlugins(vaultPath) {
  try {
    const raw = fs.readFileSync(
      path.join(vaultPath, '.obsidian', 'community-plugins.json'), 'utf8',
    );
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : null;
  } catch {
    return null;
  }
}

/**
 * After an ENOENT on `<base>/<segments…>`: is that path GENUINELY absent, or
 * is something broken on the way to it?
 *
 * ENOENT alone cannot say. On Windows, asking for a child of a regular FILE
 * answers ENOENT (POSIX says ENOTDIR) — so a file sitting where `.smart-env`
 * belongs made an unreadable store read as "empty", and a file where
 * `.obsidian/plugins` belongs made an installed plugin read as "absent"
 * (Codex, review of the first repair). A dangling symlink or junction answers
 * ENOENT too. So each ancestor is examined, from the base down, and only a
 * missing one that is reached through real directories counts as absence.
 *
 * @returns {'missing'|'unknown'}
 */
function whyMissing(base, segments) {
  // It reads the disk, and it is reachable from outside this module through
  // `_internals`: an export is not a barrier, so it checks the mark itself
  // rather than trusting its callers to have (Codex, review of the run-time
  // version — `_internals.whyMissing` read disk in a marked process).
  assertNotServerProcess();
  // The BASE first. If the vault itself has gone — a junction whose target
  // vanished, a network drive dropped between the reads above and this one —
  // every child answers ENOENT, and without this check that read as "the store
  // is simply not there yet". Nothing here is atomic: a path can change
  // between any two calls. The check narrows that window; it cannot close it.
  try {
    if (!fs.statSync(base).isDirectory()) return 'unknown';
  } catch {
    return 'unknown';
  }
  let p = base;
  for (const [i, seg] of segments.entries()) {
    p = path.join(p, seg);
    const last = i === segments.length - 1;
    let l;
    try { l = fs.lstatSync(p); } catch (err) {
      return err && err.code === 'ENOENT' ? 'missing' : 'unknown';
    }
    let st = l;
    if (l.isSymbolicLink()) {
      // A link (a Windows junction lstat's as one) must lead somewhere.
      try { st = fs.statSync(p); } catch { return 'unknown'; }
    }
    if (!last && !st.isDirectory()) return 'unknown';
  }
  // Every segment exists, yet the caller got ENOENT: inconsistent, so unknown.
  return 'unknown';
}

/**
 * Is the plugin installed? Tri-state, because "I could not tell" must never be
 * read as "no": an access-denied manifest reported as `absent` sends the user
 * to install a plugin they already have.
 *
 * @returns {'yes'|'no'|'unknown'}
 */
function pluginInstalled(vaultPath, id) {
  const segments = ['.obsidian', 'plugins', id];
  const dir = path.join(vaultPath, ...segments);
  const missing = (err, segs) => (err && err.code === 'ENOENT'
    ? (whyMissing(vaultPath, segs) === 'missing' ? 'no' : 'unknown')
    : 'unknown');

  // The FOLDER first, and on its own: a file where the plugin folder belongs
  // is a broken install, and asking for `<file>/manifest.json` cannot tell
  // (POSIX: ENOTDIR, Windows: ENOENT — measured).
  let d;
  try { d = fs.statSync(dir); } catch (err) { return missing(err, segments); }
  // REDUNDANT, AND SAID SO: the manifest lookup below would fail through a
  // file anyway, and `whyMissing` would then answer `unknown` for this same
  // shape. Kept so this function reads correctly on its own; a mutation that
  // removes it is expected to SURVIVE, and that is not a missing test.
  if (!d.isDirectory()) return 'unknown';

  let m;
  try { m = fs.statSync(path.join(dir, 'manifest.json')); } catch (err) { return missing(err, [...segments, 'manifest.json']); }
  // A DIRECTORY named manifest.json stats fine and is not a manifest.
  return m.isFile() ? 'yes' : 'unknown';
}

/**
 * Count the regular `*.ajson` files in the store (their contents are not read).
 * @returns {number|null} the count, 0 when the store does not exist yet, or
 *   null when the store could not be read for any other reason
 */
function storeRecords(vaultPath) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(vaultPath, ...SMART_ENV_MULTI), { withFileTypes: true });
  } catch (err) {
    // A store that does not exist yet is the ordinary empty shape. Anything
    // else — access denied, I/O error, a file where a directory belongs, a
    // dangling link — is NOT "empty", and reporting it as empty would tell the
    // user to wait for an indexing that may already have happened. ENOENT is
    // believed only once every ancestor has been checked.
    if (err && err.code === 'ENOENT') {
      return whyMissing(vaultPath, SMART_ENV_MULTI) === 'missing' ? 0 : null;
    }
    return null;
  }
  // Records only: a stray subdirectory or an unrelated file must not make an
  // empty store read as `ready`.
  return entries.filter((e) => e.isFile() && STORE_RECORD.test(e.name)).length;
}

/**
 * Probe one vault. Pure disk. Never throws — EXCEPT inside the router server
 * process, where it refuses on purpose (see `assertNotServerProcess`).
 *
 * @param {string} vaultPath
 * @returns {{state: string, indexed: number|null}}
 */
export function probeSemanticReadiness(vaultPath) {
  assertNotServerProcess();
  if (typeof vaultPath !== 'string' || vaultPath.trim() === '') {
    return { state: 'unknown', indexed: null };
  }

  const enabled = enabledPlugins(vaultPath);
  // An unreadable plugin list is NOT "nothing is enabled". A disconnected
  // network mount answers exactly like a vault with no plugins, and reporting
  // `disabled` there would send the user to fix a setting that is already
  // correct.
  if (enabled === null) return { state: 'unknown', indexed: null };

  const installed = pluginInstalled(vaultPath, SMART_CONNECTIONS_ID);
  if (installed === 'unknown') return { state: 'unknown', indexed: null };
  if (installed === 'no') return { state: 'absent', indexed: null };

  if (!enabled.includes(SMART_CONNECTIONS_ID)) {
    // The manifest is on disk and Obsidian ignores it. Measured 2026-09-22: the
    // bridge answers this case with the SAME body as a missing plugin
    // ("Smart Connections plugin is not available"), so the running router
    // degrades correctly — but only for whoever asks. Nobody is told.
    return { state: 'disabled', indexed: null };
  }

  const indexed = storeRecords(vaultPath);
  if (indexed === null) return { state: 'unknown', indexed: null };
  return { state: indexed > 0 ? 'ready' : 'unindexed', indexed };
}

/**
 * Probe the vaults a workspace is bound to, within a time budget.
 *
 * THE BUDGET IS NOT DECORATION. Measured 2026-09-22 across 28 vaults: 110 ms
 * for the 27 on local disks, and 1023 ms for the single one on a cold mapped
 * network drive. A session-start hook that can add a second to every start on
 * a bad day is a hook the user will disable, so it stops starting new probes
 * instead, and returns how many names it did not reach.
 *
 * The clock is MONOTONIC (`performance.now`), not wall time: `Date.now()` can
 * step backwards on an NTP correction and would then resume probing after the
 * budget had already been declared spent. And the verdict LATCHES — once
 * exhausted, every later name is skipped, whatever the clock says next.
 *
 * NAME → PATH IS NOT RESOLVED HERE, ON PURPOSE. It is injected, because the
 * repo already owns that resolution in `vault-slug.mjs:resolveVaultBySlug`,
 * and that function carries corrections this module has no business
 * re-deriving: exact names compare verbatim, and an exact remote name resolves
 * to no local path at all rather than folding onto a local namesake. A second
 * resolver would be a second set of those bugs. An earlier draft of this file
 * did write one, and an end-to-end run against the real fleet is what caught
 * it: it matched 15 vaults of 28 and none of the three the run asked for.
 *
 * @param {string[]} names vault names, primary first
 * @param {(name: string) => (string|null|undefined)} resolvePath
 * @param {{budgetMs?: number, now?: () => number}} [opts] `budgetMs` must be a
 *   finite number >= 0 (anything else means the default, 400); 0 means "the
 *   primary only". `now` is for tests.
 * @returns {{entries: Array<{name: string, state: string, indexed: number|null}>,
 *   skipped: number}} `skipped` counts names over budget AND names the resolver
 *   could not place
 */
export function probeBoundVaults(names, resolvePath, opts = {}) {
  const budgetMs = Number.isFinite(opts.budgetMs) && opts.budgetMs >= 0 ? opts.budgetMs : 400;
  const now = typeof opts.now === 'function' ? opts.now : () => performance.now();
  const list = Array.isArray(names) ? names.filter((n) => typeof n === 'string' && n.trim() !== '') : [];

  const entries = [];
  const started = now();
  let skipped = 0;
  let exhausted = false;

  for (const [i, name] of list.entries()) {
    // The budget is checked BEFORE each probe, not after: a probe already begun
    // cannot be interrupted, and checking after would let the first slow vault
    // spend the whole budget and still be counted as delivered.
    //
    // THE FIRST NAME IS EXEMPT. It is the workspace's primary vault — the one
    // the session is actually about — and a budget that can skip it turns a
    // slow disk into total silence about the vault that matters most. The
    // budget exists to stop a long WALK, not to skip the head of it.
    if (i > 0 && !exhausted && now() - started >= budgetMs) exhausted = true;
    if (exhausted) { skipped += 1; continue; }
    let p;
    // The injected resolver reads a hand-editable config; it throwing must not
    // take the briefing down with it.
    try { p = typeof resolvePath === 'function' ? resolvePath(name) : undefined; } catch { p = undefined; }
    if (typeof p !== 'string' || p.trim() === '') { skipped += 1; continue; }
    entries.push({ name, ...probeSemanticReadiness(p) });
  }

  return { entries, skipped };
}

/**
 * The recurring session line, or null for silence.
 *
 * Silence is the common case by construction: it speaks only for
 * {@link REMINDER_STATES}, so a healthy fleet prints nothing, and a vault whose
 * disk could not be read prints nothing either.
 *
 * `skipped` is mentioned ONLY when there is already a line to print. A slow
 * mapped drive can put secondaries over budget on every start, and a line that
 * says "some vaults were not checked" every session about a healthy fleet is
 * noise the reader learns to skip. When something IS wrong, knowing the check
 * was partial matters, so it is said then.
 *
 * @param {Array<{name: string, state: string}>} entries
 * @param {{skipped?: number}} [opts]
 * @returns {string|null}
 */
export function semanticReadinessLine(entries, opts = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const flagged = list.filter((e) => e && REMINDER_STATES.has(e.state));
  if (flagged.length === 0) return null;

  const say = (e) => (e.state === 'disabled'
    ? `${q(e.name)} has Smart Connections installed but NOT enabled`
    : `${q(e.name)} has Smart Connections enabled but its index is empty`);

  const parts = flagged.map(say).join('; ');
  const fix = flagged.some((e) => e.state === 'disabled')
    ? ' Enable it in Obsidian: Settings → Community plugins.'
    : '';
  const index = flagged.some((e) => e.state === 'unindexed')
    ? ' An empty index fills itself once the vault is opened in Obsidian and indexing completes.'
    : '';
  const skipped = Number.isInteger(opts.skipped) && opts.skipped > 0
    ? ` ${opts.skipped} other bound vault(s) were not checked this session (time budget or unresolvable name).`
    : '';

  return 'SEMANTIC_TIER_NOT_READY\n'
    + `Semantic search is unavailable on this workspace's vault(s): ${parts}.`
    + fix + index + skipped
    + ' Until then `search_smart` can only answer from the local BM25 fallback, which needs'
    + ' `build_search_index` to have been run, and `find_twin_pages` and the'
    + " semantic part of `get_wiki_context_pack` cannot answer at all. Tell the user"
    + ' once, plainly, at the start of the session — do not repeat it mid-session.';
}

/**
 * The ancestor check, exported so tests can drive the race branches no public
 * entry point reaches. Exported does not mean unguarded: it checks the
 * server-process mark itself, like every function here that reads disk.
 */
export const _internals = { whyMissing };
