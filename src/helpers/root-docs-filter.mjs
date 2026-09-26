/**
 * What the reference vault's root docs may carry INTO another vault.
 *
 * `cloneRootDocs` copies `README.md`, `Documentation/` and `.claude/` from the
 * reference vault. `Documentation/` is also where the reference vault keeps its
 * CONVENTIONS FILE (`Documentation/CLAUDE.md`) — and, since 2026-09-11, the
 * `CLAUDE.md.bak-*` backups of the edits made to it. Copying that folder
 * wholesale did two things nobody asked for, measured on 2026-09-26:
 *
 *   1. A vault that already had its conventions file elsewhere (at the root,
 *      or under `wiki-meta/`) received a SECOND one. `resolveClaudeMd` refuses
 *      to pick between two, so the conventions tooling stopped working on it
 *      — 13 of 27 local vaults after the 2026-09-22 sync, each holding its own
 *      eight conventions beside a four-convention copy of the template.
 *   2. Every vault received three `CLAUDE.md.bak-*` files that are the
 *      TEMPLATE's history, not its own. A later diagnosis read them as the
 *      vault's past and concluded that four conventions had been lost there.
 *      They never had been: the vault was born with the template's current
 *      file.
 *
 * The rules, and nothing more:
 *
 *   - A backup (`<name>.bak`, `<name>.bak-<anything>`, `<name>.bak.<anything>`)
 *     is never copied. A backup records the history of the file beside it, in
 *     the vault it was made in; in another vault it is a false record.
 *   - A conventions-file candidate (`CLAUDE_MD_CANDIDATES`) is copied only when
 *     the target has NO conventions file at any candidate location. A fresh
 *     vault born from the template still gets the template's conventions — that
 *     is how it gets any. A vault that has one keeps it, alone, with or without
 *     `--force`: its conventions belong to its owner and are changed through
 *     the `conventions` skill, with its preview and backup, never by a docs sync.
 *
 * Pure: no I/O except the `exists` probe the caller passes in.
 */
import path from 'node:path';

import { CLAUDE_MD_CANDIDATES } from './claude-md-conventions.mjs';

/**
 * `CLAUDE.md.bak-2026-09-11`, `CLAUDE.md.bak`, `notes.bak.1` — a backup.
 * `backlog.md`, `CLAUDE.md`, `bakery.md` — not one. The `.bak` must be a whole
 * dot-separated segment, followed by nothing, a `-`, or a `.`.
 */
const BACKUP_SEGMENT = /\.bak(?:$|[-.])/i;

/** True when `name` (a basename) is a backup file's name. */
export function isBackupName(name) {
  return BACKUP_SEGMENT.test(String(name ?? ''));
}

/** Forward-slash, no leading `./`, for comparing against the candidate list. */
function toPosixRelative(rel) {
  return String(rel).split(/[\\/]+/).filter((s) => s && s !== '.').join('/');
}

/**
 * The conventions files a vault already has, among the candidate locations.
 *
 * @param {string} vaultRoot absolute path of the target vault
 * @param {(p: string) => boolean} exists probe (fs.existsSync in production)
 * @returns {string[]} vault-relative candidates that exist, in candidate order
 */
export function existingConventionsFiles(vaultRoot, exists) {
  return CLAUDE_MD_CANDIDATES.filter((c) => exists(path.join(vaultRoot, ...c.split('/'))));
}

/**
 * Build the filter `copyTreeSync` applies while cloning one root-docs item.
 *
 * @param {object} input
 * @param {string} input.referenceVault absolute path of the source vault
 * @param {string[]} input.targetConventions `existingConventionsFiles(target)`
 *   measured BEFORE any copy starts — measuring during the copy would let the
 *   first candidate copied count as "the target already has one"
 * @param {(entry: {relative: string, reason: string}) => void} [input.onSkip]
 *   told about every entry refused, so the caller can print what it left out
 * @returns {(src: string) => boolean}
 */
export function makeRootDocsFilter({ referenceVault, targetConventions, onSkip = () => {} }) {
  // Case-folded where the filesystem folds case: on Windows and macOS a
  // reference spelling `documentation/Claude.md` IS the conventions file, and
  // an exact-case test would let it through.
  const fold = (s) => (process.platform === 'linux' ? s : s.toLowerCase());
  const candidates = new Set(CLAUDE_MD_CANDIDATES.map(fold));
  const targetHasConventions = Array.isArray(targetConventions) && targetConventions.length > 0;
  const root = path.resolve(referenceVault);
  return (src) => {
    const relative = toPosixRelative(path.relative(root, path.resolve(src)));
    if (isBackupName(path.basename(src))) {
      onSkip({ relative, reason: 'backup — the history of the reference vault, not of this one' });
      return false;
    }
    if (targetHasConventions && candidates.has(fold(relative))) {
      onSkip({
        relative,
        reason: `this vault already has its conventions file (${targetConventions.join(', ')}); a second one would leave it ambiguous`,
      });
      return false;
    }
    return true;
  };
}
