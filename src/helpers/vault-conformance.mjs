/**
 * FIRST CONTACT — the router's half of vault conformance.
 *
 * THE PROBLEM THIS SOLVES, stated as it was measured. Two derived artefacts a
 * vault is supposed to carry had no reliable way of getting there:
 *
 *   - `wiki-meta/search-index.json` (the local BM25 tier) was an opt-in that
 *     nothing ever triggered. A vault could exist for months without one, and
 *     `search_smart` on a vault whose Smart Connections was unavailable then
 *     had NO tier left — a hard error where a degraded service was the whole
 *     point of building a second tier.
 *   - the OKF projections drift. The debounced middleware only sees writes made
 *     BY THE ROUTER; a directory created by hand in Obsidian leaves the indexes
 *     stale until something else notices.
 *
 * Neither is fixed by adding another background loop. What both need is a
 * moment that reliably happens: the first time a session touches a vault.
 *
 * WHY THIS IS A STATE MACHINE AND NOT A `Set`.
 *
 * The first version remembered "vault seen" and never looked again. Walk the
 * founding incident through that: `search_smart` fails because there is no
 * index → the failure is what should trigger the repair → but a `Set` marks the
 * vault handled the moment the first attempt STARTS, and if that attempt fails
 * (the vault was offline for two seconds, the REST call 500'd) the session is
 * condemned. Every later `search_smart` fails for the rest of the session, and
 * the feature built to end that loop has recreated it.
 *
 * So a vault is in one of four states:
 *
 *   idle              never attempted this session.
 *   in-flight         a pass is running; concurrent requests AWAIT THE SAME
 *                     promise. Not a queue of rescans — one pass, shared.
 *   succeeded         terminal. Never re-run this session.
 *   failed-retryable  an attempt failed for a reason that may not recur. The
 *                     next qualifying trigger tries again, with a bounded
 *                     attempt count so a permanently-broken vault costs a
 *                     handful of passes, not one per tool call.
 *
 * `dirtyDuringRun` coalesces at most ONE rerun: a trigger arriving while a pass
 * is in flight is not lost, but ten of them do not become ten passes.
 *
 * WHAT IT DELIBERATELY DOES NOT REPAIR. The pass is gated on the private
 * `wiki-meta/` scaffold — the artefact the provisioner writes, and the honest
 * signal that this is a router-managed vault. A vault without it is somebody's
 * hand-made Obsidian vault and is left completely alone. Within a scaffolded
 * vault, `planProjectionWrites` still refuses to overwrite any UNMARKED file and
 * reports it as a conflict, so "repair" can create what is missing without ever
 * touching what a human wrote.
 *
 * Consequence, stated honestly rather than papered over: this moment alone does
 * not make every vault conformant. Coverage is the UNION of provisioning
 * (a newborn vault carries both), this repair, and the bridge's open-time
 * detection. Each has a hole the others cover, and some holes nobody covers —
 * an old vault no session ever touches stays exactly as it is.
 */

import { withVaultLock } from './vault-maintenance-lock.mjs';

/**
 * How many failed passes one vault may cost a session before it is left alone.
 * A vault that is genuinely offline should not pay for a rescan on every tool
 * call; a vault that blipped should get another chance.
 */
export const MAX_CONFORMANCE_ATTEMPTS = 3;

/**
 * Skip reasons that mean "I could not see the vault in full" — the cores RETURN
 * these instead of throwing, and a pass that hit one repaired NOTHING.
 *
 * This is the F1 fix. A transient REST outage on a directory listing (a 500 for
 * three seconds) makes `collectMarkdown` report `listFailures`, and the cores
 * fail closed by RETURNING `{skipped: 'enumeration-failed'}` — deliberately, so
 * they never delete an index for a directory that merely did not answer. But a
 * returned skip is not a thrown error, so the pass used to record no error,
 * report `ok: true`, and let the gate mark the vault `succeeded` — TERMINAL. The
 * retry budget built for exactly this case was never spent, and stderr was
 * silent: search_smart stayed broken for the whole session. That is the founding
 * incident, recreated.
 *
 * So these skips make the pass NON-ok, which routes it to `failed-retryable` and
 * spends the budget. They are distinguished from the "legitimately nothing to
 * do" skips (`no-wiki-meta-scaffold`, `not-initialized`, `root-index-unmarked`),
 * which stay a success — retrying a vault the router does not manage on every
 * tool call would be its own bug.
 */
