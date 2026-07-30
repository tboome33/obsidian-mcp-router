import { writeFile } from '../rest-client.mjs';
import { buildClickToOpenUrl } from '../helpers/click-to-open.mjs';
import { okfSafePathSuggestion } from '../helpers/okf-safe-rename.mjs';
import { isProjectionPath } from '../helpers/okf-projections.mjs';

export async function writeFileTool(registry, args = {}) {
  const { vault: name, path: filePath, content, ifNew = false } = args;
  if (!filePath) throw new Error('Missing required argument: path');
  if (typeof content !== 'string') {
    throw new Error('Missing required argument: content (string)');
  }

  const vault = registry.resolveVault(name);
  await writeFile(vault, filePath, content, {
    applyIfContentPreexists: ifNew ? false : undefined,
  });
  const clickToOpenUrl = buildClickToOpenUrl(vault, filePath);
  // Non-blocking OKF-name guard (2026-07-29 decision): new notes are born
  // with ascii-kebab OKF-safe paths; the write succeeds either way.
  const okfSuggestion = okfSafePathSuggestion(filePath);
  return {
    vault: vault.name,
    path: filePath,
    bytesWritten: Buffer.byteLength(content, 'utf8'),
    mode: ifNew ? 'create-only' : 'create-or-replace',
    ...(clickToOpenUrl && { clickToOpenUrl }),
    ...(okfSuggestion && {
      okfNameWarning: `Path is not OKF-safe (2026-07-29 policy: notes use ascii-kebab names). Suggested: ${okfSuggestion}`,
    }),
    // v0.59.0 — volet ②: writing INTO a generated projection is legal but
    // futile; say so instead of letting the next refresh silently undo it.
    ...(isProjectionPath(filePath) && {
      projectionWarning: `This path is a GENERATED OKF projection (root/per-directory index.md or wiki/log.md) — hand edits will be overwritten by the next refresh_okf_projections run. Edit the page frontmatter instead; the projections regenerate from it.`,
    }),
  };
}
