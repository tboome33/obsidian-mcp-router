import { patchFile } from '../rest-client.mjs';

export async function patchFileTool(registry, args = {}) {
  const { vault: name, path: filePath } = args;
  if (!filePath) throw new Error('Missing required argument: path');
  if (!args.operation) throw new Error('Missing required argument: operation');
  if (!args.targetType) throw new Error('Missing required argument: targetType');
  if (!args.target) throw new Error('Missing required argument: target');
  if (args.content == null) throw new Error('Missing required argument: content');

  const vault = registry.resolveVault(name);
  await patchFile(vault, filePath, {
    operation: args.operation,
    targetType: args.targetType,
    target: args.target,
    content: args.content,
    targetDelimiter: args.targetDelimiter,
    createTargetIfMissing: args.createTargetIfMissing,
    applyIfContentPreexists: args.applyIfContentPreexists,
    trimTargetWhitespace: args.trimTargetWhitespace,
  });
  return {
    vault: vault.name,
    path: filePath,
    operation: args.operation,
    targetType: args.targetType,
    target: args.target,
    patched: true,
  };
}
