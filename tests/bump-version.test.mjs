/**
 * Tests for scripts/bump-version.mjs.
 *
 * Strategy: each test sets up an isolated tmp dir mimicking the repo
 * layout (package.json + .claude-plugin/{plugin,marketplace}.json +
 * CHANGELOG.md), runs `bumpAll()` against it, and asserts the result.
 *
 * CLI behavior is exercised via spawnSync in a separate describe block.
 */
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  bumpAll,
  updateJsonVersion,
  insertChangelogStub,
  updateReadmeBadge,
} from '../scripts/bump-version.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT_PATH = path.resolve(__dirname, '..', 'scripts', 'bump-version.mjs');

let workDir;
let scratchRoots = [];

before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bump-version-'));
});

after(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

afterEach(() => {
  scratchRoots = [];
});

/**
 * Create an isolated tmp repo with the three version-bearing files +
 * a minimal CHANGELOG.md. Returns the root path. Callers can override
 * the initial versions per file.
 */
function makeFakeRepo({
  pkgVersion = '0.13.0',
  pluginVersion = '0.13.0',
  marketplaceMetaVersion = '0.13.0',
  marketplacePluginVersion = '0.13.0',
  changelog = `# Changelog\n\n## [Unreleased]\n\nNothing pending right now.\n\n## [0.13.0] — 2026-01-01 — initial\n\nInitial release.\n`,
  readmeVersion = null,
} = {}) {
  const root = fs.mkdtempSync(path.join(workDir, 'repo-'));
  scratchRoots.push(root);

  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'obsidian-mcp-router', version: pkgVersion }, null, 2) + '\n',
  );

  fs.mkdirSync(path.join(root, '.claude-plugin'));
  fs.writeFileSync(
    path.join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'obsidian-router', version: pluginVersion }, null, 2) + '\n',
  );
  fs.writeFileSync(
    path.join(root, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'obsidian-mcp-router-marketplace',
      metadata: { version: marketplaceMetaVersion },
      plugins: [{ name: 'obsidian-router', version: marketplacePluginVersion }],
    }, null, 2) + '\n',
  );

  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), changelog);

  // Optional README with two shields.io version badges (mimics EN + FR).
  if (readmeVersion !== null) {
    fs.writeFileSync(
      path.join(root, 'README.md'),
      [
        '# obsidian-mcp-router',
        '',
        `<a href="./CHANGELOG.md"><img src="https://img.shields.io/badge/version-${readmeVersion}-blueviolet.svg" alt="version"></a>`,
        '',
        '## Version française',
        '',
        `<a href="./CHANGELOG.md"><img src="https://img.shields.io/badge/version-${readmeVersion}-blueviolet.svg" alt="version"></a>`,
        '',
      ].join('\n'),
    );
  }

  return root;
}

// ───────────────────────────────────────────────────────────────────
// bumpAll — high-level integration
// ───────────────────────────────────────────────────────────────────

