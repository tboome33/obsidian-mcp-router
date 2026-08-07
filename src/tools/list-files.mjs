import { listFilesIn } from '../rest-client.mjs';
import { canonicalVaultPath } from '../helpers/vault-path-guard.mjs';

export async function listFiles(registry, { vault: name, directory } = {}) {
  // Path first, registry second: a refused call should not resolve a vault.
  // CONTAINMENT, on a READ path. `canonicalVaultPath` was wired into the seven
  // write tools and stopped there, while this module hands a caller-supplied
  // directory to the same `encodePath`. `..` survives `encodeURIComponent`, and
  // the URL parser collapses the dot segments BEFORE the request goes out, so
  // `directory: "../commands"` reached `GET /commands/` — an enumeration of the
  // installed plugins and commands, from a tool that is deliberately exposed on
  // `OBSIDIAN_ROUTER_READONLY` deployments.
  //
  // The guard's own docstring claimed it was "used by every tool that puts a
  // caller-supplied path on the wire". That sentence was false for three read
  // tools, in the module written to end exactly this class of miss. Fourteen
  // rounds in, the release's signature failure mode showed up inside its own
  // remedy.
  //
  // Conditional because an EMPTY directory means the vault root, which is a
  // legitimate request and which `canonicalVaultPath` rejects (it validates
  // paths that name something).
  const safeDir = directory ? canonicalVaultPath(directory, 'directory') : '';
  const vault = registry.resolveVault(name);
  const result = await listFilesIn(vault, safeDir);
  // RAW. `wrapResult` normalizes every response once, at the wire boundary.
  return {
    vault: vault.name,
    directory: safeDir,
    ...result,
  };
}
