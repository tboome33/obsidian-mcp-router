#!/usr/bin/env node
/**
 * okf-safe-rename-vault — apply an OKF-safe AT-REST rename to one vault or
 * the whole fleet. Two planning modes, one machinery.
 *
 * CHARSET mode (default) — slugify every name Google's OKF tooling would
 * reject (the 2026-07-29 migration):
 *
 *   node scripts/okf-safe-rename-vault.mjs --vault "C:\VAULTS\Coursera"           # dry-run
 *   node scripts/okf-safe-rename-vault.mjs --vault "C:\VAULTS\Coursera" --apply   # do it
 *
 * TABLE mode — rename an EXPLICIT list of paths, for moves no charset rule
 * can derive (`wiki-meta/index.md` is already conformant; it just has to
 * vacate a basename OKF reserves — the 2026-07-30 catalog/journal decision):
 *
 *   node scripts/okf-safe-rename-vault.mjs --preset okf-reserved-scaffolds --all-vaults
 *   node scripts/okf-safe-rename-vault.mjs --preset okf-reserved-scaffolds --all-vaults --apply
 *   node scripts/okf-safe-rename-vault.mjs --vault <dir> --table my-renames.json --apply
 *
 * `--all-vaults` walks every path in the router config's `portRegistry`;
 * `--vault` is repeatable and adds to that set (unregistered vaults).
 *
 * Dry-run prints the full plan and touches nothing. `--apply`:
 *   1. copies every file that will be renamed or content-edited into
 *      `<vault>/.okf-rename-backup/<timestamp>/` (original bytes, original
 *      relative paths) and writes a `manifest.json` there (reversible);
 *   2. rewrites links in .md (wikilinks, embeds, markdown links) and exact
 *      paths in .canvas/.base;
 *   3. renames files, then directories deepest-first;
 *   4. re-scans and verifies: zero residual references to old names, file
 *      count unchanged, and — charset mode only — zero non-conformant paths.
 *
 * Exit codes: 0 OK (or nothing to do) · 1 bad usage / blocked plan /
 * verification failure. In fleet mode the worst per-vault outcome wins.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { registeredVaultPaths } from '../src/helpers/vault-slug.mjs';

import {
  isOkfSafeSegment,
  buildRenamePlan,
  buildRenamePlanFromTable,
  buildRewriteContext,
  rewriteNoteContent,
  rewriteExactPaths,
  buildExactPathMap,
  orderRenameOps,
  retitleScaffold,
  RENAME_PRESETS,
} from '../src/helpers/okf-safe-rename.mjs';

const SKIP_DIR_RE = /^(\.|node_modules$)/;

// Same resolution order as setup-vault.mjs / the router binary.
const CONFIG_PATH = process.env.OBSIDIAN_ROUTER_CONFIG
  ? path.resolve(process.env.OBSIDIAN_ROUTER_CONFIG)
  : path.join(os.homedir(), '.claude', 'obsidian-mcp-router', 'config.json');

function usage(msg) {
  if (msg) console.error(`✗ ${msg}`);
  console.error(
    'Usage:\n' +
      '  okf-safe-rename-vault.mjs --vault <dir> [--vault <dir>…] [--apply] [--list-all]\n' +
      '  okf-safe-rename-vault.mjs --preset <name> (--all-vaults | --vault <dir>…) [--apply]\n' +
      '  okf-safe-rename-vault.mjs --table <file.json> (--all-vaults | --vault <dir>…) [--apply]\n' +
      '\n' +
      'Options:\n' +
      '  --all-vaults          every vault in the router config portRegistry\n' +
      '  --preset <name>       a shipped rename table (see below)\n' +
      '  --table <file.json>   [{oldPath,newPath}…] or {renames:[…],preserveDisplay:bool}\n' +
      '  --no-alias            rewritten wikilinks do NOT keep the old text as alias\n' +
      '  --preserve-display    force the display-preserving alias back on\n' +
      '  --apply               execute (default is dry-run)\n' +
      '  --list-all            print every rename instead of the first 25\n' +
      '\n' +
      'Presets:\n' +
      Object.entries(RENAME_PRESETS)
        .map(([name, p]) => `  ${name}\n      ${p.description}`)
        .join('\n') +
      '\n',
  );
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    vaults: [],
    apply: false,
    listAll: false,
    allVaults: false,
    preset: null,
    tableFile: null,
    preserveDisplay: null, // null = take the preset/table default
  };
  // A flag that takes a value must actually have one — otherwise `argv[++i]`
  // is undefined and we crash with a stack trace instead of printing usage.
  const value = (flag, i) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) usage(`${flag} requires a value.`);
    return v;
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--vault') args.vaults.push(value(a, i++));
    else if (a === '--apply') args.apply = true;
    else if (a === '--list-all') args.listAll = true;
    else if (a === '--all-vaults') args.allVaults = true;
    else if (a === '--preset') args.preset = value(a, i++);
    else if (a === '--table') args.tableFile = value(a, i++);
    else if (a === '--no-alias') args.preserveDisplay = false;
    else if (a === '--preserve-display') args.preserveDisplay = true;
    else usage(`Unknown argument: ${a}`);
  }

  if (args.preset && args.tableFile) usage('--preset and --table are mutually exclusive.');
  if (args.preset && !RENAME_PRESETS[args.preset]) {
    usage(`Unknown preset "${args.preset}". Known: ${Object.keys(RENAME_PRESETS).join(', ')}`);
  }

  // Resolve the rename table (null → charset mode).
  let table = null;
  let presetPreserveDisplay = true;
  args.retitle = [];
  if (args.preset) {
    const p = RENAME_PRESETS[args.preset];
    table = p.renames;
    presetPreserveDisplay = p.preserveDisplay !== false;
    args.retitle = p.retitle ?? [];
  } else if (args.tableFile) {
    if (!fs.existsSync(args.tableFile)) usage(`--table file not found: ${args.tableFile}`);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(args.tableFile, 'utf8'));
    } catch (e) {
      usage(`--table file is not valid JSON: ${e.message}`);
    }
    table = Array.isArray(parsed) ? parsed : parsed?.renames;
    if (!Array.isArray(table) || table.length === 0) {
      usage('--table file must be a non-empty array, or {"renames":[…]}.');
    }
    if (!Array.isArray(parsed)) {
      presetPreserveDisplay = parsed.preserveDisplay !== false;
      args.retitle = Array.isArray(parsed.retitle) ? parsed.retitle : [];
    }
  }
  args.table = table;
  args.preserveDisplay = args.preserveDisplay ?? presetPreserveDisplay;

  // Resolve the vault set.
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
  const registered = registeredVaultPaths(cfg);
    if (registered.length === 0) usage(`Router config has no vaults in portRegistry (${CONFIG_PATH}).`);
    paths.push(...registered);
  }
  paths.push(...args.vaults);
  if (paths.length === 0) usage('Nothing to do — pass --vault <dir> and/or --all-vaults.');

  // De-duplicate (a registered vault also passed explicitly) and validate.
  const seen = new Set();
  args.resolved = [];
  for (const p of paths) {
    const abs = path.resolve(p);
    const key = abs.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      args.resolved.push({ abs, unreachable: true });
    } else {
      args.resolved.push({ abs, unreachable: false });
    }
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

/**
 * Plan + optionally apply the rename for ONE vault.
 * @returns {{status: 'ok'|'nothing'|'planned'|'blocked'|'failed', ...}}
 */
