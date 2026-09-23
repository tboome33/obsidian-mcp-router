/**
 * pptx-assets — unit + end-to-end coverage for the deck image extractor.
 *
 * The fixture deck is BUILT here with this repository's own deterministic
 * zip writer rather than committed as a binary. Three reasons, all of them
 * learned from rules already in AGENTS.md: the release scan reads `tests/`,
 * so a committed .pptx would have to earn its place on an export surface; a
 * binary fixture cannot be diffed when it starts failing; and building the
 * archive here lets a test assert the HOSTILE cases (a traversal target, an
 * external relationship) that no legitimately-authored deck contains.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createDeterministicZip } from '../src/helpers/deterministic-zip.mjs';
import { canonicalWorkspaceKey } from '../src/helpers/workspace-bindings.mjs';
import { homeSafeEnv } from './_home-safe-spawn.mjs';
import {
  extractPptxAssets,
  sniffExtension,
  slideNumberFromRelsName,
  imageTargetsFromRels,
  resolveRelTarget,
  decodeXmlText,
  resolveOutDirArg,
  excerpt,
  MAX_SOURCE_BYTES,
  MAX_RELS_MEMBERS,
} from '../src/markdownify/pptx-assets.mjs';
import { pptxExtractAssets } from '../src/tools/convert.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'obsidian-mcp-router.mjs');
const IMAGE_REL ='http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF = Buffer.from('GIF89a', 'latin1');
const JUNK = Buffer.from('not an image at all, just prose', 'utf8');

function rels(entries) {
  const body = entries
    .map((e) => {
      const mode = e.external ? ` TargetMode="External"` : '';
      return `<Relationship Id="${e.id}" Type="${e.type || IMAGE_REL}" Target="${e.target}"${mode}/>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`;
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-assets-test-'));
}

/** A deck: three slides, slide 1 and slide 3 share one PNG, slide 2 has a JPG. */
function buildDeck(extra = []) {
  return createDeterministicZip([
    { path: '[Content_Types].xml', content: '<Types/>' },
    { path: 'ppt/slides/slide1.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/slide2.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/slide3.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/_rels/slide1.xml.rels', content: rels([{ id: 'rId1', target: '../media/shared.png' }]) },
    { path: 'ppt/slides/_rels/slide2.xml.rels', content: rels([{ id: 'rId1', target: '../media/only2.jpg' }]) },
    { path: 'ppt/slides/_rels/slide3.xml.rels', content: rels([{ id: 'rId9', target: '../media/shared.png' }]) },
    { path: 'ppt/media/shared.png', content: PNG },
    { path: 'ppt/media/only2.jpg', content: JPG },
    ...extra,
  ]);
}

/* ---------------------------------------------------------------- units -- */

test('sniffExtension identifies formats by magic bytes, not by any name', () => {
  assert.strictEqual(sniffExtension(PNG), 'png');
  assert.strictEqual(sniffExtension(JPG), 'jpg');
  assert.strictEqual(sniffExtension(Buffer.from('GIF89a....', 'latin1')), 'gif');
  assert.strictEqual(sniffExtension(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])), 'webp');
  assert.strictEqual(sniffExtension(Buffer.from('  <svg xmlns="x"></svg>', 'utf8')), 'svg');
  assert.strictEqual(sniffExtension(JUNK), null, 'unknown bytes must be refused, never guessed');
  assert.strictEqual(sniffExtension(Buffer.alloc(0)), null);
  assert.strictEqual(sniffExtension('not a buffer'), null);
});

test('slideNumberFromRelsName accepts slides only, not layouts or notes', () => {
  assert.strictEqual(slideNumberFromRelsName('ppt/slides/_rels/slide12.xml.rels'), 12);
  assert.strictEqual(slideNumberFromRelsName('ppt/slideLayouts/_rels/slideLayout2.xml.rels'), null);
  assert.strictEqual(slideNumberFromRelsName('ppt/notesSlides/_rels/notesSlide1.xml.rels'), null);
  assert.strictEqual(slideNumberFromRelsName('ppt/slides/_rels/'), null);
});

test('imageTargetsFromRels reads attributes in any order and drops non-images', () => {
  const xml = rels([
    { id: 'rId1', target: '../media/a.png' },
    { id: 'rId2', target: '../slideLayouts/slideLayout1.xml', type: 'http://x/slideLayout' },
  ]);
  assert.deepStrictEqual(imageTargetsFromRels(xml), ['../media/a.png']);

  // python-pptx and PowerPoint emit these attributes in different orders.
  const reordered = '<Relationships><Relationship Target="../media/b.png" Type="' + IMAGE_REL + '" Id="rId7"/></Relationships>';
  assert.deepStrictEqual(imageTargetsFromRels(reordered), ['../media/b.png']);
});

test('imageTargetsFromRels refuses EXTERNAL relationships (they are URLs, not members)', () => {
  const xml = rels([{ id: 'rId1', target: 'https://example.com/x.png', external: true }]);
  assert.deepStrictEqual(imageTargetsFromRels(xml), [], 'an external target must not become a fetch');
});

test('resolveRelTarget resolves inside ppt/ and refuses traversal', () => {
  assert.strictEqual(resolveRelTarget('../media/image1.png'), 'ppt/media/image1.png');
  assert.strictEqual(resolveRelTarget('media/inline.png'), 'ppt/slides/media/inline.png');
  assert.strictEqual(resolveRelTarget('../../../../etc/passwd'), null);
  assert.strictEqual(resolveRelTarget('/etc/passwd'), null);
  // Inside the archive but outside ppt/: `ppt/slides/../../x` is `x`.
  assert.strictEqual(resolveRelTarget('../../docProps/core.xml'), null);
});

/* ------------------------------------------------------------ end-to-end -- */

