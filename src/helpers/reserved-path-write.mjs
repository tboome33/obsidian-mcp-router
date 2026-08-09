/**
 * Conditional writes to RESERVED projection/index paths — the F3-b volet.
 *
 * WHAT THIS DOES, AND WHAT IT HONESTLY DOES NOT.
 *
 * A maintenance pass reads the vault (snapshot), computes a plan, then writes.
 * Between the read and the write, a foreign file can appear on a reserved path
 * (`wiki/<dir>/index.md`, `wiki-meta/search-index.json`) — realistically via a
 * sync client (Obsidian Sync / LiveSync / Dropbox / iCloud) materialising it.
 * The old apply overwrote it blind.
 *
 * This module does NOT close that race. It CANNOT: the check and the write are
 * two separate operations against a store that other writers (a native
 * `PUT /vault`, the open Obsidian editor, a sync apply) can touch in between —
 * inherent to optimistic concurrency, and confirmed in the bridge's own
 * `vault-cas.ts` "Atomicity — HONEST SCOPE" note. What it delivers instead is:
 *
 *   1. NON-DESTRUCTION (the security core). On the automatic path, foreign
 *      content on a reserved path is NEVER lost without a recoverable copy.
 *      Either the write is refused and the foreign file is left intact (the
 *      cooperative-CAS and strict modes), OR — when the only available write is
 *      unconditional — the foreign bytes are copied to a unique timestamped
 *      sidecar backup BEFORE the overwrite, and the result names that backup.
 *   2. WINDOW REDUCTION, not closure. The read is done as late as possible, so
 *      the unguarded interval shrinks from the whole enumerate→read→plan span to
 *      one read→write step. A file landing strictly inside THAT step is still
 *      overwritten — see the sub-interval test — but its bytes are only lost if
 *      the late read could not see it, and the doc says so.
 *   3. HONESTY. Nothing here is called "atomic" except the cooperative-CAS tier,
 *      and even that is "atomic only between cooperating CAS writers".
 *
 * THE THREE PROTECTION MODES (reported per apply as `protectionMode`):
 *   - 'atomic-cooperative' — the bridge's `/vault-cas` serviced the overwrite.
 *     A mismatch is refused by the bridge (409) → conflict, file left intact.
 *     Atomic ONLY against other cooperating CAS writers.
 *   - 'reduced-getcompare' — no usable CAS route. A late read decides: still
 *     ours → regenerate; foreign → back it up, then overwrite. The window is
 *     reduced, not closed.
 *   - 'skipped-strict' — `OBSIDIAN_ROUTER_STRICT_RESERVED_CAS=1` and no usable
 *     CAS route: the racy overwrite is SKIPPED and reported as a
 *     capacity-conflict instead. Zero foreign overwrite, at the cost of skipped
 *     repairs on a native-only backend.
 *
 * DELETES ARE NOT HANDLED HERE, on purpose. An automatic delete of a
 * reserved-path file is irrecoverable by nature; the maintenance path never
 * deletes automatically (it reports `pendingDeletes`), so there is nothing to
 * guard.
 *
 * Pure of module-level I/O: every effect is an injected dep, so both cores, the
 * wrappers and the tests share one contract (no test passes while production
 * would hit an unimplemented primitive).
 */

import { contentSha256 } from './content-hash.mjs';

/** Substring that marks a recoverable backup sidecar. STABLE. */
export const RESERVED_BACKUP_INFIX = '.bak-';

/**
 * Is strict reserved-path CAS mode on? `OBSIDIAN_ROUTER_STRICT_RESERVED_CAS`
 * truthy → skip a racy overwrite (capacity-conflict) instead of the reduced
 * backup-then-overwrite path. Zero foreign overwrite, at the cost of skipped
 * repairs on a native-only backend. Read from `env` (injectable for tests).
 */
