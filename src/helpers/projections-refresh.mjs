/**
 * Debounced post-write vault MAINTENANCE — the "kept fed as files are created"
 * half of volet ② (the other half is the explicit `refresh_okf_projections`
 * tool, which shares the same core).
 *
 * Design: after any successful write-tool call touching CONTENT under
 * `wiki/`, schedule a FULL maintenance pass for that vault, debounced.
 * A burst of writes (a wiki-ingest filing six pages) coalesces into ONE
 * pass a few seconds after the burst quiets down.
 *
 * BOTH derived artefacts, one window. The flush refreshes the OKF projections
 * AND the BM25 search index, because the alternative was measured and is absurd:
 * first contact repairs the index, the session's first write makes it stale, and
 * nothing rebuilds it until the NEXT session's first contact — so the index is
 * wrong for exactly as long as the session is productive. The index build
 * short-circuits on its corpus fingerprint, so a flush that changed nothing
 * indexable costs a read pass and no write.
 *
 * Why full-refresh-debounced rather than incremental per-write surgery:
 * projections are pure functions of the tree, so a full rebuild is ALWAYS
 * correct — no upsert grammar to keep in sync, no drifting subdirectory
 * counts, no ordering bugs. The cost (one bounded enumeration + one read per
 * page) is paid per QUIET PERIOD, not per write, and only by vaults that
 * opted in (the core's scaffold gate: `wiki-meta/catalog.md` present).
 *
 * The scheduler is deliberately dumb: it maps vault name → pending timer and
 * knows nothing about REST or projections. The refresh function is injected
 * (the server passes the tool core; tests pass a spy), timers are injected
 * for mock-timer tests, and every timer is `unref()`d so a pending refresh
 * never holds the server process open.
 *
 * Failure policy: best-effort. A refresh that throws logs to stderr and is
 * forgotten — the next write reschedules, and wiki-lint's drift check plus
 * the on-demand tool are the reconciliation paths. Never blocks a user write.
 */

import { isWikiContentPath, isProjectionPath } from './okf-projections.mjs';
import { writeTargets } from './write-targets.mjs';

export const DEFAULT_DEBOUNCE_MS = 15_000;

/**
 * Which vault path(s) does a write-tool call touch? Returns [] for tools whose
 * call names no target. `move_file` reports BOTH ends — a page moving out of
 * `wiki/` must still refresh the indexes it left.
 *
 * DELEGATES to `helpers/write-targets.mjs`, which is now the ONE definition of
 * "what does this call write". This function used to hold a second, older copy
 * of that rule and it had drifted three ways, all measured against this
 * scheduler:
 *
 *   write_bundle steps:[{path:'wiki/a.md'}]  -> []             a bundle write
 *                                               scheduled NO refresh at all;
 *                                               the projections went stale for
 *                                               exactly the tool that writes
 *                                               the most pages at once. A
 *                                               functional bug, not an audit one.
 *   execute_template targetPath (no createFile)
 *                                            -> ['wiki/t.md'] a render-only
 *                                               call refreshed for a file it
 *                                               never wrote.
 *   build_search_index path:'wiki/forged.md' -> ['wiki/forged.md']
 *                                               an UNDECLARED argument drove a
 *                                               refresh; the tool writes
 *                                               `wiki-meta/search-index.json`.
 *
 * The rule had been fixed in `pickAuditPath` two rounds earlier and never
 * reached here, because it was a copy. Order is not meaningful to a debounced
 * scheduler — the list is a set of things to notice.
 */
export function pathsTouchedByWrite(toolName, args = {}) {
  return writeTargets(toolName, args);
}

/**
 * @param {object} input
 * @param {(vault: object) => Promise<any>} input.refresh The refresh core.
 * @param {number} [input.delayMs]
 * @param {Function} [input.setTimeoutFn] injected for tests
 * @param {Function} [input.clearTimeoutFn] injected for tests
 * @param {(msg: string) => void} [input.logError]
 * @param {(vault: object) => boolean} [input.shouldSkip] Re-checked immediately
 *   before a QUEUED refresh actually runs — never at `noteWrite` time. A write
 *   is noted, then debounced for up to `delayMs`; `config.json` can be
 *   hot-reloaded in that window, and the `vault` object this scheduler is
 *   holding was captured at note-time, not re-resolved against whatever is
 *   live now. Without this hook, a vault turned `alsoLocked` mid-debounce
 *   still received the queued projections/index write — the "no exceptions"
 *   hard tier, silently defeated by a race that has nothing to do with the
 *   write that scheduled the refresh. Default `() => false` preserves the
 *   original unconditional behaviour for every caller (a test, or a build
 *   with no such tier concept) that does not pass one.
 */
