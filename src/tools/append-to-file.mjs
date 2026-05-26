import { appendToFile } from '../rest-client.mjs';
import { buildClickToOpenUrl } from '../helpers/click-to-open.mjs';

export async function appendToFileTool(registry, args = {}) {
  const { vault: name, path: filePath, content, requireExisting = false } = args;
  if (!filePath) throw new Error('Missing required argument: path');
  if (typeof content !== 'string') {
    throw new Error('Missing required argument: content (string)');
  }

  const vault = registry.resolveVault(name);
  await appendToFile(vault, filePath, content, {
    createTargetIfMissing: requireExisting ? false : undefined,
  });
  const clickToOpenUrl = buildClickToOpenUrl(vault, filePath);
  return {
    vault: vault.name,
    path: filePath,
    bytesAppended: Buffer.byteLength(content, 'utf8'),
    ...(clickToOpenUrl && { clickToOpenUrl }),
  };
}
