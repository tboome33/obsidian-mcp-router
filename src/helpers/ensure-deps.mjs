/**
 * ensure-deps.mjs — make the server's npm dependencies present before the
 * module graph that needs them is evaluated.
 *
 * WHY THIS EXISTS (Lot 5 — the plugin carries the MCP server)
 * ------------------------------------------------------------------
 * When Claude Code starts the router from a plugin install, it spawns
 * `node ${CLAUDE_PLUGIN_ROOT}/bin/obsidian-mcp-router.mjs`. That directory
 * is a fresh per-version copy under `~/.claude/plugins/cache/...`, and
 * NOTHING in the documented plugin contract guarantees it has a
 * `node_modules/`. Without one the process used to die instantly with
 * ERR_MODULE_NOT_FOUND before it could say why.
 *
 * Two paths do provision deps today, and neither is a guarantee:
 *   - our own auto-update (`src/helpers/plugin-auto-update.mjs`) runs
 *     `npm install --omit=dev --ignore-scripts` in the new cache dir;
 *   - Claude Code appears to npm-install plugins that carry a
 *     package.json — observed, but undocumented, so not relied upon.
 * `/plugin update` and a plain `/plugin install` are the gap this closes.
 *
 * WHY NOT `NODE_PATH` / `${CLAUDE_PLUGIN_DATA}`
 * ------------------------------------------------------------------
 * The documented pattern is `env: { NODE_PATH: "${CLAUDE_PLUGIN_DATA}/node_modules" }`.
 * NODE_PATH is honoured only by the CommonJS resolver — Node's ESM resolver
 * ignores it (verified on Node 23.11: a CJS `require` resolves, the same
 * package under `import` throws ERR_MODULE_NOT_FOUND). This package is
 * `"type": "module"` throughout, so that pattern cannot work here.
 * A `${CLAUDE_PLUGIN_ROOT}/node_modules` junction into the persistent data
 * dir does work, but collides with `plugin-auto-update.mjs`, which excludes
 * `node_modules` from its cache copy and then installs into the new version
 * dir: the junction is either not recreated (design defeated) or npm writes
 * THROUGH it and mutates the dependency tree of the still-running previous
 * server process. Per-version `node_modules` in the package root is what
 * both existing provisioning paths already produce, so that is what we
 * repair towards.
 *
 * CONTRACT
 * ------------------------------------------------------------------
 *   - Zero dependencies: node: builtins only (plus `subprocess-env.mjs`,
 *     which is itself builtins-only). This module is imported BEFORE any
 *     dependency is known to exist.
 *   - Never writes to stdout. stdout is the MCP stdio channel; a single
 *     stray byte corrupts the protocol. Diagnostics go to stderr.
 *   - Fast path is free: when the specifiers already resolve, the only
 *     cost is N `import.meta.resolve` calls (no module evaluation).
 *   - `--ignore-scripts` is mandatory, not cosmetic: this package's
 *     lifecycle scripts build Python virtualenvs (see package.json).
 *   - Cross-process safe: an exclusive mkdir lock keeps parallel Claude
 *     Code sessions from running concurrent installs into the same tree.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { subprocessOptions } from './subprocess-env.mjs';

/**
 * The specifiers to probe. These are the exact bare specifiers the startup
 * graph imports STATICALLY — resolving them proves the tree is usable.
 * Sub-path form matters: `@modelcontextprotocol/sdk` has no "." export, so
 * probing the bare package name would throw ERR_PACKAGE_PATH_NOT_EXPORTED
 * even on a healthy install.
 */
export const REQUIRED_SPECIFIERS = [
  '@modelcontextprotocol/sdk/server/index.js',
  'undici',
  'mathml-to-latex',
];

const INSTALL_TIMEOUT_MS = 180_000;
const LOCK_WAIT_MS = 180_000;
const LOCK_POLL_MS = 250;
const LOCK_STALE_MS = 10 * 60_000;

/**
 * Resolve a specifier without evaluating it. Returns true if resolvable.
 *
 * `import.meta.resolve` resolves relative to THIS module's URL, which lives
 * inside the package — so the node_modules walk-up starts at the package
 * root, exactly like the real imports. Node < 20.6 lacks the synchronous
 * form; fall back to probing the package directory on disk.
 */
