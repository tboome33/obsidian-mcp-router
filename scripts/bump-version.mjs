#!/usr/bin/env node
/**
 * bump-version.mjs
 *
 * Synchronizes the plugin version across the FIVE places Claude Code,
 * its marketplace, npm, and humans look at:
 *
 *   - `package.json`                          (npm package version + what
 *                                              hooks/check-router-update.mjs
 *                                              fetches from GitHub raw)
 *   - `.claude-plugin/plugin.json`            (plugin manifest version)
 *   - `.claude-plugin/marketplace.json`       (top-level `metadata.version`
 *                                              AND `plugins[0].version`)
 *   - `README.md`                             (the shields.io version badge,
 *                                              EN + FR — drifted repeatedly
 *                                              because earlier bumps ignored it)
 *   - `package-lock.json`                     (OPTIONAL — npm's lockfile version
 *                                              fields: top-level + packages[""];
 *                                              `npm ci` ignores them but they
 *                                              drifted to v0.25.0 regardless)
 *
 * Historically these drifted (e.g. v0.13.x in `package.json` but still
 * v0.12.7 in plugin.json + marketplace.json), which silently breaks
 * `/plugin update` for downstream users: Claude Code compares the
 * marketplace version, sees no change, refuses to refresh.
 *
 * Usage:
 *   node scripts/bump-version.mjs <new-version> [--dry-run] [--no-changelog]
 *
 * Examples:
 *   node scripts/bump-version.mjs 0.14.0
 *   node scripts/bump-version.mjs 0.14.0 --dry-run
 *   node scripts/bump-version.mjs 0.14.0 --no-changelog
 *
 * Exit codes:
 *   0 — success (or dry-run)
 *   1 — invalid args / bad version / file missing / write failure
 *
 * The `--no-changelog` flag skips inserting a stub entry at the top of
 * CHANGELOG.md (useful when you already wrote one by hand, or for a
 * resync where there is no new functional change).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSemver, compareSemver } from '../src/helpers/semver-compare.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * Update a single JSON file by setting (potentially nested) keys to the
 * new version string. Preserves the file's trailing newline if present.
 *
 * `keyPaths` is an array of arrays — each inner array describes the
 * path to a key inside the JSON, e.g. `[['version'], ['metadata', 'version']]`.
 *
 * Throws if the file is unreadable, malformed, or doesn't contain at
 * least one of the requested key paths. Idempotent: returns
 * `{ changed: false }` if the file already had every key at the target
 * version.
 */
export function updateJsonVersion(filePath, keyPaths, newVersion) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const trailingNewline = raw.endsWith('\n');
  const data = JSON.parse(raw);

  let changed = false;
  let anyKeyFound = false;

  for (const keyPath of keyPaths) {
    const current = getNested(data, keyPath);
    if (current === undefined) continue;
    anyKeyFound = true;
    if (current !== newVersion) {
      setNested(data, keyPath, newVersion);
      changed = true;
    }
  }

  if (!anyKeyFound) {
    throw new Error(
      `No matching version key found in ${filePath}. Expected one of: ${
        keyPaths.map((kp) => kp.join('.')).join(', ')
      }`,
    );
  }

  if (!changed) return { changed: false };

  const serialized = JSON.stringify(data, null, 2) + (trailingNewline ? '\n' : '');
  fs.writeFileSync(filePath, serialized);
  return { changed: true };
}

function getNested(obj, keyPath) {
  let current = obj;
  for (const key of keyPath) {
    if (current === null || typeof current !== 'object') return undefined;
    current = current[key];
  }
  return current;
}

function setNested(obj, keyPath, value) {
  let current = obj;
  for (let i = 0; i < keyPath.length - 1; i++) {
    current = current[keyPath[i]];
  }
  current[keyPath[keyPath.length - 1]] = value;
}

/**
 * Insert a stub entry near the top of CHANGELOG.md for the new version.
 *
 * The file format starts with a `# Changelog` heading, then an
 * `## [Unreleased]` block, then `## [<version>] — <date> — <title>`
 * blocks. We insert the new stub BETWEEN `## [Unreleased]` and the
 * previous top entry, so the diff is local and review-friendly. If
 * `## [Unreleased]` is absent, we insert right after the first `# Changelog`
 * line.
 *
 * Idempotent: if an entry for `<newVersion>` already exists, returns
 * `{ changed: false }`.
 */
