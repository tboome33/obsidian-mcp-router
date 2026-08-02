/**
 * Tests for the v0.65.0 workspace-attach path (roadmap W4):
 *   - the pure helpers (block builder, CLAUDE.md upsert, .gitignore guard,
 *     slug resolution) — imported directly, no I/O beyond a temp dir
 *   - the `--attach` CLI subcommand — spawned, with an isolated router config
 *     and an isolated HOME so the real ~/.claude is never read or written
 *   - the W4.2 regression: standalone `--link-workspace --claude-workspace`
 *     must enable the plugin, because a .env binding without it is inert
 *
 * Spawn strategy mirrors install-hooks.test.mjs.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  resolveSlugToVaultPath,
  knownSlugs,
  buildWorkspaceVaultsBlock,
  upsertWorkspaceClaudeMd,
  appendWorkspaceGitignore,
} from '../scripts/setup-vault.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.resolve(__dirname, '..', 'scripts', 'setup-vault.mjs');
const BIN_PATH = path.resolve(__dirname, '..', 'bin', 'obsidian-mcp-router.mjs');

const PLUGIN_KEY = 'obsidian-router@obsidian-mcp-router-marketplace';

let workDir;

before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-ws-'));
});

after(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A vault dir that satisfies the catalog precondition of the binding. */
function makeVault(root, name, { withCatalog = true } = {}) {
  const p = path.join(root, name);
  fs.mkdirSync(path.join(p, 'wiki-meta'), { recursive: true });
  if (withCatalog) fs.writeFileSync(path.join(p, 'wiki-meta', 'catalog.md'), '# Catalog\n');
  return p;
}

/**
 * A self-contained scenario: temp root, N vaults, an empty workspace, a router
 * config listing the vaults, and an isolated HOME.
 */
function makeScenario({ vaults = ['MYVAULT', 'OTHER'], noCatalogFor = [] } = {}) {
  const root = fs.mkdtempSync(path.join(workDir, 'sc-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const ws = path.join(root, 'myrepo');
  fs.mkdirSync(ws, { recursive: true });

  const portRegistry = {};
  const paths = {};
  let port = 27100;
  for (const v of vaults) {
    const vp = makeVault(root, v, { withCatalog: !noCatalogFor.includes(v) });
    portRegistry[vp] = port;
    paths[v.toLowerCase()] = vp;
    port += 10;
  }
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ portRegistry, vaultNames: {} }, null, 2));

  return { root, ws, home, configPath, paths, portRegistry };
}

function run(sc, args, { cwd = null, script = SCRIPT_PATH } = {}) {
  const res = spawnSync(process.execPath, [script, ...args], {
    cwd: cwd || sc.ws,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: sc.home,
      USERPROFILE: sc.home,
      OBSIDIAN_ROUTER_CONFIG: sc.configPath,
      // Keep the child from colouring output — assertions match plain text.
      NO_COLOR: '1',
    },
  });
  return { ...res, out: `${res.stdout || ''}${res.stderr || ''}` };
}

