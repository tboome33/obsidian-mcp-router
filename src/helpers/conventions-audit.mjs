/**
 * The state of ONE vault's conventions, in the terms a repair needs.
 *
 * Built after a misdiagnosis, and shaped by it. On 2026-09-26 a session read
 * the three `CLAUDE.md.bak-*` files sitting beside the Kiviri-OS conventions
 * file, found four conventions in the oldest that the current file lacked, and
 * concluded that the vault had LOST them on 2026-09-11. It had not. The three
 * backups were byte-for-byte the reference vault's own — its history, copied in
 * with its `Documentation/` folder — and Kiviri-OS had simply been born with the
 * reference vault's current file, which carries four conventions since decision
 * `conventions-livrees-par-le-modele`. A check that compares a file with "an
 * older backup beside it" would have flagged every vault the template ever
 * touched.
 *
 * So this audit asks different questions, each with a stated repair:
 *
 *   ambiguous-conventions-file   two or more candidate files exist; the router
 *                                reads none (resolveClaudeMd refuses to pick).
 *                                When exactly one of them is a verbatim copy of
 *                                the reference vault's file, the repair is to
 *                                RENAME that copy out of the way — reversible,
 *                                and the vault's own file becomes the only one.
 *   inherited-backups            backups that ARE the reference vault's own —
 *                                same name, same bytes: another vault's
 *                                history, not this one's. Nothing to repair — something to
 *                                NOT read as evidence.
 *   missing-recommended          recommended conventions the conventions file
 *                                does not carry. Reinstalled from the CURRENT
 *                                snippet by the `conventions` skill, never
 *                                copied back from a backup, which may be stale.
 *   no-conventions-file          no candidate at all.
 *   reference-unknown            the reference vault's fingerprints could not
 *                                be read, so "inherited" and "template copy"
 *                                are UNKNOWN, not false. Said, never implied.
 *
 * Nothing here writes, and nothing here decides: `findings[].repair` describes
 * a step for a human to approve. Pure — the caller reads, this function judges.
 */
import crypto from 'node:crypto';

import { resolveClaudeMd, detectConventions } from './claude-md-conventions.mjs';

/**
 * The conventions the `meta-attach-vault` picker pre-checks when absent
 * (decision `conventions-livrees-par-le-modele` §2-§3): the four the reference
 * vault ships, and the four it stopped shipping but still recommends.
 * `description-frontmatter` is listed in the picker too, but as a writing
 * guide, not a behaviour — its absence changes nothing enforced (the field is
 * required by the lint either way), so it is not reported as missing here.
 */
export const RECOMMENDED_CONVENTION_IDS = Object.freeze([
  'roadmap-discipline',
  'default-vault-health-check',
  'wiki-query-first',
  'path-disambiguation',
  'source-type',
  'bilingual',
  'heading-hierarchy',
  'auto-enrichment',
]);

/**
 * The identity of a backup for "is this the reference vault's?": its BASENAME
 * and its bytes. Accepts a path or a name.
 */
export function backupKey(pathOrName, sha256) {
  const name = String(pathOrName ?? '').split(/[\\/]/).pop();
  return `${name}\t${sha256}`;
}

/** sha256 of a string's UTF-8 bytes — the router's `contentSha256`. */
export function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

/** YYYY-MM-DD of a Date, for suffixes. */
function isoDay(date) {
  return (date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date()).toISOString().slice(0, 10);
}

/**
 * Audit one vault.
 *
 * @param {object} input
 * @param {string} input.vault the vault's name, echoed into repair steps
 * @param {Array<{path: string, content: string, sha256?: string}>} input.candidates
 *   the conventions-file candidates that EXIST, with their text. `sha256`
 *   defaults to the hash of `content`; pass the byte hash when the caller has
 *   it (a file with a BOM or CRLF hashes differently as bytes and as text).
 * @param {Array<{path: string, sha256: string}>} [input.backups] backup files
 *   found beside the candidates
 * @param {Set<string>|string[]|null} input.referenceFingerprints sha256 of the
 *   reference vault's conventions file AND of each of its backups (each backup
 *   is a past version of the template, so a vault born from any of them
 *   matches). `null` means "could not be read" — the audit then says so.
 * @param {Set<string>|string[]} [input.referenceBackups] `backupKey(name, sha)`
 *   of each backup the reference vault holds. A backup is INHERITED only when
 *   its NAME and its BYTES both match one of these — bytes alone are not
 *   enough: a vault born from the template that later edited its conventions
 *   file makes a backup of the template's text under a name of its own
 *   (measured: `La méthode LICARES`, `CLAUDE.md.bak-bilingual-…`). That backup
 *   is the vault's own history, and calling it inherited would hide a real edit.
 * @param {Array<{id: string, heading: string}>} input.catalogue the snippet library
 * @param {string[]} [input.recommended] defaults to RECOMMENDED_CONVENTION_IDS
 * @param {Date} [input.now] for the rename suffix
 * @returns {object} see the module comment; `verdict` is `ok` | `attention` | `broken`
 */
