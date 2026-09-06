/**
 * workspace-bindings.mjs — which vault a WORKSPACE is bound to, and the ONE
 * place that answers the question.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 * ---------------------------------------------------------------------------
 * Until now, a workspace named its vault through OBSIDIAN_ROUTER_DEFAULT_VAULT
 * in the project's own dotenv file. A workspace is very often a cloned
 * repository, and a cloned repository carries whatever that file's author put
 * in it — so the binding between "this project" and "that vault of mine" was
 * decided by a file the user may never have written. v0.87.0 closed the
 * security half (such a file can only ever name a vault the user already
 * registered, never an endpoint or a credential); v0.88.0 made the choice
 * VISIBLE (`defaultVaultSource`); v0.89.0 removed the one value that turned it
 * into standing write permission (`FullAuto`).
 *
 * This module is the next step of the same accepted decision
 * (`liaison-workspace-vault-hors-depot`, points 1 and 2): the binding moves OUT
 * of the repository, into the user's own config, indexed by the canonical path
 * of the workspace. The dotenv line stops being an authority and becomes a
 * HINT — portable, signalled, confirmed once per machine.
 *
 * ---------------------------------------------------------------------------
 * WHY THE KEY IS A CANONICAL PATH
 * ---------------------------------------------------------------------------
 * Two projects can both be called `notes`; only their paths tell them apart.
 * And the key is per-machine by construction, which is the point: the config
 * file that holds it is never synchronised between machines (it carries API
 * keys and local paths), so one machine's confirmation never binds another's.
 *
 * The normalisation is NOT written here. `normalizePathForCompare` already
 * exists, already folds Windows case, already strips trailing separators, and
 * is already what the vault registry compares paths with. A second
 * normalisation would be a second answer to one question — the class of defect
 * this repository keeps rediscovering.
 *
 * ---------------------------------------------------------------------------
 * THREE STATES, NOT TWO
 * ---------------------------------------------------------------------------
 * A workspace is bound to ONE vault, to ONE OR MORE, or to ALL of them:
 *
 *   - one    — a binding with `vault` and an empty `also`
 *   - several— a binding whose `also` names further vaults, all addressable
 *   - all    — no binding at all; the resolution cascade picks the default and
 *              every registered vault stays addressable by name
 *
 * `also` is new information for the router. `--attach a --also b` writes only
 * `a` into the dotenv file; `b` lives solely in the workspace's CLAUDE.md — a
 * prose block for Claude that the router never reads. The secondaries were
 * addressable only because EVERY registered vault is addressable by name, not
 * because anything tied them to the workspace. Recording them here is the
 * first time the router itself knows about them.
 *
 * Node builtins plus one dependency-free local helper: this module is read on
 * the start-up path.
 */

import fs from 'node:fs';
import path from 'node:path';
import { normalizePathForCompare } from './vault-path-identity.mjs';
import { writeFileAtomicSync } from './write-file-atomic.mjs';
import { envKeyOrigin, ENV_ORIGINS, dotenvRefusalHint, workspaceBindingProposal } from './workspace-dotenv.mjs';
import { acquireLock, lockPathFor } from './file-lock.mjs';

/** The config key holding every binding. The seventh top-level key. */
export const WORKSPACE_BINDINGS_KEY = 'workspaceBindings';

/**
 * The config key holding every REFUSED proposal, per workspace — decision
 * `refus-d-une-proposition-de-liaison` (accepted 2026-09-04).
 *
 *   workspaceRefusals: { "<canonical workspace key>": { "<vault>": "<date>" } }
 *
 * A refusal names a VAULT, never "this workspace, for good": a global refusal
 * would silence a DIFFERENT proposal arriving later (the file changes, names
 * another vault, and the question is never asked) — the decision's trap 1,
 * and the permanent-versus-transient distinction `CLOSING_REASONS` exists for.
 *
 * Kept OUT of the binding record on purpose. A workspace can hold refusals
 * and no binding, and `normalizeBinding` rightly answers "no binding" to an
 * entry without a `vault` — so refusals folded into that record would be
 * dropped by `withoutBinding`, replaced by `withBinding`, and invisible to
 * `unchangedBindings`, which compares through `normalizeBinding`. A sibling
 * key with its own reader and its own two transforms has none of those
 * cliffs.
 */
export const WORKSPACE_REFUSALS_KEY = 'workspaceRefusals';

/**
 * How a workspace's dotenv hint relates to what the registry says. Returned by
 * `classifyBindingHint`, surfaced by `list_vaults`, and read by the
 * session-start briefing.
 *
 * SIX values. Three are silence (`none`, `confirmed`, `refused`) and three are
 * signalled; `hintIsWorthSignalling` is the one place that partition is
 * written, and a test proves every consumer handles every value.
 */
export const HINT_STATUS = Object.freeze({
  /** No hint in the environment at all. */
  NONE: 'none',
  /**
   * The hint names a vault the confirmed binding names — the primary, or a
   * secondary in `also`. Nothing to say: what the file proposed is in force.
   * (A secondary used to fall to `conflicts`, so a workspace bound to
   * `work` + `personal` whose `.env` proposed `personal` was told at every
   * start that "the binding wins" over a vault it WAS bound to, and offered
   * a refusal the tool then rejected. Fable round on 7efbad1.)
   */
  CONFIRMED: 'confirmed',
  /** The hint names a REGISTERED vault this workspace has not confirmed. Signalled, never applied. */
  UNCONFIRMED: 'unconfirmed',
  /** The hint names a vault this machine does not have — bound or not. Signalled, never applied. */
  UNKNOWN_VAULT: 'unknown-vault',
  /** A binding exists and the hint names a DIFFERENT registered vault. Signalled; the binding wins. */
  CONFLICTS: 'conflicts',
  /**
   * The hint names a vault this workspace REFUSED, in the user's own config.
   * Silence: the question was asked and answered. A binding to that very
   * vault outranks the refusal (`confirmed`, never this) — the refusal is
   * then stale, and `withBinding` drops it.
   */
  REFUSED: 'refused',
});

/**
 * The canonical registry key for a workspace directory.
 *
 * Resolved to an absolute path first, so a relative cwd and the same directory
 * spelled absolutely produce one key rather than two. Then through the shared
 * normalisation, which folds Windows case and strips trailing separators.
 *
 * @param {string} cwd
 * @returns {string|null} the key, or null when there is no usable path
 */
export function canonicalWorkspaceKey(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return null;
  return normalizePathForCompare(path.resolve(cwd));
}

