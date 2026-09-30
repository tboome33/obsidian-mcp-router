/**
 * What a plugin sync actually did — or, for a dry-run, will do — told in three
 * buckets instead of one flattering count.
 *
 * WHY THIS EXISTS. `--sync-from-github` once reported
 *   "Synced 4 new plugin(s): mcp-router-bridge, obsidian-icon-folder,
 *    obsidian-quiet-outline, obsidian42-brat"
 * when three of those four folders held nothing but a `data.json` — settings
 * for a plugin whose code was never installed. Seven more plugins that the
 * skeleton enables had no folder at all, and nobody said so. The vault looked
 * provisioned and was not.
 *
 * So a plugin is only ever called INSTALLED when its code is on disk after the
 * copy: `main.js` AND `manifest.json` in the target's plugin folder. Everything
 * else lands in a bucket that says what is still missing:
 *
 *   - codeInstalled        — copied this run, and the target now has its code.
 *   - settingsOnly         — copied this run, but only settings arrived (the
 *                            skeleton ships config pre-seeds; the code comes
 *                            from the marketplace or BRAT).
 *   - enabledWithoutCode   — listed in the target's community-plugins.json (or
 *                            enabled by the sync source) with no `main.js` in
 *                            the target. Includes ids the source enables and
 *                            never provided at all.
 *
 * Enabling an id without its code is deliberate and kept: Obsidian switches a
 * listed plugin on as soon as its code arrives (BRAT installing the bridge, the
 * user installing from the marketplace), so the list is written ahead of time.
 * It is simply never COUNTED as synced, and the report says so.
 *
 * Pure: plain data in, plain data out. The CLI (scripts/setup-vault.mjs) reads
 * the filesystem and prints; nothing here touches a disk.
 */

/** Actions a per-plugin plan entry can carry. */
export const PLUGIN_SYNC_ACTIONS = Object.freeze({
  COPY: 'copy',                       // first-time copy into the target
  REFRESH: 'refresh',                 // --force re-clone, target data.json preserved
  SKIP_PRESENT: 'skip-present',       // already in the target, no --force
  KEEP_NEWER: 'keep-newer',           // target version is newer (BRAT-updated)
  KEEP_INSTALLED: 'keep-installed',   // a settings pre-seed never replaces installed code
  DEFER_CREDENTIAL: 'defer-credential', // credentialed plugin, target has no data.json
  REFUSED: 'refused',                 // failed the network-source vetting
  NOT_OWNED: 'not-owned',             // apply-time: the vault belongs to another installation
});

/** Actions that write the plugin folder into the target. */
const WRITING_ACTIONS = new Set([PLUGIN_SYNC_ACTIONS.COPY, PLUGIN_SYNC_ACTIONS.REFRESH]);

const sortedUnique = (xs) => [...new Set((xs || []).map(String))].sort();

function toPredicate(hasCode) {
  if (typeof hasCode === 'function') return (id) => Boolean(hasCode(id));
  if (hasCode instanceof Set) return (id) => hasCode.has(id);
  const obj = hasCode && typeof hasCode === 'object' ? hasCode : {};
  return (id) => Boolean(obj[id]);
}

/**
 * Classify a sync into the three buckets.
 *
 * @param {object} input
 * @param {Array<{id: string, action: string, kind?: string}>} input.entries
 *   the per-plugin decisions (plan or outcome).
 * @param {string[]} input.targetEnabled ids in the target's community-plugins.json
 *   (after the sync, or projected for a dry-run).
 * @param {string[]} [input.sourceEnabled] ids the sync SOURCE enables — an id the
 *   source enables but never ships is reported too, never silently dropped.
 * @param {object|Set|Function} input.hasCode which ids have `main.js` +
 *   `manifest.json` in the target (after, or projected).
 * @param {string[]} [input.bratManaged] ids BRAT installs (GitHub-only plugins,
 *   e.g. the bridge) — their remedy is BRAT, not the marketplace.
 */
