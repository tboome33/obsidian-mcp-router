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
 *  - It therefore belongs to HOOKS and CLI SCRIPTS, never to the server. The
 *    router proper is HTTP-only by doctrine — its test suite runs under
 *    `node --permission` with the vault's disk refused, to prove no tool needs
 *    it. Nothing here may be imported by a tool.
 *
 * WHAT IT DOES NOT CLAIM. `unindexed` means the store holds zero pages, not
 * "the index is incomplete". A vault indexed to 10% reads as `ready` here.
 * That threshold was chosen (Roland, 2026-09-22) over comparing the store
 * against the vault's note count, which is accurate but imposes a full
 * directory walk at every session start — measured as the dominant cost on the
 * network-mounted vaults, which is where the probe is already slowest.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Smart Connections' store, at the vault root. A dot-directory. */
const SMART_ENV_MULTI = ['.smart-env', 'multi'];
/** The plugin id, as Obsidian writes it in both places we read. */
export const SMART_CONNECTIONS_ID = 'smart-connections';
/** Its search half, split out at Smart Connections 4.7. */
export const SMART_LOOKUP_ID = 'smart-lookup';

/**
 * The states a vault's semantic tier can be in, in the order of "how much does
 * the user need to hear about it".
 *
 *  - `disabled`  — the plugin is on disk but absent from `community-plugins.json`.
 *                  Obsidian will not load it, so the store will never be built.
 *                  This is the state that reads as working and is not: the
 *                  folder is there, the sync reported success, and nothing
 *                  indexes.
 *  - `unindexed` — enabled, but the store holds zero pages. Either the vault has
 *                  not been opened since the plugin arrived, or indexing never
 *                  ran.
 *  - `absent`    — no plugin folder at all.
 *  - `ready`     — enabled, store non-empty.
 *  - `unknown`   — the vault's disk could not be read here (a remote vault, a
 *                  disconnected mount, a permission refusal). NOT a problem
 *                  report: this module cannot see, and says so rather than
 *                  guessing `absent`.
 */
export const SEMANTIC_STATES = ['disabled', 'unindexed', 'absent', 'ready', 'unknown'];

/**
 * The states the RECURRING session reminder speaks about.
 *
 * `absent` is deliberately NOT here. A vault that never had Smart Connections
 * may simply not want it, and a reminder that fires on a choice is a reminder
 * the reader learns to skip — which costs us the two that matter. The binding
 * moment says it once (see `semanticReadinessBindingAdvice`); after that,
 * silence.
 */
export const REMINDER_STATES = new Set(['disabled', 'unindexed']);

/** Parse a vault's `community-plugins.json`, or null when unreadable. */
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

/** Does this vault carry the plugin's own folder? Its manifest is the marker. */
function pluginInstalled(vaultPath, id) {
  try {
    return fs.statSync(path.join(vaultPath, '.obsidian', 'plugins', id, 'manifest.json')).isFile();
  } catch {
    return false;
  }
}

/**
 * Probe one vault. Pure disk, no network, never throws.
 *
 * @param {string} vaultPath
 * @returns {{state: string, indexed: number|null, lookupInstalled: boolean}}
 */
export function probeSemanticReadiness(vaultPath) {
  if (typeof vaultPath !== 'string' || vaultPath.trim() === '') {
    return { state: 'unknown', indexed: null, lookupInstalled: false };
  }

  const enabled = enabledPlugins(vaultPath);
  const installed = pluginInstalled(vaultPath, SMART_CONNECTIONS_ID);
  const lookupInstalled = pluginInstalled(vaultPath, SMART_LOOKUP_ID);

  // An unreadable plugin list is NOT "nothing is enabled". A disconnected
  // network mount answers exactly like a vault with no plugins, and reporting
  // `disabled` there would send the user to fix a setting that is already
  // correct. Only the absence of the vault directory itself is decided here;
  // everything else unreadable is `unknown`.
  if (enabled === null) {
    return { state: 'unknown', indexed: null, lookupInstalled };
  }

  if (!installed) {
    return { state: 'absent', indexed: null, lookupInstalled };
  }

  if (!enabled.includes(SMART_CONNECTIONS_ID)) {
    // The folder is on disk and Obsidian ignores it. Measured 2026-09-22: the
    // bridge answers this case with the SAME body as a missing plugin
    // ("Smart Connections plugin is not available"), so the running router
    // degrades correctly — but only for whoever asks. Nobody is told.
    return { state: 'disabled', indexed: null, lookupInstalled };
  }

  let indexed = 0;
  try {
    indexed = fs.readdirSync(path.join(vaultPath, ...SMART_ENV_MULTI)).length;
  } catch {
    // No store directory at all is the ordinary "never indexed" shape, not an
    // unknown: we already know the plugin is installed AND enabled here.
    indexed = 0;
  }

  return { state: indexed > 0 ? 'ready' : 'unindexed', indexed, lookupInstalled };
}

