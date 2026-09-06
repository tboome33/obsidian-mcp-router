/**
 * Skill capability contracts — C8.
 *
 * WHAT PROBLEM THIS SOLVES. The repo ships 46 skills. Nothing anywhere
 * declares what each one READS, what it WRITES, and what it REQUIRES
 * (a shell? the network? a third-party Obsidian plugin?). So there is no
 * artifact a machine can consult before granting a skill anything, and no
 * check that the three tellings of the same story agree:
 *
 *   - CODE      — the router's MCP tool catalog (`src/index.mjs` TOOLS) and
 *                 the sub-agent tool allowlists (`agents/*.md` frontmatter).
 *                 These are the only two things that are actually enforced
 *                 at runtime.
 *   - DOC       — the prose humans and models read: every SKILL.md under
 *                 `skills/`, plus the artifact counters published in
 *                 README.md and docs/architecture.md.
 *   - MANIFEST  — `contracts/skill-capabilities.json` (this module's subject)
 *                 and the plugin manifests `.claude-plugin/*.json`.
 *
 * Drift between the three is currently found by hand, weeks later. This
 * module makes it a build failure.
 *
 * THE HONESTY RULE (non-negotiable, borrowed verbatim from claude-obsidian,
 * and the same principle as C6's *declared* authority). A declaration must
 * never look better checked than it is. Every entry carries a
 * `verification.status`, and the validator refuses any status it cannot
 * mechanically substantiate:
 *
 *   - `verified` — an executable behavioral check exercises this contract.
 *                  Requires `evidence: [test files]`; each must EXIST and
 *                  must mention the skill. **No skill qualifies today** —
 *                  skills are LLM-interpreted markdown and no harness runs
 *                  one deterministically. The rung is defined so that a real
 *                  test can be recorded, and so that claiming it without one
 *                  fails.
 *   - `declared`  — nobody checks it. Requires a written `reason` naming the
 *                  specific residual uncertainty. This is the honest default
 *                  and where all 46 skills sit today.
 *
 * There is deliberately NO middle tier. The tempting one was "enforced by
 * the sub-agent tool allowlist" — but `wiki-ingest` and `wiki-lint` only run
 * inside their sub-agent in BATCH mode; in-process, the main session is
 * bound by nothing. A tier that held for one code path and not the other
 * would be precisely the inflated rung this rule exists to forbid. The
 * allowlists are still cross-checked (see checkAgentAllowlists), just not
 * as a badge on the declaration.
 *
 * The bootstrapper (`scripts/bootstrap-skill-capabilities.mjs`) only ever
 * emits `declared`. A tier is something a human claims and the validator
 * substantiates — never something a generator awards itself.
 *
 * MACHINE-READABILITY IS THE POINT. `contracts/skill-capabilities.json` is
 * the raw material for MCPHub/SaaS permissioning: the controlled vocabularies
 * below are small, closed, and stable so a policy engine can consume them
 * without parsing prose.
 */

import fs from 'node:fs';
import path from 'node:path';
import { cmp } from './total-order.mjs';
import { quickReferenceFreshness, QUICK_REFERENCE_MANIFEST } from './quick-reference.mjs';

// ---------------------------------------------------------------------------
// Schema + controlled vocabularies
// ---------------------------------------------------------------------------

/**
 * Bumped only on a BREAKING change to the entry shape. A consumer that
 * understands version N must refuse a file declaring N+1 rather than guess.
 */
export const SCHEMA_VERSION = 1;

/** Where the declarations live, relative to the repo root. */
export const DECLARATIONS_PATH = 'contracts/skill-capabilities.json';

/**
 * What a skill can READ. Closed vocabulary — an unknown atom is an error,
 * not a free-text note, because a permission engine that silently ignores a
 * value it does not know is a permission engine that grants too much.
 */
export const READ_ATOMS = Object.freeze([
  'vault:content',      // file bodies inside a vault
  'vault:listing',      // directory listings / file names
  'vault:frontmatter',  // frontmatter only
  'vault:scaffold',     // wiki-meta/** scaffolds: catalog, journal, hot, Sessions
  'vault:search',       // search / semantic-search surfaces
  'vault:derived',      // generated sidecars: search index, graph, digests, ledgers
  'vault:config',       // the vault's own .obsidian/** configuration
  'router:config',      // ~/.claude/obsidian-mcp-router/config.json + workspace .env
  'workspace:files',    // files in the current code workspace (Read/Glob/Grep)
  'local:fs',           // arbitrary local paths outside vault and workspace
  'web',                // remote HTTP(S) fetch
]);

/** What a skill can WRITE. Same closed-vocabulary discipline as READ_ATOMS. */
export const WRITE_ATOMS = Object.freeze([
  'vault:content',
  'vault:frontmatter',
  'vault:scaffold',     // wiki-meta/** scaffolds: catalog, journal, hot, Sessions
  'vault:derived',      // regenerable artifacts: search index, graph, digests, projections
  'vault:config',       // the vault's .obsidian/** (plugins, themes, snippets)
  'router:config',      // router config.json / workspace .env
  'workspace:files',
  'local:fs',
]);

/**
 * HOW a skill writes — the "(create-only / transactional / cache)" axis the
 * roadmap names. This is the field a permission engine keys on when it wants
 * to allow a skill to add but not to overwrite, or to regenerate a cache but
 * not to touch authored content.
 *
 * Ordered from least to most dangerous; `writeMode` is the MAXIMUM a skill
 * may reach, not a description of a typical run.
 */
export const WRITE_MODES = Object.freeze([
  'read-only',     // never writes anything
  'cache',         // writes only regenerable derived artifacts
  'create-only',   // creates new files; never overwrites an existing one
  'append-only',   // only appends to existing files
  'mutating',      // overwrites or patches authored content in place
  'transactional', // multi-file, all-or-nothing through write_bundle
  'destructive',   // can delete or move (loses content if wrong)
]);

/** See the honesty rule in the module header. */
export const VERIFICATION_STATUSES = Object.freeze(['verified', 'declared']);

/**
 * The bootstrapper stamps this string into every reason it generates, and
 * the validator REFUSES it.
 *
 * The roadmap is explicit that automatic bootstrapping is "a proposal, not a
 * truth". Without a mechanism, that stays a good intention: a generated file
 * is syntactically perfect, CI goes green, and nobody ever reads it. The
 * sentinel makes the proposal fail until a human has replaced the reason on
 * every entry — which is the only way to make "then review them" a step that
 * actually happens.
 */
export const BOOTSTRAP_SENTINEL = 'UNREVIEWED-BOOTSTRAP';

/** Keys allowed in `requires`. Anything else is a schema error. */
export const REQUIRES_KEYS = Object.freeze([
  'shell',            // boolean — needs Bash/PowerShell
  'network',          // boolean — reaches the public internet
  'python',           // boolean — needs the bundled Python toolchain
  'obsidianPlugins',  // string[] — third-party plugins that must be installed
  'binaries',         // string[] — external executables (git, yt-dlp, …)
]);

/**
 * Top-level keys allowed on a skill entry.
 *
 * `delegatesTo` matters more than it looks. Several skills invoke another
 * skill rather than doing the work themselves — `autoresearch` drives
 * `wiki-ingest`, `wiki-ingest` fans out to its own sub-agent. A contract
 * that lists only the tools the page itself calls UNDERSTATES what running
 * the skill can reach, and understating is the dangerous direction for a
 * permission model. Declaring the edge lets a consumer compute the
 * transitive closure instead of reading prose.
 */
const ENTRY_KEYS = Object.freeze([
  'summary', 'reads', 'writes', 'tools', 'toolsMentionedNotCalled',
  'delegatesTo', 'skillsMentionedNotInvoked', 'writeMode', 'requires', 'verification',
]);

/** Keys allowed inside `verification`, per status. Closed, like everything else. */
const VERIFICATION_KEYS = Object.freeze({
  declared: ['status', 'reason'],
  verified: ['status', 'evidence', 'reason'],
});

/**
 * WRITE MODE RANK — used to check that a declaration is at least as strong as
 * the tools it declares and the skills it delegates to.
 *
 * Understating reach is the dangerous direction for a permission model, so
 * these comparisons are always "declared >= implied", never equality.
 */
const WRITE_MODE_RANK = Object.freeze(
  Object.fromEntries(WRITE_MODES.map((m, i) => [m, i])),
);

/**
 * Router tools whose implementation reaches the public internet.
 *
 * Explicit rather than name-derived: `webpage_to_markdown` is obvious,
 * `extract_page_metadata` is not, and guessing wrong in the permissive
 * direction is how a "no network" declaration becomes false.
 */
export const NETWORK_TOOLS = Object.freeze([
  'webpage_to_markdown', 'youtube_to_markdown', 'bing_search_to_markdown',
  'git_repo_to_markdown', 'download_page_assets', 'extract_page_metadata',
]);

/** Router tools that need the bundled Python toolchain (MarkItDown / Docling). */
export const PYTHON_TOOLS = Object.freeze([
  'pdf_to_markdown', 'pdf_to_markdown_docling', 'pdf_to_images',
  'docx_to_markdown', 'pptx_to_markdown', 'xlsx_to_markdown',
  'audio_to_markdown', 'image_to_markdown',
]);

/** Router tools that can lose content: they force `destructive` or above. */
export const DESTRUCTIVE_TOOLS = Object.freeze(['delete_file', 'move_file']);

/**
 * The MINIMUM a declaration must admit for each write tool it calls.
 *
 * The first version of this check only caught the extremes — `read-only`
 * and empty `writes` — so a contract could call `write_file` and still
 * declare `writeMode: "cache"` (i.e. "only regenerable artifacts"), or call
 * `set_frontmatter` and list only `vault:derived`. Both are understatements
 * a permission engine would act on.
 *
 * `mode` is the least writeMode compatible with the tool; `atom` is a write
 * atom the declaration must contain. Tools whose target genuinely depends
 * on the caller (`write_file` can legitimately write content OR a derived
 * artifact) constrain only the mode.
 */
export const TOOL_WRITE_FLOOR = Object.freeze({
  write_file:              { mode: 'cache' },
  append_to_file:          { mode: 'append-only' },
  patch_file:              { mode: 'mutating' },
  set_frontmatter:         { mode: 'mutating', atom: 'vault:frontmatter' },
  merge_frontmatter:       { mode: 'mutating', atom: 'vault:frontmatter' },
  write_bundle:            { mode: 'transactional' },
  delete_file:             { mode: 'destructive' },
  move_file:               { mode: 'destructive' },
  build_search_index:      { mode: 'cache', atom: 'vault:derived' },
  build_wiki_graph:        { mode: 'cache', atom: 'vault:derived' },
  refresh_okf_projections: { mode: 'cache', atom: 'vault:derived' },
  record_source:           { mode: 'cache', atom: 'vault:derived' },
  download_page_assets:    { mode: 'cache' },
  execute_template:        { mode: 'create-only' },
  provision_vault:         { mode: 'mutating' },
});

