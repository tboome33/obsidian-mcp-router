/**
 * ingest-state, the DISK half — split out of `ingest-state.mjs` in v0.79.0.
 *
 * WHY THE SPLIT EXISTS. The HTTP-only workstream needs one claim to stay true:
 * no MCP tool reads a vault's disk to track ingestion state. That claim was
 * first checked by grepping for the three function names, then by a test that
 * hunted for `import { … } from '…ingest-state.mjs'`. A review walked straight
 * through it — `import * as ingest from './ingest-state.mjs'` names none of the
 * three, and so do a dynamic import, a re-export, and a specifier with a query
 * suffix. A blacklist of the import forms its author thought of is only ever as
 * good as their imagination, and no regex over source text can settle a
 * question about module boundaries.
 *
 * So the boundary became STRUCTURAL instead. The three functions that touch a
 * vault's filesystem live here, in a module nothing under `src/` imports at all,
 * and the invariant is now a substring: no router source file may so much as
 * MENTION `ingest-state-fs`. That is trivially checkable and cannot be evaded
 * by import syntax. It also follows the convention this repo already uses for
 * exactly this separation — `okf-projections.mjs` / `okf-projections-fs.mjs`,
 * `bm25-index.mjs` / `bm25-index-fs.mjs`.
 *
 * WHO CALLS THIS. The `wiki-ingest` skill, which runs on the machine that has
 * the vaults' disks, and the tests. Nothing else. `ingest-state.mjs` keeps the
 * pure half (hashing, URL normalisation, freshness comparison) and deliberately
 * does NOT re-export these — a re-export would put `node:fs` back into its
 * import graph and undo the whole point.
 *
 * THE FORMAT, unchanged: a per-vault JSON file at `wiki-meta/ingest-state.json`
 * mapping a source id to `{ hash, ingestedAt, page }`. Note that `wiki-meta/` is
 * an ORDINARY directory that the Local REST API serves — so if a diskless
 * router ever does need this state, it can be ported to REST rather than
 * reimplemented. Nothing today requires that.
 */

import fs from 'node:fs';
import path from 'node:path';

const STATE_FILENAME = 'ingest-state.json';
const STATE_DIR = 'wiki-meta';

/**
 * Resolve the absolute path to a vault's ingest-state.json file.
 *
 * @param {string} vaultPath Absolute filesystem path to the vault root
 * @returns {string} Absolute path to wiki-meta/ingest-state.json
 */
export function getStatePath(vaultPath) {
  if (typeof vaultPath !== 'string' || !vaultPath) {
    throw new TypeError('getStatePath: vaultPath must be a non-empty string');
  }
  return path.join(vaultPath, STATE_DIR, STATE_FILENAME);
}

/**
 * Load the ingest state for a vault. Returns an empty object if the file
 * doesn't exist yet (first ingest into this vault) OR if it's corrupt.
 *
 * Corruption handling (review+ pass 2 fix for Reviewer A IMP-6) — silent
 * recovery would mean the next `saveIngestState` overwrites the broken
 * file with a fresh empty state, erasing the entire ingestion history
 * invisibly. To prevent that, on corruption we :
 *   1. Log a clear warning to stderr (user sees it).
 *   2. Backup the corrupted file as `<path>.corrupted-<timestamp>` so
 *      the data isn't lost — user can inspect and recover.
 *   3. Then return `{}` so processing continues.
 *
 * If the rename fails (permissions, etc.), the warning still fires but
 * the corrupted file is left in place — the caller will see the next
 * load attempt also fail in the same way until they intervene.
 *
 * @param {string} vaultPath Absolute filesystem path to the vault root
 * @returns {Record<string, { hash: string, ingestedAt: string, page: string }>}
 */
export function loadIngestState(vaultPath) {
  const statePath = getStatePath(vaultPath);
  if (!fs.existsSync(statePath)) return {};
  let raw;
  try {
    raw = fs.readFileSync(statePath, 'utf8');
  } catch (err) {
    process.stderr.write(
      `[ingest-state] WARN: failed to read ${statePath}: ${err.message} — treating as empty.\n`,
    );
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Corrupted JSON — back up the file before we overwrite it.
    const backupPath = `${statePath}.corrupted-${Date.now()}`;
    try {
      fs.renameSync(statePath, backupPath);
      process.stderr.write(
        `[ingest-state] WARN: corrupted JSON at ${statePath} (${err.message}). ` +
          `Backed up to ${backupPath} and treating as empty.\n`,
      );
    } catch (renameErr) {
      process.stderr.write(
        `[ingest-state] WARN: corrupted JSON at ${statePath} (${err.message}). ` +
          `Backup failed (${renameErr.message}); leaving file in place. Manual cleanup may be required.\n`,
      );
    }
    return {};
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed;
  }
  // Valid JSON but wrong shape (array, scalar, null). Treat as empty
  // but warn — same recovery path as full corruption.
  const backupPath = `${statePath}.corrupted-${Date.now()}`;
  try {
    fs.renameSync(statePath, backupPath);
    process.stderr.write(
      `[ingest-state] WARN: wrong shape at ${statePath} (expected object, got ${typeof parsed}). ` +
        `Backed up to ${backupPath} and treating as empty.\n`,
    );
  } catch {
    // Best-effort backup.
  }
  return {};
}

/**
 * Save the ingest state for a vault atomically (write to tmp file then
 * rename, so a crash mid-write can't leave a corrupted JSON). Creates
 * `wiki-meta/` if it doesn't exist.
 *
 * @param {string} vaultPath Absolute filesystem path to the vault root
 * @param {Record<string, { hash: string, ingestedAt: string, page: string }>} state
 */
export function saveIngestState(vaultPath, state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new TypeError('saveIngestState: state must be a plain object');
  }
  const statePath = getStatePath(vaultPath);
  const stateDir = path.dirname(statePath);
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }
  const tmpPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  const json = `${JSON.stringify(state, null, 2)}\n`;
  fs.writeFileSync(tmpPath, json, 'utf8');
  fs.renameSync(tmpPath, statePath);
}
