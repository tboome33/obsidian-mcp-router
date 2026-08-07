import { moveFileFromTo } from '../rest-client.mjs';
import { buildClickToOpenUrl } from '../helpers/click-to-open.mjs';
import { okfSafePathSuggestion } from '../helpers/okf-safe-rename.mjs';
import { isContentSha256 } from '../helpers/content-hash.mjs';
import { canonicalVaultPath } from '../helpers/vault-path-guard.mjs';
export async function moveFileTool(registry, args = {}) {
  const { vault: name, overwrite = false, ifMatch } = args;
  // BOTH ends need containment: `from` reads and deletes, `to` writes. See
  // vault-path-guard.
  const from = canonicalVaultPath(args.from, 'from');
  const to = canonicalVaultPath(args.to, 'to');
  if (ifMatch !== undefined && !isContentSha256(ifMatch)) {
    throw new Error(
      'Invalid ifMatch: expected a 64-char lowercase hex content hash (the contentSha256 field from get_file). It is checked against the SOURCE file.',
    );
  }

  const vault = registry.resolveVault(name);
  // ifMatch (C1) guards the SOURCE: refuse to move if the source changed since
  // the caller read it.
  const result = await moveFileFromTo(vault, from, to, { overwrite, ifMatch });
  // Happy path: URL targets the destination — source is gone.
  const clickToOpenUrl = buildClickToOpenUrl(vault, to);
  // Partial-failure path (PUT OK / DELETE source KO): the source FILE is
  // still on disk. Emit a SECOND URL pointing at the source so the LLM can
  // surface both — "copied [foo](destUrl), cleanup [foo](sourceUrl)" — and
  // doesn't mislead the user by citing only the destination as if the
  // move was clean. v0.14.9 hardening (Reviewer A IMPORTANT-4 + Reviewer B P3).
  //
  // Gate on BOTH `moved: true` AND `sourceDeleted: false` to distinguish
  // the real partial-failure case from the same-path no-op where
  // `moveFileFromTo` returns `{ moved: false, sourceDeleted: false }`
  // (because there was nothing to delete — source IS destination). The
  // no-op is harmless and shouldn't trigger the dual-URL warning.
  const sourceUrl = result.moved === true && result.sourceDeleted === false
    ? buildClickToOpenUrl(vault, from)
    : null;
  // Non-blocking OKF-name guard (2026-07-29 decision) on the destination.
  const okfSuggestion = okfSafePathSuggestion(to);
  // NOT just "the two caller paths + status", which is how this tool was
  // classified on the first pass of the round-10 audit. `...result` spreads the
  // REST layer's own object, and its failure branch carries
  // `warning: "Wrote X but failed to delete source Y: ${err.message}"` — a
  // RestApiError message, which splices in 200 bytes of the HTTP response body.
  // So this tool DOES put server-supplied bytes on the success path. The
  // exemption reason was wrong, and a reason that is wrong is worse than no
  // reason: it is a guard vouching for the thing it should have caught.
  return ({
    vault: vault.name,
    from,
    to,
    overwrite,
    ...result,
    ...(clickToOpenUrl && { clickToOpenUrl }),
    ...(sourceUrl && { clickToOpenUrlSource: sourceUrl }),
    ...(okfSuggestion && {
      okfNameWarning: `Destination is not OKF-safe (2026-07-29 policy: notes use ascii-kebab names). Suggested: ${okfSuggestion}`,
    }),
  });
}
