/**
 * workspace-dotenv.mjs — what a workspace .env file may set in the router's
 * own environment, and the ONE parser the three loaders share.
 *
 * ---------------------------------------------------------------------------
 * THE HOLE THIS CLOSES
 * ---------------------------------------------------------------------------
 * The router, and its hooks (all of them, through two loader sites: the shared
 * hooks/_helpers/workspace-vault.mjs and hooks/vault-link-linter.mjs), load
 * the .env file of the current
 * workspace at start-up so that a project can carry its own default vault,
 * its lock, its auto-enrichment mode. Until v0.87.0 the loaders set ANY key
 * the file named, as long as the parent environment did not already carry
 * it. A workspace is very often a cloned repository, and a cloned repository
 * can carry a .env written by a stranger. What such a file could set:
 *
 *   - GIT_CONFIG_GLOBAL=./x.gitconfig, or HOME / XDG_CONFIG_HOME pointing into
 *     the repository — git then reads a config the attacker wrote, and
 *     `core.fsmonitor` / `gpg.program` run a command at the next commit the
 *     wiki-autocommit hook makes;
 *   - NODE_OPTIONS=--require=./x.js — code at the start of every Node child;
 *   - MARKITDOWN_PATH=./tools/x (and DOCLING_PATH, REPOMIX_PATH, YTDLP_PATH,
 *     PDF_IMAGES_PYTHON) — the router runs the attacker's file directly;
 *   - HF_ENDPOINT, HTTPS_PROXY + a CA bundle — model downloads and plugin
 *     fetches redirected or intercepted;
 *   - and, had the whole OBSIDIAN_ROUTER_* family been accepted:
 *     OBSIDIAN_ROUTER_CONFIG=./evil.json (the router reads the ATTACKER's
 *     vault registry — every tool call, every session journal, every
 *     auto-commit then works against vaults he named, remote ones included),
 *     OBSIDIAN_ROUTER_VIEW_AGENT_URL (a fetch to his host on every write),
 *     OBSIDIAN_ROUTER_SMART_LINK_* (links in chat pointing elsewhere),
 *     OBSIDIAN_ROUTER_USER_ID (a forged audit identity), OBSIDIAN_ROUTER_
 *     ALLOWED_VAULTS / READONLY (denial). Those are settings of the MCP HOST
 *     or of the launcher of a served instance — never of a workspace file.
 *
 * The per-tool allowlist of subprocess-env.mjs filters what a CHILD receives
 * by name; it cannot know where a value came from. This module is the other
 * half: a workspace .env may set ONLY the keys the router documents for a
 * workspace — written out, one by one. Everything else is ignored, and named
 * once (by the router process, on its stderr — the MCP log) with where to
 * set it instead.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS ACCEPTED — exactly what the router's own writers put there
 * ---------------------------------------------------------------------------
 *   - OBSIDIAN_ROUTER_DEFAULT_VAULT — written by `--attach` and by
 *     `setup-vault --link-workspace`;
 *   - OBSIDIAN_ROUTER_LOCKED — written by `lock_vault --persist`;
 *   - OBSIDIAN_ROUTER_AUTO_ENRICH — written by `auto-mode --persist`;
 *   - OBSIDIAN_ROUTER_REFUSED_VAULT — written by
 *     `confirm_workspace_binding({ refuse })`, and only into a file that
 *     itself carried the proposal being refused (decision
 *     `refus-d-une-proposition-de-liaison`, 2026-09-04). A HINT and never an
 *     authority, like the DEFAULT_VAULT line it answers: it silences nobody.
 *     The refusal that silences the question lives in the user's own config
 *     (`workspaceRefusals`); this line is the portable half, which survives
 *     an uninstall of the router and makes the question be asked once more,
 *     with its context, after a reinstall. Read by `classifyBindingHint`
 *     through `dotenvRefusalHint` below;
 *   - VAULT_PATH — written by setup-vault into every bootstrapped vault, read
 *     by the registry to make that vault the default when the cwd is the
 *     vault;
 *   - MD_ALLOWED_PATHS, MD_SHARE_DIR — the conversion tools' read sandbox,
 *     documented as per-project — but only to NARROW it. The two names are
 *     ONE setting, and the file's value is taken only when the parent sets
 *     neither and the instance is not gated (READONLY / ALLOWED_VAULTS /
 *     USER_ID). Otherwise a host that sandboxes through the legacy alias
 *     MD_SHARE_DIR would see a repository's MD_ALLOWED_PATHS=/ replace it,
 *     and a gated instance with no sandbox would start on the file's word
 *     instead of refusing to (index.mjs assertSandboxConsistent);
 *   - the OBSIDIAN_ROUTER_NO_* opt-outs, enumerated below: each one switches
 *     a convenience OFF (a nudge, a journal, a check, an auto-commit) and none
 *     of them switches a security guard off — a test pins the list against
 *     the names the tree actually reads, so a new opt-out is added here on
 *     purpose, never accepted by shape.
 *
 * Two more keys are KNOWN and skipped without a word: OBSIDIAN_API_KEY and
 * OBSIDIAN_BASE_URL. setup-vault writes them into a bootstrapped vault's
 * .env for companion tools; the router itself never reads them, so warning
 * about a file the router wrote would be noise at every start.
 *
 * Parent wins, always: a key already present in the environment is never
 * overwritten by the file — the semantics the three loaders had before.
 *
 * ---------------------------------------------------------------------------
 * AND ONE VALUE THAT IS REFUSED EVEN UNDER AN ACCEPTED KEY
 * ---------------------------------------------------------------------------
 * OBSIDIAN_ROUTER_AUTO_ENRICH stays an accepted key — a project may perfectly
 * well carry its own ClaudeAsk, Hybrid or off. What it may not carry is the
 * value FullAuto, which is the one mode that turns a file travelling with a
 * cloned repository into standing permission to write into one of the user's
 * vaults without asking again. That is accepted option 4 of the decision
 * `liaison-workspace-vault-hors-depot` (Roland, 2026-09-03): the mode keeps
 * its two honest homes — the MCP host's server declaration, and a call to
 * set_auto_enrich_mode during the session — and loses the one nobody signed
 * for.
 *
 * The rule is on the VALUE, not on the key, and it is applied after
 * canonicalisation: auto, full, full-auto, fullauto and FULLAUTO all mean
 * FullAuto, and a rule that compared raw strings would refuse the obvious
 * spelling while letting the others through, which is worse than no rule at
 * all because it would read as closed. The alias table is the authority, and
 * it lives in ONE place — helpers/auto-enrich-mode.mjs, which imports nothing.
 *
 * Node builtins only: bin/obsidian-mcp-router.mjs imports this before any
 * dependency is known to exist. The one local import below is dependency-free
 * for exactly that reason; keep it so.
 */

