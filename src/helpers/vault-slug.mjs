/**
 * vault-slug.mjs — what the router config says about a vault, type-checked
 * once, where the config's word becomes the program's.
 *
 * It began as the answer to one question — "what is this vault's slug?" — and
 * the name is from then. The remit is now every hand-editable `config.json`
 * value that names or locates a vault: `vaultNames`, `portRegistry`,
 * `defaultVault`, `disabledVaults`, `referenceVault`, `vaultsRoot`. They are
 * one class, they failed the same way, and splitting them across two modules
 * would recreate the duplication this file exists to end. See "The config's
 * OTHER answers about vaults" near the bottom for why they landed here rather
 * than in a sibling.
 *
 * ---------------------------------------------------------------------------
 * THE HOLE THIS CLOSES
 * ---------------------------------------------------------------------------
 * `config.json` maps a vault path to a display name:
 *
 *   "vaultNames": { "C:/VAULTS/Notes": "notes" }
 *
 * That file is hand-editable and hand-edited. Nothing between the text editor
 * and the reader checks that the VALUE is a string: `{"C:/VAULTS/Notes": 123}`
 * is perfectly good JSON, parses without a murmur, and only announces itself
 * much later — at the first reader that calls a string method on it.
 *
 * Before this module there were 22 such readers across 9 files, each having
 * re-derived the same expression by hand:
 *
 *   (vaultNames[vp] || defaultNameFromPath(vp)).toLowerCase()
 *
 * Nine of them threw a TypeError on the number — including three inside
 * `hooks/_helpers/doc-drift-detector.mjs` and one inside
 * `hooks/_helpers/workspace-vault.mjs`, which is how a mistyped config broke a
 * hook's always-exit-0 promise. The other twelve did not throw, which is the
 * worse half: they passed the number on as if it were a vault name, and one of
 * them (`scripts/setup-vault.mjs`, the `--link-workspace` tail) wrote it into a
 * workspace `.env` where the next session would read it back and resolve
 * nothing.
 *
 * Twenty-two guards would have been the wrong repair — the twenty-third site
 * gets written next month and is a guard short. The type is checked ONCE, here,
 * at the boundary where the config's word becomes the program's, and every
 * reader goes through this module. `tests/vault-slug.test.mjs` scans the tree
 * and fails if a direct `vaultNames[...]` read reappears anywhere else, so the
 * twenty-third site cannot be added quietly.
 *
 * ---------------------------------------------------------------------------
 * WHAT A BAD VALUE DOES
 * ---------------------------------------------------------------------------
 * It is IGNORED, and the slug falls back to the path — exactly as if the key
 * had never been written. Not a throw (a hook must exit 0 whatever the config
 * says), and not a `String()` coercion either: coercion would turn a typo'd
 * `123` into a real, resolvable vault name that can collide with or shadow a
 * neighbouring vault, which moves the failure somewhere harder to see rather
 * than removing it. "Unreadable override" and "no override" are the same
 * situation, and the config already treats other junk this way — `asPort` in
 * `src/registry.mjs` and `normalizePortEntry` in `helpers/port-registry.mjs`
 * both drop a value they cannot read and fall back.
 *
 * An EMPTY string is a bad value too. Twenty-one of the twenty-two readers used
 * `||`, so `""` already fell through to the path everywhere but
 * `scripts/meta-audit-bridge-readiness.mjs`, which used `??` and would have
 * labelled the vault with the empty string. This module makes that uniform.
 *
 * The bad value is not printed. That is deliberate: `22b62c4` (accepted option
 * 4 of the decision `liaison-workspace-vault-hors-depot`) had to repair three
 * start-up warnings that echoed an untrusted value raw, and a hook's stderr is
 * the text Claude reads when the hook blocks. There is nothing to say here that
 * the fallback does not already say by working.
 *
 * ---------------------------------------------------------------------------
 * CASE IS PRESERVED ON THE OVERRIDE, NEVER ON THE FALLBACK
 * ---------------------------------------------------------------------------
 * `defaultNameFromPath` lowercases, because it invents the name and has to
 * invent it identically for every reader. A CONFIGURED name is returned
 * verbatim: the real fleet carries `DEDIBOX` in `vaultNames`, and
 * `scripts/gen-remote-config.mjs` prints that name and matches it
 * case-insensitively itself. A reader that compares slugs lowercases the RESULT
 * of `vaultSlug()` — which is now guaranteed to be a string, so that call is
 * finally safe.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SIX COPIES OF defaultNameFromPath COLLAPSED INTO THIS ONE
 * ---------------------------------------------------------------------------
 * There were six, in `src/registry.mjs`, `scripts/setup-vault.mjs`,
 * `scripts/vault-plan.mjs`, `scripts/gen-remote-config.mjs`,
 * `hooks/vault-link-linter.mjs` and `hooks/_helpers/workspace-vault.mjs`. Three
 * of them carried a TODO asking for this module; the three TODOs disagreed
 * about how many copies there were (they said 3, 3 and 4), which is the usual
 * sign that the count had stopped being checked.
 *
 * The stated reason for duplicating — "setup-vault.mjs is intentionally a
 * standalone script with no src/ imports" — had expired: that file imports
 * eight `src/helpers/` modules today. The copies were identical on strings;
 * two of them (registry's, via `isWindowsPath`, and workspace-vault's) also
 * survived a non-string. This one keeps the surviving behaviour, so collapsing
 * them removed a crash rather than introducing one.
 *
 * Node builtins only, and one local import that is itself `node:path`-only.
 * This module sits on the start-up path of the binary AND of every hook, and
 * the hooks are expected to run on a checkout with no `node_modules` at all.
 * Keep it that way — same contract as `helpers/auto-enrich-mode.mjs`.
 */

