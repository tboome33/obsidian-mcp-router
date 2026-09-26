/**
 * The contract of a decision page, checked on the page JUST WRITTEN.
 *
 * Why at write time. On the night of 2026-09-25, a session writing into a
 * secondary vault filed decision pages with no `status`, none of the required
 * `## H2` sections and no `source_type` — for hours, because nothing it called
 * ever mentioned the contract. The wiki lint knew it; the lint runs when
 * someone asks for it. A write tool that says nothing is a write tool that
 * says "fine".
 *
 * What is checked, and only for pages typed `decision` / `adr` /
 * `decision-input`:
 *
 *   - the single-page rules of `lintDecisions` — `status` present and in the
 *     enumeration, `scope`, the "alternatives considered" section for verdict
 *     types, the dated fields. The CORPUS rules (a `supersedes:` or `affects:`
 *     target that does not resolve, a cycle) are dropped: with one page in
 *     hand, "target not found" would be said of every link.
 *   - the required `## H2` sections of the heading-hierarchy convention:
 *     Context, Decision, Consequences for a verdict (`decision`, `adr`);
 *     Context for a `decision-input`, which feeds a verdict and does not carry
 *     one. Matched fence-aware, accent- and case-folded, as one whole label of
 *     a possibly bilingual heading (`## Décision · Decision`) — never as a
 *     word inside another label (`## Decision context` is neither).
 *   - `description:` — required on every page by the wiki lint since v0.59.2.
 *   - `source_type:` — reported as a WARNING when the vault carries the
 *     source-type convention, as INFO when it does not or when that is unknown.
 *
 * And, on EVERY page (decision or not) of a vault that declares its languages
 * (convention `languages`, decision `convention-languages-remplace-bilingual`
 * §5): a `language:` code outside the vault's list, and — in a vault with
 * several languages — a substantive page without its language sections or
 * with them out of order. The rules live in `convention-languages.mjs`.
 *
 * NEVER BLOCKING. The page is already written when this runs; the findings
 * travel back in the tool's response for the writer to fix. Pure — no I/O.
 */
import { DECISION_TYPES, lintDecisions } from './decision-lint.mjs';
import { parseFrontmatter } from './llms-txt-exporter.mjs';
import { scanAtxHeadings } from './markdown-headings.mjs';
import { checkPageLanguages, isExemptFromLanguageChecks } from './convention-languages.mjs';

/** Rules that need the whole corpus to be true — meaningless on one page. */
const CORPUS_RULES = new Set([
  'affects-target-missing',
  'supersedes-target-missing',
  'superseded-without-successor',
  'supersedes-cycle',
]);

/** Accepted spellings per required section, already folded. */
const REQUIRED_SECTIONS = {
  context: ['context', 'contexte'],
  decision: ['decision'],
  consequences: ['consequences', 'consequence'],
};

const SECTIONS_BY_TYPE = {
  decision: ['context', 'decision', 'consequences'],
  adr: ['context', 'decision', 'consequences'],
  'decision-input': ['context'],
};

function fold(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * For each column-0 H2 outside fences, its SEGMENTS: a bilingual heading is
 * two labels joined by a separator (`## Décision · Decision`, `## Context /
 * Contexte`), and a section counts when one segment IS the label — after
 * folding and dropping a leading number (`## 2. Decision`) or a trailing
 * parenthetical. Word-anywhere matching was the first version, and review
 * broke it at once: `## Decision context` satisfied both Context and Decision.
 */
function h2Segments(body) {
  return scanAtxHeadings(String(body ?? ''))
    .filter((h) => h.level === 2 && h.indent === 0)
    .map((h) => String(h.text)
      .split(/\s[·|/—–-]\s|\s*[·|]\s*/)
      .map((seg) => fold(seg.replace(/\([^)]*\)\s*$/, '')).replace(/^\d+[a-z]?\s+/, '').trim())
      .filter(Boolean));
}

/**
 * @param {object} input
 * @param {string} input.path vault-relative path of the page written
 * @param {string} input.content its full text as it now stands
 * @param {boolean|null} [input.vaultHasSourceType] whether the vault's
 *   conventions include source-type; null when unknown
 * @param {string} [input.today] YYYY-MM-DD, for the dated rules
 * @param {string[]|null} [input.vaultLanguages] the languages the vault
 *   declares (convention `languages`), or null when it declares none or they
 *   could not be read. When set, EVERY page is checked for them — not only
 *   decision pages (see `checkPageLanguages`).
 * @returns {{type: string|null, checked: boolean, findings: Array<{rule: string, severity: 'error'|'warning'|'info', detail: string}>}}
 *   `checked` is true when at least one family of rules ran.
 */
export function checkWrittenPage({ path, content, vaultHasSourceType = null, today, vaultLanguages = null }) {
  if (typeof content !== 'string') return { type: null, checked: false, findings: [] };
  const parsed = parseFrontmatter(content);
  const frontmatter = parsed?.frontmatter ?? {};
  const type = String(frontmatter.type ?? '').trim().toLowerCase();
  // An exempt page (navigation file, conventions file) runs no language rule,
  // so it must not report `checked: true` for them (review finding).
  const languageRules = Array.isArray(vaultLanguages) && vaultLanguages.length > 0 && !isExemptFromLanguageChecks(path);
  const languageFindings = languageRules
    ? checkPageLanguages({ path, frontmatter, body: parsed?.body ?? content, vaultLanguages })
    : [];
  if (!DECISION_TYPES.has(type)) {
    return { type: type || null, checked: languageRules, findings: languageFindings };
  }

  const findings = [...languageFindings];
  const lint = lintDecisions([{ path, content }], today ? { today } : {});
  for (const f of lint.errors) {
    if (!CORPUS_RULES.has(f.rule)) findings.push({ rule: f.rule, severity: 'error', detail: f.detail });
  }
  for (const f of lint.warnings) {
    if (!CORPUS_RULES.has(f.rule)) findings.push({ rule: f.rule, severity: 'warning', detail: f.detail });
  }

  const headings = h2Segments(parsed?.body ?? content);
  for (const section of SECTIONS_BY_TYPE[type] ?? []) {
    const forms = REQUIRED_SECTIONS[section];
    const present = headings.some((segs) => segs.some((seg) => forms.includes(seg)));
    if (!present) {
      findings.push({
        rule: `section-missing-${section}`,
        severity: 'warning',
        detail: `no \`## ${section[0].toUpperCase()}${section.slice(1)}\` section — required on a \`${type}\` page by the heading-hierarchy convention (a bilingual heading such as \`## Décision · Decision\` counts)`,
      });
    }
  }

  if (!String(frontmatter.description ?? '').trim()) {
    findings.push({
      rule: 'description-missing',
      severity: 'warning',
      detail: 'no `description:` — every page needs the one-sentence summary the recall hook, the indexes and the OKF projections publish',
    });
  }
  if (!String(frontmatter.source_type ?? '').trim()) {
    findings.push({
      rule: 'source-type-missing',
      severity: vaultHasSourceType === true ? 'warning' : 'info',
      detail: vaultHasSourceType === true
        ? 'no `source_type:` — this vault\'s source-type convention requires one on every substantive page'
        : 'no `source_type:` — required wherever the source-type convention is installed',
    });
  }

  return { type, checked: true, findings };
}
