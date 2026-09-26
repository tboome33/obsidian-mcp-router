#!/usr/bin/env node
/**
 * identify-build.mjs — which commit is a running router copy?
 *
 * `list_vaults` reports `routerBuild.fingerprint`: a hash of the files that
 * define the server's behaviour (see src/helpers/build-identity.mjs). This
 * script walks this repository's history, newest first, computes the same
 * fingerprint from each commit's tree (`git ls-tree`, nothing checked out), and
 * names the commit(s) that produce it.
 *
 *   node scripts/identify-build.mjs <fingerprint>          # search the last 500 commits of every branch
 *   node scripts/identify-build.mjs <fingerprint> --max 5000
 *   node scripts/identify-build.mjs --path <plugin-dir>    # fingerprint a copy on this disk, then search
 *
 * No match is a real answer and is said as one: the copy carries changes that
 * were never committed here (a dirty working tree, or another fork). Exit code
 * 0 on a match, 1 on none, 2 on bad usage.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FINGERPRINT_ROOTS, describeRunningBuild, fingerprintFromEntries, underFingerprintRoots } from '../src/helpers/build-identity.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(args) {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

/** The fingerprint a commit's tree produces. */
export function fingerprintOfCommit(sha) {
  const out = git(['ls-tree', '-r', sha, '--', ...FINGERPRINT_ROOTS]);
  const entries = [];
  for (const line of out.split('\n')) {
    // "<mode> blob <sha>\t<path>"
    const m = /^\d+ blob ([0-9a-f]{40})\t(.+)$/.exec(line);
    if (m && underFingerprintRoots(m[2])) entries.push({ path: m[2], blob: m[1] });
  }
  return fingerprintFromEntries(entries);
}

function main() {
  const argv = process.argv.slice(2);
  let target = null;
  let max = 500;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--max') { max = Number(argv[i + 1]); i += 1; }
    else if (argv[i] === '--path') { target = describeRunningBuild(path.resolve(argv[i + 1])).fingerprint; i += 1; }
    else if (/^[0-9a-f]{16}$/.test(argv[i])) target = argv[i];
    else { console.error(`unknown argument: ${argv[i]}`); process.exit(2); }
  }
  if (!target || !Number.isInteger(max) || max < 1) {
    console.error('usage: node scripts/identify-build.mjs <16-hex fingerprint> | --path <plugin-dir>  [--max N]');
    process.exit(2);
  }
  const shas = git(['rev-list', '--all', `--max-count=${max}`]).split('\n').filter(Boolean);
  const hits = [];
  for (const sha of shas) {
    if (fingerprintOfCommit(sha) === target) hits.push(sha);
  }
  if (hits.length === 0) {
    console.log(`fingerprint ${target}: no commit among the last ${shas.length} matches — the copy carries changes never committed here, or is older (raise --max).`);
    process.exit(1);
  }
  for (const sha of hits) console.log(git(['log', '-1', '--format=%H %ad %s', '--date=short', sha]).trim());
  console.log(`\n${hits.length} commit(s) share fingerprint ${target} (commits that touch none of ${FINGERPRINT_ROOTS.join(', ')} keep the previous one's).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