/**
 * Probe the vaults a workspace is bound to, within a time budget.
 *
 * THE BUDGET IS NOT DECORATION. Measured 2026-09-22 across 28 vaults: 110 ms
 * for the 27 on local disks, and 1023 ms for the single one on a cold mapped
 * network drive. A session-start hook that can add a second to every start on
 * a bad day is a hook the user will disable, so it stops instead — and says
 * nothing rather than reporting the vaults it never reached.
 *
 * NAME → PATH IS NOT RESOLVED HERE, ON PURPOSE. It is injected, because the
 * repo already owns that resolution in `vault-slug.mjs:resolveVaultBySlug`,
 * and that function carries corrections this module has no business
 * re-deriving: names compare VERBATIM (no lowercasing, no trimming — two
 * separate holes closed there, each one having resolved a binding to a
 * DIFFERENT vault's path), and a remote vault resolves to no local path at all
 * rather than folding onto a local namesake. A second resolver would be a
 * second set of those bugs. An earlier draft of this file did write one, and
 * an end-to-end run against the real fleet is what caught it: it matched 15
 * vaults of 28 and none of the three the test asked for.
 *
 * @param {string[]} names vault names, primary first
 * @param {(name: string) => (string|null|undefined)} resolvePath
 * @param {{budgetMs?: number, now?: () => number}} [opts]
 * @returns {{entries: Array<{name: string, state: string, indexed: number|null,
 *   lookupInstalled: boolean}>, skipped: number}}
 */
export function probeBoundVaults(names, resolvePath, opts = {}) {
  const budgetMs = Number.isFinite(opts.budgetMs) ? opts.budgetMs : 400;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const list = Array.isArray(names) ? names.filter((n) => typeof n === 'string' && n.trim() !== '') : [];

  const entries = [];
  const started = now();
  let skipped = 0;

  for (const [i, name] of list.entries()) {
    // The budget is checked BEFORE each probe, not after: a probe already begun
    // cannot be interrupted, and checking after would let the first slow vault
    // spend the whole budget and still be counted as delivered.
    //
    // THE FIRST NAME IS EXEMPT. It is the workspace's primary vault — the one
    // the session is actually about — and a budget that can skip it turns a
    // slow disk into total silence about the vault that matters most. The
    // budget exists to stop a long WALK, not to skip the head of it.
    if (i > 0 && now() - started > budgetMs) { skipped += 1; continue; }
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
 * @param {Array<{name: string, state: string}>} entries
 * @returns {string|null}
 */
export function semanticReadinessLine(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const flagged = list.filter((e) => e && REMINDER_STATES.has(e.state));
  if (flagged.length === 0) return null;

  const say = (e) => (e.state === 'disabled'
    ? `"${e.name}" has Smart Connections installed but NOT enabled`
    : `"${e.name}" has Smart Connections enabled but its index is empty`);

  const parts = flagged.map(say).join('; ');
  const fix = flagged.some((e) => e.state === 'disabled')
    ? ' Enable it in Obsidian: Settings → Community plugins.'
    : '';
  const index = flagged.some((e) => e.state === 'unindexed')
    ? ' An empty index fills itself once the vault is opened in Obsidian and indexing completes.'
    : '';

  return 'SEMANTIC_TIER_NOT_READY\n'
    + `Semantic search is unavailable on this workspace's vault(s): ${parts}.`
    + fix + index
    + ' Until then `search_smart` falls back to the local BM25 tier, which needs'
    + ' `build_search_index` to have been run, and `find_twin_pages` and the'
    + " semantic part of `get_wiki_context_pack` cannot answer at all. Tell the user"
    + ' once, plainly, at the start of the session — do not repeat it mid-session.';
}

/**
 * What to tell the user AT THE MOMENT A VAULT IS BOUND — said once, covering
 * what the recurring reminder deliberately leaves out.
 *
 * Two differences from {@link semanticReadinessLine}, both decided 2026-09-22:
 * `absent` is spoken here (a fresh binding is exactly when installing is
 * cheap), and Smart Lookup is mentioned here ONLY. The router does not use
 * Smart Lookup — `search_smart` reads the store Smart Connections builds — so
 * putting it in a recurring reminder would rank a personal convenience beside
 * a missing capability, and a reminder one learns to skip stops protecting the
 * one that matters.
 *
 * @param {{state: string, lookupInstalled: boolean}} probe
 * @returns {string|null}
 */
export function semanticReadinessBindingAdvice(probe) {
  if (!probe || typeof probe !== 'object') return null;
  const { state, lookupInstalled } = probe;
  if (state === 'unknown') return null;

  const lines = [];
  if (state === 'absent') {
    lines.push('Smart Connections is not installed in this vault. Without it there is no'
      + ' semantic search: `search_smart` falls back to the local BM25 index, and'
      + ' `find_twin_pages` cannot run. Install it from Obsidian: Settings → Community'
      + ' plugins → "Smart Connections".');
  } else if (state === 'disabled') {
    lines.push('Smart Connections is installed in this vault but NOT enabled, so it will'
      + ' never build an index and semantic search will not work. Enable it in Obsidian:'
      + ' Settings → Community plugins.');
  } else if (state === 'unindexed') {
    lines.push('Smart Connections is enabled here but has indexed nothing yet. Open the'
      + ' vault in Obsidian and let the first indexing finish — it runs locally, needs no'
      + ' API key, and can take a few minutes on a large vault.');
  }

  if (!lookupInstalled) {
    // Said once, and said as an OFFER rather than a requirement, because it is
    // one: nothing in the router degrades without it.
    lines.push('Optional, for you rather than for the router: "Smart Lookup" is the search'
      + ' half of Smart Connections, split into its own plugin at version 4.7. It answers a'
      + ' question you type, where Smart Connections answers "what resembles the note I have'
      + ' open". It reuses the same index and costs no extra indexing. The router never'
      + ' calls it.');
  }

  return lines.length ? lines.join('\n\n') : null;
}
