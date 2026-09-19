/**
 * GUARD — a vault write goes through the door that has a lock on it.
 *
 * THE DEFECT THIS EXISTS TO CATCH, in the shape it actually took. On
 * 2026-09-19 three notes in a SHARED vault were rewritten by a hand-rolled
 * `fetch(url, { method: 'PUT' })` against the core `/vault/` route. Every one
 * landed with no precondition and nothing said so, for two reasons — the sha
 * was read from a field the Local REST API does not expose, and, decisively,
 * `PUT /vault/<path>` implements no precondition at all. The only `if-match`
 * code in that plugin lives in a bundled `send` library that serves static
 * GETs. Measured, not assumed.
 *
 * The precondition the repo relies on is `If-Match-Content-Sha256` on
 * `PUT /vault-cas/<path>`, served by the companion bridge, and
 * `writeFileIfMatch` in `src/rest-client.mjs` is its only handle.
 *
 * WHAT A GUARD LIKE THIS CAN AND CANNOT DO. It cannot reach an ad-hoc script
 * in a scratchpad — nothing in this repository can, which is why
 * `scripts/vault-edit.mjs` exists to make the right door the short one. What
 * it does is keep the repository itself honest, and state the rule somewhere
 * executable rather than in a memory file somebody will contradict.
 *
 * SCANNING FOR THE FORBIDDEN THING, NOT FOR THE REQUIRED ONE. The sibling
 * guard in security-invariants records the lesson the hard way: its first
 * version asserted that a file MENTIONED the right helper, and a review proved
 * it passed on a file where the real call had been deleted. A scan that looks
 * for the offending construct cannot be satisfied by a dead mention. And the
 * scan itself is driven against synthetic sources below — an inert regex would
 * otherwise report a clean repository forever.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEdits } from '../scripts/vault-edit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

/**
 * Strip comments so that PROSE ABOUT the defect is not mistaken for the
 * defect. This file, and `scripts/vault-edit.mjs`, both quote the offending
 * snippet in their headers on purpose; a scan that flagged them would be
 * uninstallable, and the usual response to an uninstallable guard is to weaken
 * it until it catches nothing.
 *
 * Quote- and template-aware, because `'https://x/y // z'` is not a comment and
 * a naive strip would swallow the rest of the line. Escape sequences are
 * honoured inside strings for the same reason.
 *
 * @param {string} src
 * @returns {string} the same length is NOT preserved; only code survives
 */
