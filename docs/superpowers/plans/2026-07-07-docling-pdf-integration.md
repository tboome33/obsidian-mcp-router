# Docling opt-in high-fidelity PDF conversion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new opt-in `pdf_to_markdown_docling` MCP tool (plus two slash commands) that converts a local PDF to markdown via Docling's standard pipeline, mirroring the existing MarkItDown subprocess pattern in-process, so self-hosters use their own CPU.

**Architecture:** A dedicated Python venv (`.venv-docling`) is created at postinstall ONLY when `OBSIDIAN_ROUTER_ENABLE_DOCLING=1`. A thin subprocess wrapper (`src/markdownify/docling.mjs`) shells out to the `docling` CLI, mirroring `src/markdownify/markitdown.mjs`. A new tool handler is wired into the existing `TOOLS` / `TOOL_HANDLERS` registry in `src/index.mjs`. `pdf_to_markdown` (MarkItDown) is untouched and stays the default for all other formats.

**Tech Stack:** Node.js ≥ 20.18.1 (ESM `.mjs`, no TypeScript), `node:test` + `node:assert/strict`, Python 3.10+ venv, the `docling` PyPI package (standard pipeline only).

## Global Constraints

- **Node:** `engines.node` is `>=20.18.1`. Pure ESM `.mjs`, no TypeScript, no new npm runtime deps.
- **License:** Apache-2.0 (repo). Docling is MIT (invoked as an external CLI, not vendored).
- **Opt-in:** Docling install is a NO-OP unless `OBSIDIAN_ROUTER_ENABLE_DOCLING === '1'` (exactly the string `'1'`) is set BEFORE `npm install`. MarkItDown stays opt-OUT (installed by default) — do not change its behavior.
- **Separate venv:** Docling lives in `.venv-docling`, never the MarkItDown `.venv`. The two dependency trees must not mix.
- **Scope = PDF only:** Do NOT add Docling variants for DOCX/PPTX/XLSX/image/audio/web. Only `pdf_to_markdown_docling`.
- **Standard pipeline only:** `pip install docling` (no `[vlm]` / `[asr]` extras). No VLM pipeline, no enrichment flags.
- **Never fail `npm install`:** the install script prints a warning and `exit 0` on any error (Python missing, pip failure, venv failure).
- **Always listed:** `pdf_to_markdown_docling` appears in the tool list even when Docling is not installed. A missing binary produces an actionable error at call time, never a startup crash.
- **No silent fallback:** if Docling errors on a PDF, surface the error — never silently retry via MarkItDown.
- **Spec:** `docs/superpowers/specs/2026-07-07-docling-pdf-integration-design.md`.

---

### Task 1: `resolveDoclingPath` executable resolver

**Files:**
- Modify: `src/markdownify/utils.mjs` (add one exported function next to `resolveMarkitdownPath`, ~line 57)
- Test: `tests/docling-markdownify.test.mjs` (new file — first test lands here)

**Interfaces:**
- Consumes: `path`, `fs` (already imported at the top of `utils.mjs`).
- Produces: `resolveDoclingPath(projectRoot: string) → string` — returns `DOCLING_PATH` env override, else `<projectRoot>/.venv-docling/{bin|Scripts}/docling[.exe]` if it exists, else the bare string `'docling'`.

- [ ] **Step 1: Write the failing test**

Create `tests/docling-markdownify.test.mjs` with:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveDoclingPath } from '../src/markdownify/utils.mjs';

