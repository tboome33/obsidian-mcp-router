/**
 * Tests for `setup-vault.mjs --install-global-convention <name>` and
 * `--list-global-conventions` (v0.13.9).
 *
 * The mode appends a snippet shipped under templates/global-claude-md-snippets/
 * to the user's ~/.claude/CLAUDE.md with HTML-comment markers for idempotency.
 *
 * Strategy: redirect $HOME (via USERPROFILE on Windows, HOME elsewhere) to a
 * temp dir so the script writes a temp CLAUDE.md instead of touching the real
 * user file.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT_PATH = path.resolve(__dirname, '..', 'scripts', 'setup-vault.mjs');

function homeEnv(homeDir) {
  // On Windows, os.homedir() reads USERPROFILE; on Unix it reads HOME. Override
  // both so the same test runs on every platform. We must also strip the other
  // common Windows vars (HOMEDRIVE/HOMEPATH) so they don't take precedence.
  return {
    HOME: homeDir,
    USERPROFILE: homeDir,
    HOMEDRIVE: '',
    HOMEPATH: '',
  };
}

function runScript(args, homeDir, extraEnv = {}) {
  return spawnSync(
    process.execPath,
    [SCRIPT_PATH, ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, ...homeEnv(homeDir), ...extraEnv },
    },
  );
}

describe('--list-global-conventions', () => {
  test('enumerates shipped snippets, exit 0', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'list-conv-test-'));
    try {
      const result = runScript(['--list-global-conventions'], homeDir);
      assert.equal(result.status, 0);
      // obsidian-vault-links is shipped — assert it shows up.
      assert.match(result.stdout, /obsidian-vault-links/);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

describe('--install-global-convention', () => {
  let homeDir;
  let claudeMd;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-conv-test-'));
    claudeMd = path.join(homeDir, '.claude', 'CLAUDE.md');
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  test('first-time install: creates CLAUDE.md with marker block', () => {
    assert.equal(fs.existsSync(claudeMd), false, 'pre-condition: file absent');

    const result = runScript(['--install-global-convention', 'obsidian-vault-links'], homeDir);
    assert.equal(result.status, 0, `stderr=${result.stderr}`);

    assert.equal(fs.existsSync(claudeMd), true);
    const content = fs.readFileSync(claudeMd, 'utf8');
    assert.match(content, /<!-- BEGIN obsidian-mcp-router:obsidian-vault-links -->/);
    assert.match(content, /<!-- END obsidian-mcp-router:obsidian-vault-links -->/);
    assert.match(content, /click-to-open/i, 'snippet body must be included');
  });

  test('append to non-empty existing CLAUDE.md: preserves user content + adds markers', () => {
    fs.mkdirSync(path.dirname(claudeMd), { recursive: true });
    const userContent = '# My existing CLAUDE.md\n\nSome custom rules I wrote myself.\n';
    fs.writeFileSync(claudeMd, userContent);

    const result = runScript(['--install-global-convention', 'obsidian-vault-links'], homeDir);
    assert.equal(result.status, 0);

    const after = fs.readFileSync(claudeMd, 'utf8');
    assert.ok(after.startsWith(userContent), 'user content must remain at the top');
    assert.match(after, /<!-- BEGIN obsidian-mcp-router:obsidian-vault-links -->/);
  });

  test('idempotent: re-running is a no-op when block is already present', () => {
    const r1 = runScript(['--install-global-convention', 'obsidian-vault-links'], homeDir);
    assert.equal(r1.status, 0);
    const mtime1 = fs.statSync(claudeMd).mtimeMs;
    const content1 = fs.readFileSync(claudeMd, 'utf8');

    const r2 = runScript(['--install-global-convention', 'obsidian-vault-links'], homeDir);
    assert.equal(r2.status, 0);
    assert.match(r2.stdout + r2.stderr, /already installed/i);

    const mtime2 = fs.statSync(claudeMd).mtimeMs;
    assert.equal(mtime2, mtime1, 'file must not be rewritten on re-run');
    assert.equal(fs.readFileSync(claudeMd, 'utf8'), content1);
  });

  test('--force replaces marker block contents, preserves content outside markers', () => {
    // First install with normal flow
    runScript(['--install-global-convention', 'obsidian-vault-links'], homeDir);

    // Manually inject content BEFORE and AFTER the marker block — simulating
    // the user adding their own rules around our section.
    const before = fs.readFileSync(claudeMd, 'utf8');
    const withSurrounding =
      '# My header above\n\nUser rule 1.\n\n' +
      before +
      '\n## My section below\n\nUser rule 2.\n';
    fs.writeFileSync(claudeMd, withSurrounding);

    // Also manually mangle the inside of the markers so we can detect the upgrade.
    const mangled = withSurrounding.replace(
      /(<!-- BEGIN obsidian-mcp-router:obsidian-vault-links -->\n)[\s\S]*?(<!-- END obsidian-mcp-router:obsidian-vault-links -->)/,
      '$1OLD MANGLED CONTENT\n$2',
    );
    fs.writeFileSync(claudeMd, mangled);
    assert.match(fs.readFileSync(claudeMd, 'utf8'), /OLD MANGLED CONTENT/);

    // Now upgrade with --force
    const result = runScript(
      ['--install-global-convention', 'obsidian-vault-links', '--force'],
      homeDir,
    );
    assert.equal(result.status, 0);
    assert.match(result.stdout + result.stderr, /upgraded/i);

    const after = fs.readFileSync(claudeMd, 'utf8');
    assert.doesNotMatch(after, /OLD MANGLED CONTENT/, 'force should replace block contents');
    assert.match(after, /click-to-open/i, 'fresh canonical snippet should be back');

    // Surrounding user content preserved
    assert.match(after, /# My header above/);
    assert.match(after, /User rule 1/);
    assert.match(after, /## My section below/);
    assert.match(after, /User rule 2/);
  });

  test('--dry-run: does not write anything', () => {
    const result = runScript(
      ['--install-global-convention', 'obsidian-vault-links', '--dry-run'],
      homeDir,
    );
    assert.equal(result.status, 0);
    assert.match(result.stdout + result.stderr, /\[DRY-RUN\]/);
    assert.equal(fs.existsSync(claudeMd), false, 'dry-run must not create the file');
  });

  test('unknown snippet name: reports + exits 1', () => {
    const result = runScript(
      ['--install-global-convention', 'no-such-snippet-xyz'],
      homeDir,
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /no snippet 'no-such-snippet-xyz\.md'/i);
    assert.match(result.stdout + result.stderr, /obsidian-vault-links/, 'should list available');
  });

  test('no name arg: prints helpful usage + exits 1', () => {
    const result = runScript(['--install-global-convention'], homeDir);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /requires a snippet name/i);
  });

  test('forced re-install when marker is BEGIN-only (missing END): refuses safely', () => {
    fs.mkdirSync(path.dirname(claudeMd), { recursive: true });
    fs.writeFileSync(claudeMd, '<!-- BEGIN obsidian-mcp-router:obsidian-vault-links -->\nbroken content with no END marker\n');

    const result = runScript(
      ['--install-global-convention', 'obsidian-vault-links', '--force'],
      homeDir,
    );
    assert.notEqual(result.status, 0, 'should refuse the dangerous overwrite');
    assert.match(result.stdout + result.stderr, /no matching END marker/i);
  });
});
