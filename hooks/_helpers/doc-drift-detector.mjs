/**
 * doc-drift-detector.mjs (v0.13.7+)
 *
 * Shared library used by:
 *   - hooks/doc-propagation-checker.mjs   (PostToolUse on `git commit`)
 *   - hooks/vault-doc-startup-check.mjs   (SessionStart — catch-up)
 *
 * Detects drift between the **repo's authoritative state**
 * (`package.json` version, `CHANGELOG.md` entries, files under tracked
 * artifact dirs `hooks/scripts/skills/commands/agents/templates/`) and
 * the **vault's wiki documentation pages** (`wiki-meta/catalog.md`,
 * `wiki/<project>/router-changelog.md`, `wiki/<project>/project-router.md`,
 * and the per-family catalog pages `router-{hooks,skills,commands,agents,
 * cheatsheet}.md`).
 *
 * Returns a structured drift report with per-issue:
 *   - kind  : 'changelog-version' | 'changelog-cumulative' |
 *             'index-version'    | 'project-router-version' |
 *             'catalog-missing'
 *   - severity : 'IMPORTANT' | 'NIT'
 *   - message  : human-readable narration
 *   - fix      : concrete action to take
 *   - target   : absolute path of the vault page that should be edited
 *
 * Why we factored this out: pre-v0.13.7 `doc-propagation-checker.mjs`
 * only checked the CURRENT package.json version against ONE vault wiki
 * changelog (and broke on the first vault that had the file — usually
 * `.template`, never the actual project vault). It missed cumulative
 * gaps (8 versions stale in one go) and never checked the other wiki
 * pages. v0.13.7 generalizes all of that.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadWorkspaceDotenv } from './workspace-vault.mjs';
import { resolveScaffold } from '../../src/helpers/wiki-meta-scaffolds.mjs';
import {
  configuredDefaultVault,
  disabledVaultEntries,
  vaultSlug,
} from '../../src/helpers/vault-slug.mjs';

// ---------------------------------------------------------------------------
// Vault selection
// ---------------------------------------------------------------------------

/**
 * Resolve the router config path (env override → default).
 */
export function routerConfigPath() {
  if (process.env.OBSIDIAN_ROUTER_CONFIG) {
    return path.resolve(process.env.OBSIDIAN_ROUTER_CONFIG);
  }
  return path.join(
    process.env.USERPROFILE || process.env.HOME || os.homedir(),
    '.claude', 'obsidian-mcp-router', 'config.json',
  );
}

/**
 * Read + parse the router config or return null.
 */
export function readRouterConfig() {
  try { return JSON.parse(fs.readFileSync(routerConfigPath(), 'utf8')); }
  catch { return null; }
}

/**
 * Order candidate vaults by relevance for the current cwd:
 *   1. The workspace-bound vault (from `<cwd>/.env` OBSIDIAN_ROUTER_DEFAULT_VAULT)
 *   2. The router config's `defaultVault`
 *   3. Vaults whose basename matches the cwd's basename (heuristic for
 *      "this is the project's own vault" — applies when cwd path !=
 *      vault path but they share the project name)
 *   4. All other vaults in `portRegistry`
 *
 * `.template` and any other vault flagged in `cfg.disabledVaults` are
 * pushed to the end (still considered, but last) so a workspace-bound
 * config or default-vault is checked first.
 *
 * This fixes the v0.11.4 bug where `doc-propagation-checker` would
 * `break` on the first vault that had `wiki/<project>/router-changelog.md`
 * — usually `.template` since it sits first in portRegistry — and
 * never reach the actual project vault.
 */