export function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i += 1;
      while (i < n) {
        if (src[i] === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
        out += src[i];
        if (src[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Blank the CONTENTS of string literals, keeping the quotes. Two questions
 * need two views of a file, and conflating them produced three false
 * positives on the first run:
 *
 *   - "does this file CALL fetch()" is about code. `subprocess-env.mjs`
 *     describes a tool as `'yt-dlp caption fetch (…)'` in a data table, and a
 *     scan that reads inside strings called that a network call.
 *   - "does this file NAME a vault route" is about string literals, so that
 *     view has to keep them.
 *
 * @param {string} code output of stripComments
 */
export function blankStrings(code) {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === "'" || c === '"' || c === '`') {
      out += c;
      i += 1;
      while (i < code.length) {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === c) { out += c; i += 1; break; }
        // A template literal's ${...} holes are CODE, not text: a hand-rolled
        // `${base}/vault/${p}` keeps its expression, and a fetch() called from
        // inside one stays visible.
        if (c === '`' && code[i] === '$' && code[i + 1] === '{') {
          let depth = 1;
          out += '${';
          i += 2;
          while (i < code.length && depth > 0) {
            if (code[i] === '{') depth += 1;
            else if (code[i] === '}') depth -= 1;
            if (depth > 0) out += code[i];
            i += 1;
          }
          out += '}';
          continue;
        }
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** HTTP verbs that change a vault. A GET is a different question. */
const WRITE_VERBS = /['"](PUT|POST|PATCH|DELETE)['"]/;
/**
 * The core vault route, however it is assembled. Deliberately NOT anchored to
 * a quote: the defect of 2026-09-19 built it as `${base}/vault/${path}`, where
 * nothing quotes the route itself.
 */
const VAULT_ROUTE = /\/vault\//;
/** The call that bypasses the router's transport entirely. */
const RAW_FETCH = /\bfetch\s*\(/;

/**
 * Files allowed to speak HTTP directly, each for a stated reason. An entry
 * here is a DECISION; adding one is the deliberate act the guard exists to
 * force. Anything else calling `fetch` is a new door nobody reviewed.
 */
export const RAW_HTTP_ALLOWLIST = new Map([
  ['src/rest-client.mjs', 'the transport itself — the only module that may name a vault route'],
  ['src/helpers/view-link.mjs', 'probes the bridge /open/ route; never writes'],
  ['src/markdownify/markitdown.mjs', 'talks to a converter service, not to a vault'],
  ['scripts/bridge-fleet-update.mjs', 'deploys plugin files under .obsidian/, which REST does not serve'],
]);

/** Directories whose sources ship, and therefore whose sources are the rule. */
const SCANNED_DIRS = ['src', 'scripts', 'hooks', 'bin'];

function walkSources(dir, prefix, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    const rel = `${prefix}${entry.name}`;
    if (entry.isDirectory()) walkSources(abs, `${rel}/`, out);
    else if (/\.(mjs|js)$/.test(entry.name)) out.push({ rel, abs });
  }
  return out;
}

/**
 * @param {Array<{rel: string, source: string}>} files
 * @returns {Array<{file: string, reason: string}>}
 */
export function scanForUnguardedVaultWrites(files) {
  const findings = [];
  for (const { rel, source } of files) {
    const code = stripComments(source);
    const calls = blankStrings(code);
    const allowed = RAW_HTTP_ALLOWLIST.has(rel);
    if (WRITE_VERBS.test(code) && VAULT_ROUTE.test(code) && rel !== 'src/rest-client.mjs') {
      findings.push({ file: rel, reason: 'names a core /vault/ route with a write verb' });
      continue;
    }
    if (RAW_FETCH.test(calls) && !allowed) {
      findings.push({ file: rel, reason: 'calls fetch() outside the allowlist' });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------

describe('GUARD — no source writes to a vault outside the transport', () => {
  const files = SCANNED_DIRS
    .filter((d) => fs.existsSync(path.join(ROOT, d)))
    .flatMap((d) => walkSources(path.join(ROOT, d), `${d}/`))
    .map(({ rel, abs }) => ({ rel, source: fs.readFileSync(abs, 'utf8') }));

  test('the scan actually reads a repository (vacuity guard)', () => {
    assert.ok(files.length > 50, `expected the source tree, saw ${files.length} files`);
    assert.ok(
      files.some((f) => f.rel === 'src/rest-client.mjs'),
      'the transport itself must be among the scanned files, or the scan is looking elsewhere',
    );
  });

  test('no source file issues a vault write of its own', () => {
    const findings = scanForUnguardedVaultWrites(files);
    assert.deepEqual(
      findings,
      [],
      'a vault write must go through writeFileIfMatch in src/rest-client.mjs — '
      + `offenders: ${findings.map((f) => `${f.file} (${f.reason})`).join(', ')}`,
    );
  });

  test('every allowlist entry still exists, and carries a reason', () => {
    // An allowlist that outlives its files stops being a list of decisions and
    // becomes a list of names, and the next reader widens it by habit.
    for (const [rel, reason] of RAW_HTTP_ALLOWLIST) {
      assert.ok(fs.existsSync(path.join(ROOT, rel)), `allowlisted file is gone: ${rel}`);
      assert.ok(reason && reason.length > 20, `allowlist entry ${rel} has no real reason`);
    }
  });
});

describe('GUARD — the scan is not inert (positive controls)', () => {
  // WITHOUT THESE, A REGEX THAT MATCHES NOTHING REPORTS A CLEAN REPOSITORY
  // FOREVER. Three artefacts in this project's history reported "no cost"
  // from an instrument that never fired; the rule since is to build the
  // effect deliberately and watch the needle move before trusting a zero.
  const OFFENDER = [
    'const url = `${base}/vault/${encodeURIComponent(p)}`;',
    "await fetch(url, { method: 'PUT', headers: auth, body });",
  ].join('\n');

  test('a hand-rolled PUT /vault/ IS flagged', () => {
    const found = scanForUnguardedVaultWrites([{ rel: 'scripts/offender.mjs', source: OFFENDER }]);
    assert.equal(found.length, 1, 'the exact defect of 2026-09-19 must be caught');
    assert.match(found[0].reason, /vault\/ route with a write verb/);
  });

  test('a bare fetch() outside the allowlist IS flagged', () => {
    const found = scanForUnguardedVaultWrites([
      { rel: 'src/tools/new-thing.mjs', source: 'const r = await fetch("https://example.test/x");' },
    ]);
    assert.equal(found.length, 1);
    assert.match(found[0].reason, /outside the allowlist/);
  });

  test('the SAME code inside a comment is NOT flagged', () => {
    // The false positive that would make this guard uninstallable: both this
    // file and scripts/vault-edit.mjs quote the defect in their headers.
    const commented = `/**\n * ${OFFENDER.split('\n').join('\n * ')}\n */\nexport const x = 1;\n`;
    assert.deepEqual(scanForUnguardedVaultWrites([{ rel: 'scripts/doc.mjs', source: commented }]), []);
  });

  test('a URL containing // inside a string does not swallow the line', () => {
    // A naive comment stripper would eat from `//` to end of line and hide a
    // real offender written on one line.
    const sneaky = 'const u = "https://127.0.0.1/vault/x.md"; await fetch(u, { method: "PUT" });';
    const found = scanForUnguardedVaultWrites([{ rel: 'scripts/sneaky.mjs', source: sneaky }]);
    assert.equal(found.length, 1, 'the stripper must not treat "//" inside a string as a comment');
  });

  test('the transport itself is exempt, by name', () => {
    assert.deepEqual(
      scanForUnguardedVaultWrites([{ rel: 'src/rest-client.mjs', source: OFFENDER }]),
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// The CLI's decision logic — pure, so it is pinned without a vault
// ---------------------------------------------------------------------------

describe('vault-edit — an edit matches exactly once, or nothing is written', () => {
  const DOC = ['# Title', '', 'alpha line', 'beta line', 'alpha line', ''].join('\n');

  test('a unique substring is replaced', () => {
    const { after, applied } = applyEdits(DOC, [{ kind: 'unique', from: 'beta line', to: 'gamma line' }]);
    assert.ok(after.includes('gamma line'));
    assert.equal(applied.length, 1);
    // Everything else is byte-identical.
    assert.equal(after.replace('gamma line', 'beta line'), DOC);
  });

  test('ZERO matches refuses — a stale anchor is not a silent no-op', () => {
    assert.throws(
      () => applyEdits(DOC, [{ kind: 'unique', from: 'absent', to: 'x' }]),
      /matched 0 times/,
    );
  });

  test('TWO matches refuses — an ambiguous anchor names nothing', () => {
    assert.throws(
      () => applyEdits(DOC, [{ kind: 'unique', from: 'alpha line', to: 'x' }]),
      /matched 2 times/,
    );
  });

  test('a line is addressed by its prefix, which dodges the apostrophe trap', () => {
    // The form that exists because a straight ' and a typographic ' are
    // indistinguishable in a terminal, and each wrong guess costs a run.
    const src = ["- 🔧 Durcir le lecteur, au moment d'écrire", '- autre'].join('\n');
    const { after } = applyEdits(src, [{ kind: 'line', startsWith: '- 🔧 Durcir', to: '- ✅ fait' }]);
    assert.equal(after, ['- ✅ fait', '- autre'].join('\n'));
  });

  test('a prefix matching two lines refuses', () => {
    assert.throws(
      () => applyEdits('- a x\n- a y\n', [{ kind: 'line', startsWith: '- a', to: '- z' }]),
      /2 lines start with/,
    );
  });

  test('a multi-line replacement for a line edit refuses', () => {
    assert.throws(
      () => applyEdits('- a\n', [{ kind: 'line', startsWith: '- a', to: 'x\ny' }]),
      /must be a single line/,
    );
  });

  test('an edit whose result collides with another edit refuses', () => {
    // The corruption nobody would look for: edit 1 produces text that edit 2's
    // verification can no longer tell apart, so a region the caller never
    // touched could move. Refused rather than reasoned about.
    assert.throws(
      () => applyEdits('one\ntwo\n', [
        { kind: 'unique', from: 'one', to: 'two' },
      ]),
      /cannot be verified/,
    );
  });

  test('an empty or non-array edits list refuses', () => {
    assert.throws(() => applyEdits(DOC, []), /non-empty array/);
    assert.throws(() => applyEdits(DOC, 'nope'), /non-empty array/);
  });

  test('an unknown kind refuses instead of being ignored', () => {
    assert.throws(
      () => applyEdits(DOC, [{ kind: 'regex', from: 'a', to: 'b' }]),
      /must be "unique" or "line"/,
    );
  });
});
