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
 * Also tidies the pre-v0.12.8 `wiki/sessions/` ghost directory when EMPTY.
 *
 * `--all-vaults` walks the router config's portRegistry; `--vault` is
 * repeatable and adds unregistered vaults (the registry lists the SERVED
 * fleet, not the existing one — 3 known strays).
 *
 * Exit codes: 0 OK · 1 bad usage or any vault reporting conflicts.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { registeredVaultPaths } from '../src/helpers/vault-slug.mjs';
import { generateProjectionsOnDisk } from '../src/helpers/okf-projections-fs.mjs';

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
    if (r.conflicts.length > 0) anyConflict = true;
    rows.push({ vault: vaultAbs, status: r.conflicts.length ? 'conflicts' : 'ok', ...r, ghostTidied });
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
}
const tally = rows.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
console.log(`  ${Object.entries(tally).map(([k, v]) => `${k}: ${v}`).join(' · ')}`);
if (!args.apply) console.log('  Dry-run only — re-run with --apply to execute.');
process.exit(anyConflict ? 1 : 0);