export function orderedVaultCandidates(cwd, cfg) {
  if (!cfg) return [];
  const portRegistry = cfg.portRegistry || {};
  const all = Object.keys(portRegistry);
  if (all.length === 0) return [];

  // v0.13.7: hooks run as fresh Node subprocesses that don't inherit
  // dotenv loading — must autoload the workspace `.env` so the
  // OBSIDIAN_ROUTER_DEFAULT_VAULT slug set by `setup-vault.mjs
  // --link-workspace` is visible. Without this, every workspace-bound
  // setup falls through to the cfg.defaultVault, picking the wrong
  // vault as "the project's own".
  loadWorkspaceDotenv(cwd);

  const seen = new Set();
  const out = [];
  const push = (vp) => {
    if (vp && !seen.has(vp) && fs.existsSync(vp)) {
      seen.add(vp);
      out.push(vp);
    }
  };

  // (1) workspace-bound vault
  // `vaultSlug` (v0.90.0) replaces the inline
  // `(cfg.vaultNames?.[vp] || path.basename(vp).replace(/^\./, '')).toLowerCase()`
  // that stood at these three sites. Two bugs went with it: a non-string in
  // `vaultNames` threw a TypeError straight out of a hook that must exit 0
  // whatever the config says, and the fallback used the RUNTIME's
  // `path.basename`, which reads a Windows registry key as one long filename
  // when the runtime is POSIX. See src/helpers/vault-slug.mjs.
  const slug = (process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT || '').trim().toLowerCase();
  if (slug) {
    for (const vp of all) {
      if (vaultSlug(cfg, vp).toLowerCase() === slug) { push(vp); break; }
    }
  }

  // (2) default vault
  //
  // `configuredDefaultVault` (v0.90.0) replaces `(cfg.defaultVault || '')`.
  // A non-string there is TRUTHY, so `||` never caught it and `.toLowerCase()`
  // threw a TypeError out of this function — which two hooks call, both of
  // which must exit 0 whatever the config says. Same defect as the
  // `vaultNames` one swept in c4291e8, one key over.
  const defaultSlug = (configuredDefaultVault(cfg) || '').toLowerCase();
  if (defaultSlug) {
    for (const vp of all) {
      if (vaultSlug(cfg, vp).toLowerCase() === defaultSlug) { push(vp); break; }
    }
  }

  // (3) basename-of-cwd match (heuristic for "the project's own vault")
  const cwdBase = path.basename(cwd).toLowerCase();
  if (cwdBase) {
    for (const vp of all) {
      const vbase = path.basename(vp).toLowerCase();
      if (vbase === cwdBase || vbase.includes(cwdBase) || cwdBase.includes(vbase)) {
        push(vp);
      }
    }
  }

  // (4) all remaining, excluding `.template`-style first
  // `.map` on `(cfg.disabledVaults || [])` threw on anything but an array —
  // including the likeliest hand-edit of all, a bare `"disabledVaults":
  // "template"`. The `String(s)` that stood here guarded the ELEMENTS and not
  // the container, and coerced a numeric entry into the name "123", which a
  // vault whose folder is called `123` really answers to. (v0.90.0)
  const disabled = new Set(disabledVaultEntries(cfg).map((s) => s.toLowerCase()));
  const isTemplate = (vp) => /\.template$/i.test(vp);
  for (const vp of all) {
    if (isTemplate(vp)) continue;
    if (disabled.has(vaultSlug(cfg, vp).toLowerCase())) continue;
    push(vp);
  }
  // Templates last (almost never the right target, but include in case
  // someone really wants the template wiki audited).
  for (const vp of all) {
    if (isTemplate(vp)) push(vp);
  }

  return out;
}

// ---------------------------------------------------------------------------
// File reading helpers
// ---------------------------------------------------------------------------

export function readSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

export function readPackageVersion(repoCwd) {
  try { return JSON.parse(fs.readFileSync(path.join(repoCwd, 'package.json'), 'utf8')).version || null; }
  catch { return null; }
}

export function readPackageName(repoCwd) {
  try { return JSON.parse(fs.readFileSync(path.join(repoCwd, 'package.json'), 'utf8')).name || null; }
  catch { return null; }
}

function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Parse the version sections from a CHANGELOG.md file. Returns an array
 * of `{ version, date }` ordered as they appear in the file (newest
 * first per Keep a Changelog convention). Tolerates `## [X.Y.Z] — date`,
 * `## [X.Y.Z]`, `## vX.Y.Z — date`.
 */
