/**
 * Docling subprocess wrapper — opt-in high-fidelity PDF → markdown.
 *
 * Mirrors src/markdownify/markitdown.mjs (same spirit: shell out to a Python
 * CLI, talk pure argv/stdout, no Python embedding). Simpler because the tool
 * is file-input only (no URL path → no safeFetch / SSRF guard). The output
 * size is still capped at MAX_OUTPUT_BYTES — Docling writes the markdown to
 * disk, so that ceiling is enforced on the file in readProducedMarkdown (the
 * subprocess `maxBuffer` alone only bounds stderr chatter).
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
import { subprocessOptions } from '../helpers/subprocess-env.mjs';

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
 *
 * `--image-export-mode placeholder` keeps figures OUT of the markdown. Docling's
 * default (`embedded`) inlines every picture as a base64 data-URI, which on an
 * illustrated PDF dwarfs the actual text — observed: a 4-page course sheet →
 * 3.3 MB output, 99.6% of it base64, for ~14 KB of real text — and can blow the
 * MAX_OUTPUT_BYTES cap for no readable gain. `placeholder` emits a
 * `<!-- image -->` marker at each figure's position instead: text-only,
 * vault-friendly output. (Externalizing images as files would need `referenced`
 * mode + persisting the output dir, which the single-file read-back does not do.)
 */
export function buildDoclingArgs(outDir, filePath) {
  return ['--to', 'md', '--image-export-mode', 'placeholder', '--output', outDir, '--', filePath];
}

/**
 * Read the single markdown file Docling produced into `outDir`, enforcing the
 * output ceiling. Docling writes `<stem>.md` to DISK (not stdout), so the
 * `maxBuffer` on the subprocess only caps stderr — the real payload is capped
 * HERE, before it is read into memory (an unbounded `readFileSync` would defeat
 * the intended MAX_OUTPUT_BYTES ceiling on a huge/complex PDF). `fsDeps` is an
 * injection seam for unit tests. Three refusals, all consistent with the repo's
 * "no silent fallback" discipline:
 *
 *   - 0 `.md` produced        → the conversion silently failed; throw.
 *   - >1 `.md` produced       → ambiguous (a companion file); refuse rather
 *                               than silently return an arbitrary one.
 *   - file > MAX_OUTPUT_BYTES → refuse before the unbounded read.
 */
export function readProducedMarkdown(outDir, fsDeps = fs) {
  const produced = fsDeps
    .readdirSync(outDir)
    .filter((f) => f.toLowerCase().endsWith('.md'));
  if (produced.length === 0) {
    throw new Error('docling produced no markdown output');
  }
  if (produced.length > 1) {
    throw new Error(
      `docling produced ${produced.length} markdown files (expected exactly 1): ${produced.join(', ')}`,
    );
  }
  const outPath = path.join(outDir, produced[0]);
  const { size } = fsDeps.statSync(outPath);
  if (size > MAX_OUTPUT_BYTES) {
    throw new Error(
      `docling output (${size} bytes) exceeds the ${MAX_OUTPUT_BYTES}-byte cap.`,
    );
  }
  return fsDeps.readFileSync(outPath, 'utf-8');
}

/**
 * Default runner: docling writes `<stem>.md` into a private temp dir; we read
 * the single produced `.md` back (capped — see readProducedMarkdown) and clean
 * up. This avoids depending on any stdout-streaming flag (version-dependent).
 */
async function defaultRun(doclingPath, filePath) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docling-'));
  try {
    // `outDir` doubles as the working directory (private, ours, removed in
    // `finally`), and the environment is Docling's allowlist — Python basics,
    // the model-cache variables (HF_HOME and friends), proxies — never the
    // router's process.env (subprocess-env.mjs). `path.resolve` keeps a
    // relative `filePath` anchored to the router's cwd, as before.
    await execFileAsync(doclingPath, buildDoclingArgs(outDir, path.resolve(filePath)), subprocessOptions('docling', {
      cwd: outDir,
      maxBuffer: MAX_OUTPUT_BYTES,
    }));
    return readProducedMarkdown(outDir);
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
