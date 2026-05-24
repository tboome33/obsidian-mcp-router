/**
 * Filter library — Wave 1 of the obsidian-clipper port (v0.13.0).
 *
 * 5 of the 17 planned Wave 1 filters shipped so far (checkpoint of
 * Phase A in [[obsidian-clipper-roadmap]]). Remaining 12 ship in
 * follow-up work:
 *   decode_uri, markdown, callout, blockquote, footnote, table,
 *   strip_tags, strip_md, image, date_modify, duration, length.
 *
 * Wave 2 (33 more filters) is Phase H backlog — activated on demand.
 * (Was "Phase G" pre-2026-05-24; shifted to H when Phase C
 * link-following was inserted before LaTeX.)
 *
 * Export shape:
 *   - Named exports (recommended): `import { slug } from '.../filters/index.mjs'`
 *   - Map export `FILTERS` for programmatic lookup by name (used by future
 *     template-engine integrations if any, and by tests that iterate the
 *     full set).
 */

import { safe_name } from './safe_name.mjs';
import { kebab } from './kebab.mjs';
import { wikilink } from './wikilink.mjs';
import { date } from './date.mjs';
import { slug } from './slug.mjs';

export { safe_name, kebab, wikilink, date, slug };

export const FILTERS = {
  safe_name,
  kebab,
  wikilink,
  date,
  slug,
};