export function parseChangelogVersions(content) {
  if (!content) return [];
  const out = [];
  const re = /^## (?:\[(\d+\.\d+\.\d+(?:[-+][^\]]+)?)\]|v(\d+\.\d+\.\d+(?:[-+]\S+)?))(?:\s*[—-]\s*(\S+))?/gm;
  let m;
  while ((m = re.exec(content))) {
    out.push({ version: m[1] || m[2], date: m[3] || null });
  }
  return out;
}

/**
 * Parse vX.Y.Z headings out of a wiki router-changelog page. Returns
 * a Set of version strings (no date).
 */
export function parseWikiChangelogVersions(content) {
  const set = new Set();
  if (!content) return set;
  const re = /^## v(\d+\.\d+\.\d+(?:[-+]\S+)?)\b/gm;
  let m;
  while ((m = re.exec(content))) set.add(m[1]);
  return set;
}

// ---------------------------------------------------------------------------
// Catalog drift — basename of every artifact under tracked dirs vs the
// corresponding wiki catalog page.
// ---------------------------------------------------------------------------

/**
 * Map of `<repo-relative dir>` → `<wiki catalog basename>` (basename of
 * the .md page under `wiki/<project>/`). Used by the catalog drift
 * check.
 */
export const CATALOG_DIR_MAP = {
  'hooks':     'router-hooks',
  'scripts':   'router-cheatsheet',  // scripts don't have their own page; listed in cheatsheet
  'skills':    'router-skills',
  'commands':  'router-commands',
  'agents':    'router-agents',
  'templates': 'router-templates',
};

/**
 * List the basenames (sans extension/ext) of artifact files under a
 * tracked dir, recursively where appropriate. Returns the set of names
 * that should appear in the corresponding catalog page.
 */
export function listCatalogBasenames(repoCwd, dirName) {
  const dir = path.join(repoCwd, dirName);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const out = new Set();
  // For skills + commands, an artifact is one dir per skill (SKILL.md inside)
  // or one .md file per slash command. We want the slug, not "SKILL".
  if (dirName === 'skills') {
    for (const name of fs.readdirSync(dir)) {
      const sub = path.join(dir, name);
      if (fs.statSync(sub).isDirectory() && fs.existsSync(path.join(sub, 'SKILL.md'))) {
        out.add(name);
      }
    }
  } else if (dirName === 'commands' || dirName === 'agents') {
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.md')) out.add(name.replace(/\.md$/, ''));
    }
  } else if (dirName === 'hooks') {
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.mjs') && !name.startsWith('_')) {
        out.add(name.replace(/\.mjs$/, ''));
      }
    }
  } else if (dirName === 'scripts') {
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.mjs') && !name.startsWith('_')) {
        out.add(name.replace(/\.mjs$/, ''));
      }
    }
  } else if (dirName === 'templates') {
    for (const name of fs.readdirSync(dir)) {
      // Templates may be files or dirs — include both
      out.add(name.replace(/\.(md|json)$/, ''));
    }
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// The main drift check
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} DriftIssue
 * @property {string}  kind      — see top-of-file enum
 * @property {string}  severity  — 'IMPORTANT' | 'NIT'
 * @property {string}  message   — what's wrong
 * @property {string}  fix       — what to do
 * @property {string}  target    — absolute path of the vault page
 */

/**
 * Run the full drift detection against a repo cwd + a specific vault
 * path. Returns { vaultPath, issues: DriftIssue[] }. An empty issues
 * array means "no drift".
 *
 * Early-returns with NO issues when the vault does not host
 * `wiki/<projectSlug>/` — i.e. it doesn't document this project, so it must
 * not be flagged (esp. by the catalog-version check, which keys on
 * `wiki-meta/catalog.md`, present in every router-scaffolded vault).
 *
 * Options:
 *   - cumulativeWindow: number — how many of the most recent CHANGELOG
 *     versions to require in the vault wiki changelog. Default 5.
 *     Catches the "8 versions in one go" gap the user hit on 2026-05-24.
 *   - projectSlug: string — name of the wiki project folder (default:
 *     auto-inferred from `package.json` name).
 */
