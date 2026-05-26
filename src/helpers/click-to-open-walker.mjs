/**
 * Walk an arbitrarily-shaped response payload (search hits, smart chunks,
 * nested arrays) to collect every vault-relative file path found inside,
 * then emit a `{ clickToOpenLinks: { "<path>": "<url>", ... } }` map.
 *
 * The walker recognises these key names as file paths:
 *   - `filename` (Local REST API /search/simple shape)
 *   - `path` (smart-connections / bridge shape, and generally anywhere)
 *   - `file` (sometimes used by template results)
 *
 * Heuristic: a candidate is considered a vault file path if it's a string,
 * ends in `.md` or has no extension at all (folders are also openable in
 * Obsidian — `/open/<folder>` reveals the folder pane). A path with a non-md
 * extension (`.png`, `.pdf`) is INCLUDED because the bridge route works on
 * any vault-relative path the Obsidian API recognises.
 *
 * Returns an object suitable for spread into the tool result:
 *   { clickToOpenLinks: { "wiki/foo.md": "http://...", ... } }
 *
 * When zero paths are found (or no URL could be built — vault is remote,
 * insecure server disabled), returns `{}` so spreading is a no-op.
 *
 * Why this design (sibling map rather than mutating hit objects):
 *   1. Doesn't break the shape contract of upstream Local REST API
 *      responses — clients that depend on the exact `matches[]` shape
 *      still see what they got before.
 *   2. Dedupe is free: a path that appears in 5 hits gets ONE entry.
 *   3. Lookup-by-path is O(1) for the caller.
 */

import { buildClickToOpenUrl } from './click-to-open.mjs';

const PATH_KEY_NAMES = new Set(['filename', 'path', 'file']);
const MAX_DEPTH = 10; // guard against pathological cycles / deep nesting

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isLikelyVaultPath(v) {
  if (typeof v !== 'string') return false;
  if (v.length === 0) return false;
  // Reject absolute paths (Windows `C:\` or POSIX `/`) — these never
  // resolve as vault-relative paths in the bridge route.
  if (/^[A-Za-z]:[\\/]/.test(v)) return false;
  if (v.startsWith('/')) return false;
  // Reject URLs (anything with `://`) — search hits sometimes include
  // citation URLs that we don't want to mistakenly wrap as vault paths.
  if (v.includes('://')) return false;
  return true;
}

/**
 * Walk recursively. Adds discovered paths to the `pathSet`. Bounded depth
 * to avoid stack blowup on hostile inputs.
 */
function walk(node, pathSet, depth) {
  if (depth > MAX_DEPTH) return;
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, pathSet, depth + 1);
    return;
  }
  if (isPlainObject(node)) {
    for (const [key, value] of Object.entries(node)) {
      if (PATH_KEY_NAMES.has(key) && isLikelyVaultPath(value)) {
        pathSet.add(value);
      }
      walk(value, pathSet, depth + 1);
    }
  }
  // primitives (string/number/bool) → nothing to recurse into.
}

/**
 * Collect every vault path in the given response payload and produce the
 * `{ clickToOpenLinks }` spread-ready object.
 *
 * @param {object} vault - Registry vault descriptor (used to look up port).
 * @param {*} payload - The response data to scan.
 * @returns {{ clickToOpenLinks?: Record<string,string> }}
 */
export function collectClickToOpenLinks(vault, payload) {
  if (!vault) return {};
  const pathSet = new Set();
  walk(payload, pathSet, 0);
  if (pathSet.size === 0) return {};
  const links = {};
  for (const p of pathSet) {
    const url = buildClickToOpenUrl(vault, p);
    if (url) links[p] = url;
  }
  if (Object.keys(links).length === 0) return {};
  return { clickToOpenLinks: links };
}