import fs from 'node:fs';
import path from 'node:path';
import { canonicalizeMode } from './auto-enrich-mode.mjs';

/**
 * The portable half of a refused binding proposal — see the header. Named
 * once here; the classifier, the tool that writes it and the briefing hook
 * all import the name rather than spelling it.
 */
export const REFUSED_VAULT_KEY = 'OBSIDIAN_ROUTER_REFUSED_VAULT';

/** The keys the router's own writers put into a workspace .env, and the two sandbox keys. */
export const WORKSPACE_DOTENV_KEYS = Object.freeze([
  'OBSIDIAN_ROUTER_DEFAULT_VAULT',
  'OBSIDIAN_ROUTER_LOCKED',
  'OBSIDIAN_ROUTER_AUTO_ENRICH',
  REFUSED_VAULT_KEY,
  'VAULT_PATH',
  'MD_ALLOWED_PATHS',
  'MD_SHARE_DIR',
]);

/**
 * The vault THIS WORKSPACE'S FILE says was refused here before, or null.
 *
 * Only ever CONTEXT for the classifier: a value here changes no verdict on
 * its own — the registry's `workspaceRefusals` is what silences a proposal —
 * it makes the briefing say "a refusal of this was recorded here before" when
 * the same vault is proposed again with no answer in the registry (the
 * reinstall case the decision was written for), and it keeps the one-time
 * import from binding that vault.
 *
 * GATED ON PROVENANCE, in two halves that answer two different questions.
 * The first version read the raw environment, so a launcher or shell that
 * happened to export OBSIDIAN_ROUTER_REFUSED_VAULT=notes beside a workspace
 * file proposing `notes` made the import skip that vault and the briefing say
 * the PROJECT FILE had recorded a refusal it never contained — a false claim
 * about a file, which is the exact class `envKeyOrigin` exists to prevent one
 * key over. (Codex, round on b59eb00.)
 *
 *   - Is the value the FILE's? `envKeyOrigin` answers `workspace-dotenv`
 *     only when the loader applied it from a file AND the environment still
 *     holds that value; a value changed since is `runtime`, and this function
 *     must not attribute a runtime value to a file. (The Fable round on
 *     7efbad1 measured exactly that after an in-process mutation, when this
 *     check had been dropped as "redundant" with the next one — it is not:
 *     the next one asks about files, this one about the value.)
 *   - Is it from the SAME file as a proposal it can answer? A refusal line
 *     answers the proposal it stands beside. A workspace file proposes a
 *     vault through TWO lines — `OBSIDIAN_ROUTER_DEFAULT_VAULT`, and
 *     `OBSIDIAN_ROUTER_LOCKED`, which the one-time import decides first —
 *     so either counts. The first version looked at the default line alone,
 *     and a `.env` carrying `LOCKED=notes` + `REFUSED_VAULT=notes` with no
 *     default line had `notes` imported LOCKED after a reinstall (Fable
 *     round on 7efbad1). A host proposal is a different question, so a file
 *     refusal beside a host-only proposal counts for nothing.
 *
 * @param {object} [env]
 * @returns {string|null}
 */
