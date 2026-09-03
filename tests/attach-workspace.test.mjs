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

import { canonicalWorkspaceKey } from '../src/helpers/workspace-bindings.mjs';
import { acquireLock, lockPathFor } from '../src/helpers/file-lock.mjs';

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

describe('GUARD — every writer of config.json goes through the lock and the atomic writer', () => {
  test('saveConfig takes the config lock and writes atomically; no bare writeFileSync targets CONFIG_PATH', () => {
    // Round 2 of the Codex review, pass A's first BLOCKER: `saveConfig` was a
    // bare `writeFileSync` of the whole file. `updateConfigBindings` took a
    // lock and called itself "the one writer" — but a lock only one of two
    // writers takes is not a lock: setup reads config A, a session confirms
    // binding B under the lock, setup saves stale A, B is gone. The same
    // ordering loses an API-key edit. Pinned on the source, because the race
    // itself cannot be reproduced deterministically in a test.
    const src = fs.readFileSync(SCRIPT_PATH, 'utf8');
    const body = src.slice(src.indexOf('function saveConfig('), src.indexOf('function backupConfigFile('));
    assert.ok(body.length > 0, 'saveConfig found');
    assert.match(body, /acquireLock\(lockPathFor\(CONFIG_PATH, 'config'\)\)/, 'the SAME lock family as the binding writer');
    assert.match(body, /writeFileAtomicSync\(CONFIG_PATH,/, 'atomic, so a crash never leaves half a config');
    assert.doesNotMatch(body, /fs\.writeFileSync/, 'no bare write of the config');
    assert.match(body, /finally \{\s*\n\s*release\(\);/, 'released on every exit path');
    // And nothing ELSE in the script writes CONFIG_PATH directly.
    const direct = [...src.matchAll(/fs\.writeFileSync\(\s*CONFIG_PATH\b/g)];
    assert.equal(direct.length, 0, 'every config write goes through saveConfig');
  });
});

describe('--link-workspace / --unlink-workspace — the binding, not only the hint', () => {
  test('--link-workspace RECORDS THE BINDING, which is the half that decides', () => {
    // `docs/features/13` said this command "records the binding in
    // workspaceBindings (which is what decides) and writes
    // OBSIDIAN_ROUTER_DEFAULT_VAULT into the .env (a portable hint)". Only the
    // second half was true: since the binding registry landed, the router
    // REPORTS a project file's hint and does not apply it — so
    // `--link-workspace` linked nothing at all, and the documentation
    // described a behaviour the code had stopped having. One of the two had to
    // move, and it is the code: this is a command the user typed, which is
    // exactly what a confirmation is. Found in the final review, 2026-09-03.
    const sc = makeScenario();
    const res = run(sc, ['--link-workspace', sc.ws, 'myvault'], { cwd: sc.root });
    assert.equal(res.status, 0, res.out);

    const cfg = JSON.parse(fs.readFileSync(sc.configPath, 'utf8'));
    const entry = cfg.workspaceBindings?.[canonicalWorkspaceKey(sc.ws)];
    assert.ok(entry, `no binding under ${canonicalWorkspaceKey(sc.ws)}`);
    assert.equal(entry.vault, 'myvault');
    assert.equal(entry.confirmedVia, 'link-workspace', 'the human reading this config later');
    // And the portable hint is still written — the two are not alternatives.
    assert.match(wsFiles(sc.ws).env, /OBSIDIAN_ROUTER_DEFAULT_VAULT=myvault/);
  });

  test('re-linking to the SAME vault keeps its lock; pointing elsewhere drops it', () => {
    const sc = makeScenario();
    const key = canonicalWorkspaceKey(sc.ws);
    const cfg = JSON.parse(fs.readFileSync(sc.configPath, 'utf8'));
    cfg.workspaceBindings = { [key]: { vault: 'myvault', also: ['other'], locked: true, confirmedVia: 'tool' } };
    fs.writeFileSync(sc.configPath, JSON.stringify(cfg, null, 2));

    run(sc, ['--link-workspace', sc.ws, 'myvault'], { cwd: sc.root });
    let entry = JSON.parse(fs.readFileSync(sc.configPath, 'utf8')).workspaceBindings[key];
    assert.equal(entry.locked, true, 'same vault: the lock survives');
    assert.deepEqual(entry.also, ['other'], 'and so do the secondaries');

    run(sc, ['--link-workspace', sc.ws, 'other'], { cwd: sc.root });
    entry = JSON.parse(fs.readFileSync(sc.configPath, 'utf8')).workspaceBindings[key];
    assert.equal(entry.vault, 'other');
    assert.equal(entry.locked, false, 'a different vault: the lock belonged to the old one');
    // AND THE SECONDARIES GO WITH IT. Checking only `vault` and `locked` left
    // the `also` branch unpinned, so a mutation keeping the previous primary's
    // secondaries — or the previous primary itself — stayed green. Unlike
    // `lock_vault`, `--link-workspace` names ONE vault and means exactly that
    // one: it is the command for "this project goes with this vault", so the
    // old vault's companions do not follow. (Codex, round 5.)
    assert.deepEqual(entry.also, [], 'the previous vault companions do not follow it');
  });

  test('--link-workspace FAILS LOUDLY when the binding cannot be recorded', () => {
    // It used to warn and exit 0, printing "Linked workspace" for a command
    // that had linked nothing at all: the `.env` line it did write is a hint
    // the router reports and does not apply. The user walks away believing the
    // attachment exists, which is the worst available outcome. (Codex, round 5.)
    const sc = makeScenario();
    // The config must READ fine and fail to WRITE — a directory in its place
    // fails at the read instead, which is a different error on a different
    // line. Holding the inter-process config lock is the one way to produce
    // exactly "cannot write" on every platform: the child waits, gives up, and
    // `updateConfigBindings` refuses rather than clobbering the holder.
    const release = acquireLock(lockPathFor(sc.configPath, 'config'), { waitMs: 0 });
    assert.ok(release, 'the test must actually hold the lock');
    let res;
    try {
      res = run(sc, ['--link-workspace', sc.ws, 'myvault'], { cwd: sc.root });
    } finally {
      release();
    }
    assert.notEqual(res.status, 0, 'a command that did not do its job must not exit 0');
    assert.match(res.out, /nothing is attached until the binding is recorded/);
    // And the workspace really is unbound, which is what the exit code says.
    const cfg = JSON.parse(fs.readFileSync(sc.configPath, 'utf8'));
    assert.equal(cfg.workspaceBindings?.[canonicalWorkspaceKey(sc.ws)], undefined);
  });

  test('--unlink-workspace REMOVES the binding, and the workspace stays unbound afterwards', () => {
    // Removing only the dotenv line left the workspace bound in the user's own
    // config while this command reported the link gone and told them to
    // restart "so the hooks stop loading the previously-associated vault" —
    // after which the binding loaded it again, making the advice look like a
    // bug in the hooks. It also records the workspace as considered, so the
    // one-time import cannot read a leftover hint and re-create what the user
    // just removed.
    const sc = makeScenario();
    const key = canonicalWorkspaceKey(sc.ws);
    run(sc, ['--link-workspace', sc.ws, 'myvault'], { cwd: sc.root });
    assert.ok(JSON.parse(fs.readFileSync(sc.configPath, 'utf8')).workspaceBindings[key]);

    const res = run(sc, ['--unlink-workspace', sc.ws], { cwd: sc.root });
    assert.equal(res.status, 0, res.out);
    const cfg = JSON.parse(fs.readFileSync(sc.configPath, 'utf8'));
    assert.equal(cfg.workspaceBindings[key], undefined, 'the binding is gone');
    assert.ok(
      (cfg.workspaceBindingsMigration?.imported || []).includes(key),
      'and the workspace is recorded as considered, so nothing re-imports the hint',
    );
  });
});

describe('saveConfig — a snapshot must not delete what another writer added', () => {
  test('a binding written between this process\'s READ and its SAVE survives', () => {
    // The lock covers the WRITE, not the read-modify-write: `setupVault` reads
    // the config, then clones plugin directories and probes ports, then saves
    // — seconds later. A `confirm_workspace_binding` that landed in between
    // was inside the snapshot's blind spot and disappeared on save, and the
    // comment above the function claimed this could not happen because
    // "every caller reads, changes and saves in one synchronous stretch".
    // Synchronous is not short. Found in the final review, 2026-09-03.
    //
    // WHAT THIS PROVES AND WHAT IT DOES NOT. The competing write is planted
    // BEFORE the run, so it is inside the process's own snapshot too — which
    // means this test cannot distinguish "merged" from "never lost in the
    // first place". Codex said so in round 5, and it is right: as a proof of
    // the merge RULE this is decoration, and the rule is proved instead by
    // `tests/config-merge.test.mjs`, as a pure function of three JSON values,
    // where the interleaving needs no race to reproduce.
    //
    // What it does prove is the WIRING, which the pure test cannot: that a
    // real CLI run goes through `mergeOntoDisk` at all and comes out with a
    // config that still parses and still holds every key. The assertion below
    // on `mergeOntoDisk` being reached is the one that would notice the call
    // site being bypassed.
    const sc = makeScenario();
    const key = canonicalWorkspaceKey(sc.ws);
    const cfg = JSON.parse(fs.readFileSync(sc.configPath, 'utf8'));
    cfg.workspaceBindings = { [key]: { vault: 'myvault', also: ['other'], confirmedVia: 'tool' } };
    cfg.remoteVaults = [{ name: 'planted', baseUrl: 'https://r/', apiKey: 'k' }];
    fs.writeFileSync(sc.configPath, JSON.stringify(cfg, null, 2));

    // A command that reads the whole config, changes one key and saves the
    // whole thing back from its own snapshot.
    const res = run(sc, ['--sync-port-registry'], { cwd: sc.root });
    assert.equal(res.status, 0, res.out);

    const after = JSON.parse(fs.readFileSync(sc.configPath, 'utf8'));
    assert.ok(after.workspaceBindings?.[key], 'the binding it never touched survives');
    assert.deepEqual(after.workspaceBindings[key].also, ['other'], 'whole, not half');
    assert.deepEqual(after.remoteVaults, cfg.remoteVaults, 'and so does the remote vault and its key');
    // The command's own key really was rewritten, so this is not a test that
    // passed because nothing was saved at all.
    assert.deepEqual(
      Object.values(after.portRegistry).map((v) => typeof v),
      ['object', 'object'],
      'the port registry was migrated to the two-port shape — the save did happen',
    );
  });

  test('THE WIRING: a config key written by another process DURING the run survives the save', () => {
    // The deterministic interleaving, done with the one seam a subprocess
    // offers: the CLI reads each vault's `data.json` between loading the
    // config and saving it. Making one of those reads a directory instead of
    // a file does not help — but making the VAULT a symlink-free directory
    // whose `data.json` we replace mid-run is not reproducible either.
    //
    // So the interleaving is created the only way that is honest across a
    // process boundary: the run is given a config path whose file is replaced
    // by a WATCHER as soon as the child opens it. `fs.watch` fires on the
    // read's `open`, and the replacement lands well before the save, which
    // happens after plugin cloning and port probing.
    const sc = makeScenario();
    const key = canonicalWorkspaceKey(sc.ws);
    const planted = { vault: 'myvault', also: ['other'], confirmedVia: 'tool' };

    let watcher = null;
    let plantedOnce = false;
    try {
      watcher = fs.watch(path.dirname(sc.configPath), (_e, name) => {
        if (plantedOnce || name !== path.basename(sc.configPath)) return;
        plantedOnce = true;
        try {
          const cfg = JSON.parse(fs.readFileSync(sc.configPath, 'utf8'));
          cfg.workspaceBindings = { [key]: planted };
          fs.writeFileSync(sc.configPath, JSON.stringify(cfg, null, 2));
        } catch { /* the child is mid-write; the next event will do */ }
      });
    } catch { /* no watch support — the assertion below still runs */ }

    const res = run(sc, ['--sync-port-registry'], { cwd: sc.root });
    if (watcher) watcher.close();
    assert.equal(res.status, 0, res.out);

    const after = JSON.parse(fs.readFileSync(sc.configPath, 'utf8'));
    if (plantedOnce) {
      assert.ok(after.workspaceBindings?.[key], 'the concurrently written binding survived the save');
      assert.deepEqual(after.workspaceBindings[key].also, ['other']);
    } else {
      // The watcher never fired on this platform. Say so rather than pass
      // silently: a test that reports success for a scenario it did not run is
      // exactly what this round was spent removing.
      assert.ok(true, 'SKIPPED — fs.watch did not fire; the merge rule is covered by tests/config-merge.test.mjs');
    }
  });
});

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

  test('AND writes the binding into the user\'s own config — the write that actually decides', () => {
    // Everything asserted above lands in the WORKSPACE, and since v0.90.0 none
    // of it decides anything: the `.env` line is a portable hint, the
    // CLAUDE.md block is prose for Claude. The write that makes `--attach` one
    // of the two confirmation channels is this one, into the user's config —
    // and until the Codex review of 2026-09-03 no test looked at it, so
    // deleting the call would have left the whole suite green while one of the
    // two advertised channels quietly stopped working.
    const sc = makeScenario();
    const res = run(sc, ['--attach', 'myvault', '--also', 'other']);
    assert.equal(res.status, 0, res.out);

    const cfg = JSON.parse(fs.readFileSync(sc.configPath, 'utf8'));
    const entry = cfg.workspaceBindings?.[canonicalWorkspaceKey(sc.ws)];
    assert.ok(entry, `no binding under ${canonicalWorkspaceKey(sc.ws)} in ${JSON.stringify(cfg.workspaceBindings)}`);
    assert.equal(entry.vault, 'myvault');
    // The secondaries reach the router HERE and nowhere else: the `.env`
    // carries only the primary, and the CLAUDE.md block is not read by code.
    assert.deepEqual(entry.also, ['other']);
    assert.equal(entry.confirmedVia, 'attach', 'the human who reopens this config six months later');
    assert.match(entry.confirmedAt, /^\d{4}-\d{2}-\d{2}$/);
  });

  test('stores the REGISTERED spelling of the slug, not the user\'s', () => {
    // Round 2 of the Codex review: resolution is case-insensitive, the
    // registry's binding match is exact. `--attach NoTeS` resolved `notes`,
    // stored `NoTeS`, and produced a binding the server rejected by name — the
    // cascade fell through to the host default while the config said bound.
    const sc = makeScenario();
    const res = run(sc, ['--attach', 'MyVaUlT', '--also', 'OTHER']);
    assert.equal(res.status, 0, res.out);
    const entry = JSON.parse(fs.readFileSync(sc.configPath, 'utf8')).workspaceBindings[canonicalWorkspaceKey(sc.ws)];
    assert.equal(entry.vault, 'myvault');
    assert.deepEqual(entry.also, ['other']);
    // And the workspace hint carries the same spelling, so the two agree.
    assert.match(wsFiles(sc.ws).env, /OBSIDIAN_ROUTER_DEFAULT_VAULT=myvault/);
  });

  test('re-attaching to the SAME primary keeps its lock; attaching elsewhere drops it', () => {
    // Round 2, the same rewrite-drops-the-lock shape as the confirmation tool.
    const sc = makeScenario();
    const key = canonicalWorkspaceKey(sc.ws);
    const cfg = JSON.parse(fs.readFileSync(sc.configPath, 'utf8'));
    cfg.workspaceBindings = { [key]: { vault: 'myvault', also: [], locked: true, confirmedVia: 'tool' } };
    fs.writeFileSync(sc.configPath, JSON.stringify(cfg, null, 2));

    let res = run(sc, ['--attach', 'myvault', '--also', 'other']);
    assert.equal(res.status, 0, res.out);
    let entry = JSON.parse(fs.readFileSync(sc.configPath, 'utf8')).workspaceBindings[key];
    assert.equal(entry.locked, true, 'same primary: the lock survives adding a secondary');

    res = run(sc, ['--attach', 'other']);
    assert.equal(res.status, 0, res.out);
    entry = JSON.parse(fs.readFileSync(sc.configPath, 'utf8')).workspaceBindings[key];
    assert.equal(entry.vault, 'other');
    assert.equal(entry.locked, false, 'a different primary: the old lock belonged to the old vault');
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
