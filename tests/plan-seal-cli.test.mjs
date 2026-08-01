/**
 * C3 sealed preview for the CLI two-phase flows in scripts/setup-vault.mjs:
 *   - --migrate-wiki-meta / --migrate-sessions-to-wiki-meta (single vault)
 *   - --sync-from-github (offline arg-validation only — the apply path downloads
 *     from GitHub, so its seal math is covered by the plan-core unit tests).
 *
 * Migrations are spawn-tested against temp-vault fixtures (matching
 * migrate-wiki-meta.test.mjs): a --dry-run must print an approvedPlanSha256 and
 * mutate nothing; an apply echoing it must migrate; an apply whose vault drifted
 * since the preview must refuse (exit 1) and mutate nothing; a malformed seal
 * must fail fast. Plan-core determinism / drift / vault-binding is unit-tested
 * through the exported helpers.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { migrationPlanCore, syncPlanCore } from '../scripts/setup-vault.mjs';
import { computePlanSeal, verifyPlanSeal, PlanDriftError } from '../src/helpers/plan-seal.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.resolve(__dirname, '..', 'scripts', 'setup-vault.mjs');

let workDir;
before(() => { workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-seal-cli-')); });
after(() => { fs.rmSync(workDir, { recursive: true, force: true }); });

function runScript(...scriptArgs) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...scriptArgs], { encoding: 'utf8', timeout: 30000 });
}
const sealOf = (out) => (out.match(/approvedPlanSha256:\s*([0-9a-f]{64})/) || [])[1] || null;

/** A 'legacy' vault: the 4 scaffolds under wiki/, no wiki-meta/. */
function makeLegacyVault() {
  const vp = fs.mkdtempSync(path.join(workDir, 'legacy-'));
  fs.mkdirSync(path.join(vp, 'wiki'), { recursive: true });
  for (const f of ['hot.md', 'index.md', 'log.md', 'overview.md']) {
    fs.writeFileSync(path.join(vp, 'wiki', f), `# ${f}\n`);
  }
  return vp;
}

function makeSessionsVault() {
  const vp = fs.mkdtempSync(path.join(workDir, 'sessions-'));
  fs.mkdirSync(path.join(vp, 'wiki', 'Sessions'), { recursive: true });
  fs.writeFileSync(path.join(vp, 'wiki', 'Sessions', '2026-01-01-a.md'), 'a\n');
  fs.writeFileSync(path.join(vp, 'wiki', 'Sessions', '2026-01-02-b.md'), 'b\n');
  return vp;
}

const scaffoldsUnderWiki = (vp) =>
  ['hot.md', 'index.md', 'log.md', 'overview.md'].filter((f) => fs.existsSync(path.join(vp, 'wiki', f)));

