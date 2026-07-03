// Pure helper: resolve the set of plugins a fresh vault should clone from a
// reference vault. Extracted from setup-vault.mjs so it is unit-testable
// WITHOUT importing that module (importing setup-vault.mjs runs its top-level
// CLI dispatch — see the note above its `export {}` block). Mirrors the
// path-helpers.mjs pattern (pure module, imported by both the CLI and tests).
//
// The clone list is DERIVED from the reference's own community-plugins.json
// (the set of plugins Obsidian has ENABLED there), unioned with the caller's
// REQUIRED plugins. This kills the historical "activated in the skeleton's
// community-plugins.json but absent from a hardcoded OPTIONAL_PLUGINS constant
// → never cloned" drift: any plugin the reference enables now propagates
// automatically, with no constant to keep in sync.
//
// Downstream safety (CREDENTIAL_LEAK_PLUGINS exclusions, per-vault data.json
// regeneration for the REST API plugin) is applied by the caller, independent
// of this list. A missing or malformed community-plugins.json yields the
// REQUIRED plugins only — the caller's `REQUIRED_PLUGINS.includes(p)` guard
// still fails loudly if a required plugin is physically absent from the source.

import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string} referenceVault Absolute path to the source/reference vault.
 * @param {string[]} requiredPlugins Plugins that MUST always be in the list
 *   (REQUIRED_PLUGINS), regardless of the source's community-plugins.json.
 * @returns {string[]} REQUIRED-first, de-duplicated clone list.
 */
export function resolvePluginsToClone(referenceVault, requiredPlugins = []) {
  const seen = new Set();
  const list = [];
  // REQUIRED first, preserving order, deduped.
  for (const p of requiredPlugins) {
    if (typeof p === 'string' && p && !seen.has(p)) { seen.add(p); list.push(p); }
  }
  try {
    const raw = fs.readFileSync(
      path.join(referenceVault, '.obsidian', 'community-plugins.json'), 'utf8');
    const cp = JSON.parse(raw);
    if (Array.isArray(cp)) {
      for (const p of cp) {
        if (typeof p === 'string' && p && !seen.has(p)) { seen.add(p); list.push(p); }
      }
    }
  } catch {
    // Missing / malformed community-plugins.json → REQUIRED only.
  }
  return list;
}
