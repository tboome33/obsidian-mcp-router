import { appendToFile, assertContentMatches } from '../rest-client.mjs';
import { buildClickToOpenUrl } from '../helpers/click-to-open.mjs';
import { isContentSha256 } from '../helpers/content-hash.mjs';

export async function appendToFileTool(registry, args = {}) {
  const { vault: name, path: filePath, content, requireExisting = false, ifMatch } = args;
  if (!filePath) throw new Error('Missing required argument: path');
  if (typeof content !== 'string') {
    throw new Error('Missing required argument: content (string)');
  }
  if (ifMatch !== undefined && !isContentSha256(ifMatch)) {
    throw new Error(
      'Invalid ifMatch: expected a 64-char lowercase hex content hash (the contentSha256 field from get_file).',
    );
  }

  const vault = registry.resolveVault(name);
  // ifMatch (C1): whole-file precondition, same tier as patch_file's — the
  // append itself is not hash-locked, but it refuses to append to a file that
  // changed since the caller read it. Without this an `ifMatch` on an append
  // was accepted and silently ignored, which is worse than not offering it:
  // a bundle could pre-check the precondition against a backup and then append
  // to a file a third party had rewritten in between (C2 review).
  if (ifMatch !== undefined) {
    await assertContentMatches(vault, filePath, ifMatch);
  }
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
