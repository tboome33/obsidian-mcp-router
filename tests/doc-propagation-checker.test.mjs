/**
 * Tests for hooks/doc-propagation-checker.mjs.
 *
 * Strategy: spawn the hook with synthetic stdin (PostToolUse Bash event)
 * + temp project dir mimicking a real repo (package.json + CHANGELOG +
 * ROADMAP). Verify nudge appears on stdout for drift cases, silent exit 0
 * for aligned cases.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HOOK_PATH = path.resolve(__dirname, '..', 'hooks', 'doc-propagation-checker.mjs');

let workDir;

before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-prop-'));
});

after(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/**
 * Run the hook with a fake project dir + stdin describing a `git commit`
 * Bash invocation. Returns { status, stdout, stderr }.
 */
function runHook({
  version = '0.11.3',
  changelogContent = null,
  roadmapContent = null,
  command = 'git commit -m "test"',
  toolName = 'Bash',
  env = {},
  configPath = null,
} = {}) {
  const projectDir = fs.mkdtempSync(path.join(workDir, 'proj-'));
  fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'test', version }));
  if (changelogContent !== null) {
    fs.writeFileSync(path.join(projectDir, 'CHANGELOG.md'), changelogContent);
  }
  if (roadmapContent !== null) {
    fs.writeFileSync(path.join(projectDir, 'ROADMAP.md'), roadmapContent);
  }

  const stdin = JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: toolName,
    tool_input: { command },
  });

  const finalEnv = { ...process.env, CLAUDE_PROJECT_DIR: projectDir, ...env };
  // Default config = empty registry so the vault check is a no-op for
  // most tests. Override via `configPath` for the vault-specific test.
  if (configPath) {
    finalEnv.OBSIDIAN_ROUTER_CONFIG = configPath;
  } else if (!('OBSIDIAN_ROUTER_CONFIG' in env)) {
    const emptyCfg = path.join(projectDir, 'empty-cfg.json');
    fs.writeFileSync(emptyCfg, JSON.stringify({ portRegistry: {} }));
    finalEnv.OBSIDIAN_ROUTER_CONFIG = emptyCfg;
  }

  return spawnSync(process.execPath, [HOOK_PATH], {
    input: stdin,
    encoding: 'utf8',
    env: finalEnv,
  });
}

// ---------------------------------------------------------------------------
// Silent exit 0 — nothing to nudge about
// ---------------------------------------------------------------------------

