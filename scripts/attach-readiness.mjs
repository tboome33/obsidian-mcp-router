/**
 * attach-readiness.mjs — what is still missing after `--attach`, in order.
 *
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 * ---------------------------------------------------------------------------
 * Attaching a blank remote vault once ended with a vault that held NOTHING but
 * the Local REST API plugin: no bridge, no wiki, no conventions — and no line
 * of output saying so. Each missing piece was discovered by hand, one failure
 * at a time. The router already knows how to find out; it just never looked.
 *
 * So `--attach` now ends with a verified state and, when something is
 * missing, the ordered list of commands that close the gap:
 *
 *   1. plugins  — code on disk for every plugin the reference skeleton
 *                 enables (`--install-plugins`, sealed), then a reload and
 *                 `--plugin-health` to see Obsidian actually load them;
 *   2. wiki     — the scaffolds (`/obsidian-router:wiki`);
 *   3. conventions — the picker, pre-checked (`/obsidian-router:conventions`),
 *                 which installs with ONE guarded `install_conventions` call.
 *
 * The order is the dependency order: the wiki and the conventions are written
 * through the REST API, and the router's richer tools need the bridge.
 *
 * WHAT IT READS, AND WHERE. The vault's disk only — a local vault's folder, or
 * a remote vault's VERIFIED local directory. Without a disk, plugins and
 * conventions are reported `unknown` and the first step becomes declaring the
 * directory — after the wiki, for a vault that has none, since only a note
 * makes the directory verifiable: this module never guesses a state it did
 * not read. Nothing here
 * runs in the server (plugin-inventory refuses to, and this is a CLI module).
 */

import nodeFs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectVaultPlugins, loadExpectedPlugins } from '../src/helpers/plugin-inventory.mjs';
import { CLAUDE_MD_CANDIDATES, resolveClaudeMd, detectConventions } from '../src/helpers/claude-md-conventions.mjs';
import { loadConventionCatalogue } from '../src/tools/install-conventions.mjs';

const SKELETON_COMMUNITY_PLUGINS = fileURLToPath(
  new URL('../templates/reference-vault-skeleton/.obsidian/community-plugins.json', import.meta.url),
);

/**
 * The conventions the attach picker pre-checks when absent — the same nine
 * skills/meta-attach-vault/SKILL.md lists (tests/attach-readiness.test.mjs
 * fails if the two drift apart).
 */
export const RECOMMENDED_CONVENTIONS = Object.freeze([
  'roadmap-discipline',
  'default-vault-health-check',
  'wiki-query-first',
  'path-disambiguation',
  'source-type',
  'bilingual',
  'heading-hierarchy',
  'auto-enrichment',
  'description-frontmatter',
]);

/** Quote a vault name for a shell line the user will copy. */
function q(name) {
  return `"${String(name).replace(/"/g, '\\"')}"`;
}

/**
 * Conventions detected in the vault's conventions file, read from disk.
 * @returns {{available:true, file:string|null, ambiguous:boolean, installed:string[], missingRecommended:string[]}}
 */
export function readConventionsFromDisk(diskPath, { fs = nodeFs, catalogue = loadConventionCatalogue() } = {}) {
  const existing = CLAUDE_MD_CANDIDATES.filter((rel) => {
    try { return fs.statSync(path.join(diskPath, ...rel.split('/'))).isFile(); } catch { return false; }
  });
  const resolved = resolveClaudeMd(existing);
  if (resolved.ambiguous) {
    return { available: true, file: null, ambiguous: true, installed: [], missingRecommended: [...RECOMMENDED_CONVENTIONS] };
  }
  let content = '';
  if (resolved.path) {
    try { content = fs.readFileSync(path.join(diskPath, ...resolved.path.split('/')), 'utf8'); } catch { content = ''; }
  }
  const installed = detectConventions(content, catalogue).filter((d) => d.installed).map((d) => d.id);
  const have = new Set(installed);
  return {
    available: true,
    file: resolved.path,
    ambiguous: false,
    installed,
    missingRecommended: RECOMMENDED_CONVENTIONS.filter((id) => !have.has(id)),
  };
}

/**
 * @param {object} args
 * @param {string} args.vault         the name the user typed commands with
 * @param {'local'|'remote'} args.kind
 * @param {string|null} args.diskPath the vault folder this machine can read, or null
 * @param {{catalog:boolean|null, hot:boolean|null}} args.wiki  from attach
 * @param {object} [deps] fs, catalogue, expected — injected by tests
 * @returns {{plugins:object, conventions:object, nextSteps:string[], ready:boolean}}
 */