export function dotenvRefusalHint(env = process.env) {
  const value = env?.[REFUSED_VAULT_KEY];
  if (typeof value !== 'string' || value.trim() === '') return null;
  if (envKeyOrigin(REFUSED_VAULT_KEY, env) !== ENV_ORIGINS.WORKSPACE_DOTENV) return null;
  const source = envKeySourceFile(REFUSED_VAULT_KEY, env);
  const proposalFiles = ['OBSIDIAN_ROUTER_DEFAULT_VAULT', 'OBSIDIAN_ROUTER_LOCKED'].map((k) => envKeySourceFile(k, env));
  return source && proposalFiles.includes(source) ? value : null;
}

/**
 * The two spellings of ONE setting — the conversion tools' read sandbox. A
 * workspace file may only narrow it: see applyWorkspaceDotenv.
 */
export const WORKSPACE_DOTENV_SANDBOX_KEYS = Object.freeze(['MD_ALLOWED_PATHS', 'MD_SHARE_DIR']);

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/**
 * The multi-tenant / gated signals of src/index.mjs assertSandboxConsistent,
 * mirrored here because this module runs BEFORE index.mjs is imported and
 * must not import it. Any of them makes the sandbox the host's to set.
 *
 * @param {object} [env]
 * @returns {boolean}
 */
export function isGatedDeployment(env = process.env) {
  const set = (v) => typeof v === 'string' && v.trim() !== '';
  return TRUTHY.has(String(env.OBSIDIAN_ROUTER_READONLY || '').trim().toLowerCase())
    || set(env.OBSIDIAN_ROUTER_ALLOWED_VAULTS)
    || set(env.OBSIDIAN_ROUTER_USER_ID);
}

/**
 * The opt-outs a workspace may carry. Each switches a convenience off; none
 * is a security guard. Pinned by tests/workspace-dotenv.test.mjs against the
 * OBSIDIAN_ROUTER_NO_* names the tree reads: a new one is added here, by hand.
 */
export const WORKSPACE_DOTENV_OPTOUTS = Object.freeze([
  'OBSIDIAN_ROUTER_NO_AUTO_CONFORMANCE',
  'OBSIDIAN_ROUTER_NO_AUTO_INSTALL_HOOKS',
  'OBSIDIAN_ROUTER_NO_DECISIONS_RECALL',
  'OBSIDIAN_ROUTER_NO_DOC_PROPAGATION_CHECK',
  'OBSIDIAN_ROUTER_NO_DOC_STARTUP_CHECK',
  'OBSIDIAN_ROUTER_NO_HOT_CACHE_GUARD',
  'OBSIDIAN_ROUTER_NO_HOT_CACHE_LOAD',
  'OBSIDIAN_ROUTER_NO_LINT_VAULT_LINKS',
  'OBSIDIAN_ROUTER_NO_OKF_PROJECTIONS',
  'OBSIDIAN_ROUTER_NO_SESSION_JOURNAL',
  'OBSIDIAN_ROUTER_NO_UPDATE_CHECK',
  'OBSIDIAN_ROUTER_NO_WATCH',
  'OBSIDIAN_ROUTER_NO_WIKI_AUTOCOMMIT',
  'OBSIDIAN_ROUTER_NO_WIKI_QUERY_FIRST',
]);

