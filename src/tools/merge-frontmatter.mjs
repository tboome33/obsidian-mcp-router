import { setFrontmatterTool } from './set-frontmatter.mjs';
import { buildClickToOpenUrl } from '../helpers/click-to-open.mjs';

/**
 * Apply multiple frontmatter key/value updates in sequence.
 *
 * Caveat: this is not atomic. If the third of five updates fails, the first
 * two will already be applied. The result includes a per-key status so the
 * caller can see which succeeded. For atomic multi-key updates, fetch the
 * file with get_frontmatter, modify the object client-side, then write back
 * the whole file via write_file — but that rewrites the entire file content.
 */
export async function mergeFrontmatterTool(registry, args = {}) {
  const { vault: name, path: filePath, values, createIfMissing = true } = args;
  if (!filePath) throw new Error('Missing required argument: path');
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new Error('Missing or invalid argument: values (must be a key/value object)');
  }

  // Resolve the vault ONCE up front so the result carries the CANONICAL vault name
  // (honouring the default-vault cascade + single-vault lock) — the per-key sub-calls
  // resolve internally but only return the name. Best-effort: an unknown name throws here
  // and the per-key writes below surface it; we then fall back to the raw arg. The
  // deterministic viewLink hook reads `result.vault`, so a non-canonical name here would
  // point the view-agent at the WRONG vault (review+ pass 1 — Code Reviewer + codex convergent).
  let resolvedVault = null;
  try { resolvedVault = registry.resolveVault(name); } catch { /* best-effort */ }
  const resolvedVaultName = resolvedVault ? resolvedVault.name : name || registry.defaultVault;

  const results = [];
  let firstError = null;

  for (const [key, value] of Object.entries(values)) {
    try {
      await setFrontmatterTool(registry, {
        vault: name,
        path: filePath,
        key,
        value,
        createIfMissing,
      });
      results.push({ key, status: 'ok' });
    } catch (err) {
      results.push({ key, status: 'failed', error: err.message });
      if (!firstError) firstError = err;
    }
  }

  // best-effort click-to-open URL from the already-resolved vault (local vaults only).
  const clickToOpenUrl = resolvedVault ? buildClickToOpenUrl(resolvedVault, filePath) : null;

  return {
    vault: resolvedVaultName,
    path: filePath,
    applied: results.filter((r) => r.status === 'ok').length,
    failed: results.filter((r) => r.status === 'failed').length,
    results,
    ...(firstError && { firstError: firstError.message }),
    ...(clickToOpenUrl && { clickToOpenUrl }),
  };
}
