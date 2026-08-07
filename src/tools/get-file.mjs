import { getFileContent } from '../rest-client.mjs';
import { canonicalVaultPath } from '../helpers/vault-path-guard.mjs';
import { buildClickToOpenUrl } from '../helpers/click-to-open.mjs';
import { contentSha256 } from '../helpers/content-hash.mjs';

export async function getFile(registry, { vault: name, path: filePath } = {}) {
  if (!filePath) {
    throw new Error('Missing required argument: path');
  }
  // VALIDATED BEFORE THE REGISTRY IS TOUCHED. Fail on the path first: a bad
  // path is a caller error and resolving a vault can itself throw, start a
  // tunnel, or log — work that a refused call should never cause.
  //
  // CONTAINMENT ON THE READ SIDE TOO. The guard was wired into the seven write
  // tools and stopped there, while this module puts a caller path on the wire
  // through the same encodePath: `../../active/` reaches GET /active, and
  // `../` reaches GET /. A read is a smaller blast radius than a write, not a
  // different question.
  const safePath = canonicalVaultPath(filePath, 'path');
  const vault = registry.resolveVault(name);
  const content = await getFileContent(vault, safePath);
  // THE RESPONSE ECHOES THE CANONICAL SPELLING, not the caller's.
  // Reading `safePath` while answering with `filePath` meant a request for
  // a redundant spelling read one file and named another: the REST layer got
  // the canonical form, the model got the original, and the link was built
  // from the original too. The whole point of canonicalising is that ONE
  // spelling addresses the file — answering with a different one gives that up.
  const clickToOpenUrl = buildClickToOpenUrl(vault, safePath);
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
  // RAW — normalized once by `wrapResult` at the wire boundary.
  //
  // This tool used to sanitize `content` here and nothing else: `path` is a
  // caller argument and the structured (note+json) branch returned whatever the
  // REST API produced, both straight through. It was also the tool the
  // round-10 sweep skipped precisely BECAUSE the module already contained the
  // word `sanitize` — the grep-shaped guard saw it and moved on. Two different
  // failures, one cause: normalization living where it is easy to half-do.
  return {
    vault: vault.name,
    path: safePath,
    content,
    // Hashed on the RAW bytes, before any sanitisation, and NOT re-walked:
    // it is hex, and an `ifMatch` replay compares it against what is on disk.
    ...(typeof content === 'string' && { contentSha256: contentSha256(content) }),
    ...(clickToOpenUrl && { clickToOpenUrl }),
  };
}
