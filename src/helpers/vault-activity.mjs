/**
 * Vault activity: when each vault was last written THROUGH THIS ROUTER, and
 * the last files it created or changed there.
 *
 * Kept in a sidecar next to the router's config — `vault-activity.json` in the
 * same directory — and never in `config.json` itself: that file is the user's,
 * hand-edited, shared by every session, and holds every vault's API key; a
 * router that rewrote it after each write would race every other writer of it
 * for a convenience. The sidecar is read-modify-written the way the config is
 * (`updateConfigBindings`): under a lock of its own, then an atomic rename.
 *
 * What it knows is what the router wrote. An edit made in Obsidian itself, or
 * by another tool, does not reach it — the panel that shows it says "via the
 * router" in its own words.
 *
 * Shape: `{ version: 1, vaults: { <name>: { lastWriteAt, recent: [{ path, at }] } } }`,
 * `recent` newest first, at most RECENT_MAX entries, one per path.
 */
import fs from 'node:fs';
import path from 'node:path';
import { acquireLockAsync, lockPathFor } from './file-lock.mjs';
import { writeFileAtomicSync } from './write-file-atomic.mjs';
import { isRecoveryCall, writeTargets } from './write-targets.mjs';
import { canonicalVaultPath } from './vault-path-guard.mjs';

export const ACTIVITY_FILE = 'vault-activity.json';
export const RECENT_MAX = 5;

// The tools whose targets are a vault's own notes. The router's upkeep
// (graph, search index, projections, conventions) and its ledgers are writes
// too, but no one reading "the last files changed" means them; a delete
// removes a file rather than making one to open.
const ACTIVITY_TOOLS = new Set([
  'write_file',
  'append_to_file',
  'patch_file',
  'set_frontmatter',
  'merge_frontmatter',
  'move_file',
  'execute_template',
  'write_bundle',
]);

/** The sidecar beside `configPath`, or null when there is no config path. */
export function activityPathFor(configPath) {
  return configPath ? path.join(path.dirname(configPath), ACTIVITY_FILE) : null;
}

/**
 * The vault-relative paths a call of `toolName` actually created or changed,
 * in the order it wrote them, read from its RESULT where the result says so:
 * nothing for a call that changed nothing (a skipped patch, a merge that
 * applied no key, a move that did not move, a refused bundle); for a bundle,
 * the steps that ran (`status: 'ok'`) and did not delete; for a move, its
 * destination only. A bundle RECOVERY replays a journal — it restores, it does
 * not make anything new — and is not recorded.
 *
 * @param {string} toolName
 * @param {object} args
 * @param {{ declares?: Function, result?: object }} [opts] `declares` passed to `writeTargets`
 * @returns {string[]}
 */
export function activityPaths(toolName, args = {}, { declares, result } = {}) {
  if (!ACTIVITY_TOOLS.has(toolName)) return [];
  if (
    result
    && typeof result === 'object'
    && (result.ok === false || result.isError === true || result.patched === false || result.applied === 0 || result.moved === false)
  ) {
    return [];
  }
  // Each path as the router itself spells it (`wiki//a.md/` is `wiki/a.md`),
  // so one file is one entry; a spelling it refuses is no file.
  const canonical = (p) => {
    try {
      return canonicalVaultPath(p);
    } catch {
      return null;
    }
  };
  const files = (paths) => [...new Set(paths.map(canonical).filter(Boolean))];
  if (toolName === 'write_bundle') {
    if (isRecoveryCall(args?.recover)) return [];
    const steps = Array.isArray(result?.steps) ? result.steps : [];
    // A path's LAST successful operation decides: written then deleted in the
    // same bundle, it is gone. The order kept is that of those last operations.
    const last = new Map();
    for (const step of steps) {
      const at = step && step.status === 'ok' ? canonical(step.path) : null;
      if (at) {
        last.delete(at);
        last.set(at, step.op);
      }
    }

    return [...last].filter(([, op]) => op !== 'delete').map(([at]) => at);
  }
  if (toolName === 'move_file') {
    const to = args?.to ?? args?.destination;
    return typeof to === 'string' && to ? files([to]) : [];
  }

  return files(writeTargets(toolName, args, { declares }));
}