export function assessAttachReadiness({ vault, kind, diskPath, wiki }, deps = {}) {
  const fs = deps.fs ?? nodeFs;
  const steps = [];
  let plugins = { available: false };
  let conventions = { available: false };
  const wikiStep = 'Create the wiki: /obsidian-router:wiki in Claude Code, in this workspace (it then offers the conventions picker).';
  let wikiListed = false;

  if (!diskPath) {
    if (kind === 'remote') {
      // A BLANK remote vault (no wiki) cannot have its folder verified: the
      // check compares a NOTE the REST API serves with the same file on disk
      // (remote-local-path.mjs, `nothing-to-compare`), and a blank vault has
      // none — so "declare --local-path" first was a loop the user could only
      // escape by hand. The wiki is written over REST and needs no disk; it
      // creates the note that makes the folder verifiable. So: wiki first.
      if (wiki?.catalog === false) {
        steps.push(wikiStep);
        wikiListed = true;
      }
      steps.push(
        `${wikiListed ? 'Then declare' : 'Declare'} the vault's folder on this machine, if its files sit here: obsidian-mcp-router --attach ${q(vault)} --local-path <abs-dir> `
        + `(${wikiListed ? 'it can be verified once the vault holds a note, which the wiki creates; ' : ''}`
        + 'plugins can then be checked and installed; otherwise install them from Obsidian: Settings → Community plugins).',
      );
    }
  } else {
    const expected = deps.expected ?? loadExpectedPlugins(SKELETON_COMMUNITY_PLUGINS, { fs: nodeFs });
    const inv = inspectVaultPlugins(diskPath, { fs, expected });
    const expectedPlugins = inv.plugins.filter((p) => p.expected);
    plugins = {
      available: true,
      installed: expectedPlugins.filter((p) => p.codeInstalled).length,
      expected: expectedPlugins.length,
      missing: inv.missing,
      enabledWithoutCode: inv.enabledWithoutCode,
      bridge: inv.bridge,
    };
    if (inv.missing.length > 0) {
      steps.push(
        `Install the missing plugin code (${inv.missing.length}: ${inv.missing.join(', ')}): `
        + `obsidian-mcp-router --install-plugins ${q(vault)} --dry-run, then re-run with the --approved-plan-sha256 it prints.`,
      );
    }
    if (inv.missing.length > 0 || inv.enabledWithoutCode.length > 0) {
      steps.push(
        'Reload Obsidian (Ctrl+P → "Reload app without saving"; in a container, the same command in the web UI or '
        + '`docker compose restart`), turn Restricted mode off, then check: '
        + `obsidian-mcp-router --plugin-health ${q(vault)}`,
      );
    }
    conventions = readConventionsFromDisk(diskPath, { fs, catalogue: deps.catalogue });
  }

  if (wiki?.catalog === false && !wikiListed) {
    steps.push(wikiStep);
  }
  if (conventions.available) {
    if (conventions.ambiguous) {
      steps.push('Two conventions files exist (CLAUDE.md candidates): keep one, then run /obsidian-router:conventions pick.');
    } else if (conventions.missingRecommended.length > 0 && wiki?.catalog !== false) {
      steps.push(
        `Choose the conventions: /obsidian-router:conventions pick (pre-checked: ${conventions.missingRecommended.join(', ')}; `
        + 'installed in one guarded write by install_conventions).',
      );
    }
  } else if (wiki?.catalog !== false) {
    steps.push('Check the conventions: /obsidian-router:conventions pick (reads the vault over REST).');
  }

  const ready = steps.length === 0 && plugins.available && conventions.available && wiki?.catalog === true;
  return { plugins, conventions, nextSteps: steps, ready };
}

/**
 * The lines `formatFinalState` appends for the readiness part.
 * @param {ReturnType<typeof assessAttachReadiness>} r
 */
export function formatReadiness(r) {
  const lines = [];
  const p = r.plugins;
  if (p.available) {
    const extra = [];
    if (p.missing.length) extra.push(`missing code: ${p.missing.join(', ')}`);
    if (p.enabledWithoutCode.length) extra.push(`enabled without code: ${p.enabledWithoutCode.join(', ')}`);
    lines.push(`  plugins     ${p.installed}/${p.expected} with code · bridge: ${p.bridge}${extra.length ? ` · ${extra.join(' · ')}` : ''}`);
  } else {
    lines.push('  plugins     unknown (no disk to read)');
  }
  const c = r.conventions;
  if (c.available) {
    const file = c.ambiguous ? 'two candidate files' : (c.file ?? 'no conventions file yet');
    lines.push(`  conventions ${c.installed.length} installed (${file}) · recommended still absent: ${c.missingRecommended.length}`);
  } else {
    lines.push('  conventions unknown (no disk to read)');
  }
  if (r.ready) {
    lines.push('  ready       yes — plugins, wiki and conventions verified');
  } else {
    lines.push('  next steps');
    r.nextSteps.forEach((s, i) => lines.push(`    ${i + 1}. ${s}`));
  }
  return lines;
}
