#!/usr/bin/env node
/**
 * okf-projections — initialise/refresh the OKF at-rest projections of one
 * vault or the whole fleet, ON DISK (works with Obsidian closed).
 *
 *   node scripts/okf-projections.mjs --all-vaults                 # dry-run
 *   node scripts/okf-projections.mjs --all-vaults --apply
 *   node scripts/okf-projections.mjs --vault "C:\VAULTS\X" --apply
 *
 * Generates `wiki/index.md` (root, `okf_version` only), one `index.md` per
 * content directory, and `wiki/log.md` (newest-first) — all derived from page
 * frontmatter, marked as generated. Once a vault is initialised, the router's
 * write middleware keeps them fed (debounced refresh after every write under
 * `wiki/`), and `refresh_okf_projections` / wiki-lint reconcile on demand.
 *
 * Safety mirrors the tool: an UNMARKED file at a reserved path is a conflict
 * (reported, untouched); only marker-carrying files are rewritten or deleted.
 * Also tidies the pre-v0.12.8 `wiki/sessions/` ghost directory when EMPTY, and
 * REPORTS (never repairs) the case that directory becomes when it is not empty:
 * session content living under `wiki/` while `wiki-meta/Sessions/` holds the
 * journals the auto-journal hook writes. Two homes for one content type, which
 * is how a `code`-mode vault ended up with a hand-written recap under
 * `wiki/Sessions/` and two raw journals under `wiki-meta/Sessions/`, unlinked.
 * Repair is left to a human because the `wiki/` files may be curated pages that
 * belong in a real content area, not raw logs to fold into `wiki-meta/`.
 *
 * `--all-vaults` walks the router config's portRegistry; `--vault` is
 * repeatable and adds unregistered vaults (the registry lists the SERVED
 * fleet, not the existing one — 3 known strays).
 *
 * Exit codes: 0 OK · 1 bad usage, any vault reporting conflicts, or a
 * `session-folder-collision`. A `session-folder-stray` (content under `wiki/`
 * with nothing to reconcile against) is a warning and keeps the exit code at 0.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { registeredVaultPaths } from '../src/helpers/vault-slug.mjs';
import { generateProjectionsOnDisk } from '../src/helpers/okf-projections-fs.mjs';
import {
  WIKI_META_OWNED_AREAS,
  PROJECTION_BASENAMES,
  detectSessionFolderCollision,
} from '../src/helpers/session-folder-collision.mjs';
import { hasProjectionMarker } from '../src/helpers/okf-projections.mjs';

const CONFIG_PATH = process.env.OBSIDIAN_ROUTER_CONFIG
  ? path.resolve(process.env.OBSIDIAN_ROUTER_CONFIG)
  : path.join(os.homedir(), '.claude', 'obsidian-mcp-router', 'config.json');

function usage(msg) {
  if (msg) console.error(`✗ ${msg}`);
  console.error(
    'Usage:\n' +
      '  okf-projections.mjs (--all-vaults | --vault <dir>…) [--apply]\n\n' +
      'Options:\n' +
      '  --all-vaults   every vault in the router config portRegistry\n' +
      '  --vault <dir>  add a vault (repeatable — covers unregistered strays)\n' +
      '  --apply        write/delete (default is dry-run)\n',
  );
  process.exit(1);
}

function parseArgs(argv) {
  const args = { vaults: [], allVaults: false, apply: false };
  const value = (flag, i) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) usage(`${flag} requires a value.`);
    return v;
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--vault') args.vaults.push(value(a, i++));
    else if (a === '--all-vaults') args.allVaults = true;
    else if (a === '--apply') args.apply = true;
    else usage(`Unknown argument: ${a}`);
  }
  const paths = [];
  if (args.allVaults) {
    let cfg = {};
    try {
      cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch {
      usage(`--all-vaults needs a readable router config at ${CONFIG_PATH}`);
    }
    // Through the accessor: the container is validated there, so a hand-edited
  // `"portRegistry": "AB"` yields no vaults instead of the paths "0" and
  // "1". Sixth key of the `vaultNames` class, swept in the final review.
  paths.push(...registeredVaultPaths(cfg));
  }
  paths.push(...args.vaults);
  if (paths.length === 0) usage('Nothing to do — pass --vault <dir> and/or --all-vaults.');

  const seen = new Set();
  args.resolved = [];
  for (const p of paths) {
    const abs = path.resolve(p);
    if (seen.has(abs.toLowerCase())) continue;
    seen.add(abs.toLowerCase());
    args.resolved.push(abs);
  }
  return args;
}

/** Remove the pre-v0.12.8 `wiki/sessions/` ghost — only when truly empty. */
function tidyGhostSessionsDir(vaultAbs, apply) {
  const ghost = path.join(vaultAbs, 'wiki', 'sessions');
  try {
    if (!fs.statSync(ghost).isDirectory()) return false;
    if (fs.readdirSync(ghost).length > 0) return false;
  } catch {
    return false;
  }
  if (apply) fs.rmdirSync(ghost);
  return true;
}

