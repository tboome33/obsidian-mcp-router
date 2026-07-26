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
    const frontmatter =
      page.frontmatter ?? parseFrontmatter(page.content ?? '').frontmatter ?? {};
    const entry = { path: page.path, frontmatter };
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
