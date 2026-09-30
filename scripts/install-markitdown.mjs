#!/usr/bin/env node
/**
 * Postinstall — create a local Python venv at <repo>/.venv and pip-install
 * `markitdown[all]`. Drives the file/URL → markdown conversion exposed by
 * the new MCP tools `pdf_to_markdown`, `docx_to_markdown`, … (v0.11.0).
 *
 * Failure policy: this script NEVER fails the npm install. If Python is
 * missing, or pip can't reach PyPI, we print a clear warning + remediation
 * steps and exit 0. The conversion tools then throw a friendly "markitdown
 * not found" error at call time — better than blocking install on a feature
 * the user might not even use.
 *
 * THE NO-ADMIN ROUTE. On Debian/Ubuntu the system Python ships WITHOUT
 * `ensurepip` unless the `python3.X-venv` package is installed, and installing
 * that package needs sudo. Measured on an Ubuntu VM where the router ran as a
 * user without sudo: `python -m venv` failed ("ensurepip is not available"),
 * and the advice printed then — `pipx install` — named a tool that was not
 * there either. `uv tool install "markitdown[all]"` worked: uv installs into
 * the user's own directories and needs no admin rights. So when the venv
 * cannot get a pip, this script uses uv if it is on the machine, and otherwise
 * prints how to get uv WITHOUT admin rights. It never downloads or executes an
 * installer itself: that is the user's decision to make, and a script run by
 * `npm install` is the wrong place to take it for them.
 *
 * Skipping the install:
 *   - `OBSIDIAN_ROUTER_SKIP_MARKITDOWN=1`     — explicit opt-out
 *   - `npm config get ignore-scripts === true` — caller already disabled scripts
 *
 * Re-running manually:
 *   `node scripts/install-markitdown.mjs`
 *
 * TESTABLE BY IMPORT. The steps live in `installMarkitdown(deps)`, whose every
 * contact with the machine (spawn, executable lookup, filesystem, Python probe,
 * output) is injectable; running the file directly calls it with the real ones.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fsDefault from 'node:fs';

import {
  findPythonDetailed, isRunnableFile, removalInstruction, findExecutableOnPath,
} from '../src/helpers/conversion-readiness.mjs';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_VENV_DIR = path.join(REPO_ROOT, '.venv');

/** What `uv tool install` / pipx is asked for — the same package the venv gets. */
export const MARKITDOWN_SPEC = 'markitdown[all]';

/**
 * `python -m venv` failing because the interpreter has no `ensurepip` — the
 * Debian/Ubuntu `python3.X-venv` package is missing. Both the Debian patch's
 * own sentence and the package name it tells you to install are matched, so
 * a rewording of one still leaves the other.
 */
export const ENSUREPIP_MISSING = /ensurepip is not available|No module named ensurepip|python3(?:\.\d+)?-venv/i;

/**
 * Where `uv tool install` puts executables, in uv's own precedence
 * (https://docs.astral.sh/uv/reference/storage/ — "Tool executables"):
 * UV_TOOL_BIN_DIR, then XDG_BIN_HOME, then XDG_DATA_HOME/../bin, then
 * ~/.local/bin (%USERPROFILE%\.local\bin on Windows). The standalone uv
 * installer puts `uv` itself in the same directory, which a fresh shell may
 * not yet have on PATH — so it is also where `uv` is looked for.
 */
export function uvExecutableDir(env = process.env, isWin = process.platform === 'win32') {
  const set = (v) => typeof v === 'string' && v.trim() !== '';
  if (set(env.UV_TOOL_BIN_DIR)) return env.UV_TOOL_BIN_DIR;
  if (set(env.XDG_BIN_HOME)) return env.XDG_BIN_HOME;
  if (set(env.XDG_DATA_HOME)) return path.join(env.XDG_DATA_HOME, '..', 'bin');
  const home = isWin ? (env.USERPROFILE || env.HOME) : (env.HOME || env.USERPROFILE);
  return path.join(home || os.homedir(), '.local', 'bin');
}