export function canResolve(specifier, { packageRoot } = {}) {
  try {
    if (typeof import.meta.resolve === 'function') {
      const resolved = import.meta.resolve(specifier);
      // A resolver that returns a promise is the old async form; treat it
      // as unusable and fall through to the filesystem probe.
      if (typeof resolved === 'string') return true;
    }
  } catch {
    return false;
  }
  if (!packageRoot) return false;
  const pkgName = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];
  return fs.existsSync(path.join(packageRoot, 'node_modules', pkgName, 'package.json'));
}

/** Which of REQUIRED_SPECIFIERS cannot be resolved right now. */
export function missingSpecifiers(specifiers, opts) {
  return specifiers.filter((s) => !canResolve(s, opts));
}

function lockPathFor(packageRoot) {
  // Keyed on the package root so two different installs (dev repo + plugin
  // cache) never block each other. Lives in tmp so a read-only package root
  // still reaches the "cannot install" branch with a clear message rather
  // than failing to even take the lock.
  const hash = crypto.createHash('sha256').update(path.resolve(packageRoot)).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), `obsidian-mcp-router-deps-${hash}.lock`);
}

/**
 * Exclusive lock via `mkdir` (atomic on every platform we target).
 * Returns a release function, or null if the lock could not be taken
 * within `waitMs` — in which case the caller re-probes, because the holder
 * has very likely just finished installing on our behalf.
 */
export function acquireLock(lockPath, { waitMs = LOCK_WAIT_MS, pollMs = LOCK_POLL_MS, now = Date.now, sleep = defaultSleep } = {}) {
  const deadline = now() + waitMs;
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      return () => { try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { /* best effort */ } };
    } catch (err) {
      if (err.code !== 'EEXIST') return null;
      // Reap a lock orphaned by a killed process.
      try {
        const age = now() - fs.statSync(lockPath).mtimeMs;
        if (age > LOCK_STALE_MS) {
          fs.rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch { /* raced with the holder releasing it — just retry */ }
      if (now() >= deadline) return null;
      sleep(pollMs);
    }
  }
}

function defaultSleep(ms) {
  // Synchronous sleep: this runs before the server exists, so there is no
  // event loop work to yield to, and Atomics.wait needs no dependency.
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

/** The npm argv. Pinned here so a test can assert the guards are present. */
export const NPM_INSTALL_ARGS = [
  'install',
  '--omit=dev',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
];

/**
 * Run the install. Never inherits stdout (MCP channel) and never runs
 * lifecycle scripts. Returns { ok, stderr }.
 */
export function runInstall(packageRoot, { runner = defaultNpmRunner } = {}) {
  return runner(NPM_INSTALL_ARGS, {
    cwd: packageRoot,
    timeout: INSTALL_TIMEOUT_MS,
    // The child's environment is the `npm` allowlist (subprocess-env.mjs) —
    // npm's own `npm_config_*`, proxies and CA bundles, the profile roots for
    // `.npmrc` and its cache — built by the runner. This used to spread the
    // router's WHOLE process.env here, workspace .env included.
    extraEnv: {
      // Belt-and-braces: even if some future npm honours a lifecycle script
      // despite --ignore-scripts, the Python installers self-skip on this.
      OBSIDIAN_ROUTER_SKIP_MARKITDOWN: '1',
    },
  });
}

function defaultNpmRunner(args, opts) {
  // npm is a shell script on POSIX and a .cmd on Windows; `shell: true`
  // is what makes `npm` resolvable through PATH on both. (Node refuses to
  // spawn a .cmd without a shell since the 2024 argument-injection fix, so
  // dropping the shell is not an option here.)
  const res = spawnSync('npm', args, subprocessOptions('npm', {
    ...opts,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  }));

  // On timeout Node signals only the DIRECT child. With a shell that child
  // is `cmd.exe /c npm …` on Windows, which has no process group to carry
  // the signal onward — so npm keeps running, keeps writing into
  // node_modules, and we would report a clean failure over a tree that is
  // still being mutated. Take the subtree down explicitly.
  const timedOut = res.error && (res.error.code === 'ETIMEDOUT' || res.error.killed === true);
  if (timedOut && res.pid) killProcessTree(res.pid);

  const stderr = [res.stderr, res.stdout].filter(Boolean).join('\n').trim();
  if (res.error) {
    const hint = timedOut ? ` (timed out after ${Math.round((opts.timeout || 0) / 1000)}s)` : '';
    return { ok: false, stderr: `${res.error.message}${hint}\n${stderr}`.trim() };
  }
  return { ok: res.status === 0, stderr };
}

/** Best-effort kill of a child and everything it spawned. Never throws. */
function killProcessTree(pid) {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], subprocessOptions('taskkill', { stdio: 'ignore', shell: false }));
    } else {
      // Negative pid targets the process group the shell child leads.
      try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); }
    }
  } catch { /* the child is already gone, which is the desired state */ }
}