export function summarizePluginSync({ entries, targetEnabled, sourceEnabled = [], hasCode, bratManaged = [] }) {
  const has = toPredicate(hasCode);
  const brat = new Set(bratManaged);
  const list = Array.isArray(entries) ? entries : [];
  const written = list.filter((e) => WRITING_ACTIONS.has(e.action)).map((e) => e.id);
  const codeInstalled = sortedUnique(written.filter((id) => has(id)));
  const settingsOnly = sortedUnique(written.filter((id) => !has(id)));

  const enabledInVault = new Set(targetEnabled || []);
  const candidates = sortedUnique([...(targetEnabled || []), ...(sourceEnabled || [])]);
  const enabledWithoutCode = candidates
    .filter((id) => !has(id))
    .map((id) => ({
      id,
      enabledInVault: enabledInVault.has(id),
      installVia: brat.has(id) ? 'brat' : 'marketplace',
    }));

  const pick = (action) => sortedUnique(list.filter((e) => e.action === action).map((e) => e.id));
  return {
    codeInstalled,
    settingsOnly,
    enabledWithoutCode,
    refreshed: pick(PLUGIN_SYNC_ACTIONS.REFRESH),
    skippedPresent: pick(PLUGIN_SYNC_ACTIONS.SKIP_PRESENT),
    keptNewer: pick(PLUGIN_SYNC_ACTIONS.KEEP_NEWER),
    keptInstalled: pick(PLUGIN_SYNC_ACTIONS.KEEP_INSTALLED),
    deferredCredential: pick(PLUGIN_SYNC_ACTIONS.DEFER_CREDENTIAL),
    refused: pick(PLUGIN_SYNC_ACTIONS.REFUSED),
    notOwned: pick(PLUGIN_SYNC_ACTIONS.NOT_OWNED),
  };
}

/**
 * Project a plan onto the target's CURRENT state, for a dry-run: which ids will
 * be listed in community-plugins.json and which will have code afterwards.
 * Mirrors the apply: a first-time COPY appends its id to the list (code or not);
 * a COPY/REFRESH of kind `code` brings code; nothing else changes either.
 *
 * @param {object} input
 * @param {Array<{id: string, action: string, kind?: string}>} input.entries
 * @param {string[]} input.targetEnabledBefore
 * @param {object|Set|Function} input.hasCodeBefore
 * @returns {{targetEnabled: string[], willEnable: string[], hasCode: (id: string) => boolean}}
 */
export function projectPluginSync({ entries, targetEnabledBefore, hasCodeBefore }) {
  const before = toPredicate(hasCodeBefore);
  const list = Array.isArray(entries) ? entries : [];
  const targetEnabled = [...(targetEnabledBefore || [])].map(String);
  const willEnable = [];
  for (const e of list) {
    if (e.action === PLUGIN_SYNC_ACTIONS.COPY && !targetEnabled.includes(e.id)) {
      targetEnabled.push(e.id);
      willEnable.push(e.id);
    }
  }
  const bringsCode = new Set(
    list.filter((e) => WRITING_ACTIONS.has(e.action) && e.kind === 'code').map((e) => e.id),
  );
  return {
    targetEnabled,
    willEnable: sortedUnique(willEnable),
    hasCode: (id) => before(id) || bringsCode.has(id),
  };
}

/** The one-command alternative to installing marketplace plugins by hand. */
export function installPluginsCommand(vaultPath) {
  return `obsidian-mcp-router --install-plugins "${vaultPath}"`;
}

/**
 * Human lines for the post-sync report. Each line is `{ level, text }` with
 * level one of `ok` / `info` / `warn`, so the CLI keeps its own colouring.
 *
 * @param {ReturnType<typeof summarizePluginSync>} summary
 * @param {{vaultPath: string}} ctx
 */
