/**
 * Wiring tests for the v0.14.8 click-to-open enrichment.
 *
 * The integration we want to guarantee: every vault-touching tool wrapper
 * imports the `buildClickToOpenUrl` helper AND emits a `clickToOpenUrl` (or
 * `clickToOpenLinks`) field in its return shape. Drift here defeats the
 * whole deterministic guarantee — the LLM is supposed to read tool results
 * and copy the URL verbatim without composing it by hand.
 *
 * Pure ESM module mocking via `mock.method` doesn't work because ESM module
 * exports are frozen (Cannot redefine property). Module-level mocking with
 * `mock.module()` is possible but fragile across Node versions. Instead we
 * do a static-wiring check: read each tool source file and assert it:
 *   (a) imports the helper, and
 *   (b) mentions `clickToOpenUrl` (the field name) in its body.
 *
 * If you add a new mutating tool, ADD IT TO `VAULT_TOUCHING_TOOLS` below.
 * The cross-check is duplicated against the runtime TOOL_HANDLERS / TOOLS
 * dispatch (which itself catches drift at boot), so this test is the
 * second line of defence for the chat-link guarantee specifically.
 *
 * Also runs an end-to-end smoke test of `build_open_link` (which doesn't
 * touch the rest-client, so it's safely testable end-to-end here).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { _internals } from '../src/index.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TOOLS_DIR = path.resolve(__dirname, '..', 'src', 'tools');

// Tools whose result MUST carry `clickToOpenUrl` (single file → single URL).
const SINGLE_FILE_TOOLS = [
  'write-file.mjs',
  'get-file.mjs',
  'append-to-file.mjs',
  'patch-file.mjs',
  'move-file.mjs',
  'set-frontmatter.mjs',
  'merge-frontmatter.mjs',
  'get-frontmatter.mjs',
  'execute-template.mjs',
];

// Tools whose result MUST carry `clickToOpenLinks` (many files → URL map).
const MULTI_FILE_TOOLS = [
  'search.mjs',
  'search-smart.mjs',
];

describe('click-to-open helper is imported by every vault-touching tool', () => {
  for (const toolFile of SINGLE_FILE_TOOLS) {
    test(`${toolFile} imports buildClickToOpenUrl`, () => {
      const src = fs.readFileSync(path.join(TOOLS_DIR, toolFile), 'utf8');
      assert.match(
        src,
        /from\s+['"]\.\.\/helpers\/click-to-open\.mjs['"]/,
        `${toolFile} must import from '../helpers/click-to-open.mjs'`,
      );
      assert.match(
        src,
        /buildClickToOpenUrl/,
        `${toolFile} must call buildClickToOpenUrl`,
      );
    });

    test(`${toolFile} includes clickToOpenUrl in its return shape`, () => {
      const src = fs.readFileSync(path.join(TOOLS_DIR, toolFile), 'utf8');
      assert.match(
        src,
        /clickToOpenUrl/,
        `${toolFile} must emit a clickToOpenUrl field in its result`,
      );
    });
  }

  for (const toolFile of MULTI_FILE_TOOLS) {
    test(`${toolFile} imports collectClickToOpenLinks`, () => {
      const src = fs.readFileSync(path.join(TOOLS_DIR, toolFile), 'utf8');
      assert.match(
        src,
        /from\s+['"]\.\.\/helpers\/click-to-open-walker\.mjs['"]/,
        `${toolFile} must import from '../helpers/click-to-open-walker.mjs'`,
      );
      assert.match(
        src,
        /collectClickToOpenLinks/,
        `${toolFile} must call collectClickToOpenLinks`,
      );
    });

    test(`${toolFile} spreads the collector output into its result`, () => {
      const src = fs.readFileSync(path.join(TOOLS_DIR, toolFile), 'utf8');
      // The collector returns either `{}` (empty) or `{ clickToOpenLinks: {...} }`.
      // Tools should spread its result so the key appears at the top level.
      assert.match(
        src,
        /\.\.\.collectClickToOpenLinks/,
        `${toolFile} must spread collectClickToOpenLinks(...) into its result`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// build_open_link is registered in src/index.mjs (TOOLS array + TOOL_HANDLERS)
// ---------------------------------------------------------------------------
describe('build_open_link is wired into the MCP surface', () => {
  test('TOOL_HANDLERS includes build_open_link', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', 'src', 'index.mjs'),
      'utf8',
    );
    assert.match(src, /build_open_link:\s*\(reg, args\)\s*=>\s*buildOpenLinkTool/);
  });

  test('TOOLS schema includes build_open_link', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', 'src', 'index.mjs'),
      'utf8',
    );
    assert.match(src, /name:\s*['"]build_open_link['"]/);
  });

  test('buildOpenLinkTool is imported at the top of index.mjs', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', 'src', 'index.mjs'),
      'utf8',
    );
    assert.match(
      src,
      /import\s+\{\s*buildOpenLinkTool\s*\}\s*from\s+['"]\.\/tools\/build-open-link\.mjs['"]/,
    );
  });

  // v0.19.1: the `path` xor `paths` contract is enforced at RUNTIME
  // (build-open-link.mjs rejects both/neither) and documented in the tool
  // description — NOT in the schema. The Anthropic Messages API rejects a
  // top-level `oneOf`/`allOf`/`anyOf` in ANY tool's input_schema, even
  // alongside `type: object` ("input_schema does not support oneOf, allOf,
  // or anyOf at the top level"), which 400s clients that inline the whole
  // catalogue (e.g. MCPHub). This guard asserts no tool re-introduces one.
  // (Composition keywords nested INSIDE a property — e.g. patch_file's
  // `content.oneOf` — are LEGITIMATE: the API forbids them only at the
  // schema ROOT. This guard is therefore intentionally NON-RECURSIVE and
  // checks only each inputSchema's top-level keys. Do NOT "harden" it by
  // walking sub-schemas ($defs / items / nested properties) — that would
  // false-positive on patch_file and any future tool with a legitimate
  // nested union, which is exactly what this guard must NOT flag.)
  test('no tool input_schema uses top-level oneOf/allOf/anyOf (Anthropic API constraint)', () => {
    const FORBIDDEN = ['oneOf', 'allOf', 'anyOf'];
    const offenders = _internals.TOOLS.filter((tool) => {
      const schema = tool.inputSchema || {};
      // Root-only by design (see the non-recursive note above): hasOwnProperty
      // on the schema object itself — never a deep walk into sub-schemas.
      return FORBIDDEN.some((kw) =>
        Object.prototype.hasOwnProperty.call(schema, kw),
      );
    }).map((tool) => tool.name);
    assert.deepStrictEqual(
      offenders,
      [],
      `tools with a forbidden top-level schema composition keyword: ${
        offenders.join(', ') || '(none)'
      }`,
    );
  });
});

// ---------------------------------------------------------------------------
// v0.14.9 (Reviewer A IMPORTANT-4): move_file emits clickToOpenUrlSource
// when the source-delete step failed. Static wiring check — runtime path
// requires rest-client mocking which ESM frozen exports block.
// ---------------------------------------------------------------------------
describe('move_file dual-URL on partial failure (v0.14.9)', () => {
  test('move-file.mjs emits clickToOpenUrlSource gated on moved:true && sourceDeleted:false', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', 'src', 'tools', 'move-file.mjs'),
      'utf8',
    );
    // Both URLs must be wired
    assert.match(src, /clickToOpenUrl/);
    assert.match(src, /clickToOpenUrlSource/);
    // The source URL must be conditional on the move RESULT — BOTH that
    // the move actually happened (excludes same-path no-op) AND that the
    // source was NOT deleted (the actual partial-failure signal). pass-3
    // hardening (Reviewer B P3 on pass 3).
    assert.match(src, /result\.moved\s*===\s*true/);
    assert.match(src, /sourceDeleted\s*===\s*false/);
  });
});

// ---------------------------------------------------------------------------
// End-to-end smoke for build_open_link (safe — no rest-client involved)
// ---------------------------------------------------------------------------
describe('build_open_link end-to-end smoke', () => {
  let vaultPath;
  let registry;

  test('setup', () => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bol-smoke-'));
    const pluginDir = path.join(
      vaultPath, '.obsidian', 'plugins', 'obsidian-local-rest-api',
    );
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'data.json'),
      JSON.stringify({ insecurePort: 27123, enableInsecureServer: true }),
    );
    // build_open_link verifies existence on disk (v0.45.0) → the cited files
    // must exist in the smoke vault.
    for (const rel of ['wiki/foo.md', 'a.md', 'wiki/b.md', 'wiki/Divers/c.md']) {
      const abs = path.join(vaultPath, ...rel.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, '# ' + rel);
    }
    registry = {
      resolveVault: () => ({ type: 'local', path: vaultPath, name: 'smoke' }),
      defaultVault: 'smoke',
    };
  });

  test('single path round-trip', async () => {
    const { buildOpenLinkTool } = await import('../src/tools/build-open-link.mjs');
    const { _resetCache } = await import('../src/helpers/click-to-open.mjs');
    _resetCache();
    const result = await buildOpenLinkTool(registry, { path: 'wiki/foo.md' });
    assert.equal(
      result.clickToOpenUrl,
      'http://127.0.0.1:27123/open/wiki%2Ffoo.md',
    );
  });

  test('batch round-trip', async () => {
    const { buildOpenLinkTool } = await import('../src/tools/build-open-link.mjs');
    const { _resetCache } = await import('../src/helpers/click-to-open.mjs');
    _resetCache();
    const result = await buildOpenLinkTool(registry, {
      paths: ['a.md', 'wiki/b.md', 'wiki/Divers/c.md'],
    });
    assert.equal(result.links.length, 3);
    assert.equal(
      result.links[0].clickToOpenUrl,
      'http://127.0.0.1:27123/open/a.md',
    );
    assert.equal(
      result.links[1].clickToOpenUrl,
      'http://127.0.0.1:27123/open/wiki%2Fb.md',
    );
    assert.equal(
      result.links[2].clickToOpenUrl,
      'http://127.0.0.1:27123/open/wiki%2FDivers%2Fc.md',
    );
  });

  test('cleanup', () => {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });
});
