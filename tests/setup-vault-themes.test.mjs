/**
 * Tests for the Lot 2 theme/appearance plumbing in scripts/setup-vault.mjs:
 *
 *   - cloneThemes()           — per-theme propagation (skip-existing,
 *                               --force overwrite, target-only preserved)
 *   - syncAppearanceDefaults() — fill-if-absent appearance.json
 *   - applyThemeChoice()       — the --theme wizard picker, applied
 *   - isTargetPluginNewer()    — the BRAT anti-downgrade guard
 *
 * Strategy mirrors the other setup-vault tests: isolated tmp dirs shaped
 * like vaults, direct calls to the exported functions, no CLI spawn.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  cloneThemes,
  syncAppearanceDefaults,
  applyThemeChoice,
  isTargetPluginNewer,
} from '../scripts/setup-vault.mjs';

let workDir;

before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-vault-themes-'));
});

after(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function makeVault(name) {
  const root = fs.mkdtempSync(path.join(workDir, `${name}-`));
  fs.mkdirSync(path.join(root, '.obsidian'), { recursive: true });
  return root;
}

function addTheme(vault, themeName, css = 'body {}') {
  const dir = path.join(vault, '.obsidian', 'themes', themeName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: themeName, version: '1.0.0' }));
  fs.writeFileSync(path.join(dir, 'theme.css'), css);
  return dir;
}

function addPlugin(vault, id, version) {
  const dir = path.join(vault, '.obsidian', 'plugins', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id, version }));
  return dir;
}

describe('cloneThemes', () => {
  test('copies every theme folder into a fresh target', () => {
    const src = makeVault('src');
    const dst = makeVault('dst');
    addTheme(src, 'Blue Topaz');
    addTheme(src, 'Prism');
    const r = cloneThemes(src, dst, false);
    assert.deepEqual(r.cloned.sort(), ['Blue Topaz', 'Prism']);
    assert.ok(fs.existsSync(path.join(dst, '.obsidian', 'themes', 'Blue Topaz', 'theme.css')));
  });

  test('skips an existing theme without --force (local edits preserved)', () => {
    const src = makeVault('src');
    const dst = makeVault('dst');
    addTheme(src, 'Blue Topaz', 'body { color: template; }');
    addTheme(dst, 'Blue Topaz', 'body { color: user-tweaked; }');
    const r = cloneThemes(src, dst, false);
    assert.deepEqual(r.skipped, ['Blue Topaz']);
    const kept = fs.readFileSync(path.join(dst, '.obsidian', 'themes', 'Blue Topaz', 'theme.css'), 'utf8');
    assert.ok(kept.includes('user-tweaked'));
  });

  test('--force overwrites the shared theme but never deletes a target-only theme', () => {
    const src = makeVault('src');
    const dst = makeVault('dst');
    addTheme(src, 'Blue Topaz', 'body { color: template-v2; }');
    addTheme(dst, 'Blue Topaz', 'body { color: stale; }');
    addTheme(dst, 'MyPersonalTheme');
    const r = cloneThemes(src, dst, true);
    assert.deepEqual(r.cloned, ['Blue Topaz']);
    const refreshed = fs.readFileSync(path.join(dst, '.obsidian', 'themes', 'Blue Topaz', 'theme.css'), 'utf8');
    assert.ok(refreshed.includes('template-v2'));
    assert.ok(fs.existsSync(path.join(dst, '.obsidian', 'themes', 'MyPersonalTheme', 'manifest.json')),
      'a theme that exists only in the target must survive --force');
  });

  test('no themes dir in the source → empty result, no crash', () => {
    const src = makeVault('src');
    const dst = makeVault('dst');
    assert.deepEqual(cloneThemes(src, dst, false), { cloned: [], skipped: [] });
  });
});

describe('syncAppearanceDefaults', () => {
  test('copies appearance.json when the target has none', () => {
    const src = makeVault('src');
    const dst = makeVault('dst');
    fs.writeFileSync(path.join(src, '.obsidian', 'appearance.json'),
      JSON.stringify({ cssTheme: 'Blue Topaz', theme: 'moonstone', accentColor: '' }));
    assert.equal(syncAppearanceDefaults(src, dst), true);
    const copied = JSON.parse(fs.readFileSync(path.join(dst, '.obsidian', 'appearance.json'), 'utf8'));
    assert.equal(copied.cssTheme, 'Blue Topaz');
    assert.equal(copied.theme, 'moonstone');
  });

  test('never touches an existing appearance.json (user theme choice wins)', () => {
    const src = makeVault('src');
    const dst = makeVault('dst');
    fs.writeFileSync(path.join(src, '.obsidian', 'appearance.json'), JSON.stringify({ cssTheme: 'Blue Topaz' }));
    fs.writeFileSync(path.join(dst, '.obsidian', 'appearance.json'), JSON.stringify({ cssTheme: 'Prism' }));
    assert.equal(syncAppearanceDefaults(src, dst), false);
    const kept = JSON.parse(fs.readFileSync(path.join(dst, '.obsidian', 'appearance.json'), 'utf8'));
    assert.equal(kept.cssTheme, 'Prism');
  });

  test('source without appearance.json → no-op', () => {
    const src = makeVault('src');
    const dst = makeVault('dst');
    assert.equal(syncAppearanceDefaults(src, dst), false);
    assert.ok(!fs.existsSync(path.join(dst, '.obsidian', 'appearance.json')));
  });
});

describe('applyThemeChoice', () => {
  test('writes cssTheme for a theme present in the target, preserving other keys', () => {
    const dst = makeVault('dst');
    addTheme(dst, 'Blue Topaz');
    fs.writeFileSync(path.join(dst, '.obsidian', 'appearance.json'),
      JSON.stringify({ cssTheme: 'Prism', theme: 'moonstone', enabledCssSnippets: ['x'] }));
    assert.equal(applyThemeChoice(dst, 'Blue Topaz'), true);
    const app = JSON.parse(fs.readFileSync(path.join(dst, '.obsidian', 'appearance.json'), 'utf8'));
    assert.equal(app.cssTheme, 'Blue Topaz');
    assert.equal(app.theme, 'moonstone');
    assert.deepEqual(app.enabledCssSnippets, ['x']);
  });

  test('"obsidian-default" clears cssTheme without requiring a theme folder', () => {
    const dst = makeVault('dst');
    fs.writeFileSync(path.join(dst, '.obsidian', 'appearance.json'), JSON.stringify({ cssTheme: 'Prism' }));
    assert.equal(applyThemeChoice(dst, 'obsidian-default'), true);
    const app = JSON.parse(fs.readFileSync(path.join(dst, '.obsidian', 'appearance.json'), 'utf8'));
    assert.equal(app.cssTheme, '');
  });

  test('refuses a theme that has no manifest in the target and leaves the file untouched', () => {
    const dst = makeVault('dst');
    fs.writeFileSync(path.join(dst, '.obsidian', 'appearance.json'), JSON.stringify({ cssTheme: 'Prism' }));
    assert.equal(applyThemeChoice(dst, 'Nonexistent Theme'), false);
    const app = JSON.parse(fs.readFileSync(path.join(dst, '.obsidian', 'appearance.json'), 'utf8'));
    assert.equal(app.cssTheme, 'Prism');
  });

  test('creates appearance.json when the vault has none yet', () => {
    const dst = makeVault('dst');
    addTheme(dst, 'Blue Topaz');
    assert.equal(applyThemeChoice(dst, 'Blue Topaz'), true);
    const app = JSON.parse(fs.readFileSync(path.join(dst, '.obsidian', 'appearance.json'), 'utf8'));
    assert.equal(app.cssTheme, 'Blue Topaz');
  });
});

describe('isTargetPluginNewer (BRAT anti-downgrade guard)', () => {
  test('true when the target is ahead of the source', () => {
    const src = makeVault('src');
    const dst = makeVault('dst');
    const s = addPlugin(src, 'mcp-router-bridge', '0.5.0');
    const d = addPlugin(dst, 'mcp-router-bridge', '0.5.1');
    assert.equal(isTargetPluginNewer(s, d), true);
  });

  test('false on equal versions (refresh allowed)', () => {
    const src = makeVault('src');
    const dst = makeVault('dst');
    assert.equal(
      isTargetPluginNewer(addPlugin(src, 'p', '1.2.3'), addPlugin(dst, 'p', '1.2.3')),
      false,
    );
  });

  test('false when the target is behind (upgrade allowed)', () => {
    const src = makeVault('src');
    const dst = makeVault('dst');
    assert.equal(
      isTargetPluginNewer(addPlugin(src, 'p', '2.0.0'), addPlugin(dst, 'p', '1.9.9')),
      false,
    );
  });

  test('fails open on a missing or unparseable manifest', () => {
    const src = makeVault('src');
    const dst = makeVault('dst');
    const s = addPlugin(src, 'p', '1.0.0');
    const dMissing = path.join(dst, '.obsidian', 'plugins', 'p');
    fs.mkdirSync(dMissing, { recursive: true });
    assert.equal(isTargetPluginNewer(s, dMissing), false);

    const dGarbage = addPlugin(dst, 'q', '1.0.0');
    fs.writeFileSync(path.join(dGarbage, 'manifest.json'), 'not json');
    assert.equal(isTargetPluginNewer(s, dGarbage), false);

    const dWeird = addPlugin(dst, 'r', 'not-semver');
    assert.equal(isTargetPluginNewer(s, dWeird), false);
  });
});
