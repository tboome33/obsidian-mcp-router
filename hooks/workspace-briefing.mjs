#!/usr/bin/env node
/**
 * workspace-briefing.mjs
 *
 * SessionStart hook. Opens a session by saying, in a few lines, what this
 * workspace is attached to and how to change it.
 *
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 * ---------------------------------------------------------------------------
 * The accepted decision `liaison-workspace-vault-hors-depot` (points 1 and 2)
 * moves the workspace→vault binding out of the project's `.env` and into the
 * user's own config. That answers WHO decides — but a decision recorded in a
 * file nobody opens is invisible, and an invisible binding is how a year of
 * notes end up in the wrong vault. Roland's requirement, 2026-09-03: every
 * session says which vault(s) this workspace is attached to, that the
 * attachment can be changed, what the enrichment mode is and what its range
 * is, and how to list every vault.
 *
 * It is also the safety net under the next phase. Importing existing dotenv
 * hints as confirmed bindings would be an act of trust in project files —
 * exactly what this decision removes — were it not that an import which got it
 * wrong announces itself at the top of every session.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT MAY AND MAY NOT DO
 * ---------------------------------------------------------------------------
 * This hook ships with the PLUGIN, active for every installer with no opt-in
 * step (hooks/hooks.json), so it is held to that manifest's four rules and
 * meets each by construction:
 *
 *   - READ-ONLY. It reads a config and an environment. It writes no file, not
 *     even a fingerprint: this block is meant to be seen at every session, so
 *     there is nothing to deduplicate and no state to keep.
 *   - NO NETWORK. In particular it does NOT ping vaults, so it never says
 *     whether a bound vault is currently open. That is a real thing to know
 *     and `list_vaults` answers it — pinging a fleet here would put an HTTP
 *     timeout in front of every session, and the slowest case is precisely the
 *     closed vault it would be reporting on.
 *   - NEVER exit 2. Always exit 0; a briefing is not a gate.
 *   - SILENT with no vault configured. `composeBriefing` returns null when
 *     this machine has no registered vault, and nothing is printed.
 *
 * Opt-out: `OBSIDIAN_ROUTER_NO_BINDING_BRIEFING=true` — from the HOST only
 * (the MCP declaration or the launching shell), never from a workspace `.env`.
 * See the ordering note further down for why this one is not like the others.
 *
 * Input (stdin, JSON from Claude Code SessionStart):
 *   { hook_event_name: "SessionStart", source: "startup" | "resume" | "clear",
 *     cwd: "...", session_id: "...", transcript_path: "..." }
 */

import fs from 'node:fs';

import {
  loadWorkspaceDotenv,
  readRouterConfig,
  registeredVaultNames,
} from './_helpers/workspace-vault.mjs';
import { readBinding, readRefusals, classifyBindingHint } from '../src/helpers/workspace-bindings.mjs';
import { composeBriefing } from '../src/helpers/binding-briefing.mjs';
import { canonicalizeMode } from '../src/helpers/auto-enrich-mode.mjs';
import { workspaceDotenvRefusals, dotenvRefusalHint, workspaceBindingProposal } from '../src/helpers/workspace-dotenv.mjs';

// ---- Resolve cwd from stdin or env ----------------------------------
// Read BEFORE the dotenv load: the file to read is this workspace's, and the
// workspace is whatever Claude Code says it is, not whatever directory this
// subprocess happens to have been spawned in.
function resolveCwd() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (raw) {
      const data = JSON.parse(raw);
      if (typeof data.cwd === 'string' && data.cwd) return data.cwd;
    }
  } catch { /* stdin missing or unparseable */ }
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

const cwd = resolveCwd();

// THE OPT-OUT IS READ BEFORE THE WORKSPACE FILE IS LOADED, and this ordering
// is the point rather than an accident. Every other hook reads its NO_* after
// the load, on purpose, so a project can switch a convenience off for itself.
// This one is different in kind: the briefing is the DISCLOSURE that a
// project's .env proposed a vault, so a .env able to silence it would be a
// file switching off the report about itself. The dotenv policy is the second
// mechanism: this key is deliberately ABSENT from `WORKSPACE_DOTENV_OPTOUTS`
// in src/helpers/workspace-dotenv.mjs, so the loader classifies it as an
// ignored key and never puts it in the environment at all — whatever the file
// says. (The comment used to name a `HOST_ONLY_OPTOUTS` constant, which has
// never existed; the guarantee is real, its description was not.) Two
// independent reasons, because this is the exact confused-deputy shape the
// decision behind this lot exists to close, and one of them is a list
// somebody could edit.
const TRUTHY = new Set(['true', '1', 'yes', 'on']);
if (TRUTHY.has(String(process.env.OBSIDIAN_ROUTER_NO_BINDING_BRIEFING || '').toLowerCase())) {
  process.exit(0);
}