/**
 * Router tools that necessarily READ something, and the atom that proves it.
 * Closes the mirror-image understatement: calling `get_file` while
 * declaring `reads: []`.
 */
export const TOOL_READ_FLOOR = Object.freeze({
  get_file:           'vault:content',
  get_frontmatter:    'vault:frontmatter',
  list_files:         'vault:listing',
  list_vaults:        'vault:listing',
  search:             'vault:search',
  search_smart:       'vault:search',
  get_page_neighbors: 'vault:derived',
  wiki_path:          'vault:derived',
  find_boundary_pages: 'vault:derived',
  audit_sources:      'vault:derived',
});

/**
 * HOST tools — capabilities the Claude Code harness provides, which no
 * amount of router-tool scanning can see.
 *
 * A skill that drives `WebFetch` reaches the internet without any router
 * tool being involved (`autoresearch` does exactly this), and one that runs
 * `node scripts/…` through Bash escapes every router-side guard
 * (`meta-attach-vault`, `hot-compact`). Left unscanned, `requires.network`
 * and `requires.shell` could sit at `false` on precisely the skills where
 * they matter most.
 *
 * A false positive here costs a human a second look; a false negative hands
 * a permission engine a lie. The patterns are therefore generous.
 */
export const HOST_TOOL_SIGNALS = Object.freeze([
  { requires: 'network', label: 'WebFetch/WebSearch', pattern: /\b(WebFetch|WebSearch)\b/ },
  // `Bash` capitalised is the harness tool's name; a fenced shell block is a
  // command the page tells the model to run; and `node scripts/…` is one
  // regardless of how (or whether) it was fenced — `sync-from-github` spells
  // out a `node scripts/setup-vault.mjs` invocation with neither a bash
  // fence nor the word Bash, and the earlier pattern missed it entirely.
  //
  // `PowerShell` on its own is deliberately NOT a signal — several pages
  // mention `$PROFILE` while explaining a fix to the USER, which is advice,
  // not a capability the skill exercises.
  {
    requires: 'shell',
    label: 'a Bash/shell invocation',
    pattern: /```(?:bash|sh|powershell|shell|console|cmd|ps1)\b|\bBash\b|\bnode\s+["'`]?[\w./\\-]*scripts[/\\][\w.-]+\.mjs/,
  },
]);

// ---------------------------------------------------------------------------
// Small parsing helpers
// ---------------------------------------------------------------------------

/**
 * Split a markdown file into its YAML frontmatter block and body.
 *
 * Deliberately NOT a YAML parser: the only frontmatter keys this module
 * needs are `name` and `tools`, both plain scalars on one line. Pulling in a
 * parser (or hand-rolling one) would buy nothing and break on the multi-line
 * `description: |` blocks every SKILL.md uses.
 *
 * Returns `{ raw, body }` where `raw` is the frontmatter text (empty when the
 * file has none) and `body` is everything after it.
 */
export function splitFrontmatter(text) {
  const src = String(text ?? '');
  // Tolerate a UTF-8 BOM and CRLF — both occur on Windows checkouts.
  const clean = src.replace(/^﻿/, '');
  const m = clean.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { raw: '', body: clean };
  return { raw: m[1], body: clean.slice(m[0].length) };
}

/** Read a single-line scalar key out of a frontmatter block. */
export function frontmatterScalar(raw, key) {
  const re = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm');
  const m = String(raw ?? '').match(re);
  if (!m) return null;
  return m[1].trim().replace(/^['"]|['"]$/g, '') || null;
}

function readSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Discovery — the CODE + DOC legs
// ---------------------------------------------------------------------------

/**
 * Every skill the repo actually ships: a directory under `skills/` holding a
 * `SKILL.md`. A directory without one is not a skill (it is leftover), and a
 * loose file under `skills/` is not a skill either — which is what lets the
 * declarations file live outside `skills/` without confusing anything.
 */
export function discoverSkills(repoRoot) {
  const dir = path.join(repoRoot, 'skills');
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return []; }
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const skillMd = path.join(dir, ent.name, 'SKILL.md');
    const text = readSafe(skillMd);
    if (text === null) continue;
    const { raw, body } = splitFrontmatter(text);
    out.push({
      name: ent.name,
      declaredName: frontmatterScalar(raw, 'name'),
      skillMdPath: path.join('skills', ent.name, 'SKILL.md'),
      frontmatter: raw,
      body,
      text,
    });
  }
  return out.sort((a, b) => cmp(a.name, b.name));
}

/**
 * Strip the MCP namespace prefix off a tool reference.
 *
 * The same router tool is addressable under two names depending on how the
 * server was installed — `mcp__obsidian-router__get_file` (standalone MCP
 * registration) and `mcp__plugin_obsidian-router_router__get_file` (served by
 * the Claude Code plugin). Agent allowlists list BOTH. Comparing raw strings
 * would make an allowlist look like it holds 22 tools when it holds 11.
 */
export function bareToolName(ref) {
  return String(ref ?? '').trim().replace(/^mcp__[^_]*(?:_[^_]+)*?__/, '');
}

/**
 * True when an allowlist entry is a grant of a ROUTER tool specifically.
 *
 * Not merely "starts with mcp__": an agent may legitimately be granted a
 * tool from another MCP server, and treating `mcp__tradingview__tv_health_check`
 * as a rotted router grant would fail CI on a perfectly good allowlist —
 * while `mcp__other-server__get_file` would satisfy a router contract by
 * name collision. Only the router's own two spellings count.
 */
export function isRouterToolRef(ref) {
  return /^mcp__(?:obsidian-router|plugin_obsidian-router_router)__/.test(String(ref ?? '').trim());
}

/**
 * The sub-agents and the tool allowlist the harness enforces for each.
 *
 * This is the only runtime enforcement point a skill contract touches — but
 * it confers NO verification status (there is no such tier; see the module
 * header). It is used one way only: an agent must never be granted a router
 * tool its own skill's contract does not declare. See checkAgentAllowlists.
 */
export function discoverAgents(repoRoot) {
  const dir = path.join(repoRoot, 'agents');
  let names;
  try { names = fs.readdirSync(dir); } catch { return new Map(); }
  const out = new Map();
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const text = readSafe(path.join(dir, name));
    if (text === null) continue;
    const { raw } = splitFrontmatter(text);
    const toolsLine = frontmatterScalar(raw, 'tools');
    const refs = (toolsLine || '').split(',').map((t) => t.trim()).filter(Boolean);
    const tools = new Set(refs.filter((r) => !/^mcp__/.test(r) || isRouterToolRef(r)).map((t) => bareToolName(t)).filter(Boolean));
    // Entries written as `mcp__…__<tool>` are ROUTER grants and must resolve
    // to a real catalog tool. Keeping them separate is what lets the
    // allowlist check tell `WebFetch` (a harness tool, correctly ignored)
    // from `delete_flie` (a rotted or typo'd router grant that would
    // otherwise be silently swallowed by the same filter).
    const routerRefs = new Set(refs.filter(isRouterToolRef).map((t) => bareToolName(t)).filter(Boolean));
    out.set(name.replace(/\.md$/, ''), {
      file: path.posix.join('agents', name),
      tools,
      routerRefs,
      // An agent whose `tools:` line we could not read must NOT silently
      // become an empty allowlist — that would switch the cross-check off
      // for exactly the file whose format changed (a YAML block list, a
      // bracket array, a missing frontmatter). Recorded so the validator
      // can say so out loud.
      allowlistParsed: toolsLine !== null && tools.size > 0,
    });
  }
  return out;
}

/**
 * Router MCP tool names a SKILL.md NAMES anywhere in its text.
 *
 * Deliberately over-inclusive: it matches any backticked identifier that is
 * also a real tool name, whether the skill CALLS it or merely mentions it in
 * prose ("keep this hash for a later `write_file`"). Over-inclusion is the
 * right failure direction — the reviewer must then say, per skill, which
 * mentions are calls (`tools`) and which are only prose
 * (`toolsMentionedNotCalled`). A narrower matcher would silently miss a real
 * new call, which is exactly the drift C8 exists to catch.
 */
export function mentionedTools(text, knownToolNames) {
  const known = knownToolNames instanceof Set ? knownToolNames : new Set(knownToolNames);
  const src = String(text ?? '');
  const found = new Set();

  // (1) Backticked identifiers — the common way a page names a tool.
  for (const m of src.matchAll(/`([a-z][a-z0-9_]*)`/g)) {
    if (known.has(m[1])) found.add(m[1]);
  }

  // (2) Fully-qualified references (`mcp__obsidian-router__get_file`).
  for (const m of src.matchAll(/mcp__[A-Za-z0-9_-]+__([a-z][a-z0-9_]*)/g)) {
    if (known.has(m[1])) found.add(m[1]);
  }

  // (3) BARE identifiers, for tool names that contain an underscore.
  //
  //     Without this, dropping the backticks around `delete_file` erases a
  //     permission-relevant mention and the contract may quietly understate
  //     the skill — formatting must never change what a capability scan
  //     sees. Restricted to underscored names on purpose: every router tool
  //     but one is `verb_noun`, which never occurs in English prose, while
  //     the lone single-word tool (`search`) appears constantly in ordinary
  //     sentences and would drown the check in false positives. `search`
  //     therefore still requires backticks or a namespace.
  for (const name of known) {
    if (!name.includes('_')) continue;
    if (found.has(name)) continue;
    if (new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(src)) found.add(name);
  }
  return found;
}

/**
 * Other skills a SKILL.md tells the reader to INVOKE.
 *
 * Deliberately narrow, unlike `mentionedTools`. Skill names are ordinary
 * hyphenated words that appear constantly as cross-references ("see
 * wiki-lint", "the complement of meta-status"), and treating every mention
 * as a delegation edge would bury the real ones. Only an explicit
 * invocation verb next to the name counts — which is how the pages that
 * really do delegate are written.
 */
