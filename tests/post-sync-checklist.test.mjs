/**
 * src/helpers/post-sync-checklist.mjs — the steps left in Obsidian after a sync.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPostSyncChecklist,
  BRAT_UPDATE_COMMAND_ID,
} from '../src/helpers/post-sync-checklist.mjs';

const base = {
  vaultPath: '/vaults/demo',
  withCode: ['obsidian42-brat'],
  bratPending: ['mcp-router-bridge'],
  bratHasCode: true,
  marketplaceMissing: ['smart-connections', 'templater-obsidian'],
};

describe('buildPostSyncChecklist', () => {
  test('full checklist, in order, numbered', () => {
    const lines = buildPostSyncChecklist(base);
    assert.equal(lines[0], 'Next steps in Obsidian for /vaults/demo:');
    const body = lines.slice(1);
    assert.equal(body.length, 6);
    body.forEach((l, i) => assert.ok(l.startsWith(`  ${i + 1}. `), l));
    assert.match(body[0], /Reload Obsidian/);
    assert.match(body[1], /Restricted mode/);
    assert.match(body[2], /obsidian42-brat/);
    assert.match(body[3], /BRAT "Check for updates"/);
    assert.ok(body[3].includes(BRAT_UPDATE_COMMAND_ID));
    assert.ok(body[3].includes('mcp-router-bridge'));
    assert.match(body[4], /--install-plugins "\/vaults\/demo"/);
    assert.match(body[5], /--plugin-health "\/vaults\/demo"/);
  });

  test('unknown host → both reload variants', () => {
    const reload = buildPostSyncChecklist(base)[1];
    assert.match(reload, /Reload app without saving/);
    assert.match(reload, /docker compose restart/);
  });

  test('container → container variant only, with the service when known', () => {
    const reload = buildPostSyncChecklist({ ...base, container: true, service: 'obsidian' })[1];
    assert.match(reload, /docker compose restart obsidian/);
    assert.doesNotMatch(reload, /desktop/);
  });

  test('desktop → desktop variant only', () => {
    const reload = buildPostSyncChecklist({ ...base, container: false })[1];
    assert.match(reload, /Reload app without saving/);
    assert.doesNotMatch(reload, /docker/);
  });

  test('BRAT without code → install BRAT first', () => {
    const lines = buildPostSyncChecklist({ ...base, bratHasCode: false }).join('\n');
    assert.match(lines, /Install BRAT \(obsidian42-brat\) from the marketplace/);
  });

  test('steps that do not apply are dropped and the numbering follows', () => {
    const lines = buildPostSyncChecklist({ vaultPath: '/v' });
    assert.equal(lines.length, 4, lines.join('\n'));
    assert.match(lines[3], /^ {2}3\. Verify/);
    assert.doesNotMatch(lines.join('\n'), /BRAT|install-plugins/);
  });
});
