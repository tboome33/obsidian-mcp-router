/**
 * Disk-side OKF projections — the same generation as the
 * `refresh_okf_projections` tool, but over the FILESYSTEM instead of REST.
 *
 * Two callers:
 *   - `scripts/setup-vault.mjs` (scaffolding a wiki initialises the
 *     projections, so a fresh vault is born with a conformant root index);
 *   - `scripts/okf-projections.mjs` (offline fleet initialisation — works
 *     with Obsidian closed, which REST cannot).
 *
 * Same pure core (`buildProjections` / `planProjectionWrites`), same safety:
 * unmarked homonyms are conflicts, only marked files are rewritten/deleted.
 */

import fs from 'node:fs';
import path from 'node:path';

import { parseFrontmatter } from './llms-txt-exporter.mjs';
import {
  buildProjections,
  planProjectionWrites,
  isProjectionPath,
  isWikiContentPath,
} from './okf-projections.mjs';

/** Walk `<vault>/wiki` for .md files (vault-relative posix paths). */
function walkWiki(vaultAbs) {
  const out = [];
  const wikiAbs = path.join(vaultAbs, 'wiki');
  if (!fs.existsSync(wikiAbs)) return out;
  const rec = (rel) => {
    const abs = path.join(wikiAbs, rel);
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (/^(\.|node_modules$)/.test(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) rec(childRel);
      else if (/\.md$/i.test(e.name)) out.push(`wiki/${childRel}`);
    }
  };
  rec('');
  return out;
}

/**
 * Generate (or refresh) the projections of ONE vault on disk.
 *
 * @param {string} vaultPath Absolute vault root
 * @param {object} [opts]
 * @param {boolean} [opts.apply=false] Write/delete; false = plan only.
 * @param {string} [opts.now] Injected ISO date (defaults to today).
 * @param {string} [opts.vaultName] Root-index heading (defaults to basename).
 * @returns {{written: string[], deleted: string[], unchanged: number,
 *            conflicts: string[], pagesScanned: number, applied: boolean}}
 */
export function generateProjectionsOnDisk(vaultPath, opts = {}) {
  const apply = opts.apply === true;
  const now = opts.now || new Date().toISOString().slice(0, 10);
  const vaultName = opts.vaultName || path.basename(vaultPath);

  const all = walkWiki(vaultPath);
  const pages = [];
  const current = new Map();
  for (const rel of all) {
    const raw = fs.readFileSync(path.join(vaultPath, ...rel.split('/')), 'utf8');
    if (isProjectionPath(rel)) current.set(rel, raw);
    else if (isWikiContentPath(rel)) {
      const { frontmatter, body } = parseFrontmatter(raw);
      pages.push({ path: rel, frontmatter, body });
    }
  }

  const { files } = buildProjections({ pages, vaultName, now });
  const plan = planProjectionWrites({ generated: files, current });

  if (apply) {
    for (const file of plan.writes) {
      const abs = path.join(vaultPath, ...file.path.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, file.content, 'utf8');
    }
    for (const rel of plan.deletes) {
      try { fs.unlinkSync(path.join(vaultPath, ...rel.split('/'))); } catch { /* best effort */ }
    }
  }

  return {
    written: plan.writes.map((w) => w.path),
    deleted: plan.deletes,
    unchanged: plan.unchanged.length,
    conflicts: plan.conflicts,
    pagesScanned: pages.length,
    applied: apply,
  };
}
