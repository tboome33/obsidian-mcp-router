/**
 * CONVENTION DRIFT — the same rule, written twice, with nothing comparing them.
 *
 * THE INCIDENT. A convention in this library lives at two addresses: the
 * snippet under `skills/conventions/snippets/<id>.md`, which the `conventions`
 * skill installs, and the section of the same name inside a vault's
 * `CLAUDE.md`, which is what an agent actually reads at session start. The
 * reference vault carries such a copy, and every vault provisioned from it
 * inherits those bytes verbatim. Nothing ever compared the two.
 *
 * Measured on 2026-09-11 against the reference vault's `Documentation/CLAUDE.md`
 * (router 0.94.1): of the eight conventions installed there, FIVE had drifted.
 * Two of them are not cosmetic. `default-vault-health-check` was missing its
 * entire "a router call failed MID-SESSION — remediate, never fall back to the
 * filesystem" subsection, added on 2026-07-05 after a real incident; and
 * `heading-hierarchy` had frozen at roughly its v0.8.x state, 23 lines against
 * the snippet's 61, missing the whole frontmatter contract for decision pages.
 * Vaults born after July 2026 believe they carry current conventions and do not.
 *
 * WHY THIS MODULE DECLARES NO SOURCE OF TRUTH. The obvious answer — "the
 * snippets win, the vault section is a projection" — is refuted by the
 * measurement itself, twice and in opposite directions:
 *
 *   - `path-disambiguation` differs by one line because the SNIPPET was
 *     deliberately anonymised for public distribution (`C:\Users\me\...`) while
 *     the reference vault kept the original. Syncing snippet→vault would write
 *     a placeholder username into the user's own reference vault.
 *   - `auto-enrichment` in `templates/wiki/CLAUDE.md` is 190 lines against the
 *     snippet's 113, and the longer text is the NEWER one: it teaches the
 *     `workspaceBinding` model, while the snippet still teaches the model this
 *     router abandoned. There the snippet is the stale side.
 *
 * So a drift is a FACT, not a verdict. This module measures and reports; which
 * side is right is a human judgement, and the baseline below is how a human
 * records one they have already made.
 *
 * WHAT A LINE-BY-LINE COMPARISON CANNOT DO, stated rather than hidden: it tests
 * textual equality, not equivalence of meaning. A pure reformulation reports as
 * drift, and a rule REVERSED by one word reports as the two lines any edited
 * line costs — the same as a corrected typo. The count is a size, never a
 * severity. Nothing downstream may read `driftLines` as "how bad".
 *
 * This module is PURE — text in, findings out. The caller does every read, so
 * the same rules serve the repo check, a fleet scan over 27 vaults, and
 * wiki-lint's Check Q without a second implementation to keep in sync.
 */

import { createHash } from 'node:crypto';

import { findConventionSection } from './claude-md-conventions.mjs';

/** The rule name every finding from this module carries. */
export const DRIFT_RULE = 'convention-drift';

/**
 * The four states a (target file, convention) pair can be in.
 *
 * `ABSENT` IS NOT A WEAK `DRIFT`, and the distinction is the point: a
 * convention that is not there is a choice about WHICH conventions this file
 * carries (the reference vault deliberately carries eight of the twelve),
 * while a convention that IS there and no longer matches its snippet is a
 * disagreement about what one of them SAYS. They call for opposite actions —
 * install, versus reconcile — so folding one into the other would turn every
 * uninstalled convention into a repair task and bury the real ones.
 *
 * WHAT `ABSENT` CANNOT TELL YOU on its own is whether the convention was never
 * installed or has just disappeared, and a review round showed what that costs:
 * delete an installed section from a governed file, or rename a snippet's
 * heading without touching the copy, and the pair silently becomes "not
 * installed" — green. Nothing in the two texts can distinguish those cases, so
 * the answer does not come from them: a governed target DECLARES the
 * conventions it carries (`expects`), and this module compares against the
 * declaration. Deliberate uninstallation stays ordinary and quiet; an
 * undeclared disappearance is an error.
 *
 * `DUPLICATE` is the state `removeConvention` already refuses on: the same
 * identity appearing twice in one file. There is no single section to compare,
 * and picking the first copy would report a verdict about bytes the reader
 * cannot locate.
 */
export const DRIFT_STATUS = Object.freeze({
  IDENTICAL: 'identical',
  DRIFT: 'drift',
  ABSENT: 'absent',
  DUPLICATE: 'duplicate',
});

