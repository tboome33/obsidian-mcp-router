#!/usr/bin/env node
/**
 * okf-safe-rename-vault — apply the OKF-safe AT-REST rename plan to one vault.
 *
 *   node scripts/okf-safe-rename-vault.mjs --vault "C:\VAULTS\Coursera"           # dry-run
 *   node scripts/okf-safe-rename-vault.mjs --vault "C:\VAULTS\Coursera" --apply   # do it
 *
 * Dry-run prints the full plan and touches nothing. `--apply`:
 *   1. copies every file that will be renamed or content-edited into
 *      `<vault>/.okf-rename-backup/<timestamp>/` (original bytes, original
 *      relative paths) and writes a `manifest.json` there (reversible);
 *   2. rewrites links in .md (wikilinks, embeds, markdown links) and exact
 *      paths in .canvas/.base;
 *   3. renames files, then directories deepest-first;
 *   4. re-scans and verifies: zero non-conformant .md paths left, zero
 *      residual references to old names, file count unchanged.
 *
 * Exit codes: 0 OK (or nothing to do) · 1 bad usage / verification failure.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  isOkfSafeSegment,
  buildRenamePlan,
  buildRewriteContext,
  rewriteNoteContent,
  rewriteExactPaths,
  buildExactPathMap,
  orderRenameOps,
} from '../src/helpers/okf-safe-rename.mjs';

const SKIP_DIR_RE = /^(\.|node_modules$)/;

function parseArgs(argv) {
  const args = { vault: null, apply: false, listAll: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--vault') args.vault = argv[++i];
    else if (a === '--apply') args.apply = true;
    else if (a === '--list-all') args.listAll = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  if (!args.vault || !fs.existsSync(args.vault) || !fs.statSync(args.vault).isDirectory()) {
    console.error('Usage: node scripts/okf-safe-rename-vault.mjs --vault <dir> [--apply] [--list-all]');
    process.exit(1);
  }
  return args;
}

/** Recursively list vault-relative posix file paths, skipping dot dirs. */
function walkFiles(vaultAbs) {
  const out = [];
  const walk = (rel) => {
    const abs = rel ? path.join(vaultAbs, rel) : vaultAbs;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (SKIP_DIR_RE.test(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(childRel);
      else if (entry.isFile()) out.push(childRel);
    }
  };
  walk('');
  return out;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nonConformantMdPaths(files) {
  return files.filter((f) => {
    if (!/\.md$/i.test(f)) return false;
    const segs = f.split('/');
    return segs.some((seg, i) => {
      const stem = i === segs.length - 1 ? seg.replace(/\.md$/i, '') : seg;
      return !isOkfSafeSegment(stem);
    });
  });
}

const args = parseArgs(process.argv);
const vaultAbs = path.resolve(args.vault);
const files = walkFiles(vaultAbs);
const plan = buildRenamePlan(files);

const fileOps = plan.renameOps.filter((r) => !r.isDir);
const dirOps = plan.renameOps.filter((r) => r.isDir);

console.log(`\n=== okf-safe-rename — ${vaultAbs} ${args.apply ? '(APPLY)' : '(dry-run)'} ===`);
console.log(`files scanned:        ${files.length}`);
console.log(`md files to rename:   ${fileOps.length}`);
console.log(`directories to rename:${dirOps.length}`);
console.log(`collision suffixes:   ${plan.collisionsResolved.length}`);
console.log(`ambiguous old stems:  ${plan.ambiguousStems.length}${plan.ambiguousStems.length ? ' → ' + plan.ambiguousStems.join(', ') : ''}`);

if (plan.renameOps.length === 0) {
  console.log('\nVault is already OKF-safe — nothing to do.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Content rewriting pass (computed in memory for both modes)
// ---------------------------------------------------------------------------

const ctx = buildRewriteContext(plan);
const exactMap = buildExactPathMap(plan);
const mdFiles = files.filter((f) => /\.md$/i.test(f));
const structuredFiles = files.filter((f) => /\.(canvas|base)$/i.test(f));

const edits = []; // {relPath, newContent, edits}
let totalLinkEdits = 0;
let totalSkippedAmbiguous = 0;

for (const rel of mdFiles) {
  const raw = fs.readFileSync(path.join(vaultAbs, rel), 'utf8');
  const linkPass = rewriteNoteContent(raw, rel, ctx);
  totalSkippedAmbiguous += linkPass.skippedAmbiguous;
  // Raw-text pass: session journals, CLAUDE.md and friends cite old paths
  // as plain text (no link syntax) — exact strings, safe to substitute.
  const rawPass = rewriteExactPaths(linkPass.content, exactMap);
  if (rawPass.content !== raw) {
    edits.push({ relPath: rel, newContent: rawPass.content, edits: linkPass.edits + rawPass.edits });
    totalLinkEdits += linkPass.edits + rawPass.edits;
  }
}
for (const rel of structuredFiles) {
  const raw = fs.readFileSync(path.join(vaultAbs, rel), 'utf8');
  const r = rewriteExactPaths(raw, exactMap);
  if (r.changed) {
    edits.push({ relPath: rel, newContent: r.content, edits: r.edits });
    totalLinkEdits += r.edits;
  }
}

console.log(`notes/canvas edited:  ${edits.length} (${totalLinkEdits} link edits)`);
if (totalSkippedAmbiguous > 0) {
  console.log(`⚠ links left untouched because their old stem is ambiguous: ${totalSkippedAmbiguous}`);
}

const shown = args.listAll ? plan.renameOps : plan.renameOps.slice(0, 25);
console.log('\nRenames:');
for (const r of shown) console.log(`  ${r.isDir ? 'DIR ' : 'file'}  ${r.oldPath}  →  ${r.newPath}`);
if (shown.length < plan.renameOps.length) {
  console.log(`  … ${plan.renameOps.length - shown.length} more (use --list-all)`);
}

if (!args.apply) {
  console.log('\nDry-run only — re-run with --apply to execute.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// APPLY: backup → content edits → renames → manifest → verify
// ---------------------------------------------------------------------------

const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const backupDir = path.join(vaultAbs, '.okf-rename-backup', ts);

fs.mkdirSync(backupDir, { recursive: true });
const touchedFiles = new Set(edits.map((e) => e.relPath));
for (const op of fileOps) touchedFiles.add(op.oldPath);
for (const rel of touchedFiles) {
  const dest = path.join(backupDir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(vaultAbs, rel), dest);
}

for (const e of edits) {
  fs.writeFileSync(path.join(vaultAbs, e.relPath), e.newContent, 'utf8');
}

for (const op of orderRenameOps(plan.renameOps)) {
  const oldAbs = path.join(vaultAbs, op.oldPath);
  const newBasename = op.newPath.split('/').pop();
  const targetAbs = path.join(path.dirname(oldAbs), newBasename);
  fs.renameSync(oldAbs, targetAbs);
}

fs.writeFileSync(
  path.join(backupDir, 'manifest.json'),
  JSON.stringify(
    {
      vault: vaultAbs,
      timestamp: ts,
      renames: plan.renameOps,
      editedFiles: edits.map((e) => ({ relPath: e.relPath, linkEdits: e.edits })),
      collisionsResolved: plan.collisionsResolved,
      ambiguousStems: plan.ambiguousStems,
    },
    null,
    2,
  ),
  'utf8',
);

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

const after = walkFiles(vaultAbs);
const problems = [];

if (after.length !== files.length) {
  problems.push(`file count changed: ${files.length} → ${after.length}`);
}
const stillBad = nonConformantMdPaths(after);
if (stillBad.length > 0) {
  problems.push(`non-conformant md paths remain: ${stillBad.length}`);
  for (const p of stillBad.slice(0, 10)) problems.push(`   ${p}`);
}

const oldStemPatterns = plan.stemRenames
  .filter((r) => !plan.ambiguousStems.includes(r.oldStem.toLowerCase()))
  .map((r) => new RegExp(`\\[\\[${escapeRegExp(r.oldStem)}(\\]\\]|#|\\|)`, 'i'));
const oldPaths = [...exactMap.keys()];
let residualRefs = 0;
for (const rel of after.filter((f) => /\.(md|canvas|base)$/i.test(f))) {
  const raw = fs.readFileSync(path.join(vaultAbs, rel), 'utf8');
  for (const re of oldStemPatterns) {
    if (re.test(raw)) {
      residualRefs += 1;
      problems.push(`residual wikilink in ${rel}: ${re.source}`);
      break;
    }
  }
  for (const op of oldPaths) {
    if (raw.includes(op)) {
      residualRefs += 1;
      problems.push(`residual old path in ${rel}: ${op}`);
      break;
    }
  }
}

console.log(`\nBackup + manifest: ${backupDir}`);
if (problems.length === 0) {
  console.log(`VERIFY ✅  ${fileOps.length} files + ${dirOps.length} dirs renamed, ${edits.length} files re-linked, 0 residual references, file count stable.`);
  process.exit(0);
} else {
  console.log('VERIFY ❌');
  for (const p of problems) console.log(`  ${p}`);
  process.exit(1);
}
