import { getNote } from '../rest-client.mjs';
import { canonicalVaultPath } from '../helpers/vault-path-guard.mjs';
import { buildClickToOpenUrl } from '../helpers/click-to-open.mjs';

export async function getFrontmatterTool(registry, args = {}) {
  const { vault: name, path: filePath, key } = args;
  if (!filePath) throw new Error('Missing required argument: path');

  // Path first, registry second — see get-file.mjs.
  // Same wire, same encoder, same traversal.
  const safePath = canonicalVaultPath(filePath, 'path');
  const vault = registry.resolveVault(name);
  const note = await getNote(vault, safePath);
  const frontmatter = note.frontmatter ?? {};
  // THE RESPONSE ECHOES THE CANONICAL SPELLING, not the caller's.
  // Reading `safePath` while answering with `filePath` meant a request for
  // a redundant spelling read one file and named another: the REST layer got
  // the canonical form, the model got the original, and the link was built
  // from the original too. The whole point of canonicalising is that ONE
  // spelling addresses the file — answering with a different one gives that up.
  const clickToOpenUrl = buildClickToOpenUrl(vault, safePath);

  // Sanitize: frontmatter values are vault-attacker-controlled like search
  // results. `sanitizeResponse` preserves non-string types (numbers, bools,
  // arrays) intact — only string scalars are cleaned. Consistent with the
  // sanitize wire-up of search / get_file — IMP-1 from /review+.
  if (key) {
    return ({
      vault: vault.name,
      path: safePath,
      key,
      value: frontmatter[key] ?? null,
      exists: Object.prototype.hasOwnProperty.call(frontmatter, key),
      ...(clickToOpenUrl && { clickToOpenUrl }),
    });
  }
  // Second return, same rule. The first pass changed the `key` branch above and
  // left this one — a two-branch function fixed on one branch, which is the
  // whole subject of this release in miniature.
  return {
    vault: vault.name,
    path: safePath,
    frontmatter,
    ...(clickToOpenUrl && { clickToOpenUrl }),
  };
}
