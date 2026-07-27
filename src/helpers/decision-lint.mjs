/**
 * Decision lint — validate the decision layer of a wiki (ADR discipline).
 *
 * Checks the frontmatter contract that `decision` / `adr` / `decision-input`
 * pages must satisfy once a vault adopts the decision discipline:
 *
 *   1. `status` is present and one of proposed | accepted | superseded |
 *      rejected. Legacy free-form values (`active`, `decided`, `captured`,
 *      `awaiting-validation`) are reported WITH the normalized value to
 *      migrate to, so the caller can propose a concrete fix.
 *   2. `supersedes:` is BIDIRECTIONALLY coherent — the target exists, is
 *      itself a decision page, and carries `status: superseded`. A dangling
 *      or still-`accepted` target means two contradictory decisions are live
 *      at once, which is exactly what the discipline exists to prevent.
 *   3. `affects:` targets resolve (the "if I change, review that" loop).
 *   4. The charter fields are present: `scope:` (a decision without a
 *      perimeter applies everywhere, therefore badly) and, for
 *      context-dependent decisions, a well-formed `review_after:` — the
 *      anti-ossification field. An expired one is surfaced so a recall layer
 *      can present the decision as "to re-evaluate" rather than as a binding
 *      constraint.
 *
 * Calibration. ERRORS are states where the decision layer actively misleads
 * a reader (missing/invalid status, incoherent supersession, cycles).
 * WARNINGS are degradations that still leave the layer usable (missing
 * scope, unresolvable `affects:` target, expired review date). INFO is
 * advisory (no `evidence:` backing).
 *
 * Corpus-scoped by design: every cross-page rule resolves ONLY against the
 * pages handed in. Linting a subfolder therefore cannot claim a link is
 * dead — that is why `superseded-without-successor` is a warning and not an
 * error: the successor may simply live outside the slice being linted.
 *
 * Pure-functional: no I/O. The caller reads the pages and passes them in.
 */

import { parseFrontmatter } from './llms-txt-exporter.mjs';

/** Frontmatter `type` values that put a page under decision discipline. */
export const DECISION_TYPES = new Set(['decision', 'adr', 'decision-input']);

/**
 * The subset that records a VERDICT. A `decision-input` is material feeding
 * a decision — asking it what it ruled out is a category error, so the
 * "alternatives considered" rule applies to these types only. (The recall
 * hook draws the same line for the same reason: an input is not a ruling.)
 */
export const VERDICT_TYPES = new Set(['decision', 'adr']);

/** The only `status` values a decision page may carry. */
export const VALID_STATUSES = ['proposed', 'accepted', 'superseded', 'rejected'];

/**
 * Free-form statuses observed in the wild, mapped to their normalized
 * equivalent. Used to turn a `status-invalid` finding into an actionable
 * migration hint instead of a bare rejection.
 */
