#!/usr/bin/env node
/**
 * build-mcpb.mjs — build the MCPHub bundle THROUGH the C9 export gate.
 *
 * Replaces the robocopy + `Compress-Archive` pipeline in `build-mcpb.ps1`,
 * which had two defects that no amount of care could fix in place:
 *
 *   1. It selected files with a DENY list (`/XD` + `/XF`). A deny list is only
 *      as complete as the last time somebody remembered it, and it was not:
 *      `.codex/config.toml` — a live Authorization bearer token — shipped
 *      inside obsidian-mcp-router-v0.67.1.mcpb, together with `.superpowers/`
 *      internal review diffs, because those directories were created after the
 *      exclusions were written. Selection is now a whitelist in
 *      `contracts/export-allowlist.json`.
 *   2. `Compress-Archive` stamps every entry with its real mtime and walks the
 *      tree in filesystem order, so two builds of one commit produced
 *      different bytes and nothing could tie a published bundle to its source.
 *
 * Pipeline: stage (whitelist) → npm ci → gate (whitelist + scan) → checksums
 * → manifest → deterministic zip → sidecars.
 *
 * Usage:
 *   node scripts/build-mcpb.mjs                     build
 *   node scripts/build-mcpb.mjs --keep-staging      reuse node_modules (fast)
 *   node scripts/build-mcpb.mjs --verify-writer-idempotent
 *                                                   zip the same entry list twice
 *                                                   and compare (writer only —
 *                                                   CI proves the full claim)
 *   node scripts/build-mcpb.mjs --compression store zlib-independent archive
 *
 * Exit codes: 0 built · 1 the gate found a leak, or a step failed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  gateDirectory,
  applyAllowlist,
  collectFiles,
  scanEntries,
  buildChecksums,
  buildGateManifest,
  serializeManifest,
  createDeterministicZip,
  auditArchive,
  renderFindings,
  sha256,
  CHECKSUM_FILE,
  MANIFEST_FILE,
} from '../src/helpers/export-gate.mjs';
import { readContract, collectPrivateRoots } from './export-gate.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const BUNDLE_BASE_NAME = 'obsidian-mcp-router';

/**
 * The MCPHub manifest that sits at the archive root.
 *
 * Carries NO build timestamp — a clock in here would make "same commit, same
 * bytes" false on its own. MCPHub prefixes `server-` to the extraction
 * directory, so the entry path is derived from the bundle base name rather
 * than written twice.
 */
export function buildMcphubManifest(version) {
  return {
    manifest_version: '1.0',
    name: BUNDLE_BASE_NAME,
    version,
    description: 'Multi-vault MCP router for Obsidian Local REST API. Bundle for MCPHub deployment.',
    server: {
      mcp_config: {
        command: 'node',
        args: [`/app/data/uploads/mcpb/server-${BUNDLE_BASE_NAME}/server/bin/${BUNDLE_BASE_NAME}.mjs`],
        env: {
          OBSIDIAN_ROUTER_ALLOWED_VAULTS: '${OBSIDIAN_ROUTER_ALLOWED_VAULTS}',
          OBSIDIAN_ROUTER_READONLY: '${OBSIDIAN_ROUTER_READONLY}',
          OBSIDIAN_ROUTER_USER_ID: '${OBSIDIAN_ROUTER_USER_ID}',
          OBSIDIAN_ROUTER_CONFIG: '${OBSIDIAN_ROUTER_CONFIG}',
          MD_ALLOWED_PATHS: '${MD_ALLOWED_PATHS}',
          OBSIDIAN_ROUTER_VIEW_AGENT_URL: '${OBSIDIAN_ROUTER_VIEW_AGENT_URL}',
          OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN: '${OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN}',
          OBSIDIAN_ROUTER_SMART_LINK_URL: '${OBSIDIAN_ROUTER_SMART_LINK_URL}',
          OBSIDIAN_ROUTER_SMART_LINK_SECRET: '${OBSIDIAN_ROUTER_SMART_LINK_SECRET}',
        },
      },
    },
  };
}

/**
 * Copy the authored zone into a clean staging tree.
 *
 * A file arrives in staging because a pattern NAMED it. Nothing is deleted
 * from an existing staging tree to compensate for a missed exclusion, because
 * there are no exclusions — the previous script needed a whole "purge stale
 * secrets" pass precisely because robocopy's `/XF` also suppressed the `/MIR`
 * delete, so a secret copied by an older build survived every later one.
 */
