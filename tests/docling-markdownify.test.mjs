import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveDoclingPath } from '../src/markdownify/utils.mjs';

test('resolveDoclingPath honors DOCLING_PATH override, else returns a non-empty string', () => {
  const old = process.env.DOCLING_PATH;
  try {
    process.env.DOCLING_PATH = '/custom/docling';
    assert.strictEqual(resolveDoclingPath('/whatever'), '/custom/docling');
  } finally {
    if (old !== undefined) process.env.DOCLING_PATH = old;
    else delete process.env.DOCLING_PATH;
  }
  // No override + no bundled venv on a throwaway root → bare 'docling'.
  delete process.env.DOCLING_PATH;
  assert.strictEqual(resolveDoclingPath('/nonexistent-root-xyz'), 'docling');
});
