/**
 * auto-enrich-mode.mjs — the four auto-enrichment modes, and the ONE function
 * that turns what somebody wrote into one of them.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ITS OWN FILE
 * ---------------------------------------------------------------------------
 * The vocabulary used to live in `src/tools/auto-enrich.mjs`, beside the tool
 * that changes the mode, which was the right place while only the server read
 * it. It stopped being the right place when `workspace-dotenv.mjs` had to
 * decide whether a value carried by a workspace file canonicalises to
 * `FullAuto` — the accepted option 4 of the decision
 * `liaison-workspace-vault-hors-depot`, which forbids that one value from that
 * one source.
 *
 * Two constraints made a shared module the only honest answer:
 *
 *   - `workspace-dotenv.mjs` runs BEFORE anything else. The binary imports it
 *     before `ensureDependencies()` has had a chance to repair the install, so
 *     it may not reach for a module that pulls in npm dependencies — and
 *     `auto-enrich.mjs` imports two helpers of its own. This file imports
 *     nothing at all, so importing it costs nothing and can fail nowhere.
 *   - The alias table is the AUTHORITY on what `FullAuto` is spelled like.
 *     `auto`, `full`, `full-auto`, `fullauto`, `FULLAUTO` all mean it. A rule
 *     that compares raw strings would refuse `FullAuto` and let `auto`
 *     through, which is worse than no rule at all — it would read as closed.
 *     A COPY of the table in the policy module would drift the first time an
 *     alias was added to one and not the other, so there is exactly one.
 *
 * Node builtins only — in fact, no imports at all. Keep it that way: the
 * module sits on the start-up path of the binary and of every hook.
 */

/**
 * The canonical spellings. The stored form of a mode is always one of these
 * four, whatever the caller wrote.
 *
 *   - "ClaudeAsk" — Claude proposes, the user confirms every save (default)
 *   - "Hybrid"    — auto-save the type-safe items, ask on the high-stakes ones
 *   - "FullAuto"  — auto-save everything (audit log + sensitivity filter + cap)
 *   - "off"       — no auto-suggestions at all
 *
 * Frozen: this is a vocabulary, not a working array. A caller that needs to
 * add to it is adding a mode, which is a change to be made here.
 */
export const VALID_MODES = Object.freeze(['ClaudeAsk', 'Hybrid', 'FullAuto', 'off']);

/**
 * The natural-language synonyms, deliberately few — a large alias table turns
 * a typo into a mode change. Kept exported because it is the authority two
 * modules and their tests need to enumerate: a rule about `FullAuto` has to
 * be provable against EVERY spelling of it, and reading them off this table
 * is the only way to keep that proof honest when a synonym is added.
 *
 * Keys are lowercase; `canonicalizeMode` lowercases its input first.
 */
export const MODE_ALIASES = Object.freeze({
  ask: 'ClaudeAsk',
  'ask-mode': 'ClaudeAsk',
  'claude-ask': 'ClaudeAsk',
  auto: 'FullAuto',
  full: 'FullAuto',
  'full-auto': 'FullAuto',
  fullauto: 'FullAuto',
  semi: 'Hybrid',
  'semi-auto': 'Hybrid',
  hybride: 'Hybrid',
  none: 'off',
  disabled: 'off',
  disable: 'off',
});

/**
 * Canonicalize a mode string. Returns the canonical spelling (one of
 * VALID_MODES) when the input is recognized, null otherwise. Accepts any
 * case, and the handful of synonyms above.
 *
 * @param {unknown} input
 * @returns {'ClaudeAsk'|'Hybrid'|'FullAuto'|'off'|null}
 */
export function canonicalizeMode(input) {
  if (!input || typeof input !== 'string') return null;
  const lower = input.trim().toLowerCase();
  // Direct case-insensitive match on a canonical spelling.
  for (const m of VALID_MODES) {
    if (m.toLowerCase() === lower) return m;
  }
  // Own property only: an input of "constructor" or "toString" must not walk
  // the prototype chain and come back as a function that then reads as a
  // recognized mode.
  return Object.hasOwn(MODE_ALIASES, lower) ? MODE_ALIASES[lower] : null;
}

/**
 * Every spelling that canonicalises to `mode`, canonical form included, in a
 * stable order. Written for the TESTS — no message calls it — because a rule
 * about "every spelling of FullAuto" is only provable if the spellings can be
 * enumerated FROM the table rather than hand-listed beside it, where a new
 * alias would be added to one and not the other.
 *
 * Case is not enumerated: `canonicalizeMode` lowercases first, so a test that
 * wants `FULLAUTO` builds it from these.
 *
 * @param {string} mode a canonical mode
 * @returns {string[]}
 */
export function spellingsOf(mode) {
  const canonical = canonicalizeMode(mode);
  if (!canonical) return [];
  return [canonical, ...Object.keys(MODE_ALIASES).filter((a) => MODE_ALIASES[a] === canonical)];
}
