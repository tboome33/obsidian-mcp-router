/**
 * PDF → image renderer — opt-in visual PDF pages, returned as MCP image
 * content blocks so the model can SEE a page (not just read its text).
 *
 * Mirrors src/markdownify/docling.mjs (same spirit: shell out to a Python
 * CLI, talk pure argv/stdout, no Python embedding). Rendering itself is done
 * by `scripts/render-pdf-images.py` via **pypdfium2 + Pillow** — NOT poppler.
 * Both ship inside the SAME opt-in `.venv-docling` that Docling installs
 * (OBSIDIAN_ROUTER_ENABLE_DOCLING=1 → `npm run install-docling`), because
 * Docling already depends on pypdfium2 for its own page rasterization. This
 * tool piggybacks on that venv rather than requiring a third one.
 *
 * The output is IMAGE bytes, not text — base64 PNGs are far more expensive
 * per page than markdown text (this is the same "base64 bloat" lesson that
 * drove Docling's `--image-export-mode placeholder` default: see docling.mjs
 * for the 4-page-course-sheet/3.3MB anecdote). Since here the whole POINT is
 * to return images, we can't dodge the cost the way Docling does — instead
 * we bound it with hard page-count and per/total-byte caps (below) so a
 * request can't accidentally ship dozens of megabytes of base64 into the
 * model's context.
 *
 * `run` is an injectable seam (mirrors the `_deps` pattern used throughout
 * the router) so the happy path is unit-testable without a real Python +
 * pypdfium2 install.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { expandHome, assertPathAllowed } from './utils.mjs';

const execFileAsync = promisify(execFile);

/* ---------------------------------------------------------------------- *
 * Caps — all of these exist to bound TOKEN cost, not just wall-clock time.
 * Every rendered page becomes a base64 image block in the tool result, and
 * that gets billed against the model's context on every single page. A
 * "give me the whole PDF" request without these caps could silently ship
 * tens of megabytes of base64 image data in one tool call.
 * ---------------------------------------------------------------------- */

// Default page budget when the caller doesn't specify `max_pages`. Generous
// enough for "show me this chapter" without being the whole-document case.
export const MAX_PAGES_DEFAULT = 8;

// Hard ceiling — even an explicit `max_pages: 999` is clamped down to this.
// Rendering (and shipping) more than this many pages in one call is almost
// always a sign the caller wants pdf_to_markdown(_docling) instead (text is
// far cheaper than images for anything but "let me actually look at it").
export const MAX_PAGES_CEILING = 30;

// Render scale defaults to ~144 DPI equivalent (2.0 × the PDF's 72-DPI
// canvas unit) — legible for a model to read on-page text/diagrams without
// the pixel dimensions (and therefore base64 size) exploding.
export const DEFAULT_SCALE = 2.0;
export const SCALE_MIN = 0.5;
export const SCALE_MAX = 4.0;

// Per-image and cumulative byte ceilings on the RAW PNG (before base64,
// which inflates it further by ~4/3). Enforced in readProducedImages BEFORE
// each file is read into memory, mirroring readProducedMarkdown's
// refuse-before-unbounded-read discipline in docling.mjs.
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 24 * 1024 * 1024;

// Project root = two levels up (src/markdownify/pdf-images.mjs). Locates the
// bundled `.venv-docling` (shared with Docling) and the co-located render
// script under `scripts/`.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Resolve the absolute path to a Python interpreter capable of importing
 * pypdfium2 + Pillow. Priority, mirroring `resolveDoclingPath` /
 * `resolveMarkitdownPath` in utils.mjs:
 *
 *   1. `PDF_IMAGES_PYTHON` env var — explicit override.
 *   2. `<projectRoot>/.venv-docling/{Scripts/python.exe | bin/python}` — the
 *      Docling opt-in venv, which already carries pypdfium2 (Docling's own
 *      page-rasterization dependency) + Pillow as transitive deps. This is
 *      the expected common case: a user who ran `npm run install-docling`
 *      gets `pdf_to_images` "for free".
 *   3. `<projectRoot>/.venv/{Scripts/python.exe | bin/python}` — the
 *      markitdown venv, in case a user pip-installed pypdfium2/Pillow there
 *      instead of provisioning the (heavier) Docling extra.
 *   4. Bare `python3` (POSIX) / `python` (Windows) — PATH lookup. Fails with
 *      ENOENT (or a ModuleNotFoundError from stderr) at call time if neither
 *      package is importable, surfaced as an actionable hint by `pdfToImages`.
 */
