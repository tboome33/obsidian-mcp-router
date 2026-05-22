import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseSemver, compareSemver } from '../src/helpers/semver-compare.mjs';

describe('parseSemver', () => {
  test('parses basic X.Y.Z', () => {
    assert.deepEqual(parseSemver('0.10.2'), {
      major: 0,
      minor: 10,
      patch: 2,
      prerelease: '',
    });
  });

  test('strips leading v', () => {
    assert.deepEqual(parseSemver('v1.2.3'), {
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: '',
    });
  });

  test('parses prerelease suffix', () => {
    assert.deepEqual(parseSemver('1.0.0-alpha.1'), {
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: 'alpha.1',
    });
  });

  test('trims whitespace', () => {
    assert.deepEqual(parseSemver('  0.10.2  '), {
      major: 0,
      minor: 10,
      patch: 2,
      prerelease: '',
    });
  });

  test('handles double-digit segments', () => {
    assert.deepEqual(parseSemver('12.345.6789'), {
      major: 12,
      minor: 345,
      patch: 6789,
      prerelease: '',
    });
  });

  test('returns null on unparseable input', () => {
    assert.equal(parseSemver('not-semver'), null);
    assert.equal(parseSemver('1.2'), null);
    assert.equal(parseSemver('1.2.3.4'), null);
    assert.equal(parseSemver(''), null);
  });

  test('returns null on non-string input', () => {
    assert.equal(parseSemver(null), null);
    assert.equal(parseSemver(undefined), null);
    assert.equal(parseSemver(42), null);
    assert.equal(parseSemver({}), null);
  });
});

describe('compareSemver', () => {
  test('equal versions return 0', () => {
    assert.equal(compareSemver('0.10.2', '0.10.2'), 0);
    assert.equal(compareSemver('1.0.0', '1.0.0'), 0);
  });

  test('major version dominates', () => {
    assert.ok(compareSemver('1.0.0', '0.99.99') > 0);
    assert.ok(compareSemver('0.99.99', '1.0.0') < 0);
  });

  test('minor version when major equal', () => {
    assert.ok(compareSemver('0.10.0', '0.9.99') > 0);
    assert.ok(compareSemver('0.9.99', '0.10.0') < 0);
  });

  test('patch version when major+minor equal', () => {
    assert.ok(compareSemver('0.10.2', '0.10.1') > 0);
    assert.ok(compareSemver('0.10.1', '0.10.2') < 0);
  });

  test('the v0.10 vs v0.9 trap (numeric not lexicographic)', () => {
    // String comparison would say "0.9" > "0.10" because '9' > '1'.
    // Semver comparison must say "0.10" > "0.9".
    assert.ok(compareSemver('0.10.0', '0.9.0') > 0);
    assert.ok(compareSemver('0.10.2', '0.9.99') > 0);
  });

  test('prerelease is older than same X.Y.Z without suffix', () => {
    assert.ok(compareSemver('1.0.0-alpha', '1.0.0') < 0);
    assert.ok(compareSemver('1.0.0', '1.0.0-alpha') > 0);
  });

  test('both prereleases of same X.Y.Z return 0 (narrow comparison)', () => {
    // We don't sort across prerelease values — that's out of scope.
    assert.equal(compareSemver('1.0.0-alpha.1', '1.0.0-alpha.2'), 0);
  });

  test('unparseable input falls back to 0 (safe)', () => {
    assert.equal(compareSemver('not-semver', '1.0.0'), 0);
    assert.equal(compareSemver('1.0.0', 'not-semver'), 0);
    assert.equal(compareSemver(null, '1.0.0'), 0);
  });

  test('strips v prefix on both sides', () => {
    assert.equal(compareSemver('v0.10.2', '0.10.2'), 0);
    assert.ok(compareSemver('v0.10.3', 'v0.10.2') > 0);
  });

  test('regression — the exact comparison the update hook performs', () => {
    // hook: compareSemver(latestFromGitHub, installedLocally)
    //  > 0 means there's an update
    //  ≤ 0 means up to date or local is ahead

    // user installed 0.10.2, github has 0.10.3 → update available
    assert.ok(compareSemver('0.10.3', '0.10.2') > 0);

    // user installed 0.10.3, github also 0.10.3 → no update
    assert.ok(compareSemver('0.10.3', '0.10.3') <= 0);

    // user is on dev install ahead of main → no update notice
    assert.ok(compareSemver('0.10.2', '0.10.3-dev') <= 0);
  });
});
