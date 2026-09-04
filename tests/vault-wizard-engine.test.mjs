// W2 review+ — pure unit tests for the shared engine bridge: arg composition,
// the `path`-starting-with-`--` rejection, and nonce'd marker parsing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeSetupVaultArgs, parseProvisionResult } from '../src/helpers/vault-wizard-engine.mjs';

test('composeSetupVaultArgs: path is argv[0], flags follow', () => {
  const args = composeSetupVaultArgs({
    path: 'C:/VAULTS/New', name: 'My Vault',
    source: { kind: 'from-vault', fromVault: 'roland', withFolderTree: true },
    plugins: { profile: 'custom', custom: ['dataview', 'x'] },
    wikiMode: { mode: 'domain', sections: ['A', 'B'] },
    open: true, probe: true, probeTimeout: 5, gitInit: true, claudeWorkspace: true, linkWorkspace: '/ws',
  });
  assert.equal(args[0], 'C:/VAULTS/New');
  assert.ok(args.includes('--name') && args.includes('My Vault'));
  assert.ok(args.includes('--from-vault') && args.includes('roland') && args.includes('--with-folder-tree'));
  assert.ok(args.includes('--plugins') && args.includes('custom:dataview,x'));
  assert.ok(args.includes('--wiki-mode') && args.includes('domain') && args.includes('--wiki-sections') && args.includes('A,B'));
  assert.ok(args.includes('--open') && args.includes('--probe') && args.includes('--probe-timeout') && args.includes('5'));
  assert.ok(args.includes('--git-init') && args.includes('--claude-workspace') && args.includes('--link-workspace'));
});

test('composeSetupVaultArgs: rejects a path that looks like a flag', () => {
  assert.throws(() => composeSetupVaultArgs({ path: '--regenerate' }), /must be a filesystem path, not a flag/);
});

test('composeSetupVaultArgs: requires path or name + validates enums', () => {
  assert.throws(() => composeSetupVaultArgs({}), /`path` or `name` \(string\) is required/);
  assert.throws(() => composeSetupVaultArgs({ path: '/v', source: { kind: 'bogus' } }), /Unknown source\.kind/);
  assert.throws(() => composeSetupVaultArgs({ path: '/v', plugins: { profile: 'bogus' } }), /Unknown plugins\.profile/);
  assert.throws(() => composeSetupVaultArgs({ path: '/v', source: { kind: 'from-vault' } }), /requires source\.fromVault/);
});

test('composeSetupVaultArgs: name alone (no path) omits the positional — the engine composes it from vaultsRoot', () => {
  const args = composeSetupVaultArgs({ name: 'Tartenpion' });
  assert.equal(args[0], '--name', 'no positional path pushed; --name is argv[0]');
  assert.ok(args.includes('Tartenpion'));
});

test('composeSetupVaultArgs: a non-string path is a type error, even when name is also given (regression)', () => {
  // A wrong-type path must never be silently swallowed as "absent" just
  // because a valid `name` happens to also be present — that would silently
  // provision at the vaultsRoot-composed location instead of refusing.
  for (const badPath of [{ evil: true }, 12345, true, ['a']]) {
    assert.throws(
      () => composeSetupVaultArgs({ path: badPath, name: 'Tartenpion' }),
      /`path` must be a string/,
      `did not reject non-string path: ${JSON.stringify(badPath)}`,
    );
  }
});

test('parseProvisionResult: matches the nonce and ignores spoofed plain markers', () => {
  const nonce = 'abc-123';
  const good = `human output\n##PROVISION_RESULT:${nonce}## ${JSON.stringify({ ok: true, port: 42 })}\nmore`;
  assert.deepEqual(parseProvisionResult(good, nonce), { ok: true, port: 42 });

  // A line with the PLAIN marker (as a malicious value could print) is ignored
  // when a nonce is expected.
  const spoof = '##PROVISION_RESULT## {"ok":false,"port":666}';
  assert.equal(parseProvisionResult(spoof, nonce), null);

  // No marker at all → null.
  assert.equal(parseProvisionResult('nothing here', nonce), null);
});

test('parseProvisionResult: plain marker for direct CLI use (no nonce)', () => {
  const out = '##PROVISION_RESULT## {"ok":true}';
  assert.deepEqual(parseProvisionResult(out), { ok: true });
});
