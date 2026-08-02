/**
 * Tests for the router-side heading patch engine (src/helpers/heading-patch.mjs).
 *
 * The first block is the REPRODUCTION of the real 2026-08-02 corruption: two
 * patch_file targetType:heading calls on the CRLF file
 * "wiki/obsidian-mcp-router/vault-wizard-roadmap.md" — an append that landed
 * MID-LINE (splitting "Guided vault-creation wizard" in two) and a replace
 * that SWALLOWED the target heading and spliced the new content into the
 * following paragraph. Root cause: the Local REST API plugin computes offsets
 * on LF-normalized content and splices them into the raw CRLF bytes — every
 * line above the target shifts the true offset by one. The router now patches
 * headings line-by-line on the raw content, so these fixtures must come out
 * byte-clean.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyHeadingPatch,
  parseHeadings,
  dominantEol,
  HeadingPatchError,
} from '../src/helpers/heading-patch.mjs';

// --- Fixture mirroring the corrupted page: CRLF + "·" + emoji headings ------

const CRLF = '\r\n';
/** Structure copied from the real vault-wizard-roadmap.md (shortened). */
const ROADMAP = [
  '---',
  'title: vault-wizard-roadmap',
  '---',
  '',
  '# Roadmap — Wizard guidé de création de vault',
  '',
  'Un wizard interactif de création de vault.',
  'The Guided vault-creation wizard ships in phases.',
  '',
  '## 🇫🇷 Version française',
  '',
  'Texte introductif de la section française.',
  '',
  '### Phase W3 · Frontends ✅ · livré 2026-07-03 (v0.36.0)',
  '',
  '- [x] CLI two-phase flow',
  '- [x] MCP plan/provision tools',
  '',
  '### Ordre d\'attaque recommandé',
  '',
  'Commencer par la phase W1, puis dérouler.',
  'Ancien paragraphe à remplacer.',
  '',
  '## 🇬🇧 English version',
  '',
  'Closing text.',
  '',
].join(CRLF);

const PHASE_TARGET =
  'Roadmap — Wizard guidé de création de vault::🇫🇷 Version française::Phase W3 · Frontends ✅ · livré 2026-07-03 (v0.36.0)';
const ORDRE_TARGET =
  "Roadmap — Wizard guidé de création de vault::🇫🇷 Version française::Ordre d'attaque recommandé";