import path from 'node:path';
import { isWindowsPath } from './vault-path-identity.mjs';

/**
 * The slug a vault gets when the config names no other: the basename of its
 * path, leading dot stripped (`.template` → `template`), lowercased.
 *
 * Windows-path detection is structural rather than platform-based, because
 * `portRegistry` stores Windows paths verbatim and a CI runner on Linux
 * loading that config must still treat `\` as a separator. See
 * `helpers/vault-path-identity.mjs`.
 *
 * Returns `''` for anything that is not a non-empty string. The registry's
 * former copy would have thrown there (`path.posix.basename(123)` is a
 * TypeError); the empty string is the answer that lets a caller keep going.
 *
 * @param {unknown} p
 * @returns {string}
 */
export function defaultNameFromPath(p) {
  if (!p || typeof p !== 'string') return '';
  const base = (isWindowsPath(p) ? path.win32 : path.posix).basename(p);
  return base.replace(/^\./, '').toLowerCase();
}

/**
 * The config's `vaultNames` map, or null when it is missing or is not a plain
 * object.
 *
 * The shape is checked, not just the values: `"vaultNames": "notes"` and
 * `"vaultNames": ["notes"]` are both parseable JSON that a `cfg.vaultNames ||
 * {}` would have accepted and then indexed with a path — reading `undefined`
 * from a string, or worse a real `Array.prototype` member. An array is refused
 * outright because its keys are indices and could never match a vault path.
 *
 * @param {unknown} cfg
 * @returns {Record<string, unknown>|null}
 */
export function vaultNamesOf(cfg) {
  if (!cfg || typeof cfg !== 'object') return null;
  const names = cfg.vaultNames;
  if (!names || typeof names !== 'object' || Array.isArray(names)) return null;
  return names;
}

/**
 * The name the config configures for this vault path — validated — or null
 * when it configures none.
 *
 * Null means "no usable override", and covers four situations a caller has no
 * reason to tell apart: no `vaultNames` map, no entry for this path, an entry
 * that is not a string, and an entry that is the empty string.
 *
 * `Object.hasOwn` rather than a plain lookup: a bare `{}` from `JSON.parse`
 * still carries `Object.prototype`, so an unguarded read for a path spelled
 * `constructor` or `toString` comes back with a function, and `typeof fn ===
 * 'function'` would have failed the string test one step too late to be
 * obvious. Same guard, and the same reason, as `MODE_ALIASES` in
 * `helpers/auto-enrich-mode.mjs`.
 *
 * Case is preserved and the value is NOT trimmed — see the module header.
 *
 * @param {unknown} cfg the parsed router config
 * @param {unknown} vaultPath the registry key to look up
 * @returns {string|null}
 */
