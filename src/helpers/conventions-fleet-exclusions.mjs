/**
 * FLEET EXCLUSIONS — the pairs the fleet must never be reconciled INTO, and the
 * two fingerprints that keep that record honest.
 *
 * THE DECISION THIS IMPLEMENTS. `exclusions-de-propagation-des-conventions`
 * (accepted 2026-09-14) rules that three conventions must not be propagated
 * from the snippet library into certain vaults, because there the library holds
 * the GENERIC text and the vault holds the CONCRETE one: `path-disambiguation`
 * everywhere (the snippet was anonymised to `C:\Users\me` for distribution),
 * `tribu-routing` on one vault (it names the family), `default-vault-health-check`
 * on one more (its JSON example is instantiated on that vault). Replacing those
 * would write a placeholder over a real value.
 *
 * §3 OF THAT DECISION IS THE WHOLE REASON THIS MODULE EXISTS, and it is a
 * refusal, not a convenience: **an exclusion is a non-write boundary, never a
 * certificate.** It says "do not write here". It does not say "this text is
 * correct". An exemption keyed on a convention's NAME would say the second
 * thing by accident — it would go on excusing that pair while the text
 * underneath it rotted, and this repository has already been bitten by exactly
 * that shape once, a check green at 211/211 while a real defect walked past it.
 *
 * So an entry pins the identity of the file AND the sha256 of BOTH texts. Edit
 * either side and the entry stops matching: the pair comes back for
 * examination. That is the mechanism, and it is the same one the repository's
 * own drift baseline uses — §3 points at it by name.
 *
 * "COMES BACK FOR EXAMINATION" IS NOT ALWAYS `stale`, and an earlier version of
 * this paragraph said it was. The verdict depends on what the edit did: a text
 * that merely moved gives `stale`, an edit that RECONCILED the two gives
 * `obsolete` (there is no divergence left to exclude), and an edit that
 * duplicated the heading gives `unverifiable` (the excluded text can no longer
 * be identified). Three doors, one corridor — but a reader who expects only
 * `stale` will not recognise the other two as the same signal.
 *
 * WHAT THE FINGERPRINTS CANNOT SEE, stated rather than implied: they are taken
 * over the section's NORMALISED lines, so a change of line terminators or of
 * trailing blank lines does not move them. That is deliberate — a CRLF checkout
 * must not invalidate every entry — and it is the exact extent of the blind
 * spot.
 *
 * WHY THIS IS NOT THE REPOSITORY'S BASELINE, though it is built like it. The
 * baseline governs the `CLAUDE.md` copies this repo SHIPS: a divergence there
 * is this project's fault and fails CI. These entries describe vaults on one
 * person's disk — subjects this project observes and never governs. Two
 * consequences follow, and both are deliberate:
 *
 *   - the document lives beside the router config, not in this repository. It
 *     is a record about one machine's fleet, and it names that machine's
 *     vaults.
 *   - nothing here can fail a run, and nothing here can reach an ERROR. Quieting
 *     an observed warning is the feature; quieting an error would be a local,
 *     unversioned file overruling CI, and `annotatedSeverity` below refuses it
 *     on every branch. That second half is load-bearing: it is what makes an
 *     absent document safe to treat as "no exclusions" rather than as a failure,
 *     since losing the file can then only make the report noisier. The first
 *     version asserted it from the CALLER's side — the fleet path produces only
 *     warnings, so a record could only reword one — and a review round was right
 *     to refuse that: this module is exported, and an argument that depends on
 *     who calls it is not a property of the module. A malformed document is
 *     still refused, because a typo in a key must not read as an empty record.
 *
 * PURE — documents and findings in, annotated findings out. Every read belongs
 * to the caller.
 */

