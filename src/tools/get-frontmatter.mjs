import { getNote } from '../rest-client.mjs';

export async function getFrontmatterTool(registry, args = {}) {
  const { vault: name, path: filePath, key } = args;
  if (!filePath) throw new Error('Missing required argument: path');

  const vault = registry.resolveVault(name);
  const note = await getNote(vault, filePath);
  const frontmatter = note.frontmatter ?? {};

  if (key) {
    return {
      vault: vault.name,
      path: filePath,
      key,
      value: frontmatter[key] ?? null,
      exists: Object.prototype.hasOwnProperty.call(frontmatter, key),
    };
  }
  return {
    vault: vault.name,
    path: filePath,
    frontmatter,
  };
}