function parse(text) {
  try {
    const data = JSON.parse(text);
    if (data && typeof data === 'object' && data.vaults && typeof data.vaults === 'object') return data;
  } catch {
    // A missing or unreadable sidecar is an empty one.
  }

  return { version: 1, vaults: {} };
}

/**
 * Every vault's activity as the sidecar holds it, `{}` when there is none.
 *
 * @param {string|null} configPath
 * @param {{ readFile?: (p: string) => string }} [seams]
 */
export function readActivity(configPath, { readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  const file = activityPathFor(configPath);
  if (!file) return {};
  try {
    return parse(readFile(file)).vaults;
  } catch {
    return {};
  }
}

/**
 * Records that `paths` of `vaultName` were written at `at`: the vault's
 * `lastWriteAt` moves to `at`, and each path goes to the head of `recent`
 * (once), which keeps RECENT_MAX entries. Best-effort by contract: a lock not
 * taken in time, or a disk that refuses, records nothing and says so by its
 * return value — never by throwing into the write it follows.
 *
 * @param {string|null} configPath
 * @param {string} vaultName
 * @param {string[]} paths
 * @param {string} [at] ISO 8601
 * @param {{ readFile?: Function, writeFile?: Function, lock?: Function }} [seams]
 * @returns {Promise<boolean>} whether the sidecar was written
 */
export async function recordActivity(
  configPath,
  vaultName,
  paths,
  at = new Date().toISOString(),
  { readFile = (p) => fs.readFileSync(p, 'utf8'), writeFile = (p, c) => writeFileAtomicSync(p, c), lock } = {},
) {
  const file = activityPathFor(configPath);
  if (!file || !vaultName || !Array.isArray(paths) || paths.length === 0) return false;
  const take = lock || ((target) => acquireLockAsync(lockPathFor(target, 'activity'), { waitMs: 2000 }));
  let release = null;
  try {
    release = await take(file);
    if (!release) return false;
    let text = '';
    try {
      text = readFile(file);
    } catch {
      // No sidecar yet: this write starts it.
    }
    const data = parse(text);
    const before = data.vaults[vaultName];
    // Merged by time, not by arrival: a recording held up by the lock must not
    // put its older write ahead of a newer one already there. Per path the
    // newest time wins; a bundle's paths, all at one time, keep the order it
    // wrote them in, the last first.
    const newest = new Map();
    const note = (p, when, rank) => {
      const seen = newest.get(p);
      if (!seen || when > seen.at || (when === seen.at && rank < seen.rank)) {
        newest.delete(p);
        newest.set(p, { at: when, rank });
      }
    };
    // Ranks break ties between equal times: the incoming paths first (last
    // written first), then the stored ones in the order they were kept.
    const incoming = [...new Set(paths)].reverse();
    incoming.forEach((p, rank) => note(p, at, rank));
    (Array.isArray(before?.recent) ? before.recent : []).forEach((entry, index) => {
      if (entry && typeof entry.path === 'string' && typeof entry.at === 'string') note(entry.path, entry.at, incoming.length + index);
    });
    const recent = [...newest]
      .sort(([, x], [, y]) => (x.at === y.at ? x.rank - y.rank : x.at < y.at ? 1 : -1))
      .slice(0, RECENT_MAX)
      .map(([p, { at: when }]) => ({ path: p, at: when }));
    const lastWriteAt = typeof before?.lastWriteAt === 'string' && before.lastWriteAt > at ? before.lastWriteAt : at;
    data.vaults[vaultName] = { lastWriteAt, recent };
    writeFile(file, `${JSON.stringify(data, null, 2)}\n`);

    return true;
  } catch {
    return false;
  } finally {
    release?.();
  }
}
