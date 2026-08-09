/**
 * HOME-safe child spawning for tests — the class guard for a bug that slipped
 * two review passes.
 *
 * A child process (`setup-vault.mjs`, the router bin) resolves `os.homedir()`
 * from HOME / USERPROFILE / HOMEPATH, and several code paths WRITE there —
 * `maybeAutoInstallHooks` appends to `~/.claude/settings.json` at the tail of
 * every bootstrap. A test that spawns such a child WITHOUT redirecting those
 * vars mutates the developer's real global settings, violating AGENTS.md's
 * "tests must not write outside a temporary directory". On a machine whose
 * hooks are already wired it silently no-ops; on one where they are not, it
 * rewrites real config on every `npm test`.
 *
 * This module is the one place that builds a child env, and it REFUSES a home
 * that is not a throwaway directory — so the mistake fails loudly at the call
 * site instead of leaking to disk. Route every test child spawn through it;
 * a direct `spawnSync`/`spawn` that rebuilds the env by hand is the thing code
 * review should now catch, because the safe path is this short.
 *
 * NOT itself a test file (no `.test.mjs` suffix), so the dark-test guard does
 * not expect it in `npm test`.
 */

import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** The four vars `os.homedir()` consults, across platforms. */
export const HOME_VARS = ['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH'];

/**
 * Assert `homeDir` is a throwaway directory, never the real home.
 *
 * The invariant is deliberately about IDENTITY, not location: the bug is a
 * child inheriting the developer's real home, so the check that catches it is
 * "this is not that home". Requiring it to sit under `os.tmpdir()` as well
 * would be stricter but brittle on Windows (short paths, %TEMP% casing); the
 * callers all pass a `mkdtemp` dir anyway.
 *
 * @param {string} homeDir
 * @returns {string} the same path, when it is safe
 */
export function assertThrowawayHome(homeDir) {
  if (typeof homeDir !== 'string' || homeDir.trim() === '') {
    throw new Error('home-safe spawn: a throwaway homeDir is required (got empty). Pass a mkdtemp directory.');
  }
  const resolved = path.resolve(homeDir);
  if (resolved === path.resolve(os.homedir())) {
    throw new Error(
      `home-safe spawn: refusing to point a child's HOME at the REAL home (${resolved}). ` +
        'A child that writes ~/.claude/settings.json would mutate global config. Pass a mkdtemp directory.',
    );
  }
  return resolved;
}

/**
 * Build a child-process env whose HOME/USERPROFILE/HOMEPATH point at a
 * throwaway directory. Throws unless `homeDir` is one.
 *
 * `HOMEDRIVE` is cleared (set to '') so a Windows `HOMEDRIVE + HOMEPATH`
 * reconstruction cannot reach back into the real profile — the same shape the
 * hand-written overrides used.
 *
 * @param {string} homeDir  a mkdtemp directory
 * @param {Record<string,string>} [extra]  additional env, applied last
 * @returns {Record<string,string>}
 */
export function homeSafeEnv(homeDir, extra = {}) {
  const home = assertThrowawayHome(homeDir);
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: '',
    HOMEPATH: home,
    ...extra,
  };
}

/**
 * `spawnSync` with a guaranteed throwaway HOME. Same signature as spawnSync
 * except the options take `homeDir` (required) and optional `env` extras.
 *
 * @param {string} file
 * @param {string[]} args
 * @param {{ homeDir: string, env?: Record<string,string> } & object} options
 */
export function spawnSyncHomeSafe(file, args, { homeDir, env = {}, ...rest } = {}) {
  return spawnSync(file, args, {
    encoding: 'utf8',
    ...rest,
    env: homeSafeEnv(homeDir, env),
  });
}