/**
 * Validate one stored binding at the boundary and return it in a known shape,
 * or null.
 *
 * A config file is a file: it can be hand-edited, half-written, or produced by
 * an older version. Anything that does not typecheck becomes null — "there is
 * no binding here" — rather than a half-formed object that later code would
 * have to keep re-checking. Same rule as the `list_vaults` response validator:
 * a contract is only a contract if malformed input cannot cross it.
 *
 * `also` is normalised to an array of non-empty strings, deduplicated, and
 * never contains the primary vault (which would make "one or several"
 * ambiguous for the briefing).
 *
 * @param {unknown} raw
 * @returns {{ vault: string, also: string[], locked: boolean, confirmedAt: string|null, confirmedVia: string|null }|null}
 */
export function normalizeBinding(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const vault = raw.vault;
  if (typeof vault !== 'string' || vault.trim() === '') return null;

  const seen = new Set([vault]);
  const also = [];
  if (Array.isArray(raw.also)) {
    for (const entry of raw.also) {
      if (typeof entry !== 'string' || entry.trim() === '') continue;
      if (seen.has(entry)) continue;
      seen.add(entry);
      also.push(entry);
    }
  }

  // THE WRITE TIER OF EACH SECONDARY, recorded on the binding itself (decision
  // portee-et-mode-ecriture-des-vaults §2, applied per WORKSPACE — Roland's
  // own words on 2026-09-05: "dans ce workspace, pour chacun d'entre eux je te
  // demanderai…"). Two lists, both subsets of `also`: a name outside `also`
  // has no role to qualify and is dropped; a name in BOTH is locked — the
  // hard tier wins a conflict, exactly as it does for the global lists.
  // Neither list means "soft", the default: a secondary in neither is
  // read-only with a per-write override on the user's say-so.
  const alsoSet = new Set(also);
  const tierList = (value) => {
    const out = [];
    if (!Array.isArray(value)) return out;
    for (const entry of value) {
      if (typeof entry !== 'string' || !alsoSet.has(entry) || out.includes(entry)) continue;
      out.push(entry);
    }
    return out;
  };
  const alsoLocked = tierList(raw.alsoLocked);
  const alsoWritable = tierList(raw.alsoWritable).filter((n) => !alsoLocked.includes(n));

  return {
    vault,
    also,
    locked: raw.locked === true,
    confirmedAt: typeof raw.confirmedAt === 'string' && raw.confirmedAt ? raw.confirmedAt : null,
    confirmedVia: typeof raw.confirmedVia === 'string' && raw.confirmedVia ? raw.confirmedVia : null,
    alsoLocked,
    alsoWritable,
  };
}

/**
 * The confirmed binding for `cwd`, or null when this workspace has none.
 *
 * Presence IS confirmation: a binding only reaches the registry through an act
 * of the user (the confirmation tool, or `--attach`, which is itself an
 * explicit command). There is no "pending" state stored here — a hint that has
 * not been confirmed simply leaves no trace in the registry, which is what
 * makes "no binding" mean "all vaults" without ambiguity.
 *
 * @param {object} config the parsed router config
 * @param {string} cwd
 * @returns {{ vault: string, also: string[], locked: boolean, confirmedAt: string|null, confirmedVia: string|null }|null}
 */
export function readBinding(config, cwd) {
  const key = canonicalWorkspaceKey(cwd);
  if (!key) return null;
  const all = config?.[WORKSPACE_BINDINGS_KEY];
  if (!all || typeof all !== 'object' || Array.isArray(all)) return null;

  // The stored keys were canonicalised when written, but a hand-edited config
  // may hold a raw path. Canonicalise BOTH sides before comparing rather than
  // trusting the file's spelling — the same reason the vault registry compares
  // normalised paths instead of raw ones.
  if (Object.hasOwn(all, key)) return normalizeBinding(all[key]);

  // AMBIGUITY IS RESOLVED DETERMINISTICALLY, not by whichever spelling the
  // file happens to list first. A hand-edited config can hold the same
  // directory twice under two non-canonical spellings — `C:\WORK\Repo\` and
  // `c:/work/repo` — and the earlier version returned the first match in
  // object order, so re-saving the file with its keys in a different order
  // silently changed which vault the workspace was bound to. Found by the
  // Codex review, 2026-09-03.
  //
  // Sorting the colliding spellings makes the answer a function of the config
  // alone. It does not make the answer RIGHT — nothing can, the file is
  // genuinely ambiguous — but a stable wrong answer is one the user can see
  // and correct, where an unstable one looks like the router changing its mind.
  // The ambiguity also self-heals: the next `withBinding` collapses every
  // colliding spelling into the canonical key.
  const colliding = Object.keys(all)
    .filter((storedKey) => canonicalWorkspaceKey(storedKey) === key)
    .sort();
  return colliding.length ? normalizeBinding(all[colliding[0]]) : null;
}

/**
 * Every vault this workspace is bound to — the primary first, then the
 * secondaries. Empty when there is no binding, which the caller reads as "all
 * vaults", never as "no vault".
 *
 * Every PRODUCTION writer of `registry.workspaceBinding` sets it from
 * `normalizeBinding()`'s output, where `also` is always a real array — but
 * `registry.workspaceBinding` is documented (helpers/vault-reach.mjs) as read
 * live rather than trusted as a fixed shape, and a caller reaching for "which
 * vaults is this workspace bound to" may hand this a binding assembled by
 * hand (a test double, a future defensive code path) rather than one that
 * went through `normalizeBinding`. Guarding `also` here — the one place this
 * question is answered — means every caller inherits the guard instead of
 * each re-deriving it, or worse, assuming it and finding out via a spread of
 * `undefined`.
 *
 * @param {{ vault: string, also: string[] }|null} binding
 * @returns {string[]}
 */
export function boundVaults(binding) {
  if (!binding) return [];
  const also = Array.isArray(binding.also) ? binding.also : [];
  return [binding.vault, ...also];
}