export function mentionedSkills(text, skillNames, self) {
  const src = String(text ?? '');
  const found = new Set();

  // Invocation verbs, minus the INVERTED forms. "If invoked FROM
  // `autoresearch`" describes a caller, not a callee: read as a delegation
  // it points the edge backwards and would have made `defuddle` — a
  // read-only fetcher — inherit the closure of the transactional skill that
  // uses it.
  // `run` is deliberately absent. Pages are full of "offer to run
  // /wiki-graph first" — a SUGGESTION the user then approves as its own
  // invocation, not something the skill does on its own authority. Counting
  // those as delegation edges would inflate almost every contract to the
  // closure of the whole skill set, which is as useless as understating.
  // The leading boundary is load-bearing: without it, `call` matched inside
  // "deterministi(call)y" and turned a passing prose reference into a
  // delegation edge.
  // Boundaries on BOTH sides. Round 1 added the leading one (`call` was
  // matching inside "deterministi(call)y") and forgot the trailing one, so
  // "the (call)er of the X skill" and "a (call)back for the X sub-agent"
  // became delegation edges — which the dominance checks would then force a
  // contract to inflate for a delegation that does not exist.
  const B = '(?<![A-Za-z])';
  const E = '(?![A-Za-z])';
  // STRONG verbs name a delegation whatever form the handle takes.
  const STRONG = `${B}(?:invoke|invokes|invoking|call|calls|calling|delegate|delegates|delegated`
    + `|hand\\s+off|fan\\s+out|dispatch|dispatches)${E}`;
  // `use` and `run` are deliberately NOT verbs here, and the name must be an
  // ADDRESSABLE handle rather than a bare word.
  //
  // Both restrictions were measured against the 46 shipped pages. Widening
  // either one turns redirects and prerequisites into "delegations":
  // "→ use `wiki` skill" (conventions) and "Target vault has `wiki/`
  // scaffolding (use `wiki` skill)" (save) are advice to the USER, and
  // "provisions in one `provision_vault` call (plugins + wiki …)" is not a
  // delegation at all. Six false positives to one true one — and a false
  // edge is not merely noise here: the dominance checks would force the
  // parent contract to absorb a delegate's whole closure, actively
  // corrupting the data a permission engine is meant to read.
  //
  // KNOWN BLIND SPOT, stated rather than papered over: a page that writes
  // "use the X skill" or "run the X skill" for a REAL delegation is missed.
  // The check is therefore a safety net for the common phrasing, not a
  // proof that `delegatesTo` is complete — completeness still rests on the
  // human review the bootstrap sentinel forces.
  const INVERTED = /(?:invoked|called|dispatched|used)\s+(?:from|by|inside)\s*$/i;
  /** "Never invoke X", "don't call X" — a prohibition, not an edge. */
  const NEGATED = /\b(?:never|do\s+not|don't|rather\s+than|instead\s+of)\b[^.\n]{0,12}$/i;

  for (const name of skillNames) {
    if (name === self) continue;
    const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // The name must appear as an ADDRESSABLE form, not as a bare word.
    // Bare-word matching produced 6 false positives for every true one:
    // `lock` fired inside "block", `wiki` inside `["wiki/"]`, `save` inside
    // "auto-save". A skill is invoked by its handle, so require the handle.
    const HANDLE =
      `(?:\`/?(?:obsidian-router:)?${n}\`` +           // `wiki-ingest` / `/obsidian-router:conventions`
      `|/(?:obsidian-router:)?${n}(?![A-Za-z0-9_-])` +  // /wiki-graph
      `|(?<![A-Za-z0-9_-])${n}(?=\\s+(?:skill|sub-agent)))`; // "the wiki-ingest sub-agent"

    for (const [verb, nameForm] of [[STRONG, HANDLE]]) {
      const re = new RegExp(`(${verb}[^.\\n]{0,40}?)${nameForm}`, 'gi');
      let hit = false;
      for (const m of src.matchAll(re)) {
        // "invoked FROM `x`" points the edge backwards; "never invoke `x`"
        // is a prohibition. Neither is a delegation.
        //
        // The negation sits BEFORE the verb, so it has to be looked for in
        // the text preceding the match — testing the match itself found
        // nothing and let "Never invoke the X skill" through as an edge.
        const lead = src.slice(Math.max(0, m.index - 30), m.index);
        if (INVERTED.test(m[1]) || NEGATED.test(lead)) continue;
        hit = true;
        break;
      }
      if (hit) { found.add(name); break; }
    }
  }
  return found;
}

/**
 * Host capabilities a SKILL.md reaches for directly (Bash, WebFetch, …).
 * Returns the `requires` keys those signals imply. See HOST_TOOL_SIGNALS.
 */
export function mentionedHostCapabilities(text) {
  const src = String(text ?? '');
  const out = new Map();
  for (const signal of HOST_TOOL_SIGNALS) {
    if (signal.pattern.test(src)) out.set(signal.requires, signal.label);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Declarations file
// ---------------------------------------------------------------------------

/**
 * Read + JSON-parse the declarations. Returns `{ ok, data, error }` rather
 * than throwing so the validator can report "the manifest itself is broken"
 * as an ordinary finding instead of a stack trace.
 */
export function readDeclarations(repoRoot) {
  const abs = path.join(repoRoot, DECLARATIONS_PATH);
  const text = readSafe(abs);
  if (text === null) {
    return { ok: false, data: null, error: `missing file: ${DECLARATIONS_PATH}` };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { ok: false, data: null, error: `invalid JSON in ${DECLARATIONS_PATH}: ${err.message}` };
  }
  const dupes = duplicateSkillKeys(text);
  if (dupes.length > 0) {
    return {
      ok: false,
      data: null,
      error: `${DECLARATIONS_PATH} declares ${dupes.join(', ')} more than once — JSON keeps only the LAST, so an earlier declaration (possibly a stricter one) is being silently discarded. This is what a botched merge-conflict resolution looks like.`,
    };
  }
  return { ok: true, data, error: null };
}

/**
 * Skill keys that appear more than once in the raw JSON text.
 *
 * `JSON.parse` resolves duplicates last-wins without a murmur, so a merge
 * that left two `"wiki-ingest"` blocks would quietly drop whichever one came
 * first — and if the survivor is the gentler of the two, the manifest now
 * understates a skill with nothing to show for it. Detecting this needs the
 * TEXT; the parsed object has already forgotten.
 */
export function duplicateSkillKeys(text) {
  const src = String(text ?? '');
  const start = src.indexOf('"skills"');
  if (start === -1) return [];
  const seen = new Set();
  const dupes = new Set();
  // Entry keys sit at one nesting level inside "skills": match a quoted key
  // followed by `: {`, which every entry is and no scalar field is.
  for (const m of src.slice(start).matchAll(/"([^"\\]+)"\s*:\s*\{/g)) {
    const key = m[1];
    if (key === 'requires' || key === 'verification' || key === 'skills') continue;
    if (seen.has(key)) dupes.add(key);
    seen.add(key);
  }
  return [...dupes].sort();
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

function issue(code, message, fix, where, extra = {}) {
  return { code, severity: 'error', message, fix, where, ...extra };
}

/**
 * Every element of a declared array must be a unique, non-empty string.
 *
 * Not pedantry: `evidence: [{...}]` or `evidence: [null]` used to reach
 * `path.join` and throw, turning a malformed manifest into a crashed
 * validator — which reads as "the check is broken" rather than "your file is
 * wrong". Type-checking first keeps every bad input a reportable finding.
 */
function checkStringArray(list, label, where) {
  const issues = [];
  const seen = new Set();
  for (const [i, v] of list.entries()) {
    if (typeof v !== 'string' || v.trim() === '') {
      issues.push(issue('schema', `entry \`${label}\`[${i}] must be a non-empty string (got ${JSON.stringify(v)}).`, 'Use a plain string, or remove the element.', where));
      continue;
    }
    if (seen.has(v)) {
      issues.push(issue('schema', `entry \`${label}\` lists \`${v}\` twice.`, 'Remove the duplicate — a set is what a policy engine expects here.', where));
    }
    seen.add(v);
  }
  return issues;
}

/**
 * Substantiate ONE `verified` evidence citation.
 *
 * `verified` is the only rung that claims something a reader cannot check by
 * eye, so the bar has to be mechanical and narrow. A citation qualifies only
 * if it is a real, non-symlink `*.test.mjs` file that lives inside the
 * repo's `tests/` directory and names the skill as a whole identifier.
 *
 * Each condition closes a specific way the badge could be faked:
 *   - CONTAINMENT — `../../elsewhere/foo.test.mjs` (or a symlink out) would
 *     let a file nobody reviews confer verification. Resolved with realpath
 *     so a link cannot smuggle the target outside.
 *   - TEST DIRECTORY + SUFFIX — otherwise the manifest could cite the README,
 *     the SKILL.md, or even itself; each contains the skill name, so each
 *     would pass a naive substring test.
 *   - WHOLE-IDENTIFIER MATCH — `save` is a substring of "saved", "saves",
 *     "unsaved"; almost any file would have vouched for it.
 *
 * This does NOT prove the cited test exercises the contract — nothing short
 * of a real skill harness could. It proves the citation is a reviewed test
 * file about this skill, and it makes the cheap fakes impossible. The
 * remaining gap is stated plainly in the README rather than papered over.
 */
export function checkEvidenceFile({ repoRoot, name, rel, where }) {
  const issues = [];
  const cite = (message, fix) => issues.push(issue('honesty', message, fix, where));

  if (path.isAbsolute(rel)) {
    cite(
      `entry \`${name}\` cites evidence by absolute path (\`${rel}\`).`,
      'Cite a repo-relative path under `tests/` — an absolute path is not portable and not reviewable.',
    );
    return issues;
  }

  const abs = path.resolve(repoRoot, rel);

  // lstat BEFORE realpath. Resolving first and then stat-ing the target
  // meant a symlink inside tests/ pointing anywhere at all satisfied the
  // "non-symlink" rule this function documents — the link was followed
  // before it could be rejected.
  try {
    if (fs.lstatSync(abs).isSymbolicLink()) {
      cite(
        `entry \`${name}\` cites \`${rel}\`, which is a symbolic link.`,
        'Cite the test file directly. A link can point outside the checkout, and following it is exactly how containment is bypassed.',
      );
      return issues;
    }
  } catch { /* absence is reported by the realpath step below */ }

  let real;
  try { real = fs.realpathSync(abs); }
  catch {
    cite(
      `entry \`${name}\` claims \`verified\` citing \`${rel}\`, which does not exist.`,
      'Cite a real test file, or drop to `declared`.',
    );
    return issues;
  }

  let realRoot;
  try { realRoot = fs.realpathSync(repoRoot); } catch { realRoot = path.resolve(repoRoot); }
  const testsRoot = path.join(realRoot, 'tests');
  const relToTests = path.relative(testsRoot, real);
  if (relToTests.startsWith('..') || path.isAbsolute(relToTests)) {
    cite(
      `entry \`${name}\` cites evidence outside \`tests/\` (\`${rel}\` resolves to ${real}).`,
      'Evidence must be a test file inside the repo\'s tests/ directory. A path that escapes the checkout — directly or through a symlink — could be anything.',
    );
    return issues;
  }

  let stat;
  try { stat = fs.statSync(real); } catch { stat = null; }
  if (!stat || !stat.isFile()) {
    cite(`entry \`${name}\` cites \`${rel}\`, which is not a regular file.`, 'Cite a single test file.');
    return issues;
  }
  if (!/\.test\.mjs$/.test(real)) {
    cite(
      `entry \`${name}\` cites \`${rel}\`, which is not a \`*.test.mjs\` file.`,
      'Evidence must be an executable test file — a doc or a fixture cannot substantiate a behavioral claim.',
    );
    return issues;
  }

  const body = readSafe(real) || '';
  // Whole-identifier match: `save` must not be satisfied by "unsaved".
  const nameRe = new RegExp(`(?<![A-Za-z0-9_-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`);
  if (!nameRe.test(body)) {
    cite(
      `entry \`${name}\` cites \`${rel}\` as evidence, but that file never names \`${name}\`.`,
      'Cite a test that actually exercises this skill, or drop to `declared`. Citing an unrelated suite is how a "verified" badge becomes a lie.',
    );
  }
  return issues;
}

/**
 * Validate the declarations against the skills on disk, the router's tool
 * catalog, and the agent allowlists.
 *
 * Pure with respect to the filesystem EXCEPT for `verification.evidence`
 * existence, which needs `repoRoot`. Everything else is derived from the
 * facts passed in, so tests can drive it with synthetic inputs.
 *
 * @param {object} facts
 * @param {Array}  facts.skills     — from discoverSkills()
 * @param {Map}    facts.agents     — from discoverAgents()
 * @param {Set}    facts.toolNames  — the router's TOOLS catalog names
 * @param {object} facts.declarations — parsed contracts/skill-capabilities.json
 * @param {string} facts.repoRoot   — for evidence-file existence checks
 */
export function validateDeclarations(facts) {
  const { skills = [], agents = new Map(), declarations, repoRoot = '.' } = facts;
  const toolNames = facts.toolNames instanceof Set
    ? facts.toolNames
    : new Set(facts.toolNames || []);
  const issues = [];

  // The router's own write/read split — the code-side truth every
  // `understated` check measures against.
  //
  // This used to default to an empty Set "harmlessly". It was not harmless:
  // with no write tools known, a contract could declare `delete_file` and
  // claim `read-only` and the flagship understatement check would report
  // nothing — a check silently switching itself off, which is the one
  // outcome this module treats as worse than a wrong answer. Missing input
  // is now a loud finding, exactly as it already was for `toolNames`.
  const writeToolsSupplied = facts.writeToolNames !== undefined && facts.writeToolNames !== null;
  const writeToolNames = facts.writeToolNames instanceof Set
    ? facts.writeToolNames
    : new Set(facts.writeToolNames || []);
  if (!writeToolsSupplied) {
    issues.push(issue(
      'schema',
      'the router write-tool classification was not supplied to the validator.',
      'Pass `writeToolNames` (from `_internals.WRITE_TOOL_NAMES`). Without it, a contract could name a write tool and still claim `read-only` unchallenged.',
      'src/helpers/skill-capabilities.mjs',
    ));
  }

  if (!declarations || typeof declarations !== 'object' || Array.isArray(declarations)) {
    issues.push(issue(
      'schema',
      `${DECLARATIONS_PATH} is not a JSON object.`,
      'Restore the file from git, or regenerate a proposal with `npm run capabilities:bootstrap`.',
      DECLARATIONS_PATH,
    ));
    return issues;
  }

  if (declarations.schemaVersion !== SCHEMA_VERSION) {
    issues.push(issue(
      'schema',
      `${DECLARATIONS_PATH} declares schemaVersion ${JSON.stringify(declarations.schemaVersion)}, this validator understands ${SCHEMA_VERSION}.`,
      `Migrate the file to schemaVersion ${SCHEMA_VERSION}, or upgrade the validator. Do NOT guess at an unknown shape.`,
      DECLARATIONS_PATH,
    ));
    return issues;
  }

  const entries = declarations.skills;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    issues.push(issue(
      'schema',
      `${DECLARATIONS_PATH} has no \`skills\` object.`,
      'Add a top-level `skills` map keyed by skill directory name.',
      DECLARATIONS_PATH,
    ));
    return issues;
  }

  const skillByName = new Map(skills.map((s) => [s.name, s]));
  const declaredNames = Object.keys(entries);

  // --- (1) undeclared skill: it ships, nothing declares it ----------------
  for (const skill of skills) {
    if (!Object.prototype.hasOwnProperty.call(entries, skill.name)) {
      issues.push(issue(
        'undeclared-skill',
        `skill \`${skill.name}\` ships (${skill.skillMdPath}) but has no entry in ${DECLARATIONS_PATH}.`,
        `Add a "${skill.name}" entry. Start from \`npm run capabilities:bootstrap\`, then REVIEW it — the bootstrap is a proposal, not a truth.`,
        skill.skillMdPath,
      ));
    }
  }

  // --- (2) orphan declaration: it is declared, nothing ships it -----------
  for (const name of declaredNames) {
    if (!skillByName.has(name)) {
      issues.push(issue(
        'orphan-declaration',
        `${DECLARATIONS_PATH} declares \`${name}\`, but \`skills/${name}/SKILL.md\` does not exist.`,
        `Delete the "${name}" entry if the skill was removed, or fix the key if the skill was renamed.`,
        DECLARATIONS_PATH,
      ));
    }
  }

  // --- (3) per-entry schema + honesty rule --------------------------------
  for (const name of declaredNames) {
    const entry = entries[name];
    const where = `${DECLARATIONS_PATH} → skills.${name}`;

    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      issues.push(issue('schema', `entry \`${name}\` is not an object.`, 'Make it an object matching the C8 entry shape.', where));
      continue;
    }

    for (const key of Object.keys(entry)) {
      if (!ENTRY_KEYS.includes(key)) {
        issues.push(issue(
          'schema',
          `entry \`${name}\` has unknown key \`${key}\`.`,
          `Remove it, or add it to ENTRY_KEYS in src/helpers/skill-capabilities.mjs if it is a real new field. Unknown keys are rejected so a policy engine never silently ignores one.`,
          where,
        ));
      }
    }

    if (typeof entry.summary !== 'string' || entry.summary.trim() === '') {
      issues.push(issue('schema', `entry \`${name}\` has no \`summary\`.`, 'Add a one-line plain-language summary of what the skill does.', where));
    }

    for (const [field, vocab] of [['reads', READ_ATOMS], ['writes', WRITE_ATOMS]]) {
      const value = entry[field];
      if (!Array.isArray(value)) {
        issues.push(issue('schema', `entry \`${name}\`.${field} must be an array (use [] for none).`, `Set \`${field}: []\` if the skill genuinely ${field === 'reads' ? 'reads' : 'writes'} nothing.`, where));
        continue;
      }
      for (const atom of value) {
        if (!vocab.includes(atom)) {
          issues.push(issue(
            'schema',
            `entry \`${name}\`.${field} has unknown atom \`${atom}\`.`,
            `Use one of: ${vocab.join(', ')}.`,
            where,
          ));
        }
      }
    }

    if (!WRITE_MODES.includes(entry.writeMode)) {
      issues.push(issue(
        'schema',
        `entry \`${name}\`.writeMode is ${JSON.stringify(entry.writeMode)}.`,
        `Use one of: ${WRITE_MODES.join(', ')}.`,
        where,
      ));
    }

    // A skill that writes nothing must say read-only, and vice versa — the
    // two fields are two views of the same fact and must not disagree.
    if (Array.isArray(entry.writes)) {
      const writesNothing = entry.writes.length === 0;
      if (writesNothing && entry.writeMode !== 'read-only') {
        issues.push(issue(
          'inconsistent',
          `entry \`${name}\` declares no write atoms but writeMode \`${entry.writeMode}\`.`,
          'Either list what it writes, or set writeMode to `read-only`.',
          where,
        ));
      }
      if (!writesNothing && entry.writeMode === 'read-only') {
        issues.push(issue(
          'inconsistent',
          `entry \`${name}\` is writeMode \`read-only\` but declares write atoms: ${entry.writes.join(', ')}.`,
          'Either clear `writes`, or pick the writeMode that matches.',
          where,
        ));
      }
      // `cache` is DEFINED as "writes only regenerable derived artifacts".
      // Without this, a contract could pair `cache` with `vault:content` and
      // still pass — telling a permission engine that authored notes are
      // safe from a skill that can replace them.
      if (entry.writeMode === 'cache') {
        const notDerived = entry.writes.filter((a) => a !== 'vault:derived');
        if (notDerived.length > 0) {
          issues.push(issue(
            'understated',
            `entry \`${name}\` is writeMode \`cache\` but writes ${notDerived.join(', ')}, which is not regenerable derived data.`,
            '`cache` means only `vault:derived`. Anything that touches authored content is at least `create-only`/`mutating` — pick that instead.',
            where,
          ));
        }
      }
    }

    // --- requires ---
    const requires = entry.requires;
    if (!requires || typeof requires !== 'object' || Array.isArray(requires)) {
      issues.push(issue('schema', `entry \`${name}\` has no \`requires\` object.`, 'Add `requires: { shell, network, python, obsidianPlugins, binaries }`.', where));
    } else {
      for (const key of Object.keys(requires)) {
        if (!REQUIRES_KEYS.includes(key)) {
          issues.push(issue('schema', `entry \`${name}\`.requires has unknown key \`${key}\`.`, `Use one of: ${REQUIRES_KEYS.join(', ')}.`, where));
        }
      }
      for (const key of ['shell', 'network', 'python']) {
        if (typeof requires[key] !== 'boolean') {
          issues.push(issue('schema', `entry \`${name}\`.requires.${key} must be a boolean.`, `Set it to true or false — "unknown" is not an answer a permission engine can act on.`, where));
        }
      }
      for (const key of ['obsidianPlugins', 'binaries']) {
        if (!Array.isArray(requires[key])) {
          issues.push(issue('schema', `entry \`${name}\`.requires.${key} must be an array (use []).`, `Set \`${key}: []\` when there are none.`, where));
        } else {
          issues.push(...checkStringArray(requires[key], `${name}.requires.${key}`, where));
        }
      }
    }

    // --- tools: must exist in the router catalog ---
    const declaredTools = Array.isArray(entry.tools) ? entry.tools : null;
    const proseTools = Array.isArray(entry.toolsMentionedNotCalled) ? entry.toolsMentionedNotCalled : [];
    if (declaredTools === null) {
      issues.push(issue('schema', `entry \`${name}\`.tools must be an array (use []).`, 'List the router MCP tools the skill calls, or [] if it calls none.', where));
    }
    if (!Array.isArray(entry.toolsMentionedNotCalled) && entry.toolsMentionedNotCalled !== undefined) {
      issues.push(issue('schema', `entry \`${name}\`.toolsMentionedNotCalled must be an array.`, 'List tools the SKILL.md merely names in prose, or drop the key.', where));
    }

    for (const [field, list] of [['tools', declaredTools || []], ['toolsMentionedNotCalled', proseTools]]) {
      issues.push(...checkStringArray(list, `${name}.${field}`, where));
      for (const tool of list) {
        if (typeof tool !== 'string') continue;
        if (!toolNames.has(tool)) {
          issues.push(issue(
            'unknown-tool',
            `entry \`${name}\`.${field} names \`${tool}\`, which is not in the router's MCP tool catalog.`,
            'Fix the spelling, or drop it — the tool was probably renamed or removed in src/index.mjs.',
            where,
          ));
        }
      }
    }

    // --- the declared tools must IMPLY no more than the declaration admits ---
    //
    // This is the most direct way a contract could understate a skill: list
    // `delete_file` under `tools` and still claim `writeMode: read-only`,
    // `writes: []`, `network: false`. Every check below derives its lower
    // bound from the router's OWN classification of its tools, so the
    // manifest can never be gentler than the code it describes.
    if (declaredTools !== null && WRITE_MODE_RANK[entry.writeMode] !== undefined) {
      const called = declaredTools.filter((t) => typeof t === 'string');
      const writeTools = called.filter((t) => writeToolNames.has(t));
      const destructive = called.filter((t) => DESTRUCTIVE_TOOLS.includes(t));

      if (writeTools.length > 0 && entry.writeMode === 'read-only') {
        issues.push(issue(
          'understated',
          `entry \`${name}\` claims writeMode \`read-only\` but calls ${writeTools.length} write tool(s): ${writeTools.join(', ')}.`,
          'Move the tool to `toolsMentionedNotCalled` if the page only names it, otherwise raise `writeMode` and list what it writes.',
          where,
        ));
      }
      if (writeTools.length > 0 && Array.isArray(entry.writes) && entry.writes.length === 0) {
        issues.push(issue(
          'understated',
          `entry \`${name}\` declares no write atoms but calls write tool(s): ${writeTools.join(', ')}.`,
          'List what those writes touch (vault:content, vault:derived, …).',
          where,
        ));
      }
      // `destructive` with no "…or transactional" escape hatch. That
      // concession contradicted TOOL_WRITE_FLOOR, and it was wrong on the
      // facts: `write_bundle` deliberately has no `move` step (C2 left it
      // out because a half-undone move is worse than no undo), so a skill
      // that moves files always does so OUTSIDE the transaction.
      if (destructive.length > 0
          && WRITE_MODE_RANK[entry.writeMode] < WRITE_MODE_RANK.destructive) {
        issues.push(issue(
          'understated',
          `entry \`${name}\` calls ${destructive.join(', ')} but declares writeMode \`${entry.writeMode}\`.`,
          'A skill that can delete or move must declare `destructive`. `transactional` does not cover it: write_bundle has no move step, so those calls run outside any rollback.',
          where,
        ));
      }

      // Per-tool floors — the general case behind the two extremes above.
      for (const tool of called) {
        const floor = TOOL_WRITE_FLOOR[tool];
        if (!floor) continue;
        if (WRITE_MODE_RANK[entry.writeMode] < WRITE_MODE_RANK[floor.mode]) {
          issues.push(issue(
            'understated',
            `entry \`${name}\` calls \`${tool}\` but declares writeMode \`${entry.writeMode}\`, weaker than the \`${floor.mode}\` that tool implies.`,
            `Raise writeMode to at least \`${floor.mode}\`, or move the tool to \`toolsMentionedNotCalled\` if the page only names it.`,
            where,
          ));
        }
        if (floor.atom && Array.isArray(entry.writes) && !entry.writes.includes(floor.atom)) {
          issues.push(issue(
            'understated',
            `entry \`${name}\` calls \`${tool}\` but does not declare the \`${floor.atom}\` write atom.`,
            `Add \`${floor.atom}\` to \`writes\`.`,
            where,
          ));
        }
      }
      for (const tool of called) {
        const atom = TOOL_READ_FLOOR[tool];
        if (!atom) continue;
        if (Array.isArray(entry.reads) && !entry.reads.includes(atom)) {
          issues.push(issue(
            'understated',
            `entry \`${name}\` calls \`${tool}\` but does not declare the \`${atom}\` read atom.`,
            `Add \`${atom}\` to \`reads\` — a skill that calls it necessarily reads that.`,
            where,
          ));
        }
      }
      if (requires && typeof requires === 'object') {
        for (const [flag, set, label] of [
          ['network', NETWORK_TOOLS, 'reaches the internet'],
          ['python', PYTHON_TOOLS, 'needs the Python toolchain'],
        ]) {
          const hits = called.filter((t) => set.includes(t));
          if (hits.length > 0 && requires[flag] !== true) {
            issues.push(issue(
              'understated',
              `entry \`${name}\` calls ${hits.join(', ')} — which ${label} — but declares requires.${flag}: ${JSON.stringify(requires[flag])}.`,
              `Set requires.${flag} to true.`,
              where,
            ));
          }
        }
      }
    }

    // --- host capabilities the page reaches for directly ---
    //
    // Router-tool scanning is blind to Bash and WebFetch, which is exactly
    // where `requires.shell` / `requires.network` would otherwise sit at
    // false on the skills that need them most.
    if (skillByName.has(name) && requires && typeof requires === 'object') {
      for (const [flag, label] of mentionedHostCapabilities(skillByName.get(name).text)) {
        if (requires[flag] !== true) {
          issues.push(issue(
            'understated',
            `${skillByName.get(name).skillMdPath} reaches for ${label}, but the contract declares requires.${flag}: ${JSON.stringify(requires[flag])}.`,
            `Set requires.${flag} to true. If the mention is incidental prose, reword the page — the scan is deliberately generous because a missed host capability is invisible to every router-side guard.`,
            where,
          ));
        }
      }
    }

    // A tool listed in both lists is a contradiction: it either is called or
    // it is not. Left unchecked, a reviewer "fixing" a mention drift by
    // pasting into both lists would neutralize the mention check forever.
    for (const tool of proseTools) {
      if ((declaredTools || []).includes(tool)) {
        issues.push(issue(
          'inconsistent',
          `entry \`${name}\` lists \`${tool}\` in BOTH tools and toolsMentionedNotCalled.`,
          'Pick one: `tools` if the skill calls it, `toolsMentionedNotCalled` if the SKILL.md only names it in prose.',
          where,
        ));
      }
    }

    // --- delegatesTo: every named skill must exist ---
    if (entry.delegatesTo !== undefined) {
      if (!Array.isArray(entry.delegatesTo)) {
        issues.push(issue('schema', `entry \`${name}\`.delegatesTo must be an array.`, 'List the skill names this skill invokes, or drop the key.', where));
      } else {
        issues.push(...checkStringArray(entry.delegatesTo, `${name}.delegatesTo`, where));
        for (const target of entry.delegatesTo) {
          if (typeof target !== 'string') continue;
          if (!skillByName.has(target)) {
            issues.push(issue(
              'unknown-delegate',
              `entry \`${name}\` delegates to \`${target}\`, which is not a shipped skill.`,
              'Fix the name or drop it — a delegation edge pointing at nothing hides real reach from the permission model.',
              where,
            ));
          }
          if (target === name) {
            issues.push(issue('inconsistent', `entry \`${name}\` delegates to itself.`, 'Remove the self-edge.', where));
          }
        }
      }
    }

    // --- doc↔manifest: every SKILL the page names must be an edge ---------
    //
    // The delegation-closure checks below bind DECLARED edges only, so a
    // contract could stay `read-only` while its page says "invoke the
    // wiki-ingest skill" — understatement by omission, and the closure
    // machinery never runs. Tool mentions are already accounted for one by
    // one; skill mentions get the same treatment.
    if (skillByName.has(name)) {
      const page = skillByName.get(name);
      const declaredEdges = new Set(Array.isArray(entry.delegatesTo) ? entry.delegatesTo : []);
      const disclaimed = new Set(
        Array.isArray(entry.skillsMentionedNotInvoked) ? entry.skillsMentionedNotInvoked : [],
      );
      for (const s of disclaimed) {
        if (declaredEdges.has(s)) {
          issues.push(issue(
            'inconsistent',
            `entry \`${name}\` lists \`${s}\` in BOTH delegatesTo and skillsMentionedNotInvoked.`,
            'Pick one: it is either a delegation or it is not.',
            where,
          ));
        }
      }
      const namedSkills = mentionedSkills(page.text, skillByName.keys(), name);
      const unaccounted = [...namedSkills].filter((s) => !declaredEdges.has(s) && !disclaimed.has(s)).sort();
      if (unaccounted.length > 0) {
        issues.push(issue(
          'unaccounted-delegation',
          `${page.skillMdPath} tells the reader to invoke ${unaccounted.length} other skill(s) the contract does not declare: ${unaccounted.join(', ')}.`,
          'Add each to `delegatesTo` (and widen this entry to cover the delegate, which the validator then enforces), or to `skillsMentionedNotInvoked` with the reason in the verification note if the page only hands control BACK to a caller.',
          page.skillMdPath,
        ));
      }
    }

    // --- doc↔manifest: every tool the SKILL.md NAMES must be accounted for ---
    const skill = skillByName.get(name);
    if (skill && declaredTools !== null) {
      const mentioned = mentionedTools(skill.text, toolNames);
      const accounted = new Set([...declaredTools, ...proseTools]);
      const unaccounted = [...mentioned].filter((t) => !accounted.has(t)).sort();
      if (unaccounted.length > 0) {
        issues.push(issue(
          'unaccounted-tool-mention',
          `${skill.skillMdPath} names ${unaccounted.length} router tool(s) the contract does not account for: ${unaccounted.join(', ')}.`,
          `Add each to \`tools\` (the skill calls it) or to \`toolsMentionedNotCalled\` (the prose only names it). This is the check that fires when a skill gains a new tool call.`,
          skill.skillMdPath,
        ));
      }
    }

    // --- verification: the honesty rule ---
    const v = entry.verification;
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      issues.push(issue(
        'honesty',
        `entry \`${name}\` has no \`verification\` block.`,
        'Add `verification: { status: "declared", reason: "<why nothing checks this>" }`. A capability with no behavioral verifier must SAY so.',
        where,
      ));
      continue;
    }
    if (!VERIFICATION_STATUSES.includes(v.status)) {
      issues.push(issue(
        'honesty',
        `entry \`${name}\`.verification.status is ${JSON.stringify(v.status)}.`,
        `Use one of: ${VERIFICATION_STATUSES.join(', ')}.`,
        where,
      ));
      continue;
    }
    for (const key of Object.keys(v)) {
      if (!VERIFICATION_KEYS[v.status].includes(key)) {
        issues.push(issue(
          'honesty',
          `entry \`${name}\`.verification has key \`${key}\`, which \`${v.status}\` does not allow.`,
          `A \`${v.status}\` block takes only: ${VERIFICATION_KEYS[v.status].join(', ')}. An unrecognized key is a claim nothing validates.`,
          where,
        ));
      }
    }

    if (v.status === 'declared') {
      if (typeof v.reason !== 'string' || v.reason.trim() === '') {
        issues.push(issue(
          'honesty',
          `entry \`${name}\` is \`declared\` with no written reason.`,
          'Write why nothing checks this contract. "declared" without a reason is the exact dishonesty this rule exists to prevent.',
          where,
        ));
      }
    }

    // An untouched bootstrap proposal must never pass. See BOOTSTRAP_SENTINEL.
    if (typeof v.reason === 'string' && v.reason.includes(BOOTSTRAP_SENTINEL)) {
      issues.push(issue(
        'unreviewed-bootstrap',
        `entry \`${name}\` still carries the ${BOOTSTRAP_SENTINEL} marker.`,
        `Read ${skillByName.has(name) ? skillByName.get(name).skillMdPath : `skills/${name}/SKILL.md`}, correct the generated reads/writes/tools/requires, then replace the reason with a real one. The bootstrap is a proposal, not a truth.`,
        where,
      ));
    }

    if (v.status === 'verified') {
      const evidence = Array.isArray(v.evidence) ? v.evidence : null;
      if (!evidence || evidence.length === 0) {
        issues.push(issue(
          'honesty',
          `entry \`${name}\` claims \`verified\` with no \`evidence\`.`,
          'List the test file(s) that behaviorally exercise this contract, or drop to `declared` with a reason. No skill qualifies today.',
          where,
        ));
      } else {
        issues.push(...checkStringArray(evidence, `${name}.verification.evidence`, where));
        for (const rel of evidence) {
          if (typeof rel !== 'string' || rel.trim() === '') continue;
          issues.push(...checkEvidenceFile({ repoRoot, name, rel, where }));
        }
      }
    }
  }

  // --- (4) skill identity: the page must not claim to be another skill ----
  for (const skill of skills) {
    if (skill.declaredName && skill.declaredName !== skill.name) {
      issues.push(issue(
        'inconsistent',
        `${skill.skillMdPath} declares \`name: ${skill.declaredName}\` but lives in \`skills/${skill.name}/\`.`,
        'Make the frontmatter name match the directory. They are the same identity, and the contract is keyed on the directory — a mismatch means the page and the manifest describe different things.',
        skill.skillMdPath,
      ));
    }
  }

  // --- (5) delegation must not launder reach ------------------------------
  //
  // A skill that invokes another one can do everything that one can. If the
  // parent could declare `read-only` while delegating to a destructive,
  // networked skill, `delegatesTo` would become a way to HIDE reach rather
  // than record it — the opposite of why the field exists.
  for (const name of declaredNames) {
    const entry = entries[name];
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.delegatesTo)) continue;
    const where = `${DECLARATIONS_PATH} → skills.${name}`;

    const cycle = findDelegationCycle(name, entries);
    if (cycle) {
      issues.push(issue(
        'inconsistent',
        `delegation cycle: ${cycle.join(' → ')}.`,
        'Break the cycle — a permission engine computing the transitive closure would not terminate.',
        where,
      ));
      continue;
    }

    for (const target of entry.delegatesTo) {
      const child = entries[target];
      if (!child || typeof child !== 'object') continue;
      if (WRITE_MODE_RANK[entry.writeMode] !== undefined
          && WRITE_MODE_RANK[child.writeMode] !== undefined
          && WRITE_MODE_RANK[entry.writeMode] < WRITE_MODE_RANK[child.writeMode]) {
        issues.push(issue(
          'understated',
          `entry \`${name}\` is writeMode \`${entry.writeMode}\` but delegates to \`${target}\`, which is \`${child.writeMode}\`.`,
          `Raise \`${name}\` to at least \`${child.writeMode}\` — invoking a skill grants everything that skill can do.`,
          where,
        ));
      }
      for (const flag of ['shell', 'network', 'python']) {
        if (child.requires && child.requires[flag] === true
            && !(entry.requires && entry.requires[flag] === true)) {
          issues.push(issue(
            'understated',
            `entry \`${name}\` declares requires.${flag}: false but delegates to \`${target}\`, which requires it.`,
            `Set requires.${flag} to true on \`${name}\` — the delegate's needs are the caller's needs.`,
            where,
          ));
        }
      }
      // The list-valued prerequisites travel the same way. A parent with an
      // empty `binaries` that delegates to a skill needing `git` is telling
      // a deployment it can run without git; it cannot.
      for (const key of ['obsidianPlugins', 'binaries']) {
        const childList = child.requires && Array.isArray(child.requires[key]) ? child.requires[key] : [];
        const parentList = entry.requires && Array.isArray(entry.requires[key]) ? entry.requires[key] : [];
        const missing = childList.filter((v) => !parentList.includes(v));
        if (missing.length > 0) {
          issues.push(issue(
            'understated',
            `entry \`${name}\` delegates to \`${target}\` but omits ${missing.length} requires.${key} entr(y/ies) the delegate needs: ${missing.join(', ')}.`,
            `Add them to \`${name}\`.requires.${key}.`,
            where,
          ));
        }
      }
      for (const [field, vocabLabel] of [['reads', 'read'], ['writes', 'write']]) {
        if (!Array.isArray(entry[field]) || !Array.isArray(child[field])) continue;
        const missing = child[field].filter((a) => !entry[field].includes(a));
        if (missing.length > 0) {
          issues.push(issue(
            'understated',
            `entry \`${name}\` delegates to \`${target}\` but omits ${missing.length} ${vocabLabel} atom(s) the delegate declares: ${missing.join(', ')}.`,
            `Add them to \`${name}\`.${field} — the parent's declaration must cover the closure, not just its own calls.`,
            where,
          ));
        }
      }
    }
  }

  // --- (6) an agent whose allowlist could not be parsed ---------------------
  for (const [agentName, agent] of agents) {
    if (agent.allowlistParsed) continue;
    if (!Object.prototype.hasOwnProperty.call(entries, agentName)) continue;
    issues.push(issue(
      'agent-allowlist-unreadable',
      `${agent.file} has a same-named skill contract, but its \`tools:\` allowlist could not be read.`,
      'The frontmatter `tools:` must be a single comma-separated line. A block list or a missing key silently disables the allowlist cross-check for this agent — which is a check that has switched itself off.',
      agent.file,
    ));
  }

  return issues;
}

