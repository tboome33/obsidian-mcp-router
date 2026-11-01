/**
 * AN UNBOUND SESSION INJECTS NO VAULT CONTENT (v0.121.0).
 *
 * The server no longer gives an unbound workspace a default vault; the hooks
 * must agree, or the session reads one vault's hot cache and decisions while
 * every tool call is refused for lack of a vault. They already resolve their
 * vault only from a confirmed binding, the cwd being a vault, or a HOST
 * override — never from config.json's `defaultVault`, `openVaults` or "the
 * first vault that answers". These tests pin that, with the exact config of
 * the bug report: vaultReach "declared", openVaults non-empty, a defaultVault.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { canonicalWorkspaceKey } from '../src/helpers/workspace-bindings.mjs';

const HOOKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks');
const HOT_TOKEN = 'hot-token-7f3a';
const DECISION_TOKEN = 'decision-token-9c2e';

let workDir;
let vaultDir;
let plainCwd;
let configPath;

before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-implicit-default-hooks-'));
  vaultDir = path.join(workDir, 'notes');
  fs.mkdirSync(path.join(vaultDir, 'wiki-meta'), { recursive: true });
  fs.mkdirSync(path.join(vaultDir, 'wiki', 'decisions'), { recursive: true });
  fs.writeFileSync(path.join(vaultDir, 'wiki-meta', 'catalog.md'), '# Catalog\n');
  fs.writeFileSync(path.join(vaultDir, 'wiki-meta', 'hot.md'), `## Recent\n\n- ${HOT_TOKEN}\n`);
  fs.writeFileSync(
    path.join(vaultDir, 'wiki', 'decisions', 'routing.md'),
    `---\ntype: decision\nstatus: accepted\ntitle: "Routing of vault writes"\ndecision: "${DECISION_TOKEN}: vault writes always go through the router"\n---\n\n# Routing\n`,
  );
  plainCwd = path.join(workDir, 'home-like');
  fs.mkdirSync(plainCwd, { recursive: true });
  configPath = path.join(workDir, 'config.json');
});

after(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function writeConfig({ binding = null } = {}) {
  fs.writeFileSync(configPath, JSON.stringify({
    portRegistry: { [vaultDir]: 27999 },
    vaultNames: { [vaultDir]: 'notes' },
    defaultVault: 'notes',
    vaultReach: 'declared',
    openVaults: ['notes'],
    ...(binding ? { workspaceBindings: { [canonicalWorkspaceKey(plainCwd)]: binding } } : {}),
  }, null, 2));
}

function runHook(name, input) {
  const clean = { ...process.env };
  for (const k of Object.keys(clean)) {
    if (k.startsWith('OBSIDIAN_ROUTER_') || k === 'VAULT_PATH' || k === 'CLAUDE_PROJECT_DIR') delete clean[k];
  }
  return spawnSync(process.execPath, [path.join(HOOKS, name)], {
    input: JSON.stringify({ cwd: plainCwd, session_id: 'test', ...input }),
    encoding: 'utf8',
    cwd: plainCwd,
    env: { ...clean, OBSIDIAN_ROUTER_CONFIG: configPath, HOME: plainCwd, USERPROFILE: plainCwd },
    timeout: 15000,
  });
}

const PROMPT = 'How do we route vault writes through the router for this project?';

describe('unbound session: no hot.md, no decisions, no vault content in the briefing', () => {
  test('hot-cache-load injects nothing', () => {
    writeConfig();
    const r = runHook('hot-cache-load.mjs', { hook_event_name: 'SessionStart' });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, new RegExp(HOT_TOKEN));
    assert.equal(r.stdout.trim(), '');
  });

  test('decisions-recall injects nothing', () => {
    writeConfig();
    const r = runHook('decisions-recall.mjs', { hook_event_name: 'UserPromptSubmit', prompt: PROMPT });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, new RegExp(DECISION_TOKEN));
  });

  test('workspace-briefing says "no binding" and carries no vault content', () => {
    writeConfig();
    const r = runHook('workspace-briefing.mjs', { hook_event_name: 'SessionStart', source: 'startup' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /no binding/);
    assert.doesNotMatch(r.stdout, new RegExp(`${HOT_TOKEN}|${DECISION_TOKEN}`));
  });
});

describe('positive control: the same vault, BOUND, does inject', () => {
  test('hot-cache-load injects the bound vault hot.md', () => {
    writeConfig({ binding: { vault: 'notes', also: [], locked: false, confirmedAt: '2026-11-01', confirmedVia: 'test' } });
    const r = runHook('hot-cache-load.mjs', { hook_event_name: 'SessionStart' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(HOT_TOKEN), 'the fixture must be valid, or the unbound tests prove nothing');
  });

  test('decisions-recall recalls the bound vault decision', () => {
    writeConfig({ binding: { vault: 'notes', also: [], locked: false, confirmedAt: '2026-11-01', confirmedVia: 'test' } });
    const r = runHook('decisions-recall.mjs', { hook_event_name: 'UserPromptSubmit', prompt: PROMPT });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(DECISION_TOKEN), `the fixture must be valid:\n${r.stdout}\n${r.stderr}`);
  });
});
