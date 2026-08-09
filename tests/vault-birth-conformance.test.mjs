/**
 * BIRTH — a vault that comes out of the scaffolder carries its derived
 * artefacts without any extra gesture.
 *
 * This is an EXECUTION test, not a grep: it spawns the real
 * `scripts/setup-vault.mjs` against a fixture reference vault in a temp
 * directory (same harness as tests/scaffold-wiki-meta.test.mjs), then inspects
 * what actually landed on disk:
 *
 *   - `wiki-meta/search-index.json` present and USABLE (`indexProblem === null`);
 *   - the OKF projections present and marked;
 *   - the projected `wiki/` tree passing the OKF conformance checker with
 *     ZERO error and ZERO warning.
 *
 * Nothing here touches a real vault, and the child process gets its own
 * `OBSIDIAN_ROUTER_CONFIG` plus overridden home variables so it can never read
 * or write the user's router configuration.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { indexProblem, SEARCH_INDEX_PATH, INDEX_VERSION } from '../src/helpers/bm25-index.mjs';
import { PROJECTION_MARKER } from '../src/helpers/okf-projections.mjs';
import { generateProjectionsOnDisk } from '../src/helpers/okf-projections-fs.mjs';
import { checkOkfConformance } from '../src/helpers/okf-conformance-checker.mjs';
// EVERY child spawn here goes through this helper, which refuses a non-throwaway
// HOME — see tests/_home-safe-spawn.mjs. setup-vault.mjs writes
// ~/.claude/settings.json (maybeAutoInstallHooks) at the tail of a bootstrap, so
// a spawn that inherited the real HOME would mutate global config (D1).
import { spawnSyncHomeSafe, homeSafeEnv, assertThrowawayHome } from './_home-safe-spawn.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'setup-vault.mjs');

/** Minimal reference vault: the two plugins `setupVault()` requires. */
function buildReferenceVault(refPath) {
  const restDir = path.join(refPath, '.obsidian', 'plugins', 'obsidian-local-rest-api');
  fs.mkdirSync(restDir, { recursive: true });
  fs.writeFileSync(path.join(restDir, 'data.json'), JSON.stringify({ apiKey: 'fixture-test-key-not-real', port: 27123 }));
  fs.writeFileSync(path.join(restDir, 'main.js'), '// rest-api stub');
  const bridgeDir = path.join(refPath, '.obsidian', 'plugins', 'mcp-router-bridge');
  fs.mkdirSync(bridgeDir, { recursive: true });
  fs.writeFileSync(path.join(bridgeDir, 'main.js'), '// bridge stub');
  fs.writeFileSync(path.join(bridgeDir, 'manifest.json'), JSON.stringify({ id: 'mcp-router-bridge', version: '0.2.0' }));
}

/** Every markdown file under `<vault>/wiki`, as BUNDLE-relative paths. */
function collectWikiDocs(vaultPath) {
  const out = [];
  const root = path.join(vaultPath, 'wiki');
  const rec = (rel) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) rec(child);
      else if (/\.md$/i.test(e.name)) {
        out.push({ path: child, content: fs.readFileSync(path.join(root, ...child.split('/')), 'utf8') });
      }
    }
  };
  rec('');
  return out;
}

