import { listFilesIn } from '../rest-client.mjs';
import { sanitizeResponse } from '../helpers/sanitize.mjs';

export async function listFiles(registry, { vault: name, directory } = {}) {
  const vault = registry.resolveVault(name);
  const result = await listFilesIn(vault, directory || '');
  // Sanitize: paths can contain attacker-controlled bytes (think file named
  // "\x1b]0;EVIL\x07.md" living inside a vault we read). Consistent with
  // search / search_smart / get_file wire-up — IMP-1 from /review+.
  return sanitizeResponse({
    vault: vault.name,
    directory: directory || '',
    ...result,
  });
}
