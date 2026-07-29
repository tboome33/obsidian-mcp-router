/**
 * Tests for Lot 5 — the Claude Code plugin carries the MCP server.
 *
 * Four contracts are pinned here, because each one fails SILENTLY when it
 * breaks (a server that never starts, a hook that never fires, a variable
 * that never expands, a Python install nobody asked for):
 *
 *   1. src/helpers/ensure-deps.mjs — the zero-dependency bootstrapper.
 *   2. hooks/_helpers/tool-names.mjs — prefix-agnostic tool matching.
 *   3. The plugin manifests (.mcp.json, hooks/hooks.json) and their
 *      variable-expansion boundary with hooks/hooks.example.json.
 *   4. The setup-vault side of the migration: matcher refresh and the
 *      double-wiring guard.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  REQUIRED_SPECIFIERS,
  NPM_INSTALL_ARGS,
  PACKAGE_ROOT,
  canResolve,
  missingSpecifiers,
  ensureDependencies,
  acquireLock,
  formatFailure,
} from '../src/helpers/ensure-deps.mjs';

import {
  ROUTER_WRITE_TOOLS,
  ROUTER_WRITE_MATCHER,
  routerWriteToolName,
  isRouterWriteTool,
  isLoggedTool,
} from '../hooks/_helpers/tool-names.mjs';

import {
  installHooksInto,
  refreshRouterMatchers,
  reportHooksStatus,
  pluginProvidedHookBasenames,
  isRouterPluginInstalled,
  installedRouterPluginPath,
  activePluginProvidedHooks,
  isRouterHookCommand,
} from '../scripts/setup-vault.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));

// ---- 1. ensure-deps -----------------------------------------------------

describe('ensure-deps — the zero-dependency bootstrapper', () => {
  test('PACKAGE_ROOT is the repo root, not a parent of it', () => {
    // Regression: the root used to be derived at the CALL SITE, and bin/
    // sits one level shallower than src/helpers/ — so the install ran in
    // the PARENT of the package, where npm found no package.json, exited 0,
    // and the failure surfaced as "npm reported success".
    assert.equal(PACKAGE_ROOT, REPO_ROOT);
    assert.ok(fs.existsSync(path.join(PACKAGE_ROOT, 'package.json')));
  });

  test('the probed specifiers are the ones actually imported statically', () => {
    // Probing the bare package name would throw ERR_PACKAGE_PATH_NOT_EXPORTED
    // on a healthy install, because the SDK declares no "." export.
    assert.ok(REQUIRED_SPECIFIERS.includes('@modelcontextprotocol/sdk/server/index.js'));
    assert.ok(REQUIRED_SPECIFIERS.includes('undici'));
    assert.ok(REQUIRED_SPECIFIERS.includes('mathml-to-latex'));
    for (const spec of REQUIRED_SPECIFIERS) {
      assert.equal(canResolve(spec, { packageRoot: PACKAGE_ROOT }), true, `${spec} should resolve in a developed checkout`);
    }
    assert.deepEqual(missingSpecifiers(REQUIRED_SPECIFIERS, { packageRoot: PACKAGE_ROOT }), []);
  });

  test('a package that is not installed is reported missing', () => {
    assert.equal(canResolve('this-package-does-not-exist-anywhere', { packageRoot: PACKAGE_ROOT }), false);
  });

  test('npm is invoked with --ignore-scripts and --omit=dev', () => {
    // --ignore-scripts is a hard requirement, not a nicety: this package's
    // lifecycle scripts build Python virtualenvs (~100 MB, 30-180 s). A
    // plugin user must never pay for that without asking.
    assert.ok(NPM_INSTALL_ARGS.includes('--ignore-scripts'));
    assert.ok(NPM_INSTALL_ARGS.includes('--omit=dev'));
    assert.equal(NPM_INSTALL_ARGS[0], 'install');
  });

  test('the fast path installs nothing when everything already resolves', () => {
    let installCalls = 0;
    const res = ensureDependencies({
      packageRoot: PACKAGE_ROOT,
      install: () => { installCalls += 1; return { ok: true, stderr: '' }; },
      lock: () => () => {},
    });
    assert.deepEqual(res, { status: 'ok', installed: false });
    assert.equal(installCalls, 0, 'a healthy tree must not shell out to npm');
  });

  test('a missing dependency triggers exactly one install', () => {
    let installCalls = 0;
    const res = ensureDependencies({
      packageRoot: PACKAGE_ROOT,
      specifiers: ['this-package-does-not-exist-anywhere'],
      install: () => {
        installCalls += 1;
        // Simulate npm making it resolvable is impossible here, so this
        // exercises the "install ran but did not help" branch.
        return { ok: true, stderr: '' };
      },
      lock: () => () => {},
    });
    assert.equal(installCalls, 1);
    assert.equal(res.status, 'failed');
    assert.match(res.reason, /reported success but the packages still do not resolve/);
  });

  test('a failing npm surfaces its stderr in the reason', () => {
    const res = ensureDependencies({
      packageRoot: PACKAGE_ROOT,
      specifiers: ['this-package-does-not-exist-anywhere'],
      install: () => ({ ok: false, stderr: 'EACCES: permission denied' }),
      lock: () => () => {},
    });
    assert.equal(res.status, 'failed');
    assert.match(res.reason, /EACCES: permission denied/);
  });

  test('the lock is always released, including after a throwing install', () => {
    let released = false;
    assert.throws(() => ensureDependencies({
      packageRoot: PACKAGE_ROOT,
      specifiers: ['this-package-does-not-exist-anywhere'],
      install: () => { throw new Error('boom'); },
      lock: () => () => { released = true; },
    }), /boom/);
    assert.equal(released, true, 'a crashed install must not strand the lock');
  });

  test('an unavailable lock does not install; it re-probes and reports', () => {
    let installCalls = 0;
    const res = ensureDependencies({
      packageRoot: PACKAGE_ROOT,
      specifiers: ['this-package-does-not-exist-anywhere'],
      install: () => { installCalls += 1; return { ok: true, stderr: '' }; },
      lock: () => null,
    });
    assert.equal(installCalls, 0, 'two processes must never npm-install the same tree at once');
    assert.equal(res.status, 'failed');
    assert.match(res.reason, /another install is in progress/);
  });

  test('acquireLock is mutually exclusive and releasable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lot5-lock-'));
    const lockPath = path.join(dir, 'lock');
    try {
      const release = acquireLock(lockPath, { waitMs: 0 });
      assert.ok(release, 'first acquisition must succeed');
      assert.equal(acquireLock(lockPath, { waitMs: 0 }), null, 'second acquisition must fail while held');
      release();
      const again = acquireLock(lockPath, { waitMs: 0 });
      assert.ok(again, 'the lock must be reusable after release');
      again();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the failure message names the root and an actionable command', () => {
    const msg = formatFailure({ packageRoot: '/x/y', missing: ['undici'], reason: 'nope' });
    assert.match(msg, /undici/);
    assert.match(msg, /npm install --omit=dev --ignore-scripts/);
    assert.match(msg, /\/x\/y/);
  });
});

// ---- 2. prefix-agnostic tool matching -----------------------------------

describe('tool-names — every registration form of the same tool', () => {
  const FORMS = {
    'direct registration': 'mcp__obsidian-router__write_file',
    'plugin-provided': 'mcp__plugin_obsidian-router_router__write_file',
    'MCPHub-namespaced': 'mcp__5f30f2c9__obsidian-router-Tribu-write_file',
  };

  for (const [label, name] of Object.entries(FORMS)) {
    test(`${label} is recognised`, () => {
      assert.equal(isRouterWriteTool(name), true);
      assert.equal(routerWriteToolName(name), 'write_file');
      assert.equal(isLoggedTool(name), true);
    });
  }

  test('every router write tool is matched under the plugin prefix', () => {
    for (const bare of ROUTER_WRITE_TOOLS) {
      assert.equal(
        routerWriteToolName(`mcp__plugin_obsidian-router_router__${bare}`),
        bare,
        `${bare} must survive the plugin prefix`,
      );
    }
  });

  test('read-only and non-MCP tools are not treated as writes', () => {
    for (const name of [
      'mcp__obsidian-router__get_file',
      'mcp__obsidian-router__search',
      'mcp__plugin_obsidian-router_router__list_vaults',
      'Read',
      '',
      null,
    ]) {
      assert.equal(isRouterWriteTool(name), false, `${name} must not count as a write`);
    }
  });

  test('a longer name merely ending in a tool word does not match', () => {
    assert.equal(isRouterWriteTool('mcp__other__write_file_backup'), false);
  });

  test('built-in writers and Bash are logged, plain reads are not', () => {
    for (const n of ['Write', 'Edit', 'MultiEdit', 'Bash']) assert.equal(isLoggedTool(n), true);
    assert.equal(isLoggedTool('Read'), false);
  });

  test('the exported matcher agrees with the predicate', () => {
    const re = new RegExp(ROUTER_WRITE_MATCHER);
    for (const name of Object.values(FORMS)) {
      assert.equal(re.test(name), isRouterWriteTool(name), `${name}: matcher and predicate must agree`);
    }
    assert.equal(re.test('mcp__obsidian-router__get_file'), false);
  });

  test('hooks.example.json PostToolUse matchers use the prefix-agnostic pattern', () => {
    // The frozen literal enumeration these replaced stopped matching the
    // moment the server was plugin-provided — and a hook that never fires
    // is indistinguishable from a hook with nothing to do.
    const example = readJson('hooks/hooks.example.json');
    const matchers = (example.hooks.PostToolUse || []).map((b) => b.matcher).filter((m) => m.includes('mcp__'));
    assert.ok(matchers.length >= 2, 'expected the autocommit and journal matchers');
    for (const m of matchers) {
      assert.ok(!m.includes('mcp__obsidian-router__'), `matcher still pins the legacy prefix: ${m}`);
      const re = new RegExp(m);
      assert.equal(re.test('mcp__plugin_obsidian-router_router__write_file'), true, `matcher misses plugin tools: ${m}`);
      assert.equal(re.test('mcp__obsidian-router__patch_file'), true, `matcher misses direct tools: ${m}`);
    }
  });
});

// ---- 3. plugin manifests ------------------------------------------------

describe('plugin manifests', () => {
  test('the server is declared INLINE in plugin.json, never as a root .mcp.json', () => {
    // This repo IS the marketplace source, so the plugin root and the repo
    // root are the same directory. A root-level `.mcp.json` would therefore
    // also be read as a PROJECT-scope MCP config by anyone who opens this
    // repo in Claude Code — and ${CLAUDE_PLUGIN_ROOT} does not expand at
    // project scope, so they would get a broken `router` registration
    // pointing at a literal "${CLAUDE_PLUGIN_ROOT}/bin/…" path.
    assert.ok(!fs.existsSync(path.join(REPO_ROOT, '.mcp.json')), 'a root .mcp.json leaks into project scope');

    const plugin = readJson('.claude-plugin/plugin.json');
    assert.deepEqual(Object.keys(plugin.mcpServers || {}), ['router']);
    const server = plugin.mcpServers.router;
    assert.equal(server.command, 'node');
    assert.ok(
      server.args.some((a) => a.includes('${CLAUDE_PLUGIN_ROOT}')),
      'the entrypoint must be resolved at startup, not pinned to an absolute path',
    );
    assert.ok(server.args.some((a) => a.endsWith('bin/obsidian-mcp-router.mjs')));
  });

  test('the server declaration does NOT set NODE_PATH', () => {
    // NODE_PATH is honoured only by the CommonJS resolver. This package is
    // "type": "module", so the documented NODE_PATH pattern would leave the
    // server unable to resolve anything — a silent, total failure.
    const server = readJson('.claude-plugin/plugin.json').mcpServers.router;
    assert.equal(server.env?.NODE_PATH, undefined);
  });

  test('the entrypoint the manifest points at exists', () => {
    const rel = readJson('.claude-plugin/plugin.json').mcpServers.router.args
      .find((a) => a.includes('bin/obsidian-mcp-router.mjs'))
      .replace('${CLAUDE_PLUGIN_ROOT}/', '');
    assert.ok(fs.existsSync(path.join(REPO_ROOT, rel)), `${rel} must exist in the shipped tree`);
  });

  test('scoped tool names stay under the 64-character limit', () => {
    // `mcp__plugin_<plugin>_<server>__` + the longest bare tool name. With
    // the server keyed `obsidian-router` instead of `router` the worst case
    // is 68 characters, past the limit many MCP clients enforce.
    const prefix = 'mcp__plugin_obsidian-router_router__';
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'index.mjs'), 'utf8');
    const bare = [...new Set([...src.matchAll(/name: '([a-z][a-z0-9_]{3,})'/g)].map((m) => m[1]))];
    assert.ok(bare.length > 20, `expected the tool table, found ${bare.length} names`);
    const worst = bare.reduce((a, b) => (b.length > a.length ? b : a));
    assert.ok(
      prefix.length + worst.length <= 64,
      `${prefix}${worst} is ${prefix.length + worst.length} chars — over the 64-char limit`,
    );
  });

  test('hooks/hooks.json ships only read-only, no-op-without-vault hooks', () => {
    // Plugin hooks are active for EVERY installer with no opt-in step, so
    // anything that commits to git, writes session transcripts into a vault,
    // blocks a turn with exit 2, or phones home must stay out.
    const manifest = readJson('hooks/hooks.json');
    const shipped = new Set();
    for (const event of Object.keys(manifest.hooks)) {
      for (const block of manifest.hooks[event]) {
        for (const entry of block.hooks) {
          const m = entry.command.match(/([a-z0-9-]+\.mjs)/);
          assert.ok(m, `unparseable hook command: ${entry.command}`);
          shipped.add(m[1]);
          assert.ok(
            entry.command.includes('${CLAUDE_PLUGIN_ROOT}'),
            'plugin hooks must resolve through ${CLAUDE_PLUGIN_ROOT}, never an absolute path',
          );
          assert.ok(fs.existsSync(path.join(REPO_ROOT, 'hooks', m[1])), `${m[1]} must exist`);
        }
      }
    }
    assert.deepEqual([...shipped].sort(), ['decisions-recall.mjs', 'hot-cache-load.mjs']);

    const FORBIDDEN = [
      'wiki-autocommit.mjs',        // writes to the user's git history
      'session-auto-journal.mjs',   // writes prompts verbatim into a vault
      'vault-link-linter.mjs',      // exit 2 — blocks the turn
      'hot-cache-update-prompt.mjs',// exit 2 — blocks the turn
      'check-router-update.mjs',    // network call + settings.json rewrite
      'doc-propagation-checker.mjs',
      'vault-doc-startup-check.mjs',
      'wiki-query-first-nudge.mjs', // injects ~2k tokens on every prompt
    ];
    for (const f of FORBIDDEN) {
      assert.ok(!shipped.has(f), `${f} must stay opt-in, never plugin-activated`);
    }
  });

  test('every plugin-shipped hook has an env opt-out', () => {
    const manifest = readJson('hooks/hooks.json');
    const OPT_OUTS = {
      'hot-cache-load.mjs': 'OBSIDIAN_ROUTER_NO_HOT_CACHE_LOAD',
      'decisions-recall.mjs': 'OBSIDIAN_ROUTER_NO_DECISIONS_RECALL',
    };
    for (const event of Object.keys(manifest.hooks)) {
      for (const block of manifest.hooks[event]) {
        for (const entry of block.hooks) {
          const file = entry.command.match(/([a-z0-9-]+\.mjs)/)[1];
          const src = fs.readFileSync(path.join(REPO_ROOT, 'hooks', file), 'utf8');
          assert.ok(src.includes(OPT_OUTS[file]), `${file} must honour ${OPT_OUTS[file]}`);
        }
      }
    }
  });

  test('hooks.example.json never uses ${CLAUDE_PLUGIN_ROOT}', () => {
    // The variable is expanded in PLUGIN component files only. Written into
    // ~/.claude/settings.json it stays a literal, and every hook silently
    // fails to launch. hooks.example.json is the settings.json source, so it
    // must keep the <router-repo> placeholder that --install-hooks resolves.
    const raw = fs.readFileSync(path.join(REPO_ROOT, 'hooks', 'hooks.example.json'), 'utf8');
    assert.ok(!raw.includes('CLAUDE_PLUGIN_ROOT'), 'settings.json does not expand plugin variables');
    assert.ok(raw.includes('<router-repo>'));
  });

  test('package.json has no postinstall — Python installs stay opt-in', () => {
    // Claude Code appears to npm-install plugins that carry a package.json,
    // and nothing documents whether it passes --ignore-scripts. A postinstall
    // here would mean every third party silently building a Python venv.
    const pkg = readJson('package.json');
    for (const phase of ['preinstall', 'install', 'postinstall', 'prepare']) {
      assert.equal(pkg.scripts[phase], undefined, `${phase} must not run for plugin installers`);
    }
    assert.equal(typeof pkg.scripts['install-markitdown'], 'string', 'the explicit opt-in must remain');
    assert.equal(typeof pkg.scripts['install-docling'], 'string');
  });

  test('everything Lot 5 added ships through the npm tarball', () => {
    const files = readJson('package.json').files;
    // .claude-plugin/ carries the server declaration; hooks/ and src/ carry
    // the manifest, the matcher helper and the bootstrapper.
    for (const entry of ['.claude-plugin/', 'hooks/', 'src/', 'bin/']) {
      assert.ok(files.includes(entry), `${entry} must be in package.json files`);
    }
  });
});

// ---- 4. the setup-vault migration side ----------------------------------

describe('hook wiring — migration to a plugin-provided server', () => {
  const example = {
    hooks: {
      PostToolUse: [
        { matcher: 'mcp__.*(?:write_file|patch_file)$', hooks: [{ type: 'command', command: 'node "/r/obsidian-mcp-router/hooks/wiki-autocommit.mjs"' }] },
      ],
      SessionStart: [
        { matcher: 'startup', hooks: [{ type: 'command', command: 'node "/r/obsidian-mcp-router/hooks/hot-cache-load.mjs"' }] },
      ],
    },
  };

  test('a frozen legacy matcher is refreshed in place', () => {
    const settings = {
      hooks: {
        PostToolUse: [
          {
            matcher: 'mcp__obsidian-router__write_file|mcp__obsidian-router__patch_file',
            hooks: [{ type: 'command', command: 'node "/r/obsidian-mcp-router/hooks/wiki-autocommit.mjs"' }],
          },
        ],
      },
    };
    const res = refreshRouterMatchers(settings, example);
    assert.deepEqual(res.updated, ['wiki-autocommit.mjs']);
    assert.equal(settings.hooks.PostToolUse[0].matcher, 'mcp__.*(?:write_file|patch_file)$');
  });

  test('refreshing is idempotent', () => {
    const settings = {
      hooks: {
        PostToolUse: [
          { matcher: 'mcp__.*(?:write_file|patch_file)$', hooks: [{ type: 'command', command: 'node "/r/obsidian-mcp-router/hooks/wiki-autocommit.mjs"' }] },
        ],
      },
    };
    assert.deepEqual(refreshRouterMatchers(settings, example).updated, []);
  });

  test('a block a user shares with their own hook is never rewritten', () => {
    const settings = {
      hooks: {
        PostToolUse: [
          {
            matcher: 'mcp__obsidian-router__write_file',
            hooks: [
              { type: 'command', command: 'node "/r/obsidian-mcp-router/hooks/wiki-autocommit.mjs"' },
              { type: 'command', command: 'node "/home/me/my-own-hook.mjs"' },
            ],
          },
        ],
      },
    };
    assert.deepEqual(refreshRouterMatchers(settings, example).updated, []);
    assert.equal(settings.hooks.PostToolUse[0].matcher, 'mcp__obsidian-router__write_file');
  });

  test('plugin-provided hooks are not wired a second time', () => {
    const settings = {};
    const res = installHooksInto(settings, example, { pluginProvided: ['hot-cache-load.mjs'] });
    assert.deepEqual(res.pluginProvided, ['hot-cache-load.mjs']);
    assert.ok(!res.added.includes('hot-cache-load.mjs'), 'wiring it again would fire it twice per event');
    assert.ok(res.added.includes('wiki-autocommit.mjs'), 'opt-in hooks must still be installed');
  });

  test('a hook already wired by hand is left alone even if plugin-provided', () => {
    // It really is firing twice; the user must keep seeing it as wired so
    // --uninstall-hooks stays the obvious remedy.
    const settings = {
      hooks: {
        SessionStart: [
          { matcher: 'startup', hooks: [{ type: 'command', command: 'node "/r/obsidian-mcp-router/hooks/hot-cache-load.mjs"' }] },
        ],
      },
    };
    const res = installHooksInto(settings, example, { pluginProvided: ['hot-cache-load.mjs'] });
    assert.deepEqual(res.pluginProvided, []);
    assert.ok(res.skipped.includes('hot-cache-load.mjs'));
  });

  test('status distinguishes plugin-active from wired and from inactive', () => {
    const rows = reportHooksStatus({}, example, { pluginProvided: ['hot-cache-load.mjs'] });
    const byName = Object.fromEntries(rows.map((r) => [r.basename, r.status]));
    assert.equal(byName['hot-cache-load.mjs'], 'plugin');
    assert.equal(byName['wiki-autocommit.mjs'], 'inactive');
  });

  test('pluginProvidedHookBasenames reads the real manifest', () => {
    assert.deepEqual(pluginProvidedHookBasenames().sort(), ['decisions-recall.mjs', 'hot-cache-load.mjs']);
  });

  test('plugin detection is conservative when the registry is unreadable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lot5-home-'));
    const registry = path.join(dir, '.claude', 'plugins', 'installed_plugins.json');
    const installPath = path.join(dir, '.claude', 'plugins', 'cache', 'mp', 'obsidian-router', '0.56.0');
    try {
      assert.equal(isRouterPluginInstalled({ homedir: dir }), false);
      fs.mkdirSync(path.dirname(registry), { recursive: true });
      fs.writeFileSync(registry, 'not json');
      assert.equal(isRouterPluginInstalled({ homedir: dir }), false);

      // Registered but the recorded installPath does not exist → not live.
      fs.writeFileSync(registry, JSON.stringify({
        version: 2,
        plugins: { 'obsidian-router@obsidian-mcp-router-marketplace': [{ version: '0.56.0', installPath }] },
      }));
      assert.equal(isRouterPluginInstalled({ homedir: dir }), false);

      fs.mkdirSync(installPath, { recursive: true });
      assert.equal(isRouterPluginInstalled({ homedir: dir }), true);
      assert.equal(installedRouterPluginPath({ homedir: dir }), installPath);

      // Explicitly disabled in settings.json → treated as not live.
      fs.writeFileSync(
        path.join(dir, '.claude', 'settings.json'),
        JSON.stringify({ enabledPlugins: { 'obsidian-router@obsidian-mcp-router-marketplace': false } }),
      );
      assert.equal(isRouterPluginInstalled({ homedir: dir }), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the skip-list comes from the INSTALLED plugin, never from this checkout', () => {
    // The BLOCKER this pins: deriving the manifest from REPO_ROOT while
    // deriving "is it installed?" from installed_plugins.json credits the
    // installed plugin with hooks it does not ship. On the normal upgrade
    // path the cached plugin lags the checkout, so a pre-Lot-5 plugin (no
    // hooks.json at all) was credited with this version's manifest:
    // --install-hooks then skipped wiring both hooks, nothing ran them, and
    // --hooks-status reported a double-wiring that did not exist while
    // prescribing a "fix" that deleted them for good.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lot5-skew-'));
    const registry = path.join(dir, '.claude', 'plugins', 'installed_plugins.json');
    const installPath = path.join(dir, '.claude', 'plugins', 'cache', 'mp', 'obsidian-router', '0.55.1');
    try {
      fs.mkdirSync(path.dirname(registry), { recursive: true });
      fs.mkdirSync(path.join(installPath, 'hooks'), { recursive: true });  // pre-Lot-5: no hooks.json
      fs.writeFileSync(registry, JSON.stringify({
        version: 2,
        plugins: { 'obsidian-router@obsidian-mcp-router-marketplace': [{ version: '0.55.1', installPath }] },
      }));

      assert.equal(isRouterPluginInstalled({ homedir: dir }), true, 'the plugin IS installed');
      assert.deepEqual(pluginProvidedHookBasenames().sort(), ['decisions-recall.mjs', 'hot-cache-load.mjs'],
        'this checkout does declare both hooks');
      assert.deepEqual(activePluginProvidedHooks({ homedir: dir }), [],
        'but the INSTALLED plugin declares none, so nothing may be skipped');

      // Once the installed plugin catches up, the skip-list appears.
      fs.copyFileSync(
        path.join(REPO_ROOT, 'hooks', 'hooks.json'),
        path.join(installPath, 'hooks', 'hooks.json'),
      );
      assert.deepEqual(activePluginProvidedHooks({ homedir: dir }).sort(), ['decisions-recall.mjs', 'hot-cache-load.mjs']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('router hooks are recognised in a plugin-cache path, not just a dev checkout', () => {
    // The old identity test was a substring match on `obsidian-mcp-router/hooks/`,
    // which a marketplace path never contains: marketplace and plugin are
    // separate segments (…/cache/obsidian-mcp-router-marketplace/obsidian-router/<v>/hooks/).
    // Plugin users were therefore invisible to --hooks-status, --uninstall-hooks
    // and the matcher refresh, and --install-hooks re-added hooks it could not see.
    const cachePath = 'node "C:\\\\Users\\\\me\\\\.claude\\\\plugins\\\\cache\\\\obsidian-mcp-router-marketplace\\\\obsidian-router\\\\0.56.0\\\\hooks\\\\hot-cache-load.mjs"';
    assert.equal(isRouterHookCommand(cachePath), true, 'a plugin-cache hook must be recognised');
    assert.equal(isRouterHookCommand('node "/home/me/dev/obsidian-mcp-router/hooks/wiki-autocommit.mjs"'), true);
    assert.equal(isRouterHookCommand('node "/opt/router-fork/hooks/vault-link-linter.mjs"'), true,
      'identity is the hook we ship sitting in a hooks/ dir, not a directory name');
    assert.equal(isRouterHookCommand('node "/home/me/scripts/my-own-hook.mjs"'), false);
    assert.equal(isRouterHookCommand('node "/home/me/hot-cache-load.mjs"'), false,
      'outside a hooks/ directory it is not ours');
    assert.equal(isRouterHookCommand(''), false);
    assert.equal(isRouterHookCommand(null), false);
  });
});

// ---- 5. the wiki-autocommit blast radius --------------------------------

describe('wiki-autocommit — only inside a real vault', () => {
  test('the guard is a vault test, not a directory-name test', () => {
    // It used to fire on "cwd contains a directory called wiki", which is an
    // ordinary docs folder name — so it injected commits, with --no-verify,
    // into unrelated repositories.
    const src = fs.readFileSync(path.join(REPO_ROOT, 'hooks', 'wiki-autocommit.mjs'), 'utf8');
    assert.ok(src.includes('detectVaultContext'), 'must gate on a real vault context');
    assert.ok(src.includes("ctx.mode !== 'cwd-is-vault'"), 'workspace-bound sessions must be excluded');
    assert.ok(src.includes('OBSIDIAN_ROUTER_NO_WIKI_AUTOCOMMIT'), 'a git-writing hook needs an opt-out');
  });
});
