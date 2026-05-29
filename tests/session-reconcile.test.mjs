/**
 * Tests for hooks/_helpers/session-reconcile.mjs (router v0.19.0).
 *
 * The shared self-healing reconciliation that fixes the log.md ↔ Sessions/
 * desync caused by an unreliable `SessionEnd` hook. Three layers:
 *
 *   1. Unit tests — call `reconcileVaultSessions()` directly against temp
 *      vault fixtures, with injectable `nowMs` / `liveWindowMs` for
 *      deterministic liveness + endedAt behavior. This is the core contract.
 *   2. Hook integration — spawn session-auto-journal.mjs SessionStart and
 *      assert it self-heals a pre-seeded orphan while NOT touching the
 *      current session.
 *   3. Backfill integration — spawn backfill-log-from-sessions.mjs
 *      --include-open and assert it closes + logs an orphan.
 *
 * Pure-helper exports (sanitize, compose, reconstruct) are covered indirectly
 * by the orchestrator tests + the existing session-auto-journal / backfill
 * suites which exercise the same formats.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  reconcileVaultSessions,
  reconstructStateFromContent,
  parseFrontmatter,
  composeSessionLogEntry,
} from '../hooks/_helpers/session-reconcile.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HOOK_PATH = path.resolve(__dirname, '..', 'hooks', 'session-auto-journal.mjs');
const BACKFILL_PATH = path.resolve(__dirname, '..', 'scripts', 'backfill-log-from-sessions.mjs');

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let root;        // scratch dir
let vaultDir;    // temp vault root
let stateDir;    // session-journals state dir

const MINUTE = 60 * 1000;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-reconcile-'));
  vaultDir = path.join(root, 'vault');
  fs.mkdirSync(path.join(vaultDir, 'wiki-meta', 'Sessions'), { recursive: true });
  fs.mkdirSync(path.join(vaultDir, 'wiki-meta'), { recursive: true });
  stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function sessionsDir() { return path.join(vaultDir, 'wiki-meta', 'Sessions'); }
function logPath() { return path.join(vaultDir, 'wiki-meta', 'log.md'); }

function writeLog(body = '---\ntype: wiki-log\n---\n\n# Log\n\nAppend-only.\n') {
  fs.writeFileSync(logPath(), body, 'utf8');
}
function readLog() { return fs.readFileSync(logPath(), 'utf8'); }

/**
 * Write a session journal file. `status` defaults to 'open'. When chrono
 * tool/prompt headings are supplied they exercise reconstructStateFromContent.
 */
