/**
 * Filter library — Wave 1 of the obsidian-clipper port (v0.13.0 +
 * v0.13.5 A.1 completion).
 *
 * All 17 Wave-1 filters now shipped:
 *
 *   Filename/slug    : safe_name, slug, kebab, wikilink
 *   URL              : decode_uri
 *   Markdown enriched: markdown, callout, blockquote, footnote, table
 *                      strip_tags, strip_md, image
 *   Dates            : date, date_modify, duration
 *   Misc             : length
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
import { decode_uri } from './decode_uri.mjs';
import { markdown } from './markdown.mjs';
import { callout } from './callout.mjs';
import { blockquote } from './blockquote.mjs';
import { footnote } from './footnote.mjs';
import { table } from './table.mjs';
import { strip_tags } from './strip_tags.mjs';
import { strip_md } from './strip_md.mjs';
import { image } from './image.mjs';
import { date_modify } from './date_modify.mjs';
import { duration } from './duration.mjs';
import { length } from './length.mjs';

export {
  safe_name, kebab, wikilink, date, slug,
  decode_uri, markdown, callout, blockquote, footnote, table,
  strip_tags, strip_md, image, date_modify, duration, length,
};

export const FILTERS = {
  safe_name,
  kebab,
  wikilink,
  date,
  slug,
  decode_uri,
  markdown,
  callout,
  blockquote,
  footnote,
  table,
  strip_tags,
  strip_md,
  image,
  date_modify,
  duration,
  length,
};