/**
 * Ensure the runtime dependencies resolve, installing them once if not.
 *
 * Returns one of:
 *   { status: 'ok', installed: false }        already usable — the hot path
 *   { status: 'ok', installed: true }         installed successfully
 *   { status: 'failed', missing, reason }     caller should report and exit
 */
export function ensureDependencies({
  packageRoot,
  specifiers = REQUIRED_SPECIFIERS,
  log = () => {},
  install = runInstall,
  lock = acquireLock,
} = {}) {
  let missing = missingSpecifiers(specifiers, { packageRoot });
  if (missing.length === 0) return { status: 'ok', installed: false };

  log(`Dependencies missing (${missing.join(', ')}) — installing into ${packageRoot}. This runs once per version.`);

  const release = lock(lockPathFor(packageRoot));
  if (!release) {
    // Either another process is installing (very likely finished by now) or
    // the lock is unusable. Re-probe before declaring failure.
    missing = missingSpecifiers(specifiers, { packageRoot });
    if (missing.length === 0) return { status: 'ok', installed: true };
    return { status: 'failed', missing, reason: 'another install is in progress and did not finish in time' };
  }

  try {
    // Re-probe under the lock: a process we queued behind may have just
    // done the work, and a second npm install would be pure waste.
    missing = missingSpecifiers(specifiers, { packageRoot });
    if (missing.length === 0) return { status: 'ok', installed: true };

    const res = install(packageRoot);
    missing = missingSpecifiers(specifiers, { packageRoot });
    if (missing.length === 0) return { status: 'ok', installed: true };
    return {
      status: 'failed',
      missing,
      reason: res.ok
        ? 'npm install reported success but the packages still do not resolve'
        : `npm install failed: ${res.stderr || 'no output'}`,
    };
  } finally {
    release();
  }
}

/**
 * Package root, derived from THIS module's own location (<root>/src/helpers/).
 *
 * Deriving it here rather than at the call site is deliberate: `bin/` and
 * `src/helpers/` sit at different depths, so a shared "walk up N levels"
 * helper silently produces the wrong root depending on who calls it — which
 * is exactly the bug this constant replaces (an install was attempted in the
 * parent of the package instead of the package itself, where npm found no
 * package.json, exited 0, and the failure read as "npm reported success").
 */
export const PACKAGE_ROOT = packageRootFrom(import.meta.url);

/** Package root for a module living at <root>/src/helpers/. Exported for tests. */
export function packageRootFrom(moduleUrl) {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), '..', '..');
}

/**
 * The operator-facing message for an unrecoverable dependency failure.
 * Kept here so the CLI stays thin and the wording is testable.
 */
export function formatFailure({ packageRoot, missing, reason }) {
  return [
    'obsidian-mcp-router cannot start: required dependencies are missing.',
    `  Missing: ${missing.join(', ')}`,
    `  Reason:  ${reason}`,
    `  Install root: ${packageRoot}`,
    '',
    'Fix it by installing the dependencies yourself:',
    `  npm install --omit=dev --ignore-scripts --prefix "${packageRoot}"`,
    '',
    'If this is a plugin install, reinstalling the plugin also repairs it.',
  ].join('\n');
}