/** Written by setup-vault for companion tools; the router does not read them — skipped silently. */
export const WORKSPACE_DOTENV_COMPANION_KEYS = Object.freeze(['OBSIDIAN_API_KEY', 'OBSIDIAN_BASE_URL']);

/**
 * The one value an accepted key may not carry, and why. A table rather than an
 * `if`, so a second refused value is added by name here and inherited by every
 * loader, and so the tests can enumerate what the rule covers.
 *
 * `canonicalize` turns the file's text into the vocabulary the rule speaks;
 * `refused` is compared against its OUTPUT, never against the raw text.
 */
export const WORKSPACE_DOTENV_REFUSED_VALUES = Object.freeze({
  OBSIDIAN_ROUTER_AUTO_ENRICH: Object.freeze({
    refused: 'FullAuto',
    canonicalize: canonicalizeMode,
    why:
      'the most permissive auto-enrichment mode is not taken from a project file — '
      + "set it in the MCP host's server declaration, or call set_auto_enrich_mode during the session",
  }),
});

/**
 * How many ignored KEY names the single warning lists, and how long each may
 * be. Declared HERE, above their first use, rather than at the foot of the
 * file where they used to sit: `safeValueForMessage` below reads
 * WARN_MAX_NAME_LENGTH, and while nothing calls it during module evaluation
 * today, a `const` read before its declaration is a temporal-dead-zone
 * ReferenceError waiting for the first caller that does.
 */
const WARN_MAX_NAMES = 20;
const WARN_MAX_NAME_LENGTH = 64;

/**
 * The alphabet a value from an untrusted file is shown through, and its clip.
 * Same treatment as the ignored KEY names further down: a workspace file must
 * not be able to drive a terminal — or a tool response — through a message
 * about itself. Every legitimate spelling of a mode is letters and hyphens,
 * so nothing readable is lost.
 *
 * @param {string} value
 * @returns {string}
 */
function safeValueForMessage(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]/g, '?').slice(0, WARN_MAX_NAME_LENGTH);
}

/**
 * Whether `value`, read from a workspace file under `key`, is a value that key
 * may not carry from that source.
 *
 * Returns null when the pair is fine — an unlisted key, or a listed key with
 * any other value. Returns a record when it is not: the spelling as written
 * (sanitised for display), what it canonicalises to, and why it is refused.
 *
 * @param {string} key
 * @param {string} value
 * @returns {{ key: string, value: string, canonical: string, reason: string }|null}
 */
export function workspaceDotenvValueRefusal(key, value) {
  const rule = Object.hasOwn(WORKSPACE_DOTENV_REFUSED_VALUES, String(key))
    ? WORKSPACE_DOTENV_REFUSED_VALUES[String(key)]
    : null;
  if (!rule) return null;
  if (rule.canonicalize(value) !== rule.refused) return null;
  return {
    key: String(key),
    value: safeValueForMessage(value),
    canonical: rule.refused,
    // The reason does NOT repeat the assignment: the warning that carries it
    // already leads with `KEY=value refused (canonicalises to …)`, and the
    // first version said the same thing twice with three em-dashes between.
    reason: `not applied from a workspace file — ${rule.why}`,
  };
}

const ACCEPTED = new Set([...WORKSPACE_DOTENV_KEYS, ...WORKSPACE_DOTENV_OPTOUTS]);

/**
 * How one key of a workspace .env is treated.
 *
 * @param {string} key
 * @returns {'apply'|'companion'|'ignore'}
 */
export function classifyWorkspaceDotenvKey(key) {
  const k = String(key);
  if (WORKSPACE_DOTENV_COMPANION_KEYS.includes(k)) return 'companion';
  return ACCEPTED.has(k) ? 'apply' : 'ignore';
}

/**
 * The parser the three loaders used to carry a copy of each: KEY=VALUE lines,
 * # comments, blank lines, an optional `export ` prefix, optional surrounding
 * double or single quotes. A leading byte-order mark (a file re-saved by
 * Notepad) goes with the whitespace, so the first key is read as written
 * rather than as an unknown name. No interpolation, no multi-line values, no
 * escaped quotes — keep it boring.
 *
 * @param {string} text
 * @returns {Array<{key: string, value: string}>}
 */