export function strictReservedCasEnabled(env = process.env) {
  const v = String(env?.OBSIDIAN_ROUTER_STRICT_RESERVED_CAS ?? '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

/** The protection mode aggregate labels, weakest last. */
export const PROTECTION_MODES = Object.freeze({
  ATOMIC: 'atomic-cooperative',
  REDUCED: 'reduced-getcompare',
  STRICT: 'skipped-strict',
  UNCONDITIONAL: 'unconditional',
});

/**
 * Is this a backup sidecar we wrote? Such a file must never be indexed, treated
 * as a projection, or itself backed up. The `.md`-only walkers already exclude
 * it (a backup name never ends in `.md`); this predicate is the explicit,
 * testable statement of that exclusion.
 *
 * @param {string} relPath
 */
export function isReservedBackupPath(relPath) {
  return String(relPath ?? '').includes(RESERVED_BACKUP_INFIX);
}

/**
 * Build a backup sidecar name for `origPath`. `n` disambiguates a collision
 * (the C12 lesson: a same-instant stamp is not unique on its own).
 *
 * The timestamp is filesystem-safe (`:`/`.` → `-`). The name deliberately does
 * NOT end in `.md`, so the projection/BM25 walkers skip it.
 *
 * @param {string} origPath
 * @param {number} nowMs
 * @param {number} n  0 → no suffix; ≥1 → `-n`
 */
export function reservedBackupName(origPath, nowMs, n = 0) {
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-');
  return n <= 0 ? `${origPath}${RESERVED_BACKUP_INFIX}${stamp}` : `${origPath}${RESERVED_BACKUP_INFIX}${stamp}-${n}`;
}

/** Does a path currently EXIST in the vault? (true unless a genuine 404) */
async function existsInVault(deps, vault, path) {
  try {
    await deps.getFileContent(vault, path);
    return true;
  } catch (err) {
    if (err?.kind === 'not_found') return false;
    throw err; // offline/unauthorized — do NOT treat as "free to write over"
  }
}

/**
 * Copy `content` to a UNIQUE backup sidecar next to `origPath`, and return its
 * path. Never overwrites an existing backup — the C12 uniqueness lesson: two
 * backups landing in the same stamp resolution must not clobber each other, so
 * we probe and disambiguate with `-n`.
 *
 * @param {object} deps {getFileContent, writeFile}
 * @param {object} vault
 * @param {string} origPath
 * @param {string} content   the foreign bytes to preserve
 * @param {number} nowMs
 * @returns {Promise<string>} the backup path actually written
 */
export async function writeUniqueBackup(deps, vault, origPath, content, nowMs) {
  let n = 0;
  let bak = reservedBackupName(origPath, nowMs, n);
  // Uniqueness loop, mirroring helpers/agent-host-install.mjs backupSidecar.
  // Bounded so a pathological vault cannot spin forever.
  while (await existsInVault(deps, vault, bak)) {
    n += 1;
    bak = reservedBackupName(origPath, nowMs, n);
    if (n > 10000) throw new Error(`could not find a free backup name for ${origPath}`);
  }
  await deps.writeFile(vault, bak, content);
  return bak;
}

/**
 * Apply ONE planned write to a reserved path, conditionally.
 *
 * @param {object} input
 * @param {object} input.deps {writeFile, getFileContent, attemptAtomicCas}
 * @param {object} input.vault
 * @param {string} input.path
 * @param {string} input.content            the generated content to write
 * @param {string|null|undefined} input.snapshotContent  what we read at snapshot
 *   (undefined/null = the path was ABSENT at snapshot → this is a CREATE)
 * @param {(current: string) => boolean} input.isOurs  recognises OUR own
 *   regeneratable artefact in `current` (marker present / valid index). Foreign
 *   content fails it and earns a backup.
 * @param {'reduced'|'strict'} input.mode
 * @param {number} input.nowMs
 * @returns {Promise<{path, written:boolean, conflict:boolean, conflictKind?:string, backupPath?:string, mode:string}>}
 */
export async function applyReservedWrite({ deps, vault, path, content, snapshotContent, isOurs, mode, nowMs }) {
  // CREATE — the path was absent at snapshot. Use the server's native
  // create-only-if-absent contract (Apply-If-Content-Preexists:false). If a
  // file appeared in the window the create is REFUSED (409) → conflict, and
  // because the write never happened that foreign file is left untouched. This
  // is conditional per the SERVER contract; whether the server's check-and-write
  // is itself indivisible is the server's guarantee, not one proven here.
  if (snapshotContent === undefined || snapshotContent === null) {
    try {
      await deps.writeFile(vault, path, content, { applyIfContentPreexists: false });
      return { path, written: true, conflict: false, mode: PROTECTION_MODES.REDUCED };
    } catch (err) {
      if (err?.kind === 'conflict') {
        return { path, written: false, conflict: true, conflictKind: 'appeared', mode: PROTECTION_MODES.REDUCED };
      }
      throw err;
    }
  }

  // OVERWRITE — the path held OUR projection/index at snapshot. Try the
  // cooperative CAS route first.
  const expectedSha = contentSha256(snapshotContent);
  const atomic = await deps.attemptAtomicCas(vault, path, content, expectedSha);
  // A real 409 is thrown by attemptAtomicCas (it never returns a conflict), so
  // reaching here means either success or an unusable route.
  if (atomic && atomic.ok) {
    return { path, written: true, conflict: false, mode: PROTECTION_MODES.ATOMIC };
  }

  // No usable CAS route (404 / body-not-text 400 / 413 / 415).
  if (mode === 'strict') {
    // Refuse the racy overwrite entirely — zero foreign overwrite.
    return {
      path,
      written: false,
      conflict: true,
      conflictKind: 'capacity',
      mode: PROTECTION_MODES.STRICT,
    };
  }

  // reduced: read as LATE as possible, then decide.
  let current;
  try {
    current = await deps.getFileContent(vault, path);
  } catch (err) {
    if (err?.kind === 'not_found') {
      // Vanished since snapshot — recreate it (nothing to lose).
      await deps.writeFile(vault, path, content);
      return { path, written: true, conflict: false, mode: PROTECTION_MODES.REDUCED };
    }
    throw err;
  }
  const currentStr = typeof current === 'string' ? current : String(current?.content ?? current ?? '');

  if (isOurs(currentStr)) {
    // Still our own artefact — regenerate, NO backup (a .bak on every refresh
    // would be pollution).
    await deps.writeFile(vault, path, content);
    return { path, written: true, conflict: false, mode: PROTECTION_MODES.REDUCED };
  }

  // FOREIGN content is here now. NON-DESTRUCTION: preserve it before we
  // overwrite. The residual sub-window (a file landing AFTER this read) is not
  // covered — documented, not claimed closed.
  const backupPath = await writeUniqueBackup(deps, vault, path, currentStr, nowMs);
  await deps.writeFile(vault, path, content);
  return { path, written: true, conflict: false, backupPath, mode: PROTECTION_MODES.REDUCED };
}

/**
 * Apply a list of planned reserved writes. Aggregates the per-write outcomes.
 *
 * @param {object} input
 * @param {object} input.deps
 * @param {object} input.vault
 * @param {Array<{path, content, snapshotContent, isOurs}>} input.plannedWrites
 * @param {'reduced'|'strict'} input.mode
 * @param {number} [input.nowMs]
 * @returns {Promise<{written:string[], conflicts:string[], backups:Array<{path,backupPath}>, protectionMode:string, warnings:string[]}>}
 */
export async function applyReservedWrites({ deps, vault, plannedWrites, mode, nowMs = Date.now() }) {
  const written = [];
  const conflicts = [];
  const backups = [];
  const warnings = [];
  const modesSeen = new Set();

  for (const w of plannedWrites) {
    const outcome = await applyReservedWrite({
      deps,
      vault,
      path: w.path,
      content: w.content,
      snapshotContent: w.snapshotContent,
      isOurs: w.isOurs,
      mode,
      nowMs,
    });
    modesSeen.add(outcome.mode);
    if (outcome.written) written.push(outcome.path);
    if (outcome.conflict) conflicts.push(outcome.path);
    if (outcome.backupPath) {
      backups.push({ path: outcome.path, backupPath: outcome.backupPath });
      warnings.push(
        `reserved path "${outcome.path}" held foreign content when the maintenance write reached it — ` +
          `the foreign bytes were preserved at "${outcome.backupPath}" before regenerating. ` +
          'This is a race the router cannot close; recover from the backup if the file was yours.',
      );
    }
    if (outcome.conflict && outcome.conflictKind === 'capacity') {
      warnings.push(
        `reserved path "${outcome.path}" could not be written under a cooperative CAS route and strict mode ` +
          'is on — the repair was SKIPPED to avoid a racy overwrite (capacity-conflict).',
      );
    }
  }

  // Aggregate mode: the WEAKEST guarantee actually used, so a caller reading one
  // field is never told the pass was stronger than its weakest write.
  const protectionMode = modesSeen.has(PROTECTION_MODES.STRICT)
    ? PROTECTION_MODES.STRICT
    : modesSeen.has(PROTECTION_MODES.REDUCED)
      ? PROTECTION_MODES.REDUCED
      : modesSeen.has(PROTECTION_MODES.ATOMIC)
        ? PROTECTION_MODES.ATOMIC
        : null;

  return { written, conflicts, backups, protectionMode, warnings };
}
