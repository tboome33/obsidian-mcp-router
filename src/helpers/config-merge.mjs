/**
 * config-merge.mjs — how a process that holds a SNAPSHOT of the router config
 * saves it back without deleting what somebody else wrote in the meantime.
 *
 * ---------------------------------------------------------------------------
 * THE HOLE THIS CLOSES
 * ---------------------------------------------------------------------------
 * `scripts/setup-vault.mjs` reads the whole config, works, and saves the whole
 * config. Taking a lock around the WRITE does not make that safe: the lock is
 * taken at the save, not at the read, and the two are far apart. `setupVault`
 * reads, then clones plugin directories and probes ports, then saves — seconds
 * later. A `confirm_workspace_binding` from a Claude session landing in that
 * window was inside the snapshot's blind spot and disappeared, and the same
 * ordering loses an API key somebody added a moment ago.
 *
 * The comment that used to stand over `saveConfig` claimed this could not
 * happen, because "every caller reads, changes and saves in one synchronous
 * stretch, and the lock makes that stretch exclusive". Synchronous is not
 * short, and the lock does not span the stretch. Found in the final review,
 * 2026-09-03.
 *
 * ---------------------------------------------------------------------------
 * WHY TOP-LEVEL KEYS, AND NOT A DEEP MERGE
 * ---------------------------------------------------------------------------
 * A deep merge would need to know what every key MEANS — whether two edits to
 * `portRegistry` can be combined, whether an array is a set or a sequence —
 * and it would be wrong in a different way for each key. Key granularity needs
 * no such knowledge and is decidable from three JSON values:
 *
 *   - the key changed in this process       → this process's value wins
 *   - the key did not change here           → the disk's value wins
 *   - the key was READ and then removed     → it is a deletion, and stays deleted
 *   - the key appeared on disk under a name
 *     this process never read               → it is somebody else's, and is kept
 *
 * It fits because the keys this script owns (`portRegistry`, `vaultNames`,
 * `referenceVault`, …) are exactly the ones no other writer touches, and the
 * keys other writers own (`workspaceBindings`, `workspaceBindingsMigration`)
 * are exactly the ones this script never changes. TWO PROCESSES EDITING THE
 * SAME KEY still lose one edit — that is what the lock is for, and it holds for
 * every writer that takes it around its own read-modify-write.
 *
 * Node builtins only — nothing at all, in fact. Pure.
 */

/**
 * A per-key snapshot of a config, for `mergeConfigOntoDisk` to compare against.
 * Serialised rather than referenced: callers mutate the object they were
 * handed, so keeping a reference would compare a snapshot against itself and
 * conclude that nothing ever changed.
 *
 * @param {object} config the config as it was READ
 * @returns {Record<string, string>} key → serialised value
 */
export function snapshotConfig(config) {
  const out = {};
  if (!config || typeof config !== 'object' || Array.isArray(config)) return out;
  for (const key of Object.keys(config)) out[key] = JSON.stringify(config[key]);
  return out;
}

/**
 * Merge the config a process is about to save onto whatever the file holds
 * NOW. Call it inside the write lock, with `onDisk` re-read there.
 *
 * @param {object} next the config this process wants to save
 * @param {object|null} onDisk the config as it is on disk right now
 * @param {Record<string, string>|null} snapshot what this process READ, per key
 * @returns {object} what should be written
 */
export function mergeConfigOntoDisk(next, onDisk, snapshot) {
  // No snapshot means this process never read the file (a bootstrap write of
  // the defaults), so there is nothing to merge onto and nothing it could be
  // clobbering that it knows about.
  if (!snapshot) return next;
  if (!onDisk || typeof onDisk !== 'object' || Array.isArray(onDisk)) return next;
  if (!next || typeof next !== 'object' || Array.isArray(next)) return next;

  const merged = { ...onDisk };
  for (const key of Object.keys(next)) {
    if (JSON.stringify(next[key]) !== snapshot[key]) merged[key] = next[key];
  }
  // A key this process READ and then removed is a deletion, and must not be
  // resurrected from the disk copy.
  for (const key of Object.keys(snapshot)) {
    if (!Object.hasOwn(next, key)) delete merged[key];
  }
  return merged;
}