export function parseDotenv(text) {
  const out = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    // trim() strips U+FEFF with the other whitespace (ECMAScript counts the
    // byte-order mark as WhiteSpace), so a file re-saved by Notepad names its
    // first key as written. A test pins that property.
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      value = value.slice(1, -1);
    }
    out.push({ key, value });
  }
  return out;
}

/** The one-line summary of the policy, for the warning and for docs. */
export const WORKSPACE_DOTENV_POLICY = `${WORKSPACE_DOTENV_KEYS.join(', ')} and the OBSIDIAN_ROUTER_NO_* opt-outs`;

/**
 * What THIS process took from a workspace .env, so a later reader can say
 * WHERE a setting came from instead of applying it without a word — the
 * "provenance" lot of the accepted decision `liaison-workspace-vault-hors-depot`
 * (a cloned repository's file may still pick which REGISTERED vault a session
 * reads, locks and enriches; until the binding moves out of the repository,
 * the least the router can do is name the source).
 *
 * Filled by `applyWorkspaceDotenv` itself rather than by its callers, so any
 * entry point that loads a workspace file records it — the binary, a hook, a
 * test. Per-process and never persisted: it describes THIS run.
 *
 * The entry keeps the environment OBJECT it wrote into, not only the value:
 * this module's public signature takes an `env`, so two calls in one process
 * can target two different objects, and a record made against one of them
 * says nothing about the other. Asked about a different object, the answer is
 * `unknown` rather than a plausible-looking guess.
 *
 * Not keyed by cwd: two loads from two different working directories in one
 * process leave the first one's keys in place. No entry point does that today
 * (the binary loads once, each hook is its own process); if one ever does, the
 * later load overwrites the keys it shares and the rest stay as they were.
 *
 * @type {Map<string, { file: string, value: string, env: object }>}
 */
const APPLIED_FROM_WORKSPACE = new Map();

/**
 * What THIS process REFUSED to take from a workspace file because of its
 * value — the other half of the register above. Kept for the same reason the
 * applied half is kept: so a later reader can say what happened instead of
 * the router silently doing something else.
 *
 * It carries the environment OBJECT it was judged against, exactly like the
 * applied register, and for the same reason: this module's public signature
 * takes an `env`, so a refusal recorded while loading into one object says
 * nothing about another. Asked about a different object, the accessor reports
 * nothing rather than a plausible-looking claim — the identity-before-value
 * rule that v0.88.1 had to restore.
 *
 * Keyed by variable NAME, not by cwd — the same reserve the applied register
 * carries: two loads from two different working directories in one process
 * leave the first one's refusals in place for the keys the second does not
 * name, and the later load overwrites the keys it shares. No entry point does
 * that today (the binary loads once, each hook is its own process).
 *
 * @type {Map<string, { file: string, value: string, canonical: string, reason: string, env: object }>}
 */
const REFUSED_FROM_WORKSPACE = new Map();

/**
 * Whether a workspace file was ever CONSULTED in this process — set once the
 * loader has tried to read one, whether it found it or not.
 *
 * Absence of a record only means "the file did not set this key" if a file was
 * looked for at all. Without this flag, an entry point that never loads one
 * (`startServer` imported directly by a test) would have every variable
 * reported as the host's, which is an assumption, not an observation.
 *
 * PROCESS-WIDE, and deliberately not per-environment-object — the one accessor
 * of this register that is not. The four that answer ABOUT a key
 * (`envKeyOrigin`, `envKeySourceFile`, `appliedWorkspaceDotenvKeys`,
 * `workspaceDotenvRefusals`) all check which environment their record was made
 * against; this one answers a question about the PROCESS ("has a workspace file
 * been looked for at all"), so an `env` parameter would suggest a precision it
 * does not have.
 *
 * THE KNOWN LIMIT, named in full rather than half. `envKeyOrigin` uses this
 * flag as its PRECONDITION while checking record identity per object, so the
 * two halves disagree for one case: after a load against environment A, asking
 * `envKeyOrigin` about a key that is NOT in the register, for environment B,
 * answers `host` — a positive claim about an object no file was ever read
 * into. That is the assumption-dressed-as-fact this flag exists to prevent,
 * surviving in the corner where the flag itself is consulted. It is not
 * reachable in production (every entry point records and asks about
 * `process.env` itself, where consultation and records coincide), and the fix
 * is a per-object consultation set, which changes `envKeyOrigin`'s documented
 * v0.88.0 precondition — a contract change belonging to the provenance lot,
 * not to this one. `tests/workspace-dotenv.test.mjs` pins the behaviour so the
 * limit is measured rather than assumed, and so the day someone fixes it, the
 * pin says what they are changing.
 */