export function detectDocDrift(repoCwd, vaultPath, opts = {}) {
  const cumulativeWindow = Number.isFinite(opts.cumulativeWindow) ? opts.cumulativeWindow : 5;
  const projectName = opts.projectSlug || readPackageName(repoCwd) || path.basename(repoCwd);
  const projectSlug = String(projectName).replace(/^@[^/]+\//, ''); // strip npm scope
  const currentVersion = readPackageVersion(repoCwd);
  const issues = [];

  if (!currentVersion) {
    return { vaultPath, projectSlug, currentVersion: null, issues };
  }

  // -----------------------------------------------------------------
  // 0) GATE — does this vault actually DOCUMENT this project?
  // -----------------------------------------------------------------
  // A vault is a drift target for this project only if it hosts the
  // project's wiki folder (`wiki/<projectSlug>/`). Without this gate the
  // `index-version` check (#2) keys solely on `wiki-meta/catalog.md`, which
  // EVERY router-scaffolded vault has (TradingView, smile, …) — so once the
  // real project vault is up to date, the SessionStart hook's
  // "first-candidate-with-drift" loop falls through and flags an unrelated
  // vault for "index doesn't mention vX.Y.Z" (it never mentions it — it has
  // zero router content). Checks #1/#3/#4 are already guarded by their
  // project-specific pages existing under this folder; #2 was the only leak.
  // Bug surfaced 2026-06-17: TradingView's index flagged for v0.31.1.
  const projectDir = path.join(vaultPath, 'wiki', projectSlug);
  if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
    return { vaultPath, projectSlug, currentVersion, issues };
  }

  // -----------------------------------------------------------------
  // 1) Wiki changelog — current version + cumulative window
  // -----------------------------------------------------------------
  const wikiChangelogPath = path.join(vaultPath, 'wiki', projectSlug, 'router-changelog.md');
  const wikiChangelog = readSafe(wikiChangelogPath);
  const repoChangelog = readSafe(path.join(repoCwd, 'CHANGELOG.md'));

  if (wikiChangelog !== null && repoChangelog !== null) {
    const wikiVersions = parseWikiChangelogVersions(wikiChangelog);
    if (!wikiVersions.has(currentVersion)) {
      issues.push({
        kind: 'changelog-version',
        severity: 'IMPORTANT',
        message: `wiki router-changelog.md doesn't have a \`## v${currentVersion}\` section.`,
        fix: `Prepend a "## v${currentVersion} — <YYYY-MM-DD>" section to ${wikiChangelogPath} with bilingual FR+EN narration + add a TOC row.`,
        target: wikiChangelogPath,
      });
    }
    // Cumulative window: are the last N versions from CHANGELOG also in the wiki?
    const repoVersions = parseChangelogVersions(repoChangelog)
      .map((v) => v.version)
      .slice(0, cumulativeWindow);
    const cumulativeMissing = repoVersions.filter((v) => !wikiVersions.has(v));
    if (cumulativeMissing.length > 1) {
      issues.push({
        kind: 'changelog-cumulative',
        severity: 'IMPORTANT',
        message: `wiki router-changelog.md is ${cumulativeMissing.length} versions stale (missing: ${cumulativeMissing.join(', ')}).`,
        fix: `Add ALL missing version sections + their TOC rows to ${wikiChangelogPath}. Don't just patch the current version — fill the gap.`,
        target: wikiChangelogPath,
      });
    }
  }

  // -----------------------------------------------------------------
  // 2) wiki-meta/catalog.md — does it mention the current version?
  //    (`wiki-meta/index.md` on a vault not yet migrated to the 0.58.0
  //    names — the check follows whichever file the vault actually has.)
  // -----------------------------------------------------------------
  const catalog = resolveScaffold(vaultPath, 'catalog', { fs, path });
  const indexPath = catalog?.absPath ?? null;
  const indexContent = indexPath ? readSafe(indexPath) : null;
  if (indexContent !== null) {
    if (!new RegExp(escRe('v' + currentVersion)).test(indexContent)) {
      issues.push({
        kind: 'index-version',
        severity: 'IMPORTANT',
        message: `${catalog.relPath} doesn't mention the current version v${currentVersion}.`,
        fix: `Bump the "état actuel" and TOC counter lines in ${indexPath} to mention v${currentVersion} + any new artifact counts.`,
        target: indexPath,
      });
    }
  }

  // -----------------------------------------------------------------
  // 3) wiki/<project>/project-router.md frontmatter `current-version`
  // -----------------------------------------------------------------
  const projectAnatomyPath = path.join(vaultPath, 'wiki', projectSlug, 'project-router.md');
  const projectAnatomy = readSafe(projectAnatomyPath);
  if (projectAnatomy !== null) {
    const m = projectAnatomy.match(/^current-version:\s*['"]?(\S+?)['"]?\s*$/m);
    const fmVersion = m ? m[1] : null;
    if (fmVersion && fmVersion !== currentVersion) {
      issues.push({
        kind: 'project-router-version',
        severity: 'IMPORTANT',
        message: `wiki ${projectSlug}/project-router.md frontmatter \`current-version\` is "${fmVersion}", repo is "${currentVersion}".`,
        fix: `Update the frontmatter \`current-version\` in ${projectAnatomyPath} to ${currentVersion} (and the date line if present).`,
        target: projectAnatomyPath,
      });
    }
  }

  // -----------------------------------------------------------------
  // 4) Catalog completeness — every artifact basename should appear
  //    somewhere in its catalog page.
  // -----------------------------------------------------------------
  for (const [dirName, catalogBase] of Object.entries(CATALOG_DIR_MAP)) {
    const catalogPath = path.join(vaultPath, 'wiki', projectSlug, catalogBase + '.md');
    const catalogContent = readSafe(catalogPath);
    if (catalogContent === null) continue; // catalog page not scaffolded — skip
    const basenames = listCatalogBasenames(repoCwd, dirName);
    const missing = basenames.filter((b) => !catalogContent.includes(b));
    if (missing.length > 0) {
      issues.push({
        kind: 'catalog-missing',
        severity: missing.length > 2 ? 'IMPORTANT' : 'NIT',
        message: `wiki ${projectSlug}/${catalogBase}.md doesn't mention ${missing.length} artifact(s) in \`${dirName}/\`: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ', …' : ''}.`,
        fix: `Add row(s) to the catalog table in ${catalogPath} for each missing artifact, with a 1-line description.`,
        target: catalogPath,
      });
    }
  }

  return { vaultPath, projectSlug, currentVersion, issues };
}

/**
 * Stable fingerprint of an issues array — used by Stop/SessionStart
 * hooks for "don't re-prompt for the same drift state" dedup.
 */
export function fingerprintIssues(issues) {
  const sig = issues
    .map((i) => `${i.kind}|${i.target}|${i.severity}`)
    .sort()
    .join('\n');
  // Cheap hash — collisions don't matter (worst case: an unrelated drift
  // shares fingerprint and skips a re-prompt; user can clear via the
  // fingerprint file or wait until the state genuinely changes).
  let h = 0;
  for (let i = 0; i < sig.length; i++) {
    h = ((h << 5) - h + sig.charCodeAt(i)) | 0;
  }
  return String(h);
}

/**
 * Render a drift report as a human-readable nudge string. Used by both
 * hooks. The `tag` prefix identifies the source for grep-ability.
 */
export function renderDriftNudge(tag, vaultPath, projectSlug, currentVersion, issues) {
  if (issues.length === 0) return '';
  const lines = [];
  lines.push(`${tag}: ${issues.length} doc drift issue(s) detected in vault \`${path.basename(vaultPath)}\` (project: ${projectSlug}, current version: v${currentVersion}).`);
  lines.push('');
  lines.push('Address these in the next response — the vault should reflect the repo state:');
  lines.push('');
  for (const [i, issue] of issues.entries()) {
    lines.push(`${i + 1}. [${issue.severity}] ${issue.message}`);
    lines.push(`   → ${issue.fix}`);
    lines.push('');
  }
  lines.push(
    'Tip: open each `target` path and patch in place. The doc-drift-detector ' +
    'fingerprints the issues set, so this nudge will not re-fire until you ' +
    'fix at least one issue (or the repo state changes).',
  );
  return lines.join('\n');
}