/**
 * How this workspace's dotenv hint stands against the registry.
 *
 * The hint is NEVER applied by this module and never returned as a resolution:
 * classifying it is the whole job. The caller signals it — `list_vaults` in a
 * separate field, the briefing in a sentence — and resolves the vault from the
 * binding or from the cascade, never from here. A value that was refused is
 * not the source of what replaced it; that lesson is v0.89.0's, and it applies
 * unchanged one setting over.
 *
 * `origin` says WHERE the proposal came from, in the vocabulary of
 * `ENV_ORIGINS` — `workspace-dotenv` for this project's own file, `host` for
 * the MCP host's server declaration or the shell that launched the router.
 * Carried through rather than assumed, because the two read identically once
 * they are in `process.env` and the difference is the whole subject: telling a
 * user "your project's .env proposes X" when their own MCP host set it is a
 * false accusation against a file that is innocent, and it points them at the
 * wrong place to change it.
 *
 * TWO REFUSALS, TWO ROLES (decision `refus-d-une-proposition-de-liaison`):
 *
 *   - `isRefused` answers from the user's own config — the AUTHORITY. A hint
 *     naming a refused vault is `refused`: silence, the question was answered.
 *   - `fileRefusal` is what the workspace file itself says was refused here
 *     before (`OBSIDIAN_ROUTER_REFUSED_VAULT`) — a portable HINT. It changes
 *     no status. It sets `previouslyRefused`, which the briefing turns into
 *     "a refusal of this was recorded here before": the reinstall case, where
 *     the config is gone and the file is the only memory left, so the
 *     question is asked once more WITH that context rather than as if nothing
 *     had happened. A cloned repository carrying that line can therefore
 *     silence nobody; at worst it makes a question be asked, once.
 *
 * The binding in force outranks both (trap 5): a hint naming the vault the
 * workspace is bound to is `confirmed` whatever any refusal says — otherwise
 * the briefing would call refused the very binding it had just announced.
 *
 * @param {{
 *   hint: string|null|undefined,
 *   binding: object|null,
 *   isRegistered: (name: string) => boolean,
 *   origin?: string|null,
 *   isRefused?: ((name: string) => boolean)|null,
 *   fileRefusal?: string|null,
 * }} opts
 * @returns {{ status: string, hint: string|null, boundTo: string|null, origin: string|null, previouslyRefused: boolean }}
 */
export function classifyBindingHint({
  hint, binding, isRegistered, origin = null, isRefused = null, fileRefusal = null, byLock = false,
}) {
  const boundTo = binding?.vault || null;
  const from = typeof origin === 'string' && origin ? origin : null;
  if (typeof hint !== 'string' || hint.trim() === '') {
    return { status: HINT_STATUS.NONE, hint: null, boundTo, origin: null, previouslyRefused: false, byLock: false };
  }
  // A FACT about the file, reported whatever the verdict: the consumers that
  // phrase it only do so for a signalled status, and a reader of `list_vaults`
  // is told what it means.
  const previouslyRefused = typeof fileRefusal === 'string' && fileRefusal !== '' && fileRefusal === hint;
  // WHICH LINE PROPOSED, carried so the consumers can spell an acceptance that
  // matches the proposal. A file proposing through `OBSIDIAN_ROUTER_LOCKED`
  // asks for a LOCKED binding; offering plain `{ vault }` there would hand the
  // user something other than what they said yes to — the sixth v0.90.0 review
  // called that class of sentence out, and the Phase 6 measurement through the
  // real hook found this one.
  const lockLine = byLock === true;
  const verdict = (status) => ({ status, hint, boundTo, origin: from, previouslyRefused, byLock: lockLine });
  const known = typeof isRegistered === 'function' && isRegistered(hint);
  // BOUND IS SATISFIED — primary or secondary — when the machine HAS the
  // vault. A proposal naming a vault the workspace is already bound to has
  // nothing left to ask. A stale binding entry (a secondary in `also` that is
  // no longer registered) is not satisfaction: the first version answered
  // `confirmed` from the binding alone, and the briefing fell silent about a
  // vault whose every resolution fails (Codex, round on 1fad78c).
  if (binding && known && boundVaults(binding).includes(hint)) return verdict(HINT_STATUS.CONFIRMED);
  // A refusal silences a registered vault and an unregistered one alike —
  // refusing is how the unknown-vault notice stops, since there is nothing to
  // register. So it is asked BEFORE the registration check.
  if (typeof isRefused === 'function' && isRefused(hint) === true) return verdict(HINT_STATUS.REFUSED);
  // `conflicts` is documented as "a DIFFERENT registered vault": a hint the
  // machine does not have is `unknown-vault` whether or not a binding exists —
  // otherwise the briefing told a bound workspace that "the binding wins" over
  // a vault that does not exist, and never that it does not exist.
  if (!known) return verdict(HINT_STATUS.UNKNOWN_VAULT);
  return verdict(binding ? HINT_STATUS.CONFLICTS : HINT_STATUS.UNCONFIRMED);
}

/**
 * The vaults this workspace REFUSED, from the user's own config: vault name →
 * the date it was refused, or null when a hand edit left none. A Map rather
 * than an object, so a vault called `constructor` or `__proto__` is a name and
 * nothing else.
 *
 * Every stored spelling that canonicalises to this workspace counts — the
 * UNION, where `readBinding` has to pick one: two refusals cannot contradict
 * each other, and dropping one because the file spells the directory twice
 * would re-ask a question the user had answered.
 *
 * @param {object} config
 * @param {string} cwd
 * @returns {Map<string, string|null>}
 */
export function readRefusals(config, cwd) {
  const out = new Map();
  const key = canonicalWorkspaceKey(cwd);
  if (!key) return out;
  const all = config?.[WORKSPACE_REFUSALS_KEY];
  if (!all || typeof all !== 'object' || Array.isArray(all)) return out;
  const spellings = Object.keys(all).filter((stored) => canonicalWorkspaceKey(stored) === key).sort();
  for (const spelling of spellings) {
    const entry = all[spelling];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    for (const [name, at] of Object.entries(entry)) {
      if (typeof name !== 'string' || name.trim() === '' || out.has(name)) continue;
      out.set(name, typeof at === 'string' && at ? at : null);
    }
  }
  return out;
}

/**
 * Every top-level entry of `workspaceRefusals` EXCEPT this workspace's, in a
 * fresh object — the two transforms below rebuild this workspace's entry from
 * the Map `readRefusals` returns, so the colliding spellings a hand edit can
 * leave behind collapse into the canonical key on the first write.
 */
function refusalsOfOtherWorkspaces(base, key) {
  const existing = base[WORKSPACE_REFUSALS_KEY];
  const all = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {};
  for (const stored of Object.keys(all)) {
    if (canonicalWorkspaceKey(stored) === key) delete all[stored];
  }
  return all;
}

/**
 * A NEW config recording that `cwd` refused the vault `vault`. Pure, and the
 * same identity rule as `withBinding`: a vault already refused changes nothing
 * and the input object comes back, so the writer skips the file.
 *
 * `Object.fromEntries` and not an object literal with a computed key: for a
 * vault named `__proto__` the literal would set the prototype instead of a
 * property, and the refusal would be written nowhere.
 *
 * @param {object} config
 * @param {string} cwd
 * @param {string} vault
 * @param {{ at?: string }} [opts]
 * @returns {object}
 */
export function withRefusal(config, cwd, vault, { at } = {}) {
  const key = canonicalWorkspaceKey(cwd);
  const base = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  if (!key || typeof vault !== 'string' || vault.trim() === '') return base;
  const current = readRefusals(base, cwd);
  if (current.has(vault)) return base;
  current.set(vault, typeof at === 'string' && at ? at : new Date().toISOString().slice(0, 10));
  const all = refusalsOfOtherWorkspaces(base, key);
  all[key] = Object.fromEntries(current);
  return { ...base, [WORKSPACE_REFUSALS_KEY]: all };
}