let workspaceFileConsulted = false;

/** Where an environment variable's current value came from, as far as this process can tell. */
export const ENV_ORIGINS = Object.freeze({
  /** applied by this process from the workspace dotenv file */
  WORKSPACE_DOTENV: 'workspace-dotenv',
  /** already in the environment at start-up: the MCP host's server declaration, a launcher, a shell */
  HOST: 'host',
  /** the value changed after the file was read — only this process can have done that */
  RUNTIME: 'runtime',
  /** recorded against a different environment object: this process cannot say */
  UNKNOWN: 'unknown',
});

/**
 * The origin of `key`'s CURRENT value.
 *
 * A key this process applied from a workspace file, whose value is still the
 * one the file carried, is `workspace-dotenv`. A key the file never set — or
 * one whose value the parent already carried, since the parent always wins —
 * is `host`. A key the file set into THIS environment and whose value has
 * changed since is `runtime`: no other process can reach in here. A key
 * recorded against a DIFFERENT environment object is `unknown` — the record
 * describes that object, not this one. And when no workspace file was ever
 * consulted, EVERY answer is `unknown`: "the file did not set it" is only a
 * fact once a file has been looked for.
 *
 * Known and accepted: a value moved away from what the file carried and then
 * back to it reads as `workspace-dotenv` again. That is the file's value, so
 * the answer is defensible; distinguishing it would need a write barrier this
 * module has no way to install.
 *
 * @param {string} key
 * @param {object} [env]
 * @returns {'workspace-dotenv'|'host'|'runtime'|'unknown'}
 */
export function envKeyOrigin(key, env = process.env) {
  if (!workspaceFileConsulted) return ENV_ORIGINS.UNKNOWN;
  const applied = APPLIED_FROM_WORKSPACE.get(String(key));
  if (!applied) return ENV_ORIGINS.HOST;
  // The record describes the object it was written into. Asked about another
  // one, this module cannot say — and must not answer from the value alone.
  if (applied.env !== env) return ENV_ORIGINS.UNKNOWN;
  return env[key] === applied.value ? ENV_ORIGINS.WORKSPACE_DOTENV : ENV_ORIGINS.RUNTIME;
}

/**
 * The workspace file a key came from, or null. For a message that names the
 * file rather than only the fact ("posé par le .env de ce dépôt").
 *
 * Takes an `env` and checks the record's identity against it, exactly like
 * `envKeyOrigin` and `workspaceDotenvRefusals`. THE SAME RULE IN ALL FOUR
 * PLACES, on purpose: v0.88.1 had to restore this check on `envKeyOrigin`
 * after it shipped missing, and a fix that reaches only its first call site is
 * the defect this repository keeps rediscovering. A record made against a
 * different environment object describes that object, so the answer here is
 * null rather than a file name that would be true of somebody else's run.
 *
 * @param {string} key
 * @param {object} [env]
 * @returns {string|null}
 */
export function envKeySourceFile(key, env = process.env) {
  const applied = APPLIED_FROM_WORKSPACE.get(String(key));
  if (!applied || applied.env !== env) return null;
  return applied.file || null;
}

/**
 * The keys this process took from a workspace file INTO `env`, in the order it
 * took them. Same identity rule as the three accessors above.
 *
 * @param {object} [env]
 * @returns {string[]}
 */
export function appliedWorkspaceDotenvKeys(env = process.env) {
  const out = [];
  for (const [key, rec] of APPLIED_FROM_WORKSPACE) {
    if (rec.env === env) out.push(key);
  }
  return out;
}

/** True once a workspace file has been looked for in this process. */
export function workspaceDotenvWasConsulted() {
  return workspaceFileConsulted;
}