/**
 * The no-admin advice, with only the tools that are ACTUALLY here named as
 * ready to use. pipx is kept as a secondary route when it is present; it is
 * never recommended blind again — that is the advice that failed on the VM.
 */
export function noAdminAdvice({ uv = null, pipx = null, isWin = process.platform === 'win32' } = {}) {
  const lines = [];
  if (uv) {
    lines.push(`  uv is available (${uv}): uv tool install "${MARKITDOWN_SPEC}"`);
  } else {
    lines.push('  Get uv first — it installs into your own user directories, no admin rights needed:');
    lines.push(isWin
      ? '    powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"'
      : '    curl -LsSf https://astral.sh/uv/install.sh | sh');
    lines.push('  (the official installer from https://docs.astral.sh/uv/getting-started/installation/ — read it before you run it)');
    lines.push(`  then, in a new shell: uv tool install "${MARKITDOWN_SPEC}"`);
    lines.push('  and re-run this script, or set MARKITDOWN_PATH to the markitdown it installed.');
  }
  if (pipx) lines.push(`  Alternatively, pipx is available (${pipx}): pipx install "${MARKITDOWN_SPEC}"`);
  return lines.join('\n');
}

/**
 * Run a child process and stream its output to the parent. stderr is ALSO
 * kept (its last 4 KB): the venv step has to read Debian's "ensurepip is not
 * available" to know which route to offer. Resolves `{stderr}` on exit code 0,
 * rejects with an Error carrying `.exitCode` and `.stderr` otherwise.
 */
function runStreamed(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['inherit', 'inherit', 'pipe'], ...opts });
    let tail = '';
    child.stderr?.on('data', (chunk) => {
      process.stderr.write(chunk);
      tail = (tail + chunk.toString()).slice(-4096);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stderr: tail });
      else reject(Object.assign(new Error(`${cmd} exited with code ${code}`), { exitCode: code, stderr: tail }));
    });
  });
}

/**
 * Resolve a Python interpreter — ONE DEFINITION, in
 * `src/helpers/conversion-readiness.mjs`.
 *
 * This function used to live here and was copied into `install-docling.mjs`
 * ("same logic as install-markitdown.mjs", said its comment). The runtime error
 * path needed it too, and a third copy is how a rule ends up fixed in one place
 * and stale in the others — the defect class this repo keeps sweeping. The
 * helper depends only on node builtins, so importing it costs this script
 * nothing it did not already have.
 */
async function findPythonDefault(warn) {
  const r = await findPythonDetailed({ execFile: execFileAsync });
  // The "found 3.9, needs 3.10+" line the local copy used to print. Losing it
  // would have told a user with only Python 3.9 that NO Python was found —
  // true of nothing, and it hides the one action that would fix their machine.
  for (const { cmd, version } of r.rejected) {
    warn(`Found ${cmd} ${version} — markitdown needs Python 3.10+.`);
  }
  // The FULL result travels, not a `{cmd, version} | null` that collapses "too
  // old" and "could not look" into the same nothing. `checked` is the field
  // that separates "we asked and nothing suitable answered" from "we never got
  // an answer at all", and the caller prints a different sentence for each.
  return r;
}

/**
 * The installer. Returns what it did, as one word, so a test can assert the
 * ROUTE taken rather than grep the output:
 *   skipped · present · broken-venv · no-python · venv-failed ·
 *   installed-venv · pip-failed · installed-uv · uv-failed · no-uv
 *
 * @param {{env?: object, venvDir?: string, isWin?: boolean, fs?: object,
 *          run?: Function, findPython?: Function, findExe?: Function,
 *          log?: Function, warn?: Function}} [deps]
 */