describe('bumpAll', () => {
  test('updates all 3 files when given a higher version', () => {
    const root = makeFakeRepo({ pkgVersion: '0.13.0', pluginVersion: '0.13.0', marketplaceMetaVersion: '0.13.0' });
    const report = bumpAll(root, '0.14.0', { withChangelog: false });

    assert.equal(report.files['package.json'].changed, true);
    assert.equal(report.files['package.json'].before, '0.13.0');
    assert.equal(report.files['.claude-plugin/plugin.json'].changed, true);
    assert.equal(report.files['.claude-plugin/marketplace.json'].changed, true);

    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(pkg.version, '0.14.0');

    const plugin = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
    assert.equal(plugin.version, '0.14.0');

    const marketplace = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
    assert.equal(marketplace.metadata.version, '0.14.0');
    assert.equal(marketplace.plugins[0].version, '0.14.0');
  });

  test('idempotent — re-running with same version reports unchanged', () => {
    const root = makeFakeRepo({ pkgVersion: '0.14.0', pluginVersion: '0.14.0', marketplaceMetaVersion: '0.14.0', marketplacePluginVersion: '0.14.0' });
    const report = bumpAll(root, '0.14.0', { withChangelog: false });

    assert.equal(report.files['package.json'].changed, false);
    assert.equal(report.files['.claude-plugin/plugin.json'].changed, false);
    assert.equal(report.files['.claude-plugin/marketplace.json'].changed, false);
  });

  test('refuses to downgrade', () => {
    const root = makeFakeRepo({ pkgVersion: '0.14.0' });
    assert.throws(
      () => bumpAll(root, '0.13.0', { withChangelog: false }),
      /Refusing to downgrade/,
    );
    // Original file should not be touched
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(pkg.version, '0.14.0');
  });

  test('rejects invalid semver', () => {
    const root = makeFakeRepo();
    assert.throws(
      () => bumpAll(root, 'not-a-version'),
      /Invalid semver/,
    );
  });

  test('handles desynced files (package.json ahead of plugin.json)', () => {
    // This is the exact bug bump-version exists to fix: package.json
    // bumped over multiple releases while plugin/marketplace lagged.
    const root = makeFakeRepo({
      pkgVersion: '0.13.9',
      pluginVersion: '0.12.7',
      marketplaceMetaVersion: '0.12.7',
      marketplacePluginVersion: '0.12.7',
    });

    const report = bumpAll(root, '0.14.0', { withChangelog: false });

    // package.json bumped from 0.13.9 → 0.14.0
    assert.equal(report.files['package.json'].before, '0.13.9');
    assert.equal(report.files['package.json'].changed, true);

    // plugin.json caught up from 0.12.7 → 0.14.0
    assert.equal(report.files['.claude-plugin/plugin.json'].before, '0.12.7');
    assert.equal(report.files['.claude-plugin/plugin.json'].changed, true);

    // marketplace.json same
    assert.equal(report.files['.claude-plugin/marketplace.json'].before, '0.12.7');
    assert.equal(report.files['.claude-plugin/marketplace.json'].changed, true);

    // Final state: all aligned
    const marketplace = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
    assert.equal(marketplace.metadata.version, '0.14.0');
    assert.equal(marketplace.plugins[0].version, '0.14.0');
  });

  test('dry-run does not write to disk', () => {
    const root = makeFakeRepo({ pkgVersion: '0.13.0' });
    const before = fs.readFileSync(path.join(root, 'package.json'), 'utf8');

    const report = bumpAll(root, '0.14.0', { dryRun: true, withChangelog: false });
    assert.equal(report.files['package.json'].changed, true); // would change

    const after = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
    assert.equal(after, before, 'file content unchanged in dry-run');
  });

  test('inserts CHANGELOG stub when withChangelog=true (default)', () => {
    const root = makeFakeRepo({ pkgVersion: '0.13.0' });
    const fixedDate = new Date('2026-05-25T12:00:00Z');
    const report = bumpAll(root, '0.14.0', { today: fixedDate });

    assert.equal(report.changelog.changed, true);
    const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    assert.match(changelog, /## \[0\.14\.0\] — 2026-05-25/);
    // Order: should be BETWEEN [Unreleased] and [0.13.0]
    const unreleasedIdx = changelog.indexOf('## [Unreleased]');
    const newEntryIdx = changelog.indexOf('## [0.14.0]');
    const oldEntryIdx = changelog.indexOf('## [0.13.0]');
    assert.ok(unreleasedIdx < newEntryIdx, '[Unreleased] before new entry');
    assert.ok(newEntryIdx < oldEntryIdx, 'new entry before old entry');
  });

  test('skips CHANGELOG when withChangelog=false', () => {
    const root = makeFakeRepo();
    const before = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    const report = bumpAll(root, '0.14.0', { withChangelog: false });

    assert.equal(report.changelog.changed, false);
    const after = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    assert.equal(after, before);
  });

  test('CHANGELOG stub is idempotent (re-run does not add duplicate)', () => {
    const root = makeFakeRepo();
    bumpAll(root, '0.14.0');
    const afterFirst = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');

    const report = bumpAll(root, '0.14.0'); // re-run same version
    assert.equal(report.changelog.changed, false);
    const afterSecond = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    assert.equal(afterSecond, afterFirst, 'CHANGELOG unchanged on re-run');
  });

  test('throws on missing file', () => {
    const root = fs.mkdtempSync(path.join(workDir, 'empty-'));
    scratchRoots.push(root);
    assert.throws(
      () => bumpAll(root, '0.14.0', { withChangelog: false }),
      /Missing file/,
    );
  });

  test('updates the README badge (all occurrences) when a README is present', () => {
    const root = makeFakeRepo({ pkgVersion: '0.21.0', pluginVersion: '0.21.0', marketplaceMetaVersion: '0.21.0', marketplacePluginVersion: '0.21.0', readmeVersion: '0.21.0' });
    const report = bumpAll(root, '0.22.0', { withChangelog: false });

    assert.equal(report.readme.changed, true);
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    assert.match(readme, /badge\/version-0\.22\.0-blueviolet/);
    assert.doesNotMatch(readme, /badge\/version-0\.21\.0-blueviolet/);
    // Both EN + FR badges updated.
    assert.equal((readme.match(/badge\/version-0\.22\.0-blueviolet/g) || []).length, 2);
  });

  test('README badge is idempotent when already at target', () => {
    const root = makeFakeRepo({ pkgVersion: '0.22.0', pluginVersion: '0.22.0', marketplaceMetaVersion: '0.22.0', marketplacePluginVersion: '0.22.0', readmeVersion: '0.22.0' });
    const report = bumpAll(root, '0.22.0', { withChangelog: false });
    assert.equal(report.readme.changed, false);
  });

  test('skips the README badge gracefully when no README is present', () => {
    const root = makeFakeRepo({ pkgVersion: '0.21.0' }); // no readmeVersion → no README.md
    const report = bumpAll(root, '0.22.0', { withChangelog: false });
    assert.equal(report.readme.changed, false);
  });

  test('dry-run does not write the README badge', () => {
    const root = makeFakeRepo({ pkgVersion: '0.21.0', readmeVersion: '0.21.0' });
    const before = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    bumpAll(root, '0.22.0', { dryRun: true, withChangelog: false });
    const after = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    assert.equal(after, before, 'README unchanged in dry-run');
  });
});

// ───────────────────────────────────────────────────────────────────
// updateJsonVersion — pure helper
// ───────────────────────────────────────────────────────────────────

describe('updateJsonVersion', () => {
  test('updates a single top-level key', () => {
    const root = makeFakeRepo({ pkgVersion: '0.13.0' });
    const result = updateJsonVersion(
      path.join(root, 'package.json'),
      [['version']],
      '0.14.0',
    );
    assert.equal(result.changed, true);
    const data = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(data.version, '0.14.0');
  });

  test('updates both metadata.version and plugins[0].version', () => {
    const root = makeFakeRepo({ marketplaceMetaVersion: '0.13.0', marketplacePluginVersion: '0.13.0' });
    const result = updateJsonVersion(
      path.join(root, '.claude-plugin', 'marketplace.json'),
      [['metadata', 'version'], ['plugins', 0, 'version']],
      '0.14.0',
    );
    assert.equal(result.changed, true);
    const data = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
    assert.equal(data.metadata.version, '0.14.0');
    assert.equal(data.plugins[0].version, '0.14.0');
  });

  test('returns changed=false if all keys already at target', () => {
    const root = makeFakeRepo({ pkgVersion: '0.14.0' });
    const result = updateJsonVersion(
      path.join(root, 'package.json'),
      [['version']],
      '0.14.0',
    );
    assert.equal(result.changed, false);
  });

  test('throws if no requested key path exists in the file', () => {
    const root = makeFakeRepo();
    const customFile = path.join(root, 'custom.json');
    fs.writeFileSync(customFile, JSON.stringify({ unrelated: 'field' }, null, 2));
    assert.throws(
      () => updateJsonVersion(customFile, [['version']], '0.14.0'),
      /No matching version key found/,
    );
  });

  test('preserves trailing newline when present', () => {
    const root = makeFakeRepo({ pkgVersion: '0.13.0' });
    updateJsonVersion(path.join(root, 'package.json'), [['version']], '0.14.0');
    const raw = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
    assert.ok(raw.endsWith('\n'), 'trailing newline preserved');
  });
});

// ───────────────────────────────────────────────────────────────────
// insertChangelogStub — pure helper
// ───────────────────────────────────────────────────────────────────

describe('insertChangelogStub', () => {
  test('inserts between [Unreleased] and previous entry', () => {
    const root = makeFakeRepo();
    const changelogPath = path.join(root, 'CHANGELOG.md');
    insertChangelogStub(changelogPath, '0.14.0', new Date('2026-05-25T00:00:00Z'));

    const content = fs.readFileSync(changelogPath, 'utf8');
    const unreleased = content.indexOf('## [Unreleased]');
    const newEntry = content.indexOf('## [0.14.0]');
    const oldEntry = content.indexOf('## [0.13.0]');

    assert.ok(unreleased < newEntry && newEntry < oldEntry,
      'order: Unreleased → 0.14.0 → 0.13.0');
  });

  test('idempotent — refuses to insert if heading already exists', () => {
    const root = makeFakeRepo();
    const changelogPath = path.join(root, 'CHANGELOG.md');
    insertChangelogStub(changelogPath, '0.14.0', new Date('2026-05-25T00:00:00Z'));
    const after1 = fs.readFileSync(changelogPath, 'utf8');

    const result = insertChangelogStub(changelogPath, '0.14.0', new Date('2026-05-25T00:00:00Z'));
    assert.equal(result.changed, false);
    const after2 = fs.readFileSync(changelogPath, 'utf8');
    assert.equal(after2, after1);
  });

  test('falls back to inserting after # Changelog if no [Unreleased] block', () => {
    const root = fs.mkdtempSync(path.join(workDir, 'no-unreleased-'));
    scratchRoots.push(root);
    const changelogPath = path.join(root, 'CHANGELOG.md');
    fs.writeFileSync(changelogPath, '# Changelog\n\nSome intro text.\n\n## [0.13.0]\n\nInitial.\n');

    const result = insertChangelogStub(changelogPath, '0.14.0', new Date('2026-05-25T00:00:00Z'));
    assert.equal(result.changed, true);
    const content = fs.readFileSync(changelogPath, 'utf8');
    assert.match(content, /## \[0\.14\.0\]/);
  });

  test('throws if no # Changelog header anywhere', () => {
    const root = fs.mkdtempSync(path.join(workDir, 'malformed-'));
    scratchRoots.push(root);
    const changelogPath = path.join(root, 'CHANGELOG.md');
    fs.writeFileSync(changelogPath, 'Just some text, no header.\n');

    assert.throws(
      () => insertChangelogStub(changelogPath, '0.14.0'),
      /malformed/,
    );
  });
});

// ───────────────────────────────────────────────────────────────────
// updateReadmeBadge — pure helper
// ───────────────────────────────────────────────────────────────────

describe('updateReadmeBadge', () => {
  test('replaces all badge occurrences (EN + FR)', () => {
    const root = makeFakeRepo({ readmeVersion: '0.21.0' });
    const result = updateReadmeBadge(path.join(root, 'README.md'), '0.22.0');
    assert.equal(result.changed, true);
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    assert.equal((readme.match(/badge\/version-0\.22\.0-blueviolet/g) || []).length, 2);
  });

  test('returns changed=false when every badge already at target', () => {
    const root = makeFakeRepo({ readmeVersion: '0.22.0' });
    const result = updateReadmeBadge(path.join(root, 'README.md'), '0.22.0');
    assert.equal(result.changed, false);
  });

  test('throws if no version badge is present', () => {
    const root = fs.mkdtempSync(path.join(workDir, 'no-badge-'));
    scratchRoots.push(root);
    fs.writeFileSync(path.join(root, 'README.md'), '# obsidian-mcp-router\n\nNo badge here.\n');
    assert.throws(
      () => updateReadmeBadge(path.join(root, 'README.md'), '0.22.0'),
      /No version badge/,
    );
  });
});

// ───────────────────────────────────────────────────────────────────
// CLI entry point
// ───────────────────────────────────────────────────────────────────

describe('bump-version CLI', () => {
  test('--help prints usage and exits 0', () => {
    const r = spawnSync(process.execPath, [SCRIPT_PATH, '--help'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage: node scripts\/bump-version\.mjs/);
  });

  test('no args prints usage and exits 1', () => {
    const r = spawnSync(process.execPath, [SCRIPT_PATH], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /Usage:/);
  });

  test('invalid semver exits 1 with error on stderr', () => {
    const r = spawnSync(process.execPath, [SCRIPT_PATH, 'not-a-version'], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Invalid semver/);
  });
});