export function configuredVaultName(cfg, vaultPath) {
  const names = vaultNamesOf(cfg);
  if (!names || typeof vaultPath !== 'string') return null;
  if (!Object.hasOwn(names, vaultPath)) return null;
  const value = names[vaultPath];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * THE question this module exists to answer: the slug this vault is known by
 * under this config — the configured name when there is a usable one, the
 * path-derived default otherwise.
 *
 * Always a string, so the `.toLowerCase()` that nearly every caller applies to
 * the result cannot throw.
 *
 * @param {unknown} cfg the parsed router config
 * @param {unknown} vaultPath the registry key
 * @returns {string}
 */
export function vaultSlug(cfg, vaultPath) {
  const configured = configuredVaultName(cfg, vaultPath);
  return configured === null ? defaultNameFromPath(vaultPath) : configured;
}

/**
 * Slug → absolute vault path, or null when no registered vault answers to it.
 *
 * Case-insensitive on both sides (NTFS and SMB are, and the slugs are things
 * people type). The input is trimmed; a blank slug matches nothing rather than
 * matching the first vault whose name happens to be empty.
 *
 * This replaces four hand-written copies of the same loop — in
 * `hooks/_helpers/workspace-vault.mjs` (`resolveVaultBySlug`),
 * `scripts/setup-vault.mjs` (`resolveSlugToVaultPath`, plus an inline copy in
 * the standalone `--link-workspace` handler) and
 * `scripts/backfill-log-from-sessions.mjs`. They differed only in which
 * guards they had bothered to write; this one has the union of them.
 *
 * @param {unknown} cfg the parsed router config
 * @param {unknown} slug
 * @returns {string|null}
 */
export function resolveVaultBySlug(cfg, slug) {
  if (!cfg || !slug) return null;
  const target = String(slug).trim().toLowerCase();
  if (!target) return null;
  for (const vaultPath of registeredVaultPaths(cfg)) {
    if (vaultSlug(cfg, vaultPath).toLowerCase() === target) return vaultPath;
  }
  return null;
}

/**
 * The registry keys, in config order — the set of vaults every resolver above
 * iterates. Its own function because `cfg.portRegistry` deserves the same
 * shape check as `vaultNames`: an array or a string there would otherwise be
 * enumerated by `Object.keys` into indices or nothing.
 *
 * @param {unknown} cfg
 * @returns {string[]}
 */
export function registeredVaultPaths(cfg) {
  if (!cfg || typeof cfg !== 'object') return [];
  const registry = cfg.portRegistry;
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) return [];
  return Object.keys(registry);
}

/**
 * Every slug the config registers, in config order — for "did you mean" error
 * text and for the status listing.
 *
 * @param {unknown} cfg
 * @returns {string[]}
 */
export function knownVaultSlugs(cfg) {
  return registeredVaultPaths(cfg).map((vaultPath) => vaultSlug(cfg, vaultPath));
}

// ---------------------------------------------------------------------------
// The config's OTHER answers about vaults
// ---------------------------------------------------------------------------
//
// `vaultNames` was the first key of this class to be swept, not the only one.
// The three below are read from the same hand-editable file, by the same
// readers, under the same assumption that whatever JSON parsed is the type the
// reader wanted. They are validated here, under the same policy, for the same
// reason — see the module header.
//
// WHY THEY LIVE IN A FILE CALLED vault-slug.mjs. Two of the functions above —
// `vaultNamesOf` and `registeredVaultPaths` — are already config accessors
// rather than slug derivations, so this module's real remit has been "the
// config's word about vaults, type-checked once" since it was written. Naming
// it after the first question it answered was the narrow choice; putting the
// sibling keys in a second module now would recreate, one commit later, the
// exact split whose repair this file is. `referenceVault` and `vaultsRoot` are
// vault paths, so they are in remit; `portStart` is NOT here because it is
// already guarded at its one real reader (`isPort` in helpers/port-registry.mjs)
// and it is not about a vault.

/**
 * The config's `defaultVault` — the slug of the vault to use when nothing else
 * names one — validated, or null when the config names none usable.
 *
 * WHO ACTUALLY NEEDED THIS. Of the eight readers of `defaultVault`, six read
 * `registry.defaultVault`, which is the RESOLVED name: `resolveDefaultVault‑
 * WithSource` only honors a configured default that passed `isActive`, i.e.
 * that equals the `name` of a vault already in the active set — and those names
 * are strings this module produced. So the registry is already a boundary for
 * that key, and everything downstream of it was safe.
 *
 * The exceptions are the readers that never go through the registry: the two
 * HOOKS, which parse `config.json` themselves. One of them,
 * `hooks/_helpers/doc-drift-detector.mjs`, did
 * `(cfg.defaultVault || '').toLowerCase()` — and a non-string is truthy, so
 * `||` never caught it and the `TypeError` came straight out of a hook that
 * two entry points call and that must exit 0 whatever the config says. That is
 * the same failure the `vaultNames` sweep removed, one key over.
 *
 * @param {unknown} cfg
 * @returns {string|null}
 */
