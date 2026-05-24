import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { slug } from '../src/helpers/filters/slug.mjs';

describe('slug', () => {
  test('lowercases and joins with -', () => {
    assert.equal(slug('Hello World'), 'hello-world');
  });

  test('ASCII-folds accented chars', () => {
    assert.equal(slug('Bonjour à toi'), 'bonjour-a-toi');
    assert.equal(slug('Éléonore'), 'eleonore');
    assert.equal(slug('Crème brûlée'), 'creme-brulee');
  });

  test('strips Obsidian markup chars', () => {
    assert.equal(slug('foo#bar|baz^qux[x]y'), 'foobarbazquxxy');
  });

  test('collapses non-alphanumeric runs to single -', () => {
    assert.equal(slug('foo !! bar !! baz'), 'foo-bar-baz');
    assert.equal(slug('a---b___c   d'), 'a-b-c-d');
  });

  test('trims leading and trailing -', () => {
    assert.equal(slug('---hello---'), 'hello');
    assert.equal(slug('!!hello!!'), 'hello');
  });

  test('empty string returns "untitled"', () => {
    assert.equal(slug(''), 'untitled');
  });

  test('only-punctuation returns "untitled"', () => {
    assert.equal(slug('!!!---???'), 'untitled');
  });

  test('caps at maxLen (default 80)', () => {
    const long = 'a'.repeat(200);
    assert.equal(slug(long).length, 80);
  });

  test('respects custom maxLen', () => {
    assert.equal(slug('hello world this is long', { maxLen: 11 }), 'hello-world');
  });

  test('preserves digits', () => {
    assert.equal(slug('Version 2 Beta'), 'version-2-beta');
  });

  test('emoji stripped (not alphanumeric)', () => {
    assert.equal(slug('Hello 🇫🇷 World'), 'hello-world');
  });

  test('REGRESSION (review+ pass 2 / codex G): truncating on a separator does not leave a trailing -', () => {
    // Pre-pass-3 bug: `slice(0, maxLen)` could land on a `-` (the
    // separator inserted between words). The edge-trim happened BEFORE
    // the slice, so the resulting slug ended in `-`, violating the
    // "no leading/trailing hyphen" contract. Fix: re-trim after slice.
    // Case 1: 79-char word + space + 'b', maxLen=80 → would have been
    // `aaa...aaa-` (80 chars ending in `-`). Now: `aaa...aaa` (79 chars).
    const out1 = slug('a'.repeat(79) + ' b', { maxLen: 80 });
    assert.equal(out1.length, 79);
    assert.equal(out1.endsWith('-'), false);
    // Case 2: maxLen falls exactly on a separator.
    const out2 = slug('hello world this is long', { maxLen: 12 });
    // "hello-world-" → trimmed to "hello-world"
    assert.equal(out2, 'hello-world');
    assert.equal(out2.endsWith('-'), false);
  });

  test('typical use case — article title → filename slug', () => {
    assert.equal(
      slug("A Recipe for Training Neural Networks — Andrej Karpathy"),
      'a-recipe-for-training-neural-networks-andrej-karpathy',
    );
  });
});
