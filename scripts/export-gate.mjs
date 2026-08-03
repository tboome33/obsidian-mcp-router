#!/usr/bin/env node
/**
 * export-gate.mjs — CLI front-end for C9's export gate.
 *
 * Three subcommands, one per question an operator actually asks:
 *
 *   scan  [target] [--root <dir>]   What would ship, and does it leak?
 *   audit <archive> [--sha256 <h>]  Is this finished artifact intact and safe
 *                                   to extract? (Nothing is unpacked.)
 *   sums  [target] [--root <dir>]   Print the SHA256SUMS the gate would emit.
 *
 * `scan` is what `npm run gate` and the CI step run: it exits 1 on any
 * finding, so a leak fails the build instead of appearing in a log nobody
 * reads. There is no flag that turns the scan off — silence an unwanted
 * finding by adding a `scanExceptions` entry WITH a written reason to
 * contracts/export-allowlist.json.
 *
 * Private roots (the ones that must never appear in a published file) are
 * assembled here rather than committed: the repo's own absolute path, the
 * user's home directory, and anything in the semicolon/colon-separated
 * OBSIDIAN_ROUTER_EXPORT_PRIVATE_ROOTS environment variable.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  gateDirectory,
  auditArchive,
  renderFindings,
  sha256,
  LEAK_CATEGORIES,
} from '../src/helpers/export-gate.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const CONTRACT_REL = 'contracts/export-allowlist.json';

/**
 * Absolute paths that must never appear inside a published artifact.
 *
 * The repo root and the home directory are derived, never stored: a contract
 * file listing `C:\VAULTS\…` in order to detect it being published would
 * itself publish it.
 */
export function collectPrivateRoots({ repoRoot = REPO_ROOT, env = process.env, homedir = os.homedir() } = {}) {
  const roots = new Set();
  if (repoRoot) roots.add(repoRoot);
  if (homedir) roots.add(homedir);
  const extra = env.OBSIDIAN_ROUTER_EXPORT_PRIVATE_ROOTS;
  if (extra) {
    // `;` always separates. `:` separates only inside a piece that is NOT a
    // Windows drive path, so `C:\VAULTS;D:\work` and `/srv/a:/srv/b` both
    // parse. A single lookbehind cannot do this: in `/srv/a:/srv/b` the
    // separating colon IS preceded by a letter, so "not preceded by a letter"
    // refuses to split it.
    for (const piece of String(extra).split(';')) {
      const parts = /^[A-Za-z]:[\\/]/.test(piece.trim()) ? [piece] : piece.split(':');
      for (const part of parts) {
        const t = part.trim();
        if (t) roots.add(t);
      }
    }
  }
  return [...roots];
}

export function readContract(repoRoot = REPO_ROOT) {
  const abs = path.join(repoRoot, CONTRACT_REL);
  const raw = fs.readFileSync(abs);
  return { contract: JSON.parse(raw.toString('utf8')), sha256: sha256(raw), path: CONTRACT_REL };
}

function gitSource(repoRoot = REPO_ROOT) {
  const run = (args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
  try {
    return {
      commit: run(['rev-parse', 'HEAD']),
      ref: (() => { try { return run(['rev-parse', '--abbrev-ref', 'HEAD']); } catch { return null; } })(),
      dirty: run(['status', '--porcelain']).length > 0,
    };
  } catch {
    return { commit: null, ref: null, dirty: null };
  }
}

function productVersion(repoRoot = REPO_ROOT) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
}

