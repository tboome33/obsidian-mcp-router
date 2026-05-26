import { moveFileFromTo } from '../rest-client.mjs';
import { buildClickToOpenUrl } from '../helpers/click-to-open.mjs';

export async function moveFileTool(registry, args = {}) {
  const { vault: name, from, to, overwrite = false } = args;
  if (!from) throw new Error('Missing required argument: from');
  if (!to) throw new Error('Missing required argument: to');

  const vault = registry.resolveVault(name);
  const result = await moveFileFromTo(vault, from, to, { overwrite });
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
  return {
    vault: vault.name,
    from,
    to,
    overwrite,
    ...result,
    ...(clickToOpenUrl && { clickToOpenUrl }),
    ...(sourceUrl && { clickToOpenUrlSource: sourceUrl }),
  };
}