const readIf = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
const wsFiles = (ws) => ({
  env: readIf(path.join(ws, '.env')),
  settings: readIf(path.join(ws, '.claude', 'settings.json')),
  claudeMd: readIf(path.join(ws, 'CLAUDE.md')),
  gitignore: readIf(path.join(ws, '.gitignore')),
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('resolveSlugToVaultPath / knownSlugs', () => {
  const cfg = {
    portRegistry: { 'C:\\VAULTS\\Alpha': 1, 'C:\\VAULTS\\Beta': 2 },
    vaultNames: { 'C:\\VAULTS\\Beta': 'custom-beta' },
  };

  test('resolves by derived basename slug, case-insensitively', () => {
    assert.equal(resolveSlugToVaultPath(cfg, 'alpha'), 'C:\\VAULTS\\Alpha');
    assert.equal(resolveSlugToVaultPath(cfg, 'ALPHA'), 'C:\\VAULTS\\Alpha');
    assert.equal(resolveSlugToVaultPath(cfg, '  Alpha  '), 'C:\\VAULTS\\Alpha');
  });

  test('honors a vaultNames display override instead of the basename', () => {
    assert.equal(resolveSlugToVaultPath(cfg, 'custom-beta'), 'C:\\VAULTS\\Beta');
    assert.equal(resolveSlugToVaultPath(cfg, 'beta'), null, 'overridden name must not also answer to its basename');
  });

  test('returns null on miss / empty input rather than throwing', () => {
    assert.equal(resolveSlugToVaultPath(cfg, 'ghost'), null);
    assert.equal(resolveSlugToVaultPath(cfg, ''), null);
    assert.equal(resolveSlugToVaultPath(null, 'alpha'), null);
  });

  test('knownSlugs lists every registered slug for error messages', () => {
    assert.deepEqual(knownSlugs(cfg).sort(), ['alpha', 'custom-beta']);
    assert.deepEqual(knownSlugs({}), []);
  });
});

describe('buildWorkspaceVaultsBlock', () => {
  const primary = { slug: 'dedibox', path: 'C:\\VAULTS\\DEDIBOX' };

  test('primary only: no secondary section, no trap warning', () => {
    const b = buildWorkspaceVaultsBlock({ primary });
    assert.match(b, /obsidian-mcp-router:vaults:start/);
    assert.match(b, /obsidian-mcp-router:vaults:end/);
    assert.match(b, /Primary — `dedibox`/);
    assert.doesNotMatch(b, /Secondary/);
    assert.doesNotMatch(b, /The trap/);
  });

  test('secondaries are named with the exact vault: call that reaches them', () => {
    const b = buildWorkspaceVaultsBlock({
      primary,
      secondaries: [{ slug: 'dedibox-hermes', path: 'C:\\VAULTS\\HERMES' }],
    });
    assert.match(b, /Secondary — `dedibox-hermes`/);
    assert.match(b, /vault: "dedibox-hermes"/);
    // The silent-write failure mode is the whole reason the block exists.
    assert.match(b, /The trap/);
  });

  test('every secondary gets its own entry', () => {
    const b = buildWorkspaceVaultsBlock({
      primary,
      secondaries: [
        { slug: 'one', path: '/v/one' },
        { slug: 'two', path: '/v/two' },
      ],
    });
    assert.match(b, /vault: "one"/);
    assert.match(b, /vault: "two"/);
  });
});

describe('upsertWorkspaceClaudeMd', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(workDir, 'md-'));
  });

  const block = (slug) => buildWorkspaceVaultsBlock({ primary: { slug, path: `/v/${slug}` } });

  test('creates CLAUDE.md when absent', () => {
    const res = upsertWorkspaceClaudeMd(dir, block('a'));
    assert.equal(res.created, true);
    assert.equal(res.changed, true);
    assert.match(fs.readFileSync(res.file, 'utf8'), /Primary — `a`/);
  });

  test('appends to an existing CLAUDE.md without touching user content', () => {
    const file = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(file, '# My project\n\nHand-written rules.\n');
    upsertWorkspaceClaudeMd(dir, block('a'));
    const out = fs.readFileSync(file, 'utf8');
    assert.match(out, /# My project/);
    assert.match(out, /Hand-written rules\./);
    assert.match(out, /Primary — `a`/);
  });

  test('replaces the managed block in place, preserving text on both sides', () => {
    const file = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(file, `BEFORE\n\n${block('a')}\n\nAFTER\n`);
    upsertWorkspaceClaudeMd(dir, block('b'));
    const out = fs.readFileSync(file, 'utf8');
    assert.match(out, /^BEFORE/);
    assert.match(out, /AFTER\n$/);
    assert.match(out, /Primary — `b`/);
    assert.doesNotMatch(out, /Primary — `a`/, 'the stale block must be gone, not duplicated');
    assert.equal(out.match(/vaults:start/g).length, 1, 'exactly one managed block');
  });

  test('re-running with an identical block reports no change', () => {
    upsertWorkspaceClaudeMd(dir, block('a'));
    const second = upsertWorkspaceClaudeMd(dir, block('a'));
    assert.equal(second.changed, false);
    assert.equal(second.created, false);
  });
});

describe('appendWorkspaceGitignore', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(workDir, 'gi-'));
  });

  test('creates the file with both guarded entries', () => {
    const res = appendWorkspaceGitignore(dir);
    assert.deepEqual(res.added, ['.env', '.mcp.json']);
    const out = fs.readFileSync(res.file, 'utf8');
    assert.match(out, /^\.env$/m);
    assert.match(out, /^\.mcp\.json$/m);
  });

  test('is idempotent — a second call adds nothing', () => {
    appendWorkspaceGitignore(dir);
    const before = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    const res = appendWorkspaceGitignore(dir);
    assert.deepEqual(res.added, []);
    assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), before);
  });

  test('adds only what is missing, keeping existing rules', () => {
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.env\n');
    const res = appendWorkspaceGitignore(dir);
    assert.deepEqual(res.added, ['.mcp.json']);
    const out = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    assert.match(out, /node_modules\//);
    assert.equal(out.match(/^\.env$/gm).length, 1, '.env must not be duplicated');
  });

  test('tolerates a file with no trailing newline', () => {
    fs.writeFileSync(path.join(dir, '.gitignore'), 'dist/');
    appendWorkspaceGitignore(dir);
    const out = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    assert.match(out, /^dist\/$/m);
    assert.match(out, /^\.env$/m);
  });
});

// ---------------------------------------------------------------------------
// CLI — the happy path
// ---------------------------------------------------------------------------

