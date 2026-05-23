/**
 * Tests for the v0.11.4 extension of hooks/check-router-update.mjs:
 * new-hooks tips (purely local; doesn't need GitHub).
 *
 * Strategy: spawn the hook with isolated HOME pointing at a temp dir +
 * a pre-populated cache file. The hook will:
 *   1. List local hooks/ (real, from repo) → currentHooks
 *   2. Read cache file → cached.snapshotHooks
 *   3. Diff → newAndNotWired
 *   4. Read ~/.claude/settings.json from isolated HOME → filter wired
 *   5. Emit tip if anything remains
 *
 * We control the cache file (= what was "snapshotted last time") and
 * the settings.json (= which hooks are wired) via the isolated HOME.
 *
 * Note: the hook also tries to fetch GitHub for the version check. To
 * avoid flakiness, we DON'T set OBSIDIAN_ROUTER_NO_UPDATE_CHECK (which
 * would early-exit), but we accept that the version notice may or may
 * not appear depending on network. Tests focus on the TIP portion.
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
const HOOK_PATH = path.resolve(__dirname, '..', 'hooks', 'check-router-update.mjs');

let workDir;

before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-update-tips-'));
});

after(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/**
 * Run the hook with isolated HOME + a pre-populated cache + optional
 * settings.json. Returns { status, stdout, stderr, cacheAfter }.
 *
 * `snapshotHooks`: simulated previous snapshot (or null = first run).
 * `wiredHooks`: hook basenames (with .mjs) to mark as already wired in
 *               ~/.claude/settings.json.
 */
function runHook({
  snapshotHooks = null,
  wiredHooks = [],
  installedVersion = '0.11.4',
  checkedAtAgeMs = 25 * 60 * 60 * 1000, // 25h old → past TTL, will re-check
} = {}) {
  const home = fs.mkdtempSync(path.join(workDir, 'home-'));
  const cacheDir = path.join(home, '.claude', 'obsidian-mcp-router');
  fs.mkdirSync(cacheDir, { recursive: true });
  const cacheFile = path.join(cacheDir, '.last-version-check.json');

  if (snapshotHooks !== null) {
    fs.writeFileSync(cacheFile, JSON.stringify({
      checkedAt: Date.now() - checkedAtAgeMs,
      notice: null,
      installedAtCheck: installedVersion,
      snapshotHooks,
    }, null, 2));
  }

  if (wiredHooks.length > 0) {
    const settingsDir = path.join(home, '.claude');
    fs.mkdirSync(settingsDir, { recursive: true });
    const settings = {
      hooks: {
        Stop: [{
          matcher: '',
          hooks: wiredHooks.map((h) => ({
            type: 'command',
            command: `node "/router/hooks/${h}"`,
          })),
        }],
      },
    };
    fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify(settings, null, 2));
  }

  const result = spawnSync(process.execPath, [HOOK_PATH], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      // Disable version check via env: we ONLY want to exercise the tip
      // logic without depending on the network. The tip logic runs
      // BEFORE the GitHub fetch, but with OBSIDIAN_ROUTER_NO_UPDATE_CHECK
      // the hook early-exits → tip not emitted either.
      // Workaround: don't set the env; accept that the hook will try to
      // reach GitHub. The tip is computed and emitted via finishWithoutFetch
      // when GitHub is unreachable (offline / timeout) — which usually
      // happens in CI sandboxes.
      // To make tests deterministic, set a bogus URL via... actually
      // PACKAGE_JSON_URL is hardcoded. Trade-off: accept best-effort.
    },
    timeout: 10000,
  });

  let cacheAfter = null;
  try {
    cacheAfter = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch { /* cache may not have been written */ }

  return { ...result, cacheAfter, homePath: home };
}

// ---------------------------------------------------------------------------
// Snapshot + tip logic
// ---------------------------------------------------------------------------