export function formatPluginSyncReport(summary, { vaultPath }) {
  const lines = [];
  const s = summary;
  if (s.codeInstalled.length > 0) {
    lines.push({ level: 'ok', text: `Code installed for ${s.codeInstalled.length} plugin(s): ${s.codeInstalled.join(', ')}` });
  }
  if (s.settingsOnly.length > 0) {
    lines.push({
      level: 'warn',
      text: `Settings only for ${s.settingsOnly.length} plugin(s) — code still to install: ${s.settingsOnly.join(', ')}`,
    });
  }
  if (s.enabledWithoutCode.length > 0) {
    const inVault = s.enabledWithoutCode.filter((e) => e.enabledInVault).map((e) => e.id);
    const bySource = s.enabledWithoutCode.filter((e) => !e.enabledInVault).map((e) => e.id);
    const groups = [];
    if (inVault.length > 0) groups.push(`listed in this vault: ${inVault.join(', ')}`);
    if (bySource.length > 0) groups.push(`enabled by the sync source, not listed here: ${bySource.join(', ')}`);
    lines.push({
      level: 'warn',
      text: `Enabled without code — ${s.enabledWithoutCode.length} plugin(s); ${groups.join('; ')}`,
    });
    lines.push({
      level: 'info',
      text: 'These ids stay listed in .obsidian/community-plugins.json so each plugin switches on as soon as its code arrives. They are NOT counted as synced.',
    });
    const viaBrat = s.enabledWithoutCode.filter((e) => e.installVia === 'brat').map((e) => e.id);
    const viaMarket = s.enabledWithoutCode.filter((e) => e.installVia === 'marketplace').map((e) => e.id);
    if (viaMarket.length > 0) {
      lines.push({ level: 'info', text: `Missing marketplace plugin(s): ${viaMarket.join(', ')}` });
      lines.push({ level: 'info', text: '  Install by hand: Obsidian → Settings → Community plugins → Browse → search each id → Install → Enable.' });
      lines.push({ level: 'info', text: `  Or in one command: ${installPluginsCommand(vaultPath)}` });
    }
    if (viaBrat.length > 0) {
      lines.push({ level: 'info', text: `Installed by BRAT (GitHub-only): ${viaBrat.join(', ')} — run BRAT "Check for updates" (see the checklist below).` });
    }
  }
  return lines;
}

/**
 * Human lines for a dry-run: one line per plugin with the decision, whether it
 * carries code or settings only, and the files that would be copied.
 *
 * @param {Array<{id: string, action: string, kind?: string, files?: string[]}>} entries
 * @param {{willEnable: string[], remainWithoutCode: string[]}} projected
 */
export function formatPluginSyncPlan(entries, { willEnable = [], remainWithoutCode = [] } = {}) {
  const LABEL = {
    [PLUGIN_SYNC_ACTIONS.COPY]: 'copy',
    [PLUGIN_SYNC_ACTIONS.REFRESH]: 'refresh (--force, data.json kept)',
    [PLUGIN_SYNC_ACTIONS.SKIP_PRESENT]: 'skip — already present',
    [PLUGIN_SYNC_ACTIONS.KEEP_NEWER]: 'skip — target version is newer',
    [PLUGIN_SYNC_ACTIONS.KEEP_INSTALLED]: 'skip — settings pre-seed never replaces installed code',
    [PLUGIN_SYNC_ACTIONS.DEFER_CREDENTIAL]: 'deferred — credentialed plugin, bootstrap the vault first',
    [PLUGIN_SYNC_ACTIONS.REFUSED]: 'refused by the network-source vetting',
  };
  const lines = [];
  for (const e of [...(entries || [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const writes = WRITING_ACTIONS.has(e.action);
    const kind = writes ? (e.kind === 'code' ? ' [code]' : ' [settings only — code still to install]') : '';
    const files = writes && Array.isArray(e.files) && e.files.length > 0 ? ` (${e.files.join(', ')})` : '';
    lines.push(`${e.id}: ${LABEL[e.action] ?? e.action}${kind}${files}`);
  }
  lines.push(`will enable: ${willEnable.length > 0 ? willEnable.join(', ') : '(none)'}`);
  lines.push(`enabled but still without code afterwards: ${remainWithoutCode.length > 0 ? remainWithoutCode.join(', ') : '(none)'}`);
  return lines;
}
