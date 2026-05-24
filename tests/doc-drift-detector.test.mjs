/**
 * Tests for hooks/_helpers/doc-drift-detector.mjs (v0.13.7).
 *
 * Covers the pure functions:
 *   - parseChangelogVersions / parseWikiChangelogVersions
 *   - orderedVaultCandidates (workspace-bound priority, .template last)
 *   - detectDocDrift (all 4 issue kinds + clean case)
 *   - fingerprintIssues (stable hashing for dedup)
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HELPER_PATH = path.resolve(__dirname, '..', 'hooks', '_helpers', 'doc-drift-detector.mjs');

const {
  parseChangelogVersions,
  parseWikiChangelogVersions,
  orderedVaultCandidates,
  detectDocDrift,
  fingerprintIssues,
  listCatalogBasenames,
} = await import(`file://${HELPER_PATH.replace(/\\/g, '/')}`);

let workDir;
let repoDir;
let vaultDir;
let templateVaultDir;

before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-drift-'));
});

after(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Fresh repo + vault per test for isolation.
  repoDir = fs.mkdtempSync(path.join(workDir, 'repo-'));
  vaultDir = fs.mkdtempSync(path.join(workDir, 'vault-'));
  templateVaultDir = fs.mkdtempSync(path.join(workDir, 'template-'));
  // Scaffold both
  for (const d of [vaultDir, templateVaultDir]) {
    fs.mkdirSync(path.join(d, 'wiki-meta'), { recursive: true });
    fs.mkdirSync(path.join(d, 'wiki', 'my-project'), { recursive: true });
  }
});

// ---------------------------------------------------------------------------

describe('parseChangelogVersions', () => {
  test('parses Keep-a-Changelog style `## [X.Y.Z]`', () => {
    const c = '## [0.12.10] — 2026-05-24\n\nfoo\n\n## [0.12.9] — 2026-05-24\n\nbar';
    const vs = parseChangelogVersions(c);
    assert.deepEqual(vs.map((v) => v.version), ['0.12.10', '0.12.9']);
    assert.equal(vs[0].date, '2026-05-24');
  });
  test('parses `## vX.Y.Z` style (without brackets)', () => {
    const c = '## v0.12.10 — 2026-05-24\n\nfoo';
    const vs = parseChangelogVersions(c);
    assert.equal(vs[0].version, '0.12.10');
  });
  test('returns [] for empty or null', () => {
    assert.deepEqual(parseChangelogVersions(''), []);
    assert.deepEqual(parseChangelogVersions(null), []);
  });
});

// ---------------------------------------------------------------------------

describe('parseWikiChangelogVersions', () => {
  test('returns a Set of `## vX.Y.Z` versions found in the page', () => {
    const c = '## v0.12.10 — 2026-05-24\n\nfoo\n\n## v0.12.9 — 2026-05-24\n\nbar';
    const set = parseWikiChangelogVersions(c);
    assert.equal(set.size, 2);
    assert.ok(set.has('0.12.10'));
    assert.ok(set.has('0.12.9'));
  });
});

// ---------------------------------------------------------------------------

describe('orderedVaultCandidates', () => {
  test('workspace-bound vault (via OBSIDIAN_ROUTER_DEFAULT_VAULT) is first', () => {
    const cfg = {
      portRegistry: {
        [templateVaultDir]: 27124,
        [vaultDir]: 27125,
      },
      vaultNames: {
        [templateVaultDir]: 'template',
        [vaultDir]: 'my-project',
      },
    };
    // Write workspace .env that binds to my-project
    fs.writeFileSync(path.join(repoDir, '.env'), 'OBSIDIAN_ROUTER_DEFAULT_VAULT=my-project\n');
    // Clear any conflicting env var
    delete process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT;
    const ordered = orderedVaultCandidates(repoDir, cfg);
    assert.equal(ordered[0], vaultDir, '.env-bound vault should be first');
    // Template should be last
    assert.equal(ordered[ordered.length - 1], templateVaultDir);
  });

  test('defaultVault is preferred when no workspace binding', () => {
    const cfg = {
      portRegistry: {
        [templateVaultDir]: 27124,
        [vaultDir]: 27125,
      },
      vaultNames: {
        [templateVaultDir]: 'template',
        [vaultDir]: 'my-project',
      },
      defaultVault: 'my-project',
    };
    delete process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT;
    if (fs.existsSync(path.join(repoDir, '.env'))) fs.unlinkSync(path.join(repoDir, '.env'));
    const ordered = orderedVaultCandidates(repoDir, cfg);
    assert.equal(ordered[0], vaultDir);
  });

  test('returns [] on null config', () => {
    assert.deepEqual(orderedVaultCandidates(repoDir, null), []);
  });
});

// ---------------------------------------------------------------------------

describe('detectDocDrift — version drift cases', () => {
  function writePackage(version, name = 'my-project') {
    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ name, version }, null, 2));
  }

  test('clean state — no drift', () => {
    writePackage('1.2.3');
    fs.writeFileSync(path.join(repoDir, 'CHANGELOG.md'), '## [1.2.3] — 2026-05-24\n\nfoo');
    fs.writeFileSync(path.join(vaultDir, 'wiki', 'my-project', 'router-changelog.md'), '## v1.2.3 — 2026-05-24\n\nfoo');
    fs.writeFileSync(path.join(vaultDir, 'wiki-meta', 'index.md'), 'état v1.2.3');
    const report = detectDocDrift(repoDir, vaultDir);
    assert.equal(report.issues.length, 0, `expected clean, got: ${JSON.stringify(report.issues, null, 2)}`);
  });

  test('changelog-version: wiki missing current version', () => {
    writePackage('1.2.3');
    fs.writeFileSync(path.join(repoDir, 'CHANGELOG.md'), '## [1.2.3] — 2026-05-24\n\nfoo');
    fs.writeFileSync(path.join(vaultDir, 'wiki', 'my-project', 'router-changelog.md'), '## v1.2.2 — 2026-05-23\n\nold');
    const report = detectDocDrift(repoDir, vaultDir);
    const kinds = report.issues.map((i) => i.kind);
    assert.ok(kinds.includes('changelog-version'));
  });

  test('changelog-cumulative: 5 versions stale (regression for 2026-05-24 8-version-gap)', () => {
    writePackage('1.2.5');
    fs.writeFileSync(path.join(repoDir, 'CHANGELOG.md'),
      '## [1.2.5] — d\n\n## [1.2.4] — d\n\n## [1.2.3] — d\n\n## [1.2.2] — d\n\n## [1.2.1] — d\n\n');
    // Wiki only has v1.2.1 — 4 versions stale
    fs.writeFileSync(path.join(vaultDir, 'wiki', 'my-project', 'router-changelog.md'), '## v1.2.1 — d');
    const report = detectDocDrift(repoDir, vaultDir);
    const cumul = report.issues.find((i) => i.kind === 'changelog-cumulative');
    assert.ok(cumul, 'should detect cumulative drift');
    assert.match(cumul.message, /4 versions stale/);
    assert.match(cumul.message, /1\.2\.5/);
    assert.match(cumul.message, /1\.2\.2/);
  });

  test('index-version: wiki-meta/index.md missing current version', () => {
    writePackage('2.0.0');
    fs.writeFileSync(path.join(repoDir, 'CHANGELOG.md'), '## [2.0.0] — d');
    fs.writeFileSync(path.join(vaultDir, 'wiki-meta', 'index.md'), 'état v1.0.0 — old');
    const report = detectDocDrift(repoDir, vaultDir);
    assert.ok(report.issues.some((i) => i.kind === 'index-version'));
  });

  test('project-router-version: frontmatter `current-version` mismatch', () => {
    writePackage('3.0.0');
    fs.writeFileSync(path.join(vaultDir, 'wiki', 'my-project', 'project-router.md'),
      '---\ntype: reference\ncurrent-version: 2.0.0\n---\n\n# X');
    const report = detectDocDrift(repoDir, vaultDir);
    const pr = report.issues.find((i) => i.kind === 'project-router-version');
    assert.ok(pr, 'should detect frontmatter version mismatch');
    assert.match(pr.message, /"2\.0\.0".*"3\.0\.0"/);
  });
});

// ---------------------------------------------------------------------------

describe('detectDocDrift — catalog completeness', () => {
  function writePackage(version, name = 'my-project') {
    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ name, version }, null, 2));
  }

  test('catalog-missing: hooks/ has files not mentioned in router-hooks.md', () => {
    writePackage('1.0.0');
    fs.mkdirSync(path.join(repoDir, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'hooks', 'fresh-new-hook.mjs'), '// new');
    fs.writeFileSync(path.join(repoDir, 'hooks', 'another-hook.mjs'), '// new2');
    fs.writeFileSync(path.join(vaultDir, 'wiki', 'my-project', 'router-hooks.md'),
      '# Router hooks\n\n| Hook | Description |\n\n(nothing here yet)');
    const report = detectDocDrift(repoDir, vaultDir);
    const cat = report.issues.find((i) => i.kind === 'catalog-missing');
    assert.ok(cat, 'should detect catalog drift');
    assert.match(cat.message, /fresh-new-hook/);
    assert.match(cat.message, /another-hook/);
  });

  test('catalog-missing severity: NIT for 1-2 missing, IMPORTANT for 3+', () => {
    writePackage('1.0.0');
    fs.mkdirSync(path.join(repoDir, 'hooks'), { recursive: true });
    // 4 hooks, none in catalog
    for (const n of ['h1', 'h2', 'h3', 'h4']) {
      fs.writeFileSync(path.join(repoDir, 'hooks', `${n}.mjs`), '');
    }
    fs.writeFileSync(path.join(vaultDir, 'wiki', 'my-project', 'router-hooks.md'), '# Hooks');
    const r = detectDocDrift(repoDir, vaultDir);
    const cat = r.issues.find((i) => i.kind === 'catalog-missing');
    assert.equal(cat.severity, 'IMPORTANT');
  });

  test('catalog page not scaffolded → skip (no false positive)', () => {
    writePackage('1.0.0');
    fs.mkdirSync(path.join(repoDir, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'hooks', 'x.mjs'), '');
    // NO wiki/my-project/router-hooks.md exists
    const r = detectDocDrift(repoDir, vaultDir);
    assert.ok(!r.issues.some((i) => i.kind === 'catalog-missing'),
      'catalog page absent → no drift reported');
  });
});

// ---------------------------------------------------------------------------

describe('listCatalogBasenames', () => {
  test('skills: returns dir names that contain SKILL.md', () => {
    fs.mkdirSync(path.join(repoDir, 'skills', 'my-skill'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'skills', 'my-skill', 'SKILL.md'), '');
    fs.mkdirSync(path.join(repoDir, 'skills', 'no-skill-md'), { recursive: true });
    const out = listCatalogBasenames(repoDir, 'skills');
    assert.deepEqual(out.sort(), ['my-skill']);
  });

  test('hooks: returns .mjs files (excludes leading-underscore helpers)', () => {
    fs.mkdirSync(path.join(repoDir, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'hooks', 'visible.mjs'), '');
    fs.writeFileSync(path.join(repoDir, 'hooks', '_hidden.mjs'), '');
    const out = listCatalogBasenames(repoDir, 'hooks');
    assert.deepEqual(out.sort(), ['visible']);
  });

  test('commands: returns .md filename basenames', () => {
    fs.mkdirSync(path.join(repoDir, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'commands', 'foo.md'), '');
    fs.writeFileSync(path.join(repoDir, 'commands', 'bar.md'), '');
    const out = listCatalogBasenames(repoDir, 'commands');
    assert.deepEqual(out.sort(), ['bar', 'foo']);
  });
});

// ---------------------------------------------------------------------------

describe('fingerprintIssues', () => {
  test('stable hash — same issues → same fingerprint', () => {
    const a = [{ kind: 'changelog-version', target: '/p', severity: 'IMPORTANT' }];
    const b = [{ kind: 'changelog-version', target: '/p', severity: 'IMPORTANT' }];
    assert.equal(fingerprintIssues(a), fingerprintIssues(b));
  });

  test('order-independent', () => {
    const a = [
      { kind: 'changelog-version', target: '/p1', severity: 'IMPORTANT' },
      { kind: 'index-version',    target: '/p2', severity: 'IMPORTANT' },
    ];
    const b = [
      { kind: 'index-version',    target: '/p2', severity: 'IMPORTANT' },
      { kind: 'changelog-version', target: '/p1', severity: 'IMPORTANT' },
    ];
    assert.equal(fingerprintIssues(a), fingerprintIssues(b));
  });

  test('different issues → different fingerprint', () => {
    const a = [{ kind: 'changelog-version', target: '/p', severity: 'IMPORTANT' }];
    const b = [{ kind: 'index-version', target: '/p', severity: 'IMPORTANT' }];
    assert.notEqual(fingerprintIssues(a), fingerprintIssues(b));
  });

  test('empty array → stable empty fingerprint', () => {
    assert.equal(fingerprintIssues([]), fingerprintIssues([]));
  });
});