export const INCOMPLETE_VIEW_SKIPS = new Set([
  'enumeration-failed',
  'enumeration-truncated',
  'page-reads-failed',
  'projection-reads-failed',
]);

/** The incomplete-view skip reason carried by a core result, or null. */
function incompleteViewSkip(result) {
  return result && INCOMPLETE_VIEW_SKIPS.has(result.skipped) ? result.skipped : null;
}

/**
 * Build the maintenance pass: projections, then the search index, inside ONE
 * hold of the per-vault lock.
 *
 * ONE hold, not two, for two reasons. It is the same maintenance window — the
 * A5 requirement that the post-write flush keep BOTH artefacts fed — and taking
 * the lock twice in sequence would let an unrelated writer slip between them and
 * leave the index describing a tree the projections had already moved past.
 *
 * ORDER MATTERS. A projections refresh creates and deletes `index.md` files
 * under `wiki/`, which changes the corpus the index is built from. Indexing
 * first would persist a fingerprint that is one refresh out of date, and the
 * next session would rebuild it for nothing.
 *
 * @param {object} input
 * @param {(vault:object)=>Promise<any>} [input.refreshProjections] core, unlocked
 * @param {(vault:object)=>Promise<any>} [input.ensureSearchIndex]  core, unlocked
 * @param {(msg:string)=>void} [input.logInfo]
 * @returns {(vault:object)=>Promise<object>} the pass
 */
export function createMaintenancePass({
  refreshProjections = null,
  ensureSearchIndex = null,
  logInfo = (msg) => console.error(msg),
} = {}) {
  return function maintain(vault) {
    return withVaultLock(vault.name, async () => {
      const report = {
        vault: vault.name,
        projections: null,
        searchIndex: null,
        conflicts: [],
        errors: [],
      };

      if (typeof refreshProjections === 'function') {
        try {
          report.projections = await refreshProjections(vault);
          const conflicts = report.projections?.conflicts;
          if (Array.isArray(conflicts) && conflicts.length > 0) report.conflicts.push(...conflicts);
          // A RETURNED skip that means "I could not read the vault in full" is a
          // failure, not a success — see INCOMPLETE_VIEW_SKIPS.
          const skip = incompleteViewSkip(report.projections);
          if (skip) report.errors.push(`projections: ${skip} — the vault could not be read in full, nothing was repaired`);
        } catch (err) {
          report.errors.push(`projections: ${err?.message ?? err}`);
        }
      }

      if (typeof ensureSearchIndex === 'function') {
        try {
          report.searchIndex = await ensureSearchIndex(vault);
          const conflicts = report.searchIndex?.conflicts;
          if (Array.isArray(conflicts) && conflicts.length > 0) report.conflicts.push(...conflicts);
          const skip = incompleteViewSkip(report.searchIndex);
          if (skip) report.errors.push(`search-index: ${skip} — the vault could not be read in full, nothing was repaired`);
        } catch (err) {
          report.errors.push(`search-index: ${err?.message ?? err}`);
        }
      }

      // A pass that could not complete its work is NOT a success — see the gate:
      // it is what keeps a two-second outage from condemning a whole session.
      report.ok = report.errors.length === 0;

      // One line, only when something actually happened. A silent no-op on an
      // already-conformant vault is the common case and must stay silent, or the
      // stderr trace becomes noise nobody reads.
      const projectionsChanged =
        (report.projections?.written?.length ?? 0) > 0 || (report.projections?.deleted?.length ?? 0) > 0;
      const indexChanged = report.searchIndex?.written === true;
      if (projectionsChanged || indexChanged || report.conflicts.length > 0 || report.errors.length > 0) {
        const parts = [];
        if (projectionsChanged) {
          parts.push(
            `projections ${report.projections.written.length} written, ${report.projections.deleted.length} deleted`,
          );
        }
        if (indexChanged) parts.push(`search index rebuilt (${report.searchIndex.stats?.chunks ?? 0} chunks)`);
        if (report.conflicts.length > 0) parts.push(`${report.conflicts.length} conflict(s) left untouched`);
        if (report.errors.length > 0) parts.push(`${report.errors.length} error(s): ${report.errors.join('; ')}`);
        logInfo(`[obsidian-mcp-router] vault maintenance for "${vault.name}": ${parts.join(', ')}`);
      }

      return report;
    });
  };
}