describe('birth — a scaffolded vault carries its search index and its projections', () => {
  let workDir;
  let referenceVault;
  let targetVault;
  let configPath;
  let fakeHome;
  let firstRun;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-birth-'));
    referenceVault = path.join(workDir, '.template');
    targetVault = path.join(workDir, 'newborn');
    configPath = path.join(workDir, 'config.json');
    fakeHome = path.join(workDir, 'home');
    fs.mkdirSync(fakeHome, { recursive: true });

    buildReferenceVault(referenceVault);
    fs.writeFileSync(
      configPath,
      JSON.stringify({ referenceVault, portRegistry: {}, portStart: 27400 }, null, 2),
    );

    firstRun = spawnSyncHomeSafe(process.execPath, [SCRIPT_PATH, targetVault], {
      homeDir: fakeHome,
      env: { OBSIDIAN_ROUTER_CONFIG: configPath },
    });
  });

  after(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  test('the scaffolder exits clean', () => {
    assert.equal(firstRun.status, 0, `expected exit 0, got ${firstRun.status}. stderr=${firstRun.stderr}`);
  });

  test('wiki-meta/search-index.json exists and is a USABLE index', () => {
    const abs = path.join(targetVault, ...SEARCH_INDEX_PATH.split('/'));
    assert.ok(fs.existsSync(abs), `${SEARCH_INDEX_PATH} must exist after provisioning`);
    const index = JSON.parse(fs.readFileSync(abs, 'utf8'));
    assert.equal(index.version, INDEX_VERSION);
    assert.equal(indexProblem(index), null, 'the newborn index must pass its own shape + integrity checks');
  });

  test('the OKF projections exist and carry the generated marker', () => {
    const rootIndex = fs.readFileSync(path.join(targetVault, 'wiki', 'index.md'), 'utf8');
    const log = fs.readFileSync(path.join(targetVault, 'wiki', 'log.md'), 'utf8');
    assert.ok(rootIndex.includes(`> ${PROJECTION_MARKER}`), 'root index must be marked');
    assert.ok(log.includes(`> ${PROJECTION_MARKER}`), 'log must be marked');
  });

  test('the projected wiki/ passes OKF conformance with zero error and zero warning', () => {
    const result = checkOkfConformance(collectWikiDocs(targetVault));
    assert.deepEqual(result.errors, [], `unexpected OKF errors: ${JSON.stringify(result.errors)}`);
    assert.deepEqual(result.warnings, [], `unexpected OKF warnings: ${JSON.stringify(result.warnings)}`);
    assert.equal(result.conformant, true);
  });

  test('the CLI says what it built', () => {
    const out = `${firstRun.stdout}${firstRun.stderr}`;
    assert.match(out, /search index built \(\d+ chunks?/i, 'the operator must be told the index was BUILT, with its size');
  });

  test('re-running the scaffolder rewrites neither index (idempotent)', () => {
    const indexAbs = path.join(targetVault, ...SEARCH_INDEX_PATH.split('/'));
    const rootIndexAbs = path.join(targetVault, 'wiki', 'index.md');
    const indexBefore = fs.readFileSync(indexAbs);
    const rootBefore = fs.readFileSync(rootIndexAbs);

    // D1: this second run MUST carry the same throwaway HOME as the first, or
    // its tail-of-bootstrap maybeAutoInstallHooks writes the REAL
    // ~/.claude/settings.json.
    const second = spawnSyncHomeSafe(process.execPath, [SCRIPT_PATH, targetVault], {
      homeDir: fakeHome,
      env: { OBSIDIAN_ROUTER_CONFIG: configPath },
    });
    assert.equal(second.status, 0, `expected exit 0, got ${second.status}. stderr=${second.stderr}`);

    assert.deepEqual(fs.readFileSync(indexAbs), indexBefore, 'search index must be byte-identical');
    assert.deepEqual(fs.readFileSync(rootIndexAbs), rootBefore, 'root projection must be byte-identical');
  });
});

// ---------------------------------------------------------------------------
// D1 — the class guard. A scaffold spawn writes ~/.claude/settings.json
// (maybeAutoInstallHooks). This proves the redirected HOME actually CAPTURES
// that write into a throwaway directory, so a spawn that forgot the override
// (writing the real home) is caught behaviourally, not by inspection.
// ---------------------------------------------------------------------------