// Loading the workspace file is also what lets `envKeyOrigin` answer at all:
// the loader's record of what came from the file is what separates "this
// project proposed it" from "your MCP host did".
loadWorkspaceDotenv(cwd);

/**
 * Everything that reads state, in one function, so the one exit path below can
 * be unconditional.
 *
 * @returns {string|null} the block to print, or null for silence
 */
function build() {
  const cfg = readRouterConfig();
  const registered = registeredVaultNames(cfg);
  if (registered.size === 0) return null; // nothing installed to be attached to

  // The binding is read through the ONE module that knows the registry's
  // shape. A hook must not learn where bindings live — that is the design rule
  // the eleven readers of this setting exist to respect.
  const binding = readBinding(cfg, cwd);

  // The refusals, through the same module — and the SAME inputs the server
  // gives the classifier (registry.mjs), so the hook and `list_vaults` cannot
  // disagree about whether a proposal is silent. A refusal recorded in the
  // config is the user's answer; the file's own OBSIDIAN_ROUTER_REFUSED_VAULT
  // line only adds "this was refused here before" when the config has no
  // answer any more.
  const refusals = readRefusals(cfg, cwd);
  // WHICH LINE PROPOSED — the default-vault line, or this file's own lock line
  // when it carries no default. The same selector the server uses, so the two
  // surfaces cannot disagree about whether there is a proposal at all.
  const proposal = workspaceBindingProposal();
  const hint = classifyBindingHint({
    hint: proposal.hint,
    binding,
    // Names are compared EXACTLY, which is what the server does
    // (`resolveVault`: `x.name === target`). Lowercasing here made the hook
    // wider than the server: `DEDIBOX` in the config beside a proposal naming
    // `dedibox` read `unconfirmed` here and `unknown-vault` there, and the
    // confirmation this line offered was refused by the tool.
    isRegistered: (name) => registered.has(String(name)),
    origin: proposal.origin,
    byLock: proposal.byLock,
    isRefused: (name) => refusals.has(name),
    fileRefusal: dotenvRefusalHint(),
  });

  // The mode this session STARTS in. A `set_auto_enrich_mode` call later in
  // the session changes the running server's mode, not this environment — and
  // this hook runs before any tool call, so "starts in" is the honest tense.
  const mode = canonicalizeMode(process.env.OBSIDIAN_ROUTER_AUTO_ENRICH);
  const modeRefused = workspaceDotenvRefusals(process.env)
    .find((r) => r.key === 'OBSIDIAN_ROUTER_AUTO_ENRICH') || null;

  return composeBriefing({
    binding,
    hint,
    mode,
    modeRefused,
    registeredCount: registered.size,
    isRegistered: (name) => registered.has(String(name)),
    // The hook cannot see what the SERVER's start-up imported — it is a
    // separate process, and the import runs where the registry loads. What it
    // can see is the binding's own provenance: `confirmedVia: 'migration'`
    // means nobody confirmed this, the router inferred it from a file. That is
    // the fact the user has to be told, and it stays true on every session
    // until they act on it — which is better than a one-shot announcement the
    // one session that happened to run the import.
    imported: binding?.confirmedVia === 'migration'
      ? { vault: binding.vault, at: binding.confirmedAt, locked: binding.locked, dotenvFile: null }
      : null,
  });
}

// "ALWAYS EXIT 0" IS A STRUCTURAL GUARANTEE, NOT A HOPE.
//
// The Codex review of 2026-09-03 found a config value of the wrong type —
// `vaultNames: {"C:/Vault": 123}`, parseable JSON — that made this hook throw
// and exit 1. That one bug is fixed at its source, but the lesson is the
// general shape: this hook reads a hand-editable file and an environment, and
// something in there will eventually be a type nobody predicted. A briefing
// that breaks a session is far worse than a briefing that does not appear, so
// the failure mode is silence, chosen here once rather than defended
// input-by-input forever.
//
// Nothing is written to stderr either: a hook's stderr is what Claude reads
// when a hook blocks a turn, and a stack trace there would be read as content.
try {
  const briefing = build();
  if (briefing) process.stdout.write(`${briefing}\n`);
} catch { /* a briefing is never worth breaking a session over */ }

process.exit(0);