export function stageAuthoredFiles({ repoRoot, serverDir, contract, target = 'mcpb' }) {
  const zones = contract.targets[target].zones;
  const all = collectFiles(repoRoot, { withContent: false });
  const { included } = applyAllowlist(all.map((e) => e.path), { authored: zones.authored });

  const symlinks = [];
  for (const { path: rel } of included) {
    const src = path.join(repoRoot, rel);
    const dst = path.join(serverDir, rel);
    if (fs.lstatSync(src).isSymbolicLink()) { symlinks.push(rel); continue; }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  return { staged: included.length, symlinks };
}

function say(msg, ...rest) { process.stdout.write(`${msg}\n`); if (rest.length) process.stdout.write(`${rest.join('\n')}\n`); }
function fail(msg) { process.stderr.write(`\nError: ${msg}\n`); process.exit(1); }

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  const argv = process.argv.slice(2);
  const keepStaging = argv.includes('--keep-staging');
  // Named for what it actually checks.  oversold it:
  // it zips ONE already-materialised array twice in ONE process, which is the
  // same in-process tautology the test suite deleted from its own headline
  // reproducibility test. It cannot see a clock, filesystem order or an npm
  // difference. The real end-to-end proof is CI's two full builds compared by
  // sha256; the old spelling still works so nothing breaks.
  const verifyReproducible = argv.includes('--verify-writer-idempotent') || argv.includes('--verify-reproducible');
  const ci = argv.indexOf('--compression');
  const compression = ci >= 0 && argv[ci + 1] === 'store' ? 'store' : 'deflate';

  const staging = path.join(REPO_ROOT, 'mcpb-staging');
  const serverDir = path.join(staging, 'server');
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const version = pkg.version;
  const bundleName = `${BUNDLE_BASE_NAME}-v${version}.mcpb`;
  const bundlePath = path.join(REPO_ROOT, bundleName);

  const { contract, sha256: contractSha, path: contractPath } = readContract(REPO_ROOT);

  // Read git state ONCE, before anything is written. The build emits three
  // files next to the bundle; two of them are untracked, so a `git status`
  // taken after the first build reports a dirty worktree that the first build
  // itself created. `dirty` goes inside export-manifest.json, inside the
  // archive — so build #1 said clean, build #2 said dirty, and the CI step
  // added to PROVE reproducibility failed on every clean runner, blaming the
  // ZIP writer. `--untracked-files=no` on top: an untracked scratch file says
  // nothing about whether the SOURCE is dirty.
  const gitSource = (() => {
    const run = (a) => execFileSync('git', a, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    try {
      return {
        commit: run(['rev-parse', 'HEAD']),
        // `ref` is deliberately NOT recorded: the same commit built from two
        // branch names would otherwise produce two different archives.
        ref: null,
        dirty: run(['status', '--porcelain', '--untracked-files=no']).length > 0,
      };
    } catch { return { commit: null, ref: null, dirty: null }; }
  })();

  say('');
  say('================================================================');
  say(`  ${BUNDLE_BASE_NAME} .mcpb build — through the C9 export gate`);
  say('================================================================');
  say(`  Version:     ${version}`);
  say(`  Compression: ${compression}`);
  say(`  Output:      ${bundlePath}`);
  say('');

  // --- 1. Stage the authored zone from the whitelist -----------------------
  say('[1/6] Staging the authored zone (whitelist)…');
  // `--keep-staging` exists to avoid a 40-second `npm ci`, so it preserves
  // `node_modules` — and NOTHING else. The authored tree is always rebuilt
  // from scratch, because `stageAuthoredFiles` only copies: a file deleted
  // from the repo survived in staging and was re-gated and re-shipped, so
  // `export-manifest.json` claimed a commit whose tree did not contain it.
  // That is the provenance property this whole module exists to provide.
  if (fs.existsSync(staging)) {
    if (!keepStaging) {
      fs.rmSync(staging, { recursive: true, force: true });
    } else {
      for (const entry of fs.readdirSync(serverDir, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        fs.rmSync(path.join(serverDir, entry.name), { recursive: true, force: true });
      }
      for (const entry of fs.readdirSync(staging, { withFileTypes: true })) {
        if (entry.name === 'server') continue;
        fs.rmSync(path.join(staging, entry.name), { recursive: true, force: true });
      }
      say('      reusing node_modules; the authored tree is rebuilt from scratch');
    }
  }
  fs.mkdirSync(serverDir, { recursive: true });
  const { staged, symlinks } = stageAuthoredFiles({ repoRoot: REPO_ROOT, serverDir, contract });
  if (symlinks.length) {
    fail(`the whitelist matched ${symlinks.length} symlink(s), which never ship: ${symlinks.join(', ')}`);
  }
  say(`      ${staged} authored files staged`);

  // --- 2. Production dependencies -----------------------------------------
  say('[2/6] npm ci --omit=dev --ignore-scripts…');
  try {
    execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts'], {
      cwd: serverDir, stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32',
    });
  } catch (err) {
    fail(`npm ci failed: ${err.message}`);
  }
  say('      production dependencies installed');

  // npm GENERATES launcher shims that are not package content and are shaped
  // differently per platform (real files on Windows, symlinks on Linux). They
  // are pruned here rather than expressed as an allowlist exclusion, because a
  // whitelist with negations is a deny list in disguise — and they are DECLARED
  // in the contract, with a written reason, rather than hidden in this script.
  for (const prune of contract.vendoredPrune || []) {
    if (!prune.reason || !String(prune.reason).trim()) {
      fail(`contract vendoredPrune entry "${prune.path}" carries no written reason.`);
    }
    const target = path.join(serverDir, prune.path);
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      say(`      pruned generated ${prune.path}`);
    }
  }

  // --- 3. The gate ---------------------------------------------------------
  say('[3/6] Gate: whitelist + leak scan over the staged tree…');
  const privatePathRoots = collectPrivateRoots({ repoRoot: REPO_ROOT });
  const gated = gateDirectory({
    root: serverDir,
    contract,
    target: 'mcpb',
    productVersion: version,
    privatePathRoots,
    contractSha256: contractSha,
    contractPath,
    compression,
    artifact: bundleName,
  });

  // A whitelist typo selects nothing, and a gate over nothing passes every
  // scan. Without a floor, a 3-entry bundle would build, audit clean, and be
  // uploaded. The number is deliberately far below the real count (~9,500) —
  // it is a tripwire for catastrophic under-selection, not a drift detector.
  const zoneCounts = {};
  for (const i of gated.included) zoneCounts[i.zone] = (zoneCounts[i.zone] || 0) + 1;

  // PER-ZONE floors. A single total of 200 sat BELOW the authored count alone
  // (309), so the most catastrophic under-selection available — an `npm ci`
  // that installed nothing — cleared it by 109 files and would have shipped a
  // bundle with no dependencies at all. Each zone has to show up on its own.
  const FLOORS = { authored: 250, vendored: 5000 };
  for (const [zone, floor] of Object.entries(FLOORS)) {
    const n = zoneCounts[zone] || 0;
    if (n < floor) {
      fail(`the allowlist selected only ${n} file(s) in the "${zone}" zone (floor ${floor}) — `
        + 'that is a selection failure, not a small bundle. Nothing was written.');
    }
  }

  say(`      included ${gated.included.length} (${Object.entries(zoneCounts).map(([z, n]) => `${z} ${n}`).join(', ')})`
    + `, excluded ${gated.excluded.length}, suppressed ${gated.scan.suppressed.length}`);
  if (!gated.ok) {
    process.stdout.write(`\n${renderFindings(gated.scan.findings)}\n`);
    fail('the export gate refused this bundle — nothing was written.');
  }
  say('      no leak found');

  // --- 4. Archive entries, checksums, manifest -----------------------------
  say('[4/6] Checksums + manifest…');
  const contentEntries = [
    {
      path: 'manifest.json',
      content: Buffer.from(`${JSON.stringify(buildMcphubManifest(version), null, 2)}\n`, 'utf8'),
    },
    ...gated.entries
      .filter((e) => !e.isSymlink)
      .map((e) => ({ path: `server/${e.path}`, content: e.content })),
  ];

  // The MCPHub manifest is GENERATED after the staged tree was gated, so it
  // never passed through the scan. It is small and currently harmless, but it
  // is also the one file in the archive nobody would think to check — scan the
  // exact set that ships, not the set that was staged.
  const generatedScan = scanEntries(
    contentEntries.filter((e) => !e.path.startsWith('server/')),
    { target: 'mcpb', privatePathRoots, exceptions: contract.scanExceptions || [], emailAllowlist: contract.emailAllowlist || [] },
  );
  if (!generatedScan.ok) {
    process.stdout.write(`\n${renderFindings(generatedScan.findings)}\n`);
    fail('the export gate refused a GENERATED bundle file — nothing was written.');
  }

  const checksums = buildChecksums(contentEntries);
  const gateManifest = buildGateManifest({
    target: 'mcpb',
    artifact: bundleName,
    productVersion: version,
    source: gitSource,
    build: { node: process.versions.node, zlibVersion: process.versions.zlib, compression },
    allowlist: { contract: contractPath, sha256: contractSha, zones: Object.keys(contract.targets.mcpb.zones) },
    scan: {
      findings: gated.scan.findings.length,
      suppressed: gated.scan.suppressed.length,
      byCategory: gated.scan.byCategory,
    },
    entries: contentEntries,
    checksumsSha256: sha256(checksums),
  });

  const archiveEntries = [
    ...contentEntries,
    { path: CHECKSUM_FILE, content: Buffer.from(checksums, 'utf8') },
    { path: MANIFEST_FILE, content: Buffer.from(serializeManifest(gateManifest), 'utf8') },
  ];
  say(`      ${contentEntries.length} entries checksummed`
    + `${gateManifest.source.dirty ? ' · WARNING: built from a dirty worktree' : ''}`);

  // --- 5. Deterministic archive -------------------------------------------
  say('[5/6] Deterministic archive…');
  const zip = createDeterministicZip(archiveEntries, { compression });
  if (verifyReproducible) {
    const again = createDeterministicZip(archiveEntries, { compression });
    if (!zip.equals(again)) fail('two archives built from the SAME entry list differ — the writer is not deterministic.');
    say('      re-zipped the same entry list: byte-identical ✓ (writer idempotence only —');
    say('      the same-commit-same-bytes claim is proved by CI running two FULL builds)');
  }
  fs.writeFileSync(bundlePath, zip);
  const archiveHash = sha256(zip);
  fs.writeFileSync(`${bundlePath}.sha256`, `${archiveHash}  ${bundleName}\n`);
  fs.writeFileSync(`${bundlePath}.manifest.json`, serializeManifest(gateManifest));

  // --- 6. Audit what was just written, without extracting it ---------------
  say('[6/6] Auditing the written archive (no extraction)…');
  // The audit re-runs the leak scan over the archive's CONTENTS, so it needs
  // the same contract inputs the staged-tree gate used — otherwise the nine
  // findings the contract legitimately suppresses would resurface here and
  // fail a build that is actually clean.
  const audit = auditArchive(fs.readFileSync(bundlePath), {
    expectArchiveSha256: archiveHash,
    target: 'mcpb',
    privatePathRoots,
    emailAllowlist: contract.emailAllowlist || [],
    exceptions: contract.scanExceptions || [],
  });
  if (!audit.ok) {
    for (const p of audit.problems) process.stderr.write(`  [${p.kind}] ${p.entry ? `${p.entry}: ` : ''}${p.detail}\n`);
    fail('the archive this build just produced does not pass its own audit.');
  }
  say(`      ${audit.entryCount} entries verified`);

  const sizeMB = (zip.length / (1024 * 1024)).toFixed(2);
  say('');
  say('================================================================');
  say(`  Bundle ready: ${bundleName} (${sizeMB} MB)`);
  say(`  sha256:       ${archiveHash}`);
  say(`  commit:       ${gateManifest.source.commit ?? 'unknown'}${gateManifest.source.dirty ? ' (dirty)' : ''}`);
  say('================================================================');
  say('');
  say('Sidecars written next to the bundle:');
  say(`  ${bundleName}.sha256          — sha256sum -c compatible`);
  say(`  ${bundleName}.manifest.json   — what was built, from which commit`);
  say('');
  say('Verify it anywhere, without unpacking:');
  say(`  node scripts/export-gate.mjs audit ${bundleName}`);
  say('');
}