describe('--attach (CLI)', () => {
  test('does all four workspace writes from the cwd', () => {
    const sc = makeScenario();
    const res = run(sc, ['--attach', 'myvault', '--also', 'other']);
    assert.equal(res.status, 0, res.out);

    const f = wsFiles(sc.ws);
    assert.match(f.env, /OBSIDIAN_ROUTER_DEFAULT_VAULT=myvault/);
    assert.equal(JSON.parse(f.settings).enabledPlugins[PLUGIN_KEY], true);
    assert.match(f.claudeMd, /Primary — `myvault`/);
    assert.match(f.claudeMd, /vault: "other"/);
    assert.match(f.gitignore, /^\.env$/m);
    assert.match(f.gitignore, /^\.mcp\.json$/m);
  });

  test('tells the user the secondary is not auto-loaded', () => {
    const sc = makeScenario();
    const res = run(sc, ['--attach', 'myvault', '--also', 'other']);
    assert.match(res.out, /NOT auto-loaded/);
    assert.match(res.out, /vault: "other"/);
  });

  test('is idempotent — a second identical run changes nothing', () => {
    const sc = makeScenario();
    run(sc, ['--attach', 'myvault', '--also', 'other']);
    const before = wsFiles(sc.ws);
    const res = run(sc, ['--attach', 'myvault', '--also', 'other']);
    assert.equal(res.status, 0, res.out);
    assert.deepEqual(wsFiles(sc.ws), before);
    assert.match(res.out, /already current/);
  });

  test('--workspace targets a directory other than the cwd', () => {
    const sc = makeScenario();
    const other = path.join(sc.root, 'elsewhere');
    fs.mkdirSync(other);
    const res = run(sc, ['--attach', 'myvault', '--workspace', other], { cwd: sc.root });
    assert.equal(res.status, 0, res.out);
    assert.match(readIf(path.join(other, '.env')), /=myvault/);
    assert.equal(readIf(path.join(sc.ws, '.env')), null, 'the default cwd workspace must be untouched');
  });

  test('warns when it rebinds a workspace to a different primary', () => {
    const sc = makeScenario();
    run(sc, ['--attach', 'myvault']);
    const res = run(sc, ['--attach', 'other']);
    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /previously bound to "myvault"/);
    assert.match(wsFiles(sc.ws).env, /=other/);
  });

  test('a slug listed both as primary and --also is ignored once, with a warning', () => {
    const sc = makeScenario();
    const res = run(sc, ['--attach', 'myvault', '--also', 'myvault']);
    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /duplicate/i);
    assert.doesNotMatch(wsFiles(sc.ws).claudeMd, /Secondary/);
  });

  test('the CLAUDE.md block updates when the vault set changes', () => {
    const sc = makeScenario();
    run(sc, ['--attach', 'myvault', '--also', 'other']);
    run(sc, ['--attach', 'myvault']);
    const md = wsFiles(sc.ws).claudeMd;
    assert.doesNotMatch(md, /Secondary/, 'the dropped secondary must disappear from the block');
    assert.equal(md.match(/vaults:start/g).length, 1);
  });
});

// ---------------------------------------------------------------------------
// CLI — opt-outs
// ---------------------------------------------------------------------------

describe('--attach opt-out flags', () => {
  test('--no-plugin skips .claude/settings.json', () => {
    const sc = makeScenario();
    const res = run(sc, ['--attach', 'myvault', '--no-plugin']);
    assert.equal(res.status, 0, res.out);
    const f = wsFiles(sc.ws);
    assert.equal(f.settings, null);
    assert.match(f.env, /=myvault/, 'the other writes still happen');
  });

  test('--no-claude-md skips CLAUDE.md', () => {
    const sc = makeScenario();
    run(sc, ['--attach', 'myvault', '--no-claude-md']);
    assert.equal(wsFiles(sc.ws).claudeMd, null);
  });

  test('--no-gitignore skips .gitignore', () => {
    const sc = makeScenario();
    run(sc, ['--attach', 'myvault', '--no-gitignore']);
    assert.equal(wsFiles(sc.ws).gitignore, null);
  });
});

// ---------------------------------------------------------------------------
// CLI — refusals. Every one of these must leave the workspace untouched.
// ---------------------------------------------------------------------------

