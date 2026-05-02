import { setFrontmatterTool } from './set-frontmatter.mjs';

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

  return {
    vault: name || registry.defaultVault,
    path: filePath,
    applied: results.filter((r) => r.status === 'ok').length,
    failed: results.filter((r) => r.status === 'failed').length,
    results,
    ...(firstError && { firstError: firstError.message }),
  };
}