export const LEGACY_STATUS_MAP = {
  active: 'accepted',
  decided: 'accepted',
  validated: 'accepted',
  done: 'accepted',
  shipped: 'accepted',
  implemented: 'accepted',
  captured: 'proposed',
  draft: 'proposed',
  'awaiting-validation': 'proposed',
  pending: 'proposed',
  obsolete: 'superseded',
  deprecated: 'superseded',
  abandoned: 'rejected',
  declined: 'rejected',
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/**
 * Heading texts that open the "what we ruled out" section, normalized
 * (lowercased, accents stripped, punctuation and emoji dropped). Matched as
 * a PREFIX so decorated variants — `## Alternatives considered · Options
 * écartées`, the bilingual form this vault family writes — still count.
 *
 * Both languages are listed because the convention that ships with the
 * router is bilingual: an FR-only vault must not be told its perfectly
 * good `## Options écartées` section is missing.
 */
const ALTERNATIVES_HEADINGS = [
  'alternatives considered',
  'alternative considered',
  'considered options',
  'why not something else',
  'alternatives envisagees',
  'alternatives ecartees',
  'options envisagees',
  'options ecartees',
  'option ecartee',
  'options rejetees',
  'pourquoi pas autre chose',
];

function finding(rule, path, detail, extra = {}) {
  return { rule, path, detail, ...extra };
}

/**
 * Normalize a frontmatter value that may be a scalar, an array, or a
 * comma-separated string into an array of trimmed non-empty strings.
 */
function toList(value) {
  if (value == null) return [];
  const raw = Array.isArray(value) ? value : String(value).split(',');
  return raw
    .map((item) => String(item).trim())
    .filter((item) => item.length > 0);
}

/**
 * Reduce a link reference to the key used for resolution. Accepts
 * `[[basename]]`, `[[folder/basename|alias]]`, `folder/basename.md`, or a
 * bare basename — all collapse to the lowercased basename without
 * extension, matching Obsidian's own basename-first resolution (which is
 * why moving a file never breaks a wikilink).
 *
 * Bracket stripping is deliberately lenient (leading `[`s and trailing `]`s
 * rather than a well-formed `[[...]]` match): `parseFrontmatter` reads an
 * unquoted `supersedes: [[a]], [[b]]` line as a YAML flow sequence and hands
 * back the bracket-mangled items `[a]]` and `[[b]` — a real authoring
 * mistake that must still resolve to `a` and `b` instead of silently
 * reporting two dead targets.
 */
export function linkKey(reference) {
  const text = String(reference)
    .trim()
    .replace(/^\[+/, '')
    .replace(/\]+$/, '');
  const [target] = text.split('|');
  const segments = target.trim().split(/[/\\]/);
  const basename = segments[segments.length - 1] || '';
  const [anchorless] = basename.split('#');
  return anchorless.trim().replace(/\.md$/i, '').toLowerCase();
}

function pageKey(path) {
  return linkKey(path);
}

/**
 * Is this reference explicitly pointing at ANOTHER vault (`kiviri:wiki/…`)?
 *
 * Such a reference must never be resolved against the local corpus: basename
 * resolution would happily match a same-named page here, and then demand a
 * reciprocity that cannot exist across vaults. Matches a `slug:` prefix
 * before any path separator — `[[Titre: sous-titre]]` (a colon inside a
 * note name, after a space) is not one.
 */
export function isExternalReference(reference) {
  const text = String(reference).trim().replace(/^\[+/, '');
  const [head] = text.split(/[/\\]/);
  return /^[A-Za-z0-9][\w-]*:/.test(head) && !/^https?:/i.test(text);
}

/** Lowercase, strip accents, drop everything that isn't a letter or space. */
function normalizeHeading(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Locate the "what we ruled out" section in a decision body.
 *
 * @returns {{found: boolean, empty: boolean, heading: string|null}}
 *   `empty` is true when the heading exists but nothing but blank lines
 *   follows before the next heading — the case that matters, because the
 *   escape hatch ("no serious alternative" + why) has to be WRITTEN. A bare
 *   heading satisfies a naive "is the section there?" check while carrying
 *   exactly zero of the information the section exists for.
 */
export function findAlternativesSection(body) {
  const lines = String(body ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const match = HEADING_RE.exec(lines[i]);
    if (!match) continue;
    const level = match[1].length;
    const normalized = normalizeHeading(match[2]);
    if (!ALTERNATIVES_HEADINGS.some((phrase) => normalized.startsWith(phrase))) continue;

    // Walk forward to the next heading of the same or a higher level.
    let empty = true;
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = HEADING_RE.exec(lines[j]);
      if (next && next[1].length <= level) break;
      if (lines[j].trim().length > 0) {
        empty = false;
        break;
      }
    }
    return { found: true, empty, heading: match[2].trim() };
  }
  return { found: false, empty: false, heading: null };
}

/**
 * Lint the decision pages of a corpus.
 *
 * @param {Array<{path: string, content?: string, frontmatter?: object}>} pages
 *   Every page of the corpus (not only the decision ones — non-decision
 *   pages are still needed to resolve `affects:` targets). Pass `content`
 *   to have the frontmatter parsed here, or a pre-parsed `frontmatter`.
 * @param {{today?: string}} [options] `today` (ISO `YYYY-MM-DD`) drives the
 *   `review-after-expired` check; defaults to the current date. Injectable
 *   so callers and tests stay deterministic.
 * @returns {{ok: boolean, errors: object[], warnings: object[], info: object[], stats: object}}
 */
export function lintDecisions(pages, options = {}) {
  if (!Array.isArray(pages)) {
    throw new TypeError('lintDecisions expects an array of pages');
  }
  const today = options.today ?? new Date().toISOString().slice(0, 10);

  const errors = [];
  const warnings = [];
  const info = [];

  // Index every page of the corpus, decision or not: `affects:` legitimately
  // points at user stories, specs and plain notes.
  const byKey = new Map();
  const parsed = [];
  for (const page of pages) {
    if (!page || typeof page.path !== 'string') continue;
    const hasContent = typeof page.content === 'string' && page.content.length > 0;
    const parsedContent = hasContent ? parseFrontmatter(page.content) : null;
    const frontmatter = page.frontmatter ?? parsedContent?.frontmatter ?? {};
    // `body` stays null for frontmatter-only callers so the body rules can
    // skip them instead of reporting a missing section they cannot see.
    const entry = { path: page.path, frontmatter, body: parsedContent?.body ?? null };
    parsed.push(entry);
    const key = pageKey(page.path);
    if (!byKey.has(key)) byKey.set(key, entry);
  }

  const decisions = parsed.filter((entry) =>
    DECISION_TYPES.has(String(entry.frontmatter.type ?? '').trim().toLowerCase()),
  );

  // Reverse index: which decisions claim to supersede a given page.
  const supersededBy = new Map();
  for (const entry of decisions) {
    for (const reference of toList(entry.frontmatter.supersedes)) {
      const key = linkKey(reference);
      if (!supersededBy.has(key)) supersededBy.set(key, []);
      supersededBy.get(key).push(entry.path);
    }
  }

  for (const entry of decisions) {
    const { path, frontmatter } = entry;
    const status = String(frontmatter.status ?? '').trim();
    const statusKey = status.toLowerCase();

    // --- Rule 1: status ---------------------------------------------------
    if (!status) {
      errors.push(
        finding('status-missing', path, 'decision page has no `status:` — add one of ' + VALID_STATUSES.join(' | ')),
      );
    } else if (!VALID_STATUSES.includes(statusKey)) {
      const suggestion = LEGACY_STATUS_MAP[statusKey];
      errors.push(
        finding(
          'status-invalid',
          path,
          suggestion
            ? `status \`${status}\` is not normalized — migrate to \`${suggestion}\``
            : `status \`${status}\` is not one of ${VALID_STATUSES.join(' | ')}`,
          suggestion ? { suggestion } : {},
        ),
      );
    }

    // --- Rule 2: supersedes coherence ------------------------------------
    const ownKey = pageKey(path);
    for (const reference of toList(frontmatter.supersedes)) {
      const key = linkKey(reference);
      if (key === ownKey) {
        errors.push(finding('supersedes-self', path, 'page supersedes itself'));
        continue;
      }
      const target = byKey.get(key);
      if (!target) {
        errors.push(
          finding('supersedes-target-missing', path, `\`supersedes: ${reference}\` points to a page not found in the corpus`),
        );
        continue;
      }
      const targetType = String(target.frontmatter.type ?? '').trim().toLowerCase();
      if (!DECISION_TYPES.has(targetType)) {
        errors.push(
          finding(
            'supersedes-target-not-decision',
            path,
            `\`supersedes: ${reference}\` points to ${target.path} whose type is \`${targetType || '(none)'}\` — only a decision can be superseded`,
          ),
        );
        continue;
      }
      const targetStatus = String(target.frontmatter.status ?? '').trim().toLowerCase();
      if (targetStatus !== 'superseded') {
        errors.push(
          finding(
            'supersedes-target-not-superseded',
            path,
            `\`supersedes: ${reference}\` but ${target.path} still has status \`${targetStatus || '(none)'}\` — both decisions read as live`,
            { target: target.path },
          ),
        );
      }
      // Cycle: the target claims to supersede this page back.
      const back = toList(target.frontmatter.supersedes).map(linkKey);
      if (back.includes(ownKey)) {
        errors.push(
          finding('supersedes-cycle', path, `\`supersedes\` cycle with ${target.path} — each claims to replace the other`, {
            target: target.path,
          }),
        );
      }
    }

    // Reverse direction: a superseded page must lead somewhere. Either a
    // corpus page claims it via `supersedes:`, or the page itself names its
    // successor via `superseded_by:` — the only way to express a successor
    // that lives outside this vault (a decision migrated to another vault,
    // say). Warning, not error: the successor may simply sit outside the
    // linted slice.
    if (statusKey === 'superseded') {
      const declared = toList(frontmatter.superseded_by);
      if (!supersededBy.has(ownKey) && declared.length === 0) {
        warnings.push(
          finding(
            'superseded-without-successor',
            path,
            'status is `superseded` but no page declares `supersedes:` pointing here and the page has no `superseded_by:`',
          ),
        );
      }
      // When the named successor IS in the corpus, the link must be
      // reciprocal — otherwise only one of the two pages knows about the
      // supersession, which is how a retired decision silently stays live.
      for (const reference of declared) {
        if (isExternalReference(reference)) continue; // names another vault
        const successor = byKey.get(linkKey(reference));
        if (!successor) continue; // out-of-corpus successor: nothing to verify
        const back = toList(successor.frontmatter.supersedes).map(linkKey);
        if (!back.includes(ownKey)) {
          warnings.push(
            finding(
              'superseded-by-not-reciprocated',
              path,
              `\`superseded_by: ${reference}\` but ${successor.path} does not declare \`supersedes:\` pointing back here`,
              { target: successor.path },
            ),
          );
        }
      }
    }

    // --- Rule 3: affects targets -----------------------------------------
    for (const reference of toList(frontmatter.affects)) {
      if (!byKey.has(linkKey(reference))) {
        warnings.push(
          finding('affects-target-missing', path, `\`affects: ${reference}\` does not resolve to a page in the corpus`),
        );
      }
    }

    // --- Rule 4: charter fields ------------------------------------------
    if (!String(frontmatter.scope ?? '').trim() && !toList(frontmatter.scope).length) {
      warnings.push(
        finding('scope-missing', path, 'no `scope:` — a decision without a perimeter applies everywhere, therefore badly'),
      );
    }

    const reviewAfter = String(frontmatter.review_after ?? '').trim();
    if (reviewAfter) {
      if (!ISO_DATE_RE.test(reviewAfter)) {
        warnings.push(
          finding('review-after-invalid', path, `\`review_after: ${reviewAfter}\` is not an ISO date (YYYY-MM-DD)`),
        );
      } else if (reviewAfter < today && statusKey === 'accepted') {
        warnings.push(
          finding('review-after-expired', path, `\`review_after: ${reviewAfter}\` has passed — surface as "to re-evaluate", not as a binding constraint`, {
            reviewAfter,
          }),
        );
      }
    }

    if (!toList(frontmatter.evidence).length) {
      info.push(finding('evidence-missing', path, 'no `evidence:` — link the study, session or source that motivated the verdict'));
    }

    // --- Rule 5: the section that justifies the whole practice ------------
    // Skipped entirely for frontmatter-only callers: a body rule must not
    // fire against a body it was never given. Skipped for `decision-input`
    // too — see VERDICT_TYPES.
    const isVerdict = VERDICT_TYPES.has(String(frontmatter.type ?? '').trim().toLowerCase());
    if (entry.body !== null && isVerdict) {
      const alternatives = findAlternativesSection(entry.body);
      if (!alternatives.found) {
        warnings.push(
          finding(
            'alternatives-missing',
            path,
            'no "alternatives considered" / "options écartées" section — the one thing the code and the PRD can never contain. If nothing was weighed, write "No serious alternative" and why (an external constraint, a licence, a third-party limit): an absent section is what is forbidden, not an honestly empty one',
          ),
        );
      } else if (alternatives.empty) {
        warnings.push(
          finding(
            'alternatives-empty',
            path,
            `section \`${alternatives.heading}\` is present but empty — the escape hatch has to be WRITTEN ("No serious alternative" + the reason), a bare heading carries none of the information the section exists for`,
          ),
        );
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    info,
    stats: {
      pages: parsed.length,
      decisions: decisions.length,
      byStatus: countByStatus(decisions),
    },
  };
}

function countByStatus(decisions) {
  const counts = {};
  for (const entry of decisions) {
    const status = String(entry.frontmatter.status ?? '').trim().toLowerCase() || '(none)';
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

/**
 * Convenience for migration tooling: given a raw `status` value, return the
 * normalized one, or `null` when it is already valid or unknown.
 */
export function normalizeStatus(status) {
  const key = String(status ?? '').trim().toLowerCase();
  if (!key || VALID_STATUSES.includes(key)) return null;
  return LEGACY_STATUS_MAP[key] ?? null;
}