/**
 * The lines a convention's text COMPARES AS.
 *
 * Two normalisations, each with a counterexample that made it necessary:
 *
 *   - line terminators are dropped, so a CRLF working copy and an LF one
 *     compare equal. This repository has already paid for getting that wrong
 *     once: a fixture that assumed LF turned a check red on Windows and
 *     vacuous everywhere else. Since the fingerprints below are taken over
 *     THIS output, a git checkout with `core.autocrlf` on cannot move them.
 *   - trailing blank lines are dropped. A snippet file ends with a newline and
 *     the section cut out of a `CLAUDE.md` carries the blank lines that
 *     separate it from the next heading — an artefact of where it sits in a
 *     document, not a difference in the convention. Nothing else is trimmed:
 *     interior blank lines are content (a missing one is exactly the
 *     `wiki-query-first` drift), and so is leading whitespace.
 *
 * @param {unknown} text
 * @returns {string[]}
 */
export function normaliseConventionLines(text) {
  if (typeof text !== 'string') return [];
  const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines;
}

/**
 * The fingerprint a baseline entry pins a side of a known divergence to.
 *
 * Taken over the NORMALISED lines, never the raw bytes, for the reason above:
 * a fingerprint that moves with the checkout's line endings would make the
 * baseline pass on one machine and fail on another, which is the failure mode
 * a baseline exists to prevent.
 *
 * @param {unknown} text
 * @returns {string} lowercase hex sha256
 */
export function conventionFingerprint(text) {
  return createHash('sha256').update(normaliseConventionLines(text).join('\n'), 'utf8').digest('hex');
}

/** Cells of the LCS table above which the exact count is abandoned. */
const LCS_CELL_BUDGET = 4_000_000;

/**
 * How many lines `diff` would print with a `+` or `-` marker.
 *
 * This is a SIZE, printed so a reader can tell a one-line divergence from a
 * rewritten section at a glance, and it is the number the 2026-09-11
 * measurement recorded. It is not a distance with any meaning beyond that.
 *
 * The exact answer is `n + m - 2 * |LCS|`, over a table of `n * m` cells. A
 * convention section is tens of lines, so the table is trivial — but this
 * function is also handed whole sections from unknown vaults, and a
 * pathological pair must degrade rather than exhaust memory. Past the budget
 * it falls back to the multiset difference, which counts every line that does
 * not pair up with an identical line on the other side. That is a LOWER bound
 * on the true count (it pairs lines `diff` would not, across moves), so the
 * fallback can only under-report, never inflate; callers that print it say
 * "at least".
 *
 * @param {string[]} a
 * @param {string[]} b
 * @returns {{count: number, exact: boolean}}
 */
export function countDriftLines(a, b) {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  const n = left.length;
  const m = right.length;
  if (n === 0 || m === 0) return { count: n + m, exact: true };

  if (n * m > LCS_CELL_BUDGET) {
    const pool = new Map();
    for (const line of right) pool.set(line, (pool.get(line) ?? 0) + 1);
    let paired = 0;
    for (const line of left) {
      const have = pool.get(line) ?? 0;
      if (have > 0) {
        pool.set(line, have - 1);
        paired += 1;
      }
    }
    return { count: n + m - 2 * paired, exact: false };
  }

  // Two rows rather than the full table: the answer only ever reads the row
  // below, and a section pair at the budget's edge would otherwise allocate
  // gigabytes to compute a number nobody reads as more than a size.
  let below = new Uint32Array(m + 1);
  let current = new Uint32Array(m + 1);
  for (let i = n - 1; i >= 0; i -= 1) {
    current[m] = 0;
    for (let j = m - 1; j >= 0; j -= 1) {
      current[j] = left[i] === right[j]
        ? below[j + 1] + 1
        : Math.max(below[j], current[j + 1]);
    }
    const swap = below;
    below = current;
    current = swap;
  }
  return { count: n + m - 2 * below[0], exact: true };
}

/**
 * Compare one convention's snippet against the section of the same identity in
 * a target file.
 *
 * @param {{id: string, heading: string, text: string}} snippet
 * @param {string} content the whole target file
 * @returns {{status: string, driftLines: number, exact: boolean,
 *   snippetSha256: string, targetSha256: string | null, line: number | null,
 *   occurrences: number}}
 *
 * The section is located with `findConventionSection`, which is fence- and
 * comment-aware and matches the identity EXACTLY (column 0, level 2, exact
 * text). That matters twice over here. A `CLAUDE.md` that merely DOCUMENTS a
 * convention inside a fenced example has not installed it — and both the
 * `bilingual` and `path-disambiguation` snippets contain fenced `## ` lines of
 * their own, so a line-based splitter would cut them in half and then report
 * the halves as drift. Every one of those bytes is somebody's rule; inventing
 * a divergence in them is as bad as missing one.
 */
