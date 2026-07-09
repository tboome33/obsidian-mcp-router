import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolvePdfImagesPython,
  buildRenderArgs,
  readProducedImages,
  pdfToImages,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_BYTES,
} from '../src/markdownify/pdf-images.mjs';
import { pdfToImagesTool } from '../src/tools/convert.mjs';
import { _internals } from '../src/index.mjs';

test('resolvePdfImagesPython honors PDF_IMAGES_PYTHON override, else returns a non-empty string', () => {
  const old = process.env.PDF_IMAGES_PYTHON;
  try {
    process.env.PDF_IMAGES_PYTHON = '/custom/python';
    assert.strictEqual(resolvePdfImagesPython('/whatever'), '/custom/python');
  } finally {
    if (old !== undefined) process.env.PDF_IMAGES_PYTHON = old;
    else delete process.env.PDF_IMAGES_PYTHON;
  }
  // No override + no bundled venvs on a throwaway root → bare fallback.
  delete process.env.PDF_IMAGES_PYTHON;
  const fallback = resolvePdfImagesPython('/nonexistent-root-xyz');
  assert.ok(typeof fallback === 'string' && fallback.length > 0);
  assert.ok(fallback === 'python' || fallback === 'python3');
});

test('buildRenderArgs puts the user filepath after -- (argv injection guard)', () => {
  const args = buildRenderArgs('/script.py', '/tmp/out', '--version', { first: 1, last: 2, scale: 2.0 });
  const sep = args.indexOf('--');
  assert.ok(sep >= 0, 'must contain a -- separator');
  assert.strictEqual(args[sep + 1], '--version', 'filepath must be the arg right after --');
  assert.ok(
    args.slice(0, sep).every((a) => a !== '--version'),
    'filepath must not appear before the -- separator',
  );
});

test('buildRenderArgs includes --out/--scale/--first/--last before the -- separator', () => {
  const args = buildRenderArgs('/script.py', '/tmp/out', '/tmp/x.pdf', { first: 3, last: 5, scale: 1.5 });
  const sep = args.indexOf('--');
  const before = args.slice(0, sep);
  assert.ok(before.includes('--out'));
  assert.strictEqual(before[before.indexOf('--out') + 1], '/tmp/out');
  assert.ok(before.includes('--scale'));
  assert.strictEqual(before[before.indexOf('--scale') + 1], '1.5');
  assert.ok(before.includes('--first'));
  assert.strictEqual(before[before.indexOf('--first') + 1], '3');
  assert.ok(before.includes('--last'));
  assert.strictEqual(before[before.indexOf('--last') + 1], '5');
});

test('pdfToImages rejects a missing filepath', async () => {
  await assert.rejects(() => pdfToImages({}), /Missing required argument: filepath/);
  await assert.rejects(() => pdfToImages({ filePath: '' }), /Missing required argument: filepath/);
});

test('pdfToImages happy path returns a leading text block + image blocks (injected run, no Python)', async () => {
  const fakeImages = [
    { name: 'page-0001.png', base64: 'AAAA' },
    { name: 'page-0002.png', base64: 'BBBB' },
  ];
  const result = await pdfToImages({
    filePath: '/tmp/whatever.pdf',
    run: async () => fakeImages,
  });
  assert.ok(Array.isArray(result.content));
  assert.strictEqual(result.content.length, 3); // 1 text summary + 2 images
  assert.strictEqual(result.content[0].type, 'text');
  assert.match(result.content[0].text, /Rendered 2 page image/);
  assert.strictEqual(result.content[1].type, 'image');
  assert.strictEqual(result.content[1].mimeType, 'image/png');
  assert.strictEqual(result.content[1].data, 'AAAA');
  assert.strictEqual(result.content[2].type, 'image');
  assert.strictEqual(result.content[2].data, 'BBBB');
});

test('pdfToImages notes a shortfall instead of silently truncating', async () => {
  const result = await pdfToImages({
    filePath: '/tmp/short.pdf',
    maxPages: 5,
    run: async () => [{ name: 'page-0001.png', base64: 'AAAA' }],
  });
  assert.match(result.content[0].text, /Requested 5 page\(s\).*only yielded 1/);
});

