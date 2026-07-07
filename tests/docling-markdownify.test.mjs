import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveDoclingPath } from '../src/markdownify/utils.mjs';
import { toMarkdownDocling, buildDoclingArgs, readProducedMarkdown } from '../src/markdownify/docling.mjs';
import { pdfToMarkdownDocling } from '../src/tools/convert.mjs';
import { _internals } from '../src/index.mjs';

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

/* ---- review+ pass 1 fixes: on-disk output cap + multi-file guard + sandbox ---- */

test('readProducedMarkdown returns the single produced markdown file', () => {
  const out = readProducedMarkdown('/tmp/outdir', {
    readdirSync: () => ['report.md'],
    statSync: () => ({ size: 42 }),
    readFileSync: () => '# Report\n',
  });
  assert.strictEqual(out, '# Report\n');
});

test('readProducedMarkdown throws when docling produced no markdown', () => {
  assert.throws(
    () => readProducedMarkdown('/tmp/outdir', {
      readdirSync: () => ['diagram.png'],
      statSync: () => ({ size: 1 }),
      readFileSync: () => '',
    }),
    /produced no markdown output/,
  );
});

test('readProducedMarkdown refuses to guess when >1 markdown file is produced', () => {
  assert.throws(
    () => readProducedMarkdown('/tmp/outdir', {
      readdirSync: () => ['report.md', 'appendix.md'],
      statSync: () => ({ size: 1 }),
      readFileSync: () => '',
    }),
    /expected exactly 1/,
  );
});

test('readProducedMarkdown enforces the MAX_OUTPUT_BYTES cap on the file (codex P2)', () => {
  let read = false;
  assert.throws(
    () => readProducedMarkdown('/tmp/outdir', {
      readdirSync: () => ['huge.md'],
      statSync: () => ({ size: 51 * 1024 * 1024 }), // > 50 MB ceiling
      readFileSync: () => { read = true; return 'should never be read'; },
    }),
    /exceeds the \d+-byte cap/,
  );
  assert.strictEqual(read, false, 'must refuse BEFORE reading the oversized file into memory');
});

test('toMarkdownDocling honors the MD_ALLOWED_PATHS sandbox (Reviewer A)', async () => {
  const old = process.env.MD_ALLOWED_PATHS;
  try {
    process.env.MD_ALLOWED_PATHS = '/sandbox/in';
    // Outside the sandbox → rejected by the shared assertPathAllowed guard,
    // before the runner is ever reached.
    await assert.rejects(
      () => toMarkdownDocling({ filePath: '/sandbox/out/doc.pdf', run: async () => '# nope' }),
      /outside the allowed directories/,
    );
    // Inside the sandbox → passes the guard, reaches the injected runner.
    const { text } = await toMarkdownDocling({
      filePath: '/sandbox/in/doc.pdf',
      run: async () => '# ok\n',
    });
    assert.strictEqual(text, '# ok\n');
  } finally {
    if (old !== undefined) process.env.MD_ALLOWED_PATHS = old;
    else delete process.env.MD_ALLOWED_PATHS;
  }
});