describe('doc-propagation-checker — silent cases', () => {
  test('exits 0 silently when tool is not Bash', () => {
    const r = runHook({ toolName: 'Read' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });

  test('exits 0 silently when Bash command is not git commit', () => {
    const r = runHook({ command: 'git status' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });

  test('exits 0 silently when CHANGELOG + ROADMAP already mention the version', () => {
    const r = runHook({
      version: '0.11.3',
      changelogContent: '# Changelog\n\n## [Unreleased]\n\nNothing pending right now.\n\n## [0.11.3] — 2026-05-23\n\nReal content.\n',
      roadmapContent: '# Roadmap\n\n## ✅ v0.11.3 — Test (shipped 2026-05-23)\n\nReal content.\n',
    });
    assert.equal(r.status, 0, r.stdout);
    assert.equal(r.stdout.trim(), '');
  });

  test('exits 0 silently when opt-out env var is set', () => {
    const r = runHook({
      version: '0.11.3',
      changelogContent: '# Changelog\n\n## [Unreleased]\n\n- pending stuff\n',
      // intentionally drift — but opt-out should silence it
      env: { OBSIDIAN_ROUTER_NO_DOC_PROPAGATION_CHECK: 'true' },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });

  test('exits 0 silently when no package.json (not a Node project)', () => {
    // runHook always writes package.json — but we can simulate by
    // passing a project dir without one via a custom env override.
    const emptyDir = fs.mkdtempSync(path.join(workDir, 'no-pkg-'));
    const stdin = JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m "test"' },
    });
    const r = spawnSync(process.execPath, [HOOK_PATH], {
      input: stdin,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: emptyDir },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });

  test('exits 0 silently on malformed stdin', () => {
    const r = spawnSync(process.execPath, [HOOK_PATH], {
      input: 'not-json',
      encoding: 'utf8',
      env: { ...process.env },
    });
    assert.equal(r.status, 0);
  });
});

// ---------------------------------------------------------------------------
// Nudge cases — exit 0 + stdout notice
// ---------------------------------------------------------------------------

describe('doc-propagation-checker — nudge cases', () => {
  test('nudges when CHANGELOG missing the current version section', () => {
    const r = runHook({
      version: '0.11.3',
      changelogContent: '# Changelog\n\n## [Unreleased]\n\nNothing pending right now.\n\n## [0.11.2]\n\nOld stuff.\n',
      roadmapContent: '# Roadmap\n\n## ✅ v0.11.3 — Test\n',
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /DOC_PROPAGATION_CHECK/);
    assert.match(r.stdout, /CHANGELOG\.md doesn't have a `## \[0\.11\.3\]` section/);
  });

  test('nudges when ROADMAP missing the current version section', () => {
    const r = runHook({
      version: '0.11.3',
      changelogContent: '# Changelog\n\n## [Unreleased]\n\nNothing pending right now.\n\n## [0.11.3] — 2026-05-23\n\nReal content.\n',
      roadmapContent: '# Roadmap\n\n## ✅ v0.11.2 — Old (shipped 2026-05-22)\n',
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /DOC_PROPAGATION_CHECK/);
    assert.match(r.stdout, /ROADMAP\.md doesn't have a `## ✅ v0\.11\.3` section/);
  });

  test('nudges when [Unreleased] still has content AND current version section exists', () => {
    const r = runHook({
      version: '0.11.3',
      changelogContent: '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- still here\n\n## [0.11.3] — 2026-05-23\n\nReal content.\n',
      roadmapContent: '# Roadmap\n\n## ✅ v0.11.3 — Test\n',
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /DOC_PROPAGATION_CHECK/);
    assert.match(r.stdout, /\[Unreleased\] still has content/);
  });

  test('does NOT nudge for stale Unreleased when version section is still missing (user is mid-flow)', () => {
    // Bumped version but didn't promote yet — this is normal mid-flow,
    // we already nudge for "missing version section", we shouldn't
    // ALSO double-nudge for "Unreleased has content".
    const r = runHook({
      version: '0.11.3',
      changelogContent: '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- pending\n\n## [0.11.2]\n\nOld.\n',
      roadmapContent: '# Roadmap\n\n## ✅ v0.11.3 — Test\n',
    });
    assert.equal(r.status, 0);
    // Should mention the missing version section
    assert.match(r.stdout, /CHANGELOG\.md doesn't have a `## \[0\.11\.3\]`/);
    // Should NOT also mention stale Unreleased (no double-nudge)
    assert.doesNotMatch(r.stdout, /\[Unreleased\] still has content/);
  });

  test('nudges when vault wiki router-changelog missing the version (multi-tier check)', () => {
    // Create a fake vault with a wiki router-changelog that doesn't
    // mention the current version
    const vault = fs.mkdtempSync(path.join(workDir, 'vault-'));
    const wikiDir = path.join(vault, 'wiki', 'obsidian-mcp-router');
    fs.mkdirSync(wikiDir, { recursive: true });
    fs.writeFileSync(
      path.join(wikiDir, 'router-changelog.md'),
      '# router-changelog\n\n## v0.11.2 — 2026-05-23\n\nOld content.\n',
    );
    const cfgPath = path.join(workDir, 'cfg-' + Date.now() + '.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      portRegistry: { [vault]: 27999 },
    }));

    const r = runHook({
      version: '0.11.3',
      changelogContent: '# Changelog\n\n## [Unreleased]\n\nNothing pending right now.\n\n## [0.11.3] — 2026-05-23\n\nOK.\n',
      roadmapContent: '# Roadmap\n\n## ✅ v0.11.3 — OK\n',
      configPath: cfgPath,
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Vault wiki router-changelog\.md/);
    assert.match(r.stdout, /doesn't mention v0\.11\.3/);
  });

  test('stdout includes opt-out env var name for discoverability', () => {
    const r = runHook({
      version: '0.11.3',
      changelogContent: '# Changelog\n\n## [Unreleased]\n\nNothing pending.\n',
      roadmapContent: '# Roadmap\n\n## ✅ v0.11.2 — Old\n',
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /OBSIDIAN_ROUTER_NO_DOC_PROPAGATION_CHECK=true/);
  });

  test('matches git commit even in compound shell commands (git add . && git commit ...)', () => {
    const r = runHook({
      version: '0.11.3',
      command: 'git add . && git commit -m "test"',
      changelogContent: '# Changelog\n\n## [Unreleased]\n\nNothing pending.\n',
      roadmapContent: '# Roadmap\n\n## ✅ v0.11.2 — Old\n',
    });
    assert.equal(r.status, 0);
    // Should still fire (and nudge), not silent
    assert.match(r.stdout, /DOC_PROPAGATION_CHECK/);
  });

  test('matches git commit --amend, git commit -a, etc.', () => {
    for (const cmd of ['git commit --amend', 'git commit -a -m "x"', 'git commit -am "x"']) {
      const r = runHook({
        version: '0.11.3',
        command: cmd,
        changelogContent: '# Changelog\n\n## [Unreleased]\n\nNothing pending.\n',
        roadmapContent: '# Roadmap\n\n## ✅ v0.11.2 — Old\n',
      });
      assert.equal(r.status, 0, `command "${cmd}" exit ${r.status}`);
      assert.match(r.stdout, /DOC_PROPAGATION_CHECK/, `command "${cmd}" no nudge`);
    }
  });
});
