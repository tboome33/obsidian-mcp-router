import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { wikilink } from '../src/helpers/filters/wikilink.mjs';

describe('wikilink', () => {
  test('wraps a basename in [[...]]', () => {
    assert.equal(wikilink('foo'), '[[foo]]');
  });

  test('adds an alias with pipe syntax', () => {
    assert.equal(wikilink('foo', 'Bar'), '[[foo|Bar]]');
  });

  test('strips surrounding double quotes from alias', () => {
    assert.equal(wikilink('foo', '"Bar"'), '[[foo|Bar]]');
  });

  test('strips surrounding single quotes from alias', () => {
    assert.equal(wikilink('foo', "'Bar'"), '[[foo|Bar]]');
  });

  test('strips wrapping parens from alias', () => {
    assert.equal(wikilink('foo', '("Bar")'), '[[foo|Bar]]');
  });

  test('empty string returns empty', () => {
    assert.equal(wikilink(''), '');
  });

  test('whitespace-only returns the whitespace (no wrap)', () => {
    assert.equal(wikilink('   '), '   ');
  });

  test('preserves spaces in basename (Obsidian wikilinks allow them)', () => {
    assert.equal(wikilink('my note'), '[[my note]]');
  });

  test('preserves accented chars and unicode', () => {
    assert.equal(wikilink('Bonjour à toi'), '[[Bonjour à toi]]');
  });
});
