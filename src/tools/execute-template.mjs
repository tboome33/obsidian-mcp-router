import { executeTemplate } from '../rest-client.mjs';
import { buildClickToOpenUrl } from '../helpers/click-to-open.mjs';
import { okfSafePathSuggestion } from '../helpers/okf-safe-rename.mjs';

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
  // Non-blocking OKF-name guard (2026-07-29 decision) — only when a file
  // is actually created.
  const okfSuggestion = createFile && targetPath ? okfSafePathSuggestion(targetPath) : null;
  return {
    vault: vault.name,
    template: templateName,
    targetPath: createFile ? targetPath : null,
    ...result,
    ...(clickToOpenUrl && { clickToOpenUrl }),
    ...(okfSuggestion && {
      okfNameWarning: `targetPath is not OKF-safe (2026-07-29 policy: notes use ascii-kebab names). Suggested: ${okfSuggestion}`,
    }),
  };
}
