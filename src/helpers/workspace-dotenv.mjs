/**
 * workspace-dotenv.mjs — what a workspace .env file may set in the router's
 * own environment, and the ONE parser the three loaders share.
 *
 * ---------------------------------------------------------------------------
 * THE HOLE THIS CLOSES
 * ---------------------------------------------------------------------------
 * The router, and two of its hooks, load the .env file of the current
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
 * Node builtins only: bin/obsidian-mcp-router.mjs imports this before any
 * dependency is known to exist.
 */

import fs from 'node:fs';
import path from 'node:path';

/** The keys the router's own writers put into a workspace .env, and the two sandbox keys. */
export const WORKSPACE_DOTENV_KEYS = Object.freeze([
  'OBSIDIAN_ROUTER_DEFAULT_VAULT',
  'OBSIDIAN_ROUTER_LOCKED',
  'OBSIDIAN_ROUTER_AUTO_ENRICH',
  'VAULT_PATH',
  'MD_ALLOWED_PATHS',
  'MD_SHARE_DIR',
]);

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
 * @param {{ cwd: string, env?: object, warn?: (message: string) => void, readFile?: (p: string) => string }} opts
 * @returns {{ applied: string[], ignored: string[], skipped: string[], withheld: string[] }}
 */
export function applyWorkspaceDotenv({
  cwd,
  env = process.env,
  warn = (message) => { try { process.stderr.write(`${message}\n`); } catch { /* a closed stderr is not our problem */ } },
  readFile = (p) => fs.readFileSync(p, 'utf8'),
} = {}) {
  const result = { applied: [], ignored: [], skipped: [], withheld: [] };
  if (!cwd) return result;
  let text;
  try {
    text = readFile(path.join(cwd, '.env'));
  } catch {
    return result;
  }
  // Judged once, against the PARENT: a sandbox the host set (either
  // spelling) or a gated instance means the file's sandbox keys are withheld.
  // A file that sets both spellings itself, on a host that set none, is the
  // narrowing case and goes through.
  const sandboxIsTheHosts = isGatedDeployment(env) || WORKSPACE_DOTENV_SANDBOX_KEYS.some((k) => k in env);
  for (const { key, value } of parseDotenv(text)) {
    const verdict = classifyWorkspaceDotenvKey(key);
    if (verdict === 'ignore') { result.ignored.push(key); continue; }
    if (verdict === 'companion') { result.skipped.push(key); continue; }
    if (key in env) continue; // the parent wins, always
    if (sandboxIsTheHosts && WORKSPACE_DOTENV_SANDBOX_KEYS.includes(key)) { result.withheld.push(key); continue; }
    env[key] = value;
    result.applied.push(key);
  }
  if (result.ignored.length || result.withheld.length) {
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
    warn(`[obsidian-mcp-router] .env: ${parts.join(' ')}`);
  }
  return result;
}

const WARN_MAX_NAMES = 20;
const WARN_MAX_NAME_LENGTH = 64;
