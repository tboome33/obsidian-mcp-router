/**
 * src/helpers/plugin-sync-report.mjs — the three-bucket plugin sync report.
 *
 * The fixture reproduces the real failure: the GitHub skeleton ships BRAT with
 * code, three settings-only pre-seeds, and enables seven marketplace plugins it
 * never ships. The old report said "Synced 4 new plugin(s)".
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  PLUGIN_SYNC_ACTIONS as A,
  summarizePluginSync,
  projectPluginSync,
  formatPluginSyncReport,
  formatPluginSyncPlan,
  installPluginsCommand,
} from '../src/helpers/plugin-sync-report.mjs';

const SKELETON_ENABLED = [
  'obsidian-local-rest-api', 'mcp-router-bridge', 'smart-connections', 'smart-lookup',
  'templater-obsidian', 'obsidian-quiet-outline', 'realclaudian', 'image-converter',
  'obsidian-icon-folder', 'recent-files-obsidian', 'rich-text-editor',
  'obsidian-style-settings', 'obsidian42-brat',
];
const ENTRIES = [
  { id: 'mcp-router-bridge', action: A.COPY, kind: 'settings-only', files: ['data.json'] },
  { id: 'obsidian-icon-folder', action: A.COPY, kind: 'settings-only', files: ['data.json'] },
  { id: 'obsidian-quiet-outline', action: A.COPY, kind: 'settings-only', files: ['data.json'] },
  { id: 'obsidian42-brat', action: A.COPY, kind: 'code', files: ['data.json', 'main.js', 'manifest.json'] },
];
const AFTER_ENABLED = ENTRIES.map((e) => e.id);
const HAS_CODE_AFTER = { 'obsidian42-brat': true };

describe('summarizePluginSync', () => {
  const s = summarizePluginSync({
    entries: ENTRIES,
    targetEnabled: AFTER_ENABLED,
    sourceEnabled: SKELETON_ENABLED,
    hasCode: HAS_CODE_AFTER,
    bratManaged: ['mcp-router-bridge'],
  });

  test('only a plugin with code after the copy counts as installed', () => {
    assert.deepEqual(s.codeInstalled, ['obsidian42-brat']);
  });

  test('settings-only copies are their own bucket', () => {
    assert.deepEqual(s.settingsOnly, ['mcp-router-bridge', 'obsidian-icon-folder', 'obsidian-quiet-outline']);
  });

  test('enabled-without-code includes ids the source enables and never provided', () => {
    const ids = s.enabledWithoutCode.map((e) => e.id);
    assert.equal(ids.length, 12, `12/13 skeleton ids lack code; got ${ids.join(',')}`);
    assert.ok(!ids.includes('obsidian42-brat'));
    for (const never of ['smart-connections', 'templater-obsidian', 'rich-text-editor']) {
      const e = s.enabledWithoutCode.find((x) => x.id === never);
      assert.ok(e, never);
      assert.equal(e.enabledInVault, false, `${never} is not in the target's list`);
      assert.equal(e.installVia, 'marketplace');
    }
    const bridge = s.enabledWithoutCode.find((x) => x.id === 'mcp-router-bridge');
    assert.equal(bridge.enabledInVault, true);
    assert.equal(bridge.installVia, 'brat');
  });

  test('accepts hasCode as a Set or a function', () => {
    const viaSet = summarizePluginSync({ entries: ENTRIES, targetEnabled: AFTER_ENABLED, hasCode: new Set(['obsidian42-brat']) });
    const viaFn = summarizePluginSync({ entries: ENTRIES, targetEnabled: AFTER_ENABLED, hasCode: (id) => id === 'obsidian42-brat' });
    assert.deepEqual(viaSet.codeInstalled, ['obsidian42-brat']);
    assert.deepEqual(viaFn.settingsOnly, s.settingsOnly);
  });

  test('non-writing actions never land in the install buckets', () => {
    const r = summarizePluginSync({
      entries: [
        { id: 'a', action: A.SKIP_PRESENT, kind: 'code' },
        { id: 'b', action: A.KEEP_NEWER, kind: 'code' },
        { id: 'c', action: A.DEFER_CREDENTIAL, kind: 'code' },
        { id: 'd', action: A.REFUSED, kind: null },
        { id: 'e', action: A.NOT_OWNED, kind: 'code' },
      ],
      targetEnabled: [],
      hasCode: {},
    });
    assert.deepEqual([...r.codeInstalled, ...r.settingsOnly], []);
    assert.deepEqual(r.deferredCredential, ['c']);
    assert.deepEqual(r.refused, ['d']);
    assert.deepEqual(r.notOwned, ['e']);
  });
});

describe('projectPluginSync', () => {
  test('a COPY is enabled whatever its kind; only a code copy brings code', () => {
    const p = projectPluginSync({
      entries: ENTRIES,
      targetEnabledBefore: ['already-there'],
      hasCodeBefore: { 'already-there': true },
    });
    assert.deepEqual(p.targetEnabled, ['already-there', ...AFTER_ENABLED]);
    assert.deepEqual(p.willEnable, [...AFTER_ENABLED].sort());
    assert.equal(p.hasCode('obsidian42-brat'), true);
    assert.equal(p.hasCode('mcp-router-bridge'), false);
    assert.equal(p.hasCode('already-there'), true);
  });

  test('a skip does not enable', () => {
    const p = projectPluginSync({
      entries: [{ id: 'x', action: A.SKIP_PRESENT, kind: 'code' }],
      targetEnabledBefore: [],
      hasCodeBefore: {},
    });
    assert.deepEqual(p.willEnable, []);
    assert.equal(p.hasCode('x'), false);
  });
});

describe('formatPluginSyncReport', () => {
  const s = summarizePluginSync({
    entries: ENTRIES,
    targetEnabled: AFTER_ENABLED,
    sourceEnabled: SKELETON_ENABLED,
    hasCode: HAS_CODE_AFTER,
    bratManaged: ['mcp-router-bridge'],
  });
  const text = formatPluginSyncReport(s, { vaultPath: '/vaults/demo' }).map((l) => l.text).join('\n');

  test('never claims the settings-only plugins were synced', () => {
    assert.doesNotMatch(text, /Synced 4/);
    assert.match(text, /Code installed for 1 plugin\(s\): obsidian42-brat/);
    assert.match(text, /Settings only for 3 plugin\(s\) — code still to install: mcp-router-bridge, obsidian-icon-folder, obsidian-quiet-outline/);
  });

  test('says the enabled ids are listed on purpose and not counted', () => {
    assert.match(text, /Enabled without code — 12 plugin\(s\)/);
    assert.match(text, /NOT counted as synced/);
  });

  test('gives the manual steps AND the one-command alternative', () => {
    assert.match(text, /Settings → Community plugins → Browse/);
    assert.ok(text.includes(installPluginsCommand('/vaults/demo')), text);
    assert.match(text, /BRAT/);
  });

  test('nothing to say → no lines', () => {
    const empty = summarizePluginSync({ entries: [], targetEnabled: [], hasCode: {} });
    assert.deepEqual(formatPluginSyncReport(empty, { vaultPath: '/v' }), []);
  });
});

describe('formatPluginSyncPlan', () => {
  test('one line per plugin with kind and files, then enable / without-code', () => {
    const lines = formatPluginSyncPlan(
      [...ENTRIES, { id: 'evil', action: A.REFUSED, kind: null, files: [] }],
      { willEnable: ['obsidian42-brat'], remainWithoutCode: ['smart-connections'] },
    );
    const brat = lines.find((l) => l.startsWith('obsidian42-brat:'));
    assert.match(brat, /copy \[code\] \(data\.json, main\.js, manifest\.json\)/);
    assert.match(lines.find((l) => l.startsWith('mcp-router-bridge:')), /settings only — code still to install/);
    assert.match(lines.find((l) => l.startsWith('evil:')), /refused/);
    assert.ok(lines.includes('will enable: obsidian42-brat'));
    assert.ok(lines.includes('enabled but still without code afterwards: smart-connections'));
  });
});
