#!/usr/bin/env node
/**
 * MEASURE THE REAL VAULT FLEET AGAINST `canonicalVaultPath`.
 *
 * Why this script exists: the v0.71.0 CHANGELOG asserted that "none of the
 * 6 791 files in the real vault fleet exercises any of the divergent classes",
 * and nothing in the repo could produce that number — not the corpus, not the
 * command, not the date. An unreproducible number in a release note is worse
 * than no number: it reads as evidence and cannot be checked, and the one that
 * was there was simply wrong (the real count is larger).
 *
 * So: this walks every configured vault root, counts what it finds, and runs
 * each vault-relative path through the ONE canonical guard. A path the guard
 * refuses, or normalises to something different, is reported by name — those
 * are the shapes the v0.71.0 tightening would change behaviour for.
 *
 * READ-ONLY. It opens no file; it only enumerates names.
 *
 *   node scripts/measure-vault-path-shapes.mjs
 *   node scripts/measure-vault-path-shapes.mjs --json
 *   node scripts/measure-vault-path-shapes.mjs --root "C:/VAULTS/extra-vault"
 *
 * Extra roots matter: `portRegistry` lists fewer vaults than exist on disk, so
 * a sweep of the configured set alone is not a sweep of the fleet. Pass the
 * strays explicitly and say so when quoting the number.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadRegistry, resolveConfigPath } from '../src/registry.mjs';
import { canonicalVaultPath } from '../src/helpers/vault-path-guard.mjs';

// THE SCOPE IS PART OF THE NUMBER. A count of "files in the vault fleet" means
// nothing until you say whether it includes the plugin trees: `.obsidian/`
// alone more than doubles it (4 794 → 10 238 on this fleet, 2026-08-06). Vault
// CONTENT is what the guard is about — those are the paths a tool argument can
// name — so that is the default, and `--all` gives the other number rather than
// leaving a reader to guess which one they were shown.
const SKIP_DIRS = new Set(['.git', '.obsidian', 'node_modules', '.trash', '.smart-env']);
const SCAN_ALL = process.argv.includes('--all');

// A SWALLOWED READ ERROR MAKES THE HEADLINE NUMBER A LIE.
//
// This `catch` used to `return out` with the comment "counted as nothing,
// reported by absence" — and absence reports nothing at all. A directory the
// process cannot open (permissions, a dead junction, a sync placeholder, an
// offline network share) contributed zero files, so "5 070 files, 0 refused"
// was indistinguishable from "5 070 of 40 000 files, 0 refused". The whole
// point of this script is that a release note's number be checkable, and a
// number with a silent hole in it is exactly the unreproducible claim it was
// written to replace.
//
// So the skip is COUNTED and printed. Still not fatal — an unreadable subtree
// is a fact about the machine, not about the guard — but a reader now sees
// whether the sweep was complete before quoting it.
function walk(root, rel = '', out = { files: [], dirs: 0, unreadable: [] }) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch (err) {
    out.unreadable.push(`${path.join(root, rel)} — ${err.code || err.message}`);
    return out;
  }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SCAN_ALL && SKIP_DIRS.has(e.name)) continue;
      out.dirs += 1;
      walk(root, r, out);
    } else if (e.isFile()) {
      out.files.push(r);
    }
  }
  return out;
}

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const extraRoots = argv.reduce((acc, a, i) => (argv[i - 1] === '--root' ? [...acc, a] : acc), []);

const registry = await loadRegistry(resolveConfigPath());
const roots = [
  ...registry.vaults.filter((v) => v.type === 'local' && v.path).map((v) => ({ name: v.name, root: v.path })),
  ...extraRoots.map((r) => ({ name: `(--root) ${path.basename(r)}`, root: r })),
];

const report = {
  measuredAt: new Date().toISOString().slice(0, 10),
  configPath: registry.configPath,
  rootsConfigured: registry.vaults.length,
  rootsScanned: 0,
  // Two DIFFERENT failures, deliberately not merged. `rootsUnreadable` is a
  // configured vault whose root is not on disk (ordinary: a vault on an
  // unmounted drive). `subtreesUnreadable` is a directory INSIDE a root that
  // `readdirSync` refused mid-walk — that one silently shrinks `files`, so it is
  // the one that can turn "0 refused" into a claim about a corpus that was never
  // read.
  rootsUnreadable: [],
  subtreesUnreadable: [],
  files: 0,
  markdown: 0,
  refused: [],
  renormalised: [],
};

for (const { name, root } of roots) {
  if (!fs.existsSync(root)) { report.rootsUnreadable.push(`${name} → ${root}`); continue; }
  report.rootsScanned += 1;
  const { files, unreadable } = walk(root);
  report.files += files.length;
  for (const u of unreadable) report.subtreesUnreadable.push(`${name}: ${u}`);
  for (const rel of files) {
    if (rel.toLowerCase().endsWith('.md')) report.markdown += 1;
    try {
      const canon = canonicalVaultPath(rel, 'fleet scan');
      // The guard NORMALISES some shapes rather than refusing them (a leading
      // or trailing slash). A file whose on-disk name does not survive the
      // round trip unchanged is a behaviour change, not just a refusal.
      if (canon !== rel) report.renormalised.push(`${name}: ${rel} → ${canon}`);
    } catch (err) {
      report.refused.push(`${name}: ${rel} — ${err.message}`);
    }
  }
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`measured    : ${report.measuredAt}`);
  console.log(`config      : ${report.configPath}`);
  console.log(`roots       : ${report.rootsScanned} scanned of ${report.rootsConfigured} configured`
    + `${extraRoots.length ? ` (+${extraRoots.length} passed with --root)` : ''}`);
  if (report.rootsUnreadable.length) {
    console.log(`  not on disk: ${report.rootsUnreadable.length}`);
    for (const r of report.rootsUnreadable) console.log(`    ${r}`);
  }
  console.log(`scope       : ${SCAN_ALL ? 'ALL files, plugin trees included' : `vault content (skipping ${[...SKIP_DIRS].join(', ')})`}`);
  // PRINTED EVEN WHEN ZERO. The line is what tells a reader the sweep was
  // complete; hiding it on the happy path would mean its absence carries the
  // information, which is the bug this counter was added to fix.
  console.log(`unreadable  : ${report.subtreesUnreadable.length} subtree(s) skipped mid-walk`
    + `${report.subtreesUnreadable.length ? ' — the file count below is a LOWER BOUND' : ''}`);
  for (const u of report.subtreesUnreadable.slice(0, 20)) console.log(`    ${u}`);
  console.log(`files       : ${report.files} (${report.markdown} markdown)`);
  console.log(`refused     : ${report.refused.length}`);
  for (const r of report.refused.slice(0, 40)) console.log(`    ${r}`);
  console.log(`renormalised: ${report.renormalised.length}`);
  for (const r of report.renormalised.slice(0, 40)) console.log(`    ${r}`);
}
