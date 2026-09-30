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
 * RETIRED CONVENTIONS. `skills/conventions/retired/` holds conventions the
 * library no longer OFFERS but must still RECOGNISE — today `bilingual`,
 * replaced by `languages` (decision `convention-languages-remplace-bilingual`).
 * A vault that still carries one must be reported "to migrate", and an audit
 * that had forgotten its heading would call it "not installed" instead: the
 * vaults that most need the migration would vanish from the report. So the
 * server's catalogue includes them, flagged `retired: true`; the picker, which
 * globs `snippets/` only, never shows them.
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

/** Beside the snippets: conventions recognised, never offered. */
export const RETIRED_DIR = path.resolve(SNIPPETS_DIR, '..', 'retired');

let cached = null;

/**
 * One directory of snippets. An ABSENT directory is an empty one only when
 * `optional` — the retired folder may legitimately not exist in a checkout
 * that has retired nothing; the library itself may not.
 */
function readDir(dir, { optional = false, retired = false } = {}) {
  const catalogue = [];
  const errors = [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')).sort();
  } catch (err) {
    if (optional && err.code === 'ENOENT') return { catalogue, errors };
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
    catalogue.push({ id: f.replace(/\.md$/i, ''), heading: first.text, ...(retired && { retired: true }) });
  }
  return { catalogue, errors };
}

/**
 * @param {string} [dir] defaults to the shipped library
 * @param {{retiredDir?: string|null}} [options] where retired conventions
 *   live; defaults to the shipped `retired/` folder when `dir` is the shipped
 *   library, and to none otherwise (a test pointing at its own library does
 *   not inherit the shipped retirements). Pass `null` to load none.
 * @returns {{catalogue: Array<{id: string, heading: string, retired?: true}>, errors: string[]}}
 *   Offered conventions first, retired ones after. An id present in BOTH
 *   folders is an error, not a merge: the same convention cannot be offered and
 *   retired at once.
 */
export function loadConventionCatalogue(dir = SNIPPETS_DIR, options = {}) {
  const shipped = dir === SNIPPETS_DIR && options.retiredDir === undefined;
  if (shipped && cached) return cached;
  const retiredDir = options.retiredDir === undefined ? (dir === SNIPPETS_DIR ? RETIRED_DIR : null) : options.retiredDir;

  const offered = readDir(dir);
  const retired = retiredDir ? readDir(retiredDir, { optional: true, retired: true }) : { catalogue: [], errors: [] };
  const errors = [...offered.errors, ...retired.errors];
  const offeredIds = new Set(offered.catalogue.map((c) => c.id));
  const kept = [];
  for (const entry of retired.catalogue) {
    if (offeredIds.has(entry.id)) {
      errors.push(`${entry.id}: present in both the library and the retired folder`);
      continue;
    }
    kept.push(entry);
  }
  const result = { catalogue: [...offered.catalogue, ...kept], errors };
  if (shipped) cached = result;
  return result;
}