/**
 * A NEW config with the refusal of `vault` by `cwd` removed — the way back
 * after a refusal, and what binding that vault does on the way through. Pure;
 * identity when there was nothing to remove. An emptied entry goes away
 * rather than lingering as `{}`, and so does the top-level key.
 *
 * @param {object} config
 * @param {string} cwd
 * @param {string} vault
 * @returns {object}
 */
export function withoutRefusal(config, cwd, vault) {
  const key = canonicalWorkspaceKey(cwd);
  const base = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  if (!key || typeof vault !== 'string') return base;
  const current = readRefusals(base, cwd);
  if (!current.has(vault)) return base;
  current.delete(vault);
  const all = refusalsOfOtherWorkspaces(base, key);
  if (current.size) all[key] = Object.fromEntries(current);
  const next = { ...base };
  if (Object.keys(all).length) next[WORKSPACE_REFUSALS_KEY] = all;
  else delete next[WORKSPACE_REFUSALS_KEY];
  return next;
}

/**
 * A NEW config object carrying `binding` for `cwd`. Pure: the input is not
 * mutated, nothing is read from or written to disk.
 *
 * Separated from the write on purpose. The transform is where every rule
 * lives — canonical key, validated shape, the primary never repeated in
 * `also` — and a pure function is the one that can be exhaustively tested
 * without a filesystem. The IO below is then small enough to have no rules of
 * its own to get wrong.
 *
 * @param {object} config
 * @param {string} cwd
 * @param {{ vault: string, also?: string[], locked?: boolean, confirmedVia?: string, confirmedAt?: string }} binding
 * @returns {object} a new config
 */
export function withBinding(config, cwd, binding) {
  const key = canonicalWorkspaceKey(cwd);
  const normalized = normalizeBinding(binding);
  if (!key || !normalized) return config;
  const base = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const existing = base[WORKSPACE_BINDINGS_KEY];
  const all = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {};

  // Drop any entry whose key canonicalises to the same workspace before
  // adding: a hand-edited config could hold the same directory under two
  // spellings, and leaving the stale one would make `readBinding`'s answer
  // depend on object key order.
  for (const storedKey of Object.keys(all)) {
    if (canonicalWorkspaceKey(storedKey) === key) delete all[storedKey];
  }
  all[key] = {
    ...normalized,
    confirmedAt: normalized.confirmedAt || new Date().toISOString().slice(0, 10),
  };
  // WRITING THE SAME BINDING BACK CHANGES NOTHING, and returning the input
  // object says so — which is what `updateConfigBindings` reads to decide
  // whether to touch the file at all. Re-running `lock_vault --persist` on an
  // already-locked workspace rewrote `config.json`, the file holding every
  // vault's API key, for byte-identical content. The same class was found one
  // door away in `withMigrationState` (where it hit EVERY router start), and a
  // repair that reaches only its first site is the defect this repository
  // keeps rediscovering — so all three transforms now share the rule.
  let next = unchangedBindings(base, all) ? base : { ...base, [WORKSPACE_BINDINGS_KEY]: all };
  // BINDING A VAULT ADOPTS IT. A refusal of the primary or of a secondary,
  // recorded for this workspace, is stale the moment the user binds it — and
  // it is dropped HERE, in the one transform every binding writer goes
  // through (the tool, `--attach`, `--link-workspace`, `lock_vault --persist`),
  // rather than in whichever caller remembered. Left in place it would come
  // back to life the day the binding is cleared: a hint the user had since
  // adopted would read `refused`, silently, instead of being proposed again.
  // `withoutRefusal` is identity when there is nothing to drop, so the
  // no-change rule above survives it.
  for (const name of boundVaults(normalized)) next = withoutRefusal(next, cwd, name);
  return next;
}

/**
 * Whether `all` is, key for key, what `base` already holds under
 * `workspaceBindings`. Compared by serialisation because these are small
 * JSON-shaped records built by `normalizeBinding`, whose key order is fixed by
 * that function — so equal content really does serialise equally here.
 *
 * @param {object} base
 * @param {Record<string, object>} all
 * @returns {boolean}
 */
function unchangedBindings(base, all) {
  const existing = base[WORKSPACE_BINDINGS_KEY];
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) return false;
  const before = Object.keys(existing);
  const after = Object.keys(all);
  if (before.length !== after.length) return false;
  for (const k of after) {
    if (!Object.hasOwn(existing, k)) return false;
    // Compared through `normalizeBinding` on BOTH sides, so the question asked
    // is "does this mean the same thing?" and not "is it spelled the same".
    //
    // The consequence, stated because it is a real one: a stored entry
    // carrying a field this module does not know about normalises to the same
    // value, so it counts as unchanged and is LEFT ALONE rather than rewritten
    // without it. That is the conservative direction — a write is not the
    // place to silently discard something a future version, or the user, put
    // there — but it does mean this function never tidies a config it did not
    // have to touch anyway.
    if (JSON.stringify(normalizeBinding(existing[k])) !== JSON.stringify(normalizeBinding(all[k]))) return false;
  }
  return true;
}

/**
 * A NEW config object with no binding for `cwd`. Pure, same reasoning as
 * `withBinding`. Removing a binding returns the workspace to "all vaults".
 *
 * @param {object} config
 * @param {string} cwd
 * @returns {object} a new config
 */
export function withoutBinding(config, cwd) {
  const key = canonicalWorkspaceKey(cwd);
  const base = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const existing = base[WORKSPACE_BINDINGS_KEY];
  if (!key || !existing || typeof existing !== 'object' || Array.isArray(existing)) return base;
  const all = { ...existing };
  let removed = false;
  for (const storedKey of Object.keys(all)) {
    if (canonicalWorkspaceKey(storedKey) === key) { delete all[storedKey]; removed = true; }
  }
  // Same rule as `withBinding` and `withMigrationState`: nothing removed means
  // nothing changed, and the input object comes back so the writer can skip
  // the file entirely. Clearing a workspace that had no binding is a common
  // no-op — the tool says so in words — and it should not rewrite the config.
  if (!removed) return base;
  return { ...base, [WORKSPACE_BINDINGS_KEY]: all };
}