export function compareConvention(snippet, content) {
  const snippetText = String(snippet?.text ?? '');
  const snippetSha256 = conventionFingerprint(snippetText);
  const found = findConventionSection(content, snippet?.heading ?? '');

  if (!found.found) {
    return {
      status: DRIFT_STATUS.ABSENT,
      driftLines: 0,
      exact: true,
      snippetSha256,
      targetSha256: null,
      line: null,
      occurrences: 0,
    };
  }
  if (found.occurrences > 1) {
    return {
      status: DRIFT_STATUS.DUPLICATE,
      driftLines: 0,
      exact: true,
      snippetSha256,
      targetSha256: null,
      line: found.line ?? null,
      occurrences: found.occurrences,
    };
  }

  const targetSha256 = conventionFingerprint(found.text);
  if (targetSha256 === snippetSha256) {
    return {
      status: DRIFT_STATUS.IDENTICAL,
      driftLines: 0,
      exact: true,
      snippetSha256,
      targetSha256,
      line: found.line ?? null,
      occurrences: 1,
    };
  }

  const { count, exact } = countDriftLines(
    normaliseConventionLines(found.text),
    normaliseConventionLines(snippetText),
  );
  return {
    status: DRIFT_STATUS.DRIFT,
    driftLines: count,
    exact,
    snippetSha256,
    targetSha256,
    line: found.line ?? null,
    occurrences: 1,
  };
}

/**
 * Read a baseline document into the index the audit consults.
 *
 * THE BASELINE IS A SIGNED PHOTOGRAPH, NOT AN EXEMPTION. An entry pins BOTH
 * fingerprints — the snippet's and the target's — plus a reason a human wrote.
 * Accepting a divergence therefore accepts exactly those two texts: edit either
 * side and the entry stops matching, which is the whole mechanism. That is the
 * difference from an exemption keyed on the convention's name, which would go
 * on passing while the text underneath it rotted — this repository has already
 * been bitten by an exemption that let a real defect through at 211/211 green.
 *
 * `reason` is required and must be non-empty: an accepted divergence with no
 * stated reason is indistinguishable from one nobody looked at.
 *
 * @param {unknown} doc parsed JSON
 * @returns {{entries: Array<{file: string, convention: string,
 *   snippetSha256: string, targetSha256: string, reason: string}>,
 *   errors: string[]}}
 */
export function readDriftBaseline(doc) {
  const errors = [];
  const entries = [];
  // A MALFORMED DOCUMENT IS NOT AN EMPTY ONE. The first version accepted
  // `{entries: null}`, a bare array, and — worst — `{entires: [...]}`: all three
  // read as "no accepted divergences", so a typo in the key silently discharged
  // the obligation to keep the acceptances honest, including the duty to remove
  // an obsolete one. The shape is now required, and an absent `entries` is a
  // malformed document rather than an empty baseline. To declare "nothing is
  // accepted", write `entries: []`.
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { entries, errors: ['baseline must be a JSON object'] };
  }
  const raw = doc.entries;
  if (!Array.isArray(raw)) {
    return { entries, errors: ['baseline `entries` must be an array — write `"entries": []` to declare that nothing is accepted'] };
  }
  const seen = new Set();
  for (const [i, item] of raw.entries()) {
    const at = `baseline entry ${i + 1}`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${at}: not an object`);
      continue;
    }
    const file = typeof item.file === 'string' ? item.file.split('\\').join('/').trim() : '';
    const convention = typeof item.convention === 'string' ? item.convention.trim() : '';
    const snippetSha256 = typeof item.snippetSha256 === 'string' ? item.snippetSha256.toLowerCase() : '';
    const targetSha256 = typeof item.targetSha256 === 'string' ? item.targetSha256.toLowerCase() : '';
    const reason = typeof item.reason === 'string' ? item.reason.trim() : '';
    if (!file) errors.push(`${at}: missing \`file\``);
    if (!convention) errors.push(`${at}: missing \`convention\``);
    if (!/^[0-9a-f]{64}$/.test(snippetSha256)) errors.push(`${at}: \`snippetSha256\` is not a sha256`);
    if (!/^[0-9a-f]{64}$/.test(targetSha256)) errors.push(`${at}: \`targetSha256\` is not a sha256`);
    if (!reason) errors.push(`${at}: missing \`reason\` — an accepted divergence must say why`);
    if (!file || !convention || !reason) continue;
    const key = `${file}\u0000${convention}`;
    if (seen.has(key)) {
      errors.push(`${at}: duplicate entry for ${convention} in ${file}`);
      continue;
    }
    seen.add(key);
    entries.push({ file, convention, snippetSha256, targetSha256, reason });
  }
  return { entries, errors };
}

