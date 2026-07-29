#!/usr/bin/env node
/**
 * okf-safe-rename-textpass — re-run the RAW-TEXT path substitution pass on a
 * vault already migrated by `okf-safe-rename-vault.mjs`, using the manifest
 * the migration left in `<vault>/.okf-rename-backup/<ts>/manifest.json`.
 *
 * Needed when a migration ran before the raw-text pass existed: links were
 * rewritten but plain-text path mentions (session journals, CLAUDE.md…)
 * still cite pre-rename paths. Idempotent — running it twice changes nothing.
 *
 *   node scripts/okf-safe-rename-textpass.mjs --vault "C:\VAULTS\Coursera"
 */

import fs from 'node:fs';
import path from 'node:path';

import { rewriteExactPaths } from '../src/helpers/okf-safe-rename.mjs';

function parseArgs(argv) {
  const args = { vault: null };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--vault') args.vault = argv[++i];
    else {
      console.error(`Unknown argument: ${argv[i]}`);
      process.exit(1);
    }
  }
  if (!args.vault || !fs.existsSync(args.vault)) {
    console.error('Usage: node scripts/okf-safe-rename-textpass.mjs --vault <dir>');
    process.exit(1);
  }
  return args;
}

function newestManifest(vaultAbs) {
  const root = path.join(vaultAbs, '.okf-rename-backup');
  if (!fs.existsSync(root)) return null;
  const stamps = fs.readdirSync(root).sort().reverse();
  for (const ts of stamps) {
    const m = path.join(root, ts, 'manifest.json');
    if (fs.existsSync(m)) return m;
  }
  return null;
}

function walkTextFiles(vaultAbs) {
  const out = [];
  const walk = (rel) => {
    const abs = rel ? path.join(vaultAbs, rel) : vaultAbs;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (/^(\.|node_modules$)/.test(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(childRel);
      else if (/\.(md|canvas|base)$/i.test(entry.name)) out.push(childRel);
    }
  };
  walk('');
  return out;
}

const args = parseArgs(process.argv);
const vaultAbs = path.resolve(args.vault);
const manifestPath = newestManifest(vaultAbs);
if (!manifestPath) {
  console.log(`No migration manifest under ${vaultAbs} — nothing to repair.`);
  process.exit(0);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const exactMap = new Map(manifest.renames.map((r) => [r.oldPath, r.newPath]));

const files = walkTextFiles(vaultAbs);
let changedFiles = 0;
let totalEdits = 0;
for (const rel of files) {
  const abs = path.join(vaultAbs, rel);
  const raw = fs.readFileSync(abs, 'utf8');
  const r = rewriteExactPaths(raw, exactMap);
  if (r.changed) {
    fs.writeFileSync(abs, r.content, 'utf8');
    changedFiles += 1;
    totalEdits += r.edits;
  }
}

// Residual verification against every old path in the manifest.
const oldPaths = [...exactMap.keys()].sort((a, b) => b.length - a.length);
const residuals = [];
for (const rel of files) {
  const raw = fs.readFileSync(path.join(vaultAbs, rel), 'utf8');
  for (const op of oldPaths) {
    if (raw.includes(op)) {
      residuals.push(`${rel}: ${op}`);
      break;
    }
  }
}

console.log(`=== okf-safe-rename-textpass — ${vaultAbs}`);
console.log(`manifest: ${manifestPath}`);
console.log(`files updated: ${changedFiles} (${totalEdits} substitutions)`);
if (residuals.length === 0) {
  console.log('VERIFY ✅  0 residual old-path mentions.');
  process.exit(0);
}
console.log(`VERIFY ❌  ${residuals.length} residual(s):`);
for (const r of residuals.slice(0, 20)) console.log(`  ${r}`);
process.exit(1);