export function insertChangelogStub(filePath, newVersion, today = new Date()) {
  const raw = fs.readFileSync(filePath, 'utf8');

  // Idempotency: bail if a heading for this version already exists
  // anywhere in the file (don't make duplicates).
  if (new RegExp(`^## \\[${escapeRegex(newVersion)}\\]`, 'm').test(raw)) {
    return { changed: false };
  }

  const dateStr = today.toISOString().slice(0, 10);
  const stub = [
    '',
    `## [${newVersion}] — ${dateStr} — TODO: one-line title`,
    '',
    'TODO: short description of the change.',
    '',
    '### Added / Changed / Fixed',
    '',
    '- TODO',
    '',
  ].join('\n');

  const lines = raw.split('\n');
  let insertIdx = -1;

  // Find `## [Unreleased]` and insert immediately after its body
  // (i.e. at the next `## [` line — or, if Unreleased is empty,
  // right after the Unreleased heading).
  for (let i = 0; i < lines.length; i++) {
    if (/^## \[Unreleased\]/i.test(lines[i])) {
      for (let j = i + 1; j < lines.length; j++) {
        if (/^## \[/.test(lines[j])) {
          insertIdx = j;
          break;
        }
      }
      if (insertIdx === -1) {
        insertIdx = lines.length;
      }
      break;
    }
  }

  // Fallback: insert after the `# Changelog` header
  if (insertIdx === -1) {
    for (let i = 0; i < lines.length; i++) {
      if (/^# Changelog/i.test(lines[i])) {
        insertIdx = i + 1;
        break;
      }
    }
  }

  if (insertIdx === -1) {
    throw new Error(
      `CHANGELOG.md is malformed: no '# Changelog' header found.`,
    );
  }

  const before = lines.slice(0, insertIdx).join('\n');
  const after = lines.slice(insertIdx).join('\n');
  const updated = before + stub + after;
  fs.writeFileSync(filePath, updated);
  return { changed: true };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rewrite the shields.io version badge in README.md to `newVersion`.
 *
 * The badge looks like `…/badge/version-0.19.1-blueviolet.svg` and appears
 * once per language section (EN + FR), so we replace EVERY occurrence. This
 * file isn't JSON, so it can't go through `updateJsonVersion` — hence a
 * dedicated regex rewrite.
 *
 * Idempotent: returns `{ changed: false }` if every badge already shows
 * `newVersion`. Throws if the file has no recognizable version badge, so a
 * renamed/removed badge surfaces loudly instead of silently no-op'ing (the
 * whole reason the badge drifted to v0.10.3 / v0.19.1 in the first place).
 */
export function updateReadmeBadge(filePath, newVersion) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const BADGE_RE = /(badge\/version-)\d+\.\d+\.\d+(-blueviolet)/g;
  const matches = raw.match(BADGE_RE);
  if (!matches || matches.length === 0) {
    throw new Error(
      `No version badge (badge/version-X.Y.Z-blueviolet) found in ${filePath}.`,
    );
  }
  const target = `badge/version-${newVersion}-blueviolet`;
  if (matches.every((m) => m === target)) {
    return { changed: false };
  }
  // Function replacement avoids `$1`/`$2` backreference parsing footguns
  // when `newVersion` contains characters special to String.replace.
  const updated = raw.replace(BADGE_RE, (_m, p1, p2) => `${p1}${newVersion}${p2}`);
  fs.writeFileSync(filePath, updated);
  return { changed: true };
}

/**
 * Bump every plugin/marketplace/package file to `newVersion`. Returns
 * a report `{ files: { [path]: { changed, before } }, changelog: { changed } }`.
 *
 * Pure-ish: caller decides whether to write or just preview. We pass
 * `dryRun=true` to short-circuit the disk writes inside helper calls
 * by reading-but-not-writing — implemented by snapshotting the file
 * content before and restoring after if dry-run.
 */