/**
 * `a/b` form, so a Windows caller and a POSIX one key the same entry.
 *
 * EXPORTED because a caller that builds its own key from the same path must
 * get the same string. The first version kept this private, and the fleet
 * report then filtered its findings with a raw `C:\…` path against findings
 * keyed `C:/…` — every match failed, so a run over fifteen vaults with
 * seventy-five drifting conventions printed nothing at all and still exited 0.
 * A silent empty report is the worst possible failure for a tool whose whole
 * job is to end a silence.
 *
 * @param {unknown} file
 * @returns {string}
 */
export function normaliseTargetFile(file) {
  return String(file ?? '').split('\\').join('/').trim();
}

/**
 * Audit a set of target files against the snippet library.
 *
 * @param {{snippets: Array<{id: string, heading: string, text: string}>,
 *   targets: Array<{file: string, content: string, governed?: boolean,
 *   label?: string}>, baseline?: {entries: Array<object>}}} input
 *
 *   `expects` (governed targets only) is the list of convention ids that file
 *   is DECLARED to carry. It is what makes `absent` meaningful: without it, a
 *   deleted section and a renamed snippet heading both read as "never
 *   installed" and pass. A convention declared but not found is
 *   `missing-convention`; one found but not declared is
 *   `unexpected-convention`; one neither declared nor found is the ordinary
 *   quiet `not-installed`. Both new verdicts are errors, because on a governed
 *   file the declaration is the contract. Omit `expects` and that half of the
 *   check is simply not performed — which is the right default for a caller
 *   who has no declaration to offer, and never a silent pass on one who does.
 *
 *   `governed` says whether the BASELINE APPLIES to this target — which is the
 *   same question as "can this repository be required to keep it in step?".
 *   The files shipped in this repo are governed: a divergence there is either
 *   declared or repaired, so it is an ERROR. A vault on somebody's disk is
 *   observed: it may legitimately carry a hand-edited section, and the fleet
 *   report exists to inform, so its divergences are WARNINGS and no baseline
 *   entry is ever expected for them. Making that a parameter rather than a
 *   heuristic keeps the policy where a reader can see it.
 *
 * @returns {{findings: Array<object>, counts: object, baselineErrors: string[],
 *   ok: boolean}}
 *   AT LEAST ONE FINDING PER (target, convention) PAIR, whatever the verdict —
 *   an in-step pair included. No pair is ever silent: the first version emitted
 *   nothing for a pair in step, and the very first run printed "0 identical"
 *   for a file whose convention it had just verified.
 *
 *   A PAIR MAY CARRY TWO, and a reader who assumes otherwise miscounts. The
 *   declaration verdicts are a SECOND question about the same pair — a section
 *   that is installed but undeclared is reported AND still compared, which is
 *   the point (the comparison is the half that says whether the undeclared
 *   addition is even in step). So `findings.length` is not a pair count:
 *   aggregate by `(file, convention)` before counting anything, as
 *   `summariseTarget` does, or a single convention renders as two. An earlier
 *   version of this paragraph claimed exactly one finding per pair; the test
 *   named "an UNDECLARED convention that is present is an error, and is still
 *   compared" asserts two, so the contract was false where the code was right.
 *
 *   Baseline entries that matched no examined pair, and declarations naming a
 *   convention the library does not provide, are the only findings with no
 *   `status` — they are about the inputs, not about a comparison.
 *
 *   `ok` is false when any finding is an error. Warnings never set it — a
 *   drift is a signpost, and this repository's own convention is that a
 *   signpost does not fail a run.
 */