export function auditVaultConventions({
  vault,
  candidates = [],
  backups = [],
  referenceFingerprints,
  referenceBackups = [],
  catalogue,
  recommended = RECOMMENDED_CONVENTION_IDS,
  now,
}) {
  const refKnown = referenceFingerprints != null;
  const refSet = new Set(refKnown ? [...referenceFingerprints] : []);
  const refBackupSet = new Set(refKnown ? [...(referenceBackups ?? [])] : []);
  const catalogueIds = new Set((catalogue ?? []).map((c) => c.id));

  const files = (Array.isArray(candidates) ? candidates : []).map((c) => {
    const sha256 = c.sha256 || sha256Text(c.content);
    const conventions = detectConventions(c.content ?? '', catalogue ?? [])
      .filter((d) => d.installed)
      .map((d) => d.id);
    return {
      path: c.path,
      sha256,
      conventions,
      // true / false when the reference is known; null when it is not
      templateCopy: refKnown ? refSet.has(sha256) : null,
    };
  });

  const resolved = resolveClaudeMd(files.map((f) => f.path));
  const findings = [];

  if (!refKnown) {
    findings.push({
      kind: 'reference-unknown',
      severity: 'info',
      message: 'The reference vault could not be read, so whether a file or a backup is a copy of the template is UNKNOWN here — not "no".',
      repair: null,
    });
  }

  // The file whose conventions count: the resolved one, or — when ambiguous —
  // the one a repair would keep (the single non-template file), if there is one.
  let effective = files.find((f) => f.path === resolved.path) ?? null;

  if (resolved.ambiguous) {
    const templateCopies = files.filter((f) => f.templateCopy === true);
    const own = files.filter((f) => f.templateCopy === false);
    // Exactly one of each. With two files of the vault's own beside the copy,
    // renaming the copy still leaves two — the repair would not repair, and
    // its summary ("becomes the only conventions file") would be false.
    const renameable = templateCopies.length === 1 && own.length === 1;
    if (renameable) effective = own[0];
    const suffix = `.from-template-${isoDay(now)}`;
    findings.push({
      kind: 'ambiguous-conventions-file',
      severity: 'error',
      message:
        `${files.length} conventions files (${files.map((f) => `${f.path}: ${f.conventions.length} conventions${f.templateCopy ? ', copy of the template' : ''}`).join(' · ')}). ` +
        'With more than one, the router reads none of them: the conventions skill refuses to act, and nothing tells a session which rules apply.',
      repair: renameable
        ? {
          summary: `Rename the template copy ${templateCopies[0].path} out of the way; ${own.map((f) => f.path).join(', ')} becomes the only conventions file. Reversible: renaming it back restores the current state.`,
          steps: [{
            tool: 'move_file',
            args: {
              vault,
              from: templateCopies[0].path,
              to: templateCopies[0].path + suffix,
              ifMatch: templateCopies[0].sha256,
            },
          }],
        }
        : {
          summary: refKnown
            ? 'No single rename resolves this (not exactly one template copy beside exactly one file of the vault\'s own): ask the user which file holds this vault\'s rules, then rename the others.'
            : 'The reference vault is unreadable, so a template copy cannot be told apart: ask the user which file to keep.',
          steps: [],
        },
    });
  } else if (files.length === 0) {
    findings.push({
      kind: 'no-conventions-file',
      severity: 'warning',
      message: 'No conventions file at any candidate location: no convention is in force in this vault.',
      repair: {
        summary: `Run the conventions picker; the first install creates ${resolved.createAt}.`,
        steps: [{ command: `/obsidian-router:conventions pick on ${vault}` }],
      },
    });
  }

  const inherited = (Array.isArray(backups) ? backups : []).map((b) => ({
    path: b.path,
    sha256: b.sha256,
    inherited: refKnown ? refBackupSet.has(backupKey(b.path, b.sha256)) : null,
  }));
  const inheritedPaths = inherited.filter((b) => b.inherited === true).map((b) => b.path);
  if (inheritedPaths.length > 0) {
    findings.push({
      kind: 'inherited-backups',
      severity: 'info',
      message:
        `${inheritedPaths.length}/${inherited.length} backups have the same name and the same bytes as one of the reference vault's own (${inheritedPaths.join(', ')}). ` +
        'They were most likely copied in by a template sync; the match alone cannot tell whether a convention present in them and absent from the current file was ever lost HERE — do not conclude it from them.',
      repair: null,
    });
  }

  let missingRecommended = [];
  if (files.length === 0) {
    missingRecommended = recommended.filter((id) => catalogueIds.has(id));
  } else if (effective) {
    const have = new Set(effective.conventions);
    missingRecommended = recommended.filter((id) => catalogueIds.has(id) && !have.has(id));
    if (missingRecommended.length > 0) {
      findings.push({
        kind: 'missing-recommended',
        severity: 'warning',
        message:
          `${effective.path} carries ${recommended.length - missingRecommended.length}/${recommended.length} recommended conventions; absent: ${missingRecommended.join(', ')}. ` +
          (effective.templateCopy
            ? 'Its bytes are a version of the template\'s own file (the template ships four conventions since 2026-09-11). Whether this vault ever carried the absent ones cannot be told from here: offer them, do not conclude a loss.'
            : 'Absent is a fact, not a verdict: the owner may have declined them.'),
        repair: {
          summary: 'Offer them through the conventions picker (preview, backup, then install from the CURRENT snippet — never restored from a backup).',
          steps: missingRecommended.map((id) => ({ command: `/obsidian-router:conventions install ${id} on ${vault}` })),
        },
      });
    }
  }

  const verdict = findings.some((f) => f.severity === 'error')
    ? 'broken'
    : findings.some((f) => f.severity === 'warning') ? 'attention' : 'ok';

  return {
    vault,
    verdict,
    conventionsFile: resolved.path,
    ambiguous: resolved.ambiguous,
    candidates: files,
    backups: inherited,
    missingRecommended,
    findings,
  };
}