export async function installMarkitdown(deps = {}) {
  const env = deps.env || process.env;
  const VENV_DIR = deps.venvDir || DEFAULT_VENV_DIR;
  const IS_WIN = typeof deps.isWin === 'boolean' ? deps.isWin : process.platform === 'win32';
  const fs = deps.fs || fsDefault;
  const run = deps.run || runStreamed;
  // Prefix every line so the noise stands out among `npm install` output.
  const log = deps.log || ((msg) => console.log(`[install-markitdown] ${msg}`));
  const warn = deps.warn || ((msg) => console.warn(`[install-markitdown] ${msg}`));
  const findPython = deps.findPython || (() => findPythonDefault(warn));
  // Spawn-free lookup: the bounded PATH scan the readiness probe uses, then —
  // for uv only — the directory uv's installer writes to, which a shell opened
  // before the install does not have on PATH yet.
  const findExe = deps.findExe || ((name) => {
    const onPath = findExecutableOnPath(name, { env, fs });
    if (onPath || name !== 'uv') return onPath;
    const candidate = path.join(uvExecutableDir(env, IS_WIN), `uv${IS_WIN ? '.exe' : ''}`);
    return isRunnableFile(candidate, fs) ? candidate : null;
  });
  const exeName = (n) => `${n}${IS_WIN ? '.exe' : ''}`;

  if (env.OBSIDIAN_ROUTER_SKIP_MARKITDOWN === '1') {
    log('Skipped via OBSIDIAN_ROUTER_SKIP_MARKITDOWN=1.');
    return 'skipped';
  }

  /** The no-admin route: uv if it is here, otherwise how to get it. */
  async function viaUv(reason) {
    const uv = findExe('uv');
    const pipx = findExe('pipx');
    if (!uv) {
      warn(
        `${reason} The venv route cannot work here without admin rights (the distribution's `
          + 'python3-venv package is missing, and installing it needs sudo). No `uv` was found either.\n'
          + noAdminAdvice({ uv: null, pipx, isWin: IS_WIN }),
      );
      return 'no-uv';
    }
    log(`${reason} Installing with uv instead — no admin rights needed: uv tool install "${MARKITDOWN_SPEC}"`);
    try {
      await run(uv, ['tool', 'install', MARKITDOWN_SPEC]);
    } catch (e) {
      warn(`uv tool install failed (${e.message}).\n${noAdminAdvice({ uv, pipx, isWin: IS_WIN })}`);
      return 'uv-failed';
    }
    const binDir = uvExecutableDir(env, IS_WIN);
    const exe = path.join(binDir, exeName('markitdown'));
    if (!isRunnableFile(exe, fs)) {
      warn(
        `uv reported success, but no markitdown was found at ${exe} (uv's default tool directory). `
          + 'Run `uv tool dir --bin` to see where it went, then set MARKITDOWN_PATH to the markitdown there.',
      );
      return 'installed-uv';
    }
    log(`Done. markitdown is at ${exe} (installed by uv).`);
    const onPath = findExecutableOnPath('markitdown', { env, fs });
    if (onPath) {
      log(`It is on this shell's PATH (${onPath}). If the MCP host starts the router with a different PATH, set MARKITDOWN_PATH=${exe} in the server declaration.`);
    } else {
      warn(
        `${binDir} is not on PATH, so the router will not find markitdown by name. Either set `
          + `MARKITDOWN_PATH=${exe} in the MCP server declaration, or run \`uv tool update-shell\` and restart the host.`,
      );
    }
    return 'installed-uv';
  }

  // 0. Already installed?
  const venvMarker = path.join(
    VENV_DIR,
    IS_WIN ? 'Scripts' : 'bin',
    exeName('markitdown'),
  );
  // "Present" must mean the same thing here as it does to the readiness probe
  // and to the runtime — RUNNABLE, not merely existing. With `existsSync`, a
  // venv left as a directory or a non-executable file by an interrupted install
  // put the user in a loop with no exit: the probe said "run the installer",
  // and the installer said "already present" and did nothing.
  if (isRunnableFile(venvMarker, fs)) {
    log(`markitdown already present at ${venvMarker} — skipping reinstall.`);
    return 'present';
  }
  if (fs.existsSync(venvMarker)) {
    // SAY IT AND STOP — do not pretend to repair it. Running `python -m venv`
    // over the existing tree does not remove whatever is sitting at the marker,
    // so pip then fails trying to write its entry point there and the next run
    // repeats the whole thing: the same loop with no exit, one step further
    // along. Deleting inside someone's `.venv` is also not this script's call.
    warn(
      `${venvMarker} exists but cannot be run (a directory, or missing its execute bit). ` +
        `Re-running the installer will NOT fix that — it cannot replace what is already there. ` +
        `Remove the broken venv and run this script again.\n` +
        removalInstruction(VENV_DIR),
    );
    return 'broken-venv';
  }

  // 1. Find a usable Python.
  const py = await findPython();
  if (!py.ok) {
    // WHICH problem, not just "no". A permission error or a hung shim means we
    // never got to look — saying "no Python found on PATH" there states a fact
    // about the user's machine that was never established.
    const diagnosis = py.checked
      ? 'No Python 3.10+ found on PATH.'
      : 'Could NOT determine whether Python 3.10+ is available here (nothing answered '
        + '— a permission error, a timeout, or a broken shim). If it IS installed, re-run this script.';
    warn(
      `${diagnosis} The conversion tools (pdf_to_markdown, ` +
        'docx_to_markdown, image_to_markdown, audio_to_markdown, …) will fail at ' +
        'call time until you either install Python and re-run ' +
        '`node scripts/install-markitdown.mjs`, or install markitdown on its own and ' +
        'set MARKITDOWN_PATH (uv brings its own Python, no admin rights needed):\n' +
        noAdminAdvice({ uv: findExe('uv'), pipx: findExe('pipx'), isWin: IS_WIN }) + '\n' +
        'The rest of the router (vault routing, search, write_file, …) works without Python.',
    );
    return 'no-python';
  }
  log(`Using ${py.cmd} ${py.version}.`);

  // 2. Create the venv.
  try {
    log(`Creating venv at ${VENV_DIR}…`);
    await run(py.cmd, ['-m', 'venv', VENV_DIR]);
  } catch (e) {
    if (ENSUREPIP_MISSING.test(String(e?.stderr || ''))) {
      return viaUv(`${py.cmd} cannot create a venv with pip: ensurepip is not available.`);
    }
    warn(
      `venv creation failed (${e.message}). Falling back to bare \`markitdown\` on ` +
        `PATH at runtime. To enable the conversion tools without a venv:\n` +
        noAdminAdvice({ uv: findExe('uv'), pipx: findExe('pipx'), isWin: IS_WIN }),
    );
    return 'venv-failed';
  }

  // 3. Resolve venv pip.
  const venvPip = path.join(
    VENV_DIR,
    IS_WIN ? 'Scripts' : 'bin',
    exeName('pip'),
  );
  if (!fs.existsSync(venvPip)) {
    // The same machine, one step later: some Pythons create the venv and
    // simply leave pip out when ensurepip is missing. Same answer.
    return viaUv(`The venv at ${VENV_DIR} was created without pip (no ensurepip in ${py.cmd}).`);
  }

  // 4. Install markitdown[all].
  try {
    log('Installing markitdown[all] (~150 MB, this may take a minute)…');
    await run(venvPip, [
      'install',
      '--quiet',
      '--disable-pip-version-check',
      'markitdown[all]>=0.1.5',
    ]);
    log(`Done. markitdown is at ${venvMarker}.`);
    return 'installed-venv';
  } catch (e) {
    warn(
      `pip install failed (${e.message}). Conversion tools will fail until you ` +
        `re-run \`node scripts/install-markitdown.mjs\`, or set MARKITDOWN_PATH ` +
        `to an external install.`,
    );
    return 'pip-failed';
  }
}

/** Run directly (`node scripts/install-markitdown.mjs`, or `npm run install-markitdown`)? */
function isMain() {
  try {
    const a = process.argv[1] ? path.resolve(process.argv[1]) : '';
    const b = path.resolve(__filename);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

if (isMain()) {
  // Never fail the parent `npm install` — wrap the whole thing.
  installMarkitdown().catch((e) => {
    console.warn(`[install-markitdown] Unexpected error: ${e?.message ?? e}. Skipping markitdown install.`);
    process.exit(0);
  });
}