export function auditConventionDrift({ snippets = [], targets = [], baseline } = {}) {
  // OMITTED IS THE ONLY THING THAT MEANS "NO BASELINE". The first version
  // tested `baseline ?` — so `null`, `false`, `0` and `''` all read as "none
  // supplied" and skipped validation entirely, which is how a file containing
  // literal JSON `null` sailed through as an intentional absence. Anything a
  // caller actually passes is a document, and a document is validated.
  const { entries: baseEntries, errors: baselineErrors } = baseline === undefined
    ? { entries: [], errors: [] }
    : readDriftBaseline(baseline);

  const index = new Map();
  for (const e of baseEntries) index.set(`${e.file}\u0000${e.convention}`, e);
  const consumed = new Set();

  const findings = [];
  const counts = {
    identical: 0, drift: 0, absent: 0, duplicate: 0, accepted: 0, errors: 0, warnings: 0,
  };

  const available = new Set(
    (Array.isArray(snippets) ? snippets : []).map((s) => s?.id).filter((id) => typeof id === 'string'),
  );

  // A DECLARATION IS CHECKED AGAINST THE LIBRARY BEFORE IT IS CHECKED AGAINST
  // THE FILE, because the per-convention loop below can only ever examine
  // conventions the library HAS. Delete a snippet and its declaration simply
  // stopped being evaluated — the shipped template kept a section nothing
  // compared any more, and the check stayed green. A review round found this in
  // the repair for the previous version of the same hole, which is the pattern
  // to expect: the second-order version of a defect hides inside its own fix.
  for (const target of Array.isArray(targets) ? targets : []) {
    if (target?.governed !== true || !Array.isArray(target?.expects)) continue;
    for (const id of target.expects) {
      if (typeof id !== 'string' || id === '' || available.has(id)) continue;
      findings.push({
        rule: DRIFT_RULE,
        file: normaliseTargetFile(target?.file),
        label: target?.label ?? null,
        convention: id,
        heading: null,
        status: null,
        driftLines: 0,
        exactCount: true,
        line: null,
        snippetSha256: null,
        targetSha256: null,
        declared: true,
        severity: 'error',
        verdict: 'declared-snippet-missing',
        reason: null,
        detail: 'this file is declared to carry a convention the snippet library does not provide — nothing can compare it',
      });
      counts.errors += 1;
    }
  }

  for (const target of Array.isArray(targets) ? targets : []) {
    const file = normaliseTargetFile(target?.file);
    const governed = target?.governed === true;
    const content = typeof target?.content === 'string' ? target.content : '';
    // `null` (not an empty Set) when the caller declared nothing: "declared to
    // carry none" and "made no declaration" are different states, and treating
    // the second as the first would report every convention of an undeclared
    // file as unexpected.
    const expects = governed && Array.isArray(target?.expects)
      ? new Set(target.expects.filter((id) => typeof id === 'string' && id !== ''))
      : null;

    for (const snippet of Array.isArray(snippets) ? snippets : []) {
      const result = compareConvention(snippet, content);
      const key = `${file}\u0000${snippet.id}`;
      const entry = governed ? index.get(key) : undefined;
      if (entry) consumed.add(key);

      const base = {
        rule: DRIFT_RULE,
        file,
        label: target?.label ?? null,
        convention: snippet.id,
        heading: snippet.heading,
        status: result.status,
        driftLines: result.driftLines,
        exactCount: result.exact,
        line: result.line,
        snippetSha256: result.snippetSha256,
        targetSha256: result.targetSha256,
        declared: expects === null ? null : expects.has(snippet.id),
      };

      counts[result.status] = (counts[result.status] ?? 0) + 1;

      // THE DECLARATION IS CHECKED BEFORE THE TEXTS, because it answers a
      // question the texts cannot. Present-but-undeclared is reported here and
      // then falls through, so a section somebody added without declaring it is
      // still compared — two findings, and the second is the one that says
      // whether the addition is even in step.
      if (expects !== null) {
        if (result.status === DRIFT_STATUS.ABSENT && expects.has(snippet.id)) {
          findings.push({
            ...base,
            severity: 'error',
            verdict: 'missing-convention',
            reason: null,
            detail: 'this file is declared to carry this convention and no longer does — restore it, or remove it from the declaration',
          });
          counts.errors += 1;
          if (entry) {
            findings.push({
              ...base,
              severity: 'error',
              verdict: 'baseline-obsolete',
              reason: entry.reason,
              detail: 'the convention is no longer present in this file; remove this baseline entry',
            });
            counts.errors += 1;
          }
          continue;
        }
        if (result.status !== DRIFT_STATUS.ABSENT && !expects.has(snippet.id)) {
          findings.push({
            ...base,
            severity: 'error',
            verdict: 'unexpected-convention',
            reason: null,
            detail: 'this convention is installed here but not declared — add it to the declaration, or remove the section',
          });
          counts.errors += 1;
        }
      }

      if (result.status === DRIFT_STATUS.IDENTICAL) {
        // An entry surviving here is the OBSOLETE case: somebody reconciled the
        // texts and left the acceptance behind. Reported as an error on
        // purpose. A stale acceptance is a loaded gun — the day the pair drifts
        // again, a matching entry could silently bless it — and it is also the
        // only way the baseline stays readable as a list of things a human
        // decided, rather than a graveyard.
        if (entry) {
          findings.push({
            ...base,
            severity: 'error',
            verdict: 'baseline-obsolete',
            reason: entry.reason,
            detail: 'the two texts now match; remove this baseline entry',
          });
          counts.errors += 1;
          continue;
        }
        findings.push({ ...base, severity: 'info', verdict: 'in-step', reason: null, detail: null });
        continue;
      }

      if (result.status === DRIFT_STATUS.ABSENT) {
        if (entry) {
          findings.push({
            ...base,
            severity: 'error',
            verdict: 'baseline-obsolete',
            reason: entry.reason,
            detail: 'the convention is no longer present in this file; remove this baseline entry',
          });
          counts.errors += 1;
          continue;
        }
        // Not reported as a problem anywhere: a file carries the conventions
        // its owner installed. The caller renders the count.
        findings.push({ ...base, severity: 'info', verdict: 'not-installed', reason: null, detail: null });
        continue;
      }

      if (result.status === DRIFT_STATUS.DUPLICATE) {
        // AN ERROR ON A GOVERNED FILE, and a review round is why. A duplicate
        // produces no comparable section, so neither fingerprint is checked —
        // and because the baseline entry was looked up (and consumed) it raised
        // no `baseline-stale` and no `baseline-unmatched` either. Duplicating a
        // heading was therefore a way to replace an accepted section with
        // arbitrary text and keep the gate green. It stays a WARNING on an
        // observed vault: a vault with two copies of a convention is its
        // owner's business, and it is already the state `removeConvention`
        // refuses on.
        findings.push({
          ...base,
          severity: governed ? 'error' : 'warning',
          verdict: 'duplicate-identity',
          reason: entry?.reason ?? null,
          detail: `the identity appears ${result.occurrences} times; there is no single section to compare${entry ? ', so this file\'s accepted divergence could not be validated' : ''}`,
        });
        if (governed) counts.errors += 1;
        else counts.warnings += 1;
        continue;
      }

      // DRIFT from here on.
      if (entry) {
        const matches = entry.snippetSha256 === result.snippetSha256
          && entry.targetSha256 === result.targetSha256;
        if (matches) {
          findings.push({
            ...base, severity: 'info', verdict: 'accepted', reason: entry.reason, detail: null,
          });
          counts.accepted += 1;
          continue;
        }
        const moved = entry.snippetSha256 !== result.snippetSha256
          ? (entry.targetSha256 !== result.targetSha256 ? 'both sides have' : 'the snippet has')
          : 'the target has';
        findings.push({
          ...base,
          severity: 'error',
          verdict: 'baseline-stale',
          reason: entry.reason,
          detail: `${moved} changed since this divergence was accepted; re-read it and update or drop the entry`,
        });
        counts.errors += 1;
        continue;
      }

      findings.push({
        ...base,
        severity: governed ? 'error' : 'warning',
        verdict: governed ? 'undeclared' : 'observed',
        reason: null,
        detail: governed
          ? 'propagate the change, or record the divergence in the baseline with a reason'
          : null,
      });
      if (governed) counts.errors += 1;
      else counts.warnings += 1;
    }
  }

  // An entry naming a file or a convention that was not examined cannot be
  // checked by the loop above, and silence would let a typo in `file` read as
  // a passing acceptance forever.
  for (const e of baseEntries) {
    const key = `${e.file}\u0000${e.convention}`;
    if (consumed.has(key)) continue;
    findings.push({
      rule: DRIFT_RULE,
      file: e.file,
      label: null,
      convention: e.convention,
      heading: null,
      status: null,
      driftLines: 0,
      exactCount: true,
      line: null,
      snippetSha256: null,
      targetSha256: null,
      severity: 'error',
      verdict: 'baseline-unmatched',
      reason: e.reason,
      detail: 'this baseline entry names a file or convention the audit never examined',
    });
    counts.errors += 1;
  }

  for (const _ of baselineErrors) counts.errors += 1;

  return {
    findings,
    counts,
    baselineErrors,
    ok: counts.errors === 0,
  };
}
