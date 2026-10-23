/**
 * unregister_vault — MCP tool. The other half of register_remote_vault: take a
 * vault out of the router's config from the conversation (or the vault
 * panel's administration console) — no hand edit of config.json.
 *
 * Two kinds of entry, two different removals, both in the router's OWN
 * config and never on a vault's disk:
 *
 *   - a `remoteVaults` entry (what register_remote_vault wrote, a remote vault
 *     or a local one registered by its REST address) is DELETED, its apiKey
 *     with it;
 *   - a LOCAL vault the router found by its folder (portRegistry) is not
 *     deleted — the router would find it again — but its name is ADDED to
 *     `disabledVaults`, the operator's own switch: no session loads it, and
 *     removing the name from that list brings it back. Its folder, its notes
 *     and Obsidian's own list are left untouched.
 *
 * REFUSED while any workspace binding names the vault (primary or
 * secondary): a binding pointing at a vault that no longer exists would fail
 * every session of that workspace at its next start. The refusal names the
 * workspaces, to unbind first.
 *
 * GATED DEPLOYMENTS: local-only, like register_remote_vault — MCPHub's
 * tenants share one central config.json, and one tenant must not remove a
 * vault another tenant's allowlist names.
 */

import { registeredVaultPaths, vaultSlug, disabledVaultEntries, openVaultEntries } from '../helpers/vault-slug.mjs';
import { updateConfigBindings, WORKSPACE_BINDINGS_KEY } from '../helpers/workspace-bindings.mjs';
import { safeForMessage } from '../helpers/sanitize.mjs';

/**
 * @param {object} registry the live registry (used for `configPath`)
 * @param {object} args tool input — `{ name }`
 * @param {{ readFile?: Function, writeFile?: Function }} [seams] test seams,
 *   threaded straight through to updateConfigBindings — omitted in production.
 */
export async function unregisterVaultTool(registry, args = {}, seams = {}) {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!name) {
    throw new Error('unregister_vault requires `name` — the registered vault to take out of the router config.');
  }
  const configPath = registry && registry.configPath;
  if (!configPath) {
    throw new Error('unregister_vault: the router has no config path — nothing to remove from.');
  }

  // Case-insensitive, as register_remote_vault's collision check and every
  // name resolver of the binding paths are.
  const nameLower = name.toLowerCase();
  const same = (candidate) => typeof candidate === 'string' && candidate.toLowerCase() === nameLower;

  let outcome = null;
  updateConfigBindings(configPath, (cfg) => {
    const remoteVaults = Array.isArray(cfg.remoteVaults) ? cfg.remoteVaults : [];
    const remoteIndex = remoteVaults.findIndex((r) => r && same(r.name));
    const localName = registeredVaultPaths(cfg).map((vp) => vaultSlug(cfg, vp)).find(same);
    if (remoteIndex < 0 && !localName) {
      throw new Error(
        `unregister_vault: "${safeForMessage(name, 60)}" is not a registered vault — nothing was changed. `
        + 'list_vaults lists the registered ones.',
      );
    }

    // Read inside the lock: a binding another session wrote a moment ago counts.
    const bindings = cfg[WORKSPACE_BINDINGS_KEY] && typeof cfg[WORKSPACE_BINDINGS_KEY] === 'object'
      ? cfg[WORKSPACE_BINDINGS_KEY]
      : {};
    const boundIn = Object.entries(bindings)
      .filter(([, b]) => b && typeof b === 'object' && (same(b.vault) || (Array.isArray(b.also) && b.also.some(same))))
      .map(([workspace]) => workspace);
    if (boundIn.length > 0) {
      const shown = boundIn.slice(0, 3).map((w) => `"${safeForMessage(w, 80)}"`).join(', ');
      throw new Error(
        `unregister_vault: "${safeForMessage(name, 60)}" is still bound to ${boundIn.length} workspace(s) `
        + `(${shown}${boundIn.length > 3 ? ', …' : ''}) — nothing was changed. Remove it from those bindings first `
        + '(confirm_workspace_binding without it, or clear the binding).',
      );
    }

    const next = { ...cfg };
    if (remoteIndex >= 0) {
      next.remoteVaults = remoteVaults.filter((_, i) => i !== remoteIndex);
      outcome = { name: remoteVaults[remoteIndex].name, removedFrom: 'remoteVaults' };
    } else {
      // The EXACT name: the loader compares `disabledVaults` entries to the
      // vault's name as written, so "NOTES" does not disable "notes".
      const disabled = disabledVaultEntries(cfg);
      if (!disabled.includes(localName)) {
        next.disabledVaults = [...disabled, localName];
      }
      outcome = { name: localName, removedFrom: 'disabledVaults' };
    }
    // A name `openVaults` still lists would make the loader look for a vault
    // that is gone (remote) or skipped (local). Read through the helper's
    // boundary check, and rewritten only when it does name the vault.
    const open = openVaultEntries(cfg);
    if (open.some(same)) {
      next.openVaults = open.filter((n) => !same(n));
    }
    return next;
  }, seams);

  const removed = outcome;
  return {
    unregistered: true,
    name: removed.name,
    removedFrom: removed.removedFrom,
    message: removed.removedFrom === 'remoteVaults'
      ? `Removed "${removed.name}" from the router config, its API key with it. The vault itself is untouched; `
        + 'register_remote_vault registers it again.'
      : `"${removed.name}" is a local vault the router finds by its folder: it was added to \`disabledVaults\`, `
        + 'so no session loads it. Its folder and notes are untouched; remove the name from `disabledVaults` to bring it back.',
  };
}