describe('CLI seal — migrate-wiki-meta', () => {
  test('--dry-run prints a seal and mutates nothing', () => {
    const vp = makeLegacyVault();
    const r = runScript('--migrate-wiki-meta', vp, '--dry-run');
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.ok(sealOf(r.stdout), 'a 64-hex approvedPlanSha256 must be printed');
    assert.equal(scaffoldsUnderWiki(vp).length, 4, 'dry-run must not move anything');
    assert.ok(!fs.existsSync(path.join(vp, 'wiki-meta', 'hot.md')));
  });

  test('apply with the matching seal migrates (unchanged vault)', () => {
    const vp = makeLegacyVault();
    const seal = sealOf(runScript('--migrate-wiki-meta', vp, '--dry-run').stdout);
    const r = runScript('--migrate-wiki-meta', vp, '--approved-plan-sha256', seal);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.equal(scaffoldsUnderWiki(vp).length, 0, 'scaffolds moved out of wiki/');
    assert.ok(fs.existsSync(path.join(vp, 'wiki-meta', 'hot.md')), 'scaffolds now under wiki-meta/');
  });

  test('apply with a stale seal (plan drifted) → refuses a real-but-different migration, moves nothing', () => {
    const vp = makeLegacyVault(); // no CLAUDE.md → claudeMdReplacements: 0
    const staleSeal = sealOf(runScript('--migrate-wiki-meta', vp, '--dry-run').stdout);
    // Drift: a CLAUDE.md referencing wiki/ scaffolds appears — the vault is still
    // 'legacy' (an apply WOULD migrate the 4 scaffolds), but the plan changed
    // (claudeMdReplacements 0 → 1). The seal must refuse rather than run a plan
    // the caller never approved.
    fs.writeFileSync(path.join(vp, 'CLAUDE.md'), 'Read wiki/hot.md first.\n');
    const r = runScript('--migrate-wiki-meta', vp, '--approved-plan-sha256', staleSeal);
    assert.equal(r.status, 1, 'a drifted apply must exit non-zero');
    assert.match((r.stdout + r.stderr), /drift/i);
    assert.equal(scaffoldsUnderWiki(vp).length, 4, 'nothing may move on a drift refusal');
    assert.ok(!fs.existsSync(path.join(vp, 'wiki-meta', 'hot.md')));
  });

  test('malformed seal → fails fast (exit 1) before touching the vault', () => {
    const vp = makeLegacyVault();
    const r = runScript('--migrate-wiki-meta', vp, '--approved-plan-sha256', 'nope');
    assert.equal(r.status, 1);
    assert.match((r.stdout + r.stderr), /Invalid --approved-plan-sha256/);
    assert.equal(scaffoldsUnderWiki(vp).length, 4, 'no mutation on a malformed seal');
  });

  test('the seal value is not mistaken for the vault path', () => {
    const vp = makeLegacyVault();
    const seal = sealOf(runScript('--migrate-wiki-meta', vp, '--dry-run').stdout);
    // Seal flag placed BEFORE the path — the parser must still find the path.
    const r = runScript('--migrate-wiki-meta', '--approved-plan-sha256', seal, vp);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.ok(fs.existsSync(path.join(vp, 'wiki-meta', 'hot.md')));
  });

  test('CLAUDE.md ref drift (same replacement count, different scaffold) → refuses', () => {
    // A count-only seal would miss this: wiki/hot.md → wiki/index.md keeps the
    // count at 1 but rewrites different text. The sealed per-file match list
    // catches it.
    const vp = makeLegacyVault();
    fs.writeFileSync(path.join(vp, 'CLAUDE.md'), 'Read wiki/hot.md first.\n');
    const staleSeal = sealOf(runScript('--migrate-wiki-meta', vp, '--dry-run').stdout);
    fs.writeFileSync(path.join(vp, 'CLAUDE.md'), 'Read wiki/index.md first.\n');
    const r = runScript('--migrate-wiki-meta', vp, '--approved-plan-sha256', staleSeal);
    assert.equal(r.status, 1);
    assert.match((r.stdout + r.stderr), /drift/i);
    assert.equal(scaffoldsUnderWiki(vp).length, 4, 'nothing moved');
  });

  test('the batch form REJECTS --approved-plan-sha256 (never silently ignores it)', () => {
    // The seal binds one vault's plan; the batch form has no single plan to
    // seal, so it must fail loudly rather than migrate the fleet unverified.
    const r = runScript('--migrate-all-wiki-meta', '--approved-plan-sha256', 'nope');
    assert.equal(r.status, 1);
    assert.match((r.stdout + r.stderr), /only supported on the single-vault form/);
  });
});

describe('CLI seal — migrate-sessions-to-wiki-meta', () => {
  test('--dry-run prints a seal; apply with it migrates', () => {
    const vp = makeSessionsVault();
    const seal = sealOf(runScript('--migrate-sessions-to-wiki-meta', vp, '--dry-run').stdout);
    assert.ok(seal, 'a seal must be printed');
    assert.ok(fs.existsSync(path.join(vp, 'wiki', 'Sessions', '2026-01-01-a.md')), 'dry-run mutates nothing');
    const r = runScript('--migrate-sessions-to-wiki-meta', vp, '--approved-plan-sha256', seal);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.ok(fs.existsSync(path.join(vp, 'wiki-meta', 'Sessions', '2026-01-01-a.md')), 'sessions moved under wiki-meta/');
  });

  test('rename manifest drift (a non-.md file dropped in) → refuses', () => {
    // A directory rename moves EVERYTHING; only .md files were in the moved-set.
    // sessionsAllEntries seals the full manifest, so a stray attachment is drift.
    const vp = makeSessionsVault();
    const staleSeal = sealOf(runScript('--migrate-sessions-to-wiki-meta', vp, '--dry-run').stdout);
    fs.writeFileSync(path.join(vp, 'wiki', 'Sessions', 'attachment.bin'), 'x');
    const r = runScript('--migrate-sessions-to-wiki-meta', vp, '--approved-plan-sha256', staleSeal);
    assert.equal(r.status, 1);
    assert.match((r.stdout + r.stderr), /drift/i);
    assert.ok(fs.existsSync(path.join(vp, 'wiki', 'Sessions', '2026-01-01-a.md')), 'nothing moved');
  });

  test('strategy drift (dst dir appeared → rename becomes merge) → refuses, moves nothing', () => {
    const vp = makeSessionsVault(); // dst absent → 'rename' strategy at preview
    const staleSeal = sealOf(runScript('--migrate-sessions-to-wiki-meta', vp, '--dry-run').stdout);
    // Drift: wiki-meta/Sessions/ appears with a non-colliding file — the apply
    // would now MERGE into pre-existing content instead of renaming the dir.
    // Same moved-set, different executed strategy: caught only because strategy
    // is sealed.
    fs.mkdirSync(path.join(vp, 'wiki-meta', 'Sessions'), { recursive: true });
    fs.writeFileSync(path.join(vp, 'wiki-meta', 'Sessions', 'preexisting.md'), 'x\n');
    const r = runScript('--migrate-sessions-to-wiki-meta', vp, '--approved-plan-sha256', staleSeal);
    assert.equal(r.status, 1, 'a strategy drift must exit non-zero');
    assert.match((r.stdout + r.stderr), /drift/i);
    assert.ok(fs.existsSync(path.join(vp, 'wiki', 'Sessions', '2026-01-01-a.md')), 'nothing moved on a drift refusal');
  });
});