/**
 * What a workspace file tried to set into `env` and was refused for its value.
 *
 * Returns the records made against THIS environment object, in the order they
 * were made. A record made against another object is not returned: it
 * describes that object, and answering from it would be the mistake v0.88.1
 * fixed on the applied half of the register. An empty array therefore means
 * "nothing was refused for this environment" — which, like every other answer
 * of this module, is only an observation once a file has actually been looked
 * for. `workspaceDotenvWasConsulted` answers that question for the PROCESS and
 * not for a given object, so it confirms "a file was looked for somewhere",
 * never "a file was looked for into THIS env"; read its docblock before
 * leaning on it.
 *
 * @param {object} [env]
 * @returns {Array<{ key: string, value: string, canonical: string, reason: string, file: string }>}
 */
export function workspaceDotenvRefusals(env = process.env) {
  const out = [];
  for (const [key, rec] of REFUSED_FROM_WORKSPACE) {
    if (rec.env !== env) continue;
    out.push({ key, value: rec.value, canonical: rec.canonical, reason: rec.reason, file: rec.file });
  }
  return out;
}

/** Test seam: forget what was recorded. Never called by the router itself. */
export function _resetWorkspaceDotenvProvenance() {
  APPLIED_FROM_WORKSPACE.clear();
  REFUSED_FROM_WORKSPACE.clear();
  workspaceFileConsulted = false;
}

/**
 * Load `<cwd>/.env` into `env` under the policy above. Never throws: a
 * missing or unreadable file is a silent no-op. Returns what happened so a
 * caller (or a test) can see it; warns ONCE, through `warn`, when the file
 * carried keys the router does not take from a workspace. The router binary
 * keeps the default `warn` (its stderr is the MCP log); the hooks pass a
 * silent one — a hook's stderr is the message Claude reads when it blocks,
 * and a line about a .env in front of the real reason would be read as an
 * instruction.
 *
 * `withheld` names the sandbox keys the file carried but that were not
 * taken, because the host already set the sandbox (either spelling) or runs
 * gated — a workspace file may only narrow an UNSET sandbox, never widen or
 * replace one. Named in the same single warning.
 *
 * `refused` carries the accepted keys whose VALUE a workspace file may not
 * choose (today: OBSIDIAN_ROUTER_AUTO_ENRICH=FullAuto). Unlike the other
 * three, its entries are objects rather than names, because the name alone
 * would not say what happened: the key is fine, the value is not. Named in
 * the same single warning, and remembered for the session so `list_vaults`
 * can show Claude a refusal the operator's stderr already carried.
 *
 * @param {{ cwd: string, env?: object, warn?: (message: string) => void, readFile?: (p: string) => string }} opts
 * @returns {{ applied: string[], ignored: string[], skipped: string[], withheld: string[], refused: Array<{ key: string, value: string, canonical: string, reason: string }> }}
 */
