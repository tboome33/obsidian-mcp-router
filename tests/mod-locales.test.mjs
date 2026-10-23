/**
 * v0.106.0 — the vault panel's translation files (`locales/<code>.json`).
 *
 * Every language file must hold exactly the keys of fr.json (the source), with
 * the same {variables} in each value; and the French copy compiled into the
 * module (`hooks/vault-panel/locale-fr.ts`) must be what fr.json says.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderLocaleModule } from '../scripts/build-mod-locales.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'locales');
const read = (file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
const vars = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('vault panel translations', () => {
  const fr = read('fr.json');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));

  test('French and English are shipped', () => {
    assert.ok(files.includes('fr.json'));
    assert.ok(files.includes('en.json'));
  });

  for (const file of files) {
    test(`${file} holds exactly the keys of fr.json, each with the same {variables}`, () => {
      const other = read(file);
      assert.deepEqual(Object.keys(other).sort(), Object.keys(fr).sort());
      for (const key of Object.keys(fr)) {
        assert.equal(typeof other[key], 'string', `${file}: ${key} is a string`);
        assert.ok(other[key].length > 0, `${file}: ${key} is not empty`);
        assert.deepEqual(vars(other[key]), vars(fr[key]), `${file}: ${key} keeps the variables of fr.json`);
      }
      assert.ok(other['_meta.name'], `${file} names its language`);
    });
  }

  test('the French copy compiled into the module is what fr.json says', () => {
    // Line endings aside: a checkout may turn LF into CRLF.
    const compiled = fs.readFileSync(path.join(root, 'hooks', 'vault-panel', 'locale-fr.ts'), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(compiled, renderLocaleModule(fr), 'run `node scripts/build-mod-locales.mjs`');
  });
});
