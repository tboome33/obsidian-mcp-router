/**
 * Tests for src/helpers/plugin-cache-purge.mjs — reclaiming the plugin cache
 * the auto-update has been growing since v0.14.
 *
 * The whole risk here is deleting a directory something still needs, so the
 * tests are written around the three ways that happens: the manifest still
 * names it, a running process is still serving from it, or the plan drifted
 * between preview and apply. Each has a test that DELETES SOMETHING REAL
 * from a fixture cache and asserts what survived — a test that only checked
 * the plan's shape would pass while the apply removed the wrong tree.
 *
 * The process scan is injected (`scan`), so liveness can be driven exactly
 * instead of depending on what happens to be running on the machine.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  planCachePurge, applyCachePurge, listCachedVersions, findLiveSnapshotVersions,
  referencedVersions, directorySize, cacheDirFor, normalizePathKey, isSafeSegment,
  formatBytes, renderPurgePlan, PURGE_OP,
} from '../src/helpers/plugin-cache-purge.mjs';
import { computePlanSeal } from '../src/helpers/plan-seal.mjs';

const MARKETPLACE = 'obsidian-mcp-router-marketplace';
const PLUGIN = 'obsidian-router';
const TMP = [];

after(() => {
  for (const d of TMP) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/**
 * Build a fake HOME with a plugin cache.
 *
 * `installed` is the version(s) installed_plugins.json points at; `versions`
 * are the directories that exist on disk. The two differ on purpose — that
 * gap is the whole problem.
 */
function makeHome({ versions = ['0.1.0', '0.2.0'], installed = ['0.2.0'], settingsVersions = [], noManifest = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'c8-cache-'));
  TMP.push(home);
  const cache = cacheDirFor({ homeDir: home, marketplace: MARKETPLACE, plugin: PLUGIN });
  for (const v of versions) {
    fs.mkdirSync(path.join(cache, v, 'src'), { recursive: true });
    fs.writeFileSync(path.join(cache, v, 'package.json'), JSON.stringify({ version: v }));
    fs.writeFileSync(path.join(cache, v, 'src', 'index.mjs'), 'x'.repeat(100));
  }
  fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
  if (!noManifest) {
    fs.writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          [`${PLUGIN}@${MARKETPLACE}`]: installed.map((v) => ({
            scope: 'user', installPath: path.join(cache, v), version: v,
          })),
        },
      }, null, 2));
  }
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
    hooks: settingsVersions.map((v) => ({ command: `node ${path.join(cache, v, 'hooks', 'h.mjs')}` })),
  }, null, 2));
  return { home, cache };
}

/** A process scan that reports the given versions as live. */
function scanReporting(cache, versions) {
  return () => ({
    status: 0,
    stdout: versions.map((v) => `node ${path.join(cache, v, 'src', 'index.mjs')} --stdio`).join('\n')
      + '\nsome unrelated process\n',
  });
}

const scanNothingLive = (cache) => scanReporting(cache, []);
const scanBroken = () => ({ status: 1, stdout: '' });

function planFor(fixture, over = {}) {
  return planCachePurge({
    homeDir: fixture.home, marketplace: MARKETPLACE, plugin: PLUGIN,
    scan: scanNothingLive(fixture.cache), platform: 'linux',
    ...over,
  });
}

const purgedVersions = (plan) => plan.purge.map((p) => p.version).sort();
const keptVersions = (plan) => plan.keep.map((k) => k.version).sort();

// ---------------------------------------------------------------------------

