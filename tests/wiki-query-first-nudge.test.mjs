/**
 * Tests for hooks/wiki-query-first-nudge.mjs (v0.11.5 UserPromptSubmit hook).
 *
 * Strategy: spawn the hook with synthetic stdin (UserPromptSubmit event)
 * + a temp cwd that may or may not look like a vault (presence of
 * `wiki-meta/index.md`, v0.12.0+). Verify stdout JSON contains the
 * additionalContext nudge for substantive vault-bound prompts, and
 * stdout is empty for filtered cases (non-vault, trivial, slash command,
 * opt-out).
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
let vaultCwd;        // contains wiki-meta/index.md → treated as vault
let nonVaultCwd;     // empty dir → treated as non-vault

before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wq-first-'));
  vaultCwd = fs.mkdtempSync(path.join(workDir, 'vault-'));
  fs.mkdirSync(path.join(vaultCwd, 'wiki-meta'), { recursive: true });
  fs.writeFileSync(path.join(vaultCwd, 'wiki-meta', 'index.md'), '# Index\n');
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
  test('non-vault cwd (no wiki-meta/index.md) → silent', () => {
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
    assert.match(ctx, /wiki-meta\/index\.md/);
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

  test('nudge mentions all 4 canonical entry points (hot/index/log/overview)', () => {
    const r = runHook({
      prompt: 'Comment fonctionne le système de plugins de cette plateforme ?',
      cwd: vaultCwd,
    });
    assert.equal(r.status, 0);
    const ctx = r.parsed?.hookSpecificOutput?.additionalContext || '';
    for (const entry of ['wiki-meta/hot.md', 'wiki-meta/index.md', 'wiki-meta/log.md', 'wiki-meta/overview.md']) {
      assert.match(ctx, new RegExp(entry.replace('.', '\\.')), `nudge should mention ${entry}`);
    }
  });

  test('nudge says cwd-is-vault for vault workspaces (mode label)', () => {
    const r = runHook({
      prompt: 'Comment fonctionne le système de plugins de cette plateforme ?',
      cwd: vaultCwd,
    });
    assert.equal(r.status, 0);
    const ctx = r.parsed?.hookSpecificOutput?.additionalContext || '';
    assert.match(ctx, /mode: cwd-is-vault/);
    assert.match(ctx, /workspace IS an Obsidian vault/);
  });
});

// ---------------------------------------------------------------------------
// v0.11.6 — workspace-bound mode (cwd is code project, .env links a vault)
// ---------------------------------------------------------------------------

describe('wiki-query-first-nudge — workspace-bound mode (v0.11.6)', () => {
  let codeWorkspace;
  let linkedVault;
  let configPath;

  before(() => {
    // Create a linked vault (separate from vaultCwd to avoid coupling
    // with the cwd-is-vault tests)
    linkedVault = fs.mkdtempSync(path.join(workDir, 'linked-vault-'));
    fs.mkdirSync(path.join(linkedVault, 'wiki-meta'), { recursive: true });
    fs.writeFileSync(path.join(linkedVault, 'wiki-meta', 'index.md'), '# Linked Index\n');

    // Create a code workspace (no wiki-meta/)
    codeWorkspace = fs.mkdtempSync(path.join(workDir, 'code-ws-'));

    // Router config registering the linked vault
    configPath = fs.mkdtempSync(path.join(workDir, 'cfg-')) + '/config.json';
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const slugFromPath = path.basename(linkedVault).replace(/^\./, '').toLowerCase();
    fs.writeFileSync(configPath, JSON.stringify({
      portRegistry: { [linkedVault]: 28100 },
    }));
    // Stash slug for tests below
    workspaceTestState = { codeWorkspace, linkedVault, slug: slugFromPath, configPath };
  });

  test('injects nudge when workspace .env links to a configured vault', () => {
    const { codeWorkspace, slug, configPath } = workspaceTestState;
    fs.writeFileSync(path.join(codeWorkspace, '.env'),
      `OBSIDIAN_ROUTER_DEFAULT_VAULT="${slug}"\n`);

    const r = runHook({
      prompt: 'Comment fonctionne le système de plugins de cette plateforme ?',
      cwd: codeWorkspace,
      env: { OBSIDIAN_ROUTER_CONFIG: configPath },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.parsed, `expected JSON output, got: ${r.stdout}`);
    const ctx = r.parsed.hookSpecificOutput?.additionalContext || '';
    assert.match(ctx, /mode: workspace-bound/);
    assert.match(ctx, new RegExp(slug.replace(/-/g, '\\-')));
  });

  test('workspace-bound nudge instructs MCP get_file with vault: slug', () => {
    const { codeWorkspace, slug, configPath } = workspaceTestState;
    fs.writeFileSync(path.join(codeWorkspace, '.env'),
      `OBSIDIAN_ROUTER_DEFAULT_VAULT="${slug}"\n`);

    const r = runHook({
      prompt: 'Comment fonctionne le système de plugins de cette plateforme ?',
      cwd: codeWorkspace,
      env: { OBSIDIAN_ROUTER_CONFIG: configPath },
    });
    assert.equal(r.status, 0);
    const ctx = r.parsed?.hookSpecificOutput?.additionalContext || '';
    assert.match(ctx, /mcp__obsidian-router__get_file/);
    assert.match(ctx, /vault:/);
  });

  test('silent when .env links to a slug not in portRegistry', () => {
    const { codeWorkspace, configPath } = workspaceTestState;
    fs.writeFileSync(path.join(codeWorkspace, '.env'),
      `OBSIDIAN_ROUTER_DEFAULT_VAULT="ghost-vault"\n`);

    const r = runHook({
      prompt: 'Comment fonctionne le système de plugins de cette plateforme ?',
      cwd: codeWorkspace,
      env: { OBSIDIAN_ROUTER_CONFIG: configPath },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '');
  });

  test('silent when cwd has no .env AND no env var set', () => {
    const { codeWorkspace, configPath } = workspaceTestState;
    // Make sure no .env exists
    const envFile = path.join(codeWorkspace, '.env');
    if (fs.existsSync(envFile)) fs.unlinkSync(envFile);

    const r = runHook({
      prompt: 'Comment fonctionne le système de plugins de cette plateforme ?',
      cwd: codeWorkspace,
      env: { OBSIDIAN_ROUTER_CONFIG: configPath, OBSIDIAN_ROUTER_DEFAULT_VAULT: '' },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '');
  });

  test('process.env wins over .env file (dotenv semantics)', () => {
    const { codeWorkspace, linkedVault, configPath } = workspaceTestState;
    // .env points at a non-existent vault; process.env points at the real one
    const realSlug = path.basename(linkedVault).replace(/^\./, '').toLowerCase();
    fs.writeFileSync(path.join(codeWorkspace, '.env'),
      `OBSIDIAN_ROUTER_DEFAULT_VAULT="ghost"\n`);

    const r = runHook({
      prompt: 'Comment fonctionne le système de plugins de cette plateforme ?',
      cwd: codeWorkspace,
      env: { OBSIDIAN_ROUTER_CONFIG: configPath, OBSIDIAN_ROUTER_DEFAULT_VAULT: realSlug },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.parsed, `expected nudge with process.env winning: ${r.stdout}`);
  });

  // v0.12.5 — PATH RESOLUTION RULES block (workspace-bound only)
  test('workspace-bound nudge includes PATH RESOLUTION RULES block with both absolute roots', () => {
    const { codeWorkspace, linkedVault, slug, configPath } = workspaceTestState;
    fs.writeFileSync(path.join(codeWorkspace, '.env'),
      `OBSIDIAN_ROUTER_DEFAULT_VAULT="${slug}"\n`);

    const r = runHook({
      prompt: 'Comment fonctionne le système de plugins de cette plateforme ?',
      cwd: codeWorkspace,
      env: { OBSIDIAN_ROUTER_CONFIG: configPath },
    });
    assert.equal(r.status, 0, r.stderr);
    const ctx = r.parsed?.hookSpecificOutput?.additionalContext || '';

    // Header present
    assert.match(ctx, /PATH RESOLUTION RULES \(workspace-bound — TWO ROOTS EXIST\)/);

    // Both absolute roots resolved dynamically and printed in the output
    // (use literal includes — these are real filesystem paths, not regex)
    assert.ok(ctx.includes(codeWorkspace),
      `expected nudge to mention cwd path ${codeWorkspace}, got:\n${ctx}`);
    assert.ok(ctx.includes(linkedVault),
      `expected nudge to mention vault path ${linkedVault}, got:\n${ctx}`);

    // WRONG / RIGHT exemplars present
    assert.match(ctx, /❌ WRONG/);
    assert.match(ctx, /✅ RIGHT/);

    // Preference order present (wikilink → click-to-open → filesystem)
    assert.match(ctx, /\[\[basename\]\]/);
    assert.match(ctx, /click-to-open/i);

    // Shared basename callout
    const sharedBasename = path.basename(linkedVault).replace(/^\./, '').toLowerCase();
    assert.ok(ctx.includes(sharedBasename),
      `expected shared basename "${sharedBasename}" in the nudge, got:\n${ctx}`);
  });

  test('cwd-is-vault nudge does NOT include PATH RESOLUTION RULES block (single root)', () => {
    // Re-use a temp vault (cwd-is-vault mode → only one root, no confusion)
    const isolatedVault = fs.mkdtempSync(path.join(workDir, 'iso-vault-'));
    fs.mkdirSync(path.join(isolatedVault, 'wiki-meta'), { recursive: true });
    fs.writeFileSync(path.join(isolatedVault, 'wiki-meta', 'index.md'), '# I\n');

    const r = runHook({
      prompt: 'Comment fonctionne le système de plugins de cette plateforme ?',
      cwd: isolatedVault,
    });
    assert.equal(r.status, 0, r.stderr);
    const ctx = r.parsed?.hookSpecificOutput?.additionalContext || '';

    assert.match(ctx, /mode: cwd-is-vault/);
    assert.doesNotMatch(ctx, /PATH RESOLUTION RULES/,
      `cwd-is-vault mode should NOT emit PATH RESOLUTION RULES (single root), got:\n${ctx}`);
  });
});

// Module-level state shared between before() and tests in the
// workspace-bound suite (Node test framework runs them in the same
// process so this is safe).
let workspaceTestState = null;

// ---------------------------------------------------------------------------
// v0.14.8 — CHAT RESPONSE LINK FORMAT block (applies in BOTH modes)
// ---------------------------------------------------------------------------

describe('wiki-query-first-nudge — v0.14.8 CHAT RESPONSE LINK FORMAT', () => {
  let cwdIsVaultWithBridge;
  let cwdIsVaultWithoutBridge;
  let cwdIsVaultBridgeDisabled;

  before(() => {
    // (1) cwd-is-vault with a real bridge data.json (insecurePort + enabled)
    cwdIsVaultWithBridge = fs.mkdtempSync(path.join(workDir, 'vault-bridge-'));
    fs.mkdirSync(path.join(cwdIsVaultWithBridge, 'wiki-meta'), { recursive: true });
    fs.writeFileSync(path.join(cwdIsVaultWithBridge, 'wiki-meta', 'index.md'), '# I\n');
    const pluginDir = path.join(
      cwdIsVaultWithBridge, '.obsidian', 'plugins', 'obsidian-local-rest-api',
    );
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'data.json'),
      JSON.stringify({ insecurePort: 27999, enableInsecureServer: true }),
    );

    // (2) cwd-is-vault without any plugin config → DEGRADED block
    cwdIsVaultWithoutBridge = fs.mkdtempSync(path.join(workDir, 'vault-nobridge-'));
    fs.mkdirSync(path.join(cwdIsVaultWithoutBridge, 'wiki-meta'), { recursive: true });
    fs.writeFileSync(path.join(cwdIsVaultWithoutBridge, 'wiki-meta', 'index.md'), '# I\n');

    // (3) cwd-is-vault with data.json but insecure server disabled → DEGRADED
    cwdIsVaultBridgeDisabled = fs.mkdtempSync(path.join(workDir, 'vault-disabled-'));
    fs.mkdirSync(path.join(cwdIsVaultBridgeDisabled, 'wiki-meta'), { recursive: true });
    fs.writeFileSync(path.join(cwdIsVaultBridgeDisabled, 'wiki-meta', 'index.md'), '# I\n');
    const dis = path.join(
      cwdIsVaultBridgeDisabled, '.obsidian', 'plugins', 'obsidian-local-rest-api',
    );
    fs.mkdirSync(dis, { recursive: true });
    fs.writeFileSync(
      path.join(dis, 'data.json'),
      JSON.stringify({ insecurePort: 27999, enableInsecureServer: false }),
    );
  });

  test('emits CHAT RESPONSE LINK FORMAT block when bridge is reachable', () => {
    const r = runHook({
      prompt: 'Explique-moi comment cette architecture fonctionne dans ce projet',
      cwd: cwdIsVaultWithBridge,
    });
    assert.equal(r.status, 0, r.stderr);
    const ctx = r.parsed?.hookSpecificOutput?.additionalContext || '';
    assert.match(ctx, /CHAT RESPONSE LINK FORMAT/);
    // Pre-computed URL prefix is injected literally
    assert.ok(ctx.includes('http://127.0.0.1:27999/open/'),
      `expected pre-computed URL prefix in nudge, got:\n${ctx}`);
    // WRONG/RIGHT chat examples present (multiline body, the "bare path"
    // explanation is on the line after the WRONG header)
    assert.match(ctx, /❌ WRONG/);
    assert.match(ctx, /bare path/);
    assert.match(ctx, /✅ RIGHT/);
    // Mentions the new build_open_link tool
    assert.match(ctx, /build_open_link/);
    // Mentions clickToOpenUrl field on tool results
    assert.match(ctx, /clickToOpenUrl/);
    // Mentions the user-frustration framing
    assert.match(ctx, /Roland.*10\+ times/);
  });

  test('emits DEGRADED block when data.json is missing', () => {
    const r = runHook({
      prompt: 'Explique-moi comment cette architecture fonctionne dans ce projet',
      cwd: cwdIsVaultWithoutBridge,
    });
    assert.equal(r.status, 0, r.stderr);
    const ctx = r.parsed?.hookSpecificOutput?.additionalContext || '';
    assert.match(ctx, /DEGRADED.*insecure HTTP server not reachable/);
    assert.match(ctx, /obsidian:\/\/open/);
    // No URL prefix injected
    assert.doesNotMatch(ctx, /http:\/\/127\.0\.0\.1:.*\/open\//);
  });

  test('emits DEGRADED block when enableInsecureServer is false', () => {
    const r = runHook({
      prompt: 'Explique-moi comment cette architecture fonctionne dans ce projet',
      cwd: cwdIsVaultBridgeDisabled,
    });
    assert.equal(r.status, 0, r.stderr);
    const ctx = r.parsed?.hookSpecificOutput?.additionalContext || '';
    assert.match(ctx, /DEGRADED/);
    assert.match(ctx, /enableInsecureServer/);
  });

  test('cwd-is-vault uses the "filesystem link, won\'t open in Obsidian" WRONG example', () => {
    const r = runHook({
      prompt: 'Explique-moi comment cette architecture fonctionne dans ce projet',
      cwd: cwdIsVaultWithBridge,
    });
    assert.equal(r.status, 0);
    const ctx = r.parsed?.hookSpecificOutput?.additionalContext || '';
    // cwd-is-vault: bare path renders as filesystem link → wrong app
    assert.match(ctx, /filesystem link, won't open in Obsidian/);
    // Should NOT use the workspace-bound "cwd+vault mix → 404" example
    assert.doesNotMatch(ctx, /cwd\+vault mix.*404/);
  });
});

// ---------------------------------------------------------------------------
// v0.14.9 (Reviewer A NIT-5): the hook's inlined readInsecurePort and the
// helper's buildClickToOpenUrl MUST agree on every reject condition. Drift
// silently degrades the click-to-open guarantee — the helper would emit
// URLs while the hook would say "DEGRADED, use obsidian://" (or vice
// versa). This suite locks the two implementations against each other.
// ---------------------------------------------------------------------------
describe('hook readInsecurePort agrees with helper buildClickToOpenUrl', () => {
  let crossImplVault;
  let crossImplDataJson;

  before(() => {
    crossImplVault = fs.mkdtempSync(path.join(workDir, 'xi-'));
    fs.mkdirSync(path.join(crossImplVault, 'wiki-meta'), { recursive: true });
    fs.writeFileSync(path.join(crossImplVault, 'wiki-meta', 'index.md'), '# I\n');
    const pluginDir = path.join(
      crossImplVault, '.obsidian', 'plugins', 'obsidian-local-rest-api',
    );
    fs.mkdirSync(pluginDir, { recursive: true });
    crossImplDataJson = path.join(pluginDir, 'data.json');
  });

  const cases = [
    { name: 'happy path', data: { insecurePort: 27999, enableInsecureServer: true }, hookEmits: true },
    { name: 'insecure server disabled', data: { insecurePort: 27999, enableInsecureServer: false }, hookEmits: false },
    { name: 'port as string', data: { insecurePort: '27999', enableInsecureServer: true }, hookEmits: false },
    { name: 'port out of range (>65535)', data: { insecurePort: 99999, enableInsecureServer: true }, hookEmits: false },
    { name: 'port 0', data: { insecurePort: 0, enableInsecureServer: true }, hookEmits: false },
    { name: 'enableInsecureServer missing', data: { insecurePort: 27999 }, hookEmits: false },
    { name: 'port missing', data: { enableInsecureServer: true }, hookEmits: false },
  ];

  for (const c of cases) {
    test(`hook and helper agree: ${c.name}`, async () => {
      fs.writeFileSync(crossImplDataJson, JSON.stringify(c.data));
      // Run hook
      const r = runHook({
        prompt: 'Explique-moi comment cette architecture fonctionne dans ce projet',
        cwd: crossImplVault,
      });
      assert.equal(r.status, 0, r.stderr);
      const ctx = r.parsed?.hookSpecificOutput?.additionalContext || '';
      const hookEmitsPrefix = ctx.includes('http://127.0.0.1:') && !ctx.includes('DEGRADED');

      // Run helper. We import dynamically + reset cache so each case
      // re-reads the same data.json the hook just saw.
      const { buildClickToOpenUrl, _resetCache } = await import('../src/helpers/click-to-open.mjs');
      _resetCache();
      const helperUrl = buildClickToOpenUrl(
        { type: 'local', path: crossImplVault, name: 'xi' },
        'wiki/foo.md',
      );
      const helperEmits = helperUrl !== null;

      assert.equal(
        hookEmitsPrefix,
        c.hookEmits,
        `hook emits URL prefix mismatch for "${c.name}"`,
      );
      assert.equal(
        helperEmits,
        c.hookEmits,
        `helper emits URL mismatch for "${c.name}" — drift with hook`,
      );
    });
  }
});