export function configuredDefaultVault(cfg) {
  if (!cfg || typeof cfg !== 'object') return null;
  const value = cfg.defaultVault;
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * The config's `disabledVaults`, as an array of usable entries — always an
 * array, never null, so a caller may iterate it without a guard.
 *
 * THE CONTAINER IS THE DANGEROUS PART HERE, not the elements. `disabledVaults`
 * is a LIST, and the likeliest hand-edit by far is to write the single vault
 * you meant as a bare string:
 *
 *   "disabledVaults": "template"        instead of  ["template"]
 *
 * A string is iterable. `new Set("template")` is therefore not an error — it is
 * `{t, e, m, p, l, a}`, a set of CHARACTERS, and a fleet with a one-character
 * vault slug would have that vault silently disabled by a line that named a
 * different one. Measured, not reasoned about. Three of the six readers were
 * exposed: two built a `Set` straight from the value and one called `.map` on
 * it (which throws instead, on everything but an array). The other three
 * already wrote `Array.isArray` by hand — this replaces all six, so the guard
 * is in one place rather than in half the places.
 *
 * ELEMENTS are filtered to non-empty strings rather than coerced. One caller
 * used to write `String(s).toLowerCase()`, which turned a numeric entry `123`
 * into the name `"123"` — and a vault whose folder is named `123` has exactly
 * that slug, so the coercion could disable a real vault on the strength of a
 * typo. Dropping it is the same refusal to coerce the module already applies
 * to `vaultNames`.
 *
 * Entries may be a vault NAME or a PATH, and the two are compared differently
 * by different callers (case-sensitively in `src/registry.mjs`, lowercased in
 * the drift detector). That is deliberately NOT normalised here: this function
 * answers "what did the config actually list", and each caller keeps the
 * comparison it documents.
 *
 * @param {unknown} cfg
 * @returns {string[]}
 */
export function disabledVaultEntries(cfg) {
  if (!cfg || typeof cfg !== 'object') return [];
  const raw = cfg.disabledVaults;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry) => typeof entry === 'string' && entry !== '');
}

/**
 * The config's `referenceVault` — the `.template` vault new vaults are cloned
 * from — validated, or null.
 *
 * The sinks here are path functions, and they are not uniformly forgiving:
 * `fs.existsSync(123)` returns `false` (so the two readers that guard with it
 * fail closed, with their own clear message, and were never at risk), while
 * `path.join(123, …)`, `path.resolve(123)` and `samePath(123, …)` all throw a
 * `TypeError`. Three readers reached the throwing kind — including
 * `buildOnDiskPortMap`, which pushes this value into the list of vaults whose
 * `data.json` it reads, i.e. straight into `path.join`. Measured with a probe
 * rather than assumed, because "it's a path, it'll be fine" is exactly the
 * assumption this class is made of.
 *
 * @param {unknown} cfg
 * @returns {string|null}
 */
export function referenceVaultPath(cfg) {
  if (!cfg || typeof cfg !== 'object') return null;
  const value = cfg.referenceVault;
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * The config's `vaultsRoot` — a directory under which provisioning a new vault
 * is allowed — validated, or null.
 *
 * Its one reader already sat inside a `try`/`catch`, so this key was never a
 * live defect. It is here anyway: the guard that saved it is a `catch` around
 * `path.resolve`, which silently swallows the difference between "not
 * configured" and "configured wrong", and the scan in
 * `tests/vault-slug.test.mjs` can only be a scan if every reader of the class
 * goes through the same door.
 *
 * @param {unknown} cfg
 * @returns {string|null}
 */
export function vaultsRootPath(cfg) {
  if (!cfg || typeof cfg !== 'object') return null;
  const value = cfg.vaultsRoot;
  return typeof value === 'string' && value !== '' ? value : null;
}