describe('what the purge protects', () => {
  test('the newest version and the N-1 rollback are always kept', () => {
    const f = makeHome({ versions: ['0.1.0', '0.2.0', '0.3.0'], installed: ['0.3.0'] });
    const plan = planFor(f, { currentVersion: '0.3.0' });
    assert.deepEqual(keptVersions(plan), ['0.2.0', '0.3.0']);
    assert.deepEqual(purgedVersions(plan), ['0.1.0']);
    const rollback = plan.keep.find((k) => k.version === '0.2.0');
    assert.ok(rollback.reasons.some((r) => /rollback/.test(r)));
  });

  test('keepPrevious: 0 is REFUSED — the rollback snapshot is not negotiable', () => {
    // This test used to assert the OPPOSITE: that keepPrevious:0 deleted the
    // N-1 snapshot "when asked". It pinned a violation of the module's own
    // stated rule, and made a one-flag mistake enough to destroy the only
    // way back from a bad release.
    const f = makeHome({ versions: ['0.1.0', '0.2.0', '0.3.0'], installed: ['0.3.0'] });
    for (const bad of [0, -1, 1.5, 'two', null]) {
      const plan = planFor(f, { currentVersion: '0.3.0', keepPrevious: bad });
      assert.equal(plan.blocked, true, `keepPrevious=${JSON.stringify(bad)} should be refused`);
      assert.deepEqual(plan.purge, []);
    }
  });

  test('the rollback snapshot is the predecessor of the CURRENT version, not of the newest on disk', () => {
    // They differ exactly when it matters: after a rollback the running
    // version is no longer the highest directory present. Anchoring to the
    // newest would protect the release just backed away from, and offer up
    // the predecessor of the one actually in use.
    const f = makeHome({ versions: ['0.1.0', '0.2.0', '0.3.0', '0.4.0'], installed: ['0.3.0'] });
    const plan = planFor(f, { currentVersion: '0.3.0' });
    assert.ok(keptVersions(plan).includes('0.2.0'), renderPurgePlan(plan));
    assert.deepEqual(purgedVersions(plan), ['0.1.0']);
  });

  test('a version the MANIFEST still names is kept even when it is old', () => {
    // installed_plugins.json can hold several scoped entries; an old one
    // pinned by a project-scope install is live by definition.
    const f = makeHome({ versions: ['0.1.0', '0.2.0', '0.3.0'], installed: ['0.3.0', '0.1.0'] });
    const plan = planFor(f, { currentVersion: '0.3.0' });
    assert.ok(!purgedVersions(plan).includes('0.1.0'), renderPurgePlan(plan));
    assert.ok(plan.keep.find((k) => k.version === '0.1.0')
      .reasons.some((r) => /installed_plugins\.json/.test(r)));
  });

  test('a version a HOOK PATH in settings.json names is kept', () => {
    const f = makeHome({ versions: ['0.1.0', '0.2.0', '0.3.0'], installed: ['0.3.0'], settingsVersions: ['0.1.0'] });
    const plan = planFor(f, { currentVersion: '0.3.0' });
    assert.ok(!purgedVersions(plan).includes('0.1.0'), renderPurgePlan(plan));
  });

  test('a version a RUNNING PROCESS is serving from is kept', () => {
    // The trap this whole module exists for. A session that started before
    // an update stays pinned to its snapshot; the manifest has already
    // moved on. Measured on a real machine while writing this: one node
    // process was serving 0.65.0 while the manifest named only 0.66.1.
    const f = makeHome({ versions: ['0.1.0', '0.2.0', '0.3.0', '0.4.0'], installed: ['0.4.0'] });
    const plan = planCachePurge({
      homeDir: f.home, marketplace: MARKETPLACE, plugin: PLUGIN,
      currentVersion: '0.4.0', platform: 'linux',
      scan: scanReporting(f.cache, ['0.1.0']),
    });
    assert.ok(!purgedVersions(plan).includes('0.1.0'), renderPurgePlan(plan));
    assert.ok(plan.keep.find((k) => k.version === '0.1.0')
      .reasons.some((r) => /running process/.test(r)));
    assert.deepEqual(purgedVersions(plan), ['0.2.0']);
  });

  test('the snapshot THIS process runs from is kept', () => {
    const f = makeHome({ versions: ['0.1.0', '0.2.0', '0.3.0'], installed: ['0.3.0'] });
    const plan = planFor(f, { currentVersion: '0.3.0', pluginRoot: path.join(f.cache, '0.1.0') });
    assert.ok(!purgedVersions(plan).includes('0.1.0'), renderPurgePlan(plan));
  });
});

