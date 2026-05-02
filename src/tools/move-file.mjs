import { moveFileFromTo } from '../rest-client.mjs';

export async function moveFileTool(registry, args = {}) {
  const { vault: name, from, to, overwrite = false } = args;
  if (!from) throw new Error('Missing required argument: from');
  if (!to) throw new Error('Missing required argument: to');

  const vault = registry.resolveVault(name);
  const result = await moveFileFromTo(vault, from, to, { overwrite });
  return {
    vault: vault.name,
    from,
    to,
    overwrite,
    ...result,
  };
}