export function createProjectionsScheduler({
  refresh,
  delayMs = DEFAULT_DEBOUNCE_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  logError = (msg) => console.error(msg),
  shouldSkip = () => false,
}) {
  const timers = new Map(); // vault name → {timer, vault}

  /**
   * Run one maintenance pass for `vault`.
   *
   * SERIALIZATION LIVES IN THE PASS, NOT HERE. `refresh` is the locked
   * maintenance pass from `helpers/vault-conformance.mjs`, which takes the
   * process-wide per-vault lock (`helpers/vault-maintenance-lock.mjs`). Holding a
   * second mutex here would be a second lock over the same resource — and since
   * that lock is a non-reentrant serial queue, acquiring it twice around one job
   * would deadlock rather than protect anything.
   *
   * That also closes the hole the debounce was standing in for. The debounce is
   * a delay, not a lock: a refresh slower than the quiet period was still
   * running when the next timer fired, and the explicit MCP tools never went
   * near it at all. Now all four callers — timer flush, first contact,
   * `refresh_okf_projections`, `build_search_index` — queue behind one another.
   *
   * WHAT THIS SCHEDULER STILL OWNS: when to fire. Errors never escape.
   */
  function runRefresh(vault) {
    if (shouldSkip(vault)) return Promise.resolve(null);
    return Promise.resolve()
      .then(() => refresh(vault))
      .catch((err) => {
        logError(
          `[obsidian-mcp-router] vault maintenance failed for vault "${vault.name}": ${err?.message ?? err}`,
        );
        return null;
      });
  }

  return {
    /**
     * Note a successful write. Returns true when a refresh was (re)scheduled.
     * Writes to projection files themselves never schedule (the middleware
     * never produces them — writes go through rest-client directly — but a
     * USER hand-writing one via a tool must not trigger a refresh loop that
     * immediately rewrites it either; the conflict surfaces in check mode).
     */
    noteWrite(vault, toolName, args) {
      if (!vault || typeof vault.name !== 'string') return false;
      const touched = pathsTouchedByWrite(toolName, args)
        .map((p) => String(p).replace(/\\/g, '/'))
        .filter((p) => isWikiContentPath(p) && !isProjectionPath(p));
      if (touched.length === 0) return false;

      const existing = timers.get(vault.name);
      if (existing) clearTimeoutFn(existing.timer);
      const timer = setTimeoutFn(() => {
        timers.delete(vault.name);
        void runRefresh(vault);
      }, delayMs);
      // A pending refresh must never keep the server process alive.
      if (timer && typeof timer.unref === 'function') timer.unref();
      timers.set(vault.name, { timer, vault });
      return true;
    },

    /**
     * Refresh NOW, through the same mutex the debounced path uses.
     *
     * This is the entry point the first-contact conformance repair calls. It is
     * deliberately a method on the scheduler rather than a direct call to the
     * refresh core: a direct call would be a second concurrent refresh path,
     * and two full rebuilds of the same tree racing each other is precisely
     * what the mutex above exists to prevent.
     *
     * A pending debounced refresh for this vault is CANCELLED first — it was
     * scheduled to catch up with writes this run is about to cover anyway, and
     * letting it fire afterwards would rebuild the same tree twice.
     *
     * Resolves with the refresh core's result, or `null` when the refresh threw
     * (already logged). Never rejects: nav upkeep must not fail its caller.
     */
    runNow(vault) {
      if (!vault || typeof vault.name !== 'string') return Promise.resolve(null);
      const existing = timers.get(vault.name);
      if (existing) {
        clearTimeoutFn(existing.timer);
        timers.delete(vault.name);
      }
      return runRefresh(vault);
    },

    /** Pending vault names (tests + diagnostics). */
    pending() {
      return [...timers.keys()];
    },

    /** Cancel everything (tests). */
    cancelAll() {
      for (const { timer } of timers.values()) clearTimeoutFn(timer);
      timers.clear();
    },
  };
}
