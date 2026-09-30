// W2 — provision_vault MCP tool + the security gates. Drives the layer-0
// engine for real, enforces the path gate, and is hidden on gated deployments.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { provisionVaultTool } from '../src/tools/provision-vault.mjs';
import { provisionExecOptions, runProvision, runDryRunPlan } from '../src/helpers/vault-wizard-engine.mjs';
import { spawnSync } from 'node:child_process';
import { planVaultTool } from '../src/tools/plan-vault.mjs';
import { _internals } from '../src/index.mjs';

describe('provision_vault tool', () => {
  let workDir, ref, cfg, prevEnv;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-vault-'));
    // Reference vault at workDir/.template → its parent (workDir) is a known
    // vault root, so targets under workDir are allowed by the path gate.
    ref = path.join(workDir, '.template');
    for (const p of ['obsidian-local-rest-api', 'mcp-router-bridge', 'smart-connections']) {
      fs.mkdirSync(path.join(ref, '.obsidian', 'plugins', p), { recursive: true });
      fs.writeFileSync(path.join(ref, '.obsidian', 'plugins', p, 'main.js'), `// ${p}`);
    }
    fs.writeFileSync(path.join(ref, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'),
      JSON.stringify({ apiKey: 'REF-SECRET-KEY', port: 27123 }));
    fs.writeFileSync(path.join(ref, '.obsidian', 'community-plugins.json'),
      JSON.stringify(['obsidian-local-rest-api', 'mcp-router-bridge', 'smart-connections']));
    cfg = path.join(workDir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ referenceVault: ref, portRegistry: {}, portStart: 27400 }));
    prevEnv = process.env.OBSIDIAN_ROUTER_CONFIG;
    process.env.OBSIDIAN_ROUTER_CONFIG = cfg;
  });

  after(() => {
    if (prevEnv === undefined) delete process.env.OBSIDIAN_ROUTER_CONFIG;
    else process.env.OBSIDIAN_ROUTER_CONFIG = prevEnv;
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  test('provisions a vault under a known root + returns port/insecurePort/openUri', async () => {
    const target = path.join(workDir, 'ProvisionedVault');
    const res = await provisionVaultTool({}, { path: target });
    assert.equal(res.ok, true, JSON.stringify(res));
    // The engine writes to the PINNED real path (pin-provision-target.mjs);
    // os.tmpdir() may be an 8.3 short-name spelling (the CI runner's is).
    assert.equal(res.path, fs.realpathSync.native(target));
    assert.equal(res.slug, 'provisionedvault');
    assert.deepEqual(fs.readdirSync(target).filter((n) => n.startsWith('.router-')), [], 'the pin\'s probe is gone once the engine has exited');
    assert.ok(Number.isInteger(res.port) && res.port > 0, 'port allocated');
    assert.equal(res.insecurePort, res.port + 10, 'insecurePort = port + 10');
    assert.match(res.openUri, /^obsidian:\/\/open\?vault=/);
    assert.equal(res.hooksWired, false, 'MCP provision never wires global hooks');
    // Real artifacts on disk.
    assert.ok(fs.existsSync(path.join(target, '.env')));
    assert.ok(fs.existsSync(path.join(target, '.obsidian', 'plugins', 'smart-connections')));
    // Fresh secret (not the reference's).
    const restData = JSON.parse(fs.readFileSync(
      path.join(target, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'), 'utf8'));
    assert.notEqual(restData.apiKey, 'REF-SECRET-KEY');
  });

  test('SECURITY: refuses a target path outside the known vault roots', async () => {
    const outside = path.join(os.tmpdir(), 'wizard-outside-' + process.pid);
    await assert.rejects(
      () => provisionVaultTool({}, { path: outside }),
      /outside all known vault roots/i,
    );
    assert.ok(!fs.existsSync(outside), 'refused target must not be created');
  });

  test('SECURITY: allowOutsideRoots overrides the path gate', async () => {
    const outside = path.join(os.tmpdir(), 'wizard-optin-' + process.pid);
    try {
      const res = await provisionVaultTool({}, { path: outside, allowOutsideRoots: true });
      assert.equal(res.ok, true);
      assert.ok(fs.existsSync(path.join(outside, '.env')));
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('SECURITY (fail-closed): an EMPTY-roots config still refuses an arbitrary path', async () => {
    // review+ W2 IMPORTANT: a config with no referenceVault / no portRegistry
    // has zero known roots → buildProvisionPlan emits NO out-of-roots warning.
    // The gate must still refuse without allowOutsideRoots.
    const emptyCfg = path.join(workDir, 'empty-config.json');
    fs.writeFileSync(emptyCfg, JSON.stringify({ portStart: 27950, portRegistry: {} }));
    // A valid source vault so the ONLY reason to refuse is the empty-roots gate.
    const src = path.join(workDir, 'FailClosedSrc');
    for (const p of ['obsidian-local-rest-api', 'mcp-router-bridge']) {
      fs.mkdirSync(path.join(src, '.obsidian', 'plugins', p), { recursive: true });
      fs.writeFileSync(path.join(src, '.obsidian', 'plugins', p, 'main.js'), '//');
    }
    fs.writeFileSync(path.join(src, '.obsidian', 'community-plugins.json'),
      JSON.stringify(['obsidian-local-rest-api', 'mcp-router-bridge']));
    const target = path.join(os.tmpdir(), 'fail-closed-' + process.pid);
    // Pass the empty config via reg.configPath (overrides the describe's env).
    await assert.rejects(
      () => provisionVaultTool({ configPath: emptyCfg }, { path: target, source: { kind: 'from-vault', fromVault: src } }),
      /outside all known vault roots/i,
    );
    assert.ok(!fs.existsSync(target), 'refused target not created');
  });

  test('--from-vault via provision copies config, regenerates the secret, excludes workspace.json', async () => {
    // Source under workDir so it's a known root.
    const src = path.join(workDir, 'CopySource');
    for (const p of ['obsidian-local-rest-api', 'mcp-router-bridge']) {
      fs.mkdirSync(path.join(src, '.obsidian', 'plugins', p), { recursive: true });
      fs.writeFileSync(path.join(src, '.obsidian', 'plugins', p, 'main.js'), `// ${p}`);
    }
    fs.writeFileSync(path.join(src, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'),
      JSON.stringify({ apiKey: 'SRC-SECRET', port: 27500 }));
    fs.writeFileSync(path.join(src, '.obsidian', 'community-plugins.json'),
      JSON.stringify(['obsidian-local-rest-api', 'mcp-router-bridge']));
    fs.writeFileSync(path.join(src, '.obsidian', 'workspace.json'), JSON.stringify({ ui: 'state' }));

    const target = path.join(workDir, 'CopiedByTool');
    const res = await provisionVaultTool({}, { path: target, source: { kind: 'from-vault', fromVault: src } });
    assert.equal(res.ok, true);
    const restData = JSON.parse(fs.readFileSync(
      path.join(target, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'), 'utf8'));
    assert.notEqual(restData.apiKey, 'SRC-SECRET', 'source secret not copied');
    assert.ok(!fs.existsSync(path.join(target, '.obsidian', 'workspace.json')), 'workspace.json excluded');
  });

  test('name alone composes a path under vaultsRoot and provisions there (decision ergonomie-creation-liaison-vaults §1)', async () => {
    const vaultsRootDir = path.join(workDir, 'name-only-roots');
    fs.mkdirSync(vaultsRootDir, { recursive: true });
    const cfgWithRoot = path.join(workDir, 'config-with-root.json');
    fs.writeFileSync(cfgWithRoot, JSON.stringify({
      referenceVault: ref, portRegistry: {}, portStart: 27600, vaultsRoot: vaultsRootDir,
    }));
    const res = await provisionVaultTool({ configPath: cfgWithRoot }, { name: 'Tartenpion' });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(path.resolve(res.path), path.join(vaultsRootDir, 'tartenpion'));
    assert.ok(fs.existsSync(path.join(vaultsRootDir, 'tartenpion', '.env')));
  });

  test('two --name values folding to the SAME vaultsRoot folder slug: refused, not silently relabeled (regression, found in review)', async () => {
    // slugifyForPath (the folder slug) folds both ' ' and '.' to '-', so "My
    // Vault" and "My.Vault" compose the identical folder — while the
    // vaultNames slug the existing collision guard checks (a bare
    // .toLowerCase(), no folding) sees "my vault" vs "my.vault": genuinely
    // different, so that guard alone cannot see this collision.
    const vaultsRootDir = path.join(workDir, 'slug-fold-roots');
    fs.mkdirSync(vaultsRootDir, { recursive: true });
    const cfgWithRoot = path.join(workDir, 'config-slug-fold.json');
    fs.writeFileSync(cfgWithRoot, JSON.stringify({
      referenceVault: ref, portRegistry: {}, portStart: 27700, vaultsRoot: vaultsRootDir,
    }));
    const first = await provisionVaultTool({ configPath: cfgWithRoot }, { name: 'My Vault' });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.path, path.join(fs.realpathSync.native(vaultsRootDir), 'my-vault'), 'the pinned real path');

    await assert.rejects(
      () => provisionVaultTool({ configPath: cfgWithRoot }, { name: 'My.Vault' }),
      /already registered as vault/,
    );

    // Re-running with the SAME --name (case-insensitive) on the same folder
    // is the legitimate case and must keep working.
    const again = await provisionVaultTool({ configPath: cfgWithRoot }, { name: 'my vault' });
    assert.equal(again.ok, true, JSON.stringify(again));
  });
});

// ---------------------------------------------------------------------------
// The target is PINNED by the real run and judged on its REAL path
// (src/helpers/pin-provision-target.mjs). Each case was MEASURED writing
// outside every known root before the fix (2026-09-23), against this same
// engine. Real runs, in a throwaway directory, HOME redirected into it.
// ---------------------------------------------------------------------------
describe('provision_vault — the target is pinned and judged on its real path (no write outside the roots)', () => {
  let work, known, outside, cfg, saved;
  const isWin = process.platform === 'win32';
  const dirLink = (target, at) => fs.symlinkSync(target, at, isWin ? 'junction' : 'dir');

  before(() => {
    work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'provision-pin-')));
    known = path.join(work, 'known');
    outside = path.join(work, 'OUTSIDE');
    fs.mkdirSync(outside, { recursive: true });
    const ref = path.join(known, '.template');
    for (const p of ['obsidian-local-rest-api', 'mcp-router-bridge']) {
      fs.mkdirSync(path.join(ref, '.obsidian', 'plugins', p), { recursive: true });
      fs.writeFileSync(path.join(ref, '.obsidian', 'plugins', p, 'main.js'), '//');
    }
    fs.writeFileSync(path.join(ref, '.obsidian', 'community-plugins.json'), JSON.stringify(['obsidian-local-rest-api', 'mcp-router-bridge']));
    cfg = path.join(work, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ referenceVault: ref, portRegistry: {}, portStart: 27850 }));
    const home = path.join(work, 'home');
    fs.mkdirSync(home);
    saved = {
      cfg: process.env.OBSIDIAN_ROUTER_CONFIG,
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      HOMEDRIVE: process.env.HOMEDRIVE,
      HOMEPATH: process.env.HOMEPATH,
    };
    process.env.OBSIDIAN_ROUTER_CONFIG = cfg;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    // All four, as the repository's test rules ask: on Windows a home can be
    // derived from HOMEDRIVE + HOMEPATH when USERPROFILE is not consulted.
    process.env.HOMEDRIVE = '';
    process.env.HOMEPATH = home;
  });

  after(() => {
    for (const [k, v] of [
      ['OBSIDIAN_ROUTER_CONFIG', saved.cfg], ['HOME', saved.HOME], ['USERPROFILE', saved.USERPROFILE],
      ['HOMEDRIVE', saved.HOMEDRIVE], ['HOMEPATH', saved.HOMEPATH],
    ]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const list = (d) => (fs.existsSync(d) ? fs.readdirSync(d) : []);

  test('a junction under a known root pointing outside: refused — no vault outside (it used to be created there, key and all)', async () => {
    dirLink(outside, path.join(known, 'alias'));
    await assert.rejects(() => provisionVaultTool({ configPath: cfg }, { path: path.join(known, 'alias', 'V1') }), /outside all known vault roots/);
    assert.deepEqual(list(outside), []);
  });

  test('an existing target whose `.obsidian` is a junction: refused — no plugin or data.json written where it points', async () => {
    const target = path.join(known, 'Existing2');
    fs.mkdirSync(target);
    const obs = path.join(outside, 'obs');
    fs.mkdirSync(obs);
    dirLink(obs, path.join(target, '.obsidian'));
    await assert.rejects(() => provisionVaultTool({ configPath: cfg }, { path: target }), /\.obsidian is a link/);
    assert.deepEqual(list(obs), []);
  });

  test('an existing target holding a DANGLING `.env` link: refused — the API key is not written where it points', async (t) => {
    const target = path.join(known, 'Existing1');
    fs.mkdirSync(target);
    const leaked = path.join(outside, 'leaked.env');
    try { fs.symlinkSync(leaked, path.join(target, '.env'), 'file'); } catch (e) { t.skip(`file symlinks need a privilege here: ${e.code}`); return; }
    await assert.rejects(() => provisionVaultTool({ configPath: cfg }, { path: target }), /\.env is a link/);
    assert.equal(fs.existsSync(leaked), false);
  });

  test('the parent swapped for a junction between the dry-run gate and the real run: refused by the real run', async () => {
    const parent = path.join(known, 'racy');
    fs.mkdirSync(parent);
    const swapped = path.join(outside, 'racy');
    fs.mkdirSync(swapped);
    let swappedOnce = 0;
    await assert.rejects(() => provisionVaultTool({ configPath: cfg }, { path: path.join(parent, 'V3') }, {
      runProvision: async (input, opts) => {
        swappedOnce += 1;
        fs.renameSync(parent, `${parent}-moved`);
        dirLink(swapped, parent);
        return runProvision(input, opts);
      },
    }), /the one the plan approved/);
    assert.equal(swappedOnce, 1, 'the swap happened after the dry-run gate had passed');
    assert.deepEqual(list(swapped), []);
  });

  test('the same swap, the approved target AND roots withheld from the real run: the current-config roots gate refuses it on its own', async () => {
    const parent = path.join(known, 'racy2');
    fs.mkdirSync(parent);
    const swapped = path.join(outside, 'racy2');
    fs.mkdirSync(swapped);
    await assert.rejects(() => provisionVaultTool({ configPath: cfg }, { path: path.join(parent, 'V5') }, {
      runProvision: async (input, opts) => {
        fs.renameSync(parent, `${parent}-moved`);
        dirLink(swapped, parent);
        return runProvision(input, { ...opts, expectedTarget: null, approvedRoots: null });
      },
    }), /outside all known vault roots \[.*\] \(judged on the pinned real path\)/);
    assert.deepEqual(list(swapped), []);
  });

  test('the ROOT itself swapped for a junction right after the dry-run (Codex round 3): refused against the roots the plan was judged on', async () => {
    // The only known root is `soleRoot` (the reference vault's parent). An
    // attacker unable to touch it before the dry-run swaps it just after:
    // the current config then re-resolves the root to where it points, and
    // only the roots FROZEN by the dry-run still say "outside".
    const soleRoot = path.join(work, 'sole-root');
    const ref = path.join(soleRoot, '.template');
    for (const p of ['obsidian-local-rest-api', 'mcp-router-bridge']) {
      fs.mkdirSync(path.join(ref, '.obsidian', 'plugins', p), { recursive: true });
      fs.writeFileSync(path.join(ref, '.obsidian', 'plugins', p, 'main.js'), '//');
    }
    fs.writeFileSync(path.join(ref, '.obsidian', 'community-plugins.json'), JSON.stringify(['obsidian-local-rest-api', 'mcp-router-bridge']));
    const soleCfg = path.join(work, 'config-sole.json');
    fs.writeFileSync(soleCfg, JSON.stringify({ referenceVault: ref, portRegistry: {}, portStart: 27880 }));
    const elsewhere = path.join(outside, 'sole-root');
    fs.cpSync(soleRoot, elsewhere, { recursive: true });
    let swapped = 0;
    await assert.rejects(() => provisionVaultTool({ configPath: soleCfg }, { path: path.join(soleRoot, 'V6') }, {
      runDryRunPlan: async (input, opts) => {
        const plan = await runDryRunPlan(input, opts);
        swapped += 1;
        fs.renameSync(soleRoot, `${soleRoot}-moved`);
        dirLink(elsewhere, soleRoot);
        return plan;
      },
      // Isolate the roots rule: the frozen target alone would refuse this too.
      runProvision: async (input, opts) => runProvision(input, { ...opts, expectedTarget: null }),
    }), /outside the vault roots the plan was judged against/);
    assert.equal(swapped, 1);
    assert.deepEqual(list(elsewhere).filter((n) => n !== '.template'), []);
  });

  test('a junction INSIDE a root re-pointed right after the dry-run (Codex round 3): refused, the target the dry-run judged is the one bound', async () => {
    const a = path.join(known, 'place-a');
    const b = path.join(known, 'place-b');
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    const alias = path.join(known, 'moving-alias');
    dirLink(a, alias);
    await assert.rejects(() => provisionVaultTool({ configPath: cfg }, { path: path.join(alias, 'V7') }, {
      runDryRunPlan: async (input, opts) => {
        const plan = await runDryRunPlan(input, opts);
        fs.unlinkSync(alias);
        dirLink(b, alias);
        return plan;
      },
    }), /the one the plan approved/);
    assert.deepEqual([list(a), list(b)], [[], []]);
  });

  test('a root SPELLED through a junction in the config: provisioning under it works (the dry-run reports the root\'s real path)', async () => {
    const spelled = path.join(work, 'known-by-junction');
    dirLink(known, spelled);
    const spelledCfg = path.join(work, 'config-spelled.json');
    fs.writeFileSync(spelledCfg, JSON.stringify({ referenceVault: path.join(spelled, '.template'), portRegistry: {}, portStart: 27890 }));
    const res = await provisionVaultTool({ configPath: spelledCfg }, { path: path.join(spelled, 'V9') });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.path, path.join(known, 'V9'));
  });

  test('an approved plan_vault preview binds the REAL destination: a junction re-pointed before provision_vault is a plan drift (Codex round 4)', async () => {
    // Same spelling, same steps, same warnings — only where the junction
    // leads changed. Before the seal covered the real target, it passed.
    const a = path.join(known, 'seal-a');
    const b = path.join(known, 'seal-b');
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    const alias = path.join(known, 'seal-alias');
    dirLink(a, alias);
    const preview = await planVaultTool({ configPath: cfg }, { path: path.join(alias, 'V10') });
    assert.match(preview.approvedPlanSha256, /^[0-9a-f]{64}$/);
    fs.unlinkSync(alias);
    dirLink(b, alias);
    await assert.rejects(
      () => provisionVaultTool({ configPath: cfg }, { path: path.join(alias, 'V10'), approvedPlanSha256: preview.approvedPlanSha256 }),
      (err) => err && err.kind === 'plan_drift',
    );
    assert.deepEqual([list(a), list(b)], [[], []]);
  });

  test('an approved preview binds the REAL roots too: a root re-pointed before provision_vault is a plan drift, even when the target stays put', async () => {
    const x = path.join(work, 'roots-x');
    const y = path.join(work, 'roots-y');
    fs.mkdirSync(x);
    fs.mkdirSync(y);
    const spelledRoot = path.join(work, 'roots-alias');
    dirLink(x, spelledRoot);
    const rootsCfg = path.join(work, 'config-roots-move.json');
    fs.writeFileSync(rootsCfg, JSON.stringify({ referenceVault: path.join(known, '.template'), portRegistry: {}, portStart: 27910, vaultsRoot: spelledRoot }));
    const target = path.join(known, 'V12'); // under the reference's parent: never moves
    const preview = await planVaultTool({ configPath: rootsCfg }, { path: target });
    fs.unlinkSync(spelledRoot);
    dirLink(y, spelledRoot);
    await assert.rejects(
      () => provisionVaultTool({ configPath: rootsCfg }, { path: target, approvedPlanSha256: preview.approvedPlanSha256 }),
      (err) => err && err.kind === 'plan_drift',
    );
    assert.equal(fs.existsSync(target), false);
  });

  test('a case-sensitive directory holding `Root` and `root`: a target under `root` is NOT inside the known root `Root` (Codex round 4)', async (t) => {
    const csParent = path.join(work, 'cs');
    fs.mkdirSync(csParent);
    if (isWin) {
      const r = spawnSync('fsutil.exe', ['file', 'setCaseSensitiveInfo', csParent, 'enable'], { encoding: 'utf8' });
      if (r.status !== 0) { t.skip(`cannot turn case sensitivity on here: ${(r.stdout || r.stderr || '').trim()}`); return; }
    }
    const upper = path.join(csParent, 'Root');
    const lower = path.join(csParent, 'root');
    fs.mkdirSync(upper);
    fs.mkdirSync(lower);
    assert.equal(fs.readdirSync(csParent).length, 2, 'two distinct directories, told apart by case only');
    const csCfg = path.join(work, 'config-cs.json');
    fs.writeFileSync(csCfg, JSON.stringify({ referenceVault: path.join(known, '.template'), portRegistry: {}, portStart: 27900, vaultsRoot: upper }));
    await assert.rejects(() => provisionVaultTool({ configPath: csCfg }, { path: path.join(lower, 'V11') }), /outside all known vault roots/);
    assert.deepEqual(list(lower), []);
  });

  test('a dry-run plan that does not report the real target and roots it judged: refused before the real run', async () => {
    let ran = false;
    await assert.rejects(() => provisionVaultTool({ configPath: cfg }, { path: path.join(known, 'V8') }, {
      runDryRunPlan: async (input, opts) => {
        const plan = await runDryRunPlan(input, opts);
        delete plan.context.realRoots;
        return plan;
      },
      runProvision: async () => { ran = true; return {}; },
    }), /did not report the real target and roots/);
    assert.equal(ran, false);
  });

  test('a name-only request whose vaultsRoot changes between the dry-run and the real run: refused, nothing created at either place', async () => {
    const rootA = path.join(known, 'roots-a');
    const rootB = path.join(known, 'roots-b');
    fs.mkdirSync(rootA);
    fs.mkdirSync(rootB);
    const nameCfg = path.join(work, 'config-name.json');
    const write = (vaultsRoot) => fs.writeFileSync(nameCfg, JSON.stringify({
      referenceVault: path.join(known, '.template'), portRegistry: {}, portStart: 27870, vaultsRoot,
    }));
    write(rootA);
    await assert.rejects(() => provisionVaultTool({ configPath: nameCfg }, { name: 'Drifted' }, {
      runProvision: async (input, opts) => { write(rootB); return runProvision(input, opts); },
    }), /the one the plan approved/);
    assert.deepEqual([list(rootA), list(rootB)], [[], []]);
  });

  test('a skeleton run is pinned and checked too: an existing target with a `.obsidian` junction is refused', async () => {
    const target = path.join(known, 'Skeleton1');
    fs.mkdirSync(target);
    const obs = path.join(outside, 'obs-skeleton');
    fs.mkdirSync(obs);
    dirLink(obs, path.join(target, '.obsidian'));
    await assert.rejects(() => provisionVaultTool({ configPath: cfg }, { path: target, source: { kind: 'skeleton' } }), /\.obsidian is a link/);
    assert.deepEqual(list(obs), []);
  });

  test('an existing `.env` hard-linked to a file outside: refused, the outside file keeps its content', async () => {
    const target = path.join(known, 'HardLinked');
    fs.mkdirSync(target);
    const elsewhere = path.join(outside, 'hard.env');
    fs.writeFileSync(elsewhere, 'KEEP=1');
    fs.linkSync(elsewhere, path.join(target, '.env'));
    await assert.rejects(() => provisionVaultTool({ configPath: cfg }, { path: target }), /\.env has 2 names/);
    assert.equal(fs.readFileSync(elsewhere, 'utf8'), 'KEEP=1');
  });

  test('gitInit on a target already holding a `.git` file pointing outside: refused, git never runs against it', async () => {
    const target = path.join(known, 'GitFile');
    fs.mkdirSync(target);
    const repo = path.join(outside, 'repo');
    fs.writeFileSync(path.join(target, '.git'), `gitdir: ${repo}\n`);
    await assert.rejects(() => provisionVaultTool({ configPath: cfg }, { path: target, gitInit: true }), /\.git already exists/);
    assert.equal(fs.existsSync(repo), false);
  });

  test('through a junction pointing INSIDE the roots: allowed, and the engine writes to — and reports — the REAL path', async () => {
    // A spelled path through a junction is not what the probe pins: the
    // junction itself could be re-pointed during the run. The engine must
    // write to the pinned real path.
    const realParent = path.join(known, 'real-parent');
    fs.mkdirSync(realParent);
    dirLink(realParent, path.join(known, 'inner-alias'));
    const res = await provisionVaultTool({ configPath: cfg }, { path: path.join(known, 'inner-alias', 'V4') });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.path, path.join(realParent, 'V4'));
    assert.ok(fs.existsSync(path.join(realParent, 'V4', '.env')));
  });

  test('gitInit still runs with the probe held inside the vault, and neither tracks nor leaves it', async (t) => {
    if (spawnSync('git', ['--version'], { encoding: 'utf8' }).status !== 0) { t.skip('git is not installed here'); return; }
    const target = path.join(known, 'GitVault');
    const res = await provisionVaultTool({ configPath: cfg }, { path: target, gitInit: true });
    assert.equal(res.ok, true, JSON.stringify(res));
    const tracked = spawnSync('git', ['ls-files'], { cwd: target, encoding: 'utf8' });
    assert.equal(tracked.status, 0, tracked.stderr);
    const files = tracked.stdout.split('\n').filter(Boolean);
    assert.ok(files.length > 0, 'git add ran over the vault');
    assert.equal(files.some((f) => f.includes('.router-pin-')), false);
    assert.deepEqual(list(target).filter((n) => n.startsWith('.router-')), []);
  });
});

describe('provision_vault — bindToWorkspace (decision ergonomie-creation-liaison-vaults §1)', () => {
  const okPlan = () => ({
    path: 'C:/VAULTS/x', slug: 'x', name: 'x', source: { kind: 'reference' },
    plugins: { profile: 'recommended', resolved: [] }, theme: null, wikiMode: { mode: 'personal' },
    conventions: null, claudeWorkspace: false, warnings: [], steps: [],
    context: { knownRoots: ['C:/VAULTS'], realTarget: 'C:/VAULTS/x', realRoots: ['C:/VAULTS'] },
  });
  const okResult = () => ({
    code: 0, stdout: '', stderr: '',
    result: { ok: true, kind: 'reference', abs: 'C:/VAULTS/x', slug: 'x', obsidianName: 'x', port: 1, insecurePort: 2, openUri: 'obsidian://x', opened: false, probe: null },
  });
  const registry = { resolveVault: () => ({ name: 'x' }), configPath: null };

  test('bindToWorkspace: true derives linkWorkspace = process.cwd() ONLY for the real run, never for the dry-run/seal computation', async () => {
    // The dry-run must see the SAME input plan_vault would have seen (no
    // resolution) — see tests/plan-seal-integration.test.mjs for why: resolving
    // it before the dry-run/seal made every plan_vault -> provision_vault call
    // with bindToWorkspace:true refuse with a false plan_drift.
    let seenAtPlan, seenAtApply;
    const out = await provisionVaultTool(
      registry,
      { path: 'C:/VAULTS/x', bindToWorkspace: true },
      {
        runDryRunPlan: async (input) => { seenAtPlan = input.linkWorkspace; return okPlan(); },
        runProvision: async (input) => { seenAtApply = input.linkWorkspace; return okResult(); },
      },
    );
    assert.equal(seenAtPlan, undefined, 'the dry-run must not see a resolved linkWorkspace');
    assert.equal(seenAtApply, process.cwd(), 'only the real spawn resolves it');
    // Regression (codex review): the binding must still be VISIBLE in the
    // result, even though it is invisible to the dry-run/seal computation.
    assert.ok(
      out.steps.some((s) => s.includes('bound the current workspace')),
      `bindToWorkspace's effect is not reported in steps: ${JSON.stringify(out.steps)}`,
    );
  });

  test('bindToWorkspace: false (default) — linkWorkspace stays unset, never bound silently', async () => {
    let seen = 'UNTOUCHED';
    await provisionVaultTool(
      registry,
      { path: 'C:/VAULTS/x' },
      { runDryRunPlan: async (input) => { seen = input.linkWorkspace; return okPlan(); }, runProvision: async () => okResult() },
    );
    assert.equal(seen, undefined);
  });

  test('an explicit linkWorkspace always wins over bindToWorkspace', async () => {
    let seen;
    await provisionVaultTool(
      registry,
      { path: 'C:/VAULTS/x', bindToWorkspace: true, linkWorkspace: '/explicit/ws' },
      { runDryRunPlan: async (input) => { seen = input.linkWorkspace; return okPlan(); }, runProvision: async () => okResult() },
    );
    assert.equal(seen, '/explicit/ws');
  });
});

describe('provision_vault — path/vaultPath type validation (regression, found by codex review)', () => {
  // `args.path || args.vaultPath` treats ANY falsy value as absent, not just
  // undefined/''. Before this fix, `path: false` alongside a valid `name`
  // silently fell through to name-composed provisioning instead of refusing
  // the caller's malformed request — the type check downstream never saw it,
  // because it had already been erased by the `||`.
  for (const badPath of [false, 0, {}, ['a']]) {
    test(`rejects path: ${JSON.stringify(badPath)} even when name is also given`, async () => {
      await assert.rejects(
        () => provisionVaultTool({}, { path: badPath, name: 'Tartenpion' }),
        /`path` must be a string/,
      );
    });
  }
  test('rejects a non-string vaultPath the same way', async () => {
    await assert.rejects(
      () => provisionVaultTool({}, { vaultPath: false, name: 'Tartenpion' }),
      /`vaultPath` must be a string/,
    );
  });
});

describe('vault-wizard tools security gate', () => {
  test('all three tools are hidden when OBSIDIAN_ROUTER_USER_ID is set (gated)', () => {
    const { TOOLS, LOCAL_ONLY_TOOL_NAMES, computeExposedTools } = _internals;
    assert.deepEqual(
      [...LOCAL_ONLY_TOOL_NAMES].sort(),
      ['plan_vault', 'provision_vault', 'register_remote_vault'],
    );
    const gated = computeExposedTools(TOOLS, { gated: true }).map((t) => t.name);
    assert.ok(!gated.includes('plan_vault'), 'plan_vault hidden when gated');
    assert.ok(!gated.includes('provision_vault'), 'provision_vault hidden when gated');
    assert.ok(
      !gated.includes('register_remote_vault'),
      'register_remote_vault hidden when gated — MCPHub tenants share one central config.json',
    );
    const open = computeExposedTools(TOOLS, { gated: false }).map((t) => t.name);
    assert.ok(
      open.includes('plan_vault') && open.includes('provision_vault') && open.includes('register_remote_vault'),
      'exposed when not gated',
    );
  });

  test('both tools have a registered handler (drift guard)', () => {
    const { TOOL_HANDLERS } = _internals;
    assert.equal(typeof TOOL_HANDLERS.plan_vault, 'function');
    assert.equal(typeof TOOL_HANDLERS.provision_vault, 'function');
  });

  test('READONLY hides provision_vault (a write tool) but keeps plan_vault', () => {
    const { TOOLS, WRITE_TOOL_NAMES, computeExposedTools } = _internals;
    assert.ok(WRITE_TOOL_NAMES.has('provision_vault'), 'provision_vault is a write tool');
    assert.ok(!WRITE_TOOL_NAMES.has('plan_vault'), 'plan_vault is read-only');
    const ro = computeExposedTools(TOOLS, { readonly: true }).map((t) => t.name);
    assert.ok(!ro.includes('provision_vault'), 'provision_vault hidden in readonly');
    assert.ok(ro.includes('plan_vault'), 'plan_vault still exposed in readonly');
  });

  test('plan_vault declares every exec option the seal folds in — schema symmetry (regression: C3 catch-22)', () => {
    // Bug found live (2026-08-29, session "Configuration vault Obsidian"): a
    // path outside the known vault roots needs allowOutsideRoots:true, but
    // plan_vault's schema didn't declare it (nor open/probe/probeTimeout/
    // gitInit) — an MCP client that only forwards schema-declared properties
    // drops it before planVaultTool ever sees it, so the preview seals
    // `exec.allowOutsideRoots: null` while provision_vault's apply hashes
    // `true` → a caller who genuinely intends the SAME options on both calls
    // gets a systematic plan_drift. Guard the INVARIANT, not the one flagged
    // field: every key provisionExecOptions folds into the seal must be a
    // declared property on BOTH tools, so adding a future exec option without
    // updating plan_vault's schema fails here instead of resurfacing live.
    const { TOOLS } = _internals;
    const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
    const execKeys = Object.keys(provisionExecOptions({}));
    assert.ok(execKeys.length > 0, 'fixture sanity: provisionExecOptions must expose at least one key');
    for (const key of execKeys) {
      assert.ok(
        Object.hasOwn(byName.provision_vault.inputSchema.properties, key),
        `provision_vault must declare exec option "${key}" (sanity check on the fixture list itself)`,
      );
      assert.ok(
        Object.hasOwn(byName.plan_vault.inputSchema.properties, key),
        `plan_vault must declare exec option "${key}" too, or an MCP client can silently drop it before the seal — causing a systematic plan_drift`,
      );
    }
  });
});
