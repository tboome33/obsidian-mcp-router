import { patchFile, assertContentMatches } from '../rest-client.mjs';
import { buildClickToOpenUrl } from '../helpers/click-to-open.mjs';
import { isContentSha256 } from '../helpers/content-hash.mjs';

export async function patchFileTool(registry, args = {}) {
  const { vault: name, path: filePath, ifMatch } = args;
  if (!filePath) throw new Error('Missing required argument: path');
  if (!args.operation) throw new Error('Missing required argument: operation');
  if (!args.targetType) throw new Error('Missing required argument: targetType');
  if (!args.target) throw new Error('Missing required argument: target');
  if (args.content == null) throw new Error('Missing required argument: content');
  if (ifMatch !== undefined && !isContentSha256(ifMatch)) {
    throw new Error(
      'Invalid ifMatch: expected a 64-char lowercase hex content hash (the contentSha256 field from get_file).',
    );
  }

  const vault = registry.resolveVault(name);
  // ifMatch (C1): whole-file precondition. Non-atomic — the patch itself is
  // not hash-locked — but it refuses to patch content that changed since the
  // caller read it. Checked before the mutation so a stale patch never lands.
  if (ifMatch !== undefined) {
    await assertContentMatches(vault, filePath, ifMatch);
  }
  const result = await patchFile(vault, filePath, {
    operation: args.operation,
    targetType: args.targetType,
    target: args.target,
    content: args.content,
    targetDelimiter: args.targetDelimiter,
    createTargetIfMissing: args.createTargetIfMissing,
    applyIfContentPreexists: args.applyIfContentPreexists,
    trimTargetWhitespace: args.trimTargetWhitespace,
  });
  const clickToOpenUrl = buildClickToOpenUrl(vault, filePath);
  // Heading targets are patched router-side and report whether the patch was
  // actually applied (applyIfContentPreexists can skip it) and whether the
  // target heading had to be created. Block/frontmatter targets go through
  // the plugin's PATCH, which reports nothing — patched stays true there.
  const skipped = result && result.applied === false;
  return {
    vault: vault.name,
    path: filePath,
    operation: args.operation,
    targetType: args.targetType,
    target: args.target,
    patched: !skipped,
    ...(skipped && { skippedReason: result.skippedReason }),
    ...(result && result.createdTarget && { createdTarget: true }),
    ...(clickToOpenUrl && { clickToOpenUrl }),
  };
}
