import { deleteFile, assertContentMatches } from '../rest-client.mjs';
import { isContentSha256 } from '../helpers/content-hash.mjs';

export async function deleteFileTool(registry, args = {}) {
  const { vault: name, path: filePath, confirm, ifMatch } = args;
  if (!filePath) throw new Error('Missing required argument: path');

  // Require explicit confirmation to avoid accidental deletes when Claude
  // hallucinates a delete call.
  if (confirm !== true) {
    throw new Error(
      `Refusing to delete "${filePath}": pass confirm: true to proceed. ` +
        `This guard exists to prevent accidental deletions.`,
    );
  }
  if (ifMatch !== undefined && !isContentSha256(ifMatch)) {
    throw new Error(
      'Invalid ifMatch: expected a 64-char lowercase hex content hash (the contentSha256 field from get_file).',
    );
  }

  const vault = registry.resolveVault(name);
  // ifMatch (C1): refuse to delete if the file changed since the caller read
  // it — protects against deleting a file another session just edited. Checked
  // before the DELETE.
  if (ifMatch !== undefined) {
    await assertContentMatches(vault, filePath, ifMatch);
  }
  await deleteFile(vault, filePath);
  return {
    vault: vault.name,
    path: filePath,
    deleted: true,
  };
}
