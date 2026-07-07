import { test } from 'node:test';
import assert from 'node:assert/strict';

import { doclingOptedIn } from '../scripts/install-docling.mjs';

test('doclingOptedIn is true only for the exact string "1"', () => {
  assert.strictEqual(doclingOptedIn({}), false);
  assert.strictEqual(doclingOptedIn({ OBSIDIAN_ROUTER_ENABLE_DOCLING: '1' }), true);
  assert.strictEqual(doclingOptedIn({ OBSIDIAN_ROUTER_ENABLE_DOCLING: 'true' }), false);
  assert.strictEqual(doclingOptedIn({ OBSIDIAN_ROUTER_ENABLE_DOCLING: '0' }), false);
  assert.strictEqual(doclingOptedIn({ OBSIDIAN_ROUTER_ENABLE_DOCLING: '' }), false);
});