describe('check-router-update — snapshot + tip logic', () => {
  test('first run: no snapshot → no tip, snapshot stored', () => {
    const r = runHook({ snapshotHooks: null });
    assert.equal(r.status, 0, r.stderr);
    // No tip should be in stdout (first run, no diff possible)
    assert.doesNotMatch(r.stdout, /new router hook\(s\) available/);
    // Snapshot should be stored with current local hooks
    assert.ok(r.cacheAfter, 'cache should be written');
    assert.ok(Array.isArray(r.cacheAfter.snapshotHooks), 'snapshotHooks array stored');
    assert.ok(r.cacheAfter.snapshotHooks.length > 0, 'real hooks listed');
  });

  test('snapshot matches current → no tip', () => {
    // Get real local hooks list
    const localHooks = fs.readdirSync(path.join(__dirname, '..', 'hooks'))
      .filter((f) => f.endsWith('.mjs')).sort();
    const r = runHook({ snapshotHooks: localHooks });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /new router hook\(s\) available/);
  });

  test('snapshot missing a hook → tip emitted for that hook', () => {
    // Simulate previous snapshot that didn't include vault-link-linter.
    // The diff = vault-link-linter (and possibly others if they were
    // also missing). We deliberately pretend only ONE hook is missing.
    const localHooks = fs.readdirSync(path.join(__dirname, '..', 'hooks'))
      .filter((f) => f.endsWith('.mjs')).sort();
    const fakePrevious = localHooks.filter((h) => h !== 'vault-link-linter.mjs');
    const r = runHook({ snapshotHooks: fakePrevious });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /new router hook\(s\) available/);
    assert.match(r.stdout, /vault-link-linter/);
    assert.match(r.stdout, /--install-hooks --select vault-link-linter/);
  });

  test('new hook already wired → no tip for it', () => {
    const localHooks = fs.readdirSync(path.join(__dirname, '..', 'hooks'))
      .filter((f) => f.endsWith('.mjs')).sort();
    const fakePrevious = localHooks.filter((h) => h !== 'vault-link-linter.mjs');
    // The user has ALREADY wired vault-link-linter manually
    const r = runHook({
      snapshotHooks: fakePrevious,
      wiredHooks: ['vault-link-linter.mjs'],
    });
    assert.equal(r.status, 0, r.stderr);
    // No tip should mention vault-link-linter since it's already active
    assert.doesNotMatch(r.stdout, /new router hook\(s\) available/);
  });

  test('multiple new hooks → tip lists them all + select uses comma', () => {
    const localHooks = fs.readdirSync(path.join(__dirname, '..', 'hooks'))
      .filter((f) => f.endsWith('.mjs')).sort();
    const fakePrevious = localHooks.filter(
      (h) => h !== 'vault-link-linter.mjs' && h !== 'doc-propagation-checker.mjs',
    );
    const r = runHook({ snapshotHooks: fakePrevious });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /2 new router hook\(s\) available/);
    assert.match(r.stdout, /vault-link-linter/);
    assert.match(r.stdout, /doc-propagation-checker/);
    // Comma-separated --select
    assert.match(r.stdout, /--install-hooks --select [\w,-]+,[\w,-]+/);
  });

  test('cache snapshot updated after run (next run sees no new hooks)', () => {
    const localHooks = fs.readdirSync(path.join(__dirname, '..', 'hooks'))
      .filter((f) => f.endsWith('.mjs')).sort();
    const r = runHook({ snapshotHooks: null });
    assert.equal(r.status, 0);
    // Snapshot in cache should equal current local hooks
    assert.deepEqual(r.cacheAfter.snapshotHooks.sort(), localHooks);
  });

  test('opt-out OBSIDIAN_ROUTER_NO_UPDATE_CHECK silences tips too', () => {
    const localHooks = fs.readdirSync(path.join(__dirname, '..', 'hooks'))
      .filter((f) => f.endsWith('.mjs')).sort();
    const fakePrevious = localHooks.filter((h) => h !== 'vault-link-linter.mjs');
    const home = fs.mkdtempSync(path.join(workDir, 'home-'));
    const cacheDir = path.join(home, '.claude', 'obsidian-mcp-router');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, '.last-version-check.json'),
      JSON.stringify({
        checkedAt: Date.now() - 25 * 60 * 60 * 1000,
        snapshotHooks: fakePrevious,
        installedAtCheck: '0.11.4',
      }),
    );

    const r = spawnSync(process.execPath, [HOOK_PATH], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        OBSIDIAN_ROUTER_NO_UPDATE_CHECK: 'true',
      },
      timeout: 10000,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '', 'no output when opt-out is set');
  });
});
