#!/usr/bin/env node
/**
 * conventions-audit.mjs — which conventions is each vault ACTUALLY under?
 *
 * For every vault in the router config, on this machine's disk:
 *
 *   - which conventions file the router resolves, and whether there are two
 *     (then it resolves none);
 *   - which of those files are verbatim copies of the reference vault's;
 *   - which `CLAUDE.md.bak-*` backups are the reference vault's history rather
 *     than the vault's own;
 *   - which recommended conventions are absent, with the command that offers
 *     them from the current snippet.
 *
 * The judging is `src/helpers/conventions-audit.mjs`; this file only reads.
 * NOTHING IN THIS SCRIPT WRITES — not to a vault, not to the repository. Each
 * finding carries the repair a human approves, vault by vault, through the
 * router (move_file with its ifMatch) or the `conventions` skill.
 *
 * Remote vaults (served over REST from another machine) have no disk here:
 * they are listed as SKIPPED with the reason, and audited through the MCP tool
 * `audit_vault_conventions` instead. Skipped is not clean.
 *
 * EXIT CODE: what a vault says never fails the run. Being unable to look does
 * (unreadable config, `--vault` matching nothing, empty snippet library) — "no
 * findings" and "never ran" must not share an exit code.
 *
 * Flags:
 *   --vault <name|path>  restrict to one vault
 *   --config <path>      router config (default: the per-user location)
 *   --snippets <dir>     snippet library (default: this repo's)
 *   --json               one JSON document instead of the table
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CLAUDE_MD_CANDIDATES } from '../src/helpers/claude-md-conventions.mjs';
import { auditVaultConventions, backupKey } from '../src/helpers/conventions-audit.mjs';
import { isBackupName } from '../src/helpers/root-docs-filter.mjs';
import { configuredVaultName, referenceVaultPath, registeredVaultPaths } from '../src/helpers/vault-slug.mjs';
import { loadSnippetLibrary } from './conventions-drift.mjs';
import { samePath } from './path-helpers.mjs';
import crypto from 'node:crypto';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const opts = { vault: null, config: null, snippets: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--vault' || a === '--config' || a === '--snippets') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      opts[a.slice(2)] = v;
      i += 1;
    } else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

const sha256Bytes = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Candidates and the backups beside them, read from one vault's disk.
 * @returns {{candidates: object[], backups: object[], unreadable: string[]}}
 */
export function readVaultConventionsFromDisk(vaultRoot) {
  const candidates = [];
  const backups = [];
  const unreadable = [];
  for (const rel of CLAUDE_MD_CANDIDATES) {
    const abs = path.join(vaultRoot, ...rel.split('/'));
    let buf;
    try { buf = fs.readFileSync(abs); } catch (err) {
      // ENOENT / ENOTDIR = absent (a file named like the folder is an absence of
      // the folder); anything else is a read that failed, and is said.
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') unreadable.push(`${rel}: ${err.code || err.message}`);
      continue;
    }
    candidates.push({ path: rel, content: buf.toString('utf8'), sha256: sha256Bytes(buf) });
  }
  // Backups of ANY candidate name, beside any candidate location — whether or
  // not the candidate itself still exists (a vault may hold only its backups).
  const dirs = new Set(CLAUDE_MD_CANDIDATES.map((rel) => path.posix.dirname(rel)));
  for (const dir of dirs) {
    const absDir = dir === '.' ? vaultRoot : path.join(vaultRoot, ...dir.split('/'));
    let names;
    try { names = fs.readdirSync(absDir); } catch (err) {
      // An absent folder is ordinary; one that exists and cannot be listed is not.
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') unreadable.push(`${dir}/: ${err.code || err.message}`);
      continue;
    }
    for (const name of names) {
      if (!name.startsWith('CLAUDE.md') || !isBackupName(name)) continue;
      const rel = dir === '.' ? name : `${dir}/${name}`;
      try {
        backups.push({ path: rel, sha256: sha256Bytes(fs.readFileSync(path.join(absDir, name))) });
      } catch (err) {
        // Vanished between listing and reading = absent, same policy as above.
        if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') unreadable.push(`${rel}: ${err.code || err.message}`);
      }
    }
  }
  return { candidates, backups, unreadable };
}

/**
 * What the reference vault holds: every conventions-file version (its file(s)
 * and their backups, by bytes) and its backups by name AND bytes. Null when the
 * reference vault is absent — the audit then says "unknown".
 * @returns {{fingerprints: Set<string>, backups: Set<string>} | null}
 */
export function referenceFromDisk(referenceRoot) {
  // A DIRECTORY, or unknown: a reference path that is a regular file would
  // turn every read below into a suppressed ENOTDIR and yield an empty — and
  // falsely "known" — reference (review round 3).
  let isDir = false;
  try { isDir = Boolean(referenceRoot) && fs.statSync(referenceRoot).isDirectory(); } catch { isDir = false; }
  if (!isDir) return null;
  const { candidates, backups, unreadable } = readVaultConventionsFromDisk(referenceRoot);
  // A PARTIAL reference is an unknown one: a template file that could not be
  // read would make every copy of it look like a vault's own file.
  if (unreadable.length > 0) return null;
  return {
    fingerprints: new Set([...candidates.map((c) => c.sha256), ...backups.map((b) => b.sha256)]),
    backups: new Set(backups.map((b) => backupKey(b.path, b.sha256))),
  };
}

