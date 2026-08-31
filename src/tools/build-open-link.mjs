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
 * VERIFICATION IS LOCAL-DISK-ONLY, AND SINCE v0.79.0 THAT IS SAID OUT LOUD.
 * A vault with no local disk cannot be stat-ed, so nothing above can run for
 * it. Until lot 2 that did not matter — such a vault got a `null` URL anyway,
 * so there was no unverified link to warn about. Now that click-to-open works
 * from a configured port, a remote vault DOES get a URL, and it is one nobody
 * checked: the exact "well-formed URL that 404s at the bridge" this tool was
 * written to eliminate. Every result therefore carries `pathVerified`, on EVERY
 * branch including the error entries — a caller that has to infer the
 * difference from which OTHER keys are absent will not. `not_found` and
 * `ambiguous` are `true`: the check RAN and reached a conclusion. Only
 * `resolution_incomplete` (the scan could not finish) and the diskless case are
 * `false`.
 *
 * THE FIELD IS NAMED `pathVerified`, NOT `verified`, AND THE NAME IS THE POINT
 * (pre-release review, 2026-08-31). It answers exactly one question: was this
 * path checked against a disk? It does NOT mean the link works. A local file
 * that exists in a vault whose plaintext server is off is `pathVerified: true`
 * with a `null` URL. The unverified explanation likewise only mentions the URL
 * when there IS one — the first draft told callers "the URL is well-formed but
 * may 404" in a result whose URL was `null`.
 * See helpers/resolve-vault-path.mjs.
 *
 * Two modes:
 *   - single: `{ vault?, path, anchor? }` → `{ vault, path, clickToOpenUrl, markdownLink }`
 *   - batch:  `{ vault?, paths: [a, b, c] }` → `{ vault, links: [...] }`
 *
 * `clickToOpenUrl` is `null` (and `markdownLink` absent) when no plaintext port
 * is known, or when the vault's `data.json` says the insecure server is off —
 * same semantics as `buildClickToOpenUrl`. The vault's `baseUrl` plays no part:
 * the emitted host is always `127.0.0.1`.
 */

