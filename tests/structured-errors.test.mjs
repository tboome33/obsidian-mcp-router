/**
 * Tests for structured error classification (v0.20.0, MCP standard #4) —
 * src/error-classify.mjs `classifyError`.
 *
 * The high-value case is RestApiError `kind: 'unreachable' | 'timeout' |
 * 'server_error'` → transient + isRetryable:true, which lets an agent auto-retry
 * a transient WireGuard drop instead of failing the whole call. Permission /
 * validation are non-retryable.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { classifyError, KIND_TO_CATEGORY } from '../src/error-classify.mjs';
import { RestApiError } from '../src/rest-client.mjs';

describe('classifyError — RestApiError kind taxonomy', () => {
  // Kinds mirror src/rest-client.mjs (categorizeFetchError / categorizeHttpStatus).
  const cases = [
    ['unreachable', 'transient', true],
    ['timeout', 'transient', true],
    ['server_error', 'transient', true],
    ['unauthorized', 'permission', false],
    ['forbidden', 'permission', false],
    ['cf_access', 'permission', false],
    ['not_found', 'validation', false],
    ['conflict', 'validation', false],
    ['unknown', 'unknown', false],
  ];

  for (const [kind, category, retryable] of cases) {
    test(`kind "${kind}" → ${category} / isRetryable=${retryable}`, () => {
      const err = new RestApiError('boom', { kind, vaultName: 'v' });
      const out = classifyError(err);
      assert.equal(out.errorCategory, category);
      assert.equal(out.isRetryable, retryable);
    });
  }

  test('an unrecognized kind falls back to unknown / not retryable', () => {
    const err = new RestApiError('weird', { kind: 'teapot' });
    const out = classifyError(err);
    assert.equal(out.errorCategory, 'unknown');
    assert.equal(out.isRetryable, false);
  });

  test('KIND_TO_CATEGORY covers every kind documented in rest-client.mjs', () => {
    // Guard against drift: if a new kind is added to rest-client without a
    // mapping here, this list is the checklist to update.
    const documented = [
      'unreachable', 'timeout', 'unauthorized', 'forbidden', 'cf_access',
      'not_found', 'conflict', 'server_error', 'unknown',
    ];
    for (const k of documented) {
      assert.ok(KIND_TO_CATEGORY[k], `missing mapping for kind "${k}"`);
    }
  });
});

describe('classifyError — internal plain Error messages', () => {
  test('vault lock → permission, not retryable', () => {
    const out = classifyError(new Error('Router is locked to vault "alpha". Cannot operate on "beta".'));
    assert.equal(out.errorCategory, 'permission');
    assert.equal(out.isRetryable, false);
  });

  test('READONLY mode → permission, not retryable', () => {
    const out = classifyError(new Error('READONLY mode: write_file is a write tool and this router instance is read-only.'));
    assert.equal(out.errorCategory, 'permission');
    assert.equal(out.isRetryable, false);
  });

  test('vault not reachable from this workspace (vaultReach: "declared") → permission, not retryable', () => {
    const out = classifyError(new Error(
      'Vault "reference" is registered but not reachable from this workspace (vaultReach: "declared" is '
      + 'active, and this workspace\'s binding does not name it, nor is it in `openVaults`). Bind this '
      + 'workspace to it with confirm_workspace_binding, add it to `openVaults` in config.json, or address '
      + 'a vault this workspace already declares.',
    ));
    assert.equal(out.errorCategory, 'permission');
    assert.equal(out.isRetryable, false);
  });

  test('lock_vault refusing an unreachable target also classifies as permission', () => {
    const out = classifyError(new Error(
      'lock_vault: cannot lock to "reference" — it is registered but not reachable from this workspace '
      + '(vaultReach: "declared" is active, and this workspace\'s binding does not name it, nor is it in '
      + '`openVaults`). Locking to it would refuse every subsequent call until unlock. Bind this workspace '
      + 'to it with confirm_workspace_binding first, or add it to `openVaults` in config.json.',
    ));
    assert.equal(out.errorCategory, 'permission');
    assert.equal(out.isRetryable, false);
  });

  test('unknown vault → validation, not retryable', () => {
    const out = classifyError(new Error('Unknown vault "ghost". Known vaults: alpha, beta.'));
    assert.equal(out.errorCategory, 'validation');
    assert.equal(out.isRetryable, false);
  });

  test('missing API key → validation, not retryable', () => {
    const out = classifyError(new Error('Vault "x" has no API key on disk.'));
    assert.equal(out.errorCategory, 'validation');
    assert.equal(out.isRetryable, false);
  });

  test('no vault specified → validation', () => {
    const out = classifyError(new Error('No vault specified and no default vault is configured.'));
    assert.equal(out.errorCategory, 'validation');
  });
});

describe('classifyError — defensive fallbacks', () => {
  test('a generic Error with no recognizable signal → unknown, not retryable', () => {
    const out = classifyError(new Error('something totally unexpected'));
    assert.equal(out.errorCategory, 'unknown');
    assert.equal(out.isRetryable, false);
  });

  test('null / undefined / non-error input is safe → unknown', () => {
    for (const bad of [null, undefined, {}, 'a string', 42]) {
      const out = classifyError(bad);
      assert.equal(out.errorCategory, 'unknown');
      assert.equal(out.isRetryable, false);
    }
  });
});
