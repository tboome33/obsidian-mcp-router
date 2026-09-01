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
 * Skipping the install:
 *   - `OBSIDIAN_ROUTER_SKIP_MARKITDOWN=1`     — explicit opt-out
 *   - `npm config get ignore-scripts === true` — caller already disabled scripts
 *
 * Re-running manually:
 *   `node scripts/install-markitdown.mjs`
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

import {
  findPythonDetailed, isRunnableFile, removalInstruction,
} from '../src/helpers/conversion-readiness.mjs';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const VENV_DIR = path.join(REPO_ROOT, '.venv');
const IS_WIN = process.platform === 'win32';

function log(msg) {
  // Prefix every line so the noise stands out among `npm install` output.
  console.log(`[install-markitdown] ${msg}`);
}

function warn(msg) {
  console.warn(`[install-markitdown] ${msg}`);
}

if (process.env.OBSIDIAN_ROUTER_SKIP_MARKITDOWN === '1') {
  log('Skipped via OBSIDIAN_ROUTER_SKIP_MARKITDOWN=1.');
  process.exit(0);
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
async function findPython() {
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
 * Run a child process and stream its stdout/stderr to the parent. Resolves
 * on exit code 0, rejects with a captured-tail-of-stderr otherwise.
 */
function runStreamed(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

async function main() {
  // 0. Already installed?
  const venvMarker = path.join(
    VENV_DIR,
    IS_WIN ? 'Scripts' : 'bin',
    `markitdown${IS_WIN ? '.exe' : ''}`,
  );
  // "Present" must mean the same thing here as it does to the readiness probe
  // and to the runtime — RUNNABLE, not merely existing. With `existsSync`, a
  // venv left as a directory or a non-executable file by an interrupted install
  // put the user in a loop with no exit: the probe said "run the installer",
  // and the installer said "already present" and did nothing.
  if (isRunnableFile(venvMarker, fs)) {
    log(`markitdown already present at ${venvMarker} — skipping reinstall.`);
    return;
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
    return;
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
        '`node scripts/install-markitdown.mjs`, or `pipx install "markitdown[all]"` ' +
        'and set MARKITDOWN_PATH. The rest of the router (vault routing, search, ' +
        'write_file, …) works without Python.',
    );
    return;
  }
  log(`Using ${py.cmd} ${py.version}.`);

  // 2. Create the venv.
  try {
    log(`Creating venv at ${VENV_DIR}…`);
    await runStreamed(py.cmd, ['-m', 'venv', VENV_DIR]);
  } catch (e) {
    warn(
      `venv creation failed (${e.message}). Falling back to bare \`markitdown\` on ` +
        `PATH at runtime. Install manually with \`pipx install "markitdown[all]"\` to ` +
        `enable conversion tools.`,
    );
    return;
  }

  // 3. Resolve venv pip.
  const venvPip = path.join(
    VENV_DIR,
    IS_WIN ? 'Scripts' : 'bin',
    `pip${IS_WIN ? '.exe' : ''}`,
  );
  if (!fs.existsSync(venvPip)) {
    warn(`pip not found inside venv at ${venvPip}. Bailing.`);
    return;
  }

  // 4. Install markitdown[all].
  try {
    log('Installing markitdown[all] (~150 MB, this may take a minute)…');
    await runStreamed(venvPip, [
      'install',
      '--quiet',
      '--disable-pip-version-check',
      'markitdown[all]>=0.1.5',
    ]);
    log(`Done. markitdown is at ${venvMarker}.`);
  } catch (e) {
    warn(
      `pip install failed (${e.message}). Conversion tools will fail until you ` +
        `re-run \`node scripts/install-markitdown.mjs\`, or set MARKITDOWN_PATH ` +
        `to an external install.`,
    );
  }
}

// Never fail the parent `npm install` — wrap the whole thing.
main().catch((e) => {
  warn(`Unexpected error: ${e?.message ?? e}. Skipping markitdown install.`);
  process.exit(0);
});
