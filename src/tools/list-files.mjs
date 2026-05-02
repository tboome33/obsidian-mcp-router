import { listFilesIn } from '../rest-client.mjs';

export async function listFiles(registry, { vault: name, directory } = {}) {
  const vault = registry.resolveVault(name);
  const result = await listFilesIn(vault, directory || '');
  return {
    vault: vault.name,
    directory: directory || '',
    ...result,
  };
}