test('pdfToImages forwards the resolved first/last/scale to the runner', async () => {
  let seenOpts = null;
  await pdfToImages({
    filePath: '/tmp/report.pdf',
    firstPage: 3,
    maxPages: 2,
    scale: 1.0,
    run: async (python, scriptPath, opts) => { seenOpts = opts; return [{ name: 'page-0003.png', base64: 'X' }]; },
  });
  assert.strictEqual(seenOpts.first, 3);
  assert.strictEqual(seenOpts.last, 4); // first + n - 1 = 3 + 2 - 1
  assert.strictEqual(seenOpts.scale, 1.0);
  assert.strictEqual(seenOpts.filePath, '/tmp/report.pdf');
});

test('pdfToImages clamps max_pages to the hard ceiling and scale to [0.5, 4.0]', async () => {
  let seenOpts = null;
  await pdfToImages({
    filePath: '/tmp/report.pdf',
    maxPages: 9999,
    scale: 100,
    run: async (python, scriptPath, opts) => { seenOpts = opts; return [{ name: 'page-0001.png', base64: 'X' }]; },
  });
  assert.strictEqual(seenOpts.last - seenOpts.first + 1, 30); // MAX_PAGES_CEILING
  assert.strictEqual(seenOpts.scale, 4.0); // SCALE_MAX
});

test('pdfToImages surfaces an actionable hint on ENOENT (python not found)', async () => {
  await assert.rejects(
    () => pdfToImages({
      filePath: '/tmp/whatever.pdf',
      run: async () => { const e = new Error('spawn python ENOENT'); e.code = 'ENOENT'; throw e; },
    }),
    /OBSIDIAN_ROUTER_ENABLE_DOCLING=1/,
  );
});

test('pdfToImages surfaces an actionable hint when stderr shows a missing module', async () => {
  await assert.rejects(
    () => pdfToImages({
      filePath: '/tmp/whatever.pdf',
      run: async () => {
        const e = new Error('Command failed');
        e.stderr = 'ModuleNotFoundError: No module named \'pypdfium2\'';
        throw e;
      },
    }),
    /needs pypdfium2 \+ Pillow/,
  );
});

test('pdfToImages honors the MD_ALLOWED_PATHS sandbox', async () => {
  const old = process.env.MD_ALLOWED_PATHS;
  try {
    process.env.MD_ALLOWED_PATHS = '/sandbox/in';
    await assert.rejects(
      () => pdfToImages({ filePath: '/sandbox/out/doc.pdf', run: async () => [{ name: 'a.png', base64: 'X' }] }),
      /outside the allowed directories/,
    );
    const result = await pdfToImages({
      filePath: '/sandbox/in/doc.pdf',
      run: async () => [{ name: 'page-0001.png', base64: 'X' }],
    });
    assert.strictEqual(result.content[1].data, 'X');
  } finally {
    if (old !== undefined) process.env.MD_ALLOWED_PATHS = old;
    else delete process.env.MD_ALLOWED_PATHS;
  }
});

/* ---- readProducedImages caps ---- */

test('readProducedImages returns sorted [{name, base64}] for the produced PNGs', () => {
  const out = readProducedImages('/tmp/outdir', {
    readdirSync: () => ['page-0002.png', 'page-0001.png', 'notes.txt'],
    statSync: () => ({ size: 42 }),
    readFileSync: () => Buffer.from('fake-png-bytes'),
  });
  assert.deepStrictEqual(out.map((i) => i.name), ['page-0001.png', 'page-0002.png']);
  assert.ok(out.every((i) => typeof i.base64 === 'string' && i.base64.length > 0));
});

test('readProducedImages throws when zero PNGs were produced', () => {
  assert.throws(
    () => readProducedImages('/tmp/outdir', {
      readdirSync: () => ['readme.txt'],
      statSync: () => ({ size: 1 }),
      readFileSync: () => Buffer.alloc(0),
    }),
    /produced no page images/,
  );
});