function arg(name, argv, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const command = argv.find((a) => !a.startsWith('--')) || 'scan';

  if (command === 'audit') {
    const file = argv.filter((a) => !a.startsWith('--'))[1];
    if (!file) { process.stderr.write('usage: export-gate.mjs audit <archive.mcpb> [--sha256 <hex>]\n'); process.exit(2); }
    const buf = fs.readFileSync(path.resolve(file));
    // The audit re-runs the leak scan over the archive's contents, so it needs
    // the same contract inputs the build used. Without them every bundle this
    // repo produces "fails" its own audit on the nine findings the contract
    // legitimately suppresses — and an operator learns to ignore the tool.
    // The exceptions are scoped to named packages, so applying them to an
    // archive from elsewhere stays conservative.
    const { contract } = readContract();
    // The target is read from the ARCHIVE's own manifest, never assumed. It
    // decides which target-scoped exceptions apply, and hardcoding `mcpb` here
    // applied this repo's bundle exceptions to an OKF bundle from somebody
    // else — muting rules on a knowledge bundle that was never covered by them.
    // `--target` overrides for an archive that carries no manifest.
    let archiveTarget = arg('target', argv);
    if (!archiveTarget) {
      const peek = auditArchive(buf, { deep: true, scanContents: false });
      archiveTarget = peek.manifest?.target ?? null;
    }
    const result = auditArchive(buf, {
      expectArchiveSha256: arg('sha256', argv),
      target: archiveTarget,
      privatePathRoots: collectPrivateRoots(),
      emailAllowlist: contract.emailAllowlist || [],
      exceptions: contract.scanExceptions || [],
    });
    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`archive:  ${path.basename(file)}`);
      console.log(`sha256:   ${result.archiveSha256}`);
      console.log(`entries:  ${result.entryCount}`);
      if (result.manifest) {
        console.log(`built from: ${result.manifest.source?.commit ?? 'unknown commit'}`
          + `${result.manifest.source?.dirty ? ' (dirty worktree)' : ''}`
          + ` · v${result.manifest.productVersion ?? '?'}`
          + ` · node ${result.manifest.build?.node ?? '?'} / zlib ${result.manifest.build?.zlibVersion ?? '?'}`);
      }
      if (result.ok) {
        // Deliberately NOT "this archive is safe": the checksum chain proves
        // the archive agrees with itself, and only `--sha256 <hash>` obtained
        // elsewhere establishes that it is the artifact the publisher built.
        console.log('\naudit: OK — names are safe to extract, contents match their checksums, no leak found.');
        console.log(result.authenticityVerified
          ? '  authenticity: verified against the hash you supplied.'
          : '  authenticity: NOT established — pass --sha256 <hash from the publisher> to check it.');
      } else {
        console.log(`\naudit: ${result.problems.length} problem(s)`);
        for (const p of result.problems) console.log(`  [${p.kind}] ${p.entry ? `${p.entry}: ` : ''}${p.detail}`);
      }
    }
    process.exitCode = result.ok ? 0 : 1;
  } else if (command === 'scan' || command === 'sums') {
    const target = argv.filter((a) => !a.startsWith('--'))[1] || 'mcpb';
    const root = path.resolve(arg('root', argv, REPO_ROOT));
    const { contract, sha256: contractSha, path: contractPath } = readContract();

    const result = gateDirectory({
      root,
      contract,
      target,
      productVersion: productVersion(),
      source: gitSource(),
      privatePathRoots: collectPrivateRoots(),
      contractSha256: contractSha,
      contractPath,
    });

    if (command === 'sums') {
      process.stdout.write(result.checksums);
      process.exitCode = 0;
    } else if (asJson) {
      console.log(JSON.stringify({
        ok: result.ok,
        target,
        included: result.included.length,
        excluded: result.excluded.length,
        byCategory: result.scan.byCategory,
        scanKinds: result.scan.scanKinds,
        findings: result.scan.findings,
        suppressed: result.scan.suppressed,
      }, null, 2));
      process.exitCode = result.ok ? 0 : 1;
    } else {
      const zones = {};
      for (const i of result.included) zones[i.zone] = (zones[i.zone] || 0) + 1;
      console.log(`export gate · target "${target}" · root ${root}`);
      console.log(`  included: ${result.included.length} `
        + `(${Object.entries(zones).map(([z, n]) => `${z} ${n}`).join(', ') || 'none'})`);
      console.log(`  excluded by the allowlist: ${result.excluded.length}`);
      console.log(`  categories scanned: ${LEAK_CATEGORIES.join(', ')}`);
      // How much was actually READ as text. 'No leak found' over a tree that
      // was largely unreadable is a different statement from the same words
      // over one that was fully read — and the previous two attempts at this
      // counter both ended up with no consumer at all.
      const kinds = result.scan.scanKinds || {};
      const readAs = Object.entries(kinds)
        .filter(([, n]) => n > 0)
        .map(([kind, n]) => `${kind} ${n}`)
        .join(', ');
      console.log(`  read as: ${readAs || 'nothing'}`);
      if (result.scan.suppressed.length) {
        console.log(`  suppressed by contract exceptions: ${result.scan.suppressed.length}`);
      }
      console.log('');
      console.log(renderFindings(result.scan.findings));
      process.exitCode = result.ok ? 0 : 1;
    }
  } else {
    process.stderr.write(`unknown command "${command}" — expected scan | audit | sums\n`);
    process.exit(2);
  }
}