describe('CLI seal — sync-from-github (offline validation)', () => {
  test('a malformed --approved-plan-sha256 is rejected before any download', () => {
    // The flag is validated during arg parsing, which precedes the network
    // fetch — so this fails fast with no connectivity.
    const r = runScript('--sync-from-github', 'C:/nonexistent-vault', '--approved-plan-sha256', 'nope');
    assert.equal(r.status, 1);
    assert.match((r.stdout + r.stderr), /Invalid --approved-plan-sha256/);
  });
});

describe('plan cores — determinism, drift, binding', () => {
  test('migrationPlanCore: key-order independent, drift-sensitive, vault-bound', () => {
    const a = { state: 'legacy', status: 'migrated', mode: 'git', scaffoldsMoved: [{ scaffold: 'index.md' }, { scaffold: 'hot.md' }], claudeMdReplacements: 2 };
    const b = { state: 'legacy', status: 'migrated', mode: 'git', scaffoldsMoved: [{ scaffold: 'hot.md' }, { scaffold: 'index.md' }], claudeMdReplacements: 2 };
    const sA = computePlanSeal({ op: 'migrate-wiki-meta', identity: { target: '/v' }, plan: migrationPlanCore('migrate-wiki-meta', a) });
    assert.equal(sA, computePlanSeal({ op: 'migrate-wiki-meta', identity: { target: '/v' }, plan: migrationPlanCore('migrate-wiki-meta', b) }));
    const drift = computePlanSeal({ op: 'migrate-wiki-meta', identity: { target: '/v' }, plan: migrationPlanCore('migrate-wiki-meta', { ...a, claudeMdReplacements: 3 }) });
    assert.notEqual(sA, drift);
    const otherVault = computePlanSeal({ op: 'migrate-wiki-meta', identity: { target: '/OTHER' }, plan: migrationPlanCore('migrate-wiki-meta', a) });
    assert.notEqual(sA, otherVault);
  });

  test('syncPlanCore: archive / force / target-set are all sealed', () => {
    const core = (over = {}) => syncPlanCore({ repo: 'o/r', ref: 'main', force: false, archiveSha256: 'a'.repeat(64), targets: ['/b', '/a'], ...over });
    assert.deepEqual(core().targets, ['/a', '/b'], 'targets sorted for stability');
    const base = computePlanSeal({ op: 'sync-from-github', identity: { repo: 'o/r' }, plan: core() });
    for (const over of [{ archiveSha256: 'b'.repeat(64) }, { force: true }, { targets: ['/a'] }, { ref: 'v1' }]) {
      assert.notEqual(base, computePlanSeal({ op: 'sync-from-github', identity: { repo: 'o/r' }, plan: core(over) }), `drift on ${JSON.stringify(over)}`);
    }
  });

  test('verifyPlanSeal accepts identical, refuses drift for a sync plan', () => {
    const plan = syncPlanCore({ repo: 'o/r', ref: 'main', force: true, archiveSha256: 'c'.repeat(64), targets: ['/v'] });
    const seal = computePlanSeal({ op: 'sync-from-github', identity: { repo: 'o/r' }, plan });
    assert.equal(verifyPlanSeal({ op: 'sync-from-github', identity: { repo: 'o/r' }, plan, approvedPlanSha256: seal }), seal);
    const drifted = syncPlanCore({ repo: 'o/r', ref: 'main', force: true, archiveSha256: 'd'.repeat(64), targets: ['/v'] });
    assert.throws(
      () => verifyPlanSeal({ op: 'sync-from-github', identity: { repo: 'o/r' }, plan: drifted, approvedPlanSha256: seal }),
      PlanDriftError,
    );
  });
});