/**
 * What became of a (vault, file, convention) pair once the record was consulted.
 *
 * `STALE` and `OBSOLETE` are different failures of the same record and must not
 * be folded together. STALE means the divergence is still there but one of the
 * two texts has moved — the exclusion was granted to a text that no longer
 * exists, so the grant has to be re-examined. OBSOLETE means there is no
 * divergence left to exclude at all: somebody reconciled the pair, or the
 * section is gone. The first asks "is this still the right call?", the second
 * asks "why is this line still here?".
 */
export const FLEET_EXCLUSION = Object.freeze({
  EXCLUDED: 'excluded',
  STALE: 'exclusion-stale',
  OBSOLETE: 'exclusion-obsolete',
  UNVERIFIABLE: 'exclusion-unverifiable',
  UNMATCHED: 'exclusion-unmatched',
  /**
   * The pair WAS examined, and this run still produced no comparison for it —
   * so the record could not be checked against anything.
   *
   * It exists because the gate below is an allowlist of the verdicts a
   * comparison carries, and an allowlist goes stale: rename or add a verdict
   * upstream and the pair would be neither annotated (it is not on the list)
   * nor reported unmatched (its identity WAS seen). Silent on both counts. This
   * verdict is the third answer that keeps the gap loud instead.
   */
  UNEVALUATED: 'exclusion-unevaluated',
});

/**
 * The severity an annotated finding carries — the record's jurisdiction, drawn
 * as a line rather than asserted in prose.
 *
 * QUIETING A WARNING IS THE JOB. An ordinary fleet drift arrives as a warning
 * and an exclusion is precisely the statement "this one is settled, stop asking
 * about it": the annotated finding becomes info-severity `excluded` and carries
 * the reason. A rule that forbade every downgrade would forbid the feature.
 *
 * QUIETING AN ERROR IS OUTSIDE IT. An error-severity finding comes from the
 * GOVERNED path — the `CLAUDE.md` copies this repository ships, where a
 * divergence is this project's fault and CI must go red. This record has no
 * authority there, and a first version that clamped nothing would have let a
 * local, unversioned, hand-edited file turn a CI error into an info. That is
 * the shape the whole design exists to refuse, so it is refused in code: an
 * error keeps `error` and merely gains the verdict and the reason.
 *
 * It is also what makes an ABSENT record safe to treat as an ordinary state. If
 * the file could silence an error, deleting it would change what the report
 * says about correctness — and the argument for optionality collapses. A review
 * round found the first version asserting this about its CALLER instead of
 * enforcing it here, and found the test named after it asserting only that no
 * finding had been dropped.
 *
 * @param {unknown} incoming the finding's own severity
 * @param {'info'|'warning'} proposed what this annotation would like
 * @returns {'info'|'warning'|'error'}
 */
export function annotatedSeverity(incoming, proposed) {
  return incoming === 'error' ? 'error' : proposed;
}

/**
 * The verdicts an exclusion is ABOUT — the finding that carries the comparison
 * of the two texts, and nothing else.
 *
 * ONE PAIR CAN PRODUCE TWO FINDINGS, and the first version of this module
 * annotated both. `auditConventionDrift` says so in its own contract: a section
 * that is installed but not declared is reported AND still compared, so the
 * pair arrives here as a declaration error plus a comparison. Matching on
 * identity alone then overwrote the declaration error's `reason` and `detail`
 * with the exclusion's, replacing the diagnosis of one problem with the excuse
 * for a different one — and counted the pair twice while it was at it.
 *
 * So the gate is the verdict, not the identity: an exclusion may speak about
 * the comparison it was written for, and must stay silent about every other
 * question asked of the same pair. A governed file's declaration verdicts
 * (`missing-convention`, `unexpected-convention`, `undeclared`, the `baseline-*`
 * family) are somebody else's answer and are returned untouched.
 */
const OBSERVATION_VERDICTS = new Set(['observed', 'in-step', 'not-installed', 'duplicate-identity']);