describe('fail-closed: uncertainty never becomes deletion', () => {
  test('a FAILED process scan blocks the purge entirely', () => {
    // Reclaiming disk is worth far less than never breaking a live session,
    // so "I could not tell what is running" must mean "purge nothing".
    const f = makeHome({ versions: ['0.1.0', '0.2.0', '0.3.0'], installed: ['0.3.0'] });
    const plan = planFor(f, { currentVersion: '0.3.0', scan: scanBroken });
    assert.equal(plan.blocked, true);
    assert.deepEqual(plan.purge, []);
    assert.match(plan.blockedReason, /cannot determine which snapshots are in use/);
    assert.match(renderPurgePlan(plan), /REFUSING TO PURGE/);
  });

  test('an EMPTY process listing counts as a failed scan, not as "nothing runs"', () => {
    // This very process would appear in a real listing. Empty means the
    // scan did not work.
    const f = makeHome();
    const plan = planFor(f, { scan: () => ({ status: 0, stdout: '   \n' }) });
    assert.equal(plan.blocked, true);
  });

  test('a scan that THROWS blocks rather than propagating', () => {
    const f = makeHome();
    const plan = planFor(f, { scan: () => { throw new Error('spawn ENOENT'); } });
    assert.equal(plan.blocked, true);
    assert.match(plan.blockedReason, /spawn ENOENT/);
  });

  test('a missing installed_plugins.json blocks the purge', () => {
    const f = makeHome({ noManifest: true });
    const plan = planFor(f);
    assert.equal(plan.blocked, true);
    assert.match(plan.blockedReason, /refusing to purge without knowing what is installed/);
  });

  test('an absent or empty cache is nothing to do, not an error', () => {
    const f = makeHome({ versions: [], installed: [] });
    const plan = planFor(f);
    assert.equal(plan.blocked, false);
    assert.deepEqual(plan.purge, []);
  });

  test('a cache dir that exists but cannot be READ blocks', () => {
    // Absent means "nothing there"; unreadable means "something is there and
    // I cannot see it" — only the second is a reason to refuse.
    const f = makeHome({ versions: ['0.1.0', '0.2.0'], installed: ['0.2.0'] });
    const listing = listCachedVersions(path.join(f.cache, '0.1.0', 'package.json'));
    assert.equal(listing.ok, false);
    assert.match(listing.error, /cannot read cache dir/);
  });

  test('a non-semver directory and a stray file are IGNORED, never candidates', () => {
    const f = makeHome({ versions: ['0.1.0', '0.2.0', '0.3.0'], installed: ['0.3.0'] });
    fs.mkdirSync(path.join(f.cache, 'scratch'));
    fs.writeFileSync(path.join(f.cache, 'notes.txt'), 'x');
    const plan = planFor(f, { currentVersion: '0.3.0' });
    assert.deepEqual(purgedVersions(plan), ['0.1.0']);
    assert.deepEqual(plan.ignored.map((i) => i.name).sort(), ['notes.txt', 'scratch']);
  });
});

