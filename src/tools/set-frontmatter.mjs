import { patchFile, assertContentMatches } from '../rest-client.mjs';
import { buildClickToOpenUrl } from '../helpers/click-to-open.mjs';
import { isContentSha256 } from '../helpers/content-hash.mjs';

/**
 * Set a single frontmatter property. Convenience wrapper around patch_file
 * with targetType: frontmatter. Type is preserved end-to-end:
 *
 *   - strings        → stored as YAML strings
 *   - numbers        → stored as YAML numbers
 *   - booleans       → stored as YAML booleans
 *   - null           → stored as YAML null
 *   - arrays/objects → stored as YAML sequences/maps
 *
 * Encoding is handled inside patchFile (application/json for non-strings,
 * text/markdown for strings).
 */
export async function setFrontmatterTool(registry, args = {}) {
  const { vault: name, path: filePath, key, value, createIfMissing = true, ifMatch } = args;
  if (!filePath) throw new Error('Missing required argument: path');
  if (!key) throw new Error('Missing required argument: key');
  if (value === undefined) throw new Error('Missing required argument: value');
  if (ifMatch !== undefined && !isContentSha256(ifMatch)) {
    throw new Error(
      'Invalid ifMatch: expected a 64-char lowercase hex content hash (the contentSha256 field from get_file).',
    );
  }

  const vault = registry.resolveVault(name);
  // ifMatch (C1): same whole-file precondition as patch_file (this tool IS a
  // patch_file with targetType:frontmatter). Previously the argument was
  // accepted and ignored — a guard that silently does nothing is worse than no
  // guard, because callers rely on it (C2 review).
  if (ifMatch !== undefined) {
    await assertContentMatches(vault, filePath, ifMatch);
  }
  await patchFile(vault, filePath, {
    operation: 'replace',
    targetType: 'frontmatter',
    target: key,
    content: value,
    createTargetIfMissing: createIfMissing,
  });
  const clickToOpenUrl = buildClickToOpenUrl(vault, filePath);
  return {
    vault: vault.name,
    path: filePath,
    key,
    value,
    set: true,
    ...(clickToOpenUrl && { clickToOpenUrl }),
  };
}
