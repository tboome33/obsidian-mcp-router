/**
 * THE per-vault maintenance lock.
 *
 * Four different callers can rebuild a vault's derived artefacts — the debounced
 * post-write flush, the first-contact repair, and the two explicit MCP tools
 * (`refresh_okf_projections`, `build_search_index`). Every one of them does the
 * same thing: enumerate the tree, read it, compute a plan, write. Two of those
 * running at once on one vault is a race with no winner — both computed their
 * plan from a tree that the other was changing, and whichever finishes last
 * decides, silently.
 *
 * The debounce that used to stand in for this was never a lock. It is a delay:
 * a refresh slower than the quiet period is still running when the next timer
 * fires. And the tool wrappers never went near it at all — they called their
 * cores directly, so an explicit `refresh_okf_projections` could always race the
 * middleware. "One entry point" was a design intention that the code did not
 * hold up.
 *
 * So this module is the entry point, and it is a MODULE-LEVEL singleton on
 * purpose: a lock that each caller constructs for itself locks nothing.
 *
 * SEMANTICS — a serial queue per vault, not a mutual-exclusion flag:
 *
 *   - work is run in arrival order, one at a time per vault;
 *   - a failing job does not poison the queue (the next one runs anyway);
 *   - `withVaultLock` rejects/resolves exactly as its job did, so callers keep
 *     their own error handling;
 *   - different vaults never wait on each other.
 *
 * NOT RE-ENTRANT, deliberately. Acquiring inside a held section would deadlock:
 * the inner job waits for the queue tail, which is the outer job. Compose by
 * putting the whole sequence in ONE section (see `runMaintenancePass`), never by
 * nesting two. `assertNotHeld` exists so that mistake fails loudly in tests
 * instead of hanging.
 *
 * WHAT IT IS NOT. It serializes work inside ONE router process. Two router
 * processes on the same vault still converge rather than transact — see the
 * limits recorded in docs/features/13-installation-et-administration.md.
 */

/** vault name → tail of its queue (a promise that never rejects). */
const queues = new Map();

/** vault names with a section currently executing (diagnostics + tests). */
const held = new Set();

/**
 * Run `job` with exclusive access to `vaultName`'s maintenance.
 *
 * @param {string} vaultName
 * @param {() => Promise<T>|T} job
 * @returns {Promise<T>} whatever `job` returned — or its rejection.
 * @template T
 */
export function withVaultLock(vaultName, job) {
  const key = String(vaultName ?? '');
  const previous = queues.get(key) ?? Promise.resolve();

  // `.then(run, run)` rather than `.then(run)`: the predecessor's OUTCOME is
  // none of this job's business. A single failed refresh must not wedge every
  // later one behind a rejected promise.
  const run = previous.then(
    () => {
      held.add(key);
      return job();
    },
    () => {
      held.add(key);
      return job();
    },
  );

  // The tail the NEXT caller waits on must never reject, or the chain would
  // propagate one job's failure into every successor's `.then`.
  const tail = run.then(
    () => { held.delete(key); },
    () => { held.delete(key); },
  );
  queues.set(key, tail);
  // Drop the entry once the queue drains, so a long-lived process does not keep
  // one settled promise per vault it ever touched.
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });

  return run;
}

/** Is a section currently executing for this vault? (diagnostics + tests) */
export function isVaultLockHeld(vaultName) {
  return held.has(String(vaultName ?? ''));
}

/**
 * Throw if the lock is already held for this vault.
 *
 * Used at the top of the tool wrappers' lock acquisition in tests to turn the
 * re-entrancy deadlock into an immediate, readable failure. Not used in
 * production paths: a legitimate caller that arrives while another holds the
 * lock must QUEUE, not throw.
 */
export function assertVaultLockFree(vaultName, context = 'maintenance') {
  if (isVaultLockHeld(vaultName)) {
    throw new Error(
      `re-entrant vault maintenance lock for "${vaultName}" (${context}) — ` +
        'compose sequences inside one withVaultLock section, never by nesting two.',
    );
  }
}

/** Vault names with queued or running work (diagnostics + tests). */
export function lockedVaults() {
  return [...queues.keys()];
}