/**
 * Vault-relative `.md` entries under the `wiki/` and `wiki-meta/` directories
 * whose name a `wiki-meta/` folder owns — the input `detectSessionFolderCollision`
 * expects. Deliberately NOT a full-tree walk: only the handful of directories
 * that can collide are opened, so this stays free on a 700-file vault.
 *
 * Directory matching is case-insensitive because the fleet carries both
 * spellings (`wiki/sessions/` from the pre-v0.12.8 layout, `wiki/Sessions/`
 * from the catalogue seed) and Windows treats them as one directory.
 *
 * TWO THINGS THIS DOES BEYOND LISTING, both found by an adversarial review:
 *
 * 1. It reads the generated-marker of every file at a RESERVED basename, rather
 *    than letting the detector assume `index.md` means generated. This repo's
 *    own projection writer treats an unmarked file at a reserved path as a
 *    user-owned conflict; a hand-written `wiki/Sessions/index.md` is content and
 *    must be reported. At most a couple of files per vault are read.
 *
 * 2. It REPORTS enumeration failures instead of swallowing them. A `catch` that
 *    returns nothing turns "I could not look" into "there is nothing there",
 *    and a vault whose `wiki/` side was unreadable would then be printed `ok`.
 *    Same rule the router's own conformance pass learned (`INCOMPLETE_VIEW_SKIPS`
 *    in `src/helpers/vault-conformance.mjs`): a skipped read is not a clean one.
 *
 * @returns {{entries: Array<{path: string, generated: boolean}>, unreadable: string[]}}
 */
function collectOwnedAreaEntries(vaultAbs) {
  const owned = new Set(WIKI_META_OWNED_AREAS.map((a) => a.toLowerCase()));
  const reserved = new Set(PROJECTION_BASENAMES.map((b) => b.toLowerCase()));
  const entries = [];
  const unreadable = [];

  for (const root of ['wiki', 'wiki-meta']) {
    let children;
    try {
      children = fs.readdirSync(path.join(vaultAbs, root), { withFileTypes: true });
    } catch (err) {
      // A MISSING root is a fact about the vault; anything else is a failure to
      // observe, and the two must not be conflated.
      if (err?.code !== 'ENOENT') unreadable.push(`${root}/ (${err?.code || err?.message})`);
      continue;
    }
    for (const dir of children) {
      if (!dir.isDirectory() || !owned.has(dir.name.toLowerCase())) continue;
      const walk = (relDir) => {
        let inner;
        try {
          inner = fs.readdirSync(path.join(vaultAbs, relDir), { withFileTypes: true });
        } catch (err) {
          unreadable.push(`${relDir}/ (${err?.code || err?.message})`);
          return;
        }
        for (const child of inner) {
          const rel = `${relDir}/${child.name}`;
          if (child.isDirectory()) { walk(rel); continue; }
          if (!child.name.toLowerCase().endsWith('.md')) continue;
          let generated = false;
          if (reserved.has(child.name.toLowerCase())) {
            try {
              generated = hasProjectionMarker(fs.readFileSync(path.join(vaultAbs, rel), 'utf8'));
            } catch (err) {
              // Unreadable: fall through as CONTENT (generated stays false) so
              // the file is reported, and say the view was incomplete.
              unreadable.push(`${rel} (${err?.code || err?.message})`);
            }
          }
          entries.push({ path: rel, generated });
        }
      };
      walk(`${root}/${dir.name}`);
    }
  }
  return { entries, unreadable };
}

