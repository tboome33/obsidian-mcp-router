import { patchFile } from '../rest-client.mjs';

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
  const { vault: name, path: filePath, key, value, createIfMissing = true } = args;
  if (!filePath) throw new Error('Missing required argument: path');
  if (!key) throw new Error('Missing required argument: key');
  if (value === undefined) throw new Error('Missing required argument: value');

  const vault = registry.resolveVault(name);
  await patchFile(vault, filePath, {
    operation: 'replace',
    targetType: 'frontmatter',
    target: key,
    content: value,
    createTargetIfMissing: createIfMissing,
  });
  return {
    vault: vault.name,
    path: filePath,
    key,
    value,
    set: true,
  };
}
