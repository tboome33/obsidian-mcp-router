/**
 * Tests for src/helpers/content-hash.mjs — the content fingerprint behind
 * ifMatch (C1 optimistic concurrency).
 *
 * The KNOWN VECTORS here are the SAME ones pinned by the bridge suite
 * (obsidian-mcp-router-bridge/tests/vault-cas-core.test.mjs). The router hashes
 * with node:crypto, the bridge with Web Crypto; a conditional write is only
 * correct if both produce byte-identical digests for the same input. If either
 * side ever drifts (encoding, normalization, algorithm), one of these two
 * suites breaks — the drift is caught before it ships.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { contentSha256, isContentSha256 } from '../src/helpers/content-hash.mjs';

// Shared, verbatim, with the bridge suite.
const HELLO = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const E_ACUTE = '4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c';

describe('contentSha256 (node:crypto)', () => {
  test('known vector: "hello" — MUST equal the bridge Web Crypto value', () => {
    assert.equal(contentSha256('hello'), HELLO);
  });

  test('known vector: empty string', () => {
    assert.equal(contentSha256(''), EMPTY);
  });

  test('known vector: UTF-8 multibyte "é" (hashed by bytes, not code units)', () => {
    assert.equal(contentSha256('é'), E_ACUTE);
  });

  test('CRLF and LF differ — no line-ending normalization', () => {
    assert.notEqual(contentSha256('a\r\nb'), contentSha256('a\nb'));
  });

  test('a LEADING BOM is stripped → equals the BOM-free hash (matches res.text())', () => {
    // The load-bearing alignment: get_file reads via res.text() (strips BOM),
    // the bridge reads via adapter.read() (keeps BOM). Both hash cores strip
    // the leading BOM so a BOM-prefixed file is not permanently unwritable via
    // the atomic tier. A regression here reintroduces the spurious-409 bug.
    assert.equal(contentSha256('﻿hello'), HELLO);
    assert.equal(contentSha256('﻿'), EMPTY);
  });

  test('a NON-leading U+FEFF is NOT stripped (only the BOM position)', () => {
    assert.notEqual(contentSha256('a﻿b'), contentSha256('ab'));
  });

  test('a trailing newline changes the hash — nothing is trimmed', () => {
    assert.notEqual(contentSha256('x'), contentSha256('x\n'));
  });

  test('pinned LARGE-content vector — no truncation at scale (matches bridge suite)', () => {
    // A self-comparison would stay green if large input were truncated or the
    // digest constant (codex #11) — pin the exact digest instead.
    assert.equal(
      contentSha256('wiki '.repeat(10000)),
      '37807f83aa437c33db5eeb3520550e3c0cb50b114aae97e78d8175188cbd4278',
    );
  });

  test('pinned astral vectors (surrogate pairs) — MUST match the bridge suite (codex #12)', () => {
    assert.equal(
      contentSha256('é🙂'),
      '7382f537af6a53054b6a72792df00fa0be0f5d2e8214db9cd6ebbcc3d57d02b9',
    );
    assert.equal(
      contentSha256('a🙂b'),
      'ff39f0ecaa28603997510830e3bcd1953150e1ac44cb8637bbbcd2270112a7cd',
    );
  });

  test('rejects non-string input', () => {
    assert.throws(() => contentSha256(123), /must be a string/);
    assert.throws(() => contentSha256(null), /must be a string/);
    assert.throws(() => contentSha256(undefined), /must be a string/);
  });
});

describe('isContentSha256', () => {
  test('accepts a 64-hex lowercase digest', () => {
    assert.equal(isContentSha256(HELLO), true);
    assert.equal(isContentSha256(contentSha256('anything')), true);
  });

  test('rejects uppercase, wrong length, non-hex, and non-strings', () => {
    assert.equal(isContentSha256(HELLO.toUpperCase()), false);
    assert.equal(isContentSha256(HELLO.slice(0, 63)), false);
    assert.equal(isContentSha256(HELLO + '00'), false);
    assert.equal(isContentSha256('g'.repeat(64)), false);
    assert.equal(isContentSha256(''), false);
    assert.equal(isContentSha256(null), false);
    assert.equal(isContentSha256(42), false);
  });
});
