/**
 * WIRE FIDELITY — the serialisation step adds no difference of its own.
 *
 * Phase 0 of the RTK borrowing roadmap writes this guard before any phase
 * changes how the router serialises its answers (Phase 1: compact JSON at the
 * single boundary, `wrapResult`). The property:
 *
 *   what the model DECODES from a response equals what the sanitiser produced.
 *
 * The sanitiser itself changes some text on purpose (control bytes, ANSI
 * sequences, agent markup such as `<system-reminder`), and its own suite pins
 * that. What must never happen is a SECOND, accidental difference introduced
 * by the way the value is written out — a lost carriage return, a mangled
 * backslash, a dropped final newline. Those are exactly the bytes a later
 * `patch_file` anchors on and a later `ifMatch` hash covers.
 *
 * So the fixtures are the shapes a serialiser gets wrong, and the assertion is
 * deep equality after decoding, whatever the indentation.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { _internals } from '../src/index.mjs';
import { sanitizeResponse, NO_TRUNCATION } from '../src/helpers/sanitize.mjs';

const { wrapResult } = _internals;

// Note bodies a serialiser can damage. Every one is a string a vault can hold.
const BODIES = {
  crlf: '# Titre\r\n\r\nPremière ligne.\r\nDeuxième ligne.\r\n',
  trailingNewline: 'Une phrase complète.\n',
  noTrailingNewline: 'Une phrase complète.',
  blankRuns: 'a\n\n\n\nb\n',
  tabsAndSpaces: '\tindenté\n    quatre espaces\n  ',
  quotesAndBackslashes: 'Il a dit "bonjour" et C:\\Users\\x\\note.md, puis \\n en clair.',
  unicode: 'Accents éàü, drapeau 🇫🇷, idéogrammes 漢字, ZWJ 👩‍💻, astral 𝔸.',
  markdown: '- [ ] tâche\n> [!note] callout\n```js\nconst x = `${y}`;\n```\n[[lien|alias]] ^bloc-id',
  htmlComment: '<!-- commentaire --> texte <span>inline</span>',
  frontmatter: '---\ntitle: "x: y"\ntags:\n  - a\n---\nCorps.\n',
  empty: '',
};

const decode = (wire) => {
  assert.equal(wire.content.length, 1, 'one text block');
  assert.equal(wire.content[0].type, 'text');
  return JSON.parse(wire.content[0].text);
};

describe('wrapResult adds no difference beyond the sanitiser', () => {
  for (const [name, body] of Object.entries(BODIES)) {
    test(`a get_file-shaped result: ${name}`, async () => {
      const raw = { vault: 'v', path: 'wiki/a.md', content: body, contentSha256: 'a'.repeat(64) };
      const decoded = decode(await wrapResult(Promise.resolve(raw)));
      assert.deepEqual(decoded, sanitizeResponse(raw, { maxLen: NO_TRUNCATION }));
    });
  }

  test('positive control: on these bodies the sanitiser itself changes nothing, so the model gets the note verbatim', async () => {
    // Without this, a sanitiser that started eating carriage returns would
    // keep the test above green — both sides would lose them together.
    for (const [name, body] of Object.entries(BODIES)) {
      const decoded = decode(await wrapResult(Promise.resolve({ content: body })));
      assert.equal(decoded.content, body, name);
    }
  });

  test('a search-shaped result with nested arrays and numbers decodes to the same value', async () => {
    const raw = {
      query: 'q',
      perVault: [
        { vault: 'a', matches: [{ filename: 'x.md', score: -686.8835, matches: [{ match: { start: 1, end: 3 }, context: BODIES.crlf }] }] },
        { vault: 'b', error: 'unreachable' },
      ],
    };
    assert.deepEqual(decode(await wrapResult(Promise.resolve(raw))), sanitizeResponse(raw, { maxLen: NO_TRUNCATION }));
  });

  test('a string result is passed through as text, not wrapped in JSON quotes', async () => {
    const wire = await wrapResult(Promise.resolve(BODIES.crlf));
    assert.equal(wire.content[0].text, BODIES.crlf);
  });
});