function writeSession(filename, {
  status = 'open',
  startedAt = '2026-05-20T10:00:00.000Z',
  endedAt = null,
  type = 'session',
  firstPrompt = null,
  tools = [],          // e.g. ['Write', 'Bash', 'mcp__obsidian-router__write_file']
} = {}) {
  const fm = ['---', `type: ${type}`, `started-at: ${startedAt}`, `status: ${status}`];
  if (endedAt) fm.push(`ended-at: ${endedAt}`);
  fm.push('---', '', `# Session — ${filename}`, '', '## Chronological log', '');
  const chrono = [];
  if (firstPrompt) chrono.push(`## 10:00:00 — User prompt\n\n${firstPrompt}\n`);
  tools.forEach((t, i) => chrono.push(`### 10:0${i + 1}:00 — tool: ${t}\nfile: /x/${i}.md\n`));
  const content = fm.join('\n') + '\n' + chrono.join('\n');
  const p = path.join(sessionsDir(), filename);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

/** Write a state JSON for a session and set its mtime to `nowMs - ageMs`. */
function writeStateJson(sessionId, journalPath, { ageMs = 5 * MINUTE, nowMs = Date.now(), counters = {}, files = [], firstUserPrompt = null, startedAt = '2026-05-20T10:00:00.000Z', bashHighlights = [] } = {}) {
  const stateFile = path.join(stateDir, `${sessionId}.json`);
  fs.writeFileSync(stateFile, JSON.stringify({
    sessionId, journalPath, startedAt,
    counters: { prompts: 0, toolCalls: 0, writes: 0, bash: 0, reads: 0, mcpWrites: 0, ...counters },
    files, bashHighlights, firstUserPrompt,
  }, null, 2), 'utf8');
  const mtimeSec = (nowMs - ageMs) / 1000;
  fs.utimesSync(stateFile, mtimeSec, mtimeSec);
  return stateFile;
}

function statusOf(p) { return parseFrontmatter(fs.readFileSync(p, 'utf8'))?.status; }

// ---------------------------------------------------------------------------
// Unit tests — the core contract
// ---------------------------------------------------------------------------

describe('reconcileVaultSessions — open orphan (the core bug)', () => {
  test('open + stale + no state JSON → closed in place + log line appended', () => {
    writeLog();
    const p = writeSession('2026-05-20-1000-proj-aaaa.md', { firstPrompt: 'do the important thing' });
    const r = reconcileVaultSessions({ vaultPath: vaultDir, stateDir, nowMs: Date.now() });

    assert.deepEqual(r.reconciledOpen, ['2026-05-20-1000-proj-aaaa']);
    assert.equal(statusOf(p), 'closed', 'orphan frontmatter must flip to closed');
    const file = fs.readFileSync(p, 'utf8');
    assert.match(file, /closed-by: reconciliation/);
    assert.match(file, /## Recap \(reconciled — no SessionEnd\)/);
    assert.match(file, /ended-at:/);
    const log = readLog();
    assert.match(log, /— session — \[\[2026-05-20-1000-proj-aaaa\]\] — do the important thing/);
  });

  test('open + stale + state JSON → log line uses the state counters (rich recap)', () => {
    writeLog();
    const p = writeSession('2026-05-20-1000-proj-bbbb.md');
    writeStateJson('bbbb-1111', p, {
      ageMs: 200 * MINUTE,
      counters: { prompts: 3, toolCalls: 27, writes: 12, bash: 15 },
      files: ['/repo/CHANGELOG.md'],
      bashHighlights: ['git push'],
      firstUserPrompt: 'ship the release',
    });
    const r = reconcileVaultSessions({ vaultPath: vaultDir, stateDir, nowMs: Date.now() });

    assert.equal(r.reconciledOpen.length, 1);
    assert.equal(r.deletedStaleState, 1, 'consumed state JSON should be deleted');
    assert.equal(fs.existsSync(path.join(stateDir, 'bbbb-1111.json')), false);
    const log = readLog();
    assert.match(log, /ship the release/);
    assert.match(log, /12 writes/);
    assert.match(log, /15 bash/);
    assert.match(log, /first bash: git push/);
    const file = fs.readFileSync(p, 'utf8');
    assert.match(file, /3 user prompts/);
    assert.match(file, /CHANGELOG\.md/);
  });

  test('marker is appended to the backfilled log line when provided', () => {
    writeLog();
    writeSession('2026-05-20-1000-proj-mark.md', { firstPrompt: 'x' });
    reconcileVaultSessions({ vaultPath: vaultDir, stateDir, nowMs: Date.now(), marker: '<!-- reconciled 2026-05-29 (no SessionEnd) -->' });
    assert.match(readLog(), /<!-- reconciled 2026-05-29 \(no SessionEnd\) -->/);
  });
});

describe('reconcileVaultSessions — liveness guard (don\'t clobber concurrent sessions)', () => {
  test('open + FRESH state JSON (within live window) → left alone', () => {
    writeLog();
    const now = Date.now();
    const p = writeSession('2026-05-20-1000-proj-live.md');
    writeStateJson('live-1', p, { ageMs: 10 * MINUTE, nowMs: now }); // 10 min < 120 min window
    const r = reconcileVaultSessions({ vaultPath: vaultDir, stateDir, nowMs: now });

    assert.equal(r.skippedLive, 1);
    assert.equal(r.reconciledOpen.length, 0);
    assert.equal(statusOf(p), 'open', 'a live session must stay open');
    assert.doesNotMatch(readLog(), /proj-live/);
    assert.equal(fs.existsSync(path.join(stateDir, 'live-1.json')), true, 'live state JSON must NOT be deleted');
  });

  test('open + STALE state JSON (beyond live window) → reconciled', () => {
    writeLog();
    const now = Date.now();
    const p = writeSession('2026-05-20-1000-proj-stale.md');
    writeStateJson('stale-1', p, { ageMs: 200 * MINUTE, nowMs: now }); // 200 min > 120
    const r = reconcileVaultSessions({ vaultPath: vaultDir, stateDir, nowMs: now });

    assert.equal(r.skippedLive, 0);
    assert.equal(r.reconciledOpen.length, 1);
    assert.equal(statusOf(p), 'closed');
  });

  test('custom liveWindowMs is honored', () => {
    writeLog();
    const now = Date.now();
    const p = writeSession('2026-05-20-1000-proj-win.md');
    writeStateJson('win-1', p, { ageMs: 30 * MINUTE, nowMs: now });
    // 30 min age, window 15 min → considered stale → reconciled
    const r = reconcileVaultSessions({ vaultPath: vaultDir, stateDir, nowMs: now, liveWindowMs: 15 * MINUTE });
    assert.equal(r.reconciledOpen.length, 1);
    assert.equal(statusOf(p), 'closed');
  });
});

describe('reconcileVaultSessions — closed + current + dedup + type guard', () => {
  test('closed + already in log → fast-skip, untouched', () => {
    writeLog('---\ntype: wiki-log\n---\n\n# Log\n\n- 2026-05-20 10:00 — session — [[2026-05-20-1000-proj-cccc]] — old\n  → done\n');
    const p = writeSession('2026-05-20-1000-proj-cccc.md', { status: 'closed', endedAt: '2026-05-20T11:00:00.000Z' });
    const before = fs.readFileSync(p, 'utf8');
    const r = reconcileVaultSessions({ vaultPath: vaultDir, stateDir, nowMs: Date.now() });

    assert.equal(r.alreadyLogged, 1);
    assert.equal(r.scanned, 0, 'fast-skip means the file was not even parsed');
    assert.equal(fs.readFileSync(p, 'utf8'), before, 'already-logged file untouched');
    // exactly one session line
    assert.equal((readLog().match(/— session —/g) || []).length, 1);
  });

  test('closed + NOT in log → log line backfilled, file NOT modified', () => {
    writeLog();
    const p = writeSession('2026-05-20-1000-proj-dddd.md', { status: 'closed', endedAt: '2026-05-20T11:00:00.000Z', firstPrompt: 'legacy closed session', tools: ['Write', 'Bash'] });
    const before = fs.readFileSync(p, 'utf8');
    const r = reconcileVaultSessions({ vaultPath: vaultDir, stateDir, nowMs: Date.now() });

    assert.deepEqual(r.closedLogged, ['2026-05-20-1000-proj-dddd']);
    assert.equal(r.reconciledOpen.length, 0);
    assert.equal(fs.readFileSync(p, 'utf8'), before, 'closed file must not be rewritten');
    assert.match(readLog(), /\[\[2026-05-20-1000-proj-dddd\]\] — legacy closed session/);
  });

  test('current session journal is skipped even if open', () => {
    writeLog();
    const p = writeSession('2026-05-20-1000-proj-curr.md');
    const r = reconcileVaultSessions({ vaultPath: vaultDir, stateDir, nowMs: Date.now(), currentJournalPath: p });

    assert.equal(r.skippedCurrent, 1);
    assert.equal(statusOf(p), 'open', 'current session must not be closed');
    assert.doesNotMatch(readLog(), /proj-curr/);
  });

  test('non-session type file is ignored', () => {
    writeLog();
    const p = writeSession('2026-05-27-saas-pivot-decision.md', { type: 'decision', status: 'captured' });
    const before = fs.readFileSync(p, 'utf8');
    const r = reconcileVaultSessions({ vaultPath: vaultDir, stateDir, nowMs: Date.now() });

    assert.equal(r.reconciledOpen.length, 0);
    assert.equal(r.closedLogged.length, 0);
    assert.equal(fs.readFileSync(p, 'utf8'), before);
    assert.doesNotMatch(readLog(), /saas-pivot/);
  });

  test('idempotent: a second run is a no-op', () => {
    writeLog();
    writeSession('2026-05-20-1000-proj-idem.md', { firstPrompt: 'once' });
    reconcileVaultSessions({ vaultPath: vaultDir, stateDir, nowMs: Date.now() });
    const after1 = readLog();
    const r2 = reconcileVaultSessions({ vaultPath: vaultDir, stateDir, nowMs: Date.now() });
    assert.equal(r2.reconciledOpen.length, 0, 'nothing left to reconcile');
    assert.equal(r2.alreadyLogged, 1);
    assert.equal(readLog(), after1, 'log.md unchanged on the second run');
  });
});

describe('reconcileVaultSessions — dry-run + missing scaffolds', () => {
  test('dryRun reports but writes nothing', () => {
    writeLog();
    const p = writeSession('2026-05-20-1000-proj-dry.md', { firstPrompt: 'preview' });
    const before = fs.readFileSync(p, 'utf8');
    const beforeLog = readLog();
    const r = reconcileVaultSessions({ vaultPath: vaultDir, stateDir, nowMs: Date.now(), dryRun: true });

    assert.equal(r.reconciledOpen.length, 1, 'dry-run still reports what it would do');
    assert.equal(fs.readFileSync(p, 'utf8'), before, 'file untouched in dry-run');
    assert.equal(readLog(), beforeLog, 'log unchanged in dry-run');
  });

  test('missing log.md → open file still closed in place, missingLog flagged', () => {
    // no writeLog() — log.md absent
    const p = writeSession('2026-05-20-1000-proj-nolog.md', { firstPrompt: 'x' });
    const r = reconcileVaultSessions({ vaultPath: vaultDir, stateDir, nowMs: Date.now() });

    assert.equal(r.missingLog, true);
    assert.equal(r.reconciledOpen.length, 1);
    assert.equal(statusOf(p), 'closed', 'orphan still closed even without a log scaffold');
    assert.equal(fs.existsSync(logPath()), false, 'log.md must not be created');
  });

  test('missing Sessions/ dir → missingSessions flagged, no throw', () => {
    fs.rmSync(sessionsDir(), { recursive: true, force: true });
    writeLog();
    const r = reconcileVaultSessions({ vaultPath: vaultDir, stateDir, nowMs: Date.now() });
    assert.equal(r.missingSessions, true);
    assert.equal(r.reconciledOpen.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers — spot checks
// ---------------------------------------------------------------------------

describe('reconstructStateFromContent', () => {
  test('counts chrono tool headings + extracts first prompt', () => {
    const content = [
      '---', 'type: session', 'started-at: 2026-05-20T10:00:00.000Z', 'status: open', '---', '',
      '## Chronological log', '',
      '## 10:00:00 — User prompt', '', 'the objective line', '',
      '### 10:01:00 — tool: Write', 'file: /a.md', '',
      '### 10:02:00 — tool: Bash', '```bash\nls\n```', '',
      '### 10:03:00 — tool: mcp__obsidian-router__write_file', 'path: x.md', '',
    ].join('\n');
    const fm = parseFrontmatter(content);
    const state = reconstructStateFromContent(content, fm);
    assert.equal(state.counters.prompts, 1);
    assert.equal(state.counters.toolCalls, 3);
    assert.equal(state.counters.writes, 1);
    assert.equal(state.counters.bash, 1);
    assert.equal(state.counters.mcpWrites, 1);
    assert.equal(state.firstUserPrompt, 'the objective line');
  });
});

describe('composeSessionLogEntry', () => {
  test('produces the 2-line Format A entry and sanitizes injection', () => {
    const entry = composeSessionLogEntry({
      basename: '2026-05-20-1000-proj-x',
      endedAtMs: new Date('2026-05-20T11:30:00').getTime(),
      objective: 'do [[evil]] thing',
      result: '1 writes',
      marker: '<!-- m -->',
    });
    assert.match(entry, /— session — \[\[2026-05-20-1000-proj-x\]\] — /);
    assert.match(entry, /\n {2}→ 1 writes  <!-- m -->\n/);
    assert.doesNotMatch(entry, /\[\[evil\]\]/, 'parasitic wikilink neutralized');
  });
});

// ---------------------------------------------------------------------------
// Integration — the hook self-heals an orphan at SessionStart
// ---------------------------------------------------------------------------

describe('session-auto-journal SessionStart — self-heal integration', () => {
  test('a pre-seeded orphan is reconciled while the current session is left open', () => {
    writeLog();
    // detectVaultContext (workspace-bound) requires wiki-meta/index.md.
    fs.writeFileSync(path.join(vaultDir, 'wiki-meta', 'index.md'), '# Index\n');
    // Seed an orphan: open journal + a STALE state JSON (so liveness lets it through).
    const orphan = writeSession('2026-05-20-1000-proj-orph.md', { firstPrompt: 'crashed work' });
    writeStateJson('orphan-sid', orphan, { ageMs: 300 * MINUTE, firstUserPrompt: 'crashed work' });

    // Router config + workspace .env so the hook resolves THIS vault.
    const cfg = path.join(root, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ portRegistry: { [vaultDir]: 27999 }, vaultNames: { [vaultDir]: 'rec-vault' } }), 'utf8');
    const ws = path.join(root, 'workspace');
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, '.env'), 'OBSIDIAN_ROUTER_DEFAULT_VAULT="rec-vault"\n');
    // Point HOME at our scratch so the hook's STATE_DIR == our stateDir parent.
    const fakeHome = path.join(root, 'fake-home');
    fs.mkdirSync(path.join(fakeHome, '.claude', 'obsidian-mcp-router', 'session-journals'), { recursive: true });
    // Move our seeded state JSON into the hook's real state dir location.
    fs.copyFileSync(path.join(stateDir, 'orphan-sid.json'),
      path.join(fakeHome, '.claude', 'obsidian-mcp-router', 'session-journals', 'orphan-sid.json'));
    const seededState = path.join(fakeHome, '.claude', 'obsidian-mcp-router', 'session-journals', 'orphan-sid.json');
    const old = (Date.now() - 300 * MINUTE) / 1000;
    fs.utimesSync(seededState, old, old);

    const r = spawnSync(process.execPath, [HOOK_PATH], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: ws, session_id: 'fresh-current-session' }),
      encoding: 'utf8',
      env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: cfg, HOME: fakeHome, USERPROFILE: fakeHome },
      timeout: 15000,
    });
    assert.equal(r.status, 0, r.stderr);

    // Orphan must now be closed + logged.
    assert.equal(statusOf(orphan), 'closed', 'orphan should be reconciled to closed');
    assert.match(readLog(), /\[\[2026-05-20-1000-proj-orph\]\] — crashed work/);
    assert.match(readLog(), /no SessionEnd/, 'reconcile marker present');

    // The current session's fresh journal must exist and stay OPEN.
    const files = fs.readdirSync(sessionsDir());
    const current = files.find((f) => f.endsWith('fresh-cu.md') || /fresh/.test(f) || f.includes('-fresh'));
    // Filename suffix is first 8 alphanum of session_id = 'freshcur'
    const cur = files.find((f) => f.includes('freshcur'));
    assert.ok(cur, `current session journal should exist (files: ${files.join(', ')})`);
    assert.equal(statusOf(path.join(sessionsDir(), cur)), 'open', 'current session must remain open');
  });
});