/**
 * Depth-first search for a delegation cycle starting at `start`.
 * Returns the cycle as a path, or null.
 */
function findDelegationCycle(start, entries) {
  const stack = [];
  const onStack = new Set();
  const seen = new Set();
  const walk = (node) => {
    if (onStack.has(node)) { stack.push(node); return true; }
    if (seen.has(node)) return false;
    seen.add(node);
    onStack.add(node);
    stack.push(node);
    const e = entries[node];
    const kids = e && Array.isArray(e.delegatesTo) ? e.delegatesTo : [];
    for (const k of kids) {
      if (typeof k === 'string' && walk(k)) return true;
    }
    onStack.delete(node);
    stack.pop();
    return false;
  };
  return walk(start) ? stack : null;
}

/**
 * Cross-check the sub-agent tool allowlists against the contracts.
 *
 * `agents/wiki-ingest.md` and `agents/wiki-lint.md` are constrained
 * executions of the same-named skills: the harness refuses any tool outside
 * their `tools:` frontmatter. So the allowlist must never grant MORE router
 * tools than the skill's contract declares — if someone adds `delete_file`
 * to the wiki-lint agent while the contract still says the skill never
 * deletes, one of the two is lying, and this is the check that says which.
 *
 * Non-router entries (`Read`, `Glob`, `WebFetch`, …) are harness tools, not
 * router tools, and are out of this contract's scope — they are filtered out
 * rather than reported, otherwise every agent would fail forever.
 *
 * Deliberately NOT the reverse direction: an agent allowlist SMALLER than
 * the contract is fine and normal — the batch path is a subset of what the
 * skill can do in-process.
 */