/**
 * The first-contact gate.
 *
 * @param {object} input
 * @param {(vault:object)=>Promise<object>} input.maintain the pass (locked)
 * @param {number} [input.maxAttempts]
 * @param {(msg:string)=>void} [input.logError]
 */
export function createConformanceGate({
  maintain,
  maxAttempts = MAX_CONFORMANCE_ATTEMPTS,
  logError = (msg) => console.error(msg),
} = {}) {
  /**
   * vault name → {
   *   status: 'in-flight'|'succeeded'|'failed-retryable'|'exhausted',
   *   promise, attempts, dirtyDuringRun
   * }
   */
  const states = new Map();

  function start(vault, entry) {
    entry.status = 'in-flight';
    entry.attempts += 1;
    entry.dirtyDuringRun = false;

    const promise = Promise.resolve()
      .then(() => maintain(vault))
      .catch((err) => {
        // `maintain` swallows per-step failures; this is the belt for a defect
        // in the pass itself.
        logError(
          `[obsidian-mcp-router] first-contact conformance failed for "${vault.name}": ${err?.message ?? err}`,
        );
        return { vault: vault.name, ok: false, errors: [String(err?.message ?? err)], conflicts: [] };
      })
      .then((report) => {
        const ok = report?.ok !== false;
        if (ok) {
          entry.status = 'succeeded';
        } else {
          // A FAILED PASS DOES NOT CONDEMN THE SESSION. A vault that was offline
          // for two seconds must be retried on the next qualifying trigger —
          // that is the whole difference between this and the `Set` it replaced.
          entry.status = entry.attempts >= maxAttempts ? 'exhausted' : 'failed-retryable';
          if (entry.status === 'exhausted') {
            // EXHAUSTED-LOUD, never succeeded-silent. If the budget runs out the
            // vault's indexes may be stale or missing for the rest of the
            // session, and a search running without its local tier with no word
            // on stderr is undetectable. Name the two usual causes so the
            // operator knows where to look.
            const detail = report?.errors?.length ? ` Last: ${report.errors.join('; ')}` : '';
            logError(
              `[obsidian-mcp-router] vault "${vault.name}": conformance repair exhausted after ${entry.attempts} ` +
                'attempt(s) — the vault could not be read in full (an unreadable subtree, or a tree deeper than the ' +
                `walker's limit). Its derived indexes may be stale or missing for the rest of this session.${detail}`,
            );
          }
        }
        // A trigger that arrived mid-pass is worth exactly ONE rerun: the tree
        // moved after this pass read it. More than one would be a rescan loop.
        if (entry.dirtyDuringRun && entry.status === 'succeeded') {
          entry.status = 'failed-retryable';
          entry.attempts = 0; // the rerun is warranted work, not a retry
        }
        entry.promise = null;
        return report;
      });

    entry.promise = promise;
    return promise;
  }

  return {
    /**
     * Verify (and repair) this vault if it is this session's first successful
     * contact with it.
     *
     * @returns {Promise<object|null>} the pass report, the SHARED in-flight
     *   promise when a pass is already running, or `null` when there is nothing
     *   to do (already succeeded, attempts exhausted, or not a vault).
     */
    ensure(vault) {
      if (!vault || typeof vault.name !== 'string') return Promise.resolve(null);

      let entry = states.get(vault.name);
      if (!entry) {
        entry = { status: 'idle', promise: null, attempts: 0, dirtyDuringRun: false };
        states.set(vault.name, entry);
      }

      if (entry.status === 'in-flight') {
        // THE SAME promise, not a chained rescan. Ten tool calls landing during
        // one pass are ten callers of one pass.
        entry.dirtyDuringRun = true;
        return entry.promise;
      }
      if (entry.status === 'succeeded' || entry.status === 'exhausted') return Promise.resolve(null);

      return start(vault, entry);
    },

    /** State of one vault (tests + diagnostics). */
    stateOf(vaultName) {
      return states.get(vaultName)?.status ?? 'idle';
    },

    /** Attempts spent on one vault (tests + diagnostics). */
    attemptsFor(vaultName) {
      return states.get(vaultName)?.attempts ?? 0;
    },

    /** Vault names this session has attempted (tests + diagnostics). */
    seen() {
      return [...states.keys()];
    },

    /** Forget everything (tests). */
    reset() {
      states.clear();
    },
  };
}
