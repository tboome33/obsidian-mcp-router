/**
 * THE PROMPT LIFECYCLE — validating `status` on `type: prompt` pages.
 *
 * A prompt page in these vaults is a WORK ORDER: a self-contained brief written
 * to be pasted into a fresh agent session and executed once. It is not a
 * proposal to be accepted or rejected — that is a `decision` page, and it has
 * its own vocabulary in `decision-lint.mjs`.
 *
 * WHY A SEPARATE MODULE, and not a branch inside `decision-lint.mjs`. Not
 * because a shared `status` field would be ambiguous — `type` is an explicit
 * discriminator and type-scoped valid sets are perfectly normal. The reason is
 * narrower and duller: the two page kinds have different invariants and
 * different consumers. A decision carries `supersedes`, `evidence`, `scope` and
 * a "what we ruled out" section that the decision linter also checks; a work
 * order carries none of that. Two small validators beat one that has to ask
 * which kind of page it is before every rule.
 *
 * HOW THE VOCABULARY WAS ESTABLISHED — this is the part that matters. The fleet
 * carried four words for what looked like one state (`ready` ×9, `done` ×7,
 * `shipped` ×1, `executed` ×1). "Looked like" was the trap: `done` can mean the
 * DOCUMENT is finished as easily as the WORK is. So the pages were read rather
 * than their spellings trusted, and they answered plainly — one states its own
 * protocol ("passer `status:` à `in-progress` en commençant, à `done` en
 * livrant"), another opens with "ARCHIVE — prompt de handoff exécuté … ne pas
 * le relancer". The status describes the RUN, unanimously.
 *
 * That is why `LEGACY_PROMPT_STATUS_MAP` contains `done` and `shipped` and
 * nothing else. `wip`, `todo` and friends were proposed and cut: an adversarial
 * review observed that `wip` plausibly means "a session is executing this",
 * which is the OPPOSITE of the `draft` a naive reading maps it to. An unknown
 * value earns a diagnostic, never an invented certainty.
 *
 * The vocabulary an author reads lives in `skills/conventions/snippets/
 * prompt-status.md`, installed into a vault's CLAUDE.md. A test pins the two
 * together so the documented states and the linted states cannot drift.
 */

/** Page types this module owns. */
export const PROMPT_TYPES = new Set(['prompt']);

/**
 * The five states, IN LIFECYCLE ORDER — the order is part of the contract,
 * because anything that renders this list to a human teaches the sequence.
 * Alphabetical would open with `abandoned`, which reads as the normal outcome.
 */
export const VALID_PROMPT_STATUSES = ['draft', 'ready', 'in-progress', 'executed', 'abandoned'];

/**
 * Older spellings whose meaning was ESTABLISHED by reading the pages that carry
 * them, mapped to the canonical state. Deliberately short: a word only earns a
 * place here once someone has confirmed what it meant, because the whole point
 * of a suggestion is that a reader can apply it without re-deriving it.
 */
export const LEGACY_PROMPT_STATUS_MAP = {
  done: 'executed',
  shipped: 'executed',
};

/**
 * Path fragments that mark a frozen copy of a vault rather than the vault.
 * Findings inside one are unactionable — nobody edits a backup — so they would
 * return on every run forever. Excluded at inspection, not merely left unwritten.
 */
const BACKUP_SEGMENTS = ['.okf-rename-backup', '.trash', '.obsidian-backup'];

const CANONICAL = new Set(VALID_PROMPT_STATUSES);

/** True when a vault-relative path sits inside a frozen copy. */
function isBackupPath(path) {
  const segments = String(path ?? '').split(/[/\\]+/);
  return segments.some((s) => BACKUP_SEGMENTS.includes(s));
}

/**
 * Resolve a written status to its canonical state, or null when the value is
 * not one this contract knows.
 *
 * Accepts surrounding whitespace and any casing — the field is typed by hand
 * into frontmatter, and reporting `Ready` as a defect would be noise. Accepts
 * ONLY a scalar string: `status: [ready]` is a one-element YAML list, and
 * coercing it with `String()` would read "ready" and wave a malformed page
 * through.
 *
 * @param {unknown} status
 * @returns {string | null}
 */
export function normalizePromptStatus(status) {
  if (typeof status !== 'string') return null;
  const key = status.trim().toLowerCase();
  if (!key) return null;
  if (CANONICAL.has(key)) return key;
  return LEGACY_PROMPT_STATUS_MAP[key] ?? null;
}

/** True when this page's frontmatter says it is a prompt. */
function isPromptPage(frontmatter) {
  if (!frontmatter || typeof frontmatter !== 'object') return false;
  const type = frontmatter.type;
  if (typeof type !== 'string') return false;
  return PROMPT_TYPES.has(type.trim().toLowerCase());
}

/**
 * Check the prompt lifecycle contract over a set of pages.
 *
 * Both rules are WARNINGS. Not because a wrong status is cosmetic — a delivered
 * brief left at `ready` invites a second session to redo the work, which is the
 * expensive mistake this vocabulary exists to prevent — but because nothing in
 * the system consumes `status` to decide anything automatically. Severity
 * follows how the metadata is consumed, and today it is consumed by humans.
 *
 * A page whose `type` is absent or unrecognised is SKIPPED, never guessed at
 * from its filename: "this page has no type" is a generic frontmatter question
 * that belongs to a generic check, and guessing here would widen this rule's
 * scope invisibly.
 *
 * @param {Array<{path: string, frontmatter: object}>} pages
 * @returns {Array<{rule: string, path: string, severity: string, detail: string, suggestion?: string}>}
 */
export function lintPrompts(pages) {
  const findings = [];
  const vocabulary = VALID_PROMPT_STATUSES.join(' | ');

  for (const entry of Array.isArray(pages) ? pages : []) {
    if (!entry || typeof entry !== 'object') continue;
    const { path, frontmatter } = entry;
    if (!isPromptPage(frontmatter)) continue;
    if (isBackupPath(path)) continue;

    const raw = frontmatter.status;
    // An ABSENT status and a WRONG one are different failures, and only one of
    // them can be repaired mechanically. Absence carries no evidence of any
    // state — a missing status never earns a suggestion, because "it was
    // probably finished" is exactly the invented history this module refuses.
    if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      findings.push({
        rule: 'prompt-status-missing',
        path,
        severity: 'warning',
        detail: `prompt page has no \`status:\` — add one of ${vocabulary}`,
      });
      continue;
    }

    const resolved = normalizePromptStatus(raw);
    if (resolved === null) {
      findings.push({
        rule: 'prompt-status-invalid',
        path,
        severity: 'warning',
        detail: typeof raw === 'string'
          ? `status \`${raw.trim()}\` is not one of ${vocabulary}`
          : `status must be a single string, one of ${vocabulary}`,
      });
      continue;
    }

    // Canonical already: nothing to say. Otherwise it is a known older spelling
    // whose meaning IS established, so the finding carries the replacement.
    const written = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (CANONICAL.has(written)) continue;
    findings.push({
      rule: 'prompt-status-invalid',
      path,
      severity: 'warning',
      detail: `status \`${raw.trim()}\` is an older spelling of \`${resolved}\` — rewrite it as \`${resolved}\``,
      suggestion: resolved,
    });
  }

  return findings;
}
