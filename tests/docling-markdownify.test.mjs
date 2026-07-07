import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveDoclingPath } from '../src/markdownify/utils.mjs';
import { toMarkdownDocling, buildDoclingArgs } from '../src/markdownify/docling.mjs';

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