export function applyWorkspaceDotenv({
  cwd,
  env = process.env,
  warn = (message) => { try { process.stderr.write(`${message}\n`); } catch { /* a closed stderr is not our problem */ } },
  readFile = (p) => fs.readFileSync(p, 'utf8'),
} = {}) {
  const result = { applied: [], ignored: [], skipped: [], withheld: [], refused: [] };
  if (!cwd) return result;
  let text;
  try {
    text = readFile(path.join(cwd, '.env'));
    // A file was CONSULTED — from here on, "no record for this key" is an
    // observation ("the file did not set it") rather than an assumption.
    workspaceFileConsulted = true;
  } catch {
    // Missing or unreadable is still a consultation: there is no file to take
    // anything from, so the environment is the host's.
    workspaceFileConsulted = true;
    return result;
  }
  // Judged once, against the PARENT: a sandbox the host set (either
  // spelling) or a gated instance means the file's sandbox keys are withheld.
  // A file that sets both spellings itself, on a host that set none, is the
  // narrowing case and goes through.
  const sandboxIsTheHosts = isGatedDeployment(env) || WORKSPACE_DOTENV_SANDBOX_KEYS.some((k) => k in env);
  /** Keys already reported as refused during THIS load — see the loop below. */
  const reportedRefusals = new Set();
  for (const { key, value } of parseDotenv(text)) {
    const verdict = classifyWorkspaceDotenvKey(key);
    if (verdict === 'ignore') { result.ignored.push(key); continue; }
    if (verdict === 'companion') { result.skipped.push(key); continue; }
    // The value rule comes BEFORE the parent rule, on purpose and with one
    // exemption. A refused line is never applied either way, so the ORDER only
    // decides whether the operator is TOLD about it — and the answer has to be
    // yes even when the parent holds some other value, because that is exactly
    // the case where the line in the file is dead and its owner has no other
    // way to find out (R4: nothing changes in silence).
    //
    // The exemption: a parent that already chose the SAME refused value chose
    // it deliberately, from a place this rule does not govern. A file that
    // merely repeats it has changed nothing, so reporting a refusal there
    // would be a false alarm about a mode that is legitimately in force.
    const refusal = workspaceDotenvValueRefusal(key, value);
    if (refusal) {
      const rule = WORKSPACE_DOTENV_REFUSED_VALUES[key];
      const parentAlreadyChoseIt = key in env && rule.canonicalize(env[key]) === refusal.canonical;
      // ONE report per key per LOAD, whatever the file repeats. A workspace
      // file that names the same refused assignment a thousand times is a
      // 37 KB file; without this it produced a single ~460 KB stderr line,
      // which is a cloned repository slowing or wedging the MCP start-up
      // through a message about itself. The register was already keyed by
      // name and so already deduplicated; the report was not.
      //
      // Per load and not per process: the counter is local to this call, so a
      // second load — another cwd, another test — reports its own file's
      // refusals rather than falling silent because an earlier one already did.
      if (!parentAlreadyChoseIt && !reportedRefusals.has(key)) {
        reportedRefusals.add(key);
        result.refused.push(refusal);
        // NOT recorded as applied — the provenance register describes what took
        // effect, and this did not. `envKeyOrigin` therefore keeps answering for
        // this key the way it would if the file had never named it.
        REFUSED_FROM_WORKSPACE.set(key, { file: path.join(cwd, '.env'), value: refusal.value, canonical: refusal.canonical, reason: refusal.reason, env });
      }
      continue;
    }
    if (key in env) continue; // the parent wins, always
    if (sandboxIsTheHosts && WORKSPACE_DOTENV_SANDBOX_KEYS.includes(key)) { result.withheld.push(key); continue; }
    env[key] = value;
    result.applied.push(key);
    // Recorded here, not by the caller: every entry point that loads a
    // workspace file gets the provenance, and none can forget to.
    APPLIED_FROM_WORKSPACE.set(key, { file: path.join(cwd, '.env'), value, env });
  }
  if (result.ignored.length || result.withheld.length || result.refused.length) {
    const parts = [];
    if (result.ignored.length) {
      // The names come from an untrusted file: they are shown through a strict
      // alphabet, clipped, and capped — a .env cannot drive a terminal through
      // the warning, nor flood it.
      const shown = result.ignored.slice(0, WARN_MAX_NAMES).map((k) => k.replace(/[^A-Za-z0-9_.-]/g, '?').slice(0, WARN_MAX_NAME_LENGTH));
      const more = result.ignored.length - shown.length;
      parts.push(
        `${result.ignored.length} key(s) ignored — a workspace .env may only set ` +
          `${WORKSPACE_DOTENV_POLICY} (ignored: ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}). ` +
          "Set anything else in the MCP host's server declaration or in your shell.",
      );
    }
    if (result.withheld.length) {
      // These names are the router's own constants — nothing from the file.
      parts.push(
        `${result.withheld.join(', ')} withheld — the conversion sandbox is the host's setting here ` +
          '(it set MD_ALLOWED_PATHS or MD_SHARE_DIR, or runs gated); a workspace file may only narrow an unset one.',
      );
    }
    for (const r of result.refused) {
      // The key and the canonical value are the router's own constants; the
      // spelling comes from the file and went through the same strict alphabet
      // as the ignored names. The migration line is the point of naming this
      // at all: a file written by `auto-mode --persist` before this rule
      // existed keeps working in every other respect, and the operator has to
      // be told why THIS line stopped, and what to do instead — nothing
      // changes in silence.
      parts.push(
        `${r.key}=${r.value} refused (canonicalises to ${r.canonical}) — ${r.reason}. ` +
          `If this line was written by an earlier \`auto-mode persist\`, remove it: the mode now comes from the host or from a call during the session.`,
      );
    }
    warn(`[obsidian-mcp-router] .env: ${parts.join(' ')}`);
  }
  return result;
}