describe('--attach refusals', () => {
  test('unknown primary slug: refuses, names the known slugs, writes nothing', () => {
    const sc = makeScenario();
    const res = run(sc, ['--attach', 'ghost']);
    assert.equal(res.status, 1);
    assert.match(res.out, /not in portRegistry/);
    assert.match(res.out, /Known slugs: myvault, other/);
    assert.deepEqual(wsFiles(sc.ws), { env: null, settings: null, claudeMd: null, gitignore: null });
  });

  test('unknown SECONDARY slug refuses before any write — no half-attached workspace', () => {
    const sc = makeScenario();
    const res = run(sc, ['--attach', 'myvault', '--also', 'ghost']);
    assert.equal(res.status, 1);
    assert.match(res.out, /Secondary vault slug "ghost"/);
    assert.equal(wsFiles(sc.ws).env, null, 'the primary must not be bound when a secondary is bogus');
  });

  test('a vault with no wiki-meta/catalog.md is refused (the hooks would skip it silently)', () => {
    const sc = makeScenario({ vaults: ['MYVAULT', 'EMPTY'], noCatalogFor: ['EMPTY'] });
    const res = run(sc, ['--attach', 'empty']);
    assert.equal(res.status, 1);
    assert.match(res.out, /catalog\.md/);
    assert.equal(wsFiles(sc.ws).env, null);
  });

  test('missing slug argument is refused with usage', () => {
    const sc = makeScenario();
    const res = run(sc, ['--attach']);
    assert.equal(res.status, 1);
    assert.match(res.out, /requires a vault slug/);
  });

  test('two positional slugs are refused, pointing at --also', () => {
    const sc = makeScenario();
    const res = run(sc, ['--attach', 'myvault', 'other']);
    assert.equal(res.status, 1);
    assert.match(res.out, /--also/);
  });

  test('--also without a value is refused', () => {
    const sc = makeScenario();
    const res = run(sc, ['--attach', 'myvault', '--also']);
    assert.equal(res.status, 1);
    assert.match(res.out, /--also requires a vault slug/);
  });

  test('an unknown flag is refused rather than silently ignored', () => {
    const sc = makeScenario();
    const res = run(sc, ['--attach', 'myvault', '--turbo']);
    assert.equal(res.status, 1);
    assert.match(res.out, /Unknown flag/);
  });

  test('a nonexistent workspace path is refused', () => {
    const sc = makeScenario();
    const res = run(sc, ['--attach', 'myvault', '--workspace', path.join(sc.root, 'nope')]);
    assert.equal(res.status, 1);
    assert.match(res.out, /does not exist/);
  });

  test('an empty portRegistry is refused with a pointer to bootstrapping', () => {
    const sc = makeScenario();
    fs.writeFileSync(sc.configPath, JSON.stringify({ portRegistry: {}, vaultNames: {} }));
    const res = run(sc, ['--attach', 'myvault']);
    assert.equal(res.status, 1);
    assert.match(res.out, /no vaults in portRegistry/);
  });
});

// ---------------------------------------------------------------------------
// W4.2 regression — the standalone link path must be able to enable the plugin
// ---------------------------------------------------------------------------

describe('--link-workspace --claude-workspace (W4.2)', () => {
  test('writes the plugin toggle, so the .env binding is not inert', () => {
    const sc = makeScenario();
    const res = run(sc, ['--link-workspace', sc.ws, 'myvault', '--claude-workspace']);
    assert.equal(res.status, 0, res.out);
    const f = wsFiles(sc.ws);
    assert.match(f.env, /=myvault/);
    assert.equal(
      JSON.parse(f.settings).enabledPlugins[PLUGIN_KEY],
      true,
      'before v0.65.0 this path wrote .env only and the hooks never ran',
    );
  });

  test('without the flag it still only writes .env, but says the binding is inert', () => {
    const sc = makeScenario();
    const res = run(sc, ['--link-workspace', sc.ws, 'myvault']);
    assert.equal(res.status, 0, res.out);
    assert.equal(wsFiles(sc.ws).settings, null);
    assert.match(res.out, /INERT/);
    assert.match(res.out, /--attach/, 'the advice must point at the one-shot command');
  });
});

// ---------------------------------------------------------------------------
// The published binary must expose --attach: it is the only entry point that
// exists in a workspace where the plugin is not yet enabled.
// ---------------------------------------------------------------------------

describe('bin/obsidian-mcp-router --attach passthrough', () => {
  test('forwards to the setup script and attaches the workspace', () => {
    const sc = makeScenario();
    const res = run(sc, ['--attach', 'myvault'], { script: BIN_PATH });
    assert.equal(res.status, 0, res.out);
    assert.match(wsFiles(sc.ws).env, /=myvault/);
  });

  test('propagates the failure exit code instead of starting the server', () => {
    const sc = makeScenario();
    const res = run(sc, ['--attach', 'ghost'], { script: BIN_PATH });
    assert.equal(res.status, 1);
    assert.match(res.out, /not in portRegistry/);
  });

  test('--help documents the subcommand', () => {
    const sc = makeScenario();
    const res = run(sc, ['--help'], { script: BIN_PATH });
    assert.equal(res.status, 0);
    assert.match(res.out, /--attach <slug>/);
  });
});
