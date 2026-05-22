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
 * Resolve a Python interpreter. Tries `python3` first (POSIX convention),
 * then `python` (Windows + some Linux distros that aliased python3→python).
 * Returns null when neither is found — the script bails gracefully in that
 * case.
 */
async function findPython() {
  for (const candidate of ['python3', 'python']) {
    try {
      const { stdout } = await execFileAsync(candidate, ['--version']);
      // Sanity: must be Python 3.10+ for markitdown[all] to install.
      // Match both `python --version` (writes to stdout on 3.4+) and the
      // older `python -V` form that wrote to stderr on Python 2 — execFile
      // only captures stdout here, but Python 3 always uses stdout for
      // `--version`, so this is fine.
      const m = stdout.match(/Python (\d+)\.(\d+)/);
      if (m) {
        const major = parseInt(m[1], 10);
        const minor = parseInt(m[2], 10);
        // Accept 3.10+ on the 3.x line OR any future 4.x+ (avoids rejecting
        // Python 4.0 the day it ships just because `minor < 10`).
        if ((major === 3 && minor >= 10) || major > 3) {
          return { cmd: candidate, version: `${major}.${minor}` };
        }
        warn(`Found ${candidate} ${major}.${minor} — markitdown needs Python 3.10+.`);
      }
    } catch {
      // Not on PATH — try the next candidate.
    }
  }
  return null;
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
  if (fs.existsSync(venvMarker)) {
    log(`markitdown already present at ${venvMarker} — skipping reinstall.`);
    return;
  }

  // 1. Find a usable Python.
  const py = await findPython();
  if (!py) {
    warn(
      'No Python 3.10+ found on PATH. The conversion tools (pdf_to_markdown, ' +
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
