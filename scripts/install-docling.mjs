#!/usr/bin/env node
/**
 * Postinstall (OPT-IN) — create a local Python venv at <repo>/.venv-docling
 * and pip-install `docling`, the high-fidelity PDF backend behind the
 * `pdf_to_markdown_docling` MCP tool.
 *
 * OPT-IN, unlike markitdown: Docling pulls ~1-2 GB of torch/onnxruntime + model
 * weights, so this script is a NO-OP unless `OBSIDIAN_ROUTER_ENABLE_DOCLING=1`
 * is set BEFORE `npm install`. Re-run manually: `npm run install-docling`
 * (with the env var set).
 *
 * Failure policy (same as install-markitdown.mjs): NEVER fail the npm install.
 * On any error we print a warning and exit 0. `pdf_to_markdown_docling` then
 * throws a friendly "not installed" error at call time.
 *
 * Standard pipeline only — plain `docling`, no `[vlm]`/`[asr]` extras.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

import {
  findPythonDetailed, isRunnableFile, removalInstruction,
} from '../src/helpers/conversion-readiness.mjs';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const VENV_DIR = path.join(REPO_ROOT, '.venv-docling');
const IS_WIN = process.platform === 'win32';

function log(msg) {
  console.log(`[install-docling] ${msg}`);
}

function warn(msg) {
  console.warn(`[install-docling] ${msg}`);
}

/**
 * Opt-in gate. Exactly the string '1' enables the install — any other value
 * (including 'true', '0', '') is a no-op. Exported so tests can assert it
 * without triggering a real install.
 */
export function doclingOptedIn(env = process.env) {
  return env.OBSIDIAN_ROUTER_ENABLE_DOCLING === '1';
}

/**
 * Resolve a Python interpreter (3.10+) — ONE DEFINITION, in
 * `src/helpers/conversion-readiness.mjs`.
 *
 * The comment that used to sit here said "same logic as install-markitdown.mjs",
 * which is a copy admitting it is one. Both installers and the runtime error
 * path now call the same function.
 */
async function findPython() {
  const r = await findPythonDetailed({ execFile: execFileAsync });
  // Same warning the local copy printed — see install-markitdown.mjs.
  for (const { cmd, version } of r.rejected) {
    warn(`Found ${cmd} ${version} — docling needs Python 3.10+.`);
  }
  // The full result travels — `checked` separates "nothing suitable answered"
  // from "we never got an answer". See install-markitdown.mjs.
  return r;
}

/**
 * Run a child process, streaming stdio to the parent. Resolves on exit 0,
 * rejects otherwise. (Same helper as install-markitdown.mjs.)
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
  // 0. Opt-in gate — the ONLY difference from install-markitdown.mjs's flow.
  if (!doclingOptedIn()) {
    log(
      'Docling is opt-in and not enabled — skipping. Set ' +
        'OBSIDIAN_ROUTER_ENABLE_DOCLING=1 before install (or before ' +
        '`npm run install-docling`) to enable the pdf_to_markdown_docling backend.',
    );
    return;
  }

  // 1. Already installed?
  const venvMarker = path.join(
    VENV_DIR,
    IS_WIN ? 'Scripts' : 'bin',
    `docling${IS_WIN ? '.exe' : ''}`,
  );
  // RUNNABLE, not merely existing — same reason as install-markitdown.mjs: an
  // "already present" that is not runnable is a loop with no exit.
  if (isRunnableFile(venvMarker, fs)) {
    log(`docling already present at ${venvMarker} — skipping reinstall.`);
    return;
  }
  if (fs.existsSync(venvMarker)) {
    // Say it and stop — see install-markitdown.mjs: re-running cannot replace
    // what is already at the marker, and deleting inside a user's venv is not
    // this script's call.
    warn(
      `${venvMarker} exists but cannot be run (a directory, or missing its execute bit). ` +
        `Re-running this script will NOT fix that. Remove the broken venv and run it again.\n` +
        removalInstruction(VENV_DIR),
    );
    return;
  }

  // 2. Find a usable Python.
  const py = await findPython();
  if (!py.ok) {
    // WHICH problem — see install-markitdown.mjs for why "no Python found" is
    // the wrong sentence when nothing ever answered.
    const diagnosis = py.checked
      ? 'No Python 3.10+ found on PATH.'
      : 'Could NOT determine whether Python 3.10+ is available here (nothing answered '
        + '— a permission error, a timeout, or a broken shim). If it IS installed, re-run this script.';
    warn(
      `${diagnosis} \`pdf_to_markdown_docling\` will fail at ` +
        'call time until you install Python and re-run `npm run install-docling`, ' +
        'or `pipx install docling` and set DOCLING_PATH. The rest of the router ' +
        '(and pdf_to_markdown via MarkItDown) works without it.',
    );
    return;
  }
  log(`Using ${py.cmd} ${py.version}.`);

  // 3. Create the venv.
  try {
    log(`Creating venv at ${VENV_DIR}…`);
    await runStreamed(py.cmd, ['-m', 'venv', VENV_DIR]);
  } catch (e) {
    warn(
      `venv creation failed (${e.message}). Install manually with ` +
        `\`pipx install docling\` and set DOCLING_PATH to enable the tool.`,
    );
    return;
  }

  // 4. Resolve venv pip.
  const venvPip = path.join(
    VENV_DIR,
    IS_WIN ? 'Scripts' : 'bin',
    `pip${IS_WIN ? '.exe' : ''}`,
  );
  if (!fs.existsSync(venvPip)) {
    warn(`pip not found inside venv at ${venvPip}. Bailing.`);
    return;
  }

  // 5. Install docling (standard pipeline only — no [vlm]/[asr] extras).
  try {
    log('Installing docling (~1-2 GB incl. torch/onnxruntime + models — this can take several minutes)…');
    await runStreamed(venvPip, [
      'install',
      '--quiet',
      '--disable-pip-version-check',
      'docling',
    ]);
    log(`Done. docling is at ${venvMarker}.`);
  } catch (e) {
    warn(
      `pip install failed (${e.message}). \`pdf_to_markdown_docling\` will fail ` +
        `until you re-run \`npm run install-docling\`, or set DOCLING_PATH.`,
    );
  }
}

// Only auto-run when invoked as a script (npm postinstall / `npm run
// install-docling`). Importing this module (e.g. from a test) must NOT trigger
// an install.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    warn(`Unexpected error: ${e?.message ?? e}. Skipping docling install.`);
    process.exit(0);
  });
}
