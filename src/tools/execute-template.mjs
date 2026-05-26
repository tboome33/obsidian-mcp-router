import { executeTemplate } from '../rest-client.mjs';
import { buildClickToOpenUrl } from '../helpers/click-to-open.mjs';

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
  // Only emit a click-to-open URL when the template actually wrote a file
  // (createFile + targetPath both provided). The render-only path has no
  // file to open.
  const clickToOpenUrl = createFile && targetPath
    ? buildClickToOpenUrl(vault, targetPath)
    : null;
  return {
    vault: vault.name,
    template: templateName,
    targetPath: createFile ? targetPath : null,
    ...result,
    ...(clickToOpenUrl && { clickToOpenUrl }),
  };
}
