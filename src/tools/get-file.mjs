import { getFileContent } from '../rest-client.mjs';
import { sanitizeContent } from '../helpers/sanitize.mjs';

export async function getFile(registry, { vault: name, path: filePath } = {}) {
  if (!filePath) {
    throw new Error('Missing required argument: path');
  }
  const vault = registry.resolveVault(name);
  const content = await getFileContent(vault, filePath);
  // The content field is opaque to the router (string for raw markdown,
  // object for the `application/vnd.olrapi.note+json` content-negotiated
  // representation). Only sanitize strings — let the structured form pass
  // through untouched so frontmatter types are preserved.
  return {
    vault: vault.name,
    path: filePath,
    content: typeof content === 'string' ? sanitizeContent(content) : content,
  };
}
