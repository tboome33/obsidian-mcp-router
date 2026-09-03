/**
 * obsidian-launcher.mjs — the ONE place that asks the operating system to open
 * a vault in Obsidian.
 *
 * ---------------------------------------------------------------------------
 * WHY IT MOVED HERE
 * ---------------------------------------------------------------------------
 * This lived in `scripts/setup-vault.mjs`, where `--open` used it after
 * provisioning a vault. The binding lot needs it from the SERVER too: a
 * workspace can be bound to a vault whose Obsidian is not running, and a vault
 * that is not open does not answer — its Local REST API only serves while
 * Obsidian has that vault open. Binding a closed vault would record a promise
 * that does not work.
 *
 * `open_in_obsidian` is NOT this. That tool navigates an Obsidian that is
 * ALREADY running for the vault (router → loopback HTTP → bridge). It cannot
 * start one. The only thing that starts one is the `obsidian://` protocol
 * handler, dispatched through the desktop opener — which is what lives here.
 *
 * Moved rather than copied. A second launcher would be a second answer to one
 * question, and this one carries a lesson (the Electron fuse below) that a
 * copy would eventually lose.
 *
 * ---------------------------------------------------------------------------
 * THE CAPABILITY, AND ITS BOUND
 * ---------------------------------------------------------------------------
 * Launching a desktop application is a real capability, so it is bounded BY
 * CONSTRUCTION rather than by validating a string: this module takes a vault
 * NAME and builds the URI itself. It has no entry point that accepts a URI, so
 * there is nothing for a caller to smuggle one through. The name still has to
 * come from the caller's own registry — the same shape as "a workspace file
 * can only ever name a vault the user already registered".
 *
 * Node builtins only.
 */

import { spawnSync } from 'node:child_process';

/**
 * The `obsidian://` URI that opens a vault by its Obsidian-side label.
 *
 * That label is the on-disk folder basename WITH its casing, not the router's
 * lowercased slug — the URI handler matches what Obsidian itself registered.
 * Callers that hold a router slug must resolve the basename first; `list_vaults`
 * already publishes it as `obsidianName`.
 *
 * @param {string} obsidianName
 * @returns {string}
 */
export function obsidianOpenUri(obsidianName) {
  return `obsidian://open?vault=${encodeURIComponent(obsidianName)}`;
}

/**
 * Build the environment the desktop launcher runs with.
 *
 * THIS PASSES THE PROCESS ENVIRONMENT THROUGH ON PURPOSE — the launched
 * application has to see the user's session (display, bus, authority). What
 * that environment contains depends on who started us: from the user's shell
 * it is the shell's; from the MCP server it is the allowlist of
 * subprocess-env.mjs, which names the session's display and bus variables for
 * exactly this hand-off.
 *
 * With ONE removal, and it is not decoration. Under an Electron host the
 * engine runs with `ELECTRON_RUN_AS_NODE`; an Obsidian that inherited it and
 * whose runAsNode fuse is open would start as a MUTE NODE PROCESS instead of
 * as the application — no window, no error, nothing to see. Removed by name
 * and case-insensitively, because Windows environment names are
 * case-insensitive and a lowercase spelling from the parent would survive a
 * `delete` of the uppercase one while Electron still read it.
 *
 * @param {object} [env]
 * @returns {Record<string,string>}
 */
export function launcherEnv(env = process.env) {
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (/^electron_(?:run_as_node|no_attach_console)$/i.test(name)) continue;
    out[name] = value;
  }
  return out;
}

