/**
 * The convention library as the SERVER sees it: `{id, heading}` per snippet.
 *
 * The snippets live in `skills/conventions/snippets/`, one convention per file,
 * whose first line is the convention's identifying `## heading`. The drift
 * script has its own, stricter loader (it also fingerprints the text); the
 * server only needs to recognise a convention inside a vault's conventions
 * file, so it reads the identity and nothing else — and refuses a file whose
 * first heading is not a column-0 H2, the same refusal the drift loader makes,
 * rather than inventing an identity for it.
 *
 * Read once per process and cached: the library ships with the code and does
 * not change under a running server.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanAtxHeadings } from './markdown-headings.mjs';

export const SNIPPETS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills', 'conventions', 'snippets',
);

let cached = null;

/**
 * @param {string} [dir] defaults to the shipped library
 * @returns {{catalogue: Array<{id: string, heading: string}>, errors: string[]}}
 */
export function loadConventionCatalogue(dir = SNIPPETS_DIR) {
  if (dir === SNIPPETS_DIR && cached) return cached;
  const catalogue = [];
  const errors = [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')).sort();
  } catch (err) {
    return { catalogue, errors: [`cannot read the convention library ${dir}: ${err.message}`] };
  }
  for (const f of files) {
    let raw;
    try { raw = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (err) {
      errors.push(`cannot read ${f}: ${err.message}`);
      continue;
    }
    const first = scanAtxHeadings(raw)[0];
    if (!first || first.level !== 2 || first.indent !== 0) {
      errors.push(`${f}: first heading is not a column-0 level-2 heading`);
      continue;
    }
    catalogue.push({ id: f.replace(/\.md$/i, ''), heading: first.text });
  }
  const result = { catalogue, errors };
  if (dir === SNIPPETS_DIR) cached = result;
  return result;
}
