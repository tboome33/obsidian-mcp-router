import { executeTemplate } from '../rest-client.mjs';

export async function executeTemplateTool(registry, args = {}) {
  const {
    vault: name,
    name: templateName,
    arguments: templateArgs,
    createFile,
    targetPath,
  } = args;
  if (!templateName) {
    throw new Error('Missing required argument: name (template path, e.g. "Templates/Daily.md")');
  }
  if (createFile && !targetPath) {
    throw new Error('targetPath is required when createFile is true');
  }

  const vault = registry.resolveVault(name);
  const result = await executeTemplate(vault, {
    name: templateName,
    args: templateArgs || {},
    createFile,
    targetPath,
  });
  return {
    vault: vault.name,
    template: templateName,
    targetPath: createFile ? targetPath : null,
    ...result,
  };
}