import {
  buildClickToOpenUrl,
  buildClickToOpenMarkdownLink,
  normalizeAnchor,
  resolveInsecurePort,
} from '../helpers/click-to-open.mjs';
import { resolveVaultPathOnDisk } from '../helpers/resolve-vault-path.mjs';
import { safeForMessage } from '../helpers/sanitize.mjs';
import { canonicalVaultPath } from '../helpers/vault-path-guard.mjs';

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
function buildOneLink(vault, requestedPath, { anchor, throwOnMiss = false, port } = {}) {
  // `resolveVaultPathOnDisk` strips leading slashes and does NOT reject `..`,
  // then stats the joined result — so an unguarded caller path made this an
  // EXISTENCE ORACLE for files outside the vault: `../secret.md` came back as
  // a success. Reading no content, but answering "does this exist" about a
  // filesystem the caller was never granted.
  //
  // Guarded here rather than in the caller because both entry points (single
  // and batch) funnel through this function — the mistake that produced the
  // hole was covering one door.
  const safeRequested = canonicalVaultPath(requestedPath, 'path');
  const verdict = resolveVaultPathOnDisk(vault, safeRequested);

  if (verdict.status === 'not_found') {
  // Built ONCE, sanitised at construction, because this exact string leaves by
  // TWO doors: it is thrown as a plain Error when throwOnMiss is set, and
  // returned inside the object when it is not. The return path went through
  // sanitizeResponse and the throw path did not — the same message, safe on one
  // branch and raw on the other, ninety lines apart. A plain Error also bypasses
  // the RestApiError constructor fix entirely.
    const message =
      `build_open_link: "${safeForMessage(requestedPath, 200)}" does not exist in vault "${safeForMessage(vault.name, 80)}". ` +
      `Check the folder and basename, or use list_files / search to find the real path — ` +
      `do NOT hand-compose the URL.`;
    if (throwOnMiss) throw new Error(message);
    // `pathVerified: true` — the check RAN and its answer is "no such file".
    // A checked absence is not the same as an unchecked path, and the batch
    // entries must carry the field too or "always present" is a false promise.
    return { path: requestedPath, error: 'not_found', message, clickToOpenUrl: null, pathVerified: true };
  }

  if (verdict.status === 'ambiguous') {
    const message =
      `build_open_link: "${safeForMessage(requestedPath, 200)}" not found, and its basename is AMBIGUOUS ` +
      `across multiple files: ${verdict.matches.map((p) => safeForMessage(p, 200)).join(', ')}. Pass the exact full path of the one you mean.`;
    if (throwOnMiss) throw new Error(message);
    return {
      path: requestedPath,
      error: 'ambiguous',
      matches: verdict.matches,
      message,
      clickToOpenUrl: null,
      pathVerified: true,
    };
  }

  if (verdict.status === 'resolution_incomplete') {
    const message =
      `build_open_link: could not verify "${safeForMessage(requestedPath, 200)}" — the vault is too large to prove ` +
      `the basename is unique within the scan budget. Pass the exact full path.`;
    if (throwOnMiss) throw new Error(message);
    // The scan ran but could not FINISH, so uniqueness was never established:
    // this is the one error branch where the path is genuinely unverified.
    return { path: requestedPath, error: 'resolution_incomplete', message, clickToOpenUrl: null, pathVerified: false };
  }

  // 'ok' → use the requested path verbatim (preserves exact encoding).
  // 'corrected' → swap in the real path and flag the correction.
  // 'unverifiable' (remote) → build from the requested path, unchanged.
  const correctedFrom = verdict.status === 'corrected' ? requestedPath : null;
  const effectivePath = verdict.status === 'corrected' ? verdict.path : requestedPath;

  const clean = normalizeAnchor(anchor);
  // ONE port for the URL and its markdown twin. Without this the two builders
  // each resolved the port independently — two disk reads per entry, and a
  // rewrite between them could hand back a result whose `clickToOpenUrl` and
  // `markdownLink` named DIFFERENT ports (third pre-release review).
  const opts = { ...(clean ? { anchor: clean } : {}), port };
  const clickToOpenUrl = buildClickToOpenUrl(vault, effectivePath, opts);
  const markdownLink = clickToOpenUrl
    ? buildClickToOpenMarkdownLink(vault, effectivePath, undefined, opts)
    : null;

  // 'unverifiable' is the ONLY status that reaches here without a disk check.
  const pathVerified = verdict.status !== 'unverifiable';

  return {
    path: effectivePath,
    ...(correctedFrom ? { corrected: true, requestedPath: correctedFrom } : {}),
    ...(clean ? { anchor: clean } : {}),
    clickToOpenUrl,
    ...(markdownLink && { markdownLink }),
    pathVerified,
    ...(pathVerified ? {} : {
      verification:
        `The path was NOT checked: vault "${safeForMessage(vault.name, 80)}" has no local filesystem `
        + 'path, so this tool could not confirm the file exists'
        // Only claim something about a URL when one was actually produced.
        + (clickToOpenUrl
          ? ', and the URL below is well-formed but may 404 at the bridge'
          : '')
        + '. Use list_files or search to confirm the path before citing it.',
    }),
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
  // Resolved ONCE for this call — see the note in buildOneLink. A 200-path
  // batch reads data.json once, not 400 times, and every link in it agrees.
  const port = resolveInsecurePort(vault);

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
    return ({
      vault: vault.name,
      links: paths.map((p) => buildOneLink(vault, p, { throwOnMiss: false, port })),
    });
  }

  // Single: a bad path THROWS — the caller cannot walk away with a dead URL.
  return ({
    vault: vault.name,
    ...buildOneLink(vault, filePath, { anchor, throwOnMiss: true, port }),
  });
}
