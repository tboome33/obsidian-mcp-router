/**
 * The steps a person still has to take in Obsidian after a plugin sync — told
 * for THIS vault, in order.
 *
 * A sync writes files; Obsidian does not notice them until it reloads, keeps
 * every community plugin off while Restricted mode is on, and installs nothing
 * by itself. Before this checklist the sync ended on "Synced N plugin(s)" and
 * the vault sat there with its plugins dark. The steps:
 *
 *   1. Reload Obsidian — desktop: the command palette's "Reload app without
 *      saving"; a container (linuxserver/obsidian and the like): the same
 *      palette command in the web UI, or restart the service. When it is not
 *      known which one applies, both are printed.
 *   2. Turn Restricted mode off (plugins never load while it is on).
 *   3. Check the plugins that have code are switched on.
 *   4. Run BRAT "Check for updates" so it installs the GitHub-only plugins it
 *      tracks (the bridge) — or install BRAT first when its code is missing.
 *   5. Install the missing marketplace plugins.
 *   6. Verify with `--plugin-health`.
 *
 * Steps that do not apply to the vault are left out, and the numbering follows.
 * Pure: plain data in, lines out.
 */

/** BRAT's command id for "check for updates to all beta plugins and UPDATE". */
export const BRAT_UPDATE_COMMAND_ID = 'obsidian42-brat:checkForUpdatesAndUpdate';
/** How the same command reads in Obsidian's palette (BRAT 2.x). */
export const BRAT_UPDATE_COMMAND_NAME = 'BRAT: Plugins: Check for updates to all beta plugins and UPDATE';

/**
 * @param {object} input
 * @param {string} input.vaultPath
 * @param {boolean|null} [input.container] true = container, false = desktop,
 *   null/undefined = unknown (both variants are printed).
 * @param {string} [input.service] compose service name when known.
 * @param {string[]} [input.withCode] enabled ids that have code in the vault.
 * @param {string[]} [input.bratPending] ids BRAT still has to install.
 * @param {boolean} [input.bratHasCode] whether BRAT's own code is in the vault.
 * @param {string[]} [input.marketplaceMissing] enabled marketplace ids without code.
 * @returns {string[]} numbered lines, header first.
 */
export function buildPostSyncChecklist({
  vaultPath,
  container = null,
  service = null,
  withCode = [],
  bratPending = [],
  bratHasCode = false,
  marketplaceMissing = [],
}) {
  const steps = [];
  const svc = service || '<service>';
  const desktop = 'desktop: Ctrl+P (Cmd+P on macOS) → "Reload app without saving"';
  const inContainer = `container (e.g. linuxserver/obsidian): the same palette command in the web UI, or \`docker compose restart ${svc}\``;
  if (container === true) steps.push(`Reload Obsidian — ${inContainer}.`);
  else if (container === false) steps.push(`Reload Obsidian — ${desktop}.`);
  else steps.push(`Reload Obsidian — ${desktop}; ${inContainer}.`);

  steps.push('Turn off Restricted mode: Settings → Community plugins → "Turn on community plugins".');

  if (withCode.length > 0) {
    steps.push(`Enable the plugins: Settings → Community plugins → Installed plugins — check these are switched on: ${[...withCode].sort().join(', ')}.`);
  }

  if (bratPending.length > 0) {
    const run = `Ctrl+P → "${BRAT_UPDATE_COMMAND_NAME}" (command id ${BRAT_UPDATE_COMMAND_ID})`;
    if (bratHasCode) {
      steps.push(`Run BRAT "Check for updates" so it installs ${[...bratPending].sort().join(', ')}: ${run}.`);
    } else {
      steps.push(`Install BRAT (obsidian42-brat) from the marketplace, enable it, then run ${run} so it installs ${[...bratPending].sort().join(', ')}.`);
    }
  }

  if (marketplaceMissing.length > 0) {
    steps.push(
      `Install the missing marketplace plugins (${[...marketplaceMissing].sort().join(', ')}): ` +
      `Settings → Community plugins → Browse → install → enable — or \`obsidian-mcp-router --install-plugins "${vaultPath}"\`.`,
    );
  }

  steps.push(`Verify: \`obsidian-mcp-router --plugin-health "${vaultPath}"\`.`);

  return [`Next steps in Obsidian for ${vaultPath}:`, ...steps.map((s, i) => `  ${i + 1}. ${s}`)];
}
