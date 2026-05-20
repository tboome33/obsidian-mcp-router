import { getNote } from '../rest-client.mjs';
import { sanitizeResponse } from '../helpers/sanitize.mjs';

export async function getFrontmatterTool(registry, args = {}) {
  const { vault: name, path: filePath, key } = args;
  if (!filePath) throw new Error('Missing required argument: path');

  const vault = registry.resolveVault(name);
  const note = await getNote(vault, filePath);
  const frontmatter = note.frontmatter ?? {};

  // Sanitize: frontmatter values are vault-attacker-controlled like search
  // results. `sanitizeResponse` preserves non-string types (numbers, bools,
  // arrays) intact — only string scalars are cleaned. Consistent with the
  // sanitize wire-up of search / get_file — IMP-1 from /review+.
  if (key) {
    return sanitizeResponse({
      vault: vault.name,
      path: filePath,
      key,
      value: frontmatter[key] ?? null,
      exists: Object.prototype.hasOwnProperty.call(frontmatter, key),
    });
  }
  return sanitizeResponse({
    vault: vault.name,
    path: filePath,
    frontmatter,
  });
}