describe('REPRO 2026-08-02 — CRLF roadmap corruption', () => {
  test('append under the "Phase W3 · … ✅ …" heading lands as whole lines, splitting nothing', () => {
    const added = '- [x] nouvel item livré';
    const out = applyHeadingPatch(ROADMAP, {
      operation: 'append',
      target: PHASE_TARGET,
      content: added,
    });
    assert.equal(out.applied, true);
    // The original corruption split this exact phrase in two.
    assert.match(out.content, /The Guided vault-creation wizard ships in phases\./);
    // Content must be inserted as its own line, at the END of the W3 section
    // (right before the next heading), terminated CRLF like the rest.
    assert.ok(
      out.content.includes(
        `- [x] MCP plan/provision tools${CRLF}${CRLF}${added}${CRLF}### Ordre d'attaque recommandé`,
      ),
      'append must land between the section content and the next heading',
    );
    // Every prior byte untouched: the prefix up to the insertion point is identical.
    const insertPos = out.content.indexOf(added);
    assert.equal(out.content.slice(0, insertPos), ROADMAP.slice(0, insertPos));
    // No mixed line endings introduced: every \n is preceded by \r.
    assert.equal((out.content.match(/(?<!\r)\n/g) || []).length, 0);
  });

  test('replace under "Ordre d\'attaque recommandé" keeps the heading and replaces ONLY its section', () => {
    const out = applyHeadingPatch(ROADMAP, {
      operation: 'replace',
      target: ORDRE_TARGET,
      content: 'Nouveau plan d\'attaque.',
    });
    // The original corruption swallowed the heading itself.
    assert.match(out.content, /### Ordre d'attaque recommandé/);
    assert.ok(!out.content.includes('Ancien paragraphe à remplacer.'), 'old section content gone');
    assert.ok(
      out.content.includes(
        `### Ordre d'attaque recommandé${CRLF}Nouveau plan d'attaque.${CRLF}## 🇬🇧 English version`,
      ),
    );
    // Sibling sections untouched.
    assert.match(out.content, /- \[x\] MCP plan\/provision tools/);
    assert.match(out.content, /Closing text\./);
    assert.equal((out.content.match(/(?<!\r)\n/g) || []).length, 0);
  });

  test('LF content patched into the CRLF file is normalized to CRLF (no mixed endings)', () => {
    const out = applyHeadingPatch(ROADMAP, {
      operation: 'append',
      target: PHASE_TARGET,
      content: 'ligne un\nligne deux\n',
    });
    assert.ok(out.content.includes(`ligne un${CRLF}ligne deux${CRLF}`));
    assert.equal((out.content.match(/(?<!\r)\n/g) || []).length, 0);
  });
});

// --- Path resolution ---------------------------------------------------------

describe('heading path resolution', () => {
  const DOC = ['# A', 'a-text', '## B', 'b-text', '## C/D', 'cd-text', '# E', 'e-text'].join('\n') + '\n';

  test('full ancestry path resolves; bare leaf under a parent does NOT (documented contract)', () => {
    const ok = applyHeadingPatch(DOC, { operation: 'append', target: 'A::B', content: 'x' });
    assert.match(ok.content, /b-text\nx\n## C\/D/);
    assert.throws(
      () => applyHeadingPatch(DOC, { operation: 'append', target: 'B', content: 'x' }),
      (err) => err instanceof HeadingPatchError && /invalid-target/.test(err.message),
    );
  });

  test('§2.17 variant — heading text containing a slash is a plain string match, nothing swallowed', () => {
    const out = applyHeadingPatch(DOC, { operation: 'replace', target: 'A::C/D', content: 'nouveau' });
    assert.match(out.content, /## C\/D\nnouveau\n# E/);
    assert.match(out.content, /b-text/);
  });

  test('root heading is addressable by its bare name', () => {
    const out = applyHeadingPatch(DOC, { operation: 'append', target: 'E', content: 'fin' });
    assert.match(out.content, /e-text\nfin\n$/);
  });

  test('custom targetDelimiter', () => {
    const out = applyHeadingPatch(DOC, {
      operation: 'append',
      target: 'A//B',
      targetDelimiter: '//',
      content: 'x',
    });
    assert.match(out.content, /b-text\nx\n/);
  });

  test('first match wins when the same path exists twice', () => {
    const doc = '# A\n## B\nfirst\n# A\n## B\nsecond\n';
    const out = applyHeadingPatch(doc, { operation: 'append', target: 'A::B', content: 'x' });
    assert.match(out.content, /first\nx\n# A/);
    assert.match(out.content, /second\n$/);
  });

  test('headings inside fenced code blocks are invisible', () => {
    const doc = '# A\n```\n# Fake\n```\ntext\n# Fake\nreal\n';
    const out = applyHeadingPatch(doc, { operation: 'append', target: 'Fake', content: 'x' });
    // Must have targeted the REAL "# Fake" (after the fence), not the fenced one.
    assert.match(out.content, /real\nx\n$/);
    assert.match(out.content, /```\n# Fake\n```/);
  });

  test('closing-hash heading "## Title ##" matches "Title"', () => {
    const doc = '# Root\n## Title ##\nbody\n';
    const out = applyHeadingPatch(doc, { operation: 'append', target: 'Root::Title', content: 'x' });
    assert.match(out.content, /body\nx\n$/);
  });

  test('invalid-target error lists the top-level headings', () => {
    assert.throws(
      () => applyHeadingPatch(DOC, { operation: 'append', target: 'Nope', content: 'x' }),
      /Top-level headings in this file: "A", "E"/,
    );
  });
});

// --- Operations ----------------------------------------------------------------

describe('operations', () => {
  const DOC = '# H1\n\nintro\n\n## Sub\nsub-text\n\n## Next\nnext-text\n';

  test('append targets the END of the whole subtree (before the next same-level heading)', () => {
    const out = applyHeadingPatch(DOC, { operation: 'append', target: 'H1', content: 'apx' });
    // H1's subtree runs to EOF (no other H1) — append lands at EOF.
    assert.match(out.content, /next-text\napx\n$/);
  });

  test('prepend inserts right after the heading line', () => {
    const out = applyHeadingPatch(DOC, { operation: 'prepend', target: 'H1::Sub', content: 'pre' });
    assert.match(out.content, /## Sub\npre\nsub-text/);
  });

  test('replace clears the section with empty content, heading intact', () => {
    const out = applyHeadingPatch(DOC, { operation: 'replace', target: 'H1::Sub', content: '' });
    assert.match(out.content, /## Sub\n## Next/);
  });

  test('trimTargetWhitespace: append drops trailing blank lines of the section', () => {
    const out = applyHeadingPatch(DOC, {
      operation: 'append',
      target: 'H1::Sub',
      content: 'apx',
      trimTargetWhitespace: true,
    });
    assert.match(out.content, /sub-text\napx\n## Next/);
  });

  test('trimTargetWhitespace: prepend drops leading blank lines of the section', () => {
    const doc = '# H\n\n\nbody\n';
    const out = applyHeadingPatch(doc, {
      operation: 'prepend',
      target: 'H',
      content: 'pre',
      trimTargetWhitespace: true,
    });
    assert.equal(out.content, '# H\npre\nbody\n');
  });

  test('append to a file whose last line has no terminator', () => {
    const doc = '# H\nlast-line-no-eol';
    const out = applyHeadingPatch(doc, { operation: 'append', target: 'H', content: 'x' });
    assert.equal(out.content, '# H\nlast-line-no-eol\nx\n');
  });

  test('multi-line content: one trailing newline is a terminator, extra blank lines survive', () => {
    const doc = '# H\nbody\n';
    const one = applyHeadingPatch(doc, { operation: 'append', target: 'H', content: 'a\nb\n' });
    assert.equal(one.content, '# H\nbody\na\nb\n');
    const extra = applyHeadingPatch(doc, { operation: 'append', target: 'H', content: 'a\n\n' });
    assert.equal(extra.content, '# H\nbody\na\n\n');
  });
});

// --- Idempotency + creation -----------------------------------------------------

describe('applyIfContentPreexists / createTargetIfMissing', () => {
  test('skip when the section already contains the content (CRLF section vs LF probe)', () => {
    const doc = `# H${CRLF}déjà là${CRLF}`;
    const out = applyHeadingPatch(doc, {
      operation: 'append',
      target: 'H',
      content: 'déjà là',
      applyIfContentPreexists: true,
    });
    assert.equal(out.applied, false);
    assert.equal(out.skippedReason, 'content-preexists');
    assert.equal(out.content, doc);
  });

  test('applies when the content is NOT in the section', () => {
    const out = applyHeadingPatch('# H\nbody\n', {
      operation: 'append',
      target: 'H',
      content: 'nouveau',
      applyIfContentPreexists: true,
    });
    assert.equal(out.applied, true);
  });

  test('createTargetIfMissing: missing leaf is created under its existing parent (level+1)', () => {
    const doc = '# A\na-text\n## B\nb-text\n# Z\nz-text\n';
    const out = applyHeadingPatch(doc, {
      operation: 'append',
      target: 'A::Nouveau',
      content: 'x',
      createTargetIfMissing: true,
    });
    assert.equal(out.createdTarget, true);
    // Created at the end of A's subtree (after b-text, before # Z).
    assert.match(out.content, /b-text\n\n## Nouveau\nx\n# Z/);
  });

  test('createTargetIfMissing: fully absent path is created at EOF, nested', () => {
    const out = applyHeadingPatch('texte libre\n', {
      operation: 'append',
      target: 'Un::Deux',
      content: 'x',
      createTargetIfMissing: true,
    });
    assert.match(out.content, /texte libre\n\n# Un\n## Deux\nx\n$/);
  });

  test('without createTargetIfMissing a missing path throws invalid-target', () => {
    assert.throws(
      () => applyHeadingPatch('# A\n', { operation: 'append', target: 'A::Missing', content: 'x' }),
      /invalid-target/,
    );
  });
});

// --- Odds and ends ---------------------------------------------------------------

describe('edges', () => {
  test('BOM is preserved and does not hide the first heading', () => {
    const doc = '﻿# H\nbody\n';
    const out = applyHeadingPatch(doc, { operation: 'append', target: 'H', content: 'x' });
    assert.ok(out.content.startsWith('﻿# H'));
    assert.match(out.content, /body\nx\n$/);
  });

  test('dominantEol: majority wins; no newlines → LF', () => {
    assert.equal(dominantEol('a\r\nb\r\nc\n'), '\r\n');
    assert.equal(dominantEol('a\nb\nc\r\n'), '\n');
    assert.equal(dominantEol('sans fin de ligne'), '\n');
  });

  test('parseHeadings builds full ancestor paths', () => {
    const lines = ['# A\n', '## B\n', '### C\n', '## D\n'];
    const hs = parseHeadings(lines);
    assert.deepEqual(hs.map((h) => h.path), [['A'], ['A', 'B'], ['A', 'B', 'C'], ['A', 'D']]);
  });

  test('empty path segment throws', () => {
    assert.throws(
      () => applyHeadingPatch('# A\n', { operation: 'append', target: 'A::', content: 'x' }),
      /empty segment/,
    );
  });

  test('unknown operation throws invalid-operation', () => {
    assert.throws(
      () => applyHeadingPatch('# A\n', { operation: 'delete', target: 'A', content: 'x' }),
      /invalid-operation/,
    );
  });
});