function processVault(vaultAbs, args) {
  const label = `\n=== okf-safe-rename — ${vaultAbs} ${args.apply ? '(APPLY)' : '(dry-run)'} ===`;
  const files = walkFiles(vaultAbs);
  const plan = args.table
    ? buildRenamePlanFromTable(files, args.table)
    : buildRenamePlan(files);
  // Retitle entries only apply to files this run actually renames — which
  // also confines them to the vault: every value in `fileMap` came through
  // the planner's `..`-rejection, so a hand-written `retitle` path pointing
  // outside (or at a file this run never touched) simply never matches.
  const newPathsLower = new Set([...plan.fileMap.values()].map((p) => p.toLowerCase()));
  const retitles = (args.retitle ?? []).filter((r) =>
    newPathsLower.has(String(r?.path ?? '').replace(/\\/g, '/').toLowerCase()),
  );
  const retitled = [];

  const fileOps = plan.renameOps.filter((r) => !r.isDir);
  const dirOps = plan.renameOps.filter((r) => r.isDir);

  console.log(label);
  console.log(`mode:                 ${args.table ? `table${args.preset ? ` (preset ${args.preset})` : ''}` : 'charset'}`);
  console.log(`files scanned:        ${files.length}`);
  console.log(`files to rename:      ${fileOps.length}`);
  console.log(`directories to rename:${dirOps.length}`);
  if (args.table) {
    console.log(`display preserved:    ${args.preserveDisplay ? 'yes (old text kept as alias)' : 'no (visible text follows the target)'}`);
    if (plan.missing.length) console.log(`not present here:     ${plan.missing.join(', ')}`);
  } else {
    console.log(`collision suffixes:   ${plan.collisionsResolved.length}`);
  }
  if (plan.ambiguousStems.length) {
    console.log(`ambiguous old stems:  ${plan.ambiguousStems.length} → ${plan.ambiguousStems.join(', ')}`);
    for (const d of plan.ambiguityDetail ?? []) {
      console.log(`   [[${d.stem}]] — ${d.reason}`);
      for (const c of d.conflicting.slice(0, 5)) console.log(`      also: ${c}`);
    }
  }

  // Pre-flight against the real filesystem. The planner reasons over a list of
  // FILES, so anything that isn't a file is invisible to it — notably an EMPTY
  // directory (or one holding only dot-dirs) sitting at a destination. That
  // slips through planning and then throws EPERM in the middle of the apply.
  // Checking the destinations on disk is three lines and turns a partial apply
  // into a clean refusal.
  for (const op of plan.renameOps) {
    const targetAbs = path.join(vaultAbs, ...op.newPath.split('/'));
    if (fs.existsSync(targetAbs)) {
      (plan.collisions ??= []).push({
        oldPath: op.oldPath,
        newPath: op.newPath,
        reason: 'target exists on disk but not in the scanned file list (empty directory?) — refusing',
      });
    }
  }

  // Blocking collisions: an explicit table gets refused, never auto-suffixed.
  if (plan.collisions?.length) {
    console.log(`\nBLOCKED — ${plan.collisions.length} collision(s):`);
    for (const c of plan.collisions) console.log(`  ${c.oldPath} → ${c.newPath}: ${c.reason}`);
    console.log('  Resolve these by hand (or amend the table); nothing was touched.');
    return { status: 'blocked', collisions: plan.collisions.length };
  }

  if (plan.renameOps.length === 0) {
    console.log(args.table ? '\nNothing from the table is present — skipped.' : '\nVault is already OKF-safe — nothing to do.');
    return { status: 'nothing' };
  }

  // -------------------------------------------------------------------------
  // Content rewriting pass (computed in memory for both modes)
  // -------------------------------------------------------------------------

  const ctx = buildRewriteContext(plan, { preserveDisplay: args.preserveDisplay });
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
  if (retitles.length) {
    console.log(`scaffolds retitled:   ${retitles.length} (${retitles.map((r) => r.path.split('/').pop()).join(', ')})`);
  }
  if (totalSkippedAmbiguous > 0) {
    console.log(`⚠ links left untouched because their old stem is ambiguous: ${totalSkippedAmbiguous}`);
  }

  const shown = args.listAll ? plan.renameOps : plan.renameOps.slice(0, 25);
  console.log('Renames:');
  for (const r of shown) console.log(`  ${r.isDir ? 'DIR ' : 'file'}  ${r.oldPath}  →  ${r.newPath}`);
  if (shown.length < plan.renameOps.length) {
    console.log(`  … ${plan.renameOps.length - shown.length} more (use --list-all)`);
  }

  if (!args.apply) {
    console.log('Dry-run only — re-run with --apply to execute.');
    return { status: 'planned', fileOps: fileOps.length, dirOps: dirOps.length, edits: edits.length };
  }

  // -------------------------------------------------------------------------
  // APPLY: backup → content edits → renames → manifest → verify
  // -------------------------------------------------------------------------

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

  // The manifest is written BEFORE anything is mutated. A rename can fail
  // mid-way (EBUSY/EPERM — Obsidian holding a file is entirely plausible
  // across 24 vaults) or the process can simply be killed, and without the
  // manifest already on disk the operator is left with a half-migrated vault,
  // no record of what was attempted, and no pointer to the backup.
  const manifestPath = path.join(backupDir, 'manifest.json');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        vault: vaultAbs,
        timestamp: ts,
        status: 'planned',
        mode: args.table ? 'table' : 'charset',
        preset: args.preset ?? null,
        preserveDisplay: args.preserveDisplay,
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

  // Both outcomes AMEND that record — read, merge, write back. Deliberately
  // not a fresh write: if the pre-mutation manifest is missing, the ordering
  // guarantee above has been broken, and silently creating one here would hide
  // exactly the bug this ordering exists to prevent. It also keeps the two
  // paths honest — a `status` can only ever describe a run that was recorded
  // before it started.
  const amendManifest = (status, extra = {}) => {
    const base = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    fs.writeFileSync(manifestPath, JSON.stringify({ ...base, status, ...extra }, null, 2), 'utf8');
  };

  try {
    for (const e of edits) {
      fs.writeFileSync(path.join(vaultAbs, e.relPath), e.newContent, 'utf8');
    }

    // Rename within the entry's OWN parent directory, by basename. This is
    // required in charset mode: files are renamed while their ancestors still
    // carry old names, so a full-path join would miss. Table mode can't reach
    // here with a different parent — `buildRenamePlanFromTable` refuses a
    // cross-directory entry as a collision (a `newPath` in another directory
    // would silently land the file next to the original while links and the
    // manifest recorded the intended destination, and verification would
    // still pass).
    for (const op of orderRenameOps(plan.renameOps)) {
      const oldAbs = path.join(vaultAbs, op.oldPath);
      const newBasename = op.newPath.split('/').pop();
      const targetAbs = path.join(path.dirname(oldAbs), newBasename);
      fs.renameSync(oldAbs, targetAbs);
    }

    // Post-rename retitle: the scaffold's own H1/`title:` still names the old
    // object. Runs on the NEW path, so it has to come after the renames. The
    // original bytes are already in the backup (the file was renamed).
    for (const r of retitles) {
      const abs = path.join(vaultAbs, r.path);
      if (!fs.existsSync(abs)) continue;
      const res = retitleScaffold(fs.readFileSync(abs, 'utf8'), r.words);
      if (res.changed) {
        fs.writeFileSync(abs, res.content, 'utf8');
        retitled.push({ relPath: r.path, edits: res.edits });
      }
    }
  } catch (err) {
    // Point at the backup before rethrowing — the driver only prints the
    // message, and a half-applied vault is exactly when the operator needs
    // that path.
    const detail = String(err && err.message ? err.message : err);
    amendManifest('failed', { retitled, error: detail });
    throw new Error(`${detail} — partial apply; backup + manifest: ${backupDir}`);
  }
  amendManifest('applied', { retitled });

  // -------------------------------------------------------------------------
  // Verify
  // -------------------------------------------------------------------------

  const after = walkFiles(vaultAbs);
  const problems = [];

  if (after.length !== files.length) {
    problems.push(`file count changed: ${files.length} → ${after.length}`);
  }
  // Charset conformity is what charset mode promised. A table promises only
  // the listed renames, so pre-existing non-conformant names elsewhere are
  // not this run's failure.
  if (!args.table) {
    const stillBad = nonConformantMdPaths(after);
    if (stillBad.length > 0) {
      problems.push(`non-conformant md paths remain: ${stillBad.length}`);
      for (const p of stillBad.slice(0, 10)) problems.push(`   ${p}`);
    }
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

  console.log(`Backup + manifest: ${backupDir}`);
  if (problems.length === 0) {
    console.log(`VERIFY ✅  ${fileOps.length} files + ${dirOps.length} dirs renamed, ${edits.length} files re-linked, 0 residual references, file count stable.`);
    return { status: 'ok', fileOps: fileOps.length, dirOps: dirOps.length, edits: edits.length, linkEdits: totalLinkEdits, backupDir };
  }
  console.log('VERIFY ❌');
  for (const p of problems) console.log(`  ${p}`);
  return { status: 'failed', problems: problems.length, residualRefs, backupDir };
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv);
const results = [];

for (const { abs, unreachable } of args.resolved) {
  if (unreachable) {
    console.log(`\n=== okf-safe-rename — ${abs}`);
    console.log('SKIPPED — not an existing directory (stale config entry?).');
    results.push({ vault: abs, status: 'unreachable' });
    continue;
  }
  try {
    results.push({ vault: abs, ...processVault(abs, args) });
  } catch (e) {
    console.log(`FAILED — ${e.message}`);
    results.push({ vault: abs, status: 'failed', problems: 1, error: e.message });
  }
}

if (args.resolved.length > 1) {
  const tally = results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
  console.log(`\n=== fleet summary — ${results.length} vault(s) ===`);
  for (const r of results) {
    const detail =
      r.status === 'ok' || r.status === 'planned'
        ? ` (${r.fileOps} files, ${r.dirOps} dirs, ${r.edits} re-linked)`
        : '';
    console.log(`  ${r.status.padEnd(11)} ${r.vault}${detail}`);
  }
  console.log(
    '  ' +
      Object.entries(tally)
        .map(([k, v]) => `${k}: ${v}`)
        .join(' · '),
  );
  const touched = results.filter((r) => r.status === 'ok' || r.status === 'planned');
  console.log(
    `  totals: ${touched.reduce((n, r) => n + (r.fileOps ?? 0), 0)} files + ` +
      `${touched.reduce((n, r) => n + (r.dirOps ?? 0), 0)} dirs renamed, ` +
      `${touched.reduce((n, r) => n + (r.edits ?? 0), 0)} files re-linked` +
      `${args.apply ? '' : ' (dry-run)'}`,
  );
}

const bad = results.filter((r) => r.status === 'failed' || r.status === 'blocked');
process.exit(bad.length > 0 ? 1 : 0);
