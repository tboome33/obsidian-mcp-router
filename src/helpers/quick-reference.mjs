/**
 * quick-reference.mjs — which pages the quick-reference PDFs are built from,
 * and whether the published PDFs still match them.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A HELPER AND NOT PART OF THE RENDER SCRIPT
 * ---------------------------------------------------------------------------
 * Two callers need the same answer and must not each have their own copy of
 * it: `scripts/render-quick-reference.mjs`, which writes the record, and the
 * C8 validator in `skill-capabilities.mjs`, which refuses when the record no
 * longer matches. Two copies of "which pages exist and where their hashes
 * live" would drift, and the drifting one would be the check.
 *
 * The dependency runs script → helper, never helper → script: `src/` is what
 * ships, `scripts/` is tooling, and a shipped module must not reach into the
 * developer's toolbox to answer a question.
 *
 * Node builtins only.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** The pages this pair of artifacts covers. Adding a language starts here. */
export const QUICK_REFERENCE_PAGES = Object.freeze(['en', 'fr']);

/** Where "what the PDFs were rendered from" is recorded. */
export const QUICK_REFERENCE_MANIFEST = 'docs/quick-reference.manifest.json';

export const htmlRelPath = (lang) => `docs/quick-reference-${lang}.html`;
export const pdfRelPath = (lang) => `docs/quick-reference-${lang}.pdf`;

/** sha256 of a file's bytes, or null when it cannot be read. */
export function sha256OfFile(abs) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Read the manifest. A missing or unparseable manifest is not an error here —
 * it is "nothing has been recorded", which each caller phrases in its own
 * words.
 */
export function readQuickReferenceManifest(repoRoot) {
  try {
    const raw = fs.readFileSync(path.join(repoRoot, QUICK_REFERENCE_MANIFEST), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Compare each page's CURRENT html against the hash recorded when its PDF was
 * last rendered.
 *
 * Returns one row per page, ALWAYS. A page with nothing recorded comes back
 * `state: 'unrecorded'` rather than being silently absent: a check that skips
 * what it cannot see is precisely the shape that let both PDFs go a whole
 * catalogue behind while `npm run validate` stayed green.
 *
 * States: `fresh` · `stale` (the page moved since the render) · `unrecorded`
 * (no hash for it) · `pdf-missing` · `html-missing`.
 */
export function quickReferenceFreshness(repoRoot) {
  const manifest = readQuickReferenceManifest(repoRoot);
  const recorded = (manifest && manifest.renderedFrom) || null;
  return QUICK_REFERENCE_PAGES.map((lang) => {
    const html = htmlRelPath(lang);
    const pdf = pdfRelPath(lang);
    const actual = sha256OfFile(path.join(repoRoot, html));
    const pdfPresent = fs.existsSync(path.join(repoRoot, pdf));
    const expected = recorded ? recorded[html] : undefined;
    let state;
    if (actual === null) state = 'html-missing';
    else if (!pdfPresent) state = 'pdf-missing';
    else if (!recorded || typeof expected !== 'string') state = 'unrecorded';
    else if (expected !== actual) state = 'stale';
    else state = 'fresh';
    return { lang, html, pdf, state, expected: expected ?? null, actual };
  });
}