describe('preview → sealed apply', () => {
  test('a preview writes nothing', () => {
    const f = makeHome({ versions: ['0.1.0', '0.2.0', '0.3.0'], installed: ['0.3.0'] });
    planFor(f, { currentVersion: '0.3.0' });
    assert.deepEqual(fs.readdirSync(f.cache).sort(), ['0.1.0', '0.2.0', '0.3.0']);
  });

  test('an apply with the previewed seal removes exactly the previewed set', () => {
    const f = makeHome({ versions: ['0.1.0', '0.2.0', '0.3.0', '0.4.0'], installed: ['0.4.0'] });
    const common = {
      homeDir: f.home, marketplace: MARKETPLACE, plugin: PLUGIN,
      currentVersion: '0.4.0', platform: 'linux', scan: scanNothingLive(f.cache),
    };
    const plan = planCachePurge(common);
    assert.deepEqual(purgedVersions(plan), ['0.1.0', '0.2.0']);
    const result = applyCachePurge({ ...common, approvedPlanSha256: plan.approvedPlanSha256 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.removed.map((r) => r.version).sort(), ['0.1.0', '0.2.0']);
    // The survivors are what matters, and they are checked ON DISK.
    assert.deepEqual(fs.readdirSync(f.cache).sort(), ['0.3.0', '0.4.0']);
    assert.ok(result.freedBytes > 0);
  });

  test('an apply with a STALE seal refuses, and deletes nothing', () => {
    const f = makeHome({ versions: ['0.1.0', '0.2.0', '0.3.0'], installed: ['0.3.0'] });
    const common = {
      homeDir: f.home, marketplace: MARKETPLACE, plugin: PLUGIN,
      currentVersion: '0.3.0', platform: 'linux', scan: scanNothingLive(f.cache),
    };
    const plan = planCachePurge(common);
    assert.deepEqual(purgedVersions(plan), ['0.1.0']);
    // A new version lands between preview and apply — the plan drifted.
    fs.mkdirSync(path.join(f.cache, '0.4.0'), { recursive: true });
    fs.writeFileSync(path.join(f.cache, '0.4.0', 'package.json'), '{"version":"0.4.0"}');
    assert.throws(
      () => applyCachePurge({ ...common, approvedPlanSha256: plan.approvedPlanSha256 }),
      /plan|seal|drift/i,
    );
    assert.ok(fs.existsSync(path.join(f.cache, '0.1.0')), 'nothing may be removed on drift');
  });

  test('a snapshot that goes LIVE between preview and apply aborts the whole purge', () => {
    // The precise race the seal exists for: someone opens a session from
    // 0.1.0 after the preview listed it. It must not be deleted under them,
    // and the abort must be total rather than partial.
    const f = makeHome({ versions: ['0.1.0', '0.2.0', '0.3.0', '0.4.0'], installed: ['0.4.0'] });
    const base = {
      homeDir: f.home, marketplace: MARKETPLACE, plugin: PLUGIN,
      currentVersion: '0.4.0', platform: 'linux',
    };
    const plan = planCachePurge({ ...base, scan: scanNothingLive(f.cache) });
    assert.deepEqual(purgedVersions(plan), ['0.1.0', '0.2.0']);
    assert.throws(() => applyCachePurge({
      ...base,
      scan: scanReporting(f.cache, ['0.1.0']),
      approvedPlanSha256: plan.approvedPlanSha256,
    }), /plan|seal|drift/i);
    assert.deepEqual(fs.readdirSync(f.cache).sort(), ['0.1.0', '0.2.0', '0.3.0', '0.4.0']);
  });

  test('a SYMLINKED version directory is never a candidate, and its target survives', () => {
    // The module's flagship containment claim — "symlinks are NOT followed
    // and never become candidates" — had NO test. Deleting the
    // `isSymbolicLink()` branch left the suite green, so nothing stood
    // between a planted link and a recursive delete outside the cache.
    const f = makeHome({ versions: ['0.1.0', '0.2.0', '0.3.0'], installed: ['0.3.0'] });
    const victim = fs.mkdtempSync(path.join(os.tmpdir(), 'c8-victim-'));
    TMP.push(victim);
    fs.writeFileSync(path.join(victim, 'precious.txt'), 'do not delete me');
    let linked = false;
    try {
      // 'junction' works without elevation on Windows; 'dir' on POSIX.
      fs.symlinkSync(victim, path.join(f.cache, '0.0.5'),
        process.platform === 'win32' ? 'junction' : 'dir');
      linked = true;
    } catch { /* unprivileged environment — assertion below is skipped */ }
    if (!linked) return;

    const common = {
      homeDir: f.home, marketplace: MARKETPLACE, plugin: PLUGIN,
      currentVersion: '0.3.0', platform: 'linux', scan: scanNothingLive(f.cache),
    };
    const plan = planCachePurge(common);
    assert.ok(!purgedVersions(plan).includes('0.0.5'), renderPurgePlan(plan));
    assert.ok(plan.ignored.some((i) => i.name === '0.0.5' && /symlink/.test(i.why)),
      JSON.stringify(plan.ignored));

    applyCachePurge({ ...common, approvedPlanSha256: plan.approvedPlanSha256 });
    assert.ok(fs.existsSync(path.join(victim, 'precious.txt')),
      'a purge must never reach through a link and delete outside the cache');
  });

  test('an apply refuses outright when the plan is blocked', () => {
    const f = makeHome({ versions: ['0.1.0', '0.2.0'], installed: ['0.2.0'] });
    const result = applyCachePurge({
      homeDir: f.home, marketplace: MARKETPLACE, plugin: PLUGIN,
      currentVersion: '0.2.0', platform: 'linux', scan: scanBroken,
      approvedPlanSha256: 'a'.repeat(64),
    });
    assert.equal(result.blocked, true);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(fs.readdirSync(f.cache).sort(), ['0.1.0', '0.2.0']);
  });

  test('one cache\'s seal cannot authorize a purge of another', () => {
    // Comparing two generated hashes proved nothing: that assertion would
    // still have passed if applyCachePurge had stopped verifying seals
    // altogether. Feed A's seal to B and check what survives ON DISK.
    const a = makeHome({ versions: ['0.1.0', '0.2.0', '0.3.0'], installed: ['0.3.0'] });
    const b = makeHome({ versions: ['0.1.0', '0.2.0', '0.3.0'], installed: ['0.3.0'] });
    const planA = planFor(a, { currentVersion: '0.3.0' });
    assert.ok(planA.purge.length > 0);
    assert.throws(() => applyCachePurge({
      homeDir: b.home, marketplace: MARKETPLACE, plugin: PLUGIN,
      currentVersion: '0.3.0', platform: 'linux', scan: scanNothingLive(b.cache),
      approvedPlanSha256: planA.approvedPlanSha256,
    }), /plan|seal|drift/i);
    assert.deepEqual(fs.readdirSync(b.cache).sort(), ['0.1.0', '0.2.0', '0.3.0']);
  });

  test('the seal ignores directory SIZE, which wobbles on its own', () => {
    const f = makeHome({ versions: ['0.1.0', '0.2.0'], installed: ['0.2.0'] });
    const before = planFor(f, { currentVersion: '0.2.0', keepPrevious: 0 }).approvedPlanSha256;
    fs.writeFileSync(path.join(f.cache, '0.1.0', 'npm-debug.log'), 'y'.repeat(5000));
    const after = planFor(f, { currentVersion: '0.2.0', keepPrevious: 0 }).approvedPlanSha256;
    assert.equal(before, after, 'a purge that refused because a log file grew would be useless');
  });
});

describe('discovery and reporting units', () => {
  test('listCachedVersions sorts by semver, not lexically', () => {
    const f = makeHome({ versions: ['0.9.0', '0.10.0', '0.2.0'], installed: ['0.10.0'] });
    const { versions } = listCachedVersions(f.cache);
    assert.deepEqual(versions.map((v) => v.version), ['0.2.0', '0.9.0', '0.10.0']);
  });

  test('listCachedVersions treats an ABSENT cache as empty, not as a failure', () => {
    const r = listCachedVersions(path.join(os.tmpdir(), 'definitely-not-here-c8'));
    assert.equal(r.ok, true);
    assert.deepEqual(r.versions, []);
  });

  test('findLiveSnapshotVersions survives mixed separators and drive-letter case', () => {
    const f = makeHome({ versions: ['0.1.0'], installed: ['0.1.0'] });
    const weird = f.cache.replace(/\\/g, '/').toUpperCase() + '/0.1.0/src/index.mjs';
    const r = findLiveSnapshotVersions({
      cacheDir: f.cache, platform: 'win32',
      scan: () => ({ status: 0, stdout: `"C:\\Program Files\\node.exe" ${weird}\n` }),
    });
    assert.equal(r.ok, true);
    assert.deepEqual([...r.versions], ['0.1.0']);
  });

  test('referencedVersions reads JSON-escaped Windows paths', () => {
    const f = makeHome({ versions: ['0.1.0', '0.2.0'], installed: ['0.2.0'] });
    const file = path.join(f.home, '.claude', 'plugins', 'installed_plugins.json');
    const found = referencedVersions({ files: [file], cacheDir: f.cache });
    assert.ok(found.has('0.2.0'));
  });

  test('directorySize measures real bytes, and reports a partial read AS partial', () => {
    // The old version asserted `partial === false` and never exercised a
    // partial read at all — it proved nothing about the flag it named.
    const f = makeHome({ versions: ['0.1.0'], installed: ['0.1.0'] });
    const whole = directorySize(path.join(f.cache, '0.1.0'));
    assert.ok(whole.bytes >= 100);
    assert.equal(whole.partial, false);
    const missing = directorySize(path.join(f.cache, 'no-such-dir'));
    assert.equal(missing.bytes, 0);
    assert.equal(missing.partial, true);
  });

  test('an existing-but-unreadable manifest BLOCKS the purge', () => {
    // Silently skipping it is how a purge deletes a version the manifest
    // still names.
    const f = makeHome({ versions: ['0.1.0', '0.2.0', '0.3.0'], installed: ['0.3.0'] });
    const manifest = path.join(f.home, '.claude', 'plugins', 'installed_plugins.json');
    fs.rmSync(manifest);
    fs.mkdirSync(manifest); // a directory where a file is expected → EISDIR on read
    const plan = planFor(f, { currentVersion: '0.3.0' });
    assert.equal(plan.blocked, true, renderPurgePlan(plan));
    assert.deepEqual(plan.purge, []);
  });

  test('a version named only by a manifest `version` field is protected', () => {
    // The text scan misses a relative or aliased installPath; the structural
    // pass catches the version regardless of how the path was spelled.
    const f = makeHome({ versions: ['0.1.0', '0.2.0', '0.3.0'], installed: ['0.3.0'] });
    const manifest = path.join(f.home, '.claude', 'plugins', 'installed_plugins.json');
    fs.writeFileSync(manifest, JSON.stringify({
      version: 2,
      plugins: { 'obsidian-router@obsidian-mcp-router-marketplace': [
        { scope: 'user', installPath: './relative/elsewhere', version: '0.1.0' },
      ] },
    }));
    const plan = planFor(f, { currentVersion: '0.3.0' });
    assert.ok(!purgedVersions(plan).includes('0.1.0'), renderPurgePlan(plan));
  });

  test('normalizePathKey folds case ONLY where the filesystem does', () => {
    // Unconditional lowercasing aliases two genuinely distinct POSIX paths,
    // which would let one cache's seal identity collide with another's.
    assert.equal(normalizePathKey('C:\\Users\\X', 'win32'), 'c:/users/x');
    assert.equal(normalizePathKey('/home/u/Cache', 'linux'), '/home/u/Cache');
    assert.notEqual(
      normalizePathKey('/home/u/Cache', 'linux'),
      normalizePathKey('/home/u/cache', 'linux'),
    );
  });

  test('formatBytes is readable at every scale', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.match(formatBytes(900 * 1024 * 1024), /MB$/);
  });

  test('the operation tag actually participates in the seal', () => {
    // Asserting PURGE_OP === 'plugin-cache-purge' proved only that a
    // constant held a string. What matters is that the tag is MIXED IN, so
    // a seal minted for a different sealed operation cannot be replayed here.
    const f = makeHome({ versions: ['0.1.0', '0.2.0', '0.3.0'], installed: ['0.3.0'] });
    const plan = planFor(f, { currentVersion: '0.3.0' });
    const foreign = computePlanSeal({
      op: 'some-other-operation',
      identity: { cacheDir: plan.sealIdentity },
      plan: { purge: plan.purge.map((p) => p.version), keep: plan.keep.map((k) => k.version) },
    });
    assert.notEqual(foreign, plan.approvedPlanSha256);
    assert.throws(() => applyCachePurge({
      homeDir: f.home, marketplace: MARKETPLACE, plugin: PLUGIN,
      currentVersion: '0.3.0', platform: 'linux', scan: scanNothingLive(f.cache),
      approvedPlanSha256: foreign,
    }), /plan|seal|drift/i);
    assert.ok(fs.existsSync(path.join(f.cache, '0.1.0')));
  });

  test('a marketplace or plugin name with separators is refused before anything is read', () => {
    // path.join swallows `..` happily, producing a lexically valid "cache
    // dir" pointing at the home directory — and the direct-child check
    // before deletion is relative to that already-escaped root.
    const f = makeHome();
    for (const bad of ['../..', 'a/b', 'a\\b', '..', '']) {
      const plan = planCachePurge({
        homeDir: f.home, marketplace: bad, plugin: PLUGIN,
        platform: 'linux', scan: scanNothingLive(f.cache),
      });
      assert.equal(plan.blocked, true, `marketplace=${JSON.stringify(bad)} should be refused`);
      assert.match(plan.blockedReason, /single path segment/);
    }
  });
});