export function checkAgentAllowlists({ agents, declarations, toolNames }) {
  const issues = [];
  const entries = (declarations && declarations.skills) || {};
  const known = toolNames instanceof Set ? toolNames : new Set(toolNames || []);
  for (const [agentName, agent] of agents) {
    // A namespaced grant that names no catalog tool is dead weight at best
    // and a rotted permission at worst — and the harness-tool filter below
    // would otherwise absorb it without a word.
    for (const ref of agent.routerRefs || []) {
      if (!known.has(ref)) {
        issues.push(issue(
          'unknown-tool',
          `${agent.file} grants \`${ref}\` as a router tool, but no such tool is in the catalog.`,
          'Fix the spelling or remove the grant — it was probably renamed or removed in src/index.mjs, and a grant that resolves to nothing hides that from every reader.',
          agent.file,
        ));
      }
    }
    const entry = entries[agentName];
    if (!entry || !Array.isArray(entry.tools)) continue; // no same-named skill
    const declared = new Set(entry.tools);
    const excess = [...agent.tools].filter((t) => known.has(t) && !declared.has(t)).sort();
    if (excess.length > 0) {
      issues.push(issue(
        'agent-exceeds-contract',
        `${agent.file} grants ${excess.length} router tool(s) that the \`${agentName}\` contract does not declare: ${excess.join(', ')}.`,
        `Either add them to skills.${agentName}.tools in ${DECLARATIONS_PATH} (the skill really does use them) or remove them from the agent's \`tools:\` frontmatter. The sub-agent must not be able to reach past its own skill's contract.`,
        agent.file,
      ));
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Doc counters — the third leg
// ---------------------------------------------------------------------------

/**
 * The counter sites the validator OWNS.
 *
 * Why an explicit allowlist instead of scanning every markdown file: most
 * "N skills" strings in this repo are HISTORY — `docs/announcements.md`
 * records what v0.19 shipped, `docs/v0.10.2-skills-promotion.md` describes
 * a past migration, `ROADMAP.md` and `CHANGELOG.md` narrate past phases.
 * A blanket scan would demand rewriting the past to make the present pass,
 * which is worse than the drift it fixes. Only statements about the CURRENT
 * state are checked, and adding a site here is a deliberate act.
 *
 * `pattern` must carry exactly one capture group: the number. EVERY match in
 * the file is checked, so the rule survives paragraphs moving around.
 *
 * `minMatches` pins how many sites the rule is known to cover. Checking only
 * "at least one match" is not enough: a README that states its command count
 * in six places could lose five of them to a rewrite and still pass, leaving
 * one guarded sentence where there used to be six. A drop below `minMatches`
 * is reported, so shrinking the guarded surface is a deliberate edit here
 * rather than an accident there.
 */
export const COUNTER_RULES = Object.freeze([
  {
    id: 'readme-commands',
    file: 'README.md',
    pattern: /(\d+) slash commands/g,
    counts: 'commands',
    label: 'slash commands',
    minMatches: 6,
  },
  {
    id: 'readme-skills',
    file: 'README.md',
    pattern: /(\d+) skills/g,
    counts: 'skills',
    label: 'skills',
    minMatches: 5,
  },
  {
    id: 'readme-hooks',
    file: 'README.md',
    pattern: /(\d+) hooks Node/g,
    counts: 'hooks',
    label: 'Node hooks',
    minMatches: 1,
  },
  {
    id: 'architecture-tools',
    file: 'docs/architecture.md',
    pattern: /(\d+) MCP tools/g,
    counts: 'tools',
    label: 'MCP tools',
    minMatches: 1,
  },
  // The two quick-reference pages. They were NOT pinned until v0.90.0, and
  // they are the artifact with the widest readership — linked from both README
  // halves, and the page someone prints. Unwatched, they went a whole
  // catalogue behind: both claimed 51 slash commands, 51 MCP tools and 47
  // skills while the README, which IS pinned, stayed correct at 53/53/48. The
  // gate covered the documents it had been pointed at rather than the class of
  // documents carrying the claim, which is the failure this repository keeps
  // paying for. Each page states its three counts twice — the masthead and the
  // section heading — so `minMatches: 2` makes losing one of the two sites a
  // deliberate edit here rather than an accident there.
  //
  // The FR page deliberately has no `commandes` rule: it heads its categories
  // "3 commandes d'état", "2 commandes de liaison", "24 commandes de gestion",
  // and a rule matching those sub-counts against the TOTAL would fail forever.
  // `slash commands` is untranslated in both pages and is the total.
  {
    id: 'quick-reference-en-commands',
    file: 'docs/quick-reference-en.html',
    pattern: /(\d+) slash commands/g,
    counts: 'commands',
    label: 'slash commands',
    minMatches: 2,
  },
  {
    id: 'quick-reference-en-tools',
    file: 'docs/quick-reference-en.html',
    pattern: /(\d+) MCP tools/g,
    counts: 'tools',
    label: 'MCP tools',
    minMatches: 2,
  },
  {
    id: 'quick-reference-en-skills',
    file: 'docs/quick-reference-en.html',
    pattern: /(\d+) skills/g,
    counts: 'skills',
    label: 'skills',
    minMatches: 2,
  },
  {
    id: 'quick-reference-fr-commands',
    file: 'docs/quick-reference-fr.html',
    pattern: /(\d+) slash commands/g,
    counts: 'commands',
    label: 'slash commands',
    minMatches: 2,
  },
  {
    id: 'quick-reference-fr-tools',
    file: 'docs/quick-reference-fr.html',
    pattern: /(\d+) outils MCP/g,
    counts: 'tools',
    label: 'outils MCP',
    minMatches: 2,
  },
  {
    id: 'quick-reference-fr-skills',
    file: 'docs/quick-reference-fr.html',
    pattern: /(\d+) skills/g,
    counts: 'skills',
    label: 'skills',
    minMatches: 2,
  },
  {
    id: 'plugin-commands',
    file: '.claude-plugin/plugin.json',
    pattern: /(\d+) \/obsidian-router:\* commands/g,
    counts: 'commands',
    label: 'slash commands',
    minMatches: 1,
  },
  {
    id: 'plugin-skills',
    file: '.claude-plugin/plugin.json',
    pattern: /(\d+) skills/g,
    counts: 'skills',
    label: 'skills',
    minMatches: 1,
  },
  {
    id: 'plugin-agents',
    file: '.claude-plugin/plugin.json',
    pattern: /(\d+) parallel sub-agents/g,
    counts: 'agents',
    label: 'sub-agents',
    minMatches: 1,
  },
  {
    id: 'marketplace-commands-total',
    file: '.claude-plugin/marketplace.json',
    pattern: /(\d+) commands total/g,
    counts: 'commands',
    label: 'slash commands',
    minMatches: 1,
  },
  {
    id: 'marketplace-commands',
    file: '.claude-plugin/marketplace.json',
    pattern: /(\d+) \/obsidian-router:\* commands/g,
    counts: 'commands',
    label: 'slash commands',
    minMatches: 1,
  },
]);

/**
 * Count the artifacts the counter rules refer to. These definitions must
 * match what the docs mean by the word, so they are spelled out rather than
 * inferred:
 *   - skills   — directories under `skills/` holding a SKILL.md
 *   - commands — `commands/*.md`, one slash command each
 *   - agents   — `agents/*.md`
 *   - hooks    — `hooks/*.mjs`, excluding `_`-prefixed shared libraries
 *   - tools    — the router's full MCP catalog (`TOOLS` in src/index.mjs),
 *                i.e. what the docs call "the router's catalog". Runtime
 *                gates can expose fewer; the catalog size is the published
 *                number.
 */
export function countArtifacts(repoRoot, { toolCount = null } = {}) {
  const errors = [];
  // An UNREADABLE directory must never become a count of zero. It used to,
  // and that is the silent-failure shape this module exists to prevent: if
  // `commands/` stopped being listable, the count would read 0, and a doc
  // that also said 0 would agree with it — a green build over a check that
  // had stopped working.
  const listDir = (rel, filter) => {
    try {
      return fs.readdirSync(path.join(repoRoot, rel), { withFileTypes: true }).filter(filter).length;
    } catch (err) {
      errors.push({ dir: rel, error: err.message });
      return null;
    }
  };
  return {
    skills: discoverSkills(repoRoot).length,
    commands: listDir('commands', (e) => e.isFile() && e.name.endsWith('.md')),
    agents: listDir('agents', (e) => e.isFile() && e.name.endsWith('.md')),
    hooks: listDir('hooks', (e) => e.isFile() && e.name.endsWith('.mjs') && !e.name.startsWith('_')),
    tools: toolCount,
    errors,
  };
}

/**
 * Check every counter site against the real counts.
 *
 * A rule whose file is missing, or whose pattern matches nothing, is itself
 * reported: a counter rule that silently stops matching is a check that has
 * quietly switched itself off — the failure mode this whole module exists to
 * prevent.
 */
/**
 * Remove markdown emphasis around numbers before a counter rule matches.
 *
 * `**9** skills` slipped past a pattern expecting `9 skills`, so a genuinely
 * wrong published number survived while a correct plain occurrence elsewhere
 * kept the rule from reporting that it had stopped matching.
 *
 * EXPORTED so the test suite uses this exact function instead of keeping its
 * own copy of the regex — two copies drift, and the copy in the test would
 * have gone on "passing" against a production regex that had changed.
 */
export function stripEmphasis(text) {
  return String(text ?? '').replace(/\*\*|\*(?=\d)|(?<=\d)\*/g, '');
}

export function checkDocCounters(repoRoot, counts) {
  const issues = [];

  for (const e of counts.errors || []) {
    issues.push(issue(
      'artifact-count-unreadable',
      `cannot list \`${e.dir}/\` (${e.error}) — the artifact count is unknown, not zero.`,
      'Fix the directory. Until then no counter that depends on it can be trusted, so none is checked.',
      e.dir,
    ));
  }

  for (const rule of COUNTER_RULES) {
    const abs = path.join(repoRoot, rule.file);
    const text = readSafe(abs);
    if (text === null) {
      issues.push(issue(
        'counter-site-missing',
        `counter rule \`${rule.id}\` targets ${rule.file}, which does not exist.`,
        'Restore the file, or remove the rule from COUNTER_RULES in src/helpers/skill-capabilities.mjs.',
        rule.file,
        { ruleId: rule.id },
      ));
      continue;
    }
    const expected = counts[rule.counts];
    if (typeof expected !== 'number') {
      issues.push(issue(
        'counter-site-missing',
        `counter rule \`${rule.id}\` counts \`${rule.counts}\`, which the validator could not determine.`,
        'Check countArtifacts() — an artifact directory is probably unreadable, or the tool catalog was not injected.',
        rule.file,
        { ruleId: rule.id },
      ));
      continue;
    }
    const flat = stripEmphasis(text);
    const matches = [...flat.matchAll(new RegExp(rule.pattern.source, rule.pattern.flags))];
    const minMatches = Number.isFinite(rule.minMatches) ? rule.minMatches : 1;
    if (matches.length < minMatches) {
      issues.push(issue(
        'counter-site-missing',
        matches.length === 0
          ? `counter rule \`${rule.id}\` matched nothing in ${rule.file}.`
          : `counter rule \`${rule.id}\` now matches ${matches.length} site(s) in ${rule.file}, down from the ${minMatches} it is meant to guard.`,
        `A sentence it watches was reworded or removed. Restore it, or update the rule's \`pattern\`/\`minMatches\` in COUNTER_RULES — shrinking the guarded surface must be a deliberate edit, not a side effect.`,
        rule.file,
        { ruleId: rule.id },
      ));
      continue;
    }
    const wrong = matches.map((m) => Number(m[1])).filter((n) => n !== expected);
    if (wrong.length > 0) {
      const seen = [...new Set(wrong)].join(', ');
      issues.push(issue(
        'doc-counter',
        `${rule.file} claims ${seen} ${rule.label}; the repo has ${expected}.`,
        `Update every "${seen} ${rule.label}" occurrence in ${rule.file} to ${expected}.`,
        rule.file,
        { ruleId: rule.id },
      ));
    }
  }
  return issues;
}

/**
 * Self-consistency of the "N MCP tools: cat (a), cat (b), …" breakdown in
 * docs/architecture.md. Cheap, needs no coupling to the code, and catches the
 * commonest way that sentence rots: someone fixes the total and forgets a
 * category (or the reverse).
 */
export function checkToolBreakdown(repoRoot) {
  const rel = 'docs/architecture.md';
  const text = readSafe(path.join(repoRoot, rel));

  // Every absent structural element is LOUD. The first version of this
  // function returned [] for a missing file, a missing sentence and a
  // missing category list alike — so deleting or reformatting the breakdown
  // disabled the check while CI stayed green. That is the precise
  // "a check that silently stops checking" failure this module is built to
  // prevent, and it had a test asserting the silence was correct.
  if (text === null) {
    return [issue(
      'counter-site-missing',
      `${rel} does not exist, so the MCP-tool breakdown cannot be checked.`,
      'Restore the file, or remove this check and its counter rule together.',
      rel,
      { ruleId: 'architecture-tool-breakdown' },
    )];
  }
  // EVERY breakdown sentence in the file, not just the first: a second,
  // contradictory one further down used to be invisible.
  const all = [...text.matchAll(/\*\*(\d+) MCP tools\*\*:([^\n]*)/g)];
  const m = all[0];
  if (!m) {
    return [issue(
      'counter-site-missing',
      `${rel} no longer carries a "**N MCP tools**:" sentence — the breakdown check has nothing to verify.`,
      'Restore the sentence in its "**N MCP tools**: category (n), …" form, or update checkToolBreakdown to match the new wording.',
      rel,
      { ruleId: 'architecture-tool-breakdown' },
    )];
  }
  const out = [];
  for (const hit of all.slice(1)) {
    const t2 = Number(hit[1]);
    const p2 = [...hit[2].matchAll(/\((\d+)\)/g)].map((x) => Number(x[1]));
    if (p2.length === 0) {
      // `continue` here contradicted the promise one paragraph above that
      // every absent structural element is loud: a second sentence that lost
      // its category list went unchecked forever.
      out.push(issue(
        'counter-site-missing',
        `${rel} has a further "${t2} MCP tools" sentence with no per-category counts, so its sum cannot be checked.`,
        'Give it a "category (n), …" breakdown, or remove the duplicate sentence.',
        rel,
        { ruleId: 'architecture-tool-breakdown' },
      ));
      continue;
    }
    const s2 = p2.reduce((a, b) => a + b, 0);
    if (s2 !== t2) {
      out.push(issue(
        'doc-counter',
        `${rel} has a further "${t2} MCP tools" breakdown that sums to ${s2}.`,
        `Fix those category counts so they add up to ${t2}, or remove the duplicate sentence.`,
        rel,
        { ruleId: 'architecture-tool-breakdown' },
      ));
    }
  }
  const total = Number(m[1]);
  const parts = [...m[2].matchAll(/\((\d+)\)/g)].map((x) => Number(x[1]));
  if (parts.length === 0) {
    return [issue(
      'counter-site-missing',
      `${rel} states "${total} MCP tools" but lists no per-category counts, so the sum cannot be checked.`,
      'Restore the "category (n), category (n), …" breakdown after the total.',
      rel,
      { ruleId: 'architecture-tool-breakdown' },
    ), ...out];
  }
  const sum = parts.reduce((a, b) => a + b, 0);
  if (sum !== total) {
    out.unshift(issue(
      'doc-counter',
      `${rel} says "${total} MCP tools" but its per-category breakdown sums to ${sum}.`,
      `Fix the category counts so they add up to ${total}.`,
      rel,
      { ruleId: 'architecture-tool-breakdown' },
    ));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

/**
 * The quick-reference PDFs must have been rendered from the pages as they
 * stand now.
 *
 * Pinning the counters in the two HTML sources (COUNTER_RULES above) is only
 * half the guard. The artifact people actually read is the PDF — that is what
 * both READMEs link and what someone prints — and it is a SEPARATE file that
 * somebody has to remember to regenerate. Fix the HTML, forget the render, and
 * the counter rules go green over a PDF that still carries the old number:
 * the same drift one step further along, and harder to see because the source
 * now looks right.
 *
 * So `scripts/render-quick-reference.mjs` records the sha256 of each page it
 * rendered from, and this check refuses when a page has moved since. Every
 * page is reported in one of its own states — missing source, missing PDF,
 * never recorded, stale — because a check that quietly skips what it cannot
 * find is the exact failure this module exists to prevent.
 *
 * @param {string} repoRoot
 * @param {(root: string) => Array} [freshness] — injected for the tests, which
 *        drive fixture repositories without a Chrome anywhere near them.
 */
export function checkQuickReferenceFreshness(repoRoot, freshness = quickReferenceFreshness) {
  const issues = [];
  let rows;
  try {
    rows = freshness(repoRoot);
  } catch (err) {
    return [issue(
      'quick-reference-unreadable',
      `the quick-reference freshness check could not run (${err && err.message}).`,
      'Fix scripts/render-quick-reference.mjs — until it runs, the PDFs are unverified, not verified.',
      QUICK_REFERENCE_MANIFEST,
    )];
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    return [issue(
      'quick-reference-unreadable',
      'the quick-reference freshness check reported no pages at all.',
      'QUICK_REFERENCE_PAGES in scripts/render-quick-reference.mjs is empty — a check with nothing to check is not a passing check.',
      QUICK_REFERENCE_MANIFEST,
    )];
  }

  const RENDER = 'Run `npm run docs:quick-reference` to re-render both PDFs and refresh the manifest.';
  for (const row of rows) {
    if (row.state === 'fresh') continue;
    if (row.state === 'html-missing') {
      issues.push(issue(
        'quick-reference-missing',
        `${row.html} does not exist, but the validator watches it.`,
        `Restore the page, or drop its language from QUICK_REFERENCE_PAGES and its rules from COUNTER_RULES — together.`,
        row.html,
      ));
    } else if (row.state === 'pdf-missing') {
      issues.push(issue(
        'quick-reference-missing',
        `${row.pdf} does not exist, but ${row.html} does — the page nobody can read is the published one.`,
        RENDER,
        row.pdf,
      ));
    } else if (row.state === 'unrecorded') {
      issues.push(issue(
        'quick-reference-stale',
        `nothing records which version of ${row.html} produced ${row.pdf}.`,
        RENDER,
        QUICK_REFERENCE_MANIFEST,
      ));
    } else {
      issues.push(issue(
        'quick-reference-stale',
        `${row.html} has changed since ${row.pdf} was rendered — the PDF still carries the older page.`,
        RENDER,
        row.pdf,
      ));
    }
  }
  return issues;
}

/**
 * Run every C8 check against a repo root.
 *
 * @param {string} repoRoot
 * @param {object} opts
 * @param {string[]|Set} opts.toolNames — the router's MCP tool catalog.
 *        Injected rather than imported so tests can drive a fixture repo
 *        without booting the server, and so a fixture can pin a tool set.
 * @returns {{ issues: Array, counts: object, skillCount: number }}
 */
export function runCapabilityValidation(repoRoot, { toolNames, writeToolNames } = {}) {
  const issues = [];

  // "Not supplied" is NOT "supplied empty". Without this, calling
  // runCapabilityValidation(repoRoot) with no catalog produced an empty set,
  // a determinate tool count of 0, and a confident verdict about a catalog
  // it had never seen — the "could not determine" guard was bypassed by the
  // very default that was supposed to be harmless.
  const catalogSupplied = toolNames !== undefined && toolNames !== null;
  const names = toolNames instanceof Set ? toolNames : new Set(toolNames || []);
  if (!catalogSupplied) {
    issues.push(issue(
      'schema',
      'the router MCP tool catalog was not supplied to the validator.',
      'Pass `toolNames` (from `_internals.TOOLS`). Without it every declared tool would look unknown and the tool count would read 0.',
      'src/helpers/skill-capabilities.mjs',
    ));
  }

  const skills = discoverSkills(repoRoot);
  const agents = discoverAgents(repoRoot);
  const counts = countArtifacts(repoRoot, { toolCount: catalogSupplied ? names.size : null });

  const decl = readDeclarations(repoRoot);
  if (!decl.ok) {
    issues.push(issue(
      'schema',
      decl.error,
      'Create the declarations file (`npm run capabilities:bootstrap` writes a reviewable proposal) or fix its JSON.',
      DECLARATIONS_PATH,
    ));
  } else if (catalogSupplied) {
    // Pass the CALLER'S value through, not a normalized Set.
    //
    // The round-1 fix made a missing `writeToolNames` a loud finding inside
    // validateDeclarations — and this wrapper then defeated it by turning
    // `undefined` into `new Set()` before the call, so the guard saw a
    // supplied-but-empty set and every write-understatement check switched
    // itself off in exactly the production path. The test caught nothing
    // because it called validateDeclarations directly.
    issues.push(...validateDeclarations({
      skills, agents, toolNames: names, writeToolNames,
      declarations: decl.data, repoRoot,
    }));
    issues.push(...checkAgentAllowlists({ agents, declarations: decl.data, toolNames: names }));
  }

  issues.push(...checkDocCounters(repoRoot, counts));
  issues.push(...checkToolBreakdown(repoRoot));
  issues.push(...checkQuickReferenceFreshness(repoRoot));

  return { issues, counts, skillCount: skills.length };
}

/** Render findings for a terminal. Grouped by code, stable order. */
export function renderIssues(issues) {
  if (issues.length === 0) return 'capability contracts: OK — no drift.';
  const lines = [`capability contracts: ${issues.length} issue(s).`, ''];
  const byCode = new Map();
  for (const i of issues) {
    if (!byCode.has(i.code)) byCode.set(i.code, []);
    byCode.get(i.code).push(i);
  }
  for (const [code, list] of [...byCode].sort((a, b) => cmp(a[0], b[0]))) {
    lines.push(`── ${code} (${list.length})`);
    for (const i of list) {
      lines.push(`   • ${i.message}`);
      lines.push(`     → ${i.fix}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