/**
 * WHAT would be spawned to open `obsidianName`, without spawning it.
 *
 * Every decision this module makes lives here — the platform table, the URI,
 * the argument shape, the environment — so all of it is testable by a pure
 * call. Returns null when there is no usable vault name, which is how the
 * launcher below refuses without spawning.
 *
 * WHY THE SPLIT, and it is not taste. The first version took an injected
 * `spawn` so tests could record calls. That seam made the launcher INVISIBLE
 * to the guard in tests/subprocess-env.test.mjs, which finds spawn sites by
 * the LOCAL NAME OF THE IMPORT: calls read `spawn(...)`, the import was
 * `spawnSync`, and the guard reported this file as having no unguarded spawn
 * at all. It did not go red — it went blind, which reads as coverage. So the
 * seam moved up: the decisions are proven here, and the spawn itself is three
 * literal `spawnSync` calls the guard can see and pins by file, count and
 * command.
 *
 * @param {string} obsidianName
 * @param {{ platform?: string, env?: object }} [opts]
 * @returns {{ command: string, args: string[], options: object, uri: string }|null}
 */
export function launchPlan(obsidianName, { platform = process.platform, env = process.env } = {}) {
  if (typeof obsidianName !== 'string' || obsidianName.trim() === '') return null;
  const uri = obsidianOpenUri(obsidianName);
  const options = { stdio: 'ignore', env: launcherEnv(env) };
  if (platform === 'win32') {
    // `cmd /c start "" <uri>` dispatches the protocol handler. This is cmd.exe
    // with /c, not the spawning of a .cmd file, which the repo bans. The empty
    // '' is START's title argument: without it a quoted URI is taken AS the
    // title and nothing opens.
    return { command: 'cmd', args: ['/c', 'start', '', uri], options, uri };
  }
  if (platform === 'darwin') return { command: 'open', args: [uri], options, uri };
  return { command: 'xdg-open', args: [uri], options, uri };
}

/**
 * Ask the OS to open `obsidianName` in Obsidian.
 *
 * BEST EFFORT, ALWAYS. A launcher that throws would turn "I could not raise a
 * window" into a failed tool call, and the caller's real work (recording a
 * binding, answering a question) is not undone by a window that did not
 * appear. The result says what happened so the caller can tell the user
 * plainly, and always carries the URI so a human can finish the job by hand.
 *
 * Does NOT wait for Obsidian to finish starting, and does not verify that it
 * did: the protocol handler returns as soon as the OS has dispatched. A caller
 * that needs the vault to be reachable must poll the vault's own port
 * afterwards — starting an application is not the same event as its REST API
 * accepting connections.
 *
 * @param {string} obsidianName
 * @param {{ platform?: string, spawn?: Function, env?: object }} [opts] test seams
 * @returns {{ launched: boolean, uri: string, command: string|null, reason: string|null }}
 */
export function launchObsidianVault(obsidianName, { platform = process.platform, env = process.env } = {}) {
  const plan = launchPlan(obsidianName, { platform, env });
  if (!plan) return { launched: false, uri: '', command: null, reason: 'no vault name given' };
  const { uri, args, options } = plan;
  // THE THREE COMMAND NAMES ARE WRITTEN OUT, ONE PER BRANCH, ON PURPOSE.
  // A first version built `[command, args]` through a ternary and passed the
  // variable to `spawn` — tidier to read, and INVISIBLE to the guard in
  // tests/subprocess-env.test.mjs, which finds spawn sites by their literal
  // command. The guard did not go red; it went BLIND, and reported this file
  // as having no unguarded spawn at all. A guard that cannot see the thing it
  // guards is worse than no guard, because it reads as coverage. Literal
  // names, three branches, one file — exactly what the exemption table pins by
  // file, by count and by command, so a fourth opener cannot arrive unnoticed.
  const command = plan.command;
  try {
    let r;
    if (platform === 'win32') r = spawnSync('cmd', args, options);
    else if (platform === 'darwin') r = spawnSync('open', args, options);
    else r = spawnSync('xdg-open', args, options);
    if (r?.error) return { launched: false, uri, command, reason: String(r.error.message || r.error) };
    return { launched: true, uri, command, reason: null };
  } catch (e) {
    return { launched: false, uri, command, reason: String(e?.message || e) };
  }
}
