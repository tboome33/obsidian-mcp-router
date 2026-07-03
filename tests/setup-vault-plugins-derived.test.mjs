// W0.2 — the plugin clone list derives from the source vault's own
// community-plugins.json (union REQUIRED), killing the "activated but never
// cloned" drift. Unit-tests the pure resolver (scripts/plugin-resolver.mjs) so
// no CLI dispatch is triggered.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolvePluginsToClone } from '../scripts/plugin-resolver.mjs';

const REQUIRED = ['obsidian-local-rest-api', 'mcp-router-bridge'];

function makeRef(plugins) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ref-'));
  fs.mkdirSync(path.join(tmp, '.obsidian'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, '.obsidian', 'community-plugins.json'),
    JSON.stringify(plugins));
  return tmp;
}

test('derives clone list from source community-plugins.json + REQUIRED', () => {
  const ref = makeRef(['smart-connections', 'realclaudian', 'obsidian42-brat']);
  try {
    const list = resolvePluginsToClone(ref, REQUIRED);
    for (const req of REQUIRED) assert.ok(list.includes(req), `REQUIRED ${req} present`);
    assert.ok(list.includes('smart-connections'));
    assert.ok(list.includes('realclaudian'), 'source-enabled plugin propagated (drift fix)');
    assert.ok(list.includes('obsidian42-brat'));
    assert.equal(new Set(list).size, list.length, 'deduped');
    // REQUIRED come first, preserving their order.
    assert.deepEqual(list.slice(0, 2), REQUIRED);
  } finally {
    fs.rmSync(ref, { recursive: true, force: true });
  }
});

test('a source that also lists a REQUIRED plugin does not duplicate it', () => {
  const ref = makeRef(['obsidian-local-rest-api', 'smart-connections']);
  try {
    const list = resolvePluginsToClone(ref, REQUIRED);
    const count = list.filter((p) => p === 'obsidian-local-rest-api').length;
    assert.equal(count, 1, 'REQUIRED plugin listed in source is not duplicated');
  } finally {
    fs.rmSync(ref, { recursive: true, force: true });
  }
});

test('missing community-plugins.json falls back to REQUIRED only', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ref-'));
  try {
    assert.deepEqual(resolvePluginsToClone(tmp, REQUIRED), REQUIRED);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('malformed community-plugins.json falls back to REQUIRED only', () => {
  const ref = fs.mkdtempSync(path.join(os.tmpdir(), 'ref-'));
  try {
    fs.mkdirSync(path.join(ref, '.obsidian'), { recursive: true });
    fs.writeFileSync(path.join(ref, '.obsidian', 'community-plugins.json'), '{ not json');
    assert.deepEqual(resolvePluginsToClone(ref, REQUIRED), REQUIRED);
  } finally {
    fs.rmSync(ref, { recursive: true, force: true });
  }
});

test('non-string / empty entries in community-plugins.json are ignored', () => {
  const ref = makeRef(['smart-connections', '', null, 42, 'templater-obsidian']);
  try {
    const list = resolvePluginsToClone(ref, REQUIRED);
    assert.ok(list.includes('smart-connections'));
    assert.ok(list.includes('templater-obsidian'));
    assert.ok(!list.includes(''), 'empty string ignored');
    assert.ok(!list.some((p) => typeof p !== 'string'), 'no non-string entries');
  } finally {
    fs.rmSync(ref, { recursive: true, force: true });
  }
});

test('empty requiredPlugins + empty source → empty list (no crash)', () => {
  const ref = makeRef([]);
  try {
    assert.deepEqual(resolvePluginsToClone(ref, []), []);
    assert.deepEqual(resolvePluginsToClone(ref), []);
  } finally {
    fs.rmSync(ref, { recursive: true, force: true });
  }
});
