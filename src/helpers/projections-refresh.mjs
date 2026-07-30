/**
 * Debounced OKF-projections refresh — the "kept fed as files are created"
 * half of volet ② (the other half is the explicit `refresh_okf_projections`
 * tool, which shares the same core).
 *
 * Design: after any successful write-tool call touching CONTENT under
 * `wiki/`, schedule a FULL projection refresh for that vault, debounced.
 * A burst of writes (a wiki-ingest filing six pages) coalesces into ONE
 * refresh a few seconds after the burst quiets down.
 *
 * Why full-refresh-debounced rather than incremental per-write surgery:
 * projections are pure functions of the tree, so a full rebuild is ALWAYS
 * correct — no upsert grammar to keep in sync, no drifting subdirectory
 * counts, no ordering bugs. The cost (one bounded enumeration + one read per
 * page) is paid per QUIET PERIOD, not per write, and only by vaults that
 * opted in (the core's `requireInitialized` gate: root `wiki/index.md`
 * present and marker-carrying).
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

export const DEFAULT_DEBOUNCE_MS = 15_000;

/**
 * Which vault path(s) does a write-tool call touch? Returns [] for tools
 * without a path (or with a non-string one). `move_file` reports BOTH ends —
 * a page moving out of `wiki/` must still refresh the indexes it left.
 */
export function pathsTouchedByWrite(toolName, args = {}) {
  if (toolName === 'move_file') {
    return [args.from, args.to].filter((p) => typeof p === 'string' && p);
  }
  if (toolName === 'execute_template') {
    return typeof args.targetPath === 'string' && args.targetPath ? [args.targetPath] : [];
  }
  return typeof args.path === 'string' && args.path ? [args.path] : [];
}

/**
 * @param {object} input
 * @param {(vault: object) => Promise<any>} input.refresh The refresh core.
 * @param {number} [input.delayMs]
 * @param {Function} [input.setTimeoutFn] injected for tests
 * @param {Function} [input.clearTimeoutFn] injected for tests
 * @param {(msg: string) => void} [input.logError]
 */
export function createProjectionsScheduler({
  refresh,
  delayMs = DEFAULT_DEBOUNCE_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  logError = (msg) => console.error(msg),
}) {
  const timers = new Map(); // vault name → {timer, vault}

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
        Promise.resolve()
          .then(() => refresh(vault))
          .catch((err) => {
            logError(
              `[obsidian-mcp-router] okf-projections refresh failed for vault "${vault.name}": ${err?.message ?? err}`,
            );
          });
      }, delayMs);
      // A pending refresh must never keep the server process alive.
      if (timer && typeof timer.unref === 'function') timer.unref();
      timers.set(vault.name, { timer, vault });
      return true;
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