/**
 * Read the router config, apply `transform` to it, and write it back
 * atomically. THE ONE WRITER of `workspaceBindings` on disk — the confirmation
 * tool, `lock_vault --persist` and `--attach` all come through here rather
 * than each doing their own read-modify-write.
 *
 * Two properties that are the whole reason it exists:
 *
 *   - It takes an EXCLUSIVE LOCK around the whole read-modify-write. This is
 *     the part that atomicity does not give you. Two processes can each read
 *     the config, each compute a new one, and each write it atomically — and
 *     the second rename discards the first one's work entirely. Both writes
 *     were atomic; the update was still lost. Since this file holds the vault
 *     registry and every vault's API key, the thing lost can be a key somebody
 *     added a moment ago. Found by the Codex review, 2026-09-03: the earlier
 *     version re-read the file and called that concurrency-safe, which narrows
 *     the window to the gap between two syscalls without closing it.
 *   - It RE-READS the file inside the lock. Another session, `--attach`, or a
 *     hand edit may have touched the config since this process started, and a
 *     read-modify-write over a stale in-memory copy would silently drop it.
 *   - It writes ATOMICALLY. `writeFileSync` truncates and then streams; a
 *     crash between those two moments leaves a real file holding a prefix of
 *     JSON, which is a config that no longer parses — and this file is the one
 *     the router needs in order to start.
 *
 * When the lock cannot be taken it REFUSES rather than proceeding. Writing
 * anyway would be choosing to discard whatever the holder is in the middle of
 * doing, which is precisely the failure the lock exists to prevent — and the
 * three callers all treat a failed binding write as best effort, so a refusal
 * degrades to "the binding was not recorded", never to lost data.
 *
 * @param {string} configPath
 * @param {(config: object) => object} transform
 * @param {{ readFile?: Function, writeFile?: Function, lock?: Function }} [seams]
 * @returns {object} the config as written
 */