test('readProducedImages refuses a single over-cap image BEFORE reading it', () => {
  let read = false;
  assert.throws(
    () => readProducedImages('/tmp/outdir', {
      readdirSync: () => ['page-0001.png'],
      statSync: () => ({ size: MAX_IMAGE_BYTES + 1 }),
      readFileSync: () => { read = true; return Buffer.alloc(0); },
    }),
    /exceeds the \d+-byte per-image cap/,
  );
  assert.strictEqual(read, false, 'must refuse BEFORE reading the oversized file into memory');
});

test('readProducedImages refuses once the cumulative total would exceed the cap, before reading the offending file', () => {
  // Each file sits exactly AT the per-image cap (allowed individually), but
  // MAX_TOTAL_BYTES == 2 * MAX_IMAGE_BYTES, so a third file pushes the running
  // total over the cap without ever tripping the per-image check.
  const perFile = MAX_IMAGE_BYTES;
  const readNames = [];
  assert.throws(
    () => readProducedImages('/tmp/outdir', {
      readdirSync: () => ['page-0001.png', 'page-0002.png', 'page-0003.png'],
      statSync: () => ({ size: perFile }),
      readFileSync: (p) => { readNames.push(p); return Buffer.alloc(0); },
    }),
    /exceed the \d+-byte total cap/,
  );
  // The first two files fit (2 * MAX_IMAGE_BYTES == MAX_TOTAL_BYTES, not over)
  // and ARE read; the third pushes the cumulative total over the cap and must
  // be refused before its own read.
  assert.strictEqual(readNames.length, 2);
});

/* ---- isMcpContentPayload / wrapResult passthrough ---- */

test('isMcpContentPayload is true for a real MCP content payload', () => {
  assert.strictEqual(
    _internals.isMcpContentPayload({ content: [{ type: 'text', text: 'hi' }] }),
    true,
  );
  assert.strictEqual(
    _internals.isMcpContentPayload({
      content: [
        { type: 'text', text: 'hi' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      ],
    }),
    true,
  );
});

test('isMcpContentPayload is false for a plain string', () => {
  assert.strictEqual(_internals.isMcpContentPayload('# Some markdown'), false);
});

test('isMcpContentPayload is false for a plain object with no content[]', () => {
  assert.strictEqual(_internals.isMcpContentPayload({ path: 'wiki/foo.md', vault: 'x' }), false);
});

test('isMcpContentPayload is false when content is a string, not an array', () => {
  assert.strictEqual(_internals.isMcpContentPayload({ content: 'not-an-array' }), false);
});

test('isMcpContentPayload is false for null/undefined/empty content', () => {
  assert.strictEqual(_internals.isMcpContentPayload(null), false);
  assert.strictEqual(_internals.isMcpContentPayload(undefined), false);
  assert.strictEqual(_internals.isMcpContentPayload({ content: [] }), false);
});

/* ---- tool registration ---- */

test('pdf_to_images is registered in TOOLS with a handler, not a write tool', () => {
  const advertised = _internals.TOOLS.map((t) => t.name);
  assert.ok(advertised.includes('pdf_to_images'), 'missing TOOLS entry');
  assert.strictEqual(
    typeof _internals.TOOL_HANDLERS['pdf_to_images'],
    'function',
    'missing handler',
  );
  assert.strictEqual(
    _internals.WRITE_TOOL_NAMES.has('pdf_to_images'),
    false,
    'must not be a write tool — it touches no vault',
  );
});

test('pdf_to_images schema requires filepath', () => {
  const byName = Object.fromEntries(_internals.TOOLS.map((t) => [t.name, t]));
  assert.deepStrictEqual(byName['pdf_to_images'].inputSchema.required, ['filepath']);
});

test('pdfToImagesTool rejects a missing filepath before touching Python', async () => {
  await assert.rejects(() => pdfToImagesTool(null, {}), /Missing required argument: filepath/);
  await assert.rejects(() => pdfToImagesTool(null, { filepath: '' }), /Missing required argument: filepath/);
});

test('pdfToImagesTool returns the {content} payload from the injected runner', async () => {
  const out = await pdfToImagesTool(
    null,
    { filepath: '/tmp/report.pdf' },
    { run: async () => [{ name: 'page-0001.png', base64: 'ZZZZ' }] },
  );
  assert.ok(Array.isArray(out.content));
  assert.strictEqual(out.content[1].data, 'ZZZZ');
});