// ---------------------------------------------------------------------------
// Integration — backfill --include-open
// ---------------------------------------------------------------------------

describe('backfill-log-from-sessions --include-open — integration', () => {
  test('closes + logs an open orphan; default mode (no flag) leaves it open', () => {
    writeLog();
    const cfg = path.join(root, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ portRegistry: { [vaultDir]: 27999 }, vaultNames: { [vaultDir]: 'bf-vault' } }), 'utf8');
    const orphan = writeSession('2026-05-20-1000-proj-bf.md', { firstPrompt: 'orphaned by crash', tools: ['Write'] });

    const runBackfill = (extraArgs) => spawnSync(process.execPath, [BACKFILL_PATH, '--vault', vaultDir, ...extraArgs], {
      encoding: 'utf8', timeout: 20000,
      env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: cfg, HOME: path.join(root, 'h'), USERPROFILE: path.join(root, 'h') },
    });

    // Default mode: open session is skipped, stays open, not logged.
    const def = runBackfill([]);
    assert.equal(def.status, 0, def.stderr || def.stdout);
    assert.equal(statusOf(orphan), 'open', 'default mode must not close open sessions');
    assert.doesNotMatch(readLog(), /proj-bf/);

    // --include-open: closes + logs.
    const inc = runBackfill(['--include-open']);
    assert.equal(inc.status, 0, inc.stderr || inc.stdout);
    assert.match(inc.stdout, /open→closed:\s*1/);
    assert.equal(statusOf(orphan), 'closed', '--include-open must close the orphan');
    assert.match(readLog(), /\[\[2026-05-20-1000-proj-bf\]\] — orphaned by crash/);
    assert.match(readLog(), /<!-- backfilled \d{4}-\d{2}-\d{2} -->/);
  });

  test('--include-open --dry-run previews without writing', () => {
    writeLog();
    const cfg = path.join(root, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ portRegistry: { [vaultDir]: 27999 }, vaultNames: { [vaultDir]: 'bf-vault' } }), 'utf8');
    const orphan = writeSession('2026-05-20-1000-proj-bfdry.md', { firstPrompt: 'x' });
    const beforeLog = readLog();
    const r = spawnSync(process.execPath, [BACKFILL_PATH, '--vault', vaultDir, '--include-open', '--dry-run'], {
      encoding: 'utf8', timeout: 20000,
      env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: cfg, HOME: path.join(root, 'h2'), USERPROFILE: path.join(root, 'h2') },
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /DRY-RUN/);
    assert.match(r.stdout, /would reconcile 1 open/);
    assert.equal(statusOf(orphan), 'open', 'dry-run must not close the orphan');
    assert.equal(readLog(), beforeLog, 'dry-run must not write to log.md');
  });
});
