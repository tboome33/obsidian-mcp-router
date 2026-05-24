import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { safe_name } from '../src/helpers/filters/safe_name.mjs';

describe('safe_name — default (conservative) mode', () => {
  test('passes through a clean ASCII name', () => {
    assert.equal(safe_name('my-article'), 'my-article');
  });

  test('strips Obsidian markup chars (# | ^ [ ])', () => {
    assert.equal(safe_name('foo#bar|baz^qux[x]y'), 'foobarbazquxxy');
  });

  test('strips Windows-forbidden chars in default mode', () => {
    assert.equal(safe_name('a<b>c:d"e/f\\g|h?i*j'), 'abcdefghij');
  });

  test('prefixes reserved Windows device names with _', () => {
    assert.equal(safe_name('CON'), '_CON');
    assert.equal(safe_name('com1.txt'), '_com1.txt');
    assert.equal(safe_name('AUX'), '_AUX');
  });

  test('strips trailing spaces and dots', () => {
    assert.equal(safe_name('hello   '), 'hello');
    assert.equal(safe_name('hello...'), 'hello');
    assert.equal(safe_name('hello . .'), 'hello');
  });

  test('replaces leading dot with _', () => {
    assert.equal(safe_name('.hidden'), '_hidden');
  });

  test('strips control chars 0x00-0x1F', () => {
    assert.equal(safe_name('a\x00b\x07c\x1fd'), 'abcd');
  });

  test('caps at 245 chars', () => {
    const long = 'x'.repeat(500);
    assert.equal(safe_name(long).length, 245);
  });

  test('returns "Untitled" when result is empty', () => {
    assert.equal(safe_name(''), 'Untitled');
    assert.equal(safe_name('////'), 'Untitled');
    assert.equal(safe_name('....'), 'Untitled');
  });
});

describe('safe_name — REGRESSION (review+ pass 1 / codex B#B): reserved-name leak after trim', () => {
  test('CON with trailing space is treated as reserved (was leaking as plain CON)', () => {
    // Before fix: `safe_name('CON ')` returned `'CON'` because:
    //   1. The reserved-name regex tested `^(con|prn|...)$` against `'CON '`
    //      → no match (trailing space).
    //   2. Then the trailing-space strip ran → `'CON'`.
    //   3. Returned a name that Windows actually rejects.
    // Fix: re-run the reserved-name + trailing-strip pair AFTER the
    // truncate so the post-strip string is also checked.
    assert.equal(safe_name('CON '), '_CON');
    assert.equal(safe_name('CON  '), '_CON');
    assert.equal(safe_name('CON\t'), '_CON');
    assert.equal(safe_name('PRN.txt '), '_PRN.txt');
    // Multiple trailing dots + space combinations.
    assert.equal(safe_name('AUX. '), '_AUX');
    assert.equal(safe_name('LPT9 . . '), '_LPT9');
  });

  test('windows mode also catches reserved-name leak after trim', () => {
    assert.equal(safe_name('CON ', 'windows'), '_CON');
    assert.equal(safe_name('NUL.dat   ', 'windows'), '_NUL.dat');
  });
});

describe('safe_name — windows mode', () => {
  test('strips only Windows-specific chars', () => {
    assert.equal(safe_name('a/b', 'windows'), 'ab');
    assert.equal(safe_name('a:b', 'windows'), 'ab');
  });

  test('does NOT convert leading dot in windows mode', () => {
    // Windows allows leading dots, only the union default converts them.
    assert.equal(safe_name('.config', 'windows'), '.config'.replace(/^\.+/, ''));
  });
});

describe('safe_name — mac mode', () => {
  test('strips slash and colon (forbidden in HFS+/APFS path components)', () => {
    assert.equal(safe_name('a/b:c', 'mac'), 'abc');
  });

  test('converts leading dot to _', () => {
    assert.equal(safe_name('.DS_Store', 'mac'), '_DS_Store');
  });
});

describe('safe_name — linux mode', () => {
  test('strips slash only', () => {
    assert.equal(safe_name('a/b', 'linux'), 'ab');
  });

  test('preserves chars Windows would strip', () => {
    assert.equal(safe_name('a:b*c?d', 'linux'), 'a:b*c?d');
  });

  test('converts leading dot to _', () => {
    assert.equal(safe_name('.bashrc', 'linux'), '_bashrc');
  });
});

describe('safe_name — unicode', () => {
  test('preserves accented and emoji chars', () => {
    assert.equal(safe_name('Bonjour à toi 🇫🇷'), 'Bonjour à toi 🇫🇷');
  });
});
