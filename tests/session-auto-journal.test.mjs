/**
 * Tests for hooks/session-auto-journal.mjs (v0.12.4).
 *
 * Covers:
 *   - SessionStart creates the journal file with frontmatter
 *   - UserPromptSubmit appends verbatim user prompts
 *   - PostToolUse appends entries for write-flavored tools (Write/Bash/MCP)
 *   - PostToolUse is silent for non-logged tools (e.g. Read)
 *   - SessionEnd inserts heuristic recap + closes frontmatter + cleans state
 *   - Workspace-bound mode (cwd is code project, vault via .env link)
 *   - No vault association → silent skip (no file created)
 *   - OBSIDIAN_ROUTER_NO_SESSION_JOURNAL=true → opt-out
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
const HOOK_PATH = path.resolve(__dirname, '..', 'hooks', 'session-auto-journal.mjs');

let workDir;
let vaultDir;          // simulated vault (has wiki-meta/index.md)
let codeWorkspace;     // code workspace (no wiki-meta/) — linked to vaultDir via .env
let plainCwd;          // no-vault cwd
let configPath;        // router config registering vaultDir
let stateDirOverride;  // we'll point HOME to here so state JSONs don't pollute the real home

function fakeHome() {
  return stateDirOverride;
}

before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-journal-'));

  vaultDir = path.join(workDir, 'my-vault');
  fs.mkdirSync(path.join(vaultDir, 'wiki-meta'), { recursive: true });
  fs.writeFileSync(path.join(vaultDir, 'wiki-meta', 'index.md'), '# Index\n');

  codeWorkspace = path.join(workDir, 'code-workspace');
  fs.mkdirSync(codeWorkspace, { recursive: true });

  plainCwd = path.join(workDir, 'plain');
  fs.mkdirSync(plainCwd, { recursive: true });

  configPath = path.join(workDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    portRegistry: { [vaultDir]: 27999 },
    vaultNames: { [vaultDir]: 'my-vault' },
  }, null, 2));

  stateDirOverride = path.join(workDir, 'fake-home');
  fs.mkdirSync(stateDirOverride, { recursive: true });
});

after(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Wipe Sessions/ from the vault between tests so each test starts fresh
  const sessionsDir = path.join(vaultDir, 'wiki-meta', 'Sessions');
  if (fs.existsSync(sessionsDir)) {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  }
  // Wipe state dir between tests
  const stateDir = path.join(stateDirOverride, '.claude', 'obsidian-mcp-router', 'session-journals');
  if (fs.existsSync(stateDir)) {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  // Clean any .env left behind in workspaces
  for (const cwd of [codeWorkspace, plainCwd]) {
    const e = path.join(cwd, '.env');
    if (fs.existsSync(e)) fs.unlinkSync(e);
  }
});

function runHook({
  event,
  cwd,
  sessionId = 'test-session-1',
  prompt = '',
  toolName = '',
  toolInput = {},
  reason = 'logout',
  env = {},
  workspaceDotenv = null,
} = {}) {
  if (workspaceDotenv !== null) {
    fs.writeFileSync(path.join(cwd, '.env'), workspaceDotenv);
  }
  const payload = {
    hook_event_name: event,
    cwd,
    session_id: sessionId,
  };
  if (event === 'UserPromptSubmit') payload.prompt = prompt;
  if (event === 'PostToolUse') { payload.tool_name = toolName; payload.tool_input = toolInput; }
  if (event === 'SessionEnd') payload.reason = reason;

  return spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      OBSIDIAN_ROUTER_CONFIG: configPath,
      // Redirect $HOME / $USERPROFILE so the hook's state dir lands under
      // our scratch workDir instead of the developer's real home.
      HOME: stateDirOverride,
      USERPROFILE: stateDirOverride,
      ...env,
    },
    timeout: 10000,
  });
}

function findJournal() {
  const sessionsDir = path.join(vaultDir, 'wiki-meta', 'Sessions');
  if (!fs.existsSync(sessionsDir)) return null;
  const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.md'));
  if (files.length === 0) return null;
  // Tests only ever create one journal each — return the first.
  return path.join(sessionsDir, files[0]);
}

function listJournals() {
  const sessionsDir = path.join(vaultDir, 'wiki-meta', 'Sessions');
  if (!fs.existsSync(sessionsDir)) return [];
  return fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.md'));
}

function readJournal() {
  const p = findJournal();
  return p ? fs.readFileSync(p, 'utf8') : null;
}

// ---------------------------------------------------------------------------

describe('session-auto-journal — cwd-is-vault mode', () => {
  test('SessionStart creates a journal file with frontmatter', () => {
    const r = runHook({ event: 'SessionStart', cwd: vaultDir });
    assert.equal(r.status, 0, r.stderr);
    const content = readJournal();
    assert.ok(content, 'journal file should exist');
    assert.match(content, /^---\n/);
    assert.match(content, /type: session/);
    assert.match(content, /status: open/);
    assert.match(content, /session-id: test-session-1/);
    assert.match(content, /## Chronological log/);
  });

  test('UserPromptSubmit lazy-creates the journal + appends prompt verbatim', () => {
    const r = runHook({
      event: 'UserPromptSubmit',
      cwd: vaultDir,
      sessionId: 'lazy-session',
      prompt: 'Hello world — verbatim prompt content',
    });
    assert.equal(r.status, 0, r.stderr);
    const content = readJournal();
    assert.ok(content, 'journal should be lazy-created');
    assert.match(content, /User prompt/);
    assert.match(content, /Hello world — verbatim prompt content/);
  });

  test('PostToolUse appends a Write tool entry with the file_path', () => {
    runHook({ event: 'SessionStart', cwd: vaultDir, sessionId: 'tool-session' });
    const r = runHook({
      event: 'PostToolUse',
      cwd: vaultDir,
      sessionId: 'tool-session',
      toolName: 'Write',
      toolInput: { file_path: '/foo/bar.mjs' },
    });
    assert.equal(r.status, 0, r.stderr);
    const content = readJournal();
    assert.match(content, /tool: Write/);
    assert.match(content, /file: \/foo\/bar\.mjs/);
  });

  test('PostToolUse appends a Bash entry with the command', () => {
    runHook({ event: 'SessionStart', cwd: vaultDir, sessionId: 'bash-session' });
    const r = runHook({
      event: 'PostToolUse',
      cwd: vaultDir,
      sessionId: 'bash-session',
      toolName: 'Bash',
      toolInput: { command: 'git status --short' },
    });
    assert.equal(r.status, 0, r.stderr);
    const content = readJournal();
    assert.match(content, /tool: Bash/);
    assert.match(content, /git status --short/);
  });

  test('PostToolUse is silent for filtered-out tools (Read)', () => {
    runHook({ event: 'SessionStart', cwd: vaultDir, sessionId: 'read-session' });
    const before = readJournal();
    const r = runHook({
      event: 'PostToolUse',
      cwd: vaultDir,
      sessionId: 'read-session',
      toolName: 'Read',
      toolInput: { file_path: '/foo/bar.mjs' },
    });
    assert.equal(r.status, 0, r.stderr);
    const after = readJournal();
    assert.equal(after, before, 'journal should not change for Read tool');
  });

  test('SessionEnd inserts recap + closes frontmatter + deletes state', () => {
    runHook({ event: 'SessionStart', cwd: vaultDir, sessionId: 'end-session' });
    runHook({
      event: 'UserPromptSubmit', cwd: vaultDir, sessionId: 'end-session',
      prompt: 'do the thing',
    });
    runHook({
      event: 'PostToolUse', cwd: vaultDir, sessionId: 'end-session',
      toolName: 'Write', toolInput: { file_path: '/foo/output.md' },
    });
    runHook({
      event: 'PostToolUse', cwd: vaultDir, sessionId: 'end-session',
      toolName: 'Bash', toolInput: { command: 'npm run build' },
    });
    const r = runHook({ event: 'SessionEnd', cwd: vaultDir, sessionId: 'end-session', reason: 'logout' });
    assert.equal(r.status, 0, r.stderr);

    const content = readJournal();
    assert.ok(content);
    // Recap inserted near the top after frontmatter
    assert.match(content, /## Recap \(auto-generated\)/);
    assert.match(content, /1 user prompts/);
    assert.match(content, /1 writes/);
    assert.match(content, /1 bash/);
    assert.match(content, /\/foo\/output\.md/);
    assert.match(content, /npm run build/);
    // Frontmatter closed
    assert.match(content, /status: closed/);
    assert.match(content, /ended-at:/);
    assert.match(content, /duration:/);
    // Closure marker in chrono
    assert.match(content, /Session closed/);

    // State JSON cleaned up
    const stateFile = path.join(stateDirOverride, '.claude', 'obsidian-mcp-router', 'session-journals', 'end-session.json');
    assert.equal(fs.existsSync(stateFile), false, 'state file should be deleted after SessionEnd');
  });
});

// ---------------------------------------------------------------------------

describe('session-auto-journal — workspace-bound mode', () => {
  test('SessionStart creates journal in the linked vault (not in cwd)', () => {
    const r = runHook({
      event: 'SessionStart',
      cwd: codeWorkspace,
      sessionId: 'ws-session',
      workspaceDotenv: 'OBSIDIAN_ROUTER_DEFAULT_VAULT="my-vault"\n',
    });
    assert.equal(r.status, 0, r.stderr);
    const content = readJournal();
    assert.ok(content, 'journal should be in the linked vault');
    assert.match(content, /workspace: code-workspace/);
    // The journal should NOT be in the code workspace
    assert.equal(fs.existsSync(path.join(codeWorkspace, 'wiki-meta', 'Sessions')), false);
  });
});

// ---------------------------------------------------------------------------

describe('session-auto-journal — skip conditions', () => {
  test('No vault association → silent skip (no file)', () => {
    const r = runHook({ event: 'SessionStart', cwd: plainCwd, sessionId: 'skip-1' });
    assert.equal(r.status, 0, r.stderr);
    const content = readJournal();
    assert.equal(content, null, 'no journal should be created');
  });

  test('OBSIDIAN_ROUTER_NO_SESSION_JOURNAL=true → silent skip', () => {
    const r = runHook({
      event: 'SessionStart',
      cwd: vaultDir,
      sessionId: 'optout-1',
      env: { OBSIDIAN_ROUTER_NO_SESSION_JOURNAL: 'true' },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readJournal(), null, 'no journal should be created');
  });

  test('Unknown event name → silent no-op (forward-compat)', () => {
    runHook({ event: 'SessionStart', cwd: vaultDir, sessionId: 'unknown-event-session' });
    const before = readJournal();
    const r = spawnSync(process.execPath, [HOOK_PATH], {
      input: JSON.stringify({ hook_event_name: 'SomeFutureEvent', cwd: vaultDir, session_id: 'unknown-event-session' }),
      encoding: 'utf8',
      env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: configPath, HOME: stateDirOverride, USERPROFILE: stateDirOverride },
      timeout: 10000,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readJournal(), before, 'unknown event should not modify the journal');
  });
});

// ---------------------------------------------------------------------------
// Review+ pass 1 regression tests (v0.12.5 fixes for findings 1-7)
// ---------------------------------------------------------------------------

describe('session-auto-journal — review+ pass 1 regressions', () => {
  test('codex P2 #1 — distinct session_ids never collide on filename', () => {
    // Two SessionStarts for the same workspace within the same minute
    // (the tests run within ms of each other → identical YYYY-MM-DD-HHMM).
    // Pre-fix: both resolved to the same `journalPath` and the second
    // session appended into the first session's file.
    runHook({ event: 'SessionStart', cwd: vaultDir, sessionId: 'session-aaaa-1111' });
    runHook({ event: 'SessionStart', cwd: vaultDir, sessionId: 'session-bbbb-2222' });
    const files = listJournals();
    assert.equal(files.length, 2, `expected 2 distinct journal files, got ${files.length}: ${files.join(', ')}`);
    // Each filename should carry a different session-id discriminator
    const ids = files.map((f) => f.match(/-(sessiona|sessionb|[a-z0-9]{1,8})\.md$/)?.[1] || f);
    assert.notEqual(ids[0], ids[1], 'filenames should carry distinct session-id suffixes');
  });

  test('Reviewer A IMPORTANT #2 — SessionEnd closes frontmatter even when `status:` was removed', () => {
    runHook({ event: 'SessionStart', cwd: vaultDir, sessionId: 'no-status-session' });
    // Manually strip `status: open` from the frontmatter to simulate a
    // user editing the file or a bug somewhere upstream.
    const jp = findJournal();
    const original = fs.readFileSync(jp, 'utf8');
    const stripped = original.replace(/^status:.*$\n/m, '');
    assert.doesNotMatch(stripped, /^status:/m, 'sanity check: status removed');
    fs.writeFileSync(jp, stripped);

    runHook({ event: 'SessionEnd', cwd: vaultDir, sessionId: 'no-status-session', reason: 'logout' });
    const after = fs.readFileSync(jp, 'utf8');
    assert.match(after, /^status: closed$/m, 'status: closed should have been appended');
  });

  test('Reviewer A IMPORTANT #5 — user prompts > 100 KB are truncated with a marker', () => {
    runHook({ event: 'SessionStart', cwd: vaultDir, sessionId: 'huge-prompt-session' });
    const huge = 'x'.repeat(120_000); // 120 KB, above the 100 KB cap
    runHook({
      event: 'UserPromptSubmit',
      cwd: vaultDir,
      sessionId: 'huge-prompt-session',
      prompt: huge,
    });
    const content = readJournal();
    assert.ok(content.length < huge.length + 5000, 'journal should be smaller than the original prompt');
    assert.match(content, /\[truncated by session-auto-journal/);
    assert.match(content, /original prompt was 120000 chars/);
  });

  test('codex P2 #2 — execute_template (with createFile) is logged + targetPath added to state.files', () => {
    runHook({ event: 'SessionStart', cwd: vaultDir, sessionId: 'template-session' });
    runHook({
      event: 'PostToolUse',
      cwd: vaultDir,
      sessionId: 'template-session',
      toolName: 'mcp__obsidian-router__execute_template',
      toolInput: { name: 'Templates/Daily.md', createFile: true, targetPath: 'Daily/2026-05-23.md' },
    });
    runHook({ event: 'SessionEnd', cwd: vaultDir, sessionId: 'template-session', reason: 'logout' });
    const content = readJournal();
    assert.match(content, /tool: mcp__obsidian-router__execute_template/);
    // The recap should list the created file
    assert.match(content, /Daily\/2026-05-23\.md/);
  });

  test('codex P3 #3 — move_file adds both `from` and `to` to state.files', () => {
    runHook({ event: 'SessionStart', cwd: vaultDir, sessionId: 'move-session' });
    runHook({
      event: 'PostToolUse',
      cwd: vaultDir,
      sessionId: 'move-session',
      toolName: 'mcp__obsidian-router__move_file',
      toolInput: { from: 'wiki/old-path.md', to: 'wiki/new-path.md' },
    });
    runHook({ event: 'SessionEnd', cwd: vaultDir, sessionId: 'move-session', reason: 'logout' });
    const content = readJournal();
    assert.match(content, /wiki\/old-path\.md/, 'recap should list the source path');
    assert.match(content, /wiki\/new-path\.md/, 'recap should list the destination path');
  });

  test('codex pass 2 P3 — fallback session_id (Claude Code omits one) does not collide on filename', () => {
    // Simulate Claude Code omitting session_id by passing an empty string.
    // The hook should generate a UUID-based id and the filename's 8-char
    // discriminator must be uuid-derived (not a constant prefix).
    runHook({ event: 'SessionStart', cwd: vaultDir, sessionId: '' });
    runHook({ event: 'SessionStart', cwd: vaultDir, sessionId: '' });
    const files = listJournals();
    assert.equal(files.length, 2,
      `expected 2 distinct journal files for two missing-session_id starts, got ${files.length}: ${files.join(', ')}`);
    // Each filename's last 11 chars are `<8-char>.md` — the 8-char part
    // must be UUID-derived (not the literal "fallback").
    for (const f of files) {
      const suffix = f.slice(-11, -3); // chars before `.md`
      assert.notEqual(suffix, 'fallback', `filename suffix should not be the literal "fallback": ${f}`);
      assert.match(suffix, /^[a-f0-9]{8}$/i, `filename suffix should be UUID-derived hex (got "${suffix}" in ${f})`);
    }
  });

  test('Reviewer A IMPORTANT #7 — SessionStart 2x with same session_id is idempotent on the journal file', () => {
    runHook({ event: 'SessionStart', cwd: vaultDir, sessionId: 'resume-test-session' });
    const before = readJournal();
    const filesBefore = listJournals();
    assert.equal(filesBefore.length, 1);

    // Simulate a crash-recovery scenario: state JSON wiped, journal file
    // still on disk. Second SessionStart for the same session_id must
    // NOT overwrite the journal file.
    const stateFile = path.join(
      stateDirOverride, '.claude', 'obsidian-mcp-router',
      'session-journals', 'resume-test-session.json',
    );
    fs.unlinkSync(stateFile);

    runHook({ event: 'SessionStart', cwd: vaultDir, sessionId: 'resume-test-session' });
    const after = readJournal();
    const filesAfter = listJournals();
    assert.equal(filesAfter.length, 1, 'still exactly one journal file');
    assert.equal(after, before, 'journal file content must not change on idempotent resume');
  });
});

// ---------------------------------------------------------------------------
// v0.12.8 — log.md auto-append on SessionEnd
// ---------------------------------------------------------------------------

describe('session-auto-journal — v0.12.8 log.md auto-append', () => {
  // Small helper: write a minimal wiki-meta/log.md so the hook has a file to append to.
  function ensureLogMd() {
    const logPath = path.join(vaultDir, 'wiki-meta', 'log.md');
    fs.writeFileSync(logPath, '---\ntype: wiki-log\n---\n\n# Log\n\nAppend-only.\n', 'utf8');
    return logPath;
  }

  test('SessionEnd appends one parseable line to wiki-meta/log.md with verb session, wikilink, objective, result', () => {
    const logPath = ensureLogMd();
    runHook({ event: 'SessionStart', cwd: vaultDir, sessionId: 'log-test-1' });
    runHook({
      event: 'UserPromptSubmit', cwd: vaultDir, sessionId: 'log-test-1',
      prompt: 'add a new MCP tool for fetching weather data',
    });
    runHook({
      event: 'PostToolUse', cwd: vaultDir, sessionId: 'log-test-1',
      toolName: 'Write', toolInput: { file_path: '/foo/weather.mjs' },
    });
    runHook({
      event: 'PostToolUse', cwd: vaultDir, sessionId: 'log-test-1',
      toolName: 'Bash', toolInput: { command: 'npm test' },
    });
    runHook({ event: 'SessionEnd', cwd: vaultDir, sessionId: 'log-test-1', reason: 'logout' });

    const logContent = fs.readFileSync(logPath, 'utf8');
    // Verb prefix + wikilink to the journal basename
    assert.match(logContent, /— session — \[\[\d{4}-\d{2}-\d{2}-\d{4}-[^\]]+\]\] — /,
      'log.md should contain the verb-prefixed line with a wikilink to the session');
    // Objective derived from first user prompt
    assert.match(logContent, /add a new MCP tool for fetching weather data/,
      'objective should be the first user prompt');
    // Result line (indented continuation arrow)
    assert.match(logContent, /\n {2}→ /,
      'result should appear on the indented continuation line');
    // Result mentions the counters we generated
    assert.match(logContent, /1 writes/);
    assert.match(logContent, /1 bash/);
    assert.match(logContent, /first bash: npm test/);
  });

  test('SessionEnd log.md append is idempotent (basename grep dedup)', () => {
    const logPath = ensureLogMd();
    runHook({ event: 'SessionStart', cwd: vaultDir, sessionId: 'idemp-test-1' });
    runHook({ event: 'SessionEnd', cwd: vaultDir, sessionId: 'idemp-test-1', reason: 'logout' });
    const after1 = fs.readFileSync(logPath, 'utf8');
    const count1 = (after1.match(/— session —/g) || []).length;
    assert.equal(count1, 1, 'one session line after first SessionEnd');

    // Re-trigger SessionEnd somehow (e.g., dual-fired event): we manually call
    // the hook handler again. The dedup grep on the basename should prevent dup.
    // Note: in practice the state JSON has been deleted, so this 2nd call would
    // be a no-op anyway — but the dedup is an additional safety net we want.
    // Simulate the un-deleted-state case by re-creating state from disk and
    // re-running. Simpler: just run a 2nd SessionStart+SessionEnd for the same
    // session_id to force a 2nd append attempt.
    runHook({ event: 'SessionStart', cwd: vaultDir, sessionId: 'idemp-test-1' });
    runHook({ event: 'SessionEnd', cwd: vaultDir, sessionId: 'idemp-test-1', reason: 'logout' });
    const after2 = fs.readFileSync(logPath, 'utf8');
    const count2 = (after2.match(/— session —/g) || []).length;
    assert.equal(count2, 1, 'still one session line after re-trigger (dedup by basename)');
  });

  test('SessionEnd silent-skips when wiki-meta/log.md absent (no crash, no creation)', () => {
    const logPath = path.join(vaultDir, 'wiki-meta', 'log.md');
    // Ensure log.md does NOT exist
    if (fs.existsSync(logPath)) fs.unlinkSync(logPath);

    runHook({ event: 'SessionStart', cwd: vaultDir, sessionId: 'no-log-test-1' });
    const r = runHook({ event: 'SessionEnd', cwd: vaultDir, sessionId: 'no-log-test-1', reason: 'logout' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(logPath), false, 'log.md should NOT be created by the hook (wiki skill owns scaffolding)');
    // But the journal file itself should still exist (the recap + frontmatter rewrite happened)
    const journal = readJournal();
    assert.ok(journal, 'journal file should still exist');
    assert.match(journal, /status: closed/, 'journal frontmatter should still be closed');
  });
});

// ---------------------------------------------------------------------------
// v0.12.9 — /review+ pass 1 regression tests
// ---------------------------------------------------------------------------

describe('session-auto-journal — v0.12.9 review+ pass 1 regressions', () => {
  function ensureLogMd() {
    const logPath = path.join(vaultDir, 'wiki-meta', 'log.md');
    fs.writeFileSync(logPath, '---\ntype: wiki-log\n---\n\n# Log\n', 'utf8');
    return logPath;
  }

  test('A1 — objective with [[wikilink]] gets ZWSP-escaped (no parasitic link)', () => {
    const logPath = ensureLogMd();
    runHook({ event: 'SessionStart', cwd: vaultDir, sessionId: 'inj-wiki-1' });
    runHook({
      event: 'UserPromptSubmit', cwd: vaultDir, sessionId: 'inj-wiki-1',
      prompt: 'malicious payload [[secret-page]] here',
    });
    runHook({ event: 'SessionEnd', cwd: vaultDir, sessionId: 'inj-wiki-1', reason: 'logout' });
    const log = fs.readFileSync(logPath, 'utf8');
    // Original unescaped form must NOT appear (would create a wikilink to secret-page)
    assert.doesNotMatch(log, /malicious payload \[\[secret-page\]\] here/);
    // But the visible text must still appear (so the user sees what was attempted)
    assert.match(log, /malicious payload/);
    assert.match(log, /secret-page/);
  });

  test('A1 — objective starting with "- " gets escaped (does not spawn a sub-bullet)', () => {
    const logPath = ensureLogMd();
    runHook({ event: 'SessionStart', cwd: vaultDir, sessionId: 'inj-bullet-1' });
    runHook({
      event: 'UserPromptSubmit', cwd: vaultDir, sessionId: 'inj-bullet-1',
      prompt: '- inject a new bullet at top level',
    });
    runHook({ event: 'SessionEnd', cwd: vaultDir, sessionId: 'inj-bullet-1', reason: 'logout' });
    const log = fs.readFileSync(logPath, 'utf8');
    assert.match(log, /\\- inject a new bullet/, 'leading dash must be backslash-escaped');
  });

  test('A1 — objective with <!-- gets ZWSP-escaped (does not hide log content)', () => {
    const logPath = ensureLogMd();
    runHook({ event: 'SessionStart', cwd: vaultDir, sessionId: 'inj-comment-1' });
    runHook({
      event: 'UserPromptSubmit', cwd: vaultDir, sessionId: 'inj-comment-1',
      prompt: 'open comment <!-- that hides everything after',
    });
    runHook({ event: 'SessionEnd', cwd: vaultDir, sessionId: 'inj-comment-1', reason: 'logout' });
    const log = fs.readFileSync(logPath, 'utf8');
    assert.doesNotMatch(log, /<!-- that hides/, 'raw comment opener must be neutralized');
  });

  test('codex P2-1 — multiline bash hint is collapsed to a single line in the result', () => {
    const logPath = ensureLogMd();
    runHook({ event: 'SessionStart', cwd: vaultDir, sessionId: 'multiline-bash-1' });
    runHook({
      event: 'PostToolUse',
      cwd: vaultDir,
      sessionId: 'multiline-bash-1',
      toolName: 'Bash',
      toolInput: { command: 'cat <<EOF\nline1\nline2\nEOF' },
    });
    runHook({ event: 'SessionEnd', cwd: vaultDir, sessionId: 'multiline-bash-1', reason: 'logout' });
    const log = fs.readFileSync(logPath, 'utf8');
    // The log entry must be exactly 2 markdown lines (after the leading \n).
    // Extract the entry for our session and split into lines.
    // Find OUR session's entry by basename (filename = YYYY-MM-DD-HHMM-<workspace>-<sessionidshort>.md
    // where sessionidshort = first 8 alphanum chars of 'multiline-bash-1' = 'multilin').
    const filename = listJournals()[0].replace(/\.md$/, '');
    const entryMatch = log.match(new RegExp(`\\n(- \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} — session — \\[\\[${filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\] — [^\\n]+\\n  → [^\\n]+\\n)`));
    assert.ok(entryMatch, `should find the session entry for ${filename}, log was:\n${log}`);
    const entry = entryMatch[1];
    // 2 lines expected (header + arrow continuation); no stray newlines from the heredoc
    const lines = entry.trimEnd().split('\n');
    assert.equal(lines.length, 2, `expected 2 lines, got ${lines.length}:\n${entry}`);
    // The collapsed bash hint should appear as 'cat <<EOF line1 line2 EOF' (spaces, not newlines)
    assert.match(log, /first bash: cat <<EOF line1 line2 EOF/);
  });

  test('codex P2-2 — log date and time derive from the same local Date (no UTC/local mix)', () => {
    // We can't easily force the timezone in node:test, but we can verify
    // that the date and time both correspond to the same local moment by
    // checking they agree with `new Date().toLocaleString()` semantics.
    const logPath = ensureLogMd();
    runHook({ event: 'SessionStart', cwd: vaultDir, sessionId: 'tz-test-1' });
    runHook({ event: 'SessionEnd', cwd: vaultDir, sessionId: 'tz-test-1', reason: 'logout' });
    const log = fs.readFileSync(logPath, 'utf8');
    const m = log.match(/\n- (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) — session — \[\[[^\]]+\]\]/);
    assert.ok(m, 'should find a session entry with date+time');
    const [, y, mo, d, h, mi] = m.map((x) => Number(x));
    const now = new Date();
    // Sanity: the recorded date must equal today's local date (we just ran).
    assert.equal(y, now.getFullYear(), 'year must match local today');
    assert.equal(mo, now.getMonth() + 1, 'month must match local today');
    assert.equal(d, now.getDate(), 'day must match local TODAY (not UTC)');
    // Hours should match local now (within ±1 minute tolerance for slow tests).
    assert.ok(Math.abs(h - now.getHours()) <= 1, `hour ${h} should be within ±1 of local now ${now.getHours()}`);
    // Bonus: the date in log must match the date prefix in the filename (also local).
    const files = listJournals();
    const filenameDate = files[0].match(/^(\d{4}-\d{2}-\d{2})/)[1];
    assert.equal(`${m[1]}-${m[2]}-${m[3]}`, filenameDate, 'log entry date must match filename date');
  });

  test('A1 — pipe chars still escaped (regression from v0.12.8)', () => {
    const logPath = ensureLogMd();
    runHook({ event: 'SessionStart', cwd: vaultDir, sessionId: 'inj-pipe-1' });
    runHook({
      event: 'UserPromptSubmit', cwd: vaultDir, sessionId: 'inj-pipe-1',
      prompt: 'objective with | pipe chars',
    });
    runHook({ event: 'SessionEnd', cwd: vaultDir, sessionId: 'inj-pipe-1', reason: 'logout' });
    const log = fs.readFileSync(logPath, 'utf8');
    assert.match(log, /objective with \\\| pipe chars/);
  });
});