const args = parseArgs(process.argv);
let anyConflict = false;
const rows = [];

for (const vaultAbs of args.resolved) {
  if (!fs.existsSync(vaultAbs) || !fs.statSync(vaultAbs).isDirectory()) {
    rows.push({ vault: vaultAbs, status: 'unreachable' });
    continue;
  }
  if (!fs.existsSync(path.join(vaultAbs, 'wiki'))) {
    rows.push({ vault: vaultAbs, status: 'no-wiki' });
    continue;
  }
  try {
    const r = generateProjectionsOnDisk(vaultAbs, { apply: args.apply });
    const ghostTidied = tidyGhostSessionsDir(vaultAbs, args.apply);
    // Read-only, and deliberately AFTER the refresh: the refresh deletes the
    // `index.md` of a directory that no longer has content, so running the
    // detector first would count a stale projection as evidence of a folder
    // that is already gone.
    const scan = collectOwnedAreaEntries(vaultAbs);
    const { findings: sessionFindings } = detectSessionFolderCollision(scan.entries);
    if (r.conflicts.length > 0) anyConflict = true;
    if (sessionFindings.some((f) => f.severity === 'error')) anyConflict = true;
    // An incomplete view is not a clean one. It does not fail the run — the
    // projections themselves may have succeeded — but the vault must never be
    // printed `ok`, because "no collision found" was not actually established.
    const status = r.conflicts.length ? 'conflicts'
      : sessionFindings.length ? 'drift'
        : scan.unreadable.length ? 'partial'
          : 'ok';
    rows.push({
      vault: vaultAbs,
      status,
      ...r,
      ghostTidied,
      sessionFindings,
      unreadable: scan.unreadable,
    });
  } catch (err) {
    anyConflict = true;
    rows.push({ vault: vaultAbs, status: 'failed', error: err.message });
  }
}

console.log(`\n=== okf-projections — ${args.resolved.length} vault(s) ${args.apply ? '(APPLY)' : '(dry-run)'} ===`);
for (const r of rows) {
  if (r.status === 'unreachable' || r.status === 'no-wiki' || r.status === 'failed') {
    console.log(`  ${r.status.padEnd(11)} ${r.vault}${r.error ? ` — ${r.error}` : ''}`);
    continue;
  }
  console.log(
    `  ${r.status.padEnd(11)} ${r.vault} — ${r.pagesScanned} pages, ` +
      `${r.written.length} written, ${r.unchanged} unchanged, ${r.deleted.length} deleted` +
      `${r.ghostTidied ? ', ghost wiki/sessions/ removed' : ''}`,
  );
  for (const c of r.conflicts) console.log(`      ⚠ conflict (unmarked file, untouched): ${c}`);
  for (const f of r.sessionFindings ?? []) {
    console.log(`      ${f.severity === 'error' ? '✗' : '⚠'} ${f.rule}: ${f.detail}`);
    for (const wf of f.wikiFiles) console.log(`          ${wf}`);
  }
  for (const u of r.unreadable ?? []) {
    console.log(`      ⚠ could not read ${u} — the Sessions scan of this vault is INCOMPLETE`);
  }
}
const tally = rows.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
console.log(`  ${Object.entries(tally).map(([k, v]) => `${k}: ${v}`).join(' · ')}`);
if (!args.apply) console.log('  Dry-run only — re-run with --apply to execute.');
process.exit(anyConflict ? 1 : 0);
