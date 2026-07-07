/**
 * Docling subprocess wrapper — opt-in high-fidelity PDF → markdown.
 *
 * Mirrors src/markdownify/markitdown.mjs (same spirit: shell out to a Python
 * CLI, talk pure argv/stdout, no Python embedding). Simpler because the tool
 * is file-input only (no URL path → no safeFetch / SSRF guard / streaming cap).
 *
 * Docling's standard pipeline (layout detection + TableFormer table-structure
 * recognition) reconstructs tables and reading order that MarkItDown's
 * pdfminer.six backend loses — at ~10x the CPU cost. It is installed into a
 * SEPARATE `.venv-docling` only when the user opts in
 * (OBSIDIAN_ROUTER_ENABLE_DOCLING=1); see scripts/install-docling.mjs.
 *
 * `run` is an injectable seam (mirrors the `_deps` pattern of youtubeToMarkdown)
 * so the happy path is unit-testable without a ~1-2 GB Docling install.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { expandHome, assertPathAllowed, resolveDoclingPath } from './utils.mjs';

const execFileAsync = promisify(execFile);

// Docling markdown output is text — 50 MB is a generous ceiling, matching the
// markitdown wrapper's subprocess cap.
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;

// Project root = two levels up (src/markdownify/docling.mjs). Locates the
// bundled `.venv-docling/bin/docling`.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Build the docling argv. `outDir` is our own mkdtemp path (not user
 * controlled). The `--` separator stops Docling's Typer/Click parser from
 * reading a `filePath` that begins with `-` (e.g. `--version`) as an option —
 * same guard as runMarkitdown. `filePath` is the only user-controlled value
 * and it sits AFTER `--`.
 */
export function buildDoclingArgs(outDir, filePath) {
  return ['--to', 'md', '--output', outDir, '--', filePath];
}

/**
 * Default runner: docling writes `<stem>.md` into a private temp dir; we read
 * the single produced `.md` back and clean up. This avoids depending on any
 * stdout-streaming flag (whose availability is version-dependent).
 */
async function defaultRun(doclingPath, filePath) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docling-'));
  try {
    await execFileAsync(doclingPath, buildDoclingArgs(outDir, filePath), {
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    const produced = fs.readdirSync(outDir).filter((f) => f.toLowerCase().endsWith('.md'));
    if (produced.length === 0) {
      throw new Error('docling produced no markdown output');
    }
    return fs.readFileSync(path.join(outDir, produced[0]), 'utf-8');
  } finally {
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Convert a local PDF to markdown via Docling. Returns `{ text }` on success.
 * Throws a wrapped Error safe to forward to the MCP client.
 */
export async function toMarkdownDocling({ filePath, projectRoot = DEFAULT_PROJECT_ROOT, run } = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('Missing required argument: filepath');
  }
  const expanded = expandHome(filePath);
  assertPathAllowed(expanded);
  const doclingPath = resolveDoclingPath(projectRoot);
  const exec = run || defaultRun;
  try {
    const text = await exec(doclingPath, expanded);
    return { text };
  } catch (e) {
    if (e?.code === 'ENOENT') {
      throw new Error(
        `docling executable not found (looked up "${doclingPath}"). Docling is an ` +
          `opt-in extra: set OBSIDIAN_ROUTER_ENABLE_DOCLING=1 and re-run ` +
          `\`npm run install-docling\`, or set DOCLING_PATH to an existing install.`,
      );
    }
    throw new Error(`Error processing to Markdown (docling): ${e?.message ?? 'Unknown error'}`);
  }
}
