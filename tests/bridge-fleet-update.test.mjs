/**
 * Tests for the pure decision core of scripts/bridge-fleet-update.mjs —
 * classifyBridge decides, per vault, whether the on-disk bridge manifest is
 * behind the target release (→ trigger BRAT) or not. The I/O shell (registry
 * scan, REST trigger, --wait polling) is deliberately thin around it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBridge } from '../scripts/bridge-fleet-update.mjs';

describe('classifyBridge', () => {
  test('older local → stale (the trigger case)', () => {
    assert.equal(classifyBridge('0.6.0', '0.7.0'), 'stale');
    assert.equal(classifyBridge('0.5.1', '0.7.0'), 'stale');
    assert.equal(classifyBridge('0.7.0', '0.7.1'), 'stale');
    assert.equal(classifyBridge('0.7.0', '1.0.0'), 'stale');
  });

  test('equal → up-to-date, never triggered', () => {
    assert.equal(classifyBridge('0.7.0', '0.7.0'), 'up-to-date');
  });

  test('newer local (dev checkout ahead of the release) → ahead, never downgraded', () => {
    assert.equal(classifyBridge('0.8.0', '0.7.0'), 'ahead');
  });

  test('no manifest on disk → missing (bridge not installed; not our job here)', () => {
    assert.equal(classifyBridge(null, '0.7.0'), 'missing');
    assert.equal(classifyBridge(undefined, '0.7.0'), 'missing');
  });

  test('garbage versions → unparseable, fail-closed (no trigger)', () => {
    assert.equal(classifyBridge('not-a-version', '0.7.0'), 'unparseable');
    assert.equal(classifyBridge('0.7.0', 'garbage'), 'unparseable');
  });

  test('v-prefixed input is tolerated by the semver parser', () => {
    assert.equal(classifyBridge('v0.6.0', '0.7.0'), 'stale');
    assert.equal(classifyBridge('v0.7.0', '0.7.0'), 'up-to-date');
  });
});
