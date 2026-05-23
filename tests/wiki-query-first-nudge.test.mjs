/**
 * Tests for hooks/wiki-query-first-nudge.mjs (v0.11.5 UserPromptSubmit hook).
 *
 * Strategy: spawn the hook with synthetic stdin (UserPromptSubmit event)
 * + a temp cwd that may or may not look like a vault (presence of
 * `wiki/index.md`). Verify stdout JSON contains the additionalContext
 * nudge for substantive vault-bound prompts, and stdout is empty for
 * filtered cases (non-vault, trivial, slash command, opt-out).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HOOK_PATH = path.resolve(__dirname, '..', 'hooks', 'wiki-query-first-nudge.mjs');

let workDir;
let vaultCwd;        // contains wiki/index.md → treated as vault
let nonVaultCwd;     // empty dir → treated as non-vault

before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wq-first-'));
  vaultCwd = fs.mkdtempSync(path.join(workDir, 'vault-'));
  fs.mkdirSync(path.join(vaultCwd, 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(vaultCwd, 'wiki', 'index.md'), '# Index\n');
  nonVaultCwd = fs.mkdtempSync(path.join(workDir, 'plain-'));
});

after(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/**
 * Run the hook with given prompt + cwd + optional env. Returns the
 * spawnSync result + parsed JSON output if any.
 */
function runHook({ prompt = '', cwd = nonVaultCwd, env = {} } = {}) {
  const stdin = JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    prompt,
    cwd,
    session_id: 'test-session',
    transcript_path: '/tmp/fake-transcript.jsonl',
  });
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 10000,
  });
  let parsed = null;
  if (result.stdout && result.stdout.trim()) {
    try { parsed = JSON.parse(result.stdout); } catch { /* not JSON */ }
  }
  return { ...result, parsed };
}

// ---------------------------------------------------------------------------
// Filter cases — exit 0 silent
// ---------------------------------------------------------------------------

describe('wiki-query-first-nudge — silent (no nudge) cases', () => {
  test('non-vault cwd (no wiki/index.md) → silent', () => {
    const r = runHook({ prompt: 'Comment fait-on X dans le projet ?', cwd: nonVaultCwd });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });

  test('vault cwd + empty prompt → silent', () => {
    const r = runHook({ prompt: '', cwd: vaultCwd });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });

  test('vault cwd + short prompt (< 20 chars) → silent', () => {
    const r = runHook({ prompt: 'oui continue', cwd: vaultCwd });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });

  test('vault cwd + slash command → silent', () => {
    const r = runHook({ prompt: '/save the current conversation as a note', cwd: vaultCwd });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });

  test('vault cwd + multi-word borderline-trivial (oui merci continue stp) → NOT silent', () => {
    // Edge case by design: the hook only catches single-word trivials
    // via the TRIVIAL regex. Multi-word borderline prompts ("oui merci
    // continue stp") pass through because they pass the length filter
    // (>20 chars) and don't match the strict single-word trivial regex.
    // Cost: ~200 tokens of nudge context that Claude can ignore. The
    // alternative (aggressive multi-word matching) would risk false
    // positives on real questions.
    const r = runHook({ prompt: 'oui merci continue stp', cwd: vaultCwd });
    assert.equal(r.status, 0);
    assert.ok(r.parsed, `expected JSON output for borderline case, got: ${r.stdout}`);
  });

  test('vault cwd + "OK" → silent', () => {
    const r = runHook({ prompt: 'OK', cwd: vaultCwd });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });

  test('vault cwd + "Continue" → silent', () => {
    const r = runHook({ prompt: 'Continue', cwd: vaultCwd });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });

  test('OBSIDIAN_ROUTER_NO_WIKI_QUERY_FIRST=true → silent even on substantive', () => {
    const r = runHook({
      prompt: 'Comment configurer la connexion RDP via WireGuard sur le PC cabinet ?',
      cwd: vaultCwd,
      env: { OBSIDIAN_ROUTER_NO_WIKI_QUERY_FIRST: 'true' },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });

  test('empty stdin → silent', () => {
    const r = spawnSync(process.execPath, [HOOK_PATH], {
      input: '',
      encoding: 'utf8',
      env: { ...process.env },
      timeout: 10000,
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });

  test('non-JSON stdin → silent', () => {
    const r = spawnSync(process.execPath, [HOOK_PATH], {
      input: 'not-json',
      encoding: 'utf8',
      env: { ...process.env },
      timeout: 10000,
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });
});

// ---------------------------------------------------------------------------
// Inject cases — exit 0 + JSON additionalContext
// ---------------------------------------------------------------------------

describe('wiki-query-first-nudge — inject (nudge) cases', () => {
  test('vault cwd + substantive question → injects additionalContext', () => {
    const r = runHook({
      prompt: 'Comment fait-on pour configurer une connexion RDP via WireGuard depuis le PC maison vers le PC cabinet ?',
      cwd: vaultCwd,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.parsed, `expected JSON output, got: ${r.stdout}`);
    assert.equal(r.parsed.hookSpecificOutput?.hookEventName, 'UserPromptSubmit');
    const ctx = r.parsed.hookSpecificOutput?.additionalContext || '';
    assert.match(ctx, /INVESTIGATION_REFLEX/);
    assert.match(ctx, /wiki\/index\.md/);
    assert.match(ctx, /search_smart/);
  });

  test('vault cwd + substantive imperative → injects', () => {
    const r = runHook({
      prompt: 'Refactore la fonction X pour utiliser la nouvelle API du module Y',
      cwd: vaultCwd,
    });
    assert.equal(r.status, 0);
    assert.ok(r.parsed);
    assert.match(r.parsed.hookSpecificOutput?.additionalContext || '', /INVESTIGATION_REFLEX/);
  });

  test('injected nudge includes opt-out env var name', () => {
    const r = runHook({
      prompt: 'Explique-moi comment cette architecture fonctionne dans ce projet',
      cwd: vaultCwd,
    });
    assert.equal(r.status, 0);
    const ctx = r.parsed?.hookSpecificOutput?.additionalContext || '';
    assert.match(ctx, /OBSIDIAN_ROUTER_NO_WIKI_QUERY_FIRST=true/);
  });

  test('CLAUDE_PROJECT_DIR is honored when cwd is missing in stdin payload', () => {
    // Some Claude Code versions might not set cwd in the JSON — fall
    // back to CLAUDE_PROJECT_DIR env var.
    const stdin = JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Comment fonctionne le système de plugins de cette plateforme ?',
      // no cwd field
      session_id: 'test',
    });
    const r = spawnSync(process.execPath, [HOOK_PATH], {
      input: stdin,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: vaultCwd },
      timeout: 10000,
    });
    assert.equal(r.status, 0, r.stderr);
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch {}
    assert.ok(parsed, `expected JSON output, got: ${r.stdout}`);
  });

  test('borderline-trivial prompt with question mark > 20 chars → injects', () => {
    // "Quels sont les vaults ?" is 24 chars but a real question
    const r = runHook({
      prompt: 'Quels sont les vaults configurés sur ma machine ?',
      cwd: vaultCwd,
    });
    assert.equal(r.status, 0);
    assert.ok(r.parsed);
  });
});
