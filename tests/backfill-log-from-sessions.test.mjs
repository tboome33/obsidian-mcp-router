/**
 * Tests for `scripts/backfill-log-from-sessions.mjs` (v0.12.9).
 *
 * Strategy: spawn the script as a subprocess against temp vault fixtures.
 * Each test creates a vault with a known set of sessions under
 * wiki-meta/Sessions/ + a baseline log.md, runs the script, and asserts
 * on the resulting log.md content.
 *
 * Covers:
 *   - 1 closed session → 1 backfilled line appended
 *   - idempotence: re-run produces 0 new entries
 *   - --dry-run: no fs write, preview only
 *   - open session (status: open) is skipped
 *   - session with no recap block falls back to "(no recap captured)"
 *   - session whose log line already exists in log.md is skipped (grep dedup)
 *   - markdown sanitize : objective with [[ or leading - is escaped
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT_PATH = path.resolve(__dirname, '..', 'scripts', 'backfill-log-from-sessions.mjs');

let workDir;
let vaultDir;
let configPath;
let stateDirOverride;

before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-log-'));
  stateDirOverride = path.join(workDir, 'fake-home');
  fs.mkdirSync(stateDirOverride, { recursive: true });
});

after(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Fresh vault per test for isolation.
  vaultDir = fs.mkdtempSync(path.join(workDir, 'vault-'));
  fs.mkdirSync(path.join(vaultDir, 'wiki-meta', 'Sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(vaultDir, 'wiki-meta', 'journal.md'),
    '---\ntype: wiki-log\n---\n\n# Journal\n\nAppend-only.\n',
    'utf8',
  );
  configPath = path.join(workDir, `config-${path.basename(vaultDir)}.json`);
  fs.writeFileSync(configPath, JSON.stringify({
    portRegistry: { [vaultDir]: 27999 },
    vaultNames: { [vaultDir]: 'test-vault' },
  }, null, 2));
});

function writeSession(filename, { status = 'closed', firstUserPrompt = null, startedAt = '2026-05-23T10:00:00.000Z', duration = '1h05m', recap = null, chronoPrompts = [] } = {}) {
  const fmLines = [
    '---',
    'type: session',
    `session-id: ${filename.replace('.md', '')}`,
    `started-at: ${startedAt}`,
    `status: ${status}`,
  ];
  if (firstUserPrompt) fmLines.push(`firstUserPrompt: ${firstUserPrompt}`);
  if (duration) fmLines.push(`duration: ${duration}`);
  fmLines.push('---', '');

  const chronoSection = chronoPrompts.length
    ? chronoPrompts.map((p, i) => `## 10:${String(10 + i).padStart(2, '0')}:00 — User prompt\n\n${p}\n`).join('\n')
    : '';

  const recapSection = recap !== null
    ? `\n## Recap (auto-generated)\n\n- **${recap.label || '5 user prompts'}** · **${recap.tools || '12 tool calls'}** (${recap.breakdown || '3 writes, 2 bash'})\n`
    : '';

  const content = fmLines.join('\n') + '\n# Session\n\n## Chronological log\n\n' + chronoSection + recapSection;
  fs.writeFileSync(path.join(vaultDir, 'wiki-meta', 'Sessions', filename), content, 'utf8');
}

function runScript(...scriptArgs) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...scriptArgs], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      OBSIDIAN_ROUTER_CONFIG: configPath,
      HOME: stateDirOverride,
      USERPROFILE: stateDirOverride,
    },
  });
}

function readLog() {
  return fs.readFileSync(path.join(vaultDir, 'wiki-meta', 'journal.md'), 'utf8');
}

// ---------------------------------------------------------------------------

describe('backfill-log-from-sessions — single vault, nominal cases', () => {
  test('1 closed session → 1 backfilled line with objective + result + wikilink', () => {
    writeSession('2026-05-23-1000-test-aaaa.md', {
      firstUserPrompt: 'add a new MCP tool for fetching X',
      recap: { label: '5 user prompts', tools: '12 tool calls', breakdown: '3 writes, 2 bash' },
    });
    const r = runScript('--vault', vaultDir);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const log = readLog();
    assert.match(log, /— session — \[\[2026-05-23-1000-test-aaaa\]\] — add a new MCP tool for fetching X/);
    assert.match(log, /\n  → /);
    assert.match(log, /<!-- backfilled \d{4}-\d{2}-\d{2} -->/);
  });

  test('re-run is idempotent (basename grep dedup)', () => {
    writeSession('2026-05-23-1000-test-bbbb.md', { firstUserPrompt: 'do X', recap: { label: '1 user prompts' } });
    runScript('--vault', vaultDir);
    const beforeLog = readLog();
    const count1 = (beforeLog.match(/— session — /g) || []).length;
    assert.equal(count1, 1);

    runScript('--vault', vaultDir);
    const afterLog = readLog();
    const count2 = (afterLog.match(/— session — /g) || []).length;
    assert.equal(count2, 1, 're-run must not duplicate the line');
  });

  test('--dry-run does not write to log.md', () => {
    writeSession('2026-05-23-1000-test-cccc.md', { firstUserPrompt: 'dry run me', recap: { label: '2 user prompts' } });
    const before = readLog();
    const r = runScript('--vault', vaultDir, '--dry-run');
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /DRY-RUN/);
    assert.match(r.stdout, /would backfill 1 session/);
    const after = readLog();
    assert.equal(after, before, 'log.md must be unchanged in dry-run');
  });
});

describe('backfill-log-from-sessions — skip + fallback cases', () => {
  test('open session is skipped (not appended to log.md)', () => {
    writeSession('2026-05-23-1000-test-open.md', { status: 'open', firstUserPrompt: 'in-progress' });
    const r = runScript('--vault', vaultDir);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const log = readLog();
    assert.doesNotMatch(log, /test-open/, 'open session should NOT appear in log');
    assert.match(r.stdout, /open \(skipped\):\s*1/);
  });

  test('closed session with no recap → fallback "(no recap captured)"', () => {
    writeSession('2026-05-23-1000-test-norecap.md', { firstUserPrompt: 'session with no recap', recap: null });
    const r = runScript('--vault', vaultDir);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const log = readLog();
    assert.match(log, /\(no recap captured/, 'fallback message should appear in the result line');
  });

  test('closed session with no firstUserPrompt + no chrono → "(historical session — no objective captured)"', () => {
    writeSession('2026-05-23-1000-test-noobj.md', { firstUserPrompt: null, recap: { label: '1 user prompts' } });
    const r = runScript('--vault', vaultDir);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const log = readLog();
    assert.match(log, /no objective captured/, 'fallback objective should appear');
  });

  test('chrono fallback when frontmatter has no firstUserPrompt', () => {
    writeSession('2026-05-23-1000-test-chrono.md', {
      firstUserPrompt: null,
      chronoPrompts: ['this prompt comes from the chrono section'],
      recap: { label: '1 user prompts' },
    });
    const r = runScript('--vault', vaultDir);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const log = readLog();
    assert.match(log, /this prompt comes from the chrono section/, 'extractFirstPrompt should rescue when frontmatter lacks the field');
  });
});

describe('backfill-log-from-sessions — markdown injection sanitize (review+ pass 1 A1)', () => {
  test('objective with [[evil]] gets ZWSP-escaped so wikilink parser does not eat it', () => {
    writeSession('2026-05-23-1000-test-inj1.md', {
      firstUserPrompt: 'malicious [[evil]] payload',
      recap: { label: '1 user prompts' },
    });
    runScript('--vault', vaultDir);
    const log = readLog();
    // The literal [[evil]] should NOT appear unescaped (would create a parasitic wikilink)
    assert.doesNotMatch(log, /\[\[evil\]\]/, 'parasitic wikilink must be neutralized');
    // The visible text "evil" should still be there
    assert.match(log, /evil/, 'visible payload should remain readable');
  });

  test('objective starting with "- " gets a backslash to avoid spawning a new bullet', () => {
    writeSession('2026-05-23-1000-test-inj2.md', {
      firstUserPrompt: '- this would have been a sub-bullet',
      recap: { label: '1 user prompts' },
    });
    runScript('--vault', vaultDir);
    const log = readLog();
    // The escaped form `\-` should be present
    assert.match(log, /\\- this would have been a sub-bullet/, 'leading dash must be escaped');
  });

  test('objective with <!-- gets ZWSP-escaped to avoid hiding subsequent log content', () => {
    writeSession('2026-05-23-1000-test-inj3.md', {
      firstUserPrompt: 'hide me <!-- everything after disappears',
      recap: { label: '1 user prompts' },
    });
    runScript('--vault', vaultDir);
    const log = readLog();
    assert.doesNotMatch(log, /<!-- everything after/, 'comment opener must be neutralized');
  });
});

describe('backfill-log-from-sessions — error paths', () => {
  test('missing --vault arg → fails with usage message', () => {
    const r = runScript();
    assert.notEqual(r.status, 0);
    const out = (r.stdout || '') + (r.stderr || '');
    assert.match(out, /Usage|--vault|--all/);
  });

  test('--vault unknown-slug → fails with clear message', () => {
    const r = runScript('--vault', 'nonexistent-slug');
    assert.notEqual(r.status, 0);
    const out = (r.stdout || '') + (r.stderr || '');
    assert.match(out, /No vault matched|did not match/i);
  });

  test('codex P3 — fm.prompt fallback used when firstUserPrompt is absent', () => {
    // Write a session with NO firstUserPrompt but with a `prompt:` frontmatter
    // (the format pre-v0.12.8 or for manual/migrated notes).
    const sessionPath = path.join(vaultDir, 'wiki-meta', 'Sessions', '2026-05-23-1000-test-promptfb.md');
    const content = (
      '---\n' +
      'type: session\n' +
      'session-id: test-promptfb\n' +
      'started-at: 2026-05-23T10:00:00.000Z\n' +
      'status: closed\n' +
      'prompt: legacy prompt field from manual session note\n' +
      'duration: 30m\n' +
      '---\n\n# Session\n\n' +
      '## Recap (auto-generated)\n\n- **1 user prompts** · **0 tool calls**\n'
    );
    fs.writeFileSync(sessionPath, content, 'utf8');
    const r = runScript('--vault', vaultDir);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const log = readLog();
    assert.match(log, /legacy prompt field from manual session note/,
      'fm.prompt should be used as objective fallback when firstUserPrompt is absent');
  });

  test('codex P2-3 — OBSIDIAN_ROUTER_CONFIG env var is honored', () => {
    // Write a session in our test vault so there's something to backfill.
    writeSession('2026-05-23-1000-test-envcfg.md', { firstUserPrompt: 'env config test', recap: { label: '1 user prompts' } });
    // Spawn the script with OBSIDIAN_ROUTER_CONFIG pointing to a bogus
    // config — should fail to resolve the vault slug (slug not in registry).
    const bogusCfg = path.join(workDir, 'bogus-cfg.json');
    fs.writeFileSync(bogusCfg, JSON.stringify({ portRegistry: {}, vaultNames: {} }), 'utf8');
    const r = spawnSync(process.execPath, [SCRIPT_PATH, '--vault', 'test-vault'], {
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: bogusCfg, HOME: stateDirOverride, USERPROFILE: stateDirOverride },
    });
    assert.notEqual(r.status, 0, 'should fail because bogus config has no test-vault slug');
    const out = (r.stdout || '') + (r.stderr || '');
    assert.match(out, /No vault matched/);
  });

  test('un-migrated vault: backfills into the legacy wiki-meta/log.md, creates no duplicate', () => {
    // v0.58.0 compat: a vault still on the pre-rename name must keep working,
    // and the backfill must NOT open a second journal beside the old one.
    fs.renameSync(
      path.join(vaultDir, 'wiki-meta', 'journal.md'),
      path.join(vaultDir, 'wiki-meta', 'log.md'),
    );
    writeSession('2026-05-23-1000-legacy.md', { firstUserPrompt: 'Objectif legacy', recap: { label: '2 user prompts' } });
    const r = runScript('--vault', vaultDir);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const legacy = fs.readFileSync(path.join(vaultDir, 'wiki-meta', 'log.md'), 'utf8');
    assert.match(legacy, /\[\[2026-05-23-1000-legacy\]\]/);
    assert.match(legacy, /Objectif legacy/);
    assert.equal(
      fs.existsSync(path.join(vaultDir, 'wiki-meta', 'journal.md')),
      false,
      'must not create journal.md next to the legacy log.md',
    );
  });

  test('vault without wiki-meta/journal.md → silent skip with info message', () => {
    // Remove the journal to simulate the case
    fs.unlinkSync(path.join(vaultDir, 'wiki-meta', 'journal.md'));
    writeSession('2026-05-23-1000-test-nolog.md', { firstUserPrompt: 'X', recap: { label: '1 user prompts' } });
    const r = runScript('--vault', vaultDir);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /no wiki-meta\/journal\.md/);
    assert.equal(fs.existsSync(path.join(vaultDir, 'wiki-meta', 'journal.md')), false, 'journal.md must NOT be created');
  });
});
