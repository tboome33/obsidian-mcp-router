/**
 * server-process — "is this process the router SERVER?"
 *
 * The router server is HTTP-only by doctrine: no tool may read a vault's disk
 * (tests/no-vault-disk.test.mjs proves it under `node --permission`). Some code
 * in this repository legitimately reads vault disk — the session hook's
 * semantic-readiness probe does, and must, because it has to work with
 * Obsidian closed. That code must never RUN inside the server.
 *
 * Proving "never loaded" by reading source text was tried for three review
 * rounds, and each round found another way to write an import a regex does not
 * see. So the rule is enforced at run time instead: the server marks itself,
 * and disk-reading code refuses to run where the mark is present.
 *
 * WHERE THE MARK LIVES, and why in two places:
 *  - a global keyed by a REGISTERED Symbol, so every instance of a module in
 *    the same JavaScript realm sees it (a `?query` import loads a fresh
 *    instance; a module-local variable would not survive that);
 *  - the process ENVIRONMENT, so what the global cannot reach still sees it:
 *    a worker thread (its own global, but a copy of the parent's env taken at
 *    creation) and a child process spawned by the server (it inherits env).
 *
 * WHAT IT DOES NOT COVER, stated so nobody relies on it: a worker or child
 * created BEFORE the mark was set, or spawned with an explicitly emptied env,
 * starts unmarked. The mark is set by `mark-server-process.mjs`, the first
 * import of both server entry points (`bin/obsidian-mcp-router.mjs` and
 * `src/index.mjs`), before any other part of the server graph runs, so in
 * practice nothing the server creates predates it.
 *
 * The environment variable is not settable from a workspace `.env`: the dotenv
 * loader applies only the keys it enumerates, and this is not one of them.
 * This module imports nothing, so loading it costs nothing and cannot fail.
 */

const MARK = Symbol.for('obsidian-mcp-router.server-process');
/**
 * The environment half of the mark, by name. Written and read below with a
 * LITERAL key: tests/workspace-dotenv.test.mjs forbids computed-key writes into
 * process.env anywhere but the policy module — the shape of an old any-key
 * loop — and the first version of this file tripped it.
 */
export const SERVER_PROCESS_ENV = 'OBSIDIAN_ROUTER_SERVER_PROCESS';

/** Mark THIS process as the router server. Called once, by mark-server-process.mjs. */
export function markServerProcess() {
  globalThis[MARK] = true;
  process.env.OBSIDIAN_ROUTER_SERVER_PROCESS = '1';
}

/** True in the router server process, in a worker it created, or in a child it spawned. */
export function isServerProcess() {
  return globalThis[MARK] === true || process.env.OBSIDIAN_ROUTER_SERVER_PROCESS === '1';
}