export function bumpAll(root, newVersion, { dryRun = false, withChangelog = true, today = new Date() } = {}) {
  const targets = [
    {
      relPath: 'package.json',
      keyPaths: [['version']],
    },
    {
      relPath: '.claude-plugin/plugin.json',
      keyPaths: [['version']],
    },
    {
      relPath: '.claude-plugin/marketplace.json',
      keyPaths: [
        ['metadata', 'version'],
        ['plugins', 0, 'version'],
      ],
    },
  ];

  const parsed = parseSemver(newVersion);
  if (!parsed) {
    throw new Error(`Invalid semver: ${newVersion}`);
  }

  const report = { files: {}, changelog: { changed: false }, readme: { changed: false }, lockfile: { changed: false } };

  for (const { relPath, keyPaths } of targets) {
    const fullPath = path.join(root, relPath);
    const before = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf8') : null;
    if (before === null) {
      throw new Error(`Missing file: ${fullPath}`);
    }

    // Read current version for the report (first key path that exists)
    let currentVersion = null;
    try {
      const data = JSON.parse(before);
      for (const kp of keyPaths) {
        const v = getNested(data, kp);
        if (v !== undefined) { currentVersion = v; break; }
      }
    } catch (err) {
      throw new Error(`Malformed JSON in ${fullPath}: ${err.message}`);
    }

    if (currentVersion) {
      const parsedCurrent = parseSemver(currentVersion);
      if (parsedCurrent && compareSemver(newVersion, currentVersion) < 0) {
        throw new Error(
          `Refusing to downgrade ${relPath} from v${currentVersion} to v${newVersion}. ` +
          `If this is intentional, edit the file manually.`,
        );
      }
    }

    const result = updateJsonVersion(fullPath, keyPaths, newVersion);
    report.files[relPath] = { changed: result.changed, before: currentVersion };

    if (dryRun) {
      fs.writeFileSync(fullPath, before);
    }
  }

  // README.md shields.io version badge (EN + FR). Not JSON, so it needs a
  // dedicated regex rewrite. Optional: skipped if the repo has no README
  // (e.g. minimal test fixtures) — never throws for a missing file here.
  const readmePath = path.join(root, 'README.md');
  if (fs.existsSync(readmePath)) {
    const beforeReadme = fs.readFileSync(readmePath, 'utf8');
    report.readme = updateReadmeBadge(readmePath, newVersion);
    if (dryRun) {
      fs.writeFileSync(readmePath, beforeReadme);
    }
  }

  // package-lock.json — npm's lockfile carries the package version in two spots: the
  // top-level `version` and the root entry `packages[""].version`. `npm ci` IGNORES these
  // (it hashes the dependency tree, not the version string), so a stale value never breaks
  // an install — but it's sloppy, misleads anyone reading the lockfile, and drifted to
  // v0.25.0 while everything else moved on. Optional: skipped if the repo has no lockfile
  // (e.g. minimal test fixtures). Only the version fields are touched — never the dep tree.
  const lockPath = path.join(root, 'package-lock.json');
  if (fs.existsSync(lockPath)) {
    const beforeLock = fs.readFileSync(lockPath, 'utf8');
    let lockCurrent = null;
    try {
      lockCurrent = getNested(JSON.parse(beforeLock), ['version']);
    } catch (err) {
      throw new Error(`Malformed JSON in ${lockPath}: ${err.message}`);
    }
    if (lockCurrent && parseSemver(lockCurrent) && compareSemver(newVersion, lockCurrent) < 0) {
      throw new Error(
        `Refusing to downgrade package-lock.json from v${lockCurrent} to v${newVersion}. ` +
        `If this is intentional, edit the file manually.`,
      );
    }
    report.lockfile = updateJsonVersion(lockPath, [['version'], ['packages', '', 'version']], newVersion);
    if (dryRun) fs.writeFileSync(lockPath, beforeLock);
  }

  if (withChangelog) {
    const changelogPath = path.join(root, 'CHANGELOG.md');
    if (fs.existsSync(changelogPath)) {
      const beforeChangelog = fs.readFileSync(changelogPath, 'utf8');
      const result = insertChangelogStub(changelogPath, newVersion, today);
      report.changelog = result;
      if (dryRun) {
        fs.writeFileSync(changelogPath, beforeChangelog);
      }
    }
  }

  return report;
}

// ────────────────────────────────────────────────────────────────────
// CLI entry point
// ────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(
      'Usage: node scripts/bump-version.mjs <new-version> [--dry-run] [--no-changelog]\n' +
      '\n' +
      'Bumps the version in package.json, .claude-plugin/plugin.json,\n' +
      '.claude-plugin/marketplace.json (both metadata.version and plugins[0].version),\n' +
      'the shields.io version badge in README.md (EN + FR),\n' +
      'package-lock.json (version fields, if present),\n' +
      'and inserts a stub entry at the top of CHANGELOG.md.\n',
    );
    process.exit(args.length === 0 ? 1 : 0);
  }

  const dryRun = args.includes('--dry-run');
  const withChangelog = !args.includes('--no-changelog');
  const newVersion = args.find((a) => !a.startsWith('--'));

  if (!newVersion) {
    process.stderr.write('Error: <new-version> argument is required.\n');
    process.exit(1);
  }

  try {
    const report = bumpAll(repoRoot, newVersion, { dryRun, withChangelog });
    const prefix = dryRun ? '[dry-run] ' : '';
    for (const [file, { changed, before }] of Object.entries(report.files)) {
      const status = changed ? `v${before} → v${newVersion}` : `unchanged (already v${newVersion})`;
      process.stdout.write(`${prefix}${file}: ${status}\n`);
    }
    if (withChangelog) {
      process.stdout.write(
        `${prefix}CHANGELOG.md: ${report.changelog.changed ? 'stub inserted' : 'unchanged (already has entry for this version)'}\n`,
      );
    }
    process.stdout.write(
      `${prefix}README.md badge: ${report.readme.changed ? `synced → v${newVersion}` : 'unchanged (already at this version, or no README)'}\n`,
    );
    process.stdout.write(
      `${prefix}package-lock.json: ${report.lockfile.changed ? `synced → v${newVersion}` : 'unchanged (already at this version, or no lockfile)'}\n`,
    );
    if (dryRun) {
      process.stdout.write('\n(Dry-run — no files were written.)\n');
    }
    process.exit(0);
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }
}