export function resolvePdfImagesPython(projectRoot) {
  if (process.env.PDF_IMAGES_PYTHON) return process.env.PDF_IMAGES_PYTHON;
  const isWin = process.platform === 'win32';
  const binDir = isWin ? 'Scripts' : 'bin';
  const exe = isWin ? 'python.exe' : 'python';

  const doclingVenv = path.join(projectRoot, '.venv-docling', binDir, exe);
  if (fs.existsSync(doclingVenv)) return doclingVenv;

  const markitdownVenv = path.join(projectRoot, '.venv', binDir, exe);
  if (fs.existsSync(markitdownVenv)) return markitdownVenv;

  return isWin ? 'python' : 'python3';
}

/**
 * Build the render-script argv. `outDir` is our own mkdtemp path (not user
 * controlled). The `--` separator stops Python's `argparse` from reading a
 * `filePath` that begins with `-` as an option — same guard as
 * `buildDoclingArgs`. `filePath` is the only user-controlled value and it
 * sits AFTER `--`.
 */
export function buildRenderArgs(scriptPath, outDir, filePath, { first, last, scale } = {}) {
  return [
    scriptPath,
    '--out', outDir,
    '--scale', String(scale),
    '--first', String(first),
    '--last', String(last),
    '--', filePath,
  ];
}

/**
 * Read the PNG files the render script produced into `outDir`, enforcing
 * the byte caps. `fsDeps` is an injection seam for unit tests. Mirrors
 * `readProducedMarkdown`'s refusal discipline:
 *
 *   - 0 `.png` produced           → the render silently failed; throw.
 *   - one file > MAX_IMAGE_BYTES  → refuse BEFORE reading that file into
 *                                    memory (statSync first, readFileSync
 *                                    only if under cap).
 *   - cumulative > MAX_TOTAL_BYTES → refuse before reading the file that
 *                                    would push the total over — again,
 *                                    checked via statSync before the read.
 *
 * Returns `[{ name, base64 }]`, sorted by filename (which is how
 * `render-pdf-images.py` encodes page order: `page-0001.png`, `page-0002.png`, …).
 */
export function readProducedImages(outDir, fsDeps = fs) {
  const produced = fsDeps
    .readdirSync(outDir)
    .filter((f) => f.toLowerCase().endsWith('.png'))
    .sort();
  if (produced.length === 0) {
    throw new Error('pdf produced no page images');
  }

  const images = [];
  let totalBytes = 0;
  for (const name of produced) {
    const filePath = path.join(outDir, name);
    const { size } = fsDeps.statSync(filePath);
    if (size > MAX_IMAGE_BYTES) {
      throw new Error(
        `rendered page "${name}" (${size} bytes) exceeds the ${MAX_IMAGE_BYTES}-byte per-image cap.`,
      );
    }
    if (totalBytes + size > MAX_TOTAL_BYTES) {
      throw new Error(
        `rendered images exceed the ${MAX_TOTAL_BYTES}-byte total cap ` +
          `(reached ${totalBytes} bytes before "${name}"). Reduce max_pages or scale.`,
      );
    }
    const base64 = fsDeps.readFileSync(filePath).toString('base64');
    images.push({ name, base64 });
    totalBytes += size;
  }
  return images;
}

/**
 * Default runner: invoke the render script into a private temp dir, read
 * the produced PNGs back (capped — see readProducedImages), and clean up.
 */