export function updateConfigBindings(configPath, transform, { readFile, writeFile, lock } = {}) {
  const read = readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const write = writeFile || ((p, c) => writeFileAtomicSync(p, c));
  const take = lock || (() => acquireLock(lockPathFor(configPath, 'config')));

  const release = take(configPath);
  if (!release) {
    throw new Error(
      `another process is writing the router config at ${configPath} and did not finish in time. `
      + 'Nothing was changed — run the command again.',
    );
  }
  try {
    let config;
    try {
      config = JSON.parse(read(configPath));
    } catch (err) {
      throw new Error(
        `cannot read the router config at ${configPath} (${err.code || err.message}). Nothing was changed.`,
      );
    }
    const next = transform(config);
    // A TRANSFORM THAT CHANGED NOTHING WRITES NOTHING. Every transform in this
    // tree is pure and returns a NEW object when it changes anything, so
    // returning the very object it was handed is an unambiguous "no change" —
    // identity, never deep equality, which would be a second definition of
    // "the same config" and would eventually disagree with the first.
    //
    // It is not only tidiness: `unlock_vaults --persist` on a workspace with
    // no binding used to rewrite the file that holds every vault's API key,
    // for nothing. A write that cannot change the content can still fail, can
    // still lose a concurrent update through the merge above, and still moves
    // the file's mtime — which the one-time import reads.
    if (next !== config) write(configPath, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  } finally {
    release();
  }
}

/**
 * The value of `OBSIDIAN_ROUTER_DEFAULT_VAULT` when it is allowed to DECIDE
 * which vault a session acts on — and `null` when it may only PROPOSE.
 *
 * ---------------------------------------------------------------------------
 * THE ONE GATE, FOR ALL FOUR RESOLVERS
 * ---------------------------------------------------------------------------
 * This is the function that makes the accepted decision true rather than
 * merely documented. Before it, the variable was applied by whoever read it,
 * whatever had set it — so the session-start briefing could truthfully report
 * a hint as `unconfirmed` while that same hint was, in fact, deciding the
 * default vault. Found by the Codex review of 2026-09-03, convergently by both
 * passes: neither half was wrong on its own, and the lie lived only in the gap
 * between them.
 *
 * There are FOUR places in this tree that turn this variable into "the vault I
 * am going to act on": the resolution cascade, `detectVaultContext` (which
 * every workspace-bound hook goes through), `orderedVaultCandidates` in the
 * doc-drift detector, and the vault-link linter. A gate implemented at the
 * first of them and nowhere else would read as closed while three of the four
 * doors stayed open — the class of defect this repository keeps rediscovering.
 * So the gate is here, once, and the four call it.
 *
 * ---------------------------------------------------------------------------
 * WHY IT REFUSES ONLY ON A POSITIVE ANSWER
 * ---------------------------------------------------------------------------
 * `workspace-dotenv` is the only origin refused, and the reasoning is worth
 * spelling out because "refuse unless proven safe" sounds stricter and is
 * wrong here:
 *
 *   - `workspace-dotenv` — the loader positively recorded taking this value
 *     from the project's own file. THE threat: a cloned repository. Refused.
 *   - `host` — the loader ran, and this key was already in the environment.
 *     The user's own MCP declaration, launcher or shell. An authority.
 *   - `runtime` — the value differs from what the file set, so this process
 *     changed it after the fact. An authority.
 *   - `unknown` — the loader never ran, or was asked about a different
 *     environment object. If no workspace file was ever read INTO this
 *     environment, then nothing from a workspace file can be in it: refusing
 *     here would take authority away from a legitimate host value on every
 *     path that does not load a dotenv file, and buy no safety at all.
 *
 * THE LIMIT, STATED RATHER THAN HIDDEN (Codex round 2, 2026-09-03): the gate
 * can only see what THIS loader loaded. If something upstream of the router
 * puts a cloned repository's `.env` into the environment before the router
 * starts — `node --env-file=.env`, a shell that sources it, a launcher that
 * does dotenv for every child — the router receives those values as the
 * HOST's, with origin `host`, and honours them. That is the host's decision
 * to make and the router cannot tell it apart from any other host setting;
 * no in-process check can. What the router can promise is that a workspace
 * file it reads ITSELF never decides, and that is the promise this gate keeps.
 *
 * @param {string} key the environment variable
 * @param {object} [env]
 * @returns {string|null} the value when it may decide, null when it may only propose
 */
export function authoritativeEnvSetting(key, env = process.env) {
  const value = env?.[key];
  if (typeof value !== 'string' || value.trim() === '') return null;
  return envKeyOrigin(key, env) === ENV_ORIGINS.WORKSPACE_DOTENV ? null : value;
}

/** The default vault, when the environment may choose it. See above. */
export function authoritativeDefaultVault(env = process.env) {
  return authoritativeEnvSetting('OBSIDIAN_ROUTER_DEFAULT_VAULT', env);
}

/**
 * `VAULT_PATH`, when it may name the vault a session acts on.
 *
 * THE THIRD GATED SETTING, found by round 2 of the Codex review (2026-09-03):
 * round 1 closed `OBSIDIAN_ROUTER_DEFAULT_VAULT`, and the spec said `VAULT_PATH`
 * was "unchanged — not a project file's hint but the observation that the
 * current directory IS a vault". The reasoning was right and the rule drawn
 * from it was wrong. Tier 2 of the cascade matched `VAULT_PATH` against every
 * registered vault path, so a cloned repository's `.env` could set
 * `VAULT_PATH=<any vault of yours>` and choose the default vault through the
 * door the first gate had just closed. Measured: origin `workspace-dotenv`,
 * applied.
 *
 * The rule that keeps the spec's meaning and closes the hole: from a workspace
 * file, `VAULT_PATH` is honoured ONLY when it names the workspace itself — the
 * directory the file lives in, canonically equal. That is exactly the legitimate
 * case (`setup-vault` writes `VAULT_PATH=<the vault>` into that vault's own
 * `.env`), and it is the one case where the file is stating a fact about its
 * own location rather than pointing somewhere else. From the host, the value is
 * an authority as before.
 *
 * @param {string} cwd the workspace the file was read from
 * @param {object} [env]
 * @returns {string|null}
 */
export function authoritativeVaultPath(cwd, env = process.env) {
  const value = env?.VAULT_PATH;
  if (typeof value !== 'string' || value.trim() === '') return null;
  if (envKeyOrigin('VAULT_PATH', env) !== ENV_ORIGINS.WORKSPACE_DOTENV) return value;
  // From the workspace file: only a statement about the workspace itself.
  const self = canonicalWorkspaceKey(cwd);
  return self && canonicalWorkspaceKey(value) === self ? value : null;
}

/**
 * The single-vault lock, when the environment may impose it.
 *
 * The same gate, for the reason the spec gives in one line: "the lock follows
 * exactly the same rule as the default vault — a hint when it comes from the
 * file, an authority when it comes from the registry or the host".
 *
 * It is worth saying why a LOCK needs the gate at all, since a lock restricts
 * rather than grants and that sounds harmless. It is not: locking the session
 * to a vault is the strongest possible way of choosing which vault every write
 * lands in, because it makes all the others unreachable. A cloned repository
 * able to set it would be choosing the destination of the session's work — the
 * same redirection as the default vault, with no way to override it in the
 * conversation.
 */
export function authoritativeLockedVault(env = process.env) {
  return authoritativeEnvSetting('OBSIDIAN_ROUTER_LOCKED', env);
}

/**
 * The config key holding the one-time import's state.
 *
 * `{ openedAt: <ISO>, imported: [<canonical workspace key>, …] }`
 */
export const MIGRATION_KEY = 'workspaceBindingsMigration';

/** Why the one-time import did, or did not, run for a workspace. */
export const IMPORT_REASON = Object.freeze({
  IMPORTED: 'imported',
  ALREADY_BOUND: 'already-bound',
  ALREADY_CONSIDERED: 'already-considered',
  NO_HINT: 'no-hint',
  NOT_FROM_A_FILE: 'not-from-a-file',
  UNKNOWN_VAULT: 'unknown-vault',
  NEWER_THAN_UPGRADE: 'newer-than-upgrade',
  /**
   * The hint names a vault this workspace REFUSED — in the user's config, or
   * in the very file that carries the hint (the reinstall case: the config is
   * gone, the file still says "refused here before"). Never imported. NOT a
   * closing reason: a refusal can be retracted, and the file can change.
   */
  REFUSED: 'refused',
});

/**
 * The reasons that CLOSE the window for a workspace for good — the ones after
 * which the router must never look at this workspace's dotenv hint again.
 *
 * `IMPORTED` is the obvious one. `ALREADY_BOUND` is the one that was missing,
 * and its absence was a defect with teeth: a workspace that already had a
 * binding at the first start of this version was never recorded as considered,
 * so the day the user CLEARED that binding the next start re-imported the
 * dotenv hint and silently undid the decision. Measured against the real
 * `loadRegistry` on 2026-09-03 (final review): attach → start → clear →
 * restart put the binding back, `confirmedVia: 'migration'`.
 *
 * The other reasons are transient by nature and must stay open: a hint that
 * names a vault this machine does not have yet (`UNKNOWN_VAULT`), a file that
 * carries no hint (`NO_HINT`), a value that came from the host this time
 * (`NOT_FROM_A_FILE`), or a file newer than the upgrade
 * (`NEWER_THAN_UPGRADE`) may each become importable later, and closing on them
 * would turn a passing condition into a permanent verdict.
 */
export const CLOSING_REASONS = Object.freeze([IMPORT_REASON.IMPORTED, IMPORT_REASON.ALREADY_BOUND]);

/**
 * Read the migration state, validated at the boundary like everything else
 * that comes out of a hand-editable file.
 *
 * @param {object} config
 * @returns {{ openedAt: string|null, imported: Set<string> }}
 */
export function readMigrationState(config) {
  const raw = config?.[MIGRATION_KEY];
  const ok = raw && typeof raw === 'object' && !Array.isArray(raw);
  const openedAt = ok && typeof raw.openedAt === 'string' && raw.openedAt ? raw.openedAt : null;
  const imported = new Set(
    ok && Array.isArray(raw.imported)
      ? raw.imported.filter((k) => typeof k === 'string' && k).map((k) => canonicalWorkspaceKey(k)).filter(Boolean)
      : [],
  );
  return { openedAt, imported };
}

/**
 * Should this workspace's dotenv hint become a confirmed binding? PURE — every
 * rule of the one-time import lives here, and nothing here touches a disk.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS A MIGRATION AT ALL
 * ---------------------------------------------------------------------------
 * Closing the gate broke every installation in the field at once: a workspace
 * with a dotenv hint and no binding now starts on whatever the cascade falls
 * through to. On a fleet of twenty-three vaults that is the first session of
 * every project going to the wrong place. Roland's arbitration (2026-09-03):
 * import every existing hint once, with a report, and ship it in the SAME
 * release as the gate so no published state ever lies. What makes importing
 * defensible is not trust in the files — it is that a binding imported wrongly
 * ANNOUNCES ITSELF at the top of every session, so it costs one sentence to
 * correct instead of quietly deciding where a year of notes get written.
 *
 * ---------------------------------------------------------------------------
 * WHY IT HAS TO CLOSE, AND HOW IT DOES
 * ---------------------------------------------------------------------------
 * An import that keeps running is not a migration. It is the old behaviour
 * with a delay: a `.env` arriving next month would still decide, which is the
 * exact thing the accepted decision removes. So the window must close, and the
 * hard part is telling a workspace that EXISTED BEFORE THE UPGRADE from one
 * that appeared after — with no marker in the file, as round 1 measured.
 *
 * Two facts close it together:
 *
 *   - `openedAt`, written into the config the first time this version starts.
 *     Everything before that instant predates the upgrade.
 *   - the dotenv file's OWN mtime, which lives on the user's disk and not in
 *     the repository. A `git clone` writes its files NOW, so a freshly cloned
 *     repository's `.env` is always newer than `openedAt` and is never
 *     imported. A workspace the user attached last year is always older.
 *
 * That is the discrimination the "smart migration" of round 1 could not get
 * from inside the repository — and it works precisely BECAUSE cloning rewrites
 * mtimes, the property that made the in-repo markers worthless.
 *
 * The honest limits, stated rather than hidden — and stated in the README and
 * the CHANGELOG too, because "a repository you clone after upgrading is never
 * imported" is the kind of absolute a user plans around:
 *   - A user who edits their own `.env` after upgrading loses the automatic
 *     import for that workspace and confirms once instead. The briefing tells
 *     them how, in the sentence it was already printing.
 *   - Someone who can set mtimes on your disk already has your disk.
 *   - On a router whose very first start ever is on this version, `openedAt`
 *     is now and any `.env` is older — so a repository cloned minutes before
 *     that first start would be imported. It is announced like any other
 *     import, and a first-ever start has nothing else to migrate from.
 *   - `git clone` rewrites mtimes; UNPACKING AN ARCHIVE DOES NOT. `tar x`,
 *     `unzip` with timestamps, the GitHub source zipball and `rsync -a` all
 *     restore the recorded mtime, so a project obtained that way after the
 *     upgrade can carry a `.env` older than `openedAt` and IS imported.
 *     Measured on 2026-09-03 with `utimesSync` against the real
 *     `loadRegistry`, not reasoned about. No in-process check can separate
 *     that file from one written last year — the timestamp is the only signal
 *     the disk carries — which is why the briefing announcing every import is
 *     the thing that has to be relied on, and why the documentation says
 *     "cloned" rather than "obtained".
 *
 * A workspace is recorded in `imported` when the window CLOSES for it — see
 * `CLOSING_REASONS`. That is what makes a later `clear` permanent: without it,
 * the next start would re-import the hint and quietly undo the user's
 * decision. The caller reads `record` rather than inferring it from `import`,
 * because "a binding was created" and "there is nothing left to import here"
 * are not the same question, and treating them as one is what let a cleared
 * binding come back.
 *
 * ---------------------------------------------------------------------------
 * THE LOCK IS MIGRATED TOO, AND FIRST
 * ---------------------------------------------------------------------------
 * `lock_vault --persist` wrote `OBSIDIAN_ROUTER_LOCKED` into the workspace
 * file, and until this release the router applied it at start-up. Closing the
 * gate refuses it — so a user who had persisted a lock, an explicit act,
 * would have lost an isolation boundary in silence on upgrade, with no field
 * anywhere reporting it. An import that carries the default vault but drops
 * the lock is not "nothing in the field breaks".
 *
 * The lock hint is considered FIRST because it decided more: while a lock was
 * in force every call without an explicit vault resolved to the locked vault
 * and every other vault was refused, so a workspace file naming both a lock on
 * B and a default of A was, in practice, a workspace on B alone. Importing
 * `{ vault: B, locked: true }` reproduces exactly what that installation did
 * yesterday; importing A would move a year of notes.
 *
 * @param {{
 *   binding: object|null,
 *   hint: string|null|undefined,
 *   hintOrigin: string|null,
 *   isRegistered: (name: string) => boolean,
 *   dotenvMtimeMs: number|null,
 *   openedAt: string|null,
 *   alreadyImported: boolean,
 *   lockHint?: string|null|undefined,
 *   lockHintOrigin?: string|null,
 *   lockMtimeMs?: number|null,
 * }} input
 * @returns {{ import: boolean, vault: string|null, locked: boolean, reason: string, record: boolean }}
 */
export function migrationDecision({
  binding,
  hint,
  hintOrigin,
  isRegistered,
  dotenvMtimeMs,
  openedAt,
  alreadyImported,
  lockHint = null,
  lockHintOrigin = null,
  lockMtimeMs = null,
  isRefused = null,
}) {
  const no = (reason) => ({
    import: false,
    vault: null,
    locked: false,
    reason,
    record: CLOSING_REASONS.includes(reason),
  });
  if (binding) return no(IMPORT_REASON.ALREADY_BOUND);
  if (alreadyImported) return no(IMPORT_REASON.ALREADY_CONSIDERED);

  const known = (name) => typeof isRegistered === 'function' && isRegistered(name);
  // A REFUSED VAULT IS NEVER IMPORTED, whichever side recorded the refusal.
  // The reinstall scenario of decision `refus-d-une-proposition-de-liaison`
  // is exactly this function's blind spot without it: a fresh config opens
  // the window NOW, every file on disk predates it, and a `.env` that says
  // both "propose X" and "X was refused here" would have X imported as a
  // confirmed binding at the very first start — the router deciding, in
  // silence, the one question the file was asking it to pose.
  const refused = (name) => typeof isRefused === 'function' && isRefused(name) === true;
  const fromFile = (value, origin) => typeof value === 'string' && value.trim() !== ''
    && origin === ENV_ORIGINS.WORKSPACE_DOTENV;

  // A LOCK THIS FILE CARRIED IS DECIDED FIRST AND ALONE. If the workspace file
  // names a lock, that lock is what the installation was actually doing, so
  // either it is imported or NOTHING is — falling back to the default-vault
  // hint would bind the workspace to a vault the old behaviour never used, and
  // then close the window on that wrong answer for good.
  //
  // The case that made this explicit (Codex, round 5): a file naming a lock on
  // B and a default of A, with B not registered *right now* — a vault the user
  // has yet to re-add, or one hidden by `disabledVaults` this week. The first
  // version imported A unlocked and recorded the workspace as considered, so
  // registering B later could never restore the isolation: a TRANSIENT
  // condition turned into a permanent verdict, which is exactly what
  // `CLOSING_REASONS` exists to prevent one level up.
  if (fromFile(lockHint, lockHintOrigin) && refused(lockHint)) {
    return no(IMPORT_REASON.REFUSED);
  }
  if (fromFile(lockHint, lockHintOrigin) && !known(lockHint)) {
    return no(IMPORT_REASON.UNKNOWN_VAULT);
  }

  // A candidate is a value THIS project's file carried, naming a vault this
  // machine has and this workspace has not refused. Only a value the loader
  // took from the file is migrated: a host value already works — it is an
  // authority — so importing it would record a confirmation the user never
  // gave, for no benefit at all.
  const candidate = (value, origin, mtimeMs, locked) => (
    fromFile(value, origin) && known(value) && !refused(value) ? { vault: value, mtimeMs, locked } : null
  );
  const chosen = candidate(lockHint, lockHintOrigin, lockMtimeMs, true)
    || candidate(hint, hintOrigin, dotenvMtimeMs, false);

  if (!chosen) {
    // WHY IT WAS NOT A CANDIDATE, reported from the DEFAULT-vault hint, which
    // is the one every existing caller and message is about. The four
    // failures are distinguished in the order they are checked above —
    // `refused` before `unknown-vault`, because a refusal names a vault
    // whether or not this machine has it, and it is the more useful answer.
    if (typeof hint !== 'string' || hint.trim() === '') return no(IMPORT_REASON.NO_HINT);
    if (hintOrigin !== ENV_ORIGINS.WORKSPACE_DOTENV) return no(IMPORT_REASON.NOT_FROM_A_FILE);
    if (refused(hint)) return no(IMPORT_REASON.REFUSED);
    return no(IMPORT_REASON.UNKNOWN_VAULT);
  }

  // The window. No `openedAt` yet means this start is the one that opens it,
  // and everything already on disk predates it — see the honest limits in the
  // header, which the README and the CHANGELOG now state too.
  //
  // AN UNKNOWABLE AGE FAILS CLOSED. `mtimeMs` is null when the file the loader
  // read has been deleted, renamed or made unreadable since — so the one fact
  // that separates a workspace attached last year from a repository cloned
  // this morning cannot be established. Treating that as "old enough" was the
  // wrong default: it imports on the strength of a measurement that was never
  // taken. The workspace simply keeps its unconfirmed hint, the briefing says
  // so, and one sentence confirms it. (Codex, round 5.)
  if (openedAt) {
    const opened = Date.parse(openedAt);
    if (Number.isFinite(opened) && !Number.isFinite(chosen.mtimeMs)) {
      return no(IMPORT_REASON.NEWER_THAN_UPGRADE);
    }
    if (Number.isFinite(opened) && chosen.mtimeMs >= opened) {
      return no(IMPORT_REASON.NEWER_THAN_UPGRADE);
    }
  }
  return {
    import: true,
    vault: chosen.vault,
    locked: chosen.locked,
    reason: IMPORT_REASON.IMPORTED,
    record: true,
  };
}

/**
 * A NEW config with the migration window opened at `at` if it was not already,
 * and `cwd` recorded as imported when `recordImported` is true. Pure.
 *
 * @param {object} config
 * @param {{ at?: string, cwd?: string|null, recordImported?: boolean }} [opts]
 * @returns {object}
 */
export function withMigrationState(config, { at, cwd = null, recordImported = false } = {}) {
  const base = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const state = readMigrationState(base);
  const openedAt = state.openedAt || at || new Date().toISOString();
  const imported = [...state.imported];
  if (recordImported) {
    const key = canonicalWorkspaceKey(cwd);
    if (key && !imported.includes(key)) imported.push(key);
  }
  // NOTHING TO CHANGE MEANS THE INPUT OBJECT COMES BACK, exactly like the
  // no-op branches of `withBinding` and `withoutBinding` — and that identity is
  // what `updateConfigBindings` reads to decide whether to write at all.
  //
  // Without it this function was the reason a bound workspace rewrote
  // `config.json` on EVERY router start: the migration re-records the window
  // each time, the recording is idempotent in CONTENT, and a fresh object was
  // returned regardless — so the file holding every vault's API key was
  // rewritten, and the inter-process lock taken, once per session for nothing.
  // Measured on 2026-09-03, in the round that introduced it.
  const before = base[MIGRATION_KEY];
  const unchanged = before
    && typeof before === 'object'
    && !Array.isArray(before)
    && before.openedAt === openedAt
    && Array.isArray(before.imported)
    && before.imported.length === imported.length
    && before.imported.every((k, i) => k === imported[i]);
  if (unchanged) return base;
  return { ...base, [MIGRATION_KEY]: { openedAt, imported } };
}

/**
 * Re-classify the live registry's `bindingHint` against the binding it now
 * carries. Call this after ANY in-session change to `registry.workspaceBinding`.
 *
 * WHY IT HAS TO EXIST. `bindingHint` is computed once, at start-up, from the
 * binding that existed then. Every tool that changes the binding used to leave
 * it alone, so after `confirm_workspace_binding({ vault: X })` the very hint
 * that had just been adopted was still reported as `unconfirmed` — measured on
 * 2026-09-03 through the real `list_vaults`, in the same process. Under
 * `--no-watch` nothing ever corrected it, and the tool's own description tells
 * Claude to offer a confirmation whenever the status is `unconfirmed`: the
 * assistant would keep proposing what the user had just accepted. The mirror
 * case is `clear`, after which the status stayed `confirmed` and the proposal
 * went unmentioned.
 *
 * It is here, beside the classifier, rather than in each tool: three call
 * sites already exist and the fourth is the one that would be forgotten.
 *
 * It reads `registry.workspaceRefusals` too — the Map `readRefusals` returns,
 * carried on the registry by `loadRegistry` and replaced by the tool after a
 * refusal or a retraction — so a proposal the user has just refused falls
 * silent in the same session, without a restart.
 *
 * @param {object} registry the live registry, mutated in place
 * @returns {object|null} the hint as re-classified
 */
export function refreshRegistryBindingHint(registry) {
  if (!registry || typeof registry !== 'object') return null;
  const proposal = workspaceBindingProposal();
  registry.bindingHint = classifyBindingHint({
    hint: proposal.hint,
    binding: registry.workspaceBinding || null,
    isRegistered: (name) => (registry.vaults || []).some((v) => v.name === name),
    origin: proposal.origin,
    byLock: proposal.byLock,
    isRefused: (name) => registry.workspaceRefusals instanceof Map && registry.workspaceRefusals.has(name),
    fileRefusal: dotenvRefusalHint(),
  });
  return registry.bindingHint;
}

/**
 * Whether a classified hint is worth telling the user about.
 *
 * `none` and `confirmed` are silence: nothing was turned away, and repeating
 * "your file agrees with your registry" at every start would be the kind of
 * noise that trains people to stop reading start-up messages. `refused` is
 * silence too, and it is the whole point of that status: the user answered,
 * and a question that keeps being asked after its answer is the sound that
 * teaches people to stop listening.
 *
 * THE ONE PLACE the silent/signalled partition of `HINT_STATUS` is written.
 * A test proves it is total — every value on exactly one side — so a seventh
 * status cannot arrive unclassified.
 *
 * @param {{ status: string }} classified
 * @returns {boolean}
 */
export function hintIsWorthSignalling(classified) {
  return classified?.status === HINT_STATUS.UNCONFIRMED
    || classified?.status === HINT_STATUS.UNKNOWN_VAULT
    || classified?.status === HINT_STATUS.CONFLICTS;
}
