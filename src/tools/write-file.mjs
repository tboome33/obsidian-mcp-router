import { writeFile } from '../rest-client.mjs';

export async function writeFileTool(registry, args = {}) {
  const { vault: name, path: filePath, content, ifNew = false } = args;
  if (!filePath) throw new Error('Missing required argument: path');
  if (typeof content !== 'string') {
    throw new Error('Missing required argument: content (string)');
  }

  const vault = registry.resolveVault(name);
  await writeFile(vault, filePath, content, {
    applyIfContentPreexists: ifNew ? false : undefined,
  });
  return {
    vault: vault.name,
    path: filePath,
    bytesWritten: Buffer.byteLength(content, 'utf8'),
    mode: ifNew ? 'create-only' : 'create-or-replace',
  };
}
