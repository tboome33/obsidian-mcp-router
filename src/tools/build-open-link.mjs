/**
 * build_open_link — produce a click-to-open URL (and a ready-to-paste
 * markdown link) for one or many vault files WITHOUT reading or writing them.
 *
 * Companion to the per-tool `clickToOpenUrl` field that write/get/patch
 * already emit. Use this when you need a URL for a file you DIDN'T just
 * touch — typically a wikilink target you want to cite in a chat response,
 * or a folder you want to surface to the user.
 *
 * DETERMINISM GUARANTEE (v0.45.0): the URL builder only URL-encodes the path
 * it's handed, so a wrong path (invented sub-folder, typo) used to yield a
 * well-formed URL that 404s at the bridge — a dead link the caller couldn't
 * tell apart from a good one. build_open_link now VERIFIES the path against the
 * local vault on disk BEFORE emitting a URL:
 *   - exact path exists            → normal result
 *   - exact miss, UNIQUE basename  → auto-corrected to the real path (result
 *                                    carries `corrected: true` + `requestedPath`)
 *   - exact miss, no/ambiguous     → single mode THROWS a clear error; batch
 *                                    mode marks that entry with `error` and a
 *                                    null URL (the good entries still resolve)
 * Local vaults only — a remote vault has no local disk to stat, so it keeps the
 * prior behaviour (null URL, unverified). See helpers/resolve-vault-path.mjs.
 *
 * Two modes:
 *   - single: `{ vault?, path, anchor? }` → `{ vault, path, clickToOpenUrl, markdownLink }`
 *   - batch:  `{ vault?, paths: [a, b, c] }` → `{ vault, links: [...] }`
 *
 * `clickToOpenUrl` is `null` (and `markdownLink` absent) when the vault is
 * remote or the insecure HTTP server isn't enabled — same semantics as
 * `buildClickToOpenUrl`.
 */

import {
  buildClickToOpenUrl,
  buildClickToOpenMarkdownLink,
  normalizeAnchor,
} from '../helpers/click-to-open.mjs';
import { resolveVaultPathOnDisk } from '../helpers/resolve-vault-path.mjs';

/**
 * Verify the path, then build the URL for the (possibly corrected) real path.
 *
 * @param {object} vault
 * @param {string} requestedPath - the path the caller asked for.
 * @param {object} [o]
 * @param {string} [o.anchor]
 * @param {boolean} [o.throwOnMiss] - single mode throws on not_found/ambiguous;
 *   batch mode (false) returns an `{ error }` entry instead so one bad path
 *   doesn't sink the whole batch.
 */
function buildOneLink(vault, requestedPath, { anchor, throwOnMiss = false } = {}) {
  const verdict = resolveVaultPathOnDisk(vault, requestedPath);

  if (verdict.status === 'not_found') {
    const message =
      `build_open_link: "${requestedPath}" does not exist in vault "${vault.name}". ` +
      `Check the folder and basename, or use list_files / search to find the real path — ` +
      `do NOT hand-compose the URL.`;
    if (throwOnMiss) throw new Error(message);
    return { path: requestedPath, error: 'not_found', message, clickToOpenUrl: null };
  }

  if (verdict.status === 'ambiguous') {
    const message =
      `build_open_link: "${requestedPath}" not found, and its basename is AMBIGUOUS ` +
      `across multiple files: ${verdict.matches.join(', ')}. Pass the exact full path of the one you mean.`;
    if (throwOnMiss) throw new Error(message);
    return {
      path: requestedPath,
      error: 'ambiguous',
      matches: verdict.matches,
      message,
      clickToOpenUrl: null,
    };
  }

  if (verdict.status === 'resolution_incomplete') {
    const message =
      `build_open_link: could not verify "${requestedPath}" — the vault is too large to prove ` +
      `the basename is unique within the scan budget. Pass the exact full path.`;
    if (throwOnMiss) throw new Error(message);
    return { path: requestedPath, error: 'resolution_incomplete', message, clickToOpenUrl: null };
  }

  // 'ok' → use the requested path verbatim (preserves exact encoding).
  // 'corrected' → swap in the real path and flag the correction.
  // 'unverifiable' (remote) → build from the requested path, unchanged.
  const correctedFrom = verdict.status === 'corrected' ? requestedPath : null;
  const effectivePath = verdict.status === 'corrected' ? verdict.path : requestedPath;

  const clean = normalizeAnchor(anchor);
  const opts = clean ? { anchor: clean } : {};
  const clickToOpenUrl = buildClickToOpenUrl(vault, effectivePath, opts);
  const markdownLink = clickToOpenUrl
    ? buildClickToOpenMarkdownLink(vault, effectivePath, undefined, opts)
    : null;

  return {
    path: effectivePath,
    ...(correctedFrom ? { corrected: true, requestedPath: correctedFrom } : {}),
    ...(clean ? { anchor: clean } : {}),
    clickToOpenUrl,
    ...(markdownLink && { markdownLink }),
  };
}

export async function buildOpenLinkTool(registry, args = {}) {
  const { vault: name, path: filePath, paths, anchor } = args;

  // Either `path` (single) or `paths` (batch) must be provided. Reject
  // both/neither rather than silently picking one — clearer errors at
  // call sites.
  const isBatch = Array.isArray(paths);
  const isSingle = typeof filePath === 'string' && filePath.length > 0;
  if (isBatch && isSingle) {
    throw new Error('Provide either `path` (single) or `paths` (batch), not both.');
  }
  if (!isBatch && !isSingle) {
    throw new Error('Missing required argument: provide `path` (string) or `paths` (array).');
  }

  // `anchor` (a heading to deep-link to) is inherently per-target, so it's
  // only meaningful in single mode. Reject it with `paths` rather than
  // silently applying one heading to every file in the batch.
  if (anchor != null && isBatch) {
    throw new Error('`anchor` is only supported with `path` (single mode), not `paths` (batch).');
  }
  if (anchor != null && typeof anchor !== 'string') {
    throw new Error(`\`anchor\` must be a string, got ${typeof anchor}.`);
  }

  const vault = registry.resolveVault(name);

  if (isBatch) {
    // Reject non-string / empty entries up front. A typo in the batch
    // would otherwise silently produce a null URL for that slot, which
    // is harder to spot than a clear validation error.
    for (let i = 0; i < paths.length; i += 1) {
      if (typeof paths[i] !== 'string' || paths[i].length === 0) {
        throw new Error(`paths[${i}] must be a non-empty string, got ${typeof paths[i]}.`);
      }
    }
    // Batch: verify per-entry, never throw for a single bad path — that entry
    // gets an `error` field + null URL, the rest still resolve.
    return {
      vault: vault.name,
      links: paths.map((p) => buildOneLink(vault, p, { throwOnMiss: false })),
    };
  }

  // Single: a bad path THROWS — the caller cannot walk away with a dead URL.
  return {
    vault: vault.name,
    ...buildOneLink(vault, filePath, { anchor, throwOnMiss: true }),
  };
}