describe('D1 — the home-safe spawn helper REFUSES the real home at the call site', () => {
  test('assertThrowawayHome throws for the real home, passes a temp dir', () => {
    assert.throws(() => assertThrowawayHome(os.homedir()), /real home/i);
    assert.throws(() => assertThrowawayHome(''), /required/i);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'home-safe-'));
    try {
      assert.equal(assertThrowawayHome(tmp), path.resolve(tmp));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('homeSafeEnv points all four HOME vars at the throwaway dir', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'home-safe-'));
    try {
      const env = homeSafeEnv(tmp, { FOO: 'bar' });
      assert.equal(env.HOME, path.resolve(tmp));
      assert.equal(env.USERPROFILE, path.resolve(tmp));
      assert.equal(env.HOMEPATH, path.resolve(tmp));
      assert.equal(env.HOMEDRIVE, '');
      assert.equal(env.FOO, 'bar');
      assert.notEqual(path.resolve(env.HOME), path.resolve(os.homedir()));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('D1 — a scaffold spawn writes its settings.json UNDER the redirected home', () => {
  let workDir;
  let referenceVault;
  let targetVault;
  let configPath;
  let freshHome;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-birth-home-'));
    referenceVault = path.join(workDir, '.template');
    targetVault = path.join(workDir, 'newborn');
    configPath = path.join(workDir, 'config.json');
    // A FRESH, EMPTY home: maybeAutoInstallHooks finds no settings.json, so it
    // adds every router hook and WRITES the file — the observable side effect.
    freshHome = path.join(workDir, 'home');
    fs.mkdirSync(freshHome, { recursive: true });

    buildReferenceVault(referenceVault);
    fs.writeFileSync(configPath, JSON.stringify({ referenceVault, portRegistry: {}, portStart: 27600 }, null, 2));
  });

  after(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  test('the child hook-install lands in the throwaway home, never the real one', () => {
    const settingsUnderFreshHome = path.join(freshHome, '.claude', 'settings.json');
    assert.equal(fs.existsSync(settingsUnderFreshHome), false, 'fixture sanity: the throwaway home starts empty');

    const run = spawnSyncHomeSafe(process.execPath, [SCRIPT_PATH, targetVault], {
      homeDir: freshHome,
      env: { OBSIDIAN_ROUTER_CONFIG: configPath },
    });
    assert.equal(run.status, 0, `expected exit 0, got ${run.status}. stderr=${run.stderr}`);

    // The whole point: the child's home-dependent write was CAPTURED by the
    // redirected HOME. If a spawn dropped the override, this file would land in
    // the developer's real ~/.claude instead and this assertion would fail —
    // which is exactly what the D1 mutation demonstrates.
    assert.equal(
      fs.existsSync(settingsUnderFreshHome), true,
      'setup-vault wrote settings.json OUTSIDE the throwaway home — a spawn is inheriting the real HOME',
    );
  });
});

// ---------------------------------------------------------------------------
// F2 — birth and first contact must write the SAME root-index title.
//
// The disk generator defaults its H1 to `path.basename(vaultPath)` (the
// on-disk case), but the REST refresh at first contact uses the REGISTRY SLUG,
// which is `basename.toLowerCase()`. When the basename is not already all
// lowercase the two titles differ, so the very first session rewrites
// `wiki/index.md` — a superfluous write on a vault the docs call "born
// conformant". Birth must stamp the same title the registry will.
// ---------------------------------------------------------------------------

describe('F2 — a mixed-case vault is born with the title first contact will keep', () => {
  let workDir;
  let referenceVault;
  let mixedVault;
  let configPath;
  let run;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-birth-case-'));
    referenceVault = path.join(workDir, '.template');
    // A basename with genuine mixed case — the whole point.
    mixedVault = path.join(workDir, 'MixedCaseVault');
    configPath = path.join(workDir, 'config.json');
    const fakeHome = path.join(workDir, 'home');
    fs.mkdirSync(fakeHome, { recursive: true });

    buildReferenceVault(referenceVault);
    fs.writeFileSync(configPath, JSON.stringify({ referenceVault, portRegistry: {}, portStart: 27500 }, null, 2));

    run = spawnSyncHomeSafe(process.execPath, [SCRIPT_PATH, mixedVault], {
      homeDir: fakeHome,
      env: { OBSIDIAN_ROUTER_CONFIG: configPath },
    });
  });

  after(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  test('scaffolder exits clean', () => {
    assert.equal(run.status, 0, `expected exit 0, got ${run.status}. stderr=${run.stderr}`);
  });

  test('the first REST contact has NO projection work to do (no superfluous rewrite)', () => {
    // The registry slug the router will resolve this vault by.
    const slug = path.basename(mixedVault).toLowerCase();
    assert.notEqual(slug, path.basename(mixedVault), 'fixture sanity: the basename must actually have mixed case');

    // Exactly what the first contact computes: a dry-run refresh keyed on the
    // slug. If birth stamped a different title, this plan rewrites wiki/index.md.
    const plan = generateProjectionsOnDisk(mixedVault, { apply: false, vaultName: slug });

    assert.deepEqual(
      plan.written, [],
      'first contact would rewrite these projections — birth used a different title than the registry slug',
    );
    assert.deepEqual(plan.deleted, []);
  });

  test('the birth root index already carries the slug-cased title', () => {
    const slug = path.basename(mixedVault).toLowerCase();
    const rootIndex = fs.readFileSync(path.join(mixedVault, 'wiki', 'index.md'), 'utf8');
    assert.match(rootIndex, new RegExp(`^# ${slug}$`, 'm'), 'the H1 must be the slug, not the mixed-case basename');
  });
});