/**
 * How a run relates to the FILE an unmatched record names — per (vault, file),
 * never per vault.
 *
 * A review round found the per-vault version giving the wrong answer on exactly
 * the population this decision is about: eleven vaults carry TWO conventions
 * files. Read one and fail on the other, and the readable sibling declared the
 * whole vault "examined" — so the record about the file nobody could open was
 * told its convention "was not found, drop the record", while the run's own
 * error list said the file had never been read. Two outputs of one run
 * contradicting each other.
 */
export const EXCLUSION_COVERAGE = Object.freeze({
  /** This run inspected the vault; this file or convention is not there. */
  EXAMINED: 'examined',
  /** This run selected the vault but could not read THIS file (or the vault). */
  UNREAD: 'unread',
  /** The run never selected this vault. */
  OUTSIDE: 'outside',
  /**
   * The record names a convention this run never compared, because the snippet
   * library does not provide it.
   *
   * It is its own answer rather than a shade of EXAMINED, and a review round is
   * why: the DETAIL said "the library does not provide this" while the summary
   * line counted the same entry under "examined and not found" — the report
   * contradicting itself, with the false half being the one a reader skims.
   */
  UNKNOWN_CONVENTION: 'unknown-convention',
});

/**
 * The byte that joins the parts of a key.
 *
 * BUILT, NEVER ESCAPED, and that is not a style preference. A unicode escape
 * typed through an editing tool in this project lands as a REAL control byte
 * in the source — it happened three times in this very file, invisibly, and it
 * was `grep` calling the module "binary" that gave it away rather than any
 * test. One constant, constructed once; nothing else here needs to spell it.
 */
const SEP = String.fromCharCode(0);

