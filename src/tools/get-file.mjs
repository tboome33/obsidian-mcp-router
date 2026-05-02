import { getFileContent } from '../rest-client.mjs';

export async function getFile(registry, { vault: name, path: filePath } = {}) {
  if (!filePath) {
    throw new Error('Missing required argument: path');
  }
  const vault = registry.resolveVault(name);
  const content = await getFileContent(vault, filePath);
  return {
    vault: vault.name,
    path: filePath,
    content,
  };
}
