/**
 * build_open_link — produce a click-to-open URL (and a ready-to-paste
 * markdown link) for one or many vault files WITHOUT actually reading or
 * writing them.
 *
 * Companion to the per-tool `clickToOpenUrl` field that write/get/patch
 * already emit. Use this when you need a URL for a file you DIDN'T just
 * touch — typically a wikilink target you want to cite in a chat response,
 * or a folder you want to surface to the user.
 *
 * Two modes:
 *   - single: `{ vault?, path }` → `{ vault, path, clickToOpenUrl, markdownLink }`
 *   - batch:  `{ vault?, paths: [a, b, c] }` → `{ vault, links: [...] }`
 *
 * Each result includes both the bare URL and a markdown link with a default
 * label (basename without extension). The caller picks whichever they
 * prefer. `clickToOpenUrl` is `null` (and `markdownLink` is absent) when
 * the vault is remote or the insecure HTTP server isn't enabled — same
 * semantics as `buildClickToOpenUrl`.
 *
 * Read-only (zero vault I/O) — only reads the vault's
 * `obsidian-local-rest-api/data.json` to look up the insecure port.
 */

import {
  buildClickToOpenUrl,
  buildClickToOpenMarkdownLink,
  normalizeAnchor,
} from '../helpers/click-to-open.mjs';

function singleResult(vault, p, anchor) {
  // Normalise once so the echoed `anchor` field and the emitted `?h=` query
  // stay consistent — a whitespace-only or `#`-only anchor yields neither.
  const clean = normalizeAnchor(anchor);
  const opts = clean ? { anchor: clean } : {};
  const clickToOpenUrl = buildClickToOpenUrl(vault, p, opts);
  const markdownLink = clickToOpenUrl
    ? buildClickToOpenMarkdownLink(vault, p, undefined, opts)
    : null;
  return {
    path: p,
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
    return {
      vault: vault.name,
      links: paths.map((p) => singleResult(vault, p)),
    };
  }

  return {
    vault: vault.name,
    ...singleResult(vault, filePath, anchor),
  };
}