/** `a/b` form, so a Windows record and a POSIX one key the same pair. */
export function normaliseRelativeFile(file) {
  return String(file ?? '').split('\\').join('/').trim().replace(/^\.\//, '');
}

/**
 * The key a pair is recorded under.
 *
 * The vault NAME is folded to lower case and the file path is not, and the
 * asymmetry is on purpose: a vault name is something a human types into this
 * document from memory, while the file path is one of three exact strings the
 * scanner itself produced. Folding the path too would make `Documentation/` and
 * `documentation/` the same key on every platform, including the ones where
 * they are two different files.
 *
 * @param {unknown} vault
 * @param {unknown} file vault-RELATIVE path
 * @param {unknown} convention
 * @returns {string}
 */
export function exclusionKey(vault, file, convention) {
  return [
    String(vault ?? '').trim().toLowerCase(),
    normaliseRelativeFile(file),
    String(convention ?? '').trim(),
  ].join(SEP);
}

/**
 * Read an exclusions document into the index the report consults.
 *
 * Validation is as strict as the baseline's and for the same reason: every
 * shape that could read as "no exclusions recorded" without saying so is
 * refused. `{entries: null}`, a bare array, and a misspelt `entires` key are
 * all malformed documents, not empty ones. To declare that nothing is excluded,
 * write `"entries": []`.
 *
 * @param {unknown} doc parsed JSON
 * @returns {{entries: Array<{vault: string, file: string, convention: string,
 *   snippetSha256: string, targetSha256: string, reason: string,
 *   decision: string|null, key: string}>, errors: string[]}}
 */
export function readFleetExclusions(doc) {
  const errors = [];
  const entries = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { entries, errors: ['exclusions document must be a JSON object'] };
  }
  const raw = doc.entries;
  if (!Array.isArray(raw)) {
    return {
      entries,
      errors: ['exclusions `entries` must be an array — write `"entries": []` to declare that nothing is excluded'],
    };
  }
  const seen = new Set();
  for (const [i, item] of raw.entries()) {
    const at = `exclusion ${i + 1}`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${at}: not an object`);
      continue;
    }
    const vault = typeof item.vault === 'string' ? item.vault.trim() : '';
    const file = typeof item.file === 'string' ? normaliseRelativeFile(item.file) : '';
    const convention = typeof item.convention === 'string' ? item.convention.trim() : '';
    const snippetSha256 = typeof item.snippetSha256 === 'string' ? item.snippetSha256.toLowerCase().trim() : '';
    const targetSha256 = typeof item.targetSha256 === 'string' ? item.targetSha256.toLowerCase().trim() : '';
    const reason = typeof item.reason === 'string' ? item.reason.trim() : '';
    const decision = typeof item.decision === 'string' && item.decision.trim() !== ''
      ? item.decision.trim()
      : null;

    // EVERY FAILED CHECK DROPS THE ENTRY, and this flag is why it is one
    // variable rather than a condition rebuilt at the bottom. The first version
    // re-listed the required fields in the `continue` guard, so a check added
    // later — the absolute-path one below — reported its error and then let the
    // entry into the index anyway. A record that is both refused and applied is
    // worse than either.
    let invalid = false;
    const refuse = (message) => { errors.push(`${at}: ${message}`); invalid = true; };

    if (!vault) refuse('missing `vault`');
    if (!file) refuse('missing `file` — the vault-relative path of the conventions file');
    // An ABSOLUTE path here would key nothing and match nothing, and the entry
    // would then read as an unmatched record rather than as the mistake it is.
    else if (/^([a-z]:[/\\]|[/\\])/i.test(file)) {
      refuse('`file` must be vault-relative (e.g. "Documentation/CLAUDE.md"), not an absolute path');
    }
    if (!convention) refuse('missing `convention`');
    if (!/^[0-9a-f]{64}$/.test(snippetSha256)) refuse('`snippetSha256` is not a sha256');
    if (!/^[0-9a-f]{64}$/.test(targetSha256)) refuse('`targetSha256` is not a sha256');
    // The same fingerprint on both sides describes two texts that are equal —
    // which is not a divergence, so there is nothing to exclude. Left to the
    // matcher it would surface as `obsolete` only if the pair happened to be
    // examined; stated here it is always caught.
    if (/^[0-9a-f]{64}$/.test(snippetSha256) && snippetSha256 === targetSha256) {
      refuse('both fingerprints are identical — that is not a divergence, so there is nothing to exclude');
    }
    if (!reason) refuse('missing `reason` — an exclusion with no stated reason is indistinguishable from one nobody looked at');

    if (invalid) continue;
    const key = exclusionKey(vault, file, convention);
    if (seen.has(key)) {
      errors.push(`${at}: duplicate entry for ${convention} in ${vault} — ${file}`);
      continue;
    }
    seen.add(key);
    entries.push({ vault, file, convention, snippetSha256, targetSha256, reason, decision, key });
  }
  return { entries, errors };
}

/**
 * Annotate fleet findings with the exclusions record.
 *
 * @param {{findings: Array<object>, locations: Array<{file: string, vault: string,
 *   relative: string}>, entries: Array<object>, examinedWholeFleet?: boolean}} input
 *
 *   `locations` maps the absolute path a finding is keyed by back to the
 *   (vault, relative) pair a record is written in terms of. The record cannot
 *   hold absolute paths — they are one machine's, and this document is already
 *   about one machine's vaults, so nothing is gained and a moved vault folder
 *   would silently void every entry.
 *
 *   `examinedWholeFleet` says whether this run looked at every vault. It only
 *   changes the WORDS on an unmatched entry: after a `--vault` run most entries
 *   are legitimately unexamined, and calling those "wrong" would train a reader
 *   to ignore the one that is.
 *
 *   BUT "UNEXAMINED" IS DECIDED PER ENTRY, from `locations`, never from that
 *   flag alone — and a review round is why. A record whose VAULT was examined
 *   and whose file was not found is in scope and wrong, whatever the run's
 *   breadth: that is exactly what a conventions file moved between the three
 *   candidate locations looks like. The first version labelled every unmatched
 *   entry of a `--vault` run "outside this run", which filed the one real
 *   finding under a sentence saying it did not apply. `inScope` on the finding
 *   carries the distinction so a renderer does not have to guess it back.
 *
 * @returns {{findings: Array<object>, counts: object}}
 *   The findings array is rebuilt, never mutated in place: a matched pair keeps
 *   every field and has its `verdict`, `reason` and `detail` replaced, and its
 *   `severity` set by `annotatedSeverity`, which may quieten a warning but never an error.
 *   Unmatched entries are appended as findings of their own, the way the
 *   baseline reports its own.
 */
export function applyFleetExclusions({
  findings = [], locations = [], entries = [], examinedWholeFleet = true, selected = null,
  unread = [], inspected = [], compared = null,
} = {}) {
  const counts = {
    excluded: 0, stale: 0, obsolete: 0, unverifiable: 0, unmatched: 0, unevaluated: 0,
    // The four ways an entry can be unmatched, so a caller can print them apart
    // without re-deriving them from the findings. They sum to `unmatched` (and
    // `unevaluated` is counted apart: that entry DID match a pair, it simply
    // could not be checked).
    examined: 0, unread: 0, outside: 0, 'unknown-convention': 0,
  };
  const index = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (e && typeof e.key === 'string') index.set(e.key, e);
  }
  const where = new Map();
  const examinedVaults = new Set();
  const locationKeys = new Set();
  for (const l of Array.isArray(locations) ? locations : []) {
    if (l && typeof l.file === 'string') where.set(l.file, l);
    if (l && typeof l.vault === 'string') {
      examinedVaults.add(l.vault.trim().toLowerCase());
      if (typeof l.relative === 'string') {
        locationKeys.add(`${l.vault.trim().toLowerCase()}${SEP}${normaliseRelativeFile(l.relative)}`);
      }
    }
  }
  // SELECTED IS NOT THE SAME AS EXAMINED, and conflating them was a finding.
  // `locations` holds only the files this run actually READ; a vault whose
  // conventions file could not be opened, or which has none, produces no
  // location at all. Calling its record "about another vault" is false — the
  // run chose that vault and failed to cover it. When the caller offers no
  // selection, every examined vault is the best available answer.
  const selectedVaults = Array.isArray(selected)
    ? new Set(selected.map((v) => String(v ?? '').trim().toLowerCase()).filter((v) => v !== ''))
    : null;
  // What this run TRIED to read and could not. Two grains, because the failure
  // has two: `{vault}` alone when the vault itself could not be inspected, and
  // `{vault, relative}` when one candidate file among several failed. The
  // second is the one that matters here — a vault with two conventions files,
  // one readable and one not, is the ordinary case in this fleet.
  const unreadFiles = new Set();
  const unreadVaults = new Set();
  for (const u of Array.isArray(unread) ? unread : []) {
    const v = String(u?.vault ?? '').trim().toLowerCase();
    if (v === '') continue;
    if (typeof u?.relative === 'string' && u.relative !== '') {
      unreadFiles.add(`${v}${SEP}${normaliseRelativeFile(u.relative)}`);
    } else {
      unreadVaults.add(v);
    }
  }
  // VAULTS THE RUN SUCCESSFULLY ENUMERATED, including the ones that turned out
  // to hold no conventions file at all. Without this, "I looked and there was
  // nothing there" fell through to `selected` and came back as "I could not
  // read it" — verified absence reported as failed coverage, which sends the
  // reader hunting for a permissions problem that does not exist.
  const inspectedVaults = new Set(
    (Array.isArray(inspected) ? inspected : [])
      .map((v) => String(v ?? '').trim().toLowerCase()).filter((v) => v !== ''),
  );
  // The convention ids this run actually compared. An entry naming something
  // outside it was never searched for, so "not found in this file" would be an
  // answer nobody established.
  const comparedIds = Array.isArray(compared)
    ? new Set(compared.map((c) => String(c ?? '').trim()).filter((c) => c !== ''))
    : null;
  const coverageOf = (vault, file, convention) => {
    const v = String(vault ?? '').trim().toLowerCase();
    const pair = `${v}${SEP}${normaliseRelativeFile(file)}`;
    // ASKED FIRST, because it makes every other answer moot: if nothing ever
    // compared this convention, "not found in that file" is not a weaker
    // statement, it is a statement about a search that never happened.
    if (comparedIds !== null && !comparedIds.has(String(convention ?? '').trim())) {
      return EXCLUSION_COVERAGE.UNKNOWN_CONVENTION;
    }
    // ORDER MATTERS, AND THE FIRST TEST IS THE NARROWEST. A vault can be both
    // examined (a sibling file was read) and unread (this file was not), and
    // only the per-file answer is true of the record in hand.
    if (locationKeys.has(pair)) return EXCLUSION_COVERAGE.EXAMINED;
    if (unreadFiles.has(pair) || unreadVaults.has(v)) return EXCLUSION_COVERAGE.UNREAD;
    if (examinedVaults.has(v) || inspectedVaults.has(v)) return EXCLUSION_COVERAGE.EXAMINED;
    if (selectedVaults !== null && selectedVaults.has(v)) return EXCLUSION_COVERAGE.UNREAD;
    return EXCLUSION_COVERAGE.OUTSIDE;
  };
  const consumed = new Set();
  const evaluated = new Set();

  const out = [];
  for (const f of Array.isArray(findings) ? findings : []) {
    const loc = where.get(f?.file);
    const entry = loc ? index.get(exclusionKey(loc.vault, loc.relative, f?.convention)) : undefined;
    if (!entry) { out.push(f); continue; }
    // THE ENTRY IS CONSUMED BY THE IDENTITY, not by the verdict. A record whose
    // pair WAS examined has matched something real even when the only finding
    // this run produced about it is one an exclusion may not speak to — calling
    // it `unmatched` on top of that would be a second, false accusation.
    consumed.add(entry.key);
    if (!OBSERVATION_VERDICTS.has(f?.verdict)) { out.push(f); continue; }
    evaluated.add(entry.key);

    const decorated = {
      ...f,
      vault: loc.vault,
      relative: loc.relative,
      // Kept so a reader can tell "quieted by the record" from "never serious".
      // The verdict alone cannot answer that, and the JSON is what a later tool
      // reads.
      severityBefore: f.severity ?? null,
      exclusionReason: entry.reason,
      exclusionDecision: entry.decision,
    };

    if (f.status === 'duplicate') {
      // No single section, so neither fingerprint can be checked. Reported
      // rather than passed over: an unverifiable record is the state in which a
      // section could be replaced wholesale behind the exclusion's back.
      counts.unverifiable += 1;
      out.push({
        ...decorated,
        severity: annotatedSeverity(f.severity, 'warning'),
        verdict: FLEET_EXCLUSION.UNVERIFIABLE,
        reason: entry.reason,
        detail: 'this identity appears more than once here, so the excluded text could not be identified — the record could not be validated',
      });
      continue;
    }

    if (f.status !== 'drift') {
      counts.obsolete += 1;
      out.push({
        ...decorated,
        severity: annotatedSeverity(f.severity, 'warning'),
        verdict: FLEET_EXCLUSION.OBSOLETE,
        reason: entry.reason,
        detail: f.status === 'identical'
          ? 'the two texts now match — there is no divergence left to exclude; drop this record'
          : 'this convention is no longer present here — there is no divergence left to exclude; drop this record',
      });
      continue;
    }

    const snippetMoved = entry.snippetSha256 !== f.snippetSha256;
    const targetMoved = entry.targetSha256 !== f.targetSha256;
    if (!snippetMoved && !targetMoved) {
      counts.excluded += 1;
      out.push({
        ...decorated,
        severity: annotatedSeverity(f.severity, 'info'),
        verdict: FLEET_EXCLUSION.EXCLUDED,
        reason: entry.reason,
        detail: null,
      });
      continue;
    }
    const moved = snippetMoved
      ? (targetMoved ? 'both texts have' : 'the snippet has')
      : 'the vault\'s text has';
    counts.stale += 1;
    out.push({
      ...decorated,
      severity: annotatedSeverity(f.severity, 'warning'),
      verdict: FLEET_EXCLUSION.STALE,
      reason: entry.reason,
      detail: `${moved} changed since this exclusion was recorded — read the pair again, then update or drop the record`,
    });
  }

  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e.key !== 'string') continue;
    if (consumed.has(e.key)) {
      // SEEN BUT NEVER CHECKED. The identity matched a pair this run examined,
      // and no finding about it was one an exclusion may speak to — so the
      // record was neither applied nor refuted. Today that cannot happen with
      // the verdicts `auditConventionDrift` emits; the day it renames one, this
      // is the line that says so instead of two silences cancelling out.
      if (evaluated.has(e.key)) continue;
      counts.unevaluated += 1;
      out.push({
        rule: 'convention-drift',
        file: null,
        label: `${e.vault} — ${e.file}`,
        vault: e.vault,
        relative: e.file,
        convention: e.convention,
        heading: null,
        status: null,
        driftLines: 0,
        exactCount: true,
        line: null,
        snippetSha256: null,
        targetSha256: null,
        declared: null,
        severity: 'warning',
        verdict: FLEET_EXCLUSION.UNEVALUATED,
        reason: e.reason,
        exclusionReason: e.reason,
        exclusionDecision: e.decision,
        coverage: EXCLUSION_COVERAGE.EXAMINED,
        inScope: true,
        detail: 'this pair was examined but produced no comparison this record could be checked against — the exclusion was neither applied nor refuted',
      });
      continue;
    }
    const coverage = coverageOf(e.vault, e.file, e.convention);
    counts.unmatched += 1;
    counts[coverage] = (counts[coverage] ?? 0) + 1;
    out.push({
      rule: 'convention-drift',
      file: null,
      label: `${e.vault} — ${e.file}`,
      vault: e.vault,
      relative: e.file,
      convention: e.convention,
      heading: null,
      status: null,
      driftLines: 0,
      exactCount: true,
      line: null,
      snippetSha256: null,
      targetSha256: null,
      declared: null,
      severity: 'warning',
      verdict: FLEET_EXCLUSION.UNMATCHED,
      reason: e.reason,
      exclusionReason: e.reason,
      exclusionDecision: e.decision,
      // THREE ANSWERS, NOT TWO. "Examined and not found" is a finding about the
      // RECORD; "selected but unreadable" is a finding about the RUN and says
      // nothing about the record; "outside the selection" is neither. The first
      // version had only the first two and gave the middle case the third one's
      // words — a vault this run chose and failed to open was reported as a
      // vault it had never heard of.
      coverage,
      inScope: coverage !== EXCLUSION_COVERAGE.OUTSIDE,
      detail: {
        [EXCLUSION_COVERAGE.EXAMINED]: 'this vault WAS examined and this file or convention was not found in it — check the path, or drop the record',
        [EXCLUSION_COVERAGE.UNKNOWN_CONVENTION]: 'this record names a convention the snippet library does not provide, so nothing compared it — check the name, or drop the record',
        [EXCLUSION_COVERAGE.UNREAD]: 'this run could not read the conventions file this record names — coverage failed, which says nothing about whether the record is right',
        [EXCLUSION_COVERAGE.OUTSIDE]: examinedWholeFleet
          ? 'this record names a vault the scan never examined — check the name, or drop the record'
          : 'this record is about another vault; this run was restricted',
      }[coverage],
    });
  }

  return { findings: out, counts };
}