test('resolveDoclingPath honors DOCLING_PATH override, else returns a non-empty string', () => {
  const old = process.env.DOCLING_PATH;
  try {
    process.env.DOCLING_PATH = '/custom/docling';
    assert.strictEqual(resolveDoclingPath('/whatever'), '/custom/docling');
  } finally {
    if (old !== undefined) process.env.DOCLING_PATH = old;
    else delete process.env.DOCLING_PATH;
  }
  // No override + no bundled venv on a throwaway root → bare 'docling'.
  delete process.env.DOCLING_PATH;
  assert.strictEqual(resolveDoclingPath('/nonexistent-root-xyz'), 'docling');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/docling-markdownify.test.mjs`
Expected: FAIL — `resolveDoclingPath` is not exported from `utils.mjs` (import throws / undefined).

- [ ] **Step 3: Write minimal implementation**

In `src/markdownify/utils.mjs`, immediately AFTER the `resolveMarkitdownPath` function (ends ~line 57), add:

```js
/**
 * Resolve the absolute path to the `docling` executable. Same cascade as
 * `resolveMarkitdownPath`, but pointed at the SEPARATE opt-in venv:
 *
 *   1. `DOCLING_PATH` env var — explicit override (e.g. `pipx install docling`).
 *   2. `<projectRoot>/.venv-docling/bin/docling` (POSIX) or
 *      `<projectRoot>\.venv-docling\Scripts\docling.exe` (Windows) — created by
 *      `scripts/install-docling.mjs` at postinstall time WHEN opted in.
 *   3. Bare `docling` — `PATH` lookup. ENOENT at call time if not installed.
 */
export function resolveDoclingPath(projectRoot) {
  if (process.env.DOCLING_PATH) return process.env.DOCLING_PATH;
  const isWin = process.platform === 'win32';
  const venvBin = path.join(
    projectRoot,
    '.venv-docling',
    isWin ? 'Scripts' : 'bin',
    `docling${isWin ? '.exe' : ''}`,
  );
  if (fs.existsSync(venvBin)) return venvBin;
  return 'docling';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/docling-markdownify.test.mjs`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/markdownify/utils.mjs tests/docling-markdownify.test.mjs
git commit -m "feat(docling): add resolveDoclingPath executable resolver"
```

---

### Task 2: `docling.mjs` subprocess wrapper

**Files:**
- Create: `src/markdownify/docling.mjs`
- Test: `tests/docling-markdownify.test.mjs` (append tests)

**Interfaces:**
- Consumes: `resolveDoclingPath`, `expandHome`, `assertPathAllowed` from `./utils.mjs`.
- Produces:
  - `buildDoclingArgs(outDir: string, filePath: string) → string[]` — the argv array `['--to','md','--output',outDir,'--',filePath]`. Exported for testing the `--` injection guard.
  - `toMarkdownDocling({ filePath: string, projectRoot?: string, run?: (doclingPath, filePath) => Promise<string> }) → Promise<{ text: string }>` — validates, sandbox-checks, runs the CLI (or an injected `run`), returns markdown. `run` is a test seam mirroring the `_deps` pattern already used by `youtubeToMarkdown`.

> **VERIFY AT IMPLEMENTATION (the one version-dependent surface):** if Docling is installed locally, run `docling --help` and confirm the output-format token is `md` (Docling's `OutputFormat` enum uses `md`) and the destination flag is `--output <dir>`. The code below uses `--to md --output <dir>`. If your Docling version differs, adjust ONLY the two string literals in `buildDoclingArgs`; the rest of the design (write-to-temp-dir, read the single `.md` back) is version-independent and does not rely on stdout streaming.

- [ ] **Step 1: Write the failing tests**

Append to `tests/docling-markdownify.test.mjs`:

```js
import { toMarkdownDocling, buildDoclingArgs } from '../src/markdownify/docling.mjs';

test('buildDoclingArgs puts the user filepath after -- (argv injection guard)', () => {
  const args = buildDoclingArgs('/tmp/out', '--version');
  const sep = args.indexOf('--');
  assert.ok(sep >= 0, 'must contain a -- separator');
  assert.strictEqual(args[sep + 1], '--version', 'filepath must be the arg right after --');
  assert.ok(
    args.slice(0, sep).every((a) => a !== '--version'),
    'filepath must not appear before the -- separator',
  );
});

test('toMarkdownDocling rejects a missing filepath', async () => {
  await assert.rejects(() => toMarkdownDocling({}), /Missing required argument: filepath/);
  await assert.rejects(() => toMarkdownDocling({ filePath: '' }), /Missing required argument: filepath/);
});

test('toMarkdownDocling returns the injected runner output (happy path, no Python)', async () => {
  const { text } = await toMarkdownDocling({
    filePath: '/tmp/whatever.pdf',
    run: async () => '# Heading\n\n| a | b |\n|---|---|\n| 1 | 2 |\n',
  });
  assert.match(text, /# Heading/);
  assert.match(text, /\| a \| b \|/);
});

test('toMarkdownDocling forwards the filepath verbatim to the runner', async () => {
  let seen = null;
  await toMarkdownDocling({
    filePath: '/tmp/report.pdf',
    run: async (doclingPath, filePath) => { seen = { doclingPath, filePath }; return 'ok'; },
  });
  assert.strictEqual(seen.filePath, '/tmp/report.pdf');
  assert.ok(typeof seen.doclingPath === 'string' && seen.doclingPath.length > 0);
});

test('toMarkdownDocling surfaces an actionable ENOENT when docling is not installed', async () => {
  await assert.rejects(
    () => toMarkdownDocling({
      filePath: '/tmp/whatever.pdf',
      run: async () => { const e = new Error('spawn docling ENOENT'); e.code = 'ENOENT'; throw e; },
    }),
    /OBSIDIAN_ROUTER_ENABLE_DOCLING=1/,
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/docling-markdownify.test.mjs`
Expected: FAIL — cannot import `toMarkdownDocling` / `buildDoclingArgs` (module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `src/markdownify/docling.mjs`:

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/docling-markdownify.test.mjs`
Expected: PASS (all tests so far — resolver + argv guard + wrapper).

- [ ] **Step 5: Commit**

```bash
git add src/markdownify/docling.mjs tests/docling-markdownify.test.mjs
git commit -m "feat(docling): add docling.mjs subprocess wrapper with injectable runner"
```

---

### Task 3: Wire `pdf_to_markdown_docling` into the tool registry

**Files:**
- Modify: `src/tools/convert.mjs` (import + two new exports)
- Modify: `src/index.mjs` (import, TOOLS entry, TOOL_HANDLERS entry)
- Test: `tests/docling-markdownify.test.mjs` (append registration + handler tests)

**Interfaces:**
- Consumes: `toMarkdownDocling` from `../markdownify/docling.mjs`; `assertString` (already defined in `convert.mjs`); the existing `_internals` export from `src/index.mjs`.
- Produces:
  - `pdfToMarkdownDocling(_registry, { filepath }, _deps = {}) → Promise<string>` — returns the markdown string (not the `{ text }` wrapper), same contract as `pdfToMarkdown`. `_deps.run` is an optional injected runner forwarded to `toMarkdownDocling`.
  - A `pdf_to_markdown_docling` entry in `_internals.TOOLS` and `_internals.TOOL_HANDLERS`; NOT in `_internals.WRITE_TOOL_NAMES`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/docling-markdownify.test.mjs`:

```js
import { pdfToMarkdownDocling } from '../src/tools/convert.mjs';
import { _internals } from '../src/index.mjs';

test('pdf_to_markdown_docling is registered in TOOLS with a handler, not a write tool', () => {
  const advertised = _internals.TOOLS.map((t) => t.name);
  assert.ok(advertised.includes('pdf_to_markdown_docling'), 'missing TOOLS entry');
  assert.strictEqual(
    typeof _internals.TOOL_HANDLERS['pdf_to_markdown_docling'],
    'function',
    'missing handler',
  );
  assert.strictEqual(
    _internals.WRITE_TOOL_NAMES.has('pdf_to_markdown_docling'),
    false,
    'must not be a write tool — it touches no vault',
  );
});

test('pdf_to_markdown_docling schema requires filepath', () => {
  const byName = Object.fromEntries(_internals.TOOLS.map((t) => [t.name, t]));
  assert.deepStrictEqual(byName['pdf_to_markdown_docling'].inputSchema.required, ['filepath']);
});

test('pdfToMarkdownDocling rejects a missing filepath before touching Docling', async () => {
  await assert.rejects(() => pdfToMarkdownDocling(null, {}), /Missing required argument: filepath/);
  await assert.rejects(() => pdfToMarkdownDocling(null, { filepath: '' }), /Missing required argument: filepath/);
});

test('pdfToMarkdownDocling returns the raw markdown string via the injected runner', async () => {
  const out = await pdfToMarkdownDocling(
    null,
    { filepath: '/tmp/report.pdf' },
    { run: async () => '# Report\n' },
  );
  assert.strictEqual(out, '# Report\n');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/docling-markdownify.test.mjs`
Expected: FAIL — `pdfToMarkdownDocling` is not exported from `convert.mjs`; `pdf_to_markdown_docling` absent from `_internals.TOOLS`. (Importing `_internals` still works; the assertions fail.)

- [ ] **Step 3a: Add the wrapper to `src/tools/convert.mjs`**

At the top of `src/tools/convert.mjs`, ADD an import directly after the existing markitdown import (currently line 23-24):

```js
import { toMarkdown, fromRepo } from '../markdownify/markitdown.mjs';
import { toMarkdownDocling } from '../markdownify/docling.mjs';
```

Then, in the `File-input tools` section, immediately AFTER the `pdfToMarkdown` export (currently lines 175-177), ADD:

```js
async function convertFileDocling(filepath, run) {
  assertString(filepath, 'filepath');
  const { text } = await toMarkdownDocling({ filePath: filepath, run });
  return text;
}

export async function pdfToMarkdownDocling(_registry, { filepath } = {}, _deps = {}) {
  return convertFileDocling(filepath, _deps.run);
}
```

- [ ] **Step 3b: Register the tool in `src/index.mjs`**

(1) Extend the convert.mjs import block (currently lines 36-47) — add `pdfToMarkdownDocling,` after `pdfToMarkdown,`:

```js
import {
  youtubeToMarkdown,
  bingSearchToMarkdown,
  webpageToMarkdown,
  pdfToMarkdown,
  pdfToMarkdownDocling,
  imageToMarkdown,
  audioToMarkdown,
  docxToMarkdown,
  xlsxToMarkdown,
  pptxToMarkdown,
  gitRepoToMarkdown,
} from './tools/convert.mjs';
```

(2) In the `TOOLS` array, immediately AFTER the `pdf_to_markdown` entry (the object ending at `additionalProperties: false }, }` ~line 473), INSERT:

```js
  {
    name: 'pdf_to_markdown_docling',
    description:
      "Convert a local PDF to markdown via Docling's standard pipeline (layout + table-structure recognition) — higher fidelity than `pdf_to_markdown` on complex tables / multi-column layouts, at ~10x the CPU cost. OPT-IN: requires the Docling extra (install with OBSIDIAN_ROUTER_ENABLE_DOCLING=1, or `npm run install-docling`); if it is not installed the call returns an actionable install hint. Returns markdown text only — does NOT write to any vault. For fast/simple PDFs or office formats use `pdf_to_markdown` instead.",
    inputSchema: {
      type: 'object',
      properties: {
        filepath: {
          type: 'string',
          description: 'Absolute path of the PDF file to convert.',
        },
      },
      required: ['filepath'],
      additionalProperties: false,
    },
  },
```

(3) In the `TOOL_HANDLERS` object, immediately AFTER the `pdf_to_markdown:` line (currently line 878), INSERT:

```js
  pdf_to_markdown_docling: (reg, args) => pdfToMarkdownDocling(reg, args),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/docling-markdownify.test.mjs`
Expected: PASS. (If `index.mjs` throws `TOOLS / TOOL_HANDLERS drift detected` at import, you added the TOOLS entry or the handler but not both — add the missing one.)

Also run the existing markdownify test to confirm no regression:
Run: `node --test tests/markdownify.test.mjs`
Expected: PASS (the 10-tool checks still hold — an 11th tool doesn't break `includes`-based assertions).

- [ ] **Step 5: Commit**

```bash
git add src/tools/convert.mjs src/index.mjs tests/docling-markdownify.test.mjs
git commit -m "feat(docling): register pdf_to_markdown_docling MCP tool"
```

---

### Task 4: Opt-in installer + package wiring + gitignore

**Files:**
- Create: `scripts/install-docling.mjs`
- Create: `tests/install-docling.test.mjs`
- Modify: `package.json` (`postinstall`, new `install-docling` script, `test` list)
- Modify: `.gitignore` (add `.venv-docling/`)

**Interfaces:**
- Consumes: nothing from earlier tasks (standalone script).
- Produces: `doclingOptedIn(env = process.env) → boolean` — exported predicate, `true` iff `env.OBSIDIAN_ROUTER_ENABLE_DOCLING === '1'`. The script only runs its install `main()` under an entrypoint guard, so importing it in a test does NOT trigger an install.

- [ ] **Step 1: Write the failing test**

Create `tests/install-docling.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { doclingOptedIn } from '../scripts/install-docling.mjs';

test('doclingOptedIn is true only for the exact string "1"', () => {
  assert.strictEqual(doclingOptedIn({}), false);
  assert.strictEqual(doclingOptedIn({ OBSIDIAN_ROUTER_ENABLE_DOCLING: '1' }), true);
  assert.strictEqual(doclingOptedIn({ OBSIDIAN_ROUTER_ENABLE_DOCLING: 'true' }), false);
  assert.strictEqual(doclingOptedIn({ OBSIDIAN_ROUTER_ENABLE_DOCLING: '0' }), false);
  assert.strictEqual(doclingOptedIn({ OBSIDIAN_ROUTER_ENABLE_DOCLING: '' }), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/install-docling.test.mjs`
Expected: FAIL — `scripts/install-docling.mjs` does not exist.

- [ ] **Step 3a: Create `scripts/install-docling.mjs`**

```js
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
 * Resolve a Python interpreter (3.10+). Tries `python3` then `python`.
 * Returns { cmd, version } or null. (Same logic as install-markitdown.mjs.)
 */
async function findPython() {
  for (const candidate of ['python3', 'python']) {
    try {
      const { stdout } = await execFileAsync(candidate, ['--version']);
      const m = stdout.match(/Python (\d+)\.(\d+)/);
      if (m) {
        const major = parseInt(m[1], 10);
        const minor = parseInt(m[2], 10);
        if ((major === 3 && minor >= 10) || major > 3) {
          return { cmd: candidate, version: `${major}.${minor}` };
        }
        warn(`Found ${candidate} ${major}.${minor} — docling needs Python 3.10+.`);
      }
    } catch {
      // Not on PATH — try the next candidate.
    }
  }
  return null;
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
  if (fs.existsSync(venvMarker)) {
    log(`docling already present at ${venvMarker} — skipping reinstall.`);
    return;
  }

  // 2. Find a usable Python.
  const py = await findPython();
  if (!py) {
    warn(
      'No Python 3.10+ found on PATH. `pdf_to_markdown_docling` will fail at ' +
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
```

- [ ] **Step 3b: Wire `package.json`**

Change the `postinstall` line and add an `install-docling` script (in the `scripts` block, currently lines 34-35):

```json
    "install-markitdown": "node scripts/install-markitdown.mjs",
    "install-docling": "node scripts/install-docling.mjs",
    "postinstall": "node scripts/install-markitdown.mjs && node scripts/install-docling.mjs"
```

(Both install scripts always `exit 0`, so `&&` reliably runs the second regardless of the first.)

Then append the two new test files to the END of the `test` script string (currently ends with `tests/youtube-fallback.test.mjs`). Replace:

```
tests/youtube-fallback.test.mjs"
```

with:

```
tests/youtube-fallback.test.mjs tests/docling-markdownify.test.mjs tests/install-docling.test.mjs"
```

- [ ] **Step 3c: Wire `.gitignore`**

In `.gitignore`, immediately AFTER the existing `.venv/` line (currently line 9), add:

```gitignore
# Opt-in Python venv for the `docling` CLI (pdf_to_markdown_docling).
.venv-docling/
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/install-docling.test.mjs`
Expected: PASS (importing the script does NOT run an install; `doclingOptedIn` behaves).

Run the full suite to confirm the `test` list edit is valid and nothing regressed:
Run: `npm test`
Expected: PASS — the previous green count **+ the new docling + install-docling tests**, all green.

- [ ] **Step 5: Commit**

```bash
git add scripts/install-docling.mjs tests/install-docling.test.mjs package.json .gitignore
git commit -m "feat(docling): opt-in postinstall installer + package/gitignore wiring"
```

---

### Task 5: Slash commands

**Files:**
- Create: `commands/pdf-to-markdown.md`
- Create: `commands/pdf-to-markdown-docling.md`

**Interfaces:**
- Consumes: the `pdf_to_markdown` tool (pre-existing) and the `pdf_to_markdown_docling` tool (Task 3).
- Produces: two plugin slash commands, invoked as `/obsidian-router:pdf-to-markdown` and `/obsidian-router:pdf-to-markdown-docling` (the `obsidian-router:` prefix comes from the plugin namespace, not the filename).

- [ ] **Step 1: Create `commands/pdf-to-markdown.md`**

```markdown
---
description: Convert a local PDF to markdown via the bundled MarkItDown Python CLI (fast, lightweight — plain text extraction, no table-structure recognition). For complex tables/layouts prefer /obsidian-router:pdf-to-markdown-docling.
---

Invoke the `pdf_to_markdown` MCP tool on the given file path.

Required argument: `filepath` (absolute path to the PDF).

Returns markdown text only — it does NOT write to any vault. To persist, chain with `write_file`, or hand off to `wiki-ingest`.

MarkItDown is fast (~12s / 100 pages) but its PDF backend (`pdfminer.six`) extracts the text stream with no layout or table analysis. For PDFs with complex tables or multi-column layouts, use `/obsidian-router:pdf-to-markdown-docling` instead (higher fidelity, ~10x slower, requires the opt-in Docling install).
```

- [ ] **Step 2: Create `commands/pdf-to-markdown-docling.md`**

```markdown
---
description: Convert a local PDF to markdown via Docling's standard pipeline (layout + table-structure recognition — higher fidelity than MarkItDown on complex tables/layouts, ~10x slower). Requires the opt-in Docling install.
---

Invoke the `pdf_to_markdown_docling` MCP tool on the given file path.

Required argument: `filepath` (absolute path to the PDF).

Returns markdown text only — it does NOT write to any vault. To persist, chain with `write_file`, or hand off to `wiki-ingest`.

Docling reconstructs table structure and reading order that MarkItDown's `pdfminer.six` backend loses, at ~10x the CPU cost. It is an **opt-in** extra: it only works if the router was installed with `OBSIDIAN_ROUTER_ENABLE_DOCLING=1` (or `npm run install-docling` was run afterwards). If Docling is not installed, the tool returns an actionable install hint — fall back to `/obsidian-router:pdf-to-markdown` (MarkItDown). For fast/simple PDFs or non-PDF office files, prefer `/obsidian-router:pdf-to-markdown`.
```

- [ ] **Step 3: Verify frontmatter validity**

Run: `node -e "const fs=require('fs');for(const f of ['commands/pdf-to-markdown.md','commands/pdf-to-markdown-docling.md']){const s=fs.readFileSync(f,'utf8');if(!s.startsWith('---\n')||s.indexOf('\n---',4)<0){throw new Error('bad frontmatter: '+f)}console.log('ok',f)}"`
Expected: prints `ok commands/pdf-to-markdown.md` and `ok commands/pdf-to-markdown-docling.md`.

- [ ] **Step 4: Commit**

```bash
git add commands/pdf-to-markdown.md commands/pdf-to-markdown-docling.md
git commit -m "feat(docling): add /pdf-to-markdown and /pdf-to-markdown-docling slash commands"
```

---

### Task 6: Docs, CHANGELOG, ROADMAP, version bump

**Files:**
- Modify: `README.md` (capability tables EN+FR, runtime-deps section, env-var table)
- Modify: `CHANGELOG.md`
- Modify: `ROADMAP.md`
- Modify (via `npm run bump`): `package.json`, `package-lock.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `README.md` badges

**Interfaces:**
- Consumes: everything built in Tasks 1–5.
- Produces: version `0.37.0` synchronized across the five version sites; user-facing docs.

- [ ] **Step 1: README — capability DETAIL table (EN)**

In `README.md`, immediately AFTER the `pdf_to_markdown · docx_to_markdown · …` detail row (the row starting `| \`pdf_to_markdown\` · \`docx_to_markdown\``), ADD a new row:

```markdown
| `pdf_to_markdown_docling` | Convert a local PDF to markdown via **Docling**'s standard pipeline (layout detection + TableFormer table-structure recognition). Higher fidelity than `pdf_to_markdown` on complex tables / multi-column layouts, at ~10× the CPU cost. **Opt-in** — requires the Docling extra (see *Conversion tools — runtime dependencies*). PDF only; for office formats keep `pdf_to_markdown`. |
```

- [ ] **Step 2: README — capability DETAIL table (FR)**

Find the FR equivalent detail row (`| \`pdf_to_markdown\` · \`docx_to_markdown\` … | Convertit un fichier local en markdown via le CLI Python \`markitdown\`…`) and ADD immediately after it:

```markdown
| `pdf_to_markdown_docling` | Convertit un PDF local en markdown via le pipeline standard de **Docling** (détection de mise en page + reconnaissance de structure de tableau TableFormer). Plus haute fidélité que `pdf_to_markdown` sur les tableaux complexes / mises en page multi-colonnes, à ~10× le coût CPU. **Opt-in** — nécessite l'extra Docling (voir la section dépendances de conversion). PDF uniquement ; pour les formats bureautiques, garder `pdf_to_markdown`. |
```

- [ ] **Step 3: README — capability SUMMARY tables (EN + FR)**

There are two summary rows (EN near the top, FR further down) that both read:
`| Conversion (v0.11+) | \`pdf_to_markdown\`, …, \`git_repo_to_markdown\` — port of [zcaceres/markdownify-mcp](https://github.com/zcaceres/markdownify-mcp) (MIT). |`

In BOTH rows, insert `, plus \`pdf_to_markdown_docling\` (opt-in high-fidelity PDF via [Docling](https://github.com/docling-project/docling), MIT)` immediately after `` `git_repo_to_markdown` `` and before ` — port of`. Result (both occurrences):

```markdown
| Conversion (v0.11+) | `pdf_to_markdown`, `docx_to_markdown`, `xlsx_to_markdown`, `pptx_to_markdown`, `image_to_markdown`, `audio_to_markdown`, `youtube_to_markdown`, `bing_search_to_markdown`, `webpage_to_markdown`, `git_repo_to_markdown`, plus `pdf_to_markdown_docling` (opt-in high-fidelity PDF via [Docling](https://github.com/docling-project/docling), MIT) — port of [zcaceres/markdownify-mcp](https://github.com/zcaceres/markdownify-mcp) (MIT). |
```

- [ ] **Step 4: README — runtime-dependencies section**

In the **Conversion tools — runtime dependencies** section, immediately AFTER the `git_repo_to_markdown` uses `repomix`… bullet (the last bullet before `Optional sandbox env vars:`), ADD:

```markdown

**High-fidelity PDF via Docling (opt-in).** `pdf_to_markdown_docling` uses [Docling](https://github.com/docling-project/docling) (IBM / LF AI & Data Foundation, MIT) instead of MarkItDown — its layout + TableFormer models reconstruct table structure and reading order that MarkItDown's `pdfminer.six` backend loses, at ~10× the CPU cost. Docling pulls ~1-2 GB of torch/onnxruntime + model weights, so it is **not** installed by default:

- Enable it by setting `OBSIDIAN_ROUTER_ENABLE_DOCLING=1` **before** `npm install` — the postinstall then creates a separate `.venv-docling` and runs `pip install docling` (standard pipeline; no VLM/ASR extras). Re-run any time with the env var set: `npm run install-docling`. Needs Python 3.10+.
- To use a system-wide install instead: `pipx install docling` and set `DOCLING_PATH=/abs/path/to/docling`.
- `pdf_to_markdown_docling` stays listed even when Docling isn't installed; calling it then returns an actionable install hint. `pdf_to_markdown` (MarkItDown) is unaffected and remains the default fast path. Docling is PDF-only here — DOCX/PPTX/XLSX keep using MarkItDown.
```

- [ ] **Step 5: README — env-var table**

In the `Optional sandbox env vars:` table, immediately AFTER the `OBSIDIAN_ROUTER_SKIP_MARKITDOWN` row, ADD:

```markdown
| `OBSIDIAN_ROUTER_ENABLE_DOCLING` | Set to `1` **before install** to opt into the Docling backend for `pdf_to_markdown_docling` (creates `.venv-docling`, `pip install docling`). Any other value → the tool is listed but errors with an install hint at call time. |
| `DOCLING_PATH` | Absolute path to the `docling` executable. Override when not using the bundled `.venv-docling`. |
```

- [ ] **Step 6: CHANGELOG — add the entry under `[Unreleased]`**

In `CHANGELOG.md`, inside the existing `## [Unreleased]` section, ADD a new `### Added` subsection (place it above the existing `### Fixed`):

```markdown
### Added

- **`pdf_to_markdown_docling` — opt-in high-fidelity PDF → markdown via Docling.** A new conversion tool (and `/pdf-to-markdown-docling` slash command) that runs [Docling](https://github.com/docling-project/docling)'s standard pipeline (layout detection + TableFormer table-structure recognition) instead of MarkItDown's `pdfminer.six` backend — reconstructing tables and reading order that MarkItDown loses (benchmarks: 88% vs 82% F1), at ~10× the CPU cost. **Opt-in and in-process**, mirroring the MarkItDown pattern: a *separate* `.venv-docling` is created at postinstall ONLY when `OBSIDIAN_ROUTER_ENABLE_DOCLING=1` is set before install (or via `npm run install-docling`); `pip install docling` pulls ~1-2 GB of torch/onnxruntime + models. The tool is always listed — an uninstalled Docling yields an actionable call-time hint, never a startup failure. Scope is **PDF only** (DOCX/PPTX/XLSX/web keep MarkItDown, where Docling shows no advantage). New: `scripts/install-docling.mjs`, `src/markdownify/docling.mjs`, `resolveDoclingPath` in `src/markdownify/utils.mjs`, `pdfToMarkdownDocling` in `src/tools/convert.mjs`, `commands/pdf-to-markdown.md` + `commands/pdf-to-markdown-docling.md`, env vars `OBSIDIAN_ROUTER_ENABLE_DOCLING` / `DOCLING_PATH`. Tests: `tests/docling-markdownify.test.mjs` + `tests/install-docling.test.mjs`. Design spec: `docs/superpowers/specs/2026-07-07-docling-pdf-integration-design.md`.
```

- [ ] **Step 7: ROADMAP — add the shipped entry**

In `ROADMAP.md`, immediately AFTER the `# Roadmap` intro lines and BEFORE the first `## ✅ v…` heading, ADD:

```markdown
## ✅ v0.37.0 — Docling opt-in high-fidelity PDF conversion (shipped 2026-07-07)

New in-process conversion tool `pdf_to_markdown_docling` (+ `/pdf-to-markdown-docling` and `/pdf-to-markdown` slash commands). Runs [Docling](https://github.com/docling-project/docling)'s standard pipeline (layout + TableFormer) for PDFs with complex tables / multi-column layouts, where MarkItDown's `pdfminer.six` backend does plain text-stream extraction with no structure (88% vs 82% F1 on document extraction). Scoped to PDF only — DOCX/PPTX/XLSX keep MarkItDown (Docling's models are PDF-first, no demonstrated advantage there).

- **Opt-in, in-process, separate venv.** Mirrors the MarkItDown wrapper (`scripts/install-docling.mjs` ⇄ `scripts/install-markitdown.mjs`, `src/markdownify/docling.mjs` ⇄ `markitdown.mjs`). Postinstall is a NO-OP unless `OBSIDIAN_ROUTER_ENABLE_DOCLING=1` is set before `npm install` (Docling pulls ~1-2 GB of torch/onnxruntime + models, ~10× slower than MarkItDown). Installs into `.venv-docling` — never mixed with the MarkItDown `.venv`.
- **Always listed, degrades gracefully.** The tool is advertised even when Docling isn't installed; a missing binary yields an actionable call-time hint (`OBSIDIAN_ROUTER_ENABLE_DOCLING=1` / `npm run install-docling` / `DOCLING_PATH`). Never fails `npm install`, never crashes at boot. No silent fallback to MarkItDown.
- **Env vars:** `OBSIDIAN_ROUTER_ENABLE_DOCLING` (opt-in gate), `DOCLING_PATH` (system-wide override).
- **Tests:** `tests/docling-markdownify.test.mjs` (resolver, argv `--` injection guard, wrapper happy path via injected runner, ENOENT hint, tool registration) + `tests/install-docling.test.mjs` (opt-in predicate). Full suite green.
- **Docs:** README (capability tables EN+FR, runtime-deps section, env-var table), CHANGELOG, design spec `docs/superpowers/specs/2026-07-07-docling-pdf-integration-design.md`.
```

- [ ] **Step 8: Bump the version to 0.37.0 (five version sites, no changelog stub)**

Run: `npm run bump 0.37.0 --no-changelog`
Expected: updates `package.json`, `package-lock.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, and the README version badges (EN + FR) to `0.37.0`; prints a success summary. `--no-changelog` is used because Step 6 wrote the CHANGELOG entry by hand.

- [ ] **Step 9: Promote the CHANGELOG `[Unreleased]` section to `[0.37.0]`**

In `CHANGELOG.md`, rename the current `## [Unreleased]` heading to a dated release heading and add a fresh empty `[Unreleased]` on top. The top of the file should read:

```markdown
## [Unreleased]

## [0.37.0] — 2026-07-07 — Docling opt-in high-fidelity PDF conversion

### Added

- **`pdf_to_markdown_docling` — opt-in high-fidelity PDF → markdown via Docling.** …(the bullet from Step 6, unchanged)…

### Fixed

- **`vault-link-linter` — wrong-port false positive on multi-vault path collision.** …(the existing Unreleased Fixed bullet, unchanged)…

### Changed

- …(the existing Unreleased Changed bullets, unchanged)…
```

(Use today's date if not 2026-07-07. This folds all previously-unreleased items into 0.37.0, which is correct — they ship in the same release.)

- [ ] **Step 10: Run the full test suite**

Run: `npm test`
Expected: PASS — the entire suite green, including `tests/docling-markdownify.test.mjs` and `tests/install-docling.test.mjs`.

- [ ] **Step 11: Sanity-check the version sync**

Run: `node -e "const p=require('./package.json');const pl=require('./.claude-plugin/plugin.json');const m=require('./.claude-plugin/marketplace.json');console.log('package',p.version,'plugin',pl.version,'market',m.metadata.version||(m.plugins&&m.plugins[0]&&m.plugins[0].version));if(p.version!=='0.37.0'||pl.version!=='0.37.0')throw new Error('version drift')"`
Expected: prints `package 0.37.0 plugin 0.37.0 market 0.37.0` with no throw.

- [ ] **Step 12: Commit**

```bash
git add README.md CHANGELOG.md ROADMAP.md package.json package-lock.json .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "docs+release(docling): document pdf_to_markdown_docling, bump to v0.37.0"
```

---

## Self-Review

**Spec coverage** (against `2026-07-07-docling-pdf-integration-design.md`):
- §3 `scripts/install-docling.mjs` → Task 4 ✓
- §3 `src/markdownify/docling.mjs` → Task 2 ✓
- §3 `resolveDoclingPath` in `utils.mjs` → Task 1 ✓
- §3 `pdfToMarkdownDocling` in `convert.mjs` → Task 3 ✓
- §3 tool registration in `index.mjs` → Task 3 ✓
- §3 `commands/pdf-to-markdown.md` + `commands/pdf-to-markdown-docling.md` → Task 5 ✓
- §3 postinstall chain → Task 4 ✓
- §4.1 opt-in gate (`OBSIDIAN_ROUTER_ENABLE_DOCLING=1`), `.venv-docling`, `findPython` reuse, `pip install docling`, never-fail, idempotence marker → Task 4 ✓
- §4.2 `toMarkdownDocling`, `assertPathAllowed`, `resolveDoclingPath`, `--` guard, ENOENT hint, `{ text }` return → Task 2 ✓
- §4.3 `convertFileDocling` + `pdfToMarkdownDocling` → Task 3 ✓
- §4.4 34th tool, honest description, not in `WRITE_TOOL_NAMES` → Task 3 ✓
- §4.5 slash commands, terse pattern, cross-reference → Task 5 ✓
- §5 error behavior (not installed / Python absent / docling fails, no silent fallback) → Tasks 2 & 4 ✓
- §6 `tests/docling-markdownify.test.mjs` (happy path, sandbox reject via `assertPathAllowed`, ENOENT, argv guard) + install no-op test → Tasks 1-4 ✓
  - Note: the "outside MD_ALLOWED_PATHS" rejection is already covered by the shared `assertPathAllowed` (tested in `tests/markdownify.test.mjs`); `toMarkdownDocling` calls the same guard, so it is not re-tested per-tool to avoid duplication.
- §7 out-of-scope (VLM, other formats, docling-serve, dynamic detection) → honored; no tasks add them ✓
- Additional (from task brief): README, CHANGELOG, ROADMAP, version bump → Task 6 ✓

**Placeholder scan:** No TBD/TODO. The single "verify at implementation" note (Task 2, the `--to md` CLI-flag literal) is a concrete conditional with exact fallback values, not a placeholder — it flags the one genuinely version-dependent string.

**Type/name consistency:** `resolveDoclingPath` (Task 1) — used identically in Task 2. `buildDoclingArgs(outDir, filePath)` — defined + tested Task 2, same signature. `toMarkdownDocling({ filePath, projectRoot, run })` — defined Task 2, consumed Task 3 via `{ filePath: filepath, run }`. `pdfToMarkdownDocling(_registry, { filepath }, _deps)` — defined Task 3, tool name `pdf_to_markdown_docling` consistent across TOOLS entry, handler, tests, commands, docs. `doclingOptedIn(env)` — defined + tested Task 4. `.venv-docling` and `OBSIDIAN_ROUTER_ENABLE_DOCLING` / `DOCLING_PATH` spelled identically everywhere.
