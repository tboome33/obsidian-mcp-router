/**
 * v0.111.0 — the opt-in hooks run per workspace.
 *
 * The three read-only hooks run everywhere (hooks/hooks.json); every other one
 * is declared there behind hooks/opt-in-gate.mjs, which runs it only in a
 * workspace switched on from the vault panel's console (workspace-hooks.json,
 * written by scripts/workspace-hooks.mjs).
 *
 * The gate is proved end to end on vault-link-linter: a bare link to a real
 * vault file makes it exit 2. Through the gate that exit 2 must reach Claude
 * Code where the hook is on, and nothing must run where it is off.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  ALWAYS_ON_HOOKS,
  OPT_IN_HOOKS,
  enabledHooks,
  globallyWiredHooks,
  parseState,
  readState,
  withHook,
  workspaceHooksPath,
} from '../src/helpers/workspace-hooks.mjs';
import { run } from '../scripts/workspace-hooks.mjs';
import { homeSafeEnv } from './_home-safe-spawn.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(ROOT, 'hooks', 'opt-in-gate.mjs');
const CLI = path.join(ROOT, 'scripts', 'workspace-hooks.mjs');
const IS_WINDOWS = process.platform === 'win32';

describe('the hook catalogue', () => {
  test('every hook file is in exactly one family, and the read-only ones are the plugin’s own', () => {
    const files = fs
      .readdirSync(path.join(ROOT, 'hooks'))
      .filter((f) => f.endsWith('.mjs') && f !== 'opt-in-gate.mjs')
      .map((f) => f.slice(0, -4))
      .sort();
    assert.deepEqual([...ALWAYS_ON_HOOKS, ...OPT_IN_HOOKS].sort(), files);
    assert.equal(new Set([...ALWAYS_ON_HOOKS, ...OPT_IN_HOOKS]).size, files.length);
  });

  test('hooks.json declares each opt-in hook behind the gate, on the events hooks.example.json gives it', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
    const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.example.json'), 'utf8'));
    const pairs = (hooks, pick) => {
      const out = [];
      for (const [event, blocks] of Object.entries(hooks)) {
        for (const b of blocks) for (const h of b.hooks) {
          const name = pick(h.command);
          if (name) out.push(`${event}|${b.matcher}|${name}`);
        }
      }
      return out.sort();
    };
    const gated = pairs(manifest.hooks, (c) => c.match(/opt-in-gate\.mjs" ([a-z0-9-]+)$/)?.[1]);
    const expected = pairs(example.hooks, (c) => {
      const name = c.match(/([a-z0-9-]+)\.mjs/)[1];
      return OPT_IN_HOOKS.includes(name) ? name : null;
    });
    assert.deepEqual(gated, expected);
    for (const name of OPT_IN_HOOKS) {
      assert.ok(gated.some((p) => p.endsWith(`|${name}`)), `${name} is declared`);
    }
  });
});

describe('workspace state', () => {
  test('a hook switched on is on for that workspace only, under any spelling of it', () => {
    const ws = IS_WINDOWS ? 'C:\\Work\\Project' : '/work/project';
    let state = withHook(parseState(null), ws, 'wiki-autocommit', true);
    state = withHook(state, ws, 'vault-link-linter', true);
    assert.deepEqual(enabledHooks(state, ws), ['wiki-autocommit', 'vault-link-linter'].sort((a, b) => OPT_IN_HOOKS.indexOf(a) - OPT_IN_HOOKS.indexOf(b)));
    assert.deepEqual(enabledHooks(state, IS_WINDOWS ? 'c:/work/project/' : '/work/project/'), enabledHooks(state, ws));
    assert.deepEqual(enabledHooks(state, IS_WINDOWS ? 'C:\\Work\\Other' : '/work/other'), []);

    state = withHook(state, ws, 'wiki-autocommit', false);
    assert.deepEqual(enabledHooks(state, ws), ['vault-link-linter']);
    state = withHook(state, ws, 'vault-link-linter', false);
    assert.deepEqual(state.workspaces, {}, 'a workspace with nothing on leaves no entry');
  });

  test('a read-only hook or an unknown name cannot be switched', () => {
    assert.throws(() => withHook(parseState(null), '/w', 'hot-cache-load', true), /unknown opt-in hook/);
    assert.throws(() => withHook(parseState(null), '/w', '../evil', true), /unknown opt-in hook/);
  });

  test('a hand-edited file keeps only known opt-in hooks', () => {
    const state = parseState({ workspaces: { '/w': { hooks: ['wiki-autocommit', 'hot-cache-load', 'nope'] } } });
    assert.deepEqual(enabledHooks(state, '/w'), ['wiki-autocommit']);
    assert.deepEqual(parseState('garbage').workspaces, {});
  });

  test('the file sits beside the router config', () => {
    const file = workspaceHooksPath({ OBSIDIAN_ROUTER_CONFIG: path.join(os.tmpdir(), 'x', 'config.json') });
    assert.equal(file, path.join(os.tmpdir(), 'x', 'workspace-hooks.json'));
  });
});

describe('global settings', () => {
  test('a direct router entry counts as global; a gated one or the user’s own does not', () => {
    const settings = {
      hooks: {
        Stop: [{ matcher: '', hooks: [
          { type: 'command', command: 'node "C:/x/obsidian-mcp-router/hooks/vault-link-linter.mjs"' },
          { type: 'command', command: 'node "/p/hooks/opt-in-gate.mjs" wiki-autocommit' },
          { type: 'command', command: 'node ~/my-hooks/chat-link-guard.mjs' },
          { type: 'command', command: 'node C:\\x\\hooks\\hot-cache-load.mjs' },
        ] }],
      },
    };
    assert.deepEqual(globallyWiredHooks(settings), ['vault-link-linter']);
    assert.deepEqual(globallyWiredHooks(null), []);
  });
});

describe('scripts/workspace-hooks.mjs', () => {
  let dir;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-hooks-cli-')); });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('status, then set, then status again', () => {
    const file = path.join(dir, 'workspace-hooks.json');
    const ws = path.join(dir, 'project');
    const settings = { hooks: { Stop: [{ hooks: [{ command: 'node /r/hooks/check-router-update.mjs' }] }] } };

    const first = run(['status', '--workspace', ws], file, settings);
    assert.deepEqual(first.alwaysOn, [...ALWAYS_ON_HOOKS]);
    assert.ok(first.optIn.every((h) => h.enabled === false));
    assert.equal(first.optIn.find((h) => h.name === 'check-router-update').global, true);

    const after = run(['set', '--workspace', ws, '--hook', 'session-auto-journal', '--on'], file, settings);
    assert.equal(after.optIn.find((h) => h.name === 'session-auto-journal').enabled, true);
    assert.deepEqual(enabledHooks(readState(file), ws), ['session-auto-journal']);

    assert.throws(() => run(['set', '--workspace', ws, '--hook', 'wiki-autocommit'], file, settings), /exactly one of/);
    assert.throws(() => run(['status'], file, settings), /--workspace/);
  });

  test('run as a program it prints one JSON object, and an error as { error } with exit 1', () => {
    const env = homeSafeEnv(dir, { OBSIDIAN_ROUTER_CONFIG: path.join(dir, 'cfg', 'config.json') });
    const ok = spawnSync(process.execPath, [CLI, 'status', '--workspace', dir], { encoding: 'utf8', env });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).optIn.length, OPT_IN_HOOKS.length);
    const bad = spawnSync(process.execPath, [CLI, 'set', '--workspace', dir, '--hook', 'nope', '--on'], { encoding: 'utf8', env });
    assert.equal(bad.status, 1);
    assert.match(JSON.parse(bad.stdout).error, /unknown opt-in hook/);
  });
});

describe('hooks/opt-in-gate.mjs', () => {
  let dir, home, cfgDir, workspace, vaultPath, transcriptPath;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opt-in-gate-'));
    home = path.join(dir, 'home');
    cfgDir = path.join(dir, 'cfg');
    workspace = path.join(dir, 'project');
    vaultPath = path.join(dir, 'vault');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    // The linter's own fixture: a vault file to link to, and its REST port.
    fs.mkdirSync(path.join(vaultPath, 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, 'wiki', 'log.md'), '# log');
    const plugin = path.join(vaultPath, '.obsidian', 'plugins', 'obsidian-local-rest-api');
    fs.mkdirSync(plugin, { recursive: true });
    fs.writeFileSync(path.join(plugin, 'data.json'), JSON.stringify({ port: 27132, insecurePort: 27142, enableInsecureServer: true }));
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ portRegistry: { [vaultPath]: 27132 }, portStart: 27132 }));
    transcriptPath = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Voir [log](wiki/log.md).' }] } })}\n`);
  });

  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const gate = (name) =>
    spawnSync(process.execPath, [GATE, name], {
      cwd: workspace,
      encoding: 'utf8',
      input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcriptPath, stop_hook_active: false }),
      env: homeSafeEnv(home, { OBSIDIAN_ROUTER_CONFIG: path.join(cfgDir, 'config.json'), CLAUDE_PROJECT_DIR: workspace }),
    });
  const setOn = (isOn) => {
    const file = path.join(cfgDir, 'workspace-hooks.json');
    run(['set', '--workspace', workspace, '--hook', 'vault-link-linter', isOn ? '--on' : '--off'], file, null);
  };

  test('off (the default): the hook does not run, nothing printed, exit 0', () => {
    const r = gate('vault-link-linter');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout + r.stderr, '');
  });

  test('on for this workspace: the hook runs with the same stdin, and its exit 2 comes through', () => {
    setOn(true);
    const r = gate('vault-link-linter');
    assert.equal(r.status, 2, `expected the linter's exit 2, got ${r.status}. stderr=${r.stderr}`);
    assert.match(r.stderr, /Convention violation/);
  });

  test('on, but still wired machine-wide: the gate steps aside, so it never runs twice', () => {
    setOn(true);
    const settings = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'node "/r/hooks/vault-link-linter.mjs"' }] }] } }));
    try {
      const r = gate('vault-link-linter');
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout + r.stderr, '');
    } finally {
      fs.rmSync(settings);
    }
  });

  test('switched off again, or an unknown or read-only name: silent exit 0', () => {
    setOn(false);
    for (const name of ['vault-link-linter', 'hot-cache-load', '../hooks/vault-link-linter', '']) {
      const r = gate(name);
      assert.equal(r.status, 0, `${name}: ${r.stderr}`);
      assert.equal(r.stdout + r.stderr, '', name);
    }
  });
});