async function defaultRun(python, scriptPath, { filePath, first, last, scale }) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-images-'));
  try {
    await execFileAsync(
      python,
      buildRenderArgs(scriptPath, outDir, filePath, { first, last, scale }),
      { maxBuffer: MAX_TOTAL_BYTES },
    );
    return readProducedImages(outDir);
  } finally {
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Render a local PDF's pages to PNG images and return them as an MCP
 * content payload: a leading text summary followed by one `image` block
 * per rendered page.
 *
 * `run` is the injectable seam: `(python, scriptPath, { filePath, first,
 * last, scale }) => Promise<[{ name, base64 }]>`. Production callers omit it
 * (the default runner shells out to `render-pdf-images.py`); tests inject a
 * fake that returns synthetic images without touching Python at all.
 */
export async function pdfToImages({
  filePath,
  maxPages,
  firstPage,
  scale,
  projectRoot = DEFAULT_PROJECT_ROOT,
  run,
} = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('Missing required argument: filepath');
  }
  const expanded = expandHome(filePath);
  assertPathAllowed(expanded);

  const first = Math.max(1, Number.isFinite(firstPage) ? firstPage : 1);
  const n = clamp(Number.isFinite(maxPages) ? maxPages : MAX_PAGES_DEFAULT, 1, MAX_PAGES_CEILING);
  const last = first + n - 1;
  const renderScale = clamp(Number.isFinite(scale) ? scale : DEFAULT_SCALE, SCALE_MIN, SCALE_MAX);

  const python = resolvePdfImagesPython(projectRoot);
  const scriptPath = path.resolve(projectRoot, 'scripts', 'render-pdf-images.py');
  const exec = run || ((py, script, opts) => defaultRun(py, script, opts));

  let images;
  try {
    images = await exec(python, scriptPath, { filePath: expanded, first, last, scale: renderScale });
  } catch (e) {
    if (e?.code === 'ENOENT') {
      throw new Error(
        `pdf_to_images needs pypdfium2 + Pillow. They ship with the Docling extra — ` +
          `set OBSIDIAN_ROUTER_ENABLE_DOCLING=1 and run \`npm run install-docling\`, ` +
          `or pip install pypdfium2 pillow into a venv and set PDF_IMAGES_PYTHON.`,
      );
    }
    const stderr = e?.stderr ?? '';
    if (/ModuleNotFoundError|pypdfium2|PIL/i.test(stderr)) {
      throw new Error(
        `pdf_to_images needs pypdfium2 + Pillow. They ship with the Docling extra — ` +
          `set OBSIDIAN_ROUTER_ENABLE_DOCLING=1 and run \`npm run install-docling\`, ` +
          `or pip install pypdfium2 pillow into a venv and set PDF_IMAGES_PYTHON.`,
      );
    }
    // A subprocess's stderr, verbatim, into a message the dispatcher renders as
    // `Error: ${err.message}`. It broke out of its own line (`\n`) as well as
    // carrying wrapper markup and ANSI.
    throw new Error(`Error rendering PDF to images: ${String(e?.message ?? 'Unknown error')}`);
  }

  const basename = path.basename(expanded);
  const requested = last - first + 1;
  const rendered = images.length;
  let summary = `Rendered ${rendered} page image(s) of ${basename} (pages ${first}–${first + rendered - 1}, scale ${renderScale}).`;
  if (rendered < requested) {
    summary += ` Requested ${requested} page(s) (${first}–${last}) but the PDF only yielded ${rendered} — likely a shorter document than requested.`;
  }

  return {
    content: [
      // THE TEXT BLOCK ONLY. This is the payload `wrapResult` deliberately
      // passes through untouched (`isMcpContentPayload` short-circuits before
      // any walk), so nothing downstream will ever look at it — and the summary
      // splices in `path.basename(filepath)`, a tool argument, which the threat
      // model treats as untrusted. The module already contained the word
      // `sanitize` thirteen times, so the grep-shaped guard was green while the
      // return path had zero coverage. Second tool caught by exactly that
      // (`get_file` was the first).
      //
      // On Windows the closing `</…>` happens to be eaten by `basename` at the
      // `/`; on POSIX it is not. Relying on a filesystem's naming rules for
      // containment is not containment.
      { type: 'text', text: summary },
      // NOT the images: base64 has no `<` to neutralize and no cap should ever
      // touch it. Capping or walking this would corrupt the picture.
      ...images.map((img) => ({ type: 'image', data: img.base64, mimeType: 'image/png' })),
    ],
  };
}
