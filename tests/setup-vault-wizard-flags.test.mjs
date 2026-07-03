// W1 — CLI integration for the wizard flags. Spawns setup-vault.mjs as a
// subprocess (importing it runs the CLI), using Node-native temp paths so the
// reference vault resolves correctly. Covers --dry-run/--json plan output,
// plugin profiles, source flags, arg validation, AND a backward-compat proof
// that a plain bootstrap (no wizard flags) still provisions a vault.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'setup-vault.mjs');

function makeReference(workDir) {
  const ref = path.join(workDir, '.template');
  for (const p of ['obsidian-local-rest-api', 'mcp-router-bridge', 'smart-connections']) {
    fs.mkdirSync(path.join(ref, '.obsidian', 'plugins', p), { recursive: true });
    fs.writeFileSync(path.join(ref, '.obsidian', 'plugins', p, 'main.js'), `// ${p}`);
  }
  // REST API plugin needs a data.json (patchRestApiData patches it in place).
  fs.writeFileSync(
    path.join(ref, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'),
    JSON.stringify({ apiKey: 'REF-SECRET-KEY-0000000000', port: 27123 }));
  fs.writeFileSync(
    path.join(ref, '.obsidian', 'community-plugins.json'),
    JSON.stringify(['obsidian-local-rest-api', 'mcp-router-bridge', 'smart-connections', 'dataview']));
  return ref;
}

describe('setup-vault.mjs wizard flags', () => {
  let workDir, ref, cfg;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-flags-'));
    ref = makeReference(workDir);
    cfg = path.join(workDir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ referenceVault: ref, portRegistry: {}, portStart: 27200 }));
  });

  after(() => fs.rmSync(workDir, { recursive: true, force: true }));

  function run(args) {
    return spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: cfg, OBSIDIAN_ROUTER_NO_AUTO_INSTALL_HOOKS: '1' },
    });
  }

  test('--dry-run --json prints a valid plan, recommended picks up source plugins, no mutation', () => {
    const target = path.join(workDir, 'NewVault');
    const r = run([target, '--dry-run', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const plan = JSON.parse(r.stdout);
    assert.equal(plan.slug, 'newvault');
    assert.equal(plan.source.kind, 'reference');
    assert.equal(plan.plugins.profile, 'recommended');
    assert.ok(plan.plugins.resolved.includes('smart-connections'), 'source-enabled plugin in plan');
    assert.ok(plan.plugins.resolved.includes('dataview'));
    assert.ok(Array.isArray(plan.steps) && plan.steps.length > 0);
    assert.ok(!fs.existsSync(target), '--dry-run must not create the target');
  });

  test('--dry-run --json --plugins minimal → REQUIRED only', () => {
    const r = run([path.join(workDir, 'V2'), '--dry-run', '--json', '--plugins', 'minimal']);
    assert.equal(r.status, 0, r.stderr);
    const plan = JSON.parse(r.stdout);
    assert.deepEqual(plan.plugins.resolved, ['obsidian-local-rest-api', 'mcp-router-bridge']);
  });

  test('--dry-run --json --plugins custom:dataview,foo → REQUIRED ∪ custom', () => {
    const r = run([path.join(workDir, 'V3'), '--dry-run', '--json', '--plugins', 'custom:dataview,foo']);
    assert.equal(r.status, 0, r.stderr);
    const plan = JSON.parse(r.stdout);
    assert.equal(plan.plugins.profile, 'custom');
    assert.ok(plan.plugins.resolved.includes('dataview'));
    assert.ok(plan.plugins.resolved.includes('foo'));
    for (const req of ['obsidian-local-rest-api', 'mcp-router-bridge']) assert.ok(plan.plugins.resolved.includes(req));
  });

  test('--dry-run --json --bare → minimal profile', () => {
    const r = run([path.join(workDir, 'V4'), '--dry-run', '--json', '--bare']);
    assert.equal(r.status, 0, r.stderr);
    const plan = JSON.parse(r.stdout);
    assert.equal(plan.plugins.profile, 'minimal');
  });

  test('--dry-run --json --name "My Vault" derives a lowercased slug', () => {
    const r = run([path.join(workDir, 'V5'), '--dry-run', '--json', '--name', 'My Vault']);
    assert.equal(r.status, 0, r.stderr);
    const plan = JSON.parse(r.stdout);
    assert.equal(plan.name, 'My Vault');
    assert.equal(plan.slug, 'my vault');
  });

  test('invalid --plugins value exits non-zero with a clear message', () => {
    const r = run([path.join(workDir, 'V6'), '--dry-run', '--plugins', 'bogus']);
    assert.notEqual(r.status, 0);
    assert.match((r.stdout || '') + (r.stderr || ''), /--plugins must be one of/);
  });

  test('two mutually-exclusive source flags are rejected', () => {
    const r = run([path.join(workDir, 'V7'), '--dry-run', '--bare', '--from-skeleton']);
    assert.notEqual(r.status, 0);
    assert.match((r.stdout || '') + (r.stderr || ''), /Choose one template source/);
  });

  test('BACKWARD COMPAT: a plain bootstrap (no wizard flags) still provisions a vault', () => {
    const target = path.join(workDir, 'PlainBootstrap');
    const r = run([target]);
    assert.equal(r.status, 0, `plain bootstrap must succeed. stderr=${r.stderr}`);
    // Core artifacts the pre-wizard path always produced:
    assert.ok(fs.existsSync(path.join(target, '.env')), '.env written');
    assert.ok(fs.existsSync(path.join(target, '.obsidian', 'plugins', 'smart-connections')), 'source plugin cloned');
    assert.ok(fs.existsSync(path.join(target, 'wiki-meta', 'index.md')), 'wiki-meta scaffolded');
    // Secret regenerated (NOT the reference's key).
    const restData = JSON.parse(fs.readFileSync(
      path.join(target, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'), 'utf8'));
    assert.notEqual(restData.apiKey, 'REF-SECRET-KEY-0000000000', 'fresh API key generated');
    // Backward compat: no --wiki-mode → index.md uses the generic template
    // (has "## Sources", NOT a mode frontmatter).
    const idx = fs.readFileSync(path.join(target, 'wiki-meta', 'index.md'), 'utf8');
    assert.match(idx, /## Sources/, 'default index uses the generic template');
    assert.ok(!/^mode:/m.test(idx), 'no mode frontmatter without --wiki-mode');
  });

  test('--wiki-mode research seeds mode-specific index sections + frontmatter', () => {
    const target = path.join(workDir, 'ResearchVault');
    const r = run([target, '--wiki-mode', 'research']);
    assert.equal(r.status, 0, r.stderr);
    const idx = fs.readFileSync(path.join(target, 'wiki-meta', 'index.md'), 'utf8');
    assert.match(idx, /^mode: research$/m, 'index frontmatter carries the mode');
    assert.match(idx, /## Papers/, 'research section present');
    assert.match(idx, /## Hypotheses/);
    assert.ok(!/## Sources/.test(idx), 'generic template sections replaced');
    const ov = fs.readFileSync(path.join(target, 'wiki-meta', 'overview.md'), 'utf8');
    assert.match(ov, /^mode: research$/m, 'overview frontmatter stamped with mode');
  });

  test('--wiki-mode domain --wiki-sections lays out the given sections', () => {
    const target = path.join(workDir, 'DomainVault');
    const r = run([target, '--wiki-mode', 'domain', '--wiki-sections', 'Reptiles,Habitats,Diets']);
    assert.equal(r.status, 0, r.stderr);
    const idx = fs.readFileSync(path.join(target, 'wiki-meta', 'index.md'), 'utf8');
    for (const s of ['Reptiles', 'Habitats', 'Diets']) assert.match(idx, new RegExp(`## ${s}`));
  });

  test('--name writes a custom slug into config vaultNames', () => {
    const target = path.join(workDir, 'RawName');
    const r = run([target, '--name', 'Pretty Name']);
    assert.equal(r.status, 0, r.stderr);
    const conf = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    assert.equal(conf.vaultNames[path.resolve(target)], 'pretty name');
  });

  test('--name colliding with an existing registered slug fails fast with no side-effects', () => {
    // Register an existing vault under slug "taken", then try to --name a NEW
    // vault "Taken". Must fail BEFORE creating the target dir (early guard).
    const snapshot = fs.readFileSync(cfg, 'utf8'); // restore verbatim afterward
    const existing = path.join(workDir, 'ExistingVault');
    fs.mkdirSync(existing, { recursive: true });
    const conf = JSON.parse(snapshot);
    conf.portRegistry[path.resolve(existing)] = 28000;
    conf.vaultNames = { ...(conf.vaultNames || {}), [path.resolve(existing)]: 'taken' };
    fs.writeFileSync(cfg, JSON.stringify(conf));
    try {
      const target = path.join(workDir, 'CollideTarget');
      const r = run([target, '--name', 'Taken']);
      assert.notEqual(r.status, 0, 'colliding --name must fail');
      assert.match((r.stdout || '') + (r.stderr || ''), /already maps to/i);
      assert.ok(!fs.existsSync(target), 'target dir must not be created on a collision');
    } finally {
      fs.writeFileSync(cfg, snapshot); // exact restore for later tests
    }
  });

  test('--dry-run does NOT create the config file when it is missing', () => {
    // A first-time --dry-run must not write anything — including the config.
    const isolatedCfg = path.join(workDir, 'nested', 'fresh-config.json');
    const r = spawnSync(process.execPath, [SCRIPT, path.join(workDir, 'DryTarget'), '--dry-run', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: isolatedCfg, OBSIDIAN_ROUTER_NO_AUTO_INSTALL_HOOKS: '1' },
    });
    assert.equal(r.status, 0, r.stderr);
    JSON.parse(r.stdout); // valid plan
    assert.ok(!fs.existsSync(isolatedCfg), '--dry-run must not create the config file');
  });

  test('--git-init initializes a git repo in the new vault', () => {
    const target = path.join(workDir, 'GitVault');
    const r = run([target, '--git-init']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(target, '.git')), 'vault has its own git repo');
  });

  test('--probe (no Obsidian running) times out to a red verdict + non-zero exit', () => {
    // No --open here: the port never comes up (Obsidian isn't launched), so the
    // probe must go red and exit non-zero. --probe-timeout 1 keeps it fast.
    const target = path.join(workDir, 'ProbeVault');
    const r = run([target, '--probe', '--probe-timeout', '1']);
    assert.notEqual(r.status, 0, 'red probe must exit non-zero');
    assert.match((r.stdout || '') + (r.stderr || ''), /Probe red/i);
    // The vault itself was still provisioned before the probe ran.
    assert.ok(fs.existsSync(path.join(target, '.env')), 'vault provisioned before probe');
  });

  test('--claude-workspace merges the router plugin into the workspace .claude/settings.json', () => {
    const target = path.join(workDir, 'CCVault');
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ws-'));
    // Pre-existing workspace settings with an unrelated key — must be preserved.
    fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.claude', 'settings.json'), JSON.stringify({ env: { FOO: '1' } }));
    try {
      const r = run([target, '--link-workspace', ws, '--claude-workspace']);
      assert.equal(r.status, 0, r.stderr);
      const s = JSON.parse(fs.readFileSync(path.join(ws, '.claude', 'settings.json'), 'utf8'));
      assert.equal(s.enabledPlugins['obsidian-router@obsidian-mcp-router-marketplace'], true, 'router plugin enabled');
      assert.equal(s.env.FOO, '1', 'pre-existing keys preserved');
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  });
});

describe('setup-vault.mjs --from-vault (config-only copy + security)', () => {
  let workDir, source, cfg;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'from-vault-'));
    // A source vault to copy config FROM: full plugin set + a workspace.json
    // (UI state, must NOT be copied) + a credentialed data.json (secret, must be
    // regenerated) + a root CLAUDE.md (config, copied) + a wiki/ tree with a
    // note (structure only with --with-folder-tree; NO note content copied).
    source = path.join(workDir, 'SourceVault');
    for (const p of ['obsidian-local-rest-api', 'mcp-router-bridge', 'smart-connections']) {
      fs.mkdirSync(path.join(source, '.obsidian', 'plugins', p), { recursive: true });
      fs.writeFileSync(path.join(source, '.obsidian', 'plugins', p, 'main.js'), `// ${p}`);
    }
    fs.writeFileSync(
      path.join(source, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'),
      JSON.stringify({ apiKey: 'SOURCE-VAULT-SECRET-KEY-123', port: 27300 }));
    fs.writeFileSync(
      path.join(source, '.obsidian', 'community-plugins.json'),
      JSON.stringify(['obsidian-local-rest-api', 'mcp-router-bridge', 'smart-connections']));
    fs.writeFileSync(path.join(source, '.obsidian', 'workspace.json'), JSON.stringify({ secret: 'UI-STATE' }));
    // Visual config (config-only, copied) + a theme folder.
    fs.writeFileSync(path.join(source, '.obsidian', 'appearance.json'),
      JSON.stringify({ theme: 'obsidian', cssTheme: 'Cool Theme', accentColor: '#abcdef' }));
    fs.mkdirSync(path.join(source, '.obsidian', 'themes', 'Cool Theme'), { recursive: true });
    fs.writeFileSync(path.join(source, '.obsidian', 'themes', 'Cool Theme', 'theme.css'), '/* theme */');
    // A snippet so cloneSnippets runs — proves appearance is copied BEFORE
    // snippets (the enablement merges into the copied appearance, not over it).
    fs.mkdirSync(path.join(source, '.obsidian', 'snippets'), { recursive: true });
    fs.writeFileSync(path.join(source, '.obsidian', 'snippets', 'src-snippet.css'), '/* snippet */');
    fs.writeFileSync(path.join(source, 'CLAUDE.md'), '# Source conventions');
    fs.mkdirSync(path.join(source, 'wiki', 'People'), { recursive: true });
    fs.mkdirSync(path.join(source, 'wiki', 'Projects', 'Alpha'), { recursive: true });
    fs.writeFileSync(path.join(source, 'wiki', 'People', 'note.md'), '# private note');

    cfg = path.join(workDir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ referenceVault: source, portRegistry: {}, portStart: 27310 }));
  });

  after(() => fs.rmSync(workDir, { recursive: true, force: true }));

  function run(args) {
    return spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: cfg, OBSIDIAN_ROUTER_NO_AUTO_INSTALL_HOOKS: '1' },
    });
  }

  test('copies config, regenerates the secret, excludes workspace.json, no content', () => {
    const target = path.join(workDir, 'CopiedVault');
    const r = run([target, '--from-vault', source, '--with-folder-tree']);
    assert.equal(r.status, 0, r.stderr);

    // Config copied.
    assert.ok(fs.existsSync(path.join(target, '.obsidian', 'plugins', 'smart-connections')), 'plugins cloned');
    assert.ok(fs.existsSync(path.join(target, 'CLAUDE.md')), 'root CLAUDE.md copied');

    // Secret regenerated — the source apiKey must NOT survive.
    const rest = JSON.parse(fs.readFileSync(
      path.join(target, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'), 'utf8'));
    assert.notEqual(rest.apiKey, 'SOURCE-VAULT-SECRET-KEY-123', 'source secret NOT copied');
    assert.notEqual(rest.port, 27300, 'fresh port allocated');

    // Visual config copied (spec Q3): appearance.json + themes/, snippet
    // enablement merged into the copied appearance (cssTheme preserved).
    const app = JSON.parse(fs.readFileSync(path.join(target, '.obsidian', 'appearance.json'), 'utf8'));
    assert.equal(app.cssTheme, 'Cool Theme', 'source cssTheme carried over');
    assert.equal(app.accentColor, '#abcdef', 'source accent carried over');
    assert.ok(Array.isArray(app.enabledCssSnippets) && app.enabledCssSnippets.includes('src-snippet'),
      'snippet enablement merged INTO the copied appearance (copy-before-snippets ordering)');
    assert.ok(fs.existsSync(path.join(target, '.obsidian', 'themes', 'Cool Theme', 'theme.css')), 'theme folder copied');

    // UI state never copied.
    assert.ok(!fs.existsSync(path.join(target, '.obsidian', 'workspace.json')), 'workspace.json excluded');

    // --with-folder-tree: dirs recreated, but NO notes copied.
    assert.ok(fs.existsSync(path.join(target, 'wiki', 'People')), 'folder tree recreated');
    assert.ok(fs.existsSync(path.join(target, 'wiki', 'Projects', 'Alpha')), 'nested folder recreated');
    assert.ok(!fs.existsSync(path.join(target, 'wiki', 'People', 'note.md')), 'no note content copied');

    // Fresh empty scaffolds.
    assert.ok(fs.existsSync(path.join(target, 'wiki-meta', 'index.md')), 'fresh wiki-meta scaffolded');
  });

  test('--from-vault without --with-folder-tree does NOT recreate the wiki tree', () => {
    const target = path.join(workDir, 'CopiedNoTree');
    const r = run([target, '--from-vault', source]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!fs.existsSync(path.join(target, 'wiki', 'People')), 'no folder tree without the flag');
  });

  test('SECURITY: a source missing a REQUIRED plugin fails BEFORE the secret data.json is copied', () => {
    // Build a source that has obsidian-local-rest-api (credentialed, sorts
    // first) but is MISSING mcp-router-bridge (REQUIRED, sorts after). Pre-fix,
    // the clone loop copied the REST data.json then failed → source secret left
    // in the half-built target. The pre-validate must fail with no secret file.
    const badSource = path.join(workDir, 'BadSource');
    fs.mkdirSync(path.join(badSource, '.obsidian', 'plugins', 'obsidian-local-rest-api'), { recursive: true });
    fs.writeFileSync(
      path.join(badSource, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'),
      JSON.stringify({ apiKey: 'LEAK-ME-SECRET', port: 27999 }));
    fs.writeFileSync(path.join(badSource, '.obsidian', 'community-plugins.json'),
      JSON.stringify(['obsidian-local-rest-api']));

    const target = path.join(workDir, 'LeakTarget');
    const r = run([target, '--from-vault', badSource]);
    assert.notEqual(r.status, 0, 'must fail on the missing REQUIRED plugin');
    assert.match((r.stdout || '') + (r.stderr || ''), /Required plugin missing in source/i);
    // No credential file must have been written into the target.
    const leaked = path.join(target, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json');
    assert.ok(!fs.existsSync(leaked), 'source secret data.json must NOT be left in the target');
  });

  test('--plugins custom names a plugin absent from the source → surfaced warning, still exits 0', () => {
    const target = path.join(workDir, 'CustomMissing');
    const r = run([target, '--from-vault', source, '--plugins', 'custom:not-a-real-plugin']);
    assert.equal(r.status, 0, r.stderr);
    assert.match((r.stdout || '') + (r.stderr || ''), /custom: "not-a-real-plugin" is not installed/i);
  });
});
