import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { kebab } from '../src/helpers/filters/kebab.mjs';

describe('kebab', () => {
  test('lowercases already-clean text', () => {
    assert.equal(kebab('foo bar'), 'foo-bar');
  });

  test('camelCase → kebab-case', () => {
    assert.equal(kebab('fooBar'), 'foo-bar');
    assert.equal(kebab('myAwesomeThing'), 'my-awesome-thing');
  });

  test('collapses whitespace and underscores', () => {
    assert.equal(kebab('foo___bar   baz'), 'foo-bar-baz');
    assert.equal(kebab('foo_bar baz_qux'), 'foo-bar-baz-qux');
  });

  test('consecutive caps collapse (matches Clipper behavior)', () => {
    // No boundary between HTTP and Request → "httprequest", not "h-t-t-p-request".
    // This is documented Clipper behavior and we match it for parity.
    assert.equal(kebab('HTTPRequest'), 'httprequest');
  });

  test('already-kebab passes through unchanged', () => {
    assert.equal(kebab('already-kebab-case'), 'already-kebab-case');
  });

  test('empty string returns empty', () => {
    assert.equal(kebab(''), '');
  });

  test('numeric chars preserved', () => {
    assert.equal(kebab('version2 Beta'), 'version2-beta');
  });
});