test('extractPptxAssets writes each image once and maps it to every slide using it', () => {
  const dir = tmpdir();
  const deck = path.join(dir, 'deck.pptx');
  fs.writeFileSync(deck, buildDeck());
  const out = path.join(dir, 'assets');

  const res = extractPptxAssets({ filePath: deck, outDir: out });

  assert.strictEqual(res.slideCount, 3);
  assert.strictEqual(res.assetCount, 2, 'the shared image is written once, not twice');

  const shared = res.assets.find((a) => a.ext === 'png');
  assert.deepStrictEqual(shared.slides, [1, 3], 'both referencing slides are reported');
  assert.strictEqual(shared.name, 'slide1-1.png', 'named after the FIRST slide that uses it');

  const only2 = res.assets.find((a) => a.ext === 'jpg');
  assert.deepStrictEqual(only2.slides, [2]);
  assert.strictEqual(only2.name, 'slide2-1.jpg');

  // The bytes on disk are the bytes from the archive, not a re-encode.
  assert.deepStrictEqual(fs.readFileSync(shared.path), PNG);
  assert.deepStrictEqual(fs.readFileSync(only2.path), JPG);
  assert.strictEqual(res.totalBytes, PNG.length + JPG.length);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('extractPptxAssets is deterministic: the same deck yields the same names twice', () => {
  const dir = tmpdir();
  const deck = path.join(dir, 'deck.pptx');
  fs.writeFileSync(deck, buildDeck());

  const a = extractPptxAssets({ filePath: deck, outDir: path.join(dir, 'a') });
  const b = extractPptxAssets({ filePath: deck, outDir: path.join(dir, 'b') });

  assert.deepStrictEqual(
    a.assets.map((x) => [x.name, x.slides, x.sha256]),
    b.assets.map((x) => [x.name, x.slides, x.sha256]),
    're-ingesting a deck must not rewrite every image link in the vault',
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

test('extractPptxAssets refuses bytes it cannot identify instead of guessing an extension', () => {
  const dir = tmpdir();
  const deck = path.join(dir, 'deck.pptx');
  fs.writeFileSync(
    deck,
    createDeterministicZip([
      { path: 'ppt/slides/slide1.xml', content: '<p:sld/>' },
      { path: 'ppt/slides/_rels/slide1.xml.rels', content: rels([{ id: 'rId1', target: '../media/liar.png' }]) },
      { path: 'ppt/media/liar.png', content: JUNK },
    ]),
  );

  const res = extractPptxAssets({ filePath: deck, outDir: path.join(dir, 'out') });

  assert.strictEqual(res.assetCount, 0);
  assert.strictEqual(res.skipped.length, 1);
  assert.match(res.skipped[0].reason, /unrecognised image format/);
  assert.strictEqual(fs.readdirSync(path.join(dir, 'out')).length, 0, 'nothing is written for an unidentified entry');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('extractPptxAssets never lets an archive name reach the filesystem', () => {
  const dir = tmpdir();
  const deck = path.join(dir, 'deck.pptx');
  // Hostile AND legitimate in one deck. The legitimate half is what makes this
  // test bite: a first version referenced only the traversal target, so every
  // assertion still passed when the guard was removed (the escaping member is
  // absent from the archive either way, so nothing gets written with or
  // without it). Measured by mutation during review. With a real image
  // alongside, dropping the guard changes assetCount from 1 to 2.
  fs.writeFileSync(
    deck,
    createDeterministicZip([
      { path: 'ppt/slides/slide1.xml', content: '<p:sld/>' },
      {
        path: 'ppt/slides/_rels/slide1.xml.rels',
        content: rels([
          { id: 'rId1', target: '../../../../evil.png' },
          { id: 'rId2', target: '../media/innocent.png' },
        ]),
      },
      { path: 'ppt/media/innocent.png', content: PNG },
      { path: 'evil.png', content: JPG },
    ]),
  );

  const out = path.join(dir, 'out');
  const res = extractPptxAssets({ filePath: deck, outDir: out });

  assert.strictEqual(res.assetCount, 1, 'only the legitimate image is written');
  assert.strictEqual(res.assets[0].ext, 'png');
  assert.ok(
    res.skipped.some((s) => /image target refused \(absolute, outside ppt\/, over 9216 characters as written, or over 1024 once resolved\): \.\.\/\.\.\/\.\.\/\.\.\/evil\.png/.test(s.reason)),
    'the refused target is SAID, not silently dropped',
  );
  for (const name of fs.readdirSync(out)) {
    assert.ok(!name.includes('..') && !path.isAbsolute(name), 'unsafe output name: ' + name);
  }
  assert.strictEqual(fs.existsSync(path.join(dir, 'evil.png')), false);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('extractPptxAssets honours the asset cap and says what it skipped', () => {
  const dir = tmpdir();
  const deck = path.join(dir, 'deck.pptx');
  fs.writeFileSync(deck, buildDeck());

  const res = extractPptxAssets({ filePath: deck, outDir: path.join(dir, 'out'), maxAssets: 1 });

  assert.strictEqual(res.assetCount, 1);
  assert.strictEqual(res.skipped.length, 1);
  assert.match(res.skipped[0].reason, /asset cap reached \(1\)/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('extractPptxAssets honours the total byte cap', () => {
  const dir = tmpdir();
  const deck = path.join(dir, 'deck.pptx');
  fs.writeFileSync(deck, buildDeck());

  const res = extractPptxAssets({ filePath: deck, outDir: path.join(dir, 'out'), maxTotalBytes: PNG.length });

  assert.strictEqual(res.assetCount, 1, 'the first image fits, the second does not');
  assert.match(res.skipped[0].reason, /total byte cap reached/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('extractPptxAssets defaults to a fresh temp directory when no outDir is given', () => {
  const dir = tmpdir();
  const deck = path.join(dir, 'deck.pptx');
  fs.writeFileSync(deck, buildDeck());

  const res = extractPptxAssets({ filePath: deck });

  assert.ok(res.outDir.startsWith(os.tmpdir()), 'output must land under the temp root');
  assert.notStrictEqual(res.outDir, dir);
  assert.strictEqual(res.assetCount, 2);

  fs.rmSync(res.outDir, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('extractPptxAssets rejects a missing or non-string filepath, and a non-ZIP file', () => {
  assert.throws(() => extractPptxAssets({}), /filepath is required/);
  assert.throws(() => extractPptxAssets({ filePath: '   ' }), /filepath is required/);

  const dir = tmpdir();
  const notADeck = path.join(dir, 'deck.pptx');
  fs.writeFileSync(notADeck, 'this is plain text, not a package');
  assert.throws(() => extractPptxAssets({ filePath: notADeck }), /not a readable PPTX/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('extractPptxAssets obeys MD_ALLOWED_PATHS on the READ and the WRITE side', () => {
  const sandbox = tmpdir();
  const outside = tmpdir();
  const deck = path.join(sandbox, 'deck.pptx');
  fs.writeFileSync(deck, buildDeck());

  const old = process.env.MD_ALLOWED_PATHS;
  try {
    process.env.MD_ALLOWED_PATHS = sandbox;

    // Inside the sandbox: allowed.
    const ok = extractPptxAssets({ filePath: deck, outDir: path.join(sandbox, 'out') });
    assert.strictEqual(ok.assetCount, 2);

    // Reading a deck from outside: refused.
    const strayDeck = path.join(outside, 'deck.pptx');
    fs.writeFileSync(strayDeck, buildDeck());
    assert.throws(
      () => extractPptxAssets({ filePath: strayDeck, outDir: path.join(sandbox, 'out2') }),
      /outside the allowed directories/,
    );

    // Writing outside the sandbox: refused too — the gate is not read-only.
    assert.throws(
      () => extractPptxAssets({ filePath: deck, outDir: path.join(outside, 'out') }),
      /outside the allowed directories/,
    );
  } finally {
    if (old !== undefined) process.env.MD_ALLOWED_PATHS = old;
    else delete process.env.MD_ALLOWED_PATHS;
  }

  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

/* -------------------------------------------------- review follow-ups -- */

/** A deck whose PRESENTATION order differs from its slide FILE numbers. */
function buildReorderedDeck() {
  const presRels = [
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rA" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>',
    '<Relationship Id="rB" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>',
    '<Relationship Id="rC" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide3.xml"/>',
    '</Relationships>',
  ].join('');
  // Shown order: slide3, slide1, slide2.
  const presentation =
    '<p:presentation><p:sldIdLst>'
    + '<p:sldId id="256" r:id="rC"/><p:sldId id="257" r:id="rA"/><p:sldId id="258" r:id="rB"/>'
    + '</p:sldIdLst></p:presentation>';
  return createDeterministicZip([
    { path: 'ppt/presentation.xml', content: presentation },
    { path: 'ppt/_rels/presentation.xml.rels', content: presRels },
    { path: 'ppt/slides/slide1.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/slide2.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/slide3.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/_rels/slide1.xml.rels', content: rels([{ id: 'r1', target: '../media/a.png' }]) },
    { path: 'ppt/slides/_rels/slide2.xml.rels', content: rels([{ id: 'r1', target: '../media/b.jpg' }]) },
    { path: 'ppt/slides/_rels/slide3.xml.rels', content: rels([{ id: 'r1', target: '../media/c.gif' }]) },
    { path: 'ppt/media/a.png', content: PNG },
    { path: 'ppt/media/b.jpg', content: JPG },
    { path: 'ppt/media/c.gif', content: GIF },
  ]);
}

test('slide numbers are the RUNNING ORDER, not the slide file number', () => {
  const dir = tmpdir();
  const deck = path.join(dir, 'deck.pptx');
  fs.writeFileSync(deck, buildReorderedDeck());

  const res = extractPptxAssets({ filePath: deck, outDir: path.join(dir, 'out') });

  assert.strictEqual(res.orderSource, 'presentation');
  assert.strictEqual(res.orderFallbackReason, undefined, 'no fallback, no reason');
  assert.strictEqual(res.slideCount, 3);
  // slide3.xml is shown FIRST, so its gif must be position 1 — keying on the
  // file number would call it 3, and an ingestion skill would then file the
  // picture under the wrong heading.
  const byExt = Object.fromEntries(res.assets.map((a) => [a.ext, a.slides]));
  assert.deepStrictEqual(byExt.gif, [1], 'slide3.xml is shown first');
  assert.deepStrictEqual(byExt.png, [2], 'slide1.xml is shown second');
  assert.deepStrictEqual(byExt.jpg, [3], 'slide2.xml is shown third');
  assert.ok(res.assets.some((a) => a.name === 'slide1-1.gif'));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a deck with no readable presentation part falls back to file numbers and SAYS so', () => {
  const dir = tmpdir();
  const deck = path.join(dir, 'deck.pptx');
  fs.writeFileSync(deck, buildDeck());

  const res = extractPptxAssets({ filePath: deck, outDir: path.join(dir, 'out') });

  assert.strictEqual(res.orderSource, 'file-number', 'the fallback is reported, not hidden');
  assert.strictEqual(res.orderFallbackReason, 'no ppt/presentation.xml in the archive', 'and so is its cause');
  assert.strictEqual(res.assetCount, 2);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('identical bytes under two different members are written ONCE', () => {
  const dir = tmpdir();
  const deck = path.join(dir, 'deck.pptx');
  // PowerPoint routinely stores one picture under two members. Keying dedup on
  // the member name gave the vault two files carrying the same sha256.
  fs.writeFileSync(
    deck,
    createDeterministicZip([
      { path: 'ppt/slides/slide1.xml', content: '<p:sld/>' },
      { path: 'ppt/slides/slide2.xml', content: '<p:sld/>' },
      { path: 'ppt/slides/_rels/slide1.xml.rels', content: rels([{ id: 'r1', target: '../media/one.png' }]) },
      { path: 'ppt/slides/_rels/slide2.xml.rels', content: rels([{ id: 'r1', target: '../media/two.png' }]) },
      { path: 'ppt/media/one.png', content: PNG },
      { path: 'ppt/media/two.png', content: PNG },
    ]),
  );

  const out = path.join(dir, 'out');
  const res = extractPptxAssets({ filePath: deck, outDir: out });

  assert.strictEqual(res.assetCount, 1, 'one file for one image');
  assert.deepStrictEqual(res.assets[0].slides, [1, 2], 'both slides are credited');
  assert.deepStrictEqual(res.assets[0].members.slice().sort(), ['ppt/media/one.png', 'ppt/media/two.png']);
  assert.strictEqual(fs.readdirSync(out).length, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a picture is named after the FIRST slide that shows it, whatever its members are called', () => {
  // `a.png` sorts first by name but shows on slide 2; its duplicate `z.png`
  // shows on slide 1. Members are processed by lowest slide, so the one file
  // is named for slide 1.
  const res = runDeck(createDeterministicZip([
    { path: 'ppt/slides/slide1.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/slide2.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/_rels/slide1.xml.rels', content: rels([{ id: 'r1', target: '../media/z.png' }]) },
    { path: 'ppt/slides/_rels/slide2.xml.rels', content: rels([{ id: 'r1', target: '../media/a.png' }]) },
    { path: 'ppt/media/a.png', content: PNG },
    { path: 'ppt/media/z.png', content: PNG },
  ]));
  assert.deepStrictEqual(res.assets.map((a) => [a.name, a.slides]), [['slide1-1.png', [1, 2]]]);
});

test('the rels parser reads quote styles, namespace prefixes, comments and encodings', () => {
  assert.deepStrictEqual(
    imageTargetsFromRels("<Relationships><Relationship Id='r1' Type='" + IMAGE_REL + "' Target='../media/a.png'/></Relationships>"),
    ['../media/a.png'],
    'single-quoted attributes are legal XML',
  );
  assert.deepStrictEqual(
    imageTargetsFromRels('<pr:Relationships><pr:Relationship Id="r1" Type="' + IMAGE_REL + '" Target="../media/a.png"/></pr:Relationships>'),
    ['../media/a.png'],
    'a namespace-prefixed element is still a Relationship',
  );
  assert.deepStrictEqual(
    imageTargetsFromRels('<Relationships><!-- <Relationship Id="r1" Type="' + IMAGE_REL + '" Target="../media/ghost.png"/> --></Relationships>'),
    [],
    'a commented-out relationship is not a relationship',
  );
  assert.deepStrictEqual(
    imageTargetsFromRels('<Relationships><Relationship Id="r1" Type="' + IMAGE_REL + '" Target="../media/a&amp;b.png"/></Relationships>'),
    ['../media/a&b.png'],
    'XML entities are decoded',
  );
  assert.strictEqual(
    resolveRelTarget('../media/my%20image.png'),
    'ppt/media/my image.png',
    'OPC part names are percent-encoded URI references',
  );
});

test('decodeXmlText handles the five predefined entities and numeric references', () => {
  assert.strictEqual(decodeXmlText('a&amp;b&lt;c&gt;d&quot;e&apos;f'), 'a&b<c>d"e' + "'" + 'f');
  assert.strictEqual(decodeXmlText('&#65;&#x42;'), 'AB');
});

test('sniffExtension needs BOTH EMF markers, not just the common 01 00 00 00 prefix', () => {
  const notEmf = Buffer.concat([Buffer.from([0x01, 0x00, 0x00, 0x00]), Buffer.from('AB')]);
  assert.strictEqual(sniffExtension(notEmf), null, 'a bare little-endian 1 identifies nothing');

  const emf = Buffer.alloc(48);
  emf.writeUInt32LE(1, 0);
  emf.writeUInt32LE(0x464d4520, 40); // ' EMF'
  assert.strictEqual(sniffExtension(emf), 'emf');
});

test('a byte cap below the first image writes nothing, and stops the run', () => {
  const dir = tmpdir();
  const deck = path.join(dir, 'deck.pptx');
  fs.writeFileSync(deck, buildDeck());

  // Below the first image's own size: nothing may be written at all.
  const res = extractPptxAssets({ filePath: deck, outDir: path.join(dir, 'out'), maxTotalBytes: 1 });

  assert.strictEqual(res.assetCount, 0);
  assert.strictEqual(res.totalBytes, 0);
  assert.ok(res.skipped.length > 0);
  // The WRITE cap: the inflation budget is a separate, fixed bound, so a tiny
  // write cap still lets the tool read (and recognise) what it will not write.
  assert.ok(res.skipped.every((s) => /total byte cap reached/.test(s.reason)), JSON.stringify(res.skipped));
  assert.strictEqual(fs.readdirSync(path.join(dir, 'out')).length, 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('caller-supplied caps are clamped to the module ceilings, never raised', () => {
  const dir = tmpdir();
  const deck = path.join(dir, 'deck.pptx');
  fs.writeFileSync(deck, buildDeck());

  // A caller asking for a terabyte must not disable the guard.
  const res = extractPptxAssets({
    filePath: deck,
    outDir: path.join(dir, 'out'),
    maxAssets: 1e9,
    maxTotalBytes: 1e12,
  });
  assert.strictEqual(res.assetCount, 2, 'the deck is small, so both still fit');

  // Garbage is REFUSED with a message, not clamped into a silent near-zero
  // budget. Same precedent as download_page_assets, whose maxAssets: 0 used to
  // read as "the tool is broken".
  assert.throws(
    () => extractPptxAssets({ filePath: deck, outDir: path.join(dir, 'out2'), maxAssets: Number.NaN }),
    /max_assets must be a positive integer/,
  );
  assert.throws(
    () => extractPptxAssets({ filePath: deck, outDir: path.join(dir, 'out3'), maxTotalBytes: -5 }),
    /max_total_bytes must be a positive integer/,
  );
  assert.throws(
    () => extractPptxAssets({ filePath: deck, outDir: path.join(dir, 'out4'), maxAssets: 0 }),
    /max_assets must be a positive integer/,
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a pre-existing symlink at an output name is replaced, not followed', (t) => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const deck = path.join(dir, 'deck.pptx');
  fs.writeFileSync(deck, buildDeck());
  const out = path.join(dir, 'out');
  fs.mkdirSync(out, { recursive: true });

  const victim = path.join(dir, 'victim.txt');
  fs.writeFileSync(victim, 'precious');
  // Windows without developer mode refuses to create one: SAID, not passed.
  try { fs.symlinkSync(victim, path.join(out, 'slide1-1.png')); }
  catch (e) { t.skip(`cannot create a file symlink here: ${e.code} — the no-follow write was not exercised`); return; }

  const res = extractPptxAssets({ filePath: deck, outDir: out });
  assert.strictEqual(res.assetCount, 2);
  assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'precious', 'the link target must be untouched');
  assert.ok(!fs.lstatSync(path.join(out, 'slide1-1.png')).isSymbolicLink());
});

test('the dispatcher authorisation reaches the pin: asked about the REAL outdir, through the module and through the MCP wrapper', async (t) => {
  const dir = fs.realpathSync.native(tmpdir());
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const deck = path.join(dir, 'deck.pptx');
  fs.writeFileSync(deck, buildDeck());

  const seen = [];
  extractPptxAssets({ filePath: deck, outDir: path.join(dir, 'a'), authorizeOutDir: (p) => seen.push(p) });
  assert.deepEqual(seen, [path.join(dir, 'a')]);

  const viaWrapper = [];
  await pptxExtractAssets(null, { filepath: deck, outdir: path.join(dir, 'b') }, { authorizeOutputDir: (p) => viaWrapper.push(p) });
  assert.deepEqual(viaWrapper, [path.join(dir, 'b')]);

  assert.throws(
    () => extractPptxAssets({ filePath: deck, outDir: path.join(dir, 'refused'), authorizeOutDir: () => { throw new Error('NOT HERE'); } }),
    /NOT HERE/,
  );
  assert.equal(fs.existsSync(path.join(dir, 'refused')), false, 'a refusal creates nothing');
});

test('the internal pin options cannot be reached through MCP arguments', async (t) => {
  // `pinStrategy` and `nativeHelper` exist for tests; an MCP caller naming
  // them must reach nothing — a bogus strategy would throw "unknown pin
  // strategy" if it travelled.
  const dir = fs.realpathSync.native(tmpdir());
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const deck = path.join(dir, 'deck.pptx');
  fs.writeFileSync(deck, buildDeck());
  const res = await pptxExtractAssets(
    null,
    { filepath: deck, outdir: path.join(dir, 'out'), pinStrategy: 'bogus', nativeHelper: null, strategy: 'bogus', authorizeOutDir: () => { throw new Error('forged'); } },
    { authorizeOutputDir: () => {} },
  );
  assert.equal(res.assetCount, 2);
});

test('through an ALIAS, the manifest names the pinned real directory — where the files are', (t) => {
  const dir = fs.realpathSync.native(tmpdir());
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const deck = path.join(dir, 'deck.pptx');
  fs.writeFileSync(deck, buildDeck());
  const real = path.join(dir, 'real');
  fs.mkdirSync(real);
  try { fs.symlinkSync(real, path.join(dir, 'alias'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) { t.skip(`cannot create a directory link: ${e.code}`); return; }
  const res = extractPptxAssets({ filePath: deck, outDir: path.join(dir, 'alias', 'out') });
  assert.equal(res.outDir, path.join(real, 'out'));
  for (const a of res.assets) assert.equal(path.dirname(a.path), path.join(real, 'out'));
});

test('with no outdir, a REFUSED authorisation leaves no temp directory behind (it used to be mkdtemp\'d first)', (t) => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const deck = path.join(dir, 'deck.pptx');
  fs.writeFileSync(deck, buildDeck());
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('pptx-assets-')));
  const seen = [];
  assert.throws(
    () => extractPptxAssets({ filePath: deck, authorizeOutDir: (p) => { seen.push(p); throw new Error('NOT HERE'); } }),
    /NOT HERE/,
  );
  assert.equal(seen.length, 1);
  assert.equal(path.basename(seen[0]).startsWith('pptx-assets-'), true, 'the temp directory about to be created is what was judged');
  const created = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('pptx-assets-') && !before.has(n));
  assert.deepEqual(created, [], 'nothing was created before the refusal');
});

test('createOnly: a DANGLING link at an output name creates nothing where it points (wx followed it on Windows)', (t) => {
  // Measured 2026-09-23 on NTFS: `writeFileSync(name, bytes, { flag: 'wx' })`
  // over a dangling file symlink CREATED the link's target. The pinned writer
  // places by hard link from a temporary, which never follows the name.
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const deck = path.join(dir, 'deck.pptx');
  fs.writeFileSync(deck, buildDeck());
  const out = path.join(dir, 'out');
  fs.mkdirSync(out);
  const target = path.join(dir, 'created-through-the-link.png');
  try { fs.symlinkSync(target, path.join(out, 'slide1-1.png'), 'file'); }
  catch (e) { t.skip(`cannot create a file symlink here: ${e.code}`); return; }

  const res = extractPptxAssets({ filePath: deck, outDir: out, createOnly: true });
  assert.strictEqual(fs.existsSync(target), false, 'nothing was created through the link');
  const png = res.assets.find((a) => a.ext === 'png');
  assert.match(png.name, /^slide1-[0-9a-f]{16}\.png$/, 'the link holds the name; the hashed name is used');
  assert.ok(fs.lstatSync(path.join(out, 'slide1-1.png')).isSymbolicLink(), 'the link itself is left alone');
});

test('a source file over the ceiling is refused before it is read', () => {
  const dir = tmpdir();
  const huge = path.join(dir, 'huge.pptx');
  fs.writeFileSync(huge, 'x');
  // Grow the file sparsely to just over the ceiling without allocating it.
  const fd = fs.openSync(huge, 'r+');
  fs.ftruncateSync(fd, MAX_SOURCE_BYTES + 1);
  fs.closeSync(fd);

  assert.throws(() => extractPptxAssets({ filePath: huge }), /over the .* ceiling/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a ~ in filepath is expanded against the overridden home, not the real one', () => {
  const home = tmpdir();
  const deck = path.join(home, 'deck.pptx');
  fs.writeFileSync(deck, buildDeck());

  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH,
  };
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.HOMEDRIVE;
    delete process.env.HOMEPATH;

    const res = extractPptxAssets({ filePath: '~/deck.pptx', outDir: path.join(home, 'out') });
    assert.strictEqual(res.assetCount, 2);
    assert.strictEqual(res.source, fs.realpathSync(deck));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  fs.rmSync(home, { recursive: true, force: true });
});

test('the tool is registered AND listed in WRITE_TOOL_NAMES', async () => {
  // Mirrors tests/download-page-assets.test.mjs:200. The review that added
  // this found the tool absent from the set while the ingestion skill aimed
  // its `outdir` at the vault — so OBSIDIAN_ROUTER_READONLY stopped meaning
  // read-only. A membership test is the only thing that keeps the two in step.
  const mod = await import('../src/index.mjs');
  const toolNames = mod._internals.TOOLS.map((x) => x.name);
  assert.ok(toolNames.includes('pptx_extract_assets'), 'present in the catalog');
  assert.ok(
    mod._internals.WRITE_TOOL_NAMES.has('pptx_extract_assets'),
    'it writes binary files through an argument path, exactly like download_page_assets',
  );
});

test('createOnly leaves an existing image alone and reports it', () => {
  const dir = tmpdir();
  const deck = path.join(dir, 'deck.pptx');
  fs.writeFileSync(deck, buildDeck());
  const out = path.join(dir, 'out');
  fs.mkdirSync(out, { recursive: true });

  // Someone got there first — a previous ingest, or a human who edited the
  // picture. createOnly is the shared-vault precondition precisely because it
  // promises this file survives.
  const squatter = path.join(out, 'slide1-1.png');
  fs.writeFileSync(squatter, 'edited by a human');

  const res = extractPptxAssets({ filePath: deck, outDir: out, createOnly: true });

  assert.strictEqual(fs.readFileSync(squatter, 'utf8'), 'edited by a human', 'never overwritten');
  // The deck's picture still gets a file — under its content-hash name, the
  // same fallback download_page_assets uses — so the manifest can link it.
  const png = res.assets.find((a) => a.ext === 'png');
  assert.match(png.name, /^slide1-[0-9a-f]{16}\.png$/);
  assert.deepStrictEqual(fs.readFileSync(png.path), PNG);
  assert.strictEqual(res.assetCount, 2);

  // Both names taken by other bytes: reported, never overwritten.
  fs.writeFileSync(path.join(out, png.name), 'also edited');
  const blocked = extractPptxAssets({ filePath: deck, outDir: out, createOnly: true });
  assert.ok(
    blocked.skipped.some((s) => /name taken by different content, left untouched \(createOnly\)/.test(s.reason)),
    'the skip is reported, not silent',
  );
  assert.strictEqual(fs.readFileSync(path.join(out, png.name), 'utf8'), 'also edited');

  // Without createOnly the same call replaces it — that is the contrast that
  // makes the flag mean something.
  const res2 = extractPptxAssets({ filePath: deck, outDir: out });
  assert.strictEqual(res2.assetCount, 2);
  assert.deepStrictEqual(fs.readFileSync(squatter), PNG, 'the default mode does overwrite');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('createOnly re-run into its own output: same names, every image listed, nothing new written', () => {
  // The re-ingest of one deck into a SHARED vault, where createOnly is
  // mandatory. Slide 1 holds image A under two members (deduplicated) and a
  // second image B. The first version listed A and B as skipped on the second
  // run — every link lost — and the unregistered duplicate of A took B's name,
  // pushing B onto a third file.
  const A = Buffer.concat([PNG, Buffer.from([1, 1, 1])]);
  const B = Buffer.concat([PNG, Buffer.from([2, 2, 2])]);
  const dir = tmpdir();
  const deck = path.join(dir, 'deck.pptx');
  fs.writeFileSync(deck, createDeterministicZip([
    { path: 'ppt/slides/slide1.xml', content: '<p:sld/>' },
    {
      path: 'ppt/slides/_rels/slide1.xml.rels',
      content: rels([
        { id: 'r1', target: '../media/a1.png' },
        { id: 'r2', target: '../media/a2.png' },
        { id: 'r3', target: '../media/b.png' },
      ]),
    },
    { path: 'ppt/media/a1.png', content: A },
    { path: 'ppt/media/a2.png', content: A },
    { path: 'ppt/media/b.png', content: B },
  ]));
  const out = path.join(dir, 'out');
  const view = (r) => r.assets.map((a) => [a.name, a.sha256]);

  const first = extractPptxAssets({ filePath: deck, outDir: out, createOnly: true });
  const second = extractPptxAssets({ filePath: deck, outDir: out, createOnly: true });

  assert.deepStrictEqual(view(second), view(first), 'the same names map to the same images');
  assert.ok(second.assets.every((a) => a.alreadyPresent === true));
  assert.ok(first.assets.every((a) => a.alreadyPresent === undefined));
  assert.deepStrictEqual(second.skipped, []);
  assert.strictEqual(second.totalBytes, 0, 'nothing was written the second time');
  assert.deepStrictEqual(fs.readdirSync(out).sort(), ['slide1-1.png', 'slide1-2.png']);

  fs.rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------- Codex round 1 repairs -- */

test('a slide file number that is not a small positive integer is not a slide', () => {
  assert.strictEqual(slideNumberFromRelsName(`ppt/slides/_rels/slide${'9'.repeat(400)}.xml.rels`), null, 'Infinity is not a slide');
  assert.strictEqual(slideNumberFromRelsName('ppt/slides/_rels/slide0.xml.rels'), null);
  assert.strictEqual(slideNumberFromRelsName('ppt/slides/_rels/slide007.xml.rels'), null);
  assert.strictEqual(slideNumberFromRelsName('ppt/slides/_rels/slide999999.xml.rels'), 999999);
});

test('the running order reads a relationship id under ANY prefix, and an unresolvable entry keeps its position', () => {
  const dir = tmpdir();
  const deck = path.join(dir, 'deck.pptx');
  const presRels = '<Relationships>'
    + '<Relationship Id="rA" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>'
    + '<Relationship Id="rB" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>'
    + '</Relationships>';
  // `q` is bound to the relationships namespace; `x` is an extension namespace.
  // First entry: the numeric `id`, then an `x:id` decoy, THEN the real `q:id`.
  // Second entry: a relationship id that resolves to nothing — a gap.
  // Third entry: `q:id` again. Fourth: unresolvable, trailing — still counted.
  const presentation = '<p:presentation'
    + ' xmlns:q="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
    + ' xmlns:x="urn:example:extension"><p:sldIdLst>'
    + '<p:sldId id="256" x:id="rB" q:id="rA"/><p:sldId id="257" q:id="rGone"/>'
    + '<p:sldId id="258" q:id="rB"/><p:sldId id="259" q:id="rAlsoGone"/>'
    + '</p:sldIdLst></p:presentation>';
  fs.writeFileSync(deck, createDeterministicZip([
    { path: 'ppt/presentation.xml', content: presentation },
    { path: 'ppt/_rels/presentation.xml.rels', content: presRels },
    { path: 'ppt/slides/slide1.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/slide2.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/_rels/slide1.xml.rels', content: rels([{ id: 'r1', target: '../media/a.png' }]) },
    { path: 'ppt/slides/_rels/slide2.xml.rels', content: rels([{ id: 'r1', target: '../media/b.jpg' }]) },
    { path: 'ppt/media/a.png', content: PNG },
    { path: 'ppt/media/b.jpg', content: JPG },
  ]));

  const res = extractPptxAssets({ filePath: deck, outDir: path.join(dir, 'out') });

  assert.strictEqual(res.orderSource, 'presentation');
  const byExt = Object.fromEntries(res.assets.map((a) => [a.ext, a.slides]));
  assert.deepStrictEqual(byExt.png, [1], 'q:id="rA" is the relationship id; neither id="256" nor the x:id decoy is');
  assert.deepStrictEqual(byExt.jpg, [3], 'the unresolvable second entry still occupies position 2');
  assert.strictEqual(res.slideCount, 4, 'the trailing unresolvable entry is still a slide');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('namespace scope: a prefix REBOUND on the slide entry itself is not the relationships prefix there', () => {
  const dir = tmpdir();
  const deck = path.join(dir, 'deck.pptx');
  const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const presRels = '<Relationships>'
    + '<Relationship Id="rA" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>'
    + '<Relationship Id="rB" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>'
    + '</Relationships>';
  // The root binds BOTH x and r to the relationships namespace; the first
  // entry rebinds x to an extension and carries x:id="rB" before r:id="rA".
  const presentation = `<p:presentation xmlns:x="${REL_NS}" xmlns:r="${REL_NS}"><p:sldIdLst>`
    + '<p:sldId xmlns:x="urn:example:extension" id="256" x:id="rB" r:id="rA"/>'
    // The rebinding ends with its element: here x is the relationships
    // namespace again (bound on the root), so x:id IS the relationship id.
    + '<p:sldId id="257" x:id="rB"/>'
    + '</p:sldIdLst></p:presentation>';
  fs.writeFileSync(deck, createDeterministicZip([
    { path: 'ppt/presentation.xml', content: presentation },
    { path: 'ppt/_rels/presentation.xml.rels', content: presRels },
    { path: 'ppt/slides/slide1.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/slide2.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/_rels/slide1.xml.rels', content: rels([{ id: 'r1', target: '../media/a.png' }]) },
    { path: 'ppt/slides/_rels/slide2.xml.rels', content: rels([{ id: 'r1', target: '../media/b.jpg' }]) },
    { path: 'ppt/media/a.png', content: PNG },
    { path: 'ppt/media/b.jpg', content: JPG },
  ]));

  const res = extractPptxAssets({ filePath: deck, outDir: path.join(dir, 'out') });

  const byExt = Object.fromEntries(res.assets.map((a) => [a.ext, a.slides]));
  assert.deepStrictEqual(byExt.png, [1], 'on the first entry x is the extension namespace; r:id="rA" is the relationship');
  assert.deepStrictEqual(byExt.jpg, [2]);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('XML reads are charged to the same budget: a slide whose relationships cannot be afforded is REPORTED', () => {
  const dir = tmpdir();
  const deck = path.join(dir, 'deck.pptx');
  const r1 = rels([{ id: 'r1', target: '../media/a.png' }]);
  fs.writeFileSync(deck, createDeterministicZip([
    { path: 'ppt/slides/slide1.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/slide2.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/_rels/slide1.xml.rels', content: r1 },
    { path: 'ppt/slides/_rels/slide2.xml.rels', content: rels([{ id: 'r1', target: '../media/b.jpg' }]) },
    { path: 'ppt/media/a.png', content: PNG },
    { path: 'ppt/media/b.jpg', content: JPG },
  ]));

  // Enough for slide 1's rels and nothing more: slide 2's rels are not read.
  const res = extractPptxAssets({ filePath: deck, outDir: path.join(dir, 'out'), maxInflateBytes: Buffer.byteLength(r1) + 1 });

  const lost = res.skipped.find((s) => s.member === 'ppt/slides/_rels/slide2.xml.rels');
  assert.ok(lost, JSON.stringify(res.skipped));
  assert.match(lost.reason, /slide relationships not read: inflation budget reached/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('without a running order, a relationships part whose slide does not exist is not a slide', () => {
  const dir = tmpdir();
  const deck = path.join(dir, 'deck.pptx');
  fs.writeFileSync(deck, createDeterministicZip([
    { path: 'ppt/slides/slide1.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/_rels/slide1.xml.rels', content: rels([{ id: 'r1', target: '../media/a.png' }]) },
    // slide7.xml does not exist: an orphan relationships part.
    { path: 'ppt/slides/_rels/slide7.xml.rels', content: rels([{ id: 'r1', target: '../media/b.jpg' }]) },
    { path: 'ppt/media/a.png', content: PNG },
    { path: 'ppt/media/b.jpg', content: JPG },
  ]));

  const res = extractPptxAssets({ filePath: deck, outDir: path.join(dir, 'out') });

  assert.strictEqual(res.orderSource, 'file-number');
  assert.deepStrictEqual(res.assets.map((a) => [a.ext, a.slides]), [['png', [1]]], 'the orphan contributes nothing');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('lexical: constructs are consumed in document order, and attributes as whole tokens', () => {
  const dir = tmpdir();
  const deck = path.join(dir, 'deck.pptx');
  const presRels = '<Relationships>'
    + '<Relationship Id="rA" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>'
    + '<Relationship Id="rB" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>'
    + '</Relationships>';
  // 1. A PI whose body contains `<!--`, then a REAL entry, then a comment:
  //    three sequential passes let the comment pass eat the real entry.
  // 2. An attribute VALUE that looks like `r:id='rB'`, and a `>` inside a
  //    value, before the real r:id.
  const presentation = '<p:presentation><p:sldIdLst>'
    + '<?probe <!-- ?><p:sldId id="256" r:id="rA"/><!-- end -->'
    + '<p:sldId id="257" x:note=" r:id=\'rA\' >" r:id="rB"/>'
    + '</p:sldIdLst></p:presentation>';
  fs.writeFileSync(deck, createDeterministicZip([
    { path: 'ppt/presentation.xml', content: presentation },
    { path: 'ppt/_rels/presentation.xml.rels', content: presRels },
    { path: 'ppt/slides/slide1.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/slide2.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/_rels/slide1.xml.rels', content: rels([{ id: 'r1', target: '../media/a.png' }]) },
    { path: 'ppt/slides/_rels/slide2.xml.rels', content: rels([{ id: 'r1', target: '../media/b.jpg' }]) },
    { path: 'ppt/media/a.png', content: PNG },
    { path: 'ppt/media/b.jpg', content: JPG },
  ]));

  const res = extractPptxAssets({ filePath: deck, outDir: path.join(dir, 'out') });

  const byExt = Object.fromEntries(res.assets.map((a) => [a.ext, a.slides]));
  assert.deepStrictEqual(byExt.png, [1], 'the real first entry survives the PI and the comment');
  assert.deepStrictEqual(byExt.jpg, [2], 'r:id is the attribute, not text inside x:note');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('tokenizer: a Unicode namespace prefix does not stop the attribute scan', () => {
  const eAcute = String.fromCharCode(0xe9); // built, not escaped (repo rule)
  const xml = '<Relationships><Relationship xmlns:' + eAcute + '="urn:unused" Id="r1" Type="' + IMAGE_REL
    + '" Target="../media/a.png"/></Relationships>';
  assert.deepStrictEqual(imageTargetsFromRels(xml), ['../media/a.png']);
});

test('entities are decoded ONCE: &#38;amp; is the text &amp;', () => {
  assert.strictEqual(decodeXmlText('a&#38;amp;b'), 'a&amp;b');
  assert.strictEqual(decodeXmlText('&#x26;lt;'), '&lt;');
  assert.throws(() => decodeXmlText('&#x110000;'), /malformed XML/);
});

test('UTF-16 parts are read: a UTF-16LE relationships part and a UTF-16BE presentation', () => {
  const dir = tmpdir();
  const deck = path.join(dir, 'deck.pptx');
  const utf16le = (s) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);
  const utf16beNoBom = (s) => { const b = Buffer.from(s, 'utf16le'); b.swap16(); return b; };
  const presRels = '<Relationships>'
    + '<Relationship Id="rA" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>'
    + '<Relationship Id="rB" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>'
    + '</Relationships>';
  const presentation = '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rB"/><p:sldId id="257" r:id="rA"/></p:sldIdLst></p:presentation>';
  fs.writeFileSync(deck, createDeterministicZip([
    { path: 'ppt/presentation.xml', content: utf16beNoBom(presentation) },
    { path: 'ppt/_rels/presentation.xml.rels', content: presRels },
    { path: 'ppt/slides/slide1.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/slide2.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/_rels/slide1.xml.rels', content: utf16le(rels([{ id: 'r1', target: '../media/a.png' }])) },
    { path: 'ppt/slides/_rels/slide2.xml.rels', content: rels([{ id: 'r1', target: '../media/b.jpg' }]) },
    { path: 'ppt/media/a.png', content: PNG },
    { path: 'ppt/media/b.jpg', content: JPG },
  ]));

  const res = extractPptxAssets({ filePath: deck, outDir: path.join(dir, 'out') });

  assert.strictEqual(res.orderSource, 'presentation', res.orderFallbackReason);
  const byExt = Object.fromEntries(res.assets.map((a) => [a.ext, a.slides]));
  assert.deepStrictEqual(byExt.png, [2], 'the UTF-16LE rels part was read, and slide1.xml is shown second');
  assert.deepStrictEqual(byExt.jpg, [1]);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a DTD or unterminated markup in a relationships part is a REPORTED loss, never a silent one', () => {
  const dir = tmpdir();
  const deck = path.join(dir, 'deck.pptx');
  const withDtd = '<?xml version="1.0"?><!DOCTYPE Relationships [<!ENTITY t "../media/a.png">]>'
    + '<Relationships><Relationship Id="r1" Type="' + IMAGE_REL + '" Target="&t;"/></Relationships>';
  fs.writeFileSync(deck, createDeterministicZip([
    { path: 'ppt/slides/slide1.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/slide2.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/_rels/slide1.xml.rels', content: withDtd },
    { path: 'ppt/slides/_rels/slide2.xml.rels', content: '<Relationships><Relationship Id="r1" Target="../media/a.png' },
    { path: 'ppt/media/a.png', content: PNG },
  ]));

  const res = extractPptxAssets({ filePath: deck, outDir: path.join(dir, 'out') });

  const why = Object.fromEntries(res.skipped.map((s) => [s.member, s.reason]));
  assert.match(why['ppt/slides/_rels/slide1.xml.rels'] ?? '', /DTD is not allowed/);
  assert.match(why['ppt/slides/_rels/slide2.xml.rels'] ?? '', /malformed XML: unterminated/);
  assert.strictEqual(res.assetCount, 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

/** A deck whose presentation.xml is given, with slide1/slide2 holding a.png/b.jpg. */
function deckWithPresentation(presentation, extra = []) {
  const presRels = '<Relationships>'
    + '<Relationship Id="A" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>'
    + '<Relationship Id="B" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>'
    + '</Relationships>';
  return createDeterministicZip([
    { path: 'ppt/presentation.xml', content: presentation },
    { path: 'ppt/_rels/presentation.xml.rels', content: presRels },
    { path: 'ppt/slides/slide1.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/slide2.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/_rels/slide1.xml.rels', content: rels([{ id: 'r1', target: '../media/a.png' }]) },
    { path: 'ppt/slides/_rels/slide2.xml.rels', content: rels([{ id: 'r1', target: '../media/b.jpg' }]) },
    { path: 'ppt/media/a.png', content: PNG },
    { path: 'ppt/media/b.jpg', content: JPG },
    ...extra,
  ]);
}
function runDeck(zip) {
  const dir = tmpdir();
  const deck = path.join(dir, 'deck.pptx');
  fs.writeFileSync(deck, zip);
  try { return extractPptxAssets({ filePath: deck, outDir: path.join(dir, 'out') }); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const slidesByExt = (res) => Object.fromEntries(res.assets.map((a) => [a.ext, a.slides]));

test('an unmatched end tag makes the order UNREADABLE (reported), never lets a nested list pass', () => {
  const res = runDeck(deckWithPresentation(
    '<p:presentation><p:extLst></bogus><p:sldIdLst><p:sldId r:id="B"/></p:sldIdLst></p:extLst>'
    + '<p:sldIdLst><p:sldId r:id="A"/></p:sldIdLst></p:presentation>',
  ));
  assert.strictEqual(res.orderSource, 'file-number');
  assert.match(res.orderFallbackReason, /malformed XML: end tag <\/bogus> does not close <p:extLst>/);
});

test('a FOREIGN element of the same local name neither truncates nor replaces the slide list', () => {
  const PML = 'http://schemas.openxmlformats.org/presentationml/2006/main';
  const res = runDeck(deckWithPresentation(
    `<p:presentation xmlns:p="${PML}" xmlns:x="urn:example">`
    + '<x:sldIdLst><x:sldId r:id="A"/></x:sldIdLst>' // a direct child, but not PresentationML
    + '<p:extLst><p:sldId r:id="A"/></p:extLst>' // a PresentationML sldId, but not in THE list
    + '<p:sldIdLst>'
    + '<p:sldId r:id="B"><p:extLst><p:ext uri="u"><x:sldIdLst/></p:ext></p:extLst></p:sldId>'
    + '<p:sldId r:id="A"/>'
    + '</p:sldIdLst></p:presentation>',
  ));
  assert.strictEqual(res.orderSource, 'presentation', res.orderFallbackReason);
  assert.deepStrictEqual(slidesByExt(res), { jpg: [1], png: [2] }, 'B then A: the whole real list, and only it');
  assert.strictEqual(res.slideCount, 2);
});

test('slide parts are found by what the running order NAMES, not by a slide<N> file name', () => {
  // In a sub-directory too: each part's targets resolve from ITS directory.
  const presRels = '<Relationships>'
    + '<Relationship Id="A" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/deck/intro.xml"/>'
    + '<Relationship Id="B" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/deck/results.xml"/>'
    + '</Relationships>';
  const res = runDeck(createDeterministicZip([
    { path: 'ppt/presentation.xml', content: '<p:presentation><p:sldIdLst><p:sldId r:id="B"/><p:sldId r:id="A"/></p:sldIdLst></p:presentation>' },
    { path: 'ppt/_rels/presentation.xml.rels', content: presRels },
    { path: 'ppt/slides/deck/intro.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/deck/results.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/deck/_rels/intro.xml.rels', content: rels([{ id: 'r1', target: '../../media/a.png' }]) },
    { path: 'ppt/slides/deck/_rels/results.xml.rels', content: rels([{ id: 'r1', target: '../../media/b.jpg' }]) },
    { path: 'ppt/media/a.png', content: PNG },
    { path: 'ppt/media/b.jpg', content: JPG },
  ]));
  assert.deepStrictEqual(slidesByExt(res), { jpg: [1], png: [2] });
});

test('a slide list entry that resolves to nothing is REPORTED', () => {
  const res = runDeck(deckWithPresentation(
    '<p:presentation><p:sldIdLst><p:sldId r:id="A"/><p:sldId r:id="Gone"/><p:sldId r:id="B"/></p:sldIdLst></p:presentation>',
  ));
  assert.deepStrictEqual(slidesByExt(res), { png: [1], jpg: [3] });
  const lost = res.skipped.find((s) => s.member === 'ppt/presentation.xml');
  assert.deepStrictEqual(lost?.slides, [2], JSON.stringify(res.skipped));
  assert.match(lost.reason, /resolves to no slide part/);
});

test('Strict OOXML namespaces are PresentationML and relationships too (and `</x >` is a legal end tag)', () => {
  const PML_STRICT = 'http://purl.oclc.org/ooxml/presentationml/main';
  const REL_STRICT = 'http://purl.oclc.org/ooxml/officeDocument/relationships';
  const res = runDeck(deckWithPresentation(
    `<p:presentation xmlns:p="${PML_STRICT}" xmlns:r="${REL_STRICT}">`
    + '<p:sldIdLst><p:sldId r:id="B"/><p:sldId r:id="A"/></p:sldIdLst >'
    + '</p:presentation>',
  ));
  assert.strictEqual(res.orderSource, 'presentation', res.orderFallbackReason);
  assert.deepStrictEqual(slidesByExt(res), { jpg: [1], png: [2] });
});

test('xmlns="" undeclares the default namespace: an unprefixed list under it still counts', () => {
  const PML = 'http://schemas.openxmlformats.org/presentationml/2006/main';
  const res = runDeck(deckWithPresentation(
    `<presentation xmlns="${PML}"><sldIdLst xmlns=""><sldId r:id="B"/><sldId r:id="A"/></sldIdLst></presentation>`,
  ));
  assert.strictEqual(res.orderSource, 'presentation', res.orderFallbackReason);
  assert.deepStrictEqual(slidesByExt(res), { jpg: [1], png: [2] });
});

test('a list entry naming an ABSENT part, or a part already listed, is REPORTED — never a silent overwrite', () => {
  const presRels = '<Relationships>'
    + '<Relationship Id="A" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>'
    + '<Relationship Id="M" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/missing.xml"/>'
    + '</Relationships>';
  const res = runDeck(createDeterministicZip([
    { path: 'ppt/presentation.xml', content: '<p:presentation><p:sldIdLst><p:sldId r:id="A"/><p:sldId r:id="M"/><p:sldId r:id="A"/></p:sldIdLst></p:presentation>' },
    { path: 'ppt/_rels/presentation.xml.rels', content: presRels },
    { path: 'ppt/slides/slide1.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/_rels/slide1.xml.rels', content: rels([{ id: 'r1', target: '../media/a.png' }]) },
    { path: 'ppt/media/a.png', content: PNG },
  ]));
  assert.deepStrictEqual(slidesByExt(res), { png: [1] }, 'slide 1 keeps its position');
  const why = Object.fromEntries(res.skipped.filter((s) => s.member === 'ppt/presentation.xml').map((s) => [s.slides[0], s.reason]));
  assert.match(why[2] ?? '', /ppt\/slides\/missing\.xml, which is not in the archive/);
  assert.match(why[3] ?? '', /again \(already slide 1\)/);
});

test('an ambiguous presentation (duplicate relationship Id, foreign root) falls back WITH its reason', () => {
  const SLIDE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';
  const dup = runDeck(createDeterministicZip([
    { path: 'ppt/presentation.xml', content: '<p:presentation><p:sldIdLst><p:sldId r:id="A"/></p:sldIdLst></p:presentation>' },
    {
      path: 'ppt/_rels/presentation.xml.rels',
      content: `<Relationships><Relationship Id="A" Type="${SLIDE}" Target="slides/slide1.xml"/>`
        + `<Relationship Id="A" Type="${SLIDE}" Target="slides/slide2.xml"/></Relationships>`,
    },
    { path: 'ppt/slides/slide1.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/slide2.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/_rels/slide1.xml.rels', content: rels([{ id: 'r1', target: '../media/a.png' }]) },
    { path: 'ppt/slides/_rels/slide2.xml.rels', content: rels([{ id: 'r1', target: '../media/b.jpg' }]) },
    { path: 'ppt/media/a.png', content: PNG },
    { path: 'ppt/media/b.jpg', content: JPG },
  ]));
  assert.strictEqual(dup.orderSource, 'file-number');
  assert.match(dup.orderFallbackReason, /duplicate relationship Id "A"/);

  const foreign = runDeck(deckWithPresentation(
    '<x:presentation xmlns:x="urn:foreign"><p:sldIdLst><p:sldId r:id="B"/><p:sldId r:id="A"/></p:sldIdLst></x:presentation>',
  ));
  assert.strictEqual(foreign.orderSource, 'file-number');
  assert.match(foreign.orderFallbackReason, /not a presentation \(root element <presentation \(foreign namespace\)>\)/);
});

test('a list entry whose relationship is NOT of the slide type (a notes slide) is not a slide', () => {
  const presRels = '<Relationships>'
    + '<Relationship Id="A" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>'
    + '<Relationship Id="N" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="notesSlides/notesSlide1.xml"/>'
    + '</Relationships>';
  const res = runDeck(createDeterministicZip([
    { path: 'ppt/presentation.xml', content: '<p:presentation><p:sldIdLst><p:sldId r:id="N"/><p:sldId r:id="A"/></p:sldIdLst></p:presentation>' },
    { path: 'ppt/_rels/presentation.xml.rels', content: presRels },
    { path: 'ppt/slides/slide1.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/_rels/slide1.xml.rels', content: rels([{ id: 'r1', target: '../media/a.png' }]) },
    { path: 'ppt/notesSlides/notesSlide1.xml', content: '<p:notes/>' },
    { path: 'ppt/notesSlides/_rels/notesSlide1.xml.rels', content: rels([{ id: 'r1', target: '../media/n.jpg' }]) },
    { path: 'ppt/media/a.png', content: PNG },
    { path: 'ppt/media/n.jpg', content: JPG },
  ]));
  assert.deepStrictEqual(slidesByExt(res), { png: [2] }, "the notes slide's picture is not filed under slide 1");
  assert.ok(res.skipped.some((s) => s.member === 'ppt/presentation.xml' && s.slides[0] === 1), JSON.stringify(res.skipped));
});

test('an EXTERNAL presentation relationship is never a slide, even when its target names one', () => {
  const presRels = '<Relationships>'
    + '<Relationship Id="X" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml" TargetMode="External"/>'
    + '<Relationship Id="B" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>'
    + '</Relationships>';
  const res = runDeck(createDeterministicZip([
    { path: 'ppt/presentation.xml', content: '<p:presentation><p:sldIdLst><p:sldId r:id="X"/><p:sldId r:id="B"/></p:sldIdLst></p:presentation>' },
    { path: 'ppt/_rels/presentation.xml.rels', content: presRels },
    { path: 'ppt/slides/slide1.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/slide2.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/_rels/slide1.xml.rels', content: rels([{ id: 'r1', target: '../media/a.png' }]) },
    { path: 'ppt/slides/_rels/slide2.xml.rels', content: rels([{ id: 'r1', target: '../media/b.jpg' }]) },
    { path: 'ppt/media/a.png', content: PNG },
    { path: 'ppt/media/b.jpg', content: JPG },
  ]));
  assert.deepStrictEqual(slidesByExt(res), { jpg: [2] });
  assert.ok(res.skipped.some((s) => s.member === 'ppt/presentation.xml' && s.slides[0] === 1));
});

test('relationship TYPES are matched exactly (after whitespace collapse), not by suffix', () => {
  const SLIDE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';
  const presRels = '<Relationships>'
    + '<Relationship Id="F" Type="https://example.invalid/custom/slide" Target="slides/slide1.xml"/>'
    + `<Relationship Id="B" Type=" ${SLIDE} " Target="slides/slide2.xml"/>`
    + '</Relationships>';
  const res = runDeck(createDeterministicZip([
    { path: 'ppt/presentation.xml', content: '<p:presentation><p:sldIdLst><p:sldId r:id="F"/><p:sldId r:id="B"/></p:sldIdLst></p:presentation>' },
    { path: 'ppt/_rels/presentation.xml.rels', content: presRels },
    { path: 'ppt/slides/slide1.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/slide2.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/_rels/slide1.xml.rels', content: rels([{ id: 'r1', target: '../media/a.png' }]) },
    {
      path: 'ppt/slides/_rels/slide2.xml.rels',
      content: rels([
        { id: 'r1', target: '../media/b.jpg' },
        { id: 'r2', target: '../media/a.png', type: 'https://example.invalid/custom/image' },
      ]),
    },
    { path: 'ppt/media/a.png', content: PNG },
    { path: 'ppt/media/b.jpg', content: JPG },
  ]));
  assert.deepStrictEqual(slidesByExt(res), { jpg: [2] }, 'the custom /slide and /image types are neither slide nor image');
  assert.ok(res.skipped.some((s) => s.member === 'ppt/presentation.xml' && s.slides[0] === 1));
});

test('a relationships part must BE one: any other root is a REPORTED loss', () => {
  const res = runDeck(createDeterministicZip([
    { path: 'ppt/slides/slide1.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/_rels/slide1.xml.rels', content: '<unrelated/>' },
  ]));
  assert.match(res.skipped[0]?.reason ?? '', /slide relationships unreadable: .*root element <unrelated>, not <Relationships>/);
});

test('target bounds: the ENCODED target and the DECODED member are bounded separately', () => {
  const mediaName = 'x'.repeat(10) + String.fromCharCode(0x6f22).repeat(120) + '.png'; // 134 decoded characters
  const encoded = '../media/' + encodeURIComponent(mediaName); // over 1024 raw characters
  assert.ok(encoded.length > 1024, `fixture: ${encoded.length}`);
  assert.strictEqual(resolveRelTarget(encoded), `ppt/media/${mediaName}`, 'a short non-ASCII name is not refused for its encoding');
  // Over the encoded bound, even though it would normalise to a short name.
  assert.strictEqual(resolveRelTarget('./'.repeat(4700) + '../media/a.png'), null);
  // Under the encoded bound, but the JOINED name is over the member bound.
  assert.strictEqual(resolveRelTarget('sub/' + 'y'.repeat(200) + '.png', 'ppt/slides/' + 'd'.repeat(900)), null);
});

test('TargetMode is Internal, External, or malformed — never a substring match', () => {
  const R = (mode) => `<Relationships><Relationship Id="r1" Type="${IMAGE_REL}" Target="../media/a.png"${mode}/></Relationships>`;
  assert.deepStrictEqual(imageTargetsFromRels(R('')), ['../media/a.png']);
  assert.deepStrictEqual(imageTargetsFromRels(R(' TargetMode="Internal"')), ['../media/a.png']);
  assert.deepStrictEqual(imageTargetsFromRels(R(' TargetMode="External"')), []);
  assert.throws(() => imageTargetsFromRels(R(' TargetMode="NotExternal"')), /TargetMode "NotExternal"/);
});

test('a Relationships root in a FOREIGN namespace is not a relationships part', () => {
  assert.throws(
    () => imageTargetsFromRels(`<Relationships xmlns="urn:foreign"><Relationship Id="r1" Type="${IMAGE_REL}" Target="../media/a.png"/></Relationships>`),
    /not <Relationships>/,
  );
  const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
  assert.deepStrictEqual(
    imageTargetsFromRels(`<Relationships xmlns="${PKG}"><Relationship Id="r1" Type="${IMAGE_REL}" Target="../media/a.png"/></Relationships>`),
    ['../media/a.png'],
  );
  // A CHILD in a foreign namespace — declared on the child itself — is an
  // extension element, not a relationship; one re-declared into the package
  // namespace on itself is one.
  const child = (decl) => `<Relationships><Relationship${decl} Id="r1" Type="${IMAGE_REL}" Target="../media/a.png"/></Relationships>`;
  assert.deepStrictEqual(imageTargetsFromRels(child(' xmlns="urn:ext"')), []);
  assert.deepStrictEqual(imageTargetsFromRels(child(` xmlns="${PKG}"`)), ['../media/a.png']);
  assert.deepStrictEqual(
    imageTargetsFromRels(`<p:Relationships xmlns:p="${PKG}" xmlns:x="urn:ext"><x:Relationship Id="r1" Type="${IMAGE_REL}" Target="../media/a.png"/></p:Relationships>`),
    [],
    'a prefixed child bound to a foreign namespace on the root is not a relationship either',
  );
});

test('a listed slide with NO relationships part is reported, not taken for a slide without pictures', () => {
  const res = runDeck(createDeterministicZip([
    { path: 'ppt/presentation.xml', content: '<p:presentation><p:sldIdLst><p:sldId r:id="A"/><p:sldId r:id="B"/></p:sldIdLst></p:presentation>' },
    {
      path: 'ppt/_rels/presentation.xml.rels',
      content: '<Relationships>'
        + '<Relationship Id="A" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>'
        + '<Relationship Id="B" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>'
        + '</Relationships>',
    },
    { path: 'ppt/slides/slide1.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/slide2.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/_rels/slide2.xml.rels', content: rels([{ id: 'r1', target: '../media/b.jpg' }]) },
    { path: 'ppt/media/b.jpg', content: JPG },
  ]));
  assert.deepStrictEqual(slidesByExt(res), { jpg: [2] });
  const lost = res.skipped.find((s) => s.member === 'ppt/slides/_rels/slide1.xml.rels');
  assert.deepStrictEqual(lost?.slides, [1], JSON.stringify(res.skipped));
  assert.match(lost.reason, /no relationships part/);
});

test('an image relationship without a Target is a REPORTED loss, not a silent drop', () => {
  const res = runDeck(createDeterministicZip([
    { path: 'ppt/slides/slide1.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/_rels/slide1.xml.rels', content: `<Relationships><Relationship Id="r1" Type="${IMAGE_REL}"/></Relationships>` },
  ]));
  assert.match(res.skipped[0]?.reason ?? '', /slide relationships unreadable: .*image relationship without a Target/);
});

test('an over-long target is refused and reported; a skipped member name is bounded', () => {
  const longTarget = '../media/' + 'a'.repeat(2000) + '.png';
  // Under the part-name bound, but long, and absent: its MEMBER name is quoted.
  const longMissing = '../media/' + 'b'.repeat(900) + '.png';
  const res = runDeck(createDeterministicZip([
    { path: 'ppt/slides/slide1.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/_rels/slide1.xml.rels', content: rels([{ id: 'r1', target: longTarget }, { id: 'r2', target: longMissing }]) },
  ]));
  const s = res.skipped.find((x) => /image target refused/.test(x.reason));
  assert.ok(s, JSON.stringify(res.skipped).slice(0, 300));
  assert.ok(s.reason.length < 400, 'the quoted target is cut');
  assert.match(s.reason, /more characters\]/);
  const absent = res.skipped.find((x) => /absent from the archive/.test(x.reason));
  assert.ok(absent && absent.member.length < 400, 'a long member NAME is bounded too');
  assert.match(absent.member, /more characters\]$/);
});

test('text from the archive is quoted in a reason escaped and bounded', () => {
  const NL = String.fromCharCode(10);
  assert.strictEqual(excerpt(`a${NL}b`), 'a\\x0ab');
  const long = excerpt('x'.repeat(500));
  assert.ok(long.startsWith('x'.repeat(120) + '... [380 more characters]'));
});

test('tokenizer: what it refuses, it refuses by throwing — each case', () => {
  const R = (inner) => `<Relationships>${inner}</Relationships>`;
  const cases = [
    [R('<Relationship Id="a" Id="b"/>'), /duplicate attribute Id/],
    [R('<Relationship Target="a<b"/>'), /a literal < in the value/],
    [R('<Relationship Target="&t;"/>'), /undeclared entity reference/],
    ['<Relationships/><Relationships/>', /a second root element/],
    ['<Relationships><Relationship>', /is never closed/],
    ['<!-- nothing -->', /no root element/],
    ['</Relationships>', /with no element open/],
  ];
  for (const [xml, why] of cases) assert.throws(() => imageTargetsFromRels(xml), why, xml);
  // Bytes: invalid UTF-8, and UTF-16 with an odd byte count.
  assert.throws(() => imageTargetsFromRels(Buffer.from([0x3c, 0x61, 0xff, 0x3e])), /not valid utf-8/);
  const odd = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<a/>', 'utf16le'), Buffer.from([0x00])]);
  assert.throws(() => imageTargetsFromRels(odd), /odd byte count/);
});

test('attribute values are normalised as an XML parser does: a literal tab is a space, &#9; stays a tab', () => {
  const TAB = String.fromCharCode(9);
  const xml = `<Relationships><Relationship Id="r1" Type="${IMAGE_REL}" Target="../media/a${TAB}b&#9;c.png"/></Relationships>`;
  assert.deepStrictEqual(imageTargetsFromRels(xml), [`../media/a b${TAB}c.png`]);
});

test('a processing instruction carrying a fake slide list is not the slide list', () => {
  const dir = tmpdir();
  const deck = path.join(dir, 'deck.pptx');
  const presRels = '<Relationships>'
    + '<Relationship Id="rA" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>'
    + '<Relationship Id="rB" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>'
    + '</Relationships>';
  // The real list shows B (slide2.xml) THEN A (slide1.xml) — the reverse of
  // the file numbers, so a fallback to file numbers is visible too. Every
  // fake list (in a PI, in CDATA, nested below the root's own child) lists A
  // alone, so taking any of them is visible as well.
  const fake = '<p:sldIdLst><p:sldId r:id="rA"/></p:sldIdLst>';
  const presentation = '<?xml version="1.0"?>'
    + `<?review ${fake} ?>`
    + `<p:presentation><![CDATA[${fake}]]>`
    + `<p:extLst>${fake}</p:extLst>`
    + '<p:sldIdLst><p:sldId id="256" r:id="rB"/><p:sldId id="257" r:id="rA"/></p:sldIdLst></p:presentation>';
  fs.writeFileSync(deck, createDeterministicZip([
    { path: 'ppt/presentation.xml', content: presentation },
    { path: 'ppt/_rels/presentation.xml.rels', content: presRels },
    { path: 'ppt/slides/slide1.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/slide2.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/_rels/slide1.xml.rels', content: rels([{ id: 'r1', target: '../media/a.png' }]) },
    { path: 'ppt/slides/_rels/slide2.xml.rels', content: rels([{ id: 'r1', target: '../media/b.jpg' }]) },
    { path: 'ppt/media/a.png', content: PNG },
    { path: 'ppt/media/b.jpg', content: JPG },
  ]));

  const res = extractPptxAssets({ filePath: deck, outDir: path.join(dir, 'out') });

  assert.strictEqual(res.orderSource, 'presentation', res.orderFallbackReason);
  const byExt = Object.fromEntries(res.assets.map((a) => [a.ext, a.slides]));
  assert.deepStrictEqual(byExt.jpg, [1], 'slide2.xml is shown first');
  assert.deepStrictEqual(byExt.png, [2], 'slide1.xml is shown second');
  assert.strictEqual(res.slideCount, 2);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('the relationship scan limit is REPORTED, not a silent stop', () => {
  const dir = tmpdir();
  const deck = path.join(dir, 'deck.pptx');
  const entries = [];
  for (let n = 1; n <= MAX_RELS_MEMBERS + 1; n++) {
    entries.push({ path: `ppt/slides/slide${n}.xml`, content: '<p:sld/>' });
    entries.push({ path: `ppt/slides/_rels/slide${n}.xml.rels`, content: '<Relationships/>' });
  }
  fs.writeFileSync(deck, createDeterministicZip(entries));

  const res = extractPptxAssets({ filePath: deck, outDir: path.join(dir, 'out') });

  const stops = res.skipped.filter((s) => /relationship scan limit reached/.test(s.reason));
  assert.strictEqual(stops.length, 1, JSON.stringify(res.skipped.slice(0, 3)));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a cap never drops a slide from an image already written: duplicates are merged first', () => {
  const dir = tmpdir();
  const deck = path.join(dir, 'deck.pptx');
  fs.writeFileSync(deck, createDeterministicZip([
    { path: 'ppt/slides/slide1.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/slide2.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/_rels/slide1.xml.rels', content: rels([{ id: 'r1', target: '../media/one.png' }]) },
    { path: 'ppt/slides/_rels/slide2.xml.rels', content: rels([{ id: 'r1', target: '../media/two.png' }]) },
    { path: 'ppt/media/one.png', content: PNG },
    { path: 'ppt/media/two.png', content: PNG },
  ]));

  const res = extractPptxAssets({ filePath: deck, outDir: path.join(dir, 'out'), maxAssets: 1 });

  assert.strictEqual(res.assetCount, 1);
  assert.deepStrictEqual(res.assets[0].slides, [1, 2], 'slide 2 shows the picture already written');
  assert.deepStrictEqual(res.skipped, []);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('duplicates cannot inflate for free: the inflation budget bounds them, and says so', () => {
  const dir = tmpdir();
  const deck = path.join(dir, 'deck.pptx');
  const slideRels = rels([
    { id: 'r1', target: '../media/a.png' },
    { id: 'r2', target: '../media/b.png' },
    { id: 'r3', target: '../media/c.png' },
  ]);
  fs.writeFileSync(deck, createDeterministicZip([
    { path: 'ppt/slides/slide1.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/_rels/slide1.xml.rels', content: slideRels },
    { path: 'ppt/media/a.png', content: PNG },
    { path: 'ppt/media/b.png', content: PNG },
    { path: 'ppt/media/c.png', content: PNG },
  ]));

  // Every read is charged its declared size + 1, the slide's rels included.
  // Budget (lowered for the fixture) = the rels + two images: a and b are
  // read (b merges into a), c is not.
  const budget = (Buffer.byteLength(slideRels) + 1) + 2 * (PNG.length + 1);
  const res = extractPptxAssets({ filePath: deck, outDir: path.join(dir, 'out'), maxInflateBytes: budget });

  assert.strictEqual(res.assetCount, 1);
  assert.deepStrictEqual(res.assets[0].members, ['ppt/media/a.png', 'ppt/media/b.png']);
  assert.strictEqual(res.skipped.length, 1);
  assert.strictEqual(res.skipped[0].member, 'ppt/media/c.png');
  assert.match(res.skipped[0].reason, /inflation budget/);

  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Rewrite the DECLARED uncompressed size of `name`, in the central directory
 * and in its local header alike (so the two still agree), leaving the body
 * alone. A DEFLATE body that expands past its declared size then fails to
 * inflate — after doing the work — which is the attempt a budget must charge.
 */
function patchDeclaredSize(zip, name, size) {
  const buf = Buffer.from(zip);
  for (let p = buf.length - 22; p >= 0; p--) {
    if (buf.readUInt32LE(p) !== 0x02014b50) continue;
    const nameLen = buf.readUInt16LE(p + 28);
    if (buf.subarray(p + 46, p + 46 + nameLen).toString('utf8') !== name) continue;
    const local = buf.readUInt32LE(p + 42);
    buf.writeUInt32LE(size, p + 24);
    buf.writeUInt32LE(size, local + 22);
    return buf;
  }
  throw new Error(`no central record for ${name}`);
}

test('a FAILED inflation is charged to the budget too', () => {
  const dir = tmpdir();
  const deck = path.join(dir, 'deck.pptx');
  const expands = 'x'.repeat(4000); // deflates small, inflates far past 15
  const rels1 = rels([{ id: 'r1', target: '../media/f1.png' }, { id: 'r2', target: '../media/f2.png' }]);
  const rels2 = rels([{ id: 'r1', target: '../media/good.png' }]);
  let zip = createDeterministicZip([
    { path: 'ppt/slides/slide1.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/slide2.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/_rels/slide1.xml.rels', content: rels1 },
    { path: 'ppt/slides/_rels/slide2.xml.rels', content: rels2 },
    { path: 'ppt/media/f1.png', content: expands },
    { path: 'ppt/media/f2.png', content: expands },
    { path: 'ppt/media/good.png', content: PNG },
  ]);
  zip = patchDeclaredSize(zip, 'ppt/media/f1.png', 15);
  zip = patchDeclaredSize(zip, 'ppt/media/f2.png', 15);
  fs.writeFileSync(deck, zip);

  // Budget = both rels + 40. f1 and f2 are charged 16 each and FAIL; good.png
  // would need 13 more (45 > 40). Uncharged failures would leave room for it.
  const xmlCharge = (Buffer.byteLength(rels1) + 1) + (Buffer.byteLength(rels2) + 1);
  const res = extractPptxAssets({ filePath: deck, outDir: path.join(dir, 'out'), maxInflateBytes: xmlCharge + 40 });

  const why = Object.fromEntries(res.skipped.map((s) => [s.member, s.reason]));
  assert.match(why['ppt/media/f1.png'], /could not inflate/, 'the fixture must really fail to inflate');
  assert.match(why['ppt/media/f2.png'], /could not inflate/);
  assert.match(why['ppt/media/good.png'] ?? '', /inflation budget reached/, JSON.stringify(res.skipped));
  assert.strictEqual(res.assetCount, 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('createOnly: files already there cost no write, so the write caps never refuse them', () => {
  const dir = tmpdir();
  const deck = path.join(dir, 'deck.pptx');
  fs.writeFileSync(deck, buildDeck());
  const out = path.join(dir, 'out');
  const first = extractPptxAssets({ filePath: deck, outDir: out, createOnly: true });
  assert.strictEqual(first.assetCount, 2);

  // A second run capped at ONE write and ONE byte — smaller than either image,
  // so the cap WOULD refuse both: both are already there, so both are listed
  // and nothing is refused.
  const again = extractPptxAssets({ filePath: deck, outDir: out, createOnly: true, maxAssets: 1, maxTotalBytes: 1 });
  assert.deepStrictEqual(again.assets.map((a) => [a.name, a.alreadyPresent]), [['slide1-1.png', true], ['slide2-1.jpg', true]]);
  assert.deepStrictEqual(again.skipped, []);

  // One already there, one missing, cap of ONE write: the cap counts writes,
  // not manifest entries, so the missing image is still written.
  fs.rmSync(path.join(out, 'slide2-1.jpg'));
  const mixed = extractPptxAssets({ filePath: deck, outDir: out, createOnly: true, maxAssets: 1 });
  assert.deepStrictEqual(mixed.assets.map((a) => [a.name, a.alreadyPresent === true]), [['slide1-1.png', true], ['slide2-1.jpg', false]]);
  assert.deepStrictEqual(mixed.skipped, []);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('createOnly: a LINK at an output name is never taken for the file, even when its target holds the same bytes', (t) => {
  const dir = tmpdir();
  const deck = path.join(dir, 'deck.pptx');
  fs.writeFileSync(deck, buildDeck());
  const out = path.join(dir, 'out');
  fs.mkdirSync(out);
  const elsewhere = path.join(dir, 'elsewhere.png');
  fs.writeFileSync(elsewhere, PNG);
  try { fs.symlinkSync(elsewhere, path.join(out, 'slide1-1.png')); }
  catch (e) { t.skip(`cannot create a file symlink here: ${e.code}`); return; }

  const res = extractPptxAssets({ filePath: deck, outDir: out, createOnly: true });

  const png = res.assets.find((a) => a.ext === 'png');
  assert.match(png.name, /^slide1-[0-9a-f]{16}\.png$/, 'the link is not the asset; the hashed name is');
  assert.strictEqual(png.alreadyPresent, undefined);
  assert.ok(fs.lstatSync(path.join(out, 'slide1-1.png')).isSymbolicLink(), 'the link itself is left alone');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('resolveOutDirArg is the one reading of outdir: blank is absent, ~ is home, a non-string is refused', () => {
  assert.strictEqual(resolveOutDirArg(undefined), null);
  assert.strictEqual(resolveOutDirArg('   '), null);
  assert.strictEqual(resolveOutDirArg('~/pptx-x'), path.join(os.homedir(), 'pptx-x'));
  assert.throws(() => resolveOutDirArg(42), /outdir must be a string/);
});

test('MD_ALLOWED_PATHS: a sandbox root not created yet, under an existing link, still admits what is inside it', (t) => {
  const base = tmpdir();
  const real = path.join(base, 'real');
  fs.mkdirSync(real);
  const alias = path.join(base, 'alias');
  try { fs.symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) { t.skip(`cannot create a directory link: ${e.code}`); return; }
  // The deck sits in its OWN allowed directory, so the output below is
  // admitted by the not-yet-created root and by nothing else.
  const decks = path.join(base, 'decks');
  fs.mkdirSync(decks);
  const deck = path.join(decks, 'deck.pptx');
  fs.writeFileSync(deck, buildDeck());

  const old = process.env.MD_ALLOWED_PATHS;
  try {
    process.env.MD_ALLOWED_PATHS = [path.join(alias, 'root'), decks].join(path.delimiter);
    const res = extractPptxAssets({ filePath: deck, outDir: path.join(alias, 'root', 'out') });
    assert.strictEqual(res.assetCount, 2, 'inside the configured (not-yet-created) root: allowed');
  } finally {
    if (old !== undefined) process.env.MD_ALLOWED_PATHS = old;
    else delete process.env.MD_ALLOWED_PATHS;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('an unreadable slide relationships part is REPORTED, not silently dropped', () => {
  const dir = tmpdir();
  const deck = path.join(dir, 'deck.pptx');
  // Over the XML-part ceiling: 17 MiB of whitespace inside a rels document.
  const bloated = `<Relationships>${' '.repeat(17 * 1024 * 1024)}</Relationships>`;
  fs.writeFileSync(deck, createDeterministicZip([
    { path: 'ppt/slides/slide1.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/slide2.xml', content: '<p:sld/>' },
    { path: 'ppt/slides/_rels/slide1.xml.rels', content: bloated },
    { path: 'ppt/slides/_rels/slide2.xml.rels', content: rels([{ id: 'r1', target: '../media/a.png' }]) },
    { path: 'ppt/media/a.png', content: PNG },
  ]));

  const res = extractPptxAssets({ filePath: deck, outDir: path.join(dir, 'out') });

  assert.strictEqual(res.assetCount, 1, 'the readable slide still yields its picture');
  const lost = res.skipped.find((s) => s.member === 'ppt/slides/_rels/slide1.xml.rels');
  assert.ok(lost, `the unreadable part must be named in skipped: ${JSON.stringify(res.skipped)}`);
  assert.deepStrictEqual(lost.slides, [1]);
  assert.match(lost.reason, /slide relationships unreadable/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a filepath that is not a regular file is refused before it is read', () => {
  const dir = tmpdir();
  assert.throws(() => extractPptxAssets({ filePath: dir }), /not a regular file/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a FIFO is refused without blocking (POSIX)', (t) => {
  if (process.platform === 'win32') { t.skip('no mkfifo on Windows — the directory case above drives the same check'); return; }
  const dir = tmpdir();
  const fifo = path.join(dir, 'deck.pptx');
  const made = spawnSync('mkfifo', [fifo]);
  if (made.status !== 0) { t.skip(`mkfifo unavailable: ${made.error?.message ?? made.status}`); return; }
  assert.throws(() => extractPptxAssets({ filePath: fifo }), /not a regular file/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('MD_ALLOWED_PATHS: an outdir to be CREATED under a link that leaves the sandbox is refused', (t) => {
  const sandbox = tmpdir();
  const outside = tmpdir();
  const deck = path.join(sandbox, 'deck.pptx');
  fs.writeFileSync(deck, buildDeck());
  const link = path.join(sandbox, 'link');
  try { fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) { t.skip(`cannot create a directory link: ${e.code}`); return; }

  const old = process.env.MD_ALLOWED_PATHS;
  try {
    process.env.MD_ALLOWED_PATHS = sandbox;
    const outdir = path.join(link, 'new-assets');
    assert.throws(() => extractPptxAssets({ filePath: deck, outDir: outdir }), /outside the allowed directories/);
    assert.strictEqual(fs.existsSync(path.join(outside, 'new-assets')), false, 'nothing was created outside');
  } finally {
    if (old !== undefined) process.env.MD_ALLOWED_PATHS = old;
    else delete process.env.MD_ALLOWED_PATHS;
    fs.rmSync(link, { recursive: true, force: true });
    fs.rmSync(sandbox, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

/* ------------------------------------------- through the real dispatcher -- */

/**
 * The gate is where the file lands, not the session's default vault. The
 * first version of this tool was in WRITE_TOOL_NAMES only, so the dispatcher's
 * vault-argument gate resolved the PRIMARY (the tool has no `vault` argument)
 * and let an `outdir` inside an alsoLocked secondary through. Driven against
 * the real `bin/` over stdio, with two LOCAL vaults — the containment gate only
 * knows local vault folders — and no Obsidian needed: the tool writes to disk.
 */
function startRouterWithTwoLocalVaults({ tiers = { alsoLocked: ['ref'] }, sharedVault = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-assets-e2e-'));
  const work = path.join(dir, 'work');
  const ref = path.join(dir, 'ref');
  fs.mkdirSync(work);
  fs.mkdirSync(ref);
  const deck = path.join(dir, 'deck.pptx');
  fs.writeFileSync(deck, buildDeck());
  const bindings = {
    [canonicalWorkspaceKey(dir)]: {
      vault: 'work', also: ['ref'], locked: false, confirmedAt: '2026-09-23', confirmedVia: 'test', ...tiers,
    },
  };
  // A second workspace declaring `sharedVault` makes that vault SHARED.
  if (sharedVault) {
    bindings[canonicalWorkspaceKey(path.join(dir, 'elsewhere'))] = {
      vault: sharedVault, also: [], locked: false, confirmedAt: '2026-09-23', confirmedVia: 'test',
    };
  }
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    portRegistry: { [work]: 27981, [ref]: 27982 },
    vaultNames: { [work]: 'work', [ref]: 'ref' },
    defaultVault: 'work',
    workspaceBindings: bindings,
  }, null, 2));

  const child = spawn(process.execPath, [BIN, '--config', configPath], {
    cwd: dir,
    env: homeSafeEnv(path.join(dir, 'home'), {
      OBSIDIAN_ROUTER_NO_WATCH: '1',
      MD_ALLOWED_PATHS: dir,
      OBSIDIAN_ROUTER_LOCKED: '',
      OBSIDIAN_ROUTER_VIEW_AGENT_URL: '',
      OBSIDIAN_ROUTER_USER_ID: '',
      OBSIDIAN_ROUTER_NO_AUTO_CONFORMANCE: 'true',
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  let stderr = '';
  const waiters = new Map();
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const w = waiters.get(msg.id);
      if (w) { waiters.delete(msg.id); w(msg); }
    }
  });
  let nextId = 1;
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`timed out on ${method}\n${stderr}`)), 20000);
    waiters.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const tool = async (name, args) => {
    const res = await call('tools/call', { name, arguments: args });
    const text = res.result?.content?.[0]?.text ?? JSON.stringify(res.error ?? res.result);
    return { refused: Boolean(res.error || res.result?.isError), text };
  };
  const extract = (args) => tool('pptx_extract_assets', { filepath: deck, ...args });
  const start = async () => {
    await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'pptx-e2e', version: '0' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  };
  // The child's cwd is `dir`, and Windows refuses to remove a directory a live
  // process sits in: wait for the exit, THEN remove.
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const stop = async () => {
    child.stdin.end();
    child.kill();
    await exited;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  return { dir, work, ref, start, extract, tool, stop };
}

test('E2E: an outdir outside every vault and outside the temp directory is refused, and not created', async (t) => {
  const rt = startRouterWithTwoLocalVaults();
  t.after(rt.stop);
  await rt.start();
  // A sibling of the temp directory: shares its parent, is not inside it.
  const outdir = path.join(path.dirname(os.tmpdir()), `pptx-e2e-not-temp-${process.pid}-${Date.now()}`);
  const res = await rt.extract({ outdir });
  assert.ok(res.refused, `expected a refusal, got: ${res.text}`);
  assert.match(res.text, /must be inside a registered vault or inside the system temporary directory/);
  assert.equal(fs.existsSync(outdir), false);
});

test('E2E: download_page_assets goes through the dispatcher with its authorisation — writes to the primary, refused in a locked vault', async (t) => {
  // The asset writers refuse to run without the dispatcher's output-directory
  // authorisation; a dispatcher that stopped handing it over would turn this
  // call into a refusal. No network: `html` with no image, so the handler
  // pins the directory and downloads nothing.
  const rt = startRouterWithTwoLocalVaults();
  t.after(rt.stop);
  await rt.start();
  const good = path.join(rt.work, 'wiki', '.assets', 'page');
  fs.mkdirSync(path.dirname(good), { recursive: true });
  const ok = await rt.tool('download_page_assets', { html: '<p>no image</p>', baseUrl: 'https://example.test/', outputDir: good });
  assert.ok(!ok.refused, `primary write refused: ${ok.text}`);
  assert.ok(fs.statSync(good).isDirectory(), 'the pinned directory was created');
  assert.deepEqual(fs.readdirSync(good), [], 'and nothing left behind: no anchor, no temporary');

  const locked = path.join(rt.ref, 'wiki', '.assets', 'page');
  fs.mkdirSync(path.dirname(locked), { recursive: true });
  const no = await rt.tool('download_page_assets', { html: '<p>no image</p>', baseUrl: 'https://example.test/', outputDir: locked, confirmSecondaryWrite: true });
  assert.ok(no.refused, `expected a refusal, got: ${no.text}`);
  assert.match(no.text, /locked read-only/);
  assert.equal(fs.existsSync(locked), false);
});

test('E2E: an outdir inside an alsoLocked secondary is refused and nothing is written there', async (t) => {
  const rt = startRouterWithTwoLocalVaults();
  t.after(rt.stop);
  await rt.start();
  const outdir = path.join(rt.ref, 'wiki', '.assets', 'deck');
  const res = await rt.extract({ outdir, confirmSecondaryWrite: true, createOnly: true });
  assert.ok(res.refused, `expected a refusal, got: ${res.text}`);
  assert.match(res.text, /locked read-only/);
  assert.equal(fs.existsSync(outdir), false, 'no file, not even the directory, may reach the locked vault');
});

test('E2E control: the same call aimed at the PRIMARY writes, so the refusal above is the gate and not a broken tool', async (t) => {
  const rt = startRouterWithTwoLocalVaults();
  t.after(rt.stop);
  await rt.start();
  const outdir = path.join(rt.work, 'wiki', '.assets', 'deck');
  const res = await rt.extract({ outdir });
  assert.ok(!res.refused, `primary write refused: ${res.text}`);
  assert.equal(fs.readdirSync(outdir).length, 2);
});

test('E2E: a soft-tier secondary needs confirmSecondaryWrite, and a shared one needs createOnly', async (t) => {
  const soft = startRouterWithTwoLocalVaults({ tiers: {} });
  t.after(soft.stop);
  await soft.start();
  const outdir = path.join(soft.ref, 'wiki', '.assets', 'deck');
  const unconfirmed = await soft.extract({ outdir });
  assert.ok(unconfirmed.refused, `expected a refusal, got: ${unconfirmed.text}`);
  assert.match(unconfirmed.text, /SECONDARY vault/);
  assert.equal(fs.existsSync(outdir), false);
  const confirmed = await soft.extract({ outdir, confirmSecondaryWrite: true });
  assert.ok(!confirmed.refused, `confirmed soft-tier write refused: ${confirmed.text}`);

  const shared = startRouterWithTwoLocalVaults({ tiers: { alsoWritable: ['ref'] }, sharedVault: 'ref' });
  t.after(shared.stop);
  await shared.start();
  const out2 = path.join(shared.ref, 'wiki', '.assets', 'deck');
  const bare = await shared.extract({ outdir: out2 });
  assert.ok(bare.refused, `expected the shared-vault refusal, got: ${bare.text}`);
  assert.match(bare.text, /createOnly: true/);
  const carried = await shared.extract({ outdir: out2, createOnly: true });
  assert.ok(!carried.refused, `createOnly write refused: ${carried.text}`);
});

test('E2E: with no outdir the images go to a temp directory, and a shared primary does not refuse that', async (t) => {
  // Before the fix the vault-argument gate resolved the PRIMARY and asked it
  // for a precondition, although nothing was being written into any vault.
  const rt = startRouterWithTwoLocalVaults({ tiers: {}, sharedVault: 'work' });
  t.after(rt.stop);
  await rt.start();
  const res = await rt.extract({});
  assert.ok(!res.refused, `a temp-dir extraction was refused: ${res.text}`);
  const manifest = JSON.parse(res.text);
  assert.ok(manifest.outDir.startsWith(os.tmpdir()));
  fs.rmSync(manifest.outDir, { recursive: true, force: true });
});

test('createOnly must be a boolean', () => {
  const dir = tmpdir();
  const deck = path.join(dir, 'deck.pptx');
  fs.writeFileSync(deck, buildDeck());
  assert.throws(
    () => extractPptxAssets({ filePath: deck, outDir: path.join(dir, 'out'), createOnly: 'yes' }),
    /createOnly must be a boolean/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
