import { deleteFile } from '../rest-client.mjs';

export async function deleteFileTool(registry, args = {}) {
  const { vault: name, path: filePath, confirm } = args;
  if (!filePath) throw new Error('Missing required argument: path');

  // Require explicit confirmation to avoid accidental deletes when Claude
  // hallucinates a delete call.
  if (confirm !== true) {
    throw new Error(
      `Refusing to delete "${filePath}": pass confirm: true to proceed. ` +
        `This guard exists to prevent accidental deletions.`,
    );
  }

  const vault = registry.resolveVault(name);
  await deleteFile(vault, filePath);
  return {
    vault: vault.name,
    path: filePath,
    deleted: true,
  };
}
