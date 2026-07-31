import { getFileContent } from '../rest-client.mjs';
import { sanitizeContent } from '../helpers/sanitize.mjs';
import { buildClickToOpenUrl } from '../helpers/click-to-open.mjs';
import { contentSha256 } from '../helpers/content-hash.mjs';

export async function getFile(registry, { vault: name, path: filePath } = {}) {
  if (!filePath) {
    throw new Error('Missing required argument: path');
  }
  const vault = registry.resolveVault(name);
  const content = await getFileContent(vault, filePath);
  const clickToOpenUrl = buildClickToOpenUrl(vault, filePath);
  // The content field is opaque to the router (string for raw markdown,
  // object for the `application/vnd.olrapi.note+json` content-negotiated
  // representation). Only sanitize strings — let the structured form pass
  // through untouched so frontmatter types are preserved.
  //
  // contentSha256 (C1) is computed on the RAW content BEFORE sanitize, so it
  // matches the bytes on disk (what the bridge's atomic CAS read compares
  // against). Hashing the sanitized copy instead would make every replayed
  // `ifMatch` a guaranteed mismatch. Only strings get a hash — the structured
  // note+json form has no single canonical byte content to pin.
  return {
    vault: vault.name,
    path: filePath,
    content: typeof content === 'string' ? sanitizeContent(content) : content,
    ...(typeof content === 'string' && { contentSha256: contentSha256(content) }),
    ...(clickToOpenUrl && { clickToOpenUrl }),
  };
}
