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

  // v0.14.9 (Reviewer B P2): mutual-exclusion contract is encoded in the
  // schema, not just enforced at the handler level.
  test('TOOLS schema has oneOf mutual-exclusion for path vs paths', () => {
    // Normalize CRLF → LF: on a Windows checkout with git autocrlf=true
    // the file has `\r\n`, and the block-boundary regex below ends in a
    // bare `\n` that can't match `},\r\n` — which reddened CI on the
    // Windows runners while passing locally (autocrlf=input → LF).
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', 'src', 'index.mjs'),
      'utf8',
    ).replace(/\r\n/g, '\n');
    // Find the build_open_link tool block and assert it contains a oneOf
    // with `path` xor `paths`. Brittle but cheap — drift here is a real
    // bug, the test SHOULD complain if someone removes the contract.
    const m = src.match(/name:\s*['"]build_open_link['"][\s\S]*?\n\s\s\},\n/);
    assert.ok(m, 'could not locate build_open_link tool block');
    assert.match(m[0], /oneOf:\s*\[/, 'oneOf missing from build_open_link schema');
    assert.match(m[0], /required:\s*\[\s*['"]path['"]\s*\]/);
    assert.match(m[0], /required:\s*\[\s*['"]paths['"]\s*\]/);
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