/** Remote vault names from either config shape (array of records, or name → record). */
export function remoteVaultNames(cfg) {
  const r = cfg?.remoteVaults;
  if (Array.isArray(r)) return r.map((v) => v?.name).filter((n) => typeof n === 'string' && n !== '');
  if (r && typeof r === 'object') return Object.keys(r);
  return [];
}

const LABEL = { ok: 'ok       ', attention: 'attention', broken: 'BROKEN   ', skipped: 'skipped  ' };

function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log('usage: node scripts/conventions-audit.mjs [--vault <name|path>] [--config <path>] [--snippets <dir>] [--json]');
    process.exit(0);
  }
  const snippetsDir = opts.snippets ? path.resolve(opts.snippets) : path.join(REPO, 'skills', 'conventions', 'snippets');
  const { snippets, errors } = loadSnippetLibrary(snippetsDir);
  if (errors.length > 0 || snippets.length === 0) {
    for (const e of errors) console.error(`✗ ${e}`);
    if (snippets.length === 0) console.error(`✗ no convention snippets loaded from ${snippetsDir}`);
    process.exit(1);
  }
  const catalogue = snippets.map((s) => ({ id: s.id, heading: s.heading }));

  const configPath = opts.config
    ? path.resolve(opts.config)
    : path.join(os.homedir(), '.claude', 'obsidian-mcp-router', 'config.json');
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (err) {
    console.error(`✗ cannot read router config ${configPath}: ${err.message}`);
    process.exit(1);
  }

  const reference = referenceVaultPath(cfg);
  const referenceData = referenceFromDisk(reference);
  let vaultPaths = registeredVaultPaths(cfg);
  if (reference && !vaultPaths.some((p) => samePath(p, reference))) vaultPaths = [reference, ...vaultPaths];
  const remote = remoteVaultNames(cfg);

  let remoteSelected = remote;
  if (opts.vault) {
    const want = opts.vault.toLowerCase();
    vaultPaths = vaultPaths.filter((p) => samePath(p, opts.vault)
      || (configuredVaultName(cfg, p) ?? '').toLowerCase() === want
      || path.basename(p).toLowerCase() === want);
    remoteSelected = remote.filter((n) => n.toLowerCase() === want);
    if (vaultPaths.length === 0 && remoteSelected.length === 0) {
      console.error(`✗ no configured vault matches "${opts.vault}"`);
      process.exit(1);
    }
  }

  const rows = [];
  for (const vaultPath of vaultPaths) {
    const name = configuredVaultName(cfg, vaultPath) ?? path.basename(vaultPath);
    const isReference = reference !== null && samePath(vaultPath, reference);
    if (!fs.existsSync(vaultPath)) {
      rows.push({ vault: name, path: vaultPath, verdict: 'skipped', skipped: 'vault folder absent on this machine' });
      continue;
    }
    const read = readVaultConventionsFromDisk(vaultPath);
    const audit = auditVaultConventions({
      vault: name,
      candidates: read.candidates,
      backups: read.backups,
      // The reference vault audited against itself would call its own file a
      // "template copy" and its own backups "inherited": both true and useless.
      referenceFingerprints: isReference ? new Set() : (referenceData?.fingerprints ?? null),
      referenceBackups: isReference ? [] : (referenceData?.backups ?? []),
      catalogue,
    });
    rows.push({ ...audit, path: vaultPath, reference: isReference, unreadable: read.unreadable });
  }
  for (const name of remoteSelected) {
    rows.push({ vault: name, verdict: 'skipped', skipped: 'remote vault — no disk here; use the MCP tool audit_vault_conventions' });
  }

  const counts = rows.reduce((acc, r) => { acc[r.verdict] = (acc[r.verdict] ?? 0) + 1; return acc; }, {});
  if (opts.json) {
    console.log(JSON.stringify({ reference, referenceKnown: referenceData !== null, counts, total: rows.length, vaults: rows }, null, 2));
    process.exit(0);
  }
  console.log(`Conventions audit — ${rows.length} vaults (reference: ${reference ?? 'none configured'}${referenceData ? '' : ', UNREADABLE — template copies cannot be told apart'})`);
  for (const r of rows) {
    const file = r.skipped ? r.skipped : (r.ambiguous ? `${r.candidates.length} files: ${r.candidates.map((c) => c.path).join(' + ')}` : (r.conventionsFile ?? 'no conventions file'));
    console.log(`  ${LABEL[r.verdict] ?? r.verdict} ${String(r.vault).padEnd(34)} ${file}`);
    for (const f of r.findings ?? []) {
      if (f.severity === 'info' && f.kind === 'reference-unknown') continue;
      console.log(`      - [${f.kind}] ${f.message}`);
      if (f.repair?.summary) console.log(`        repair: ${f.repair.summary}`);
    }
    for (const u of r.unreadable ?? []) console.log(`      - unreadable: ${u}`);
  }
  console.log(`\n${Object.entries(counts).map(([k, v]) => `${k} ${v}/${rows.length}`).join(' · ')}`);
  console.log('Nothing was changed. Each repair is proposed vault by vault, and applied only after approval.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
