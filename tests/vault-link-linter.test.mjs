/**
 * Tests for hooks/vault-link-linter.mjs.
 *
 * Strategy:
 *   - The hook reads JSON from stdin and exits 0 (pass) or 2 (block).
 *     We test it as a subprocess via `spawnSync`, feeding hand-crafted
 *     transcript JSONL fixtures + a temp router config via
 *     `OBSIDIAN_ROUTER_CONFIG`.
 *   - Fixture vault has one fake markdown file the linter can verify.
 *   - All non-success scenarios should exit 0 silently (no disruption).
 *   - Only verified vault-file mentions should trigger exit 2.
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
const HOOK_PATH = path.resolve(__dirname, '..', 'hooks', 'vault-link-linter.mjs');

let workDir, vaultPath, configPath, transcriptPath;

before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-linter-'));
  vaultPath = path.join(workDir, 'fake-vault');

  // Minimal vault: wiki/log.md + a REST API plugin data.json
  fs.mkdirSync(path.join(vaultPath, 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(vaultPath, 'wiki', 'log.md'), '# log');
  fs.mkdirSync(path.join(vaultPath, 'wiki', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(vaultPath, 'wiki', 'sub', 'page.md'), '# page');

  fs.mkdirSync(
    path.join(vaultPath, '.obsidian', 'plugins', 'obsidian-local-rest-api'),
    { recursive: true },
  );
  fs.writeFileSync(
    path.join(vaultPath, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'),
    JSON.stringify({ port: 27132, insecurePort: 27142, enableInsecureServer: true }),
  );

  configPath = path.join(workDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    portRegistry: { [vaultPath]: 27132 },
    portStart: 27132,
  }, null, 2));

  transcriptPath = path.join(workDir, 'transcript.jsonl');
});

after(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/**
 * Write a synthetic transcript with one assistant message containing
 * the given text, then run the hook with the appropriate stdin payload.
 */
function runLinter(assistantText, { stopHookActive = false, env = {} } = {}) {
  const entry = {
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: assistantText }],
    },
  };
  fs.writeFileSync(transcriptPath, JSON.stringify(entry) + '\n');

  const stdin = JSON.stringify({
    hook_event_name: 'Stop',
    transcript_path: transcriptPath,
    stop_hook_active: stopHookActive,
  });

  return spawnSync(process.execPath, [HOOK_PATH], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: configPath, ...env },
  });
}

// ---------------------------------------------------------------------------
// Pass cases — exit 0 silent
// ---------------------------------------------------------------------------

describe('vault-link-linter — pass cases', () => {
  test('exits 0 when assistant text has no links at all', () => {
    const r = runLinter('Hello world, nothing to lint here.');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr.trim(), '');
  });

  test('exits 0 when link uses http:// scheme (already correct format)', () => {
    const r = runLinter('See [log](http://127.0.0.1:27142/open/wiki%2Flog.md) for details.');
    assert.equal(r.status, 0, r.stderr);
  });

  test('exits 0 when link uses https:// scheme', () => {
    const r = runLinter('See [log](https://127.0.0.1:27132/open/wiki%2Flog.md).');
    assert.equal(r.status, 0, r.stderr);
  });

  test('exits 0 when link uses obsidian:// scheme', () => {
    const r = runLinter('See [log](obsidian://open?vault=Roland&file=wiki%2Flog).');
    assert.equal(r.status, 0, r.stderr);
  });

  test('exits 0 when bare path is inside a fenced code block', () => {
    const r = runLinter('```\n[log](wiki/log.md)\n```');
    assert.equal(r.status, 0, r.stderr);
  });

  test('exits 0 when bare path is inside inline code', () => {
    const r = runLinter('Use the path `[log](wiki/log.md)` for reference.');
    assert.equal(r.status, 0, r.stderr);
  });

  test('exits 0 when bare-path target does not exist in any vault', () => {
    // wiki/does-not-exist.md is a markdown link with a relative bare
    // path, but no configured vault contains this file → false positive
    // avoidance via filesystem check.
    const r = runLinter('See [missing](wiki/does-not-exist.md).');
    assert.equal(r.status, 0, r.stderr);
  });

  test('exits 0 when stop_hook_active=true (recursion guard)', () => {
    const r = runLinter('See [log](wiki/log.md) — would normally block.', {
      stopHookActive: true,
    });
    assert.equal(r.status, 0, r.stderr);
  });

  test('exits 0 when OBSIDIAN_ROUTER_NO_LINT_VAULT_LINKS=true', () => {
    const r = runLinter('See [log](wiki/log.md).', {
      env: { OBSIDIAN_ROUTER_NO_LINT_VAULT_LINKS: 'true' },
    });
    assert.equal(r.status, 0, r.stderr);
  });

  test('exits 0 when router config is missing (no portRegistry to verify against)', () => {
    const r = runLinter('See [log](wiki/log.md).', {
      env: { OBSIDIAN_ROUTER_CONFIG: path.join(workDir, 'nonexistent.json') },
    });
    assert.equal(r.status, 0, r.stderr);
  });

  test('exits 0 on absolute path link (skipped, never a vault-relative ref)', () => {
    const r = runLinter('See [system file](/etc/passwd.md).');
    assert.equal(r.status, 0, r.stderr);
  });

  test('exits 0 on Windows-absolute path link', () => {
    const r = runLinter('See [doc](C:\\Users\\me\\notes.md).');
    assert.equal(r.status, 0, r.stderr);
  });

  test('exits 0 on path-traversal href that would escape the vault root', () => {
    // Even though `path.join(vault, "../../../etc/hosts.md")` might
    // resolve to a real file on the system (e.g. /etc/hosts.md exists on
    // POSIX), the linter MUST refuse to claim it belongs to a vault.
    // Otherwise the stderr would surface system paths and Claude would
    // get a bogus suggestion to re-link them.
    const r = runLinter('See [bad](../../../etc/hosts.md).');
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}. stderr=${r.stderr}`);
  });

  test('exits 0 on 4-space-indented markdown code block containing a vault link', () => {
    // 4-space-indented code blocks are markdown's other code-block
    // syntax. The linter must strip those before scanning, otherwise
    // examples in docs/recipes will be flagged.
    const text = 'Here is an example:\n\n    [log](wiki/log.md)\n\nEnd of example.';
    const r = runLinter(text);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}. stderr=${r.stderr}`);
  });
});

// ---------------------------------------------------------------------------
// Block cases — exit 2 with stderr listing violations + suggestion
// ---------------------------------------------------------------------------

describe('vault-link-linter — block cases', () => {
  test('blocks on bare-path link to a real vault file', () => {
    const r = runLinter('Voir [log](wiki/log.md) pour le détail.');
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}. stderr=${r.stderr}`);
    assert.match(r.stderr, /Convention violation/);
    assert.match(r.stderr, /\[log\]\(wiki\/log\.md\)/);
    assert.match(r.stderr, /http:\/\/127\.0\.0\.1:27142\/open\/wiki%2Flog\.md/);
  });

  test('blocks on multiple bare-path links and lists them all', () => {
    const text = 'Files: [log](wiki/log.md) and [page](wiki/sub/page.md).';
    const r = runLinter(text);
    assert.equal(r.status, 2);
    // v0.12.8 reworded preamble: "2 violation(s)" + per-kind breakdown line
    // "2 vault link(s) missing the http://...". The exact count + EN
    // breakdown line proves both links were detected.
    assert.match(r.stderr, /2 violation\(s\)/);
    assert.match(r.stderr, /2 vault link\(s\) missing/);
    assert.match(r.stderr, /wiki%2Flog\.md/);
    assert.match(r.stderr, /wiki%2Fsub%2Fpage\.md/);
  });

  test('blocks on URL-percent-encoded href that resolves to a vault file', () => {
    // Claude might write `wiki/sub/page.md` or `wiki%2Fsub%2Fpage.md`.
    // The decoder should handle both forms.
    const r = runLinter('See [page](wiki%2Fsub%2Fpage.md).');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /wiki%2Fsub%2Fpage\.md/);
  });

  test('stderr includes the bilingual FR+EN preamble', () => {
    const r = runLinter('See [log](wiki/log.md).');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /FR —/);
    assert.match(r.stderr, /EN —/);
  });

  test('stderr includes the opt-out env var name', () => {
    const r = runLinter('See [log](wiki/log.md).');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /OBSIDIAN_ROUTER_NO_LINT_VAULT_LINKS=true/);
  });

  test('block respects code-block stripping (only flags non-code link)', () => {
    const text = 'In code: ```\n[log](wiki/log.md)\n```\nReal link: [page](wiki/sub/page.md).';
    const r = runLinter(text);
    assert.equal(r.status, 2);
    // Only the page link is flagged; the in-code log link must NOT appear in stderr
    assert.match(r.stderr, /wiki%2Fsub%2Fpage\.md/);
    assert.doesNotMatch(r.stderr, /Violations.*wiki\/log\.md/s);
  });

  test('REGRESSION (codex P2): filename with literal % does not crash the decoder', () => {
    // A real vault filename containing a `%` (e.g. "100% done.md") would
    // historically crash the second decodeURIComponent call with URIError
    // → exit 1 instead of the intended exit 2. The fix reuses the safe-
    // decoded value from findOwningVault. Test confirms the file resolves
    // AND the suggestion is generated without crashing.
    fs.writeFileSync(path.join(vaultPath, 'wiki', '100% done.md'), '# done');
    try {
      const r = runLinter('Voir [done](wiki/100% done.md).');
      // Either status 0 (the path doesn't resolve for some reason) or 2
      // (block, with suggestion). The forbidden outcome is status 1
      // (unhandled URIError exit).
      assert.notEqual(r.status, 1, `hook crashed with exit 1. stderr=${r.stderr}`);
    } finally {
      fs.rmSync(path.join(vaultPath, 'wiki', '100% done.md'), { force: true });
    }
  });

  test('REGRESSION (codex P2 pass 2): files in disabledVaults are ignored (no false block)', () => {
    // The file wiki/log.md exists in vaultPath, but if vaultPath is in
    // cfg.disabledVaults, the linter must NOT lint against it — the
    // router would refuse to serve the vault anyway.
    const disabledConfigPath = path.join(workDir, 'disabled-config.json');
    fs.writeFileSync(disabledConfigPath, JSON.stringify({
      disabledVaults: [vaultPath],  // disable by absolute path
      portRegistry: { [vaultPath]: 27132 },
      portStart: 27132,
    }, null, 2));

    try {
      const entry = {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'See [log](wiki/log.md).' }] },
      };
      fs.writeFileSync(transcriptPath, JSON.stringify(entry) + '\n');
      const r = spawnSync(
        process.execPath,
        [HOOK_PATH],
        {
          input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcriptPath }),
          encoding: 'utf8',
          env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: disabledConfigPath },
        },
      );
      assert.equal(r.status, 0, `expected exit 0 (vault disabled), got ${r.status}. stderr=${r.stderr}`);
    } finally {
      fs.rmSync(disabledConfigPath, { force: true });
    }
  });

  test('REGRESSION (codex P2 pass 2): OBSIDIAN_ROUTER_ALLOWED_VAULTS filters vault set', () => {
    // ALLOWED_VAULTS env restricts to a whitelist (slug-based). If
    // vaultPath's slug ('fake-vault') is NOT in the whitelist, the
    // linter must skip linting against it.
    const entry = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'See [log](wiki/log.md).' }] },
    };
    fs.writeFileSync(transcriptPath, JSON.stringify(entry) + '\n');
    const r = spawnSync(
      process.execPath,
      [HOOK_PATH],
      {
        input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcriptPath }),
        encoding: 'utf8',
        env: {
          ...process.env,
          OBSIDIAN_ROUTER_CONFIG: configPath,
          OBSIDIAN_ROUTER_ALLOWED_VAULTS: 'other-vault-not-this-one',
        },
      },
    );
    assert.equal(r.status, 0, `expected exit 0 (vault not in whitelist), got ${r.status}. stderr=${r.stderr}`);
  });

  test('REGRESSION (codex P2 pass 2): OBSIDIAN_ROUTER_DEFAULT_VAULT env wins over cfg.defaultVault', () => {
    // Two vaults both contain wiki/log.md. cfg.defaultVault points at
    // vault A (slug 'fake-vault', port 27142). Set env var to override
    // to vault B (slug 'other-vault', port 27143). The suggestion must
    // target B's port, not A's.
    const otherVault = path.join(workDir, 'other-vault');
    fs.mkdirSync(path.join(otherVault, 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(otherVault, 'wiki', 'log.md'), '# other log');
    fs.mkdirSync(
      path.join(otherVault, '.obsidian', 'plugins', 'obsidian-local-rest-api'),
      { recursive: true },
    );
    fs.writeFileSync(
      path.join(otherVault, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'),
      JSON.stringify({ port: 27133, insecurePort: 27143, enableInsecureServer: true }),
    );

    const multiConfigPath = path.join(workDir, 'multi-env-config.json');
    fs.writeFileSync(multiConfigPath, JSON.stringify({
      defaultVault: 'fake-vault',  // config points at vault A
      portRegistry: { [vaultPath]: 27132, [otherVault]: 27133 },
      portStart: 27132,
    }, null, 2));

    try {
      const entry = {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'See [log](wiki/log.md).' }] },
      };
      fs.writeFileSync(transcriptPath, JSON.stringify(entry) + '\n');
      const r = spawnSync(
        process.execPath,
        [HOOK_PATH],
        {
          input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcriptPath }),
          encoding: 'utf8',
          env: {
            ...process.env,
            OBSIDIAN_ROUTER_CONFIG: multiConfigPath,
            OBSIDIAN_ROUTER_DEFAULT_VAULT: 'other-vault',  // env override
          },
        },
      );
      assert.equal(r.status, 2);
      // Suggestion targets B (port 27143), not A (port 27142)
      assert.match(r.stderr, /127\.0\.0\.1:27143/);
      assert.doesNotMatch(r.stderr, /127\.0\.0\.1:27142/);
    } finally {
      fs.rmSync(otherVault, { recursive: true, force: true });
      fs.rmSync(multiConfigPath, { force: true });
    }
  });

  test('REGRESSION (codex P2 pass 3): loads workspace .env so VAULT_PATH set there wins', () => {
    // The hook runs as a separate subprocess and doesn't inherit the
    // workspace .env. It must read it itself, otherwise multi-vault
    // sessions with VAULT_PATH only in .env will bias to the wrong vault.
    const otherVault = path.join(workDir, 'other-vault-dotenv');
    fs.mkdirSync(path.join(otherVault, 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(otherVault, 'wiki', 'log.md'), '# other log');
    fs.mkdirSync(
      path.join(otherVault, '.obsidian', 'plugins', 'obsidian-local-rest-api'),
      { recursive: true },
    );
    fs.writeFileSync(
      path.join(otherVault, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'),
      JSON.stringify({ port: 27135, insecurePort: 27145, enableInsecureServer: true }),
    );

    const multiConfigPath = path.join(workDir, 'multi-dotenv-config.json');
    fs.writeFileSync(multiConfigPath, JSON.stringify({
      portRegistry: { [vaultPath]: 27132, [otherVault]: 27135 },
      portStart: 27132,
    }, null, 2));

    // Simulate a CLAUDE_PROJECT_DIR with a .env that sets VAULT_PATH
    // pointing at otherVault. Note: this scenario reflects what
    // `setup-vault.mjs` writes into each bootstrapped vault's .env.
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-dir-'));
    fs.writeFileSync(
      path.join(projectDir, '.env'),
      `VAULT_PATH=${otherVault}\nOBSIDIAN_API_KEY=ignored\n`,
    );

    try {
      const entry = {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'See [log](wiki/log.md).' }] },
      };
      fs.writeFileSync(transcriptPath, JSON.stringify(entry) + '\n');
      // Deliberately OMIT VAULT_PATH from env (delete vs empty string —
      // the loader's `key in process.env` check would otherwise see ''
      // as "already set" and skip filling from .env, defeating the test).
      const baseEnv = { ...process.env };
      delete baseEnv.VAULT_PATH;
      const r = spawnSync(
        process.execPath,
        [HOOK_PATH],
        {
          input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcriptPath }),
          encoding: 'utf8',
          env: {
            ...baseEnv,
            OBSIDIAN_ROUTER_CONFIG: multiConfigPath,
            CLAUDE_PROJECT_DIR: projectDir,
          },
        },
      );
      assert.equal(r.status, 2);
      assert.match(r.stderr, /127\.0\.0\.1:27145/);
      assert.doesNotMatch(r.stderr, /127\.0\.0\.1:27142/);
    } finally {
      fs.rmSync(otherVault, { recursive: true, force: true });
      fs.rmSync(multiConfigPath, { force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('REGRESSION (codex P2 pass 3): OBSIDIAN_ROUTER_LOCKED restricts lint scope to locked vault only', () => {
    // When the router is locked to vault A, the linter must not block
    // (or suggest URLs) for links pointing at files only in vault B —
    // those are outside the lock scope and the router would refuse them.
    const otherVault = path.join(workDir, 'other-vault-lock');
    fs.mkdirSync(path.join(otherVault, 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(otherVault, 'wiki', 'unique-other-file.md'), '# only here');
    fs.mkdirSync(
      path.join(otherVault, '.obsidian', 'plugins', 'obsidian-local-rest-api'),
      { recursive: true },
    );
    fs.writeFileSync(
      path.join(otherVault, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'),
      JSON.stringify({ port: 27136, insecurePort: 27146, enableInsecureServer: true }),
    );

    const multiConfigPath = path.join(workDir, 'lock-config.json');
    fs.writeFileSync(multiConfigPath, JSON.stringify({
      portRegistry: { [vaultPath]: 27132, [otherVault]: 27136 },
      portStart: 27132,
    }, null, 2));

    try {
      // Link points at a file that ONLY exists in the OTHER vault.
      const entry = {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'See [other](wiki/unique-other-file.md).' }] },
      };
      fs.writeFileSync(transcriptPath, JSON.stringify(entry) + '\n');
      const r = spawnSync(
        process.execPath,
        [HOOK_PATH],
        {
          input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcriptPath }),
          encoding: 'utf8',
          env: {
            ...process.env,
            OBSIDIAN_ROUTER_CONFIG: multiConfigPath,
            // Lock to the FIRST vault (which doesn't contain the file).
            OBSIDIAN_ROUTER_LOCKED: 'fake-vault',
          },
        },
      );
      // The file is in other-vault, but the lock excludes it from lint
      // scope → no violation surfaces.
      assert.equal(r.status, 0, `expected exit 0 (lock isolates), got ${r.status}. stderr=${r.stderr}`);
    } finally {
      fs.rmSync(otherVault, { recursive: true, force: true });
      fs.rmSync(multiConfigPath, { force: true });
    }
  });

  test('REGRESSION (codex P2 pass 2): VAULT_PATH env resolves default by path', () => {
    // Same setup as above but the override is via VAULT_PATH (absolute
    // path) instead of OBSIDIAN_ROUTER_DEFAULT_VAULT (slug).
    const otherVault = path.join(workDir, 'other-vault-vp');
    fs.mkdirSync(path.join(otherVault, 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(otherVault, 'wiki', 'log.md'), '# other log');
    fs.mkdirSync(
      path.join(otherVault, '.obsidian', 'plugins', 'obsidian-local-rest-api'),
      { recursive: true },
    );
    fs.writeFileSync(
      path.join(otherVault, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'),
      JSON.stringify({ port: 27134, insecurePort: 27144, enableInsecureServer: true }),
    );

    const multiConfigPath = path.join(workDir, 'multi-vp-config.json');
    fs.writeFileSync(multiConfigPath, JSON.stringify({
      portRegistry: { [vaultPath]: 27132, [otherVault]: 27134 },
      portStart: 27132,
    }, null, 2));

    try {
      const entry = {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'See [log](wiki/log.md).' }] },
      };
      fs.writeFileSync(transcriptPath, JSON.stringify(entry) + '\n');
      const r = spawnSync(
        process.execPath,
        [HOOK_PATH],
        {
          input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcriptPath }),
          encoding: 'utf8',
          env: {
            ...process.env,
            OBSIDIAN_ROUTER_CONFIG: multiConfigPath,
            VAULT_PATH: otherVault,  // path-based override (tier 2)
          },
        },
      );
      assert.equal(r.status, 2);
      assert.match(r.stderr, /127\.0\.0\.1:27144/);
      assert.doesNotMatch(r.stderr, /127\.0\.0\.1:27142/);
    } finally {
      fs.rmSync(otherVault, { recursive: true, force: true });
      fs.rmSync(multiConfigPath, { force: true });
    }
  });

  test('REGRESSION (codex P2): multi-vault collision prefers defaultVault when set', () => {
    // Create a second vault that ALSO contains wiki/log.md, plus set
    // defaultVault to the second vault. The linter should suggest a URL
    // pointing at the second vault's port (insecurePort 27143), not the
    // first vault's (27142).
    const otherVault = path.join(workDir, 'other-vault');
    fs.mkdirSync(path.join(otherVault, 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(otherVault, 'wiki', 'log.md'), '# other log');
    fs.mkdirSync(
      path.join(otherVault, '.obsidian', 'plugins', 'obsidian-local-rest-api'),
      { recursive: true },
    );
    fs.writeFileSync(
      path.join(otherVault, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'),
      JSON.stringify({ port: 27133, insecurePort: 27143, enableInsecureServer: true }),
    );

    const multiConfigPath = path.join(workDir, 'multi-config.json');
    fs.writeFileSync(multiConfigPath, JSON.stringify({
      defaultVault: 'other-vault',
      portRegistry: { [vaultPath]: 27132, [otherVault]: 27133 },
      portStart: 27132,
    }, null, 2));

    try {
      const entry = {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'See [log](wiki/log.md).' }] },
      };
      fs.writeFileSync(transcriptPath, JSON.stringify(entry) + '\n');
      const r = spawnSync(
        process.execPath,
        [HOOK_PATH],
        {
          input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcriptPath }),
          encoding: 'utf8',
          env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: multiConfigPath },
        },
      );
      assert.equal(r.status, 2);
      // Suggestion should target the DEFAULT vault's port (27143), not
      // the first-in-registry vault's (27142).
      assert.match(r.stderr, /127\.0\.0\.1:27143/);
      assert.doesNotMatch(r.stderr, /127\.0\.0\.1:27142/);
    } finally {
      fs.rmSync(otherVault, { recursive: true, force: true });
      fs.rmSync(multiConfigPath, { force: true });
    }
  });

  test('flags HTTPS-fallback when enableInsecureServer=false', () => {
    // Override the vault's data.json to disable HTTP
    const dataJsonPath = path.join(
      vaultPath, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json',
    );
    const original = fs.readFileSync(dataJsonPath, 'utf8');
    try {
      fs.writeFileSync(
        dataJsonPath,
        JSON.stringify({ port: 27132, insecurePort: 27142, enableInsecureServer: false }),
      );
      const r = runLinter('See [log](wiki/log.md).');
      assert.equal(r.status, 2);
      // Suggestion should be https:// with caveat comment
      assert.match(r.stderr, /https:\/\/127\.0\.0\.1:27132\/open/);
      assert.match(r.stderr, /HTTPS fallback/i);
    } finally {
      fs.writeFileSync(dataJsonPath, original);
    }
  });
});

// ---------------------------------------------------------------------------
// v0.12.8 — wrong-port detection (the original cause of this issue:
// Roland incident 2026-05-24 where Claude generated port 27143 instead of
// the actual 27142). Pre-v0.12.8 these slipped past the linter because the
// scheme-skip guard treated any `http://`-prefixed href as "already
// correct format". The extension verifies the port instead of assuming it.
// ---------------------------------------------------------------------------

describe('vault-link-linter — wrong-port detection (v0.12.8)', () => {
  test('blocks when http:// scheme has WRONG port (was 27143, expected 27142)', () => {
    const r = runLinter(
      'See [log](http://127.0.0.1:27143/open/wiki%2Flog.md) for details.',
    );
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}. stderr=${r.stderr}`);
    assert.match(r.stderr, /wrong-port/);
    assert.match(r.stderr, /used port 27143/);
    assert.match(r.stderr, /expected 27142/);
    // Suggestion uses the correct port.
    assert.match(r.stderr, /http:\/\/127\.0\.0\.1:27142\/open\/wiki%2Flog\.md/);
  });

  test('passes when http:// scheme has CORRECT port', () => {
    const r = runLinter(
      'See [log](http://127.0.0.1:27142/open/wiki%2Flog.md) for details.',
    );
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}. stderr=${r.stderr}`);
  });

  test('blocks when https:// scheme has WRONG port (used insecurePort instead of port)', () => {
    // Mixing up `port` (https, 27132) and `insecurePort` (http, 27142):
    // user wrote https:// but with the http port. Common mistake.
    const r = runLinter(
      'See [log](https://127.0.0.1:27142/open/wiki%2Flog.md).',
    );
    assert.equal(r.status, 2);
    assert.match(r.stderr, /wrong-port/);
    assert.match(r.stderr, /used port 27142/);
    assert.match(r.stderr, /expected 27132/);
  });

  test('passes when https:// scheme has CORRECT port', () => {
    const r = runLinter(
      'See [log](https://127.0.0.1:27132/open/wiki%2Flog.md).',
    );
    assert.equal(r.status, 0, r.stderr);
  });

  test('blocks when http:// is used but vault has enableInsecureServer=false', () => {
    // Even with the "right" insecurePort, http:// won't work if the
    // insecure server isn't listening. Flag and route through HTTPS fallback.
    const dataJsonPath = path.join(
      vaultPath, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json',
    );
    const original = fs.readFileSync(dataJsonPath, 'utf8');
    try {
      fs.writeFileSync(
        dataJsonPath,
        JSON.stringify({ port: 27132, insecurePort: 27142, enableInsecureServer: false }),
      );
      const r = runLinter(
        'See [log](http://127.0.0.1:27142/open/wiki%2Flog.md).',
      );
      assert.equal(r.status, 2);
      assert.match(r.stderr, /wrong-port/);
      // Suggestion is the HTTPS fallback (insecure server disabled).
      assert.match(r.stderr, /https:\/\/127\.0\.0\.1:27132\/open\/wiki%2Flog\.md/);
    } finally {
      fs.writeFileSync(dataJsonPath, original);
    }
  });

  test('mixed violations — bare-path + wrong-port — both listed in stderr', () => {
    const text =
      'Bare: [a](wiki/log.md) and wrong-port: [b](http://127.0.0.1:27143/open/wiki%2Fsub%2Fpage.md).';
    const r = runLinter(text);
    assert.equal(r.status, 2);
    // Preamble shows both kinds in the breakdown.
    assert.match(r.stderr, /1 vault link\(s\) missing/);
    assert.match(r.stderr, /1 click-to-open URL\(s\) with the wrong port/);
    // Both violations and their tags appear.
    assert.match(r.stderr, /\[bare-path\]/);
    assert.match(r.stderr, /\[wrong-port\]/);
    // Both suggestions reference the correct port.
    assert.match(r.stderr, /http:\/\/127\.0\.0\.1:27142\/open\/wiki%2Flog\.md/);
    assert.match(r.stderr, /http:\/\/127\.0\.0\.1:27142\/open\/wiki%2Fsub%2Fpage\.md/);
  });

  test('passes wrong-port URL whose path does NOT resolve to any vault (silent skip)', () => {
    // A click-to-open URL referencing a non-existent file shouldn't fail
    // the lint — that's a different kind of bug (hallucinated path) and
    // outside this hook's concern. Matches bare-path behavior.
    const r = runLinter(
      'See [missing](http://127.0.0.1:27143/open/wiki%2Fnonexistent.md).',
    );
    assert.equal(r.status, 0, r.stderr);
  });

  test('wrong-port stderr names the offending vault (basename)', () => {
    const r = runLinter(
      'See [log](http://127.0.0.1:27143/open/wiki%2Flog.md).',
    );
    assert.equal(r.status, 2);
    // The vault basename (fake-vault from the test fixture) appears in
    // the per-violation explainer line.
    assert.match(r.stderr, /vault fake-vault/);
  });
});

// ---------------------------------------------------------------------------
// v0.18.1 — cwd + vault-subpath "phantom path" trap.
// Roland incident 2026-05-29: Claude emitted
// `I:\DEVELOPPEMENT\obsidian-mcp-router\wiki\...\graph-viewer-survey.md` — the
// workspace cwd concatenated with a vault-internal subpath. The cwd (code
// repo) and the vault (Obsidian notes) live at DIFFERENT absolute roots, so
// the path is a phantom that doesn't exist on disk. Pre-v0.18.1 the linter
// skipped it (the drive-letter "scheme" guard + no bare-prose scan).
// ---------------------------------------------------------------------------

describe('vault-link-linter — cwd+vault-subpath trap (v0.18.1)', () => {
  // A synthetic, space-free, non-existent workspace root. Pass 3 only does
  // string ops + a phantom existsSync on it, so it need not exist on disk.
  // Space-free so the bare-prose scan (which stops at whitespace) works
  // regardless of the CI tmp path having spaces.
  const FAKE_WS = process.platform === 'win32' ? 'C:\\fake-code-ws' : '/fake-code-ws';
  const phantom = (rel) => path.join(FAKE_WS, rel);

  test('blocks a markdown-link href mixing cwd + vault subpath (phantom)', () => {
    const bad = phantom('wiki/log.md'); // <FAKE_WS>/wiki/log.md — does not exist
    const r = runLinter(`See [log](${bad}) for details.`, {
      env: { CLAUDE_PROJECT_DIR: FAKE_WS },
    });
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}. stderr=${r.stderr}`);
    assert.match(r.stderr, /cwd\+vault|phantom/i);
    // Correct click-to-open URL for the fixture vault (insecurePort 27142).
    assert.match(r.stderr, /http:\/\/127\.0\.0\.1:27142\/open\/wiki%2Flog\.md/);
  });

  test('blocks a BARE-PROSE phantom path (no markdown-link wrapper)', () => {
    const bad = phantom('wiki/sub/page.md');
    const r = runLinter(`I created the note at ${bad} just now.`, {
      env: { CLAUDE_PROJECT_DIR: FAKE_WS },
    });
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}. stderr=${r.stderr}`);
    assert.match(r.stderr, /http:\/\/127\.0\.0\.1:27142\/open\/wiki%2Fsub%2Fpage\.md/);
  });

  test('dedupes: a markdown link counts once, not twice (link + inner bare token)', () => {
    const bad = phantom('wiki/log.md');
    const r = runLinter(`See [log](${bad}).`, { env: { CLAUDE_PROJECT_DIR: FAKE_WS } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /1 violation\(s\)/);
  });

  test('exits 0 when the phantom tail does NOT resolve to any vault file', () => {
    // Under cwd + wiki segment, but the tail is not a real vault file →
    // hallucinated path, not this hook's concern (matches bare-path behavior).
    const bad = phantom('wiki/does-not-exist-xyz.md');
    const r = runLinter(`See [missing](${bad}).`, { env: { CLAUDE_PROJECT_DIR: FAKE_WS } });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}. stderr=${r.stderr}`);
  });

  test('exits 0 when the absolute path is under cwd but NOT a wiki/wiki-meta segment', () => {
    const bad = phantom('src/index.md'); // first segment 'src' → skip
    const r = runLinter(`See [src](${bad}).`, { env: { CLAUDE_PROJECT_DIR: FAKE_WS } });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}. stderr=${r.stderr}`);
  });

  test('exits 0 on an absolute link straight to the real vault file (not under cwd)', () => {
    // An absolute path under a DIFFERENT root than the cwd is not the trap.
    const r = runLinter(`See [log](${path.join(vaultPath, 'wiki', 'log.md')}).`, {
      env: { CLAUDE_PROJECT_DIR: FAKE_WS },
    });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}. stderr=${r.stderr}`);
  });

  test('exits 0 when a REAL local file under cwd/wiki exists (existsSync guard)', () => {
    // A real file under <cwd>/wiki with the SAME tail as a vault file must
    // be left alone — it's a genuine local file, not a phantom, even if a
    // same-named note also exists in the vault.
    const realWs = path.join(workDir, 'real-ws');
    fs.mkdirSync(path.join(realWs, 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(realWs, 'wiki', 'log.md'), '# local log');
    try {
      const r = runLinter(`See [log](${path.join(realWs, 'wiki', 'log.md')}).`, {
        env: { CLAUDE_PROJECT_DIR: realWs },
      });
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}. stderr=${r.stderr}`);
    } finally {
      fs.rmSync(realWs, { recursive: true, force: true });
    }
  });

  test('REGRESSION: the exact Roland 2026-05-29 path shape is caught', () => {
    // Mixed separators (backslash cwd + forward-slash subpath) exactly as
    // emitted in the incident. path.resolve normalizes; the tail must still
    // resolve to the fixture vault file.
    const r = runLinter(
      `Voir [page](${FAKE_WS}\\wiki/sub/page.md) pour le détail.`,
      { env: { CLAUDE_PROJECT_DIR: FAKE_WS } },
    );
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}. stderr=${r.stderr}`);
    assert.match(r.stderr, /http:\/\/127\.0\.0\.1:27142\/open\/wiki%2Fsub%2Fpage\.md/);
  });
});

// ---------------------------------------------------------------------------
// Robustness — malformed inputs should never crash the hook
// ---------------------------------------------------------------------------

describe('vault-link-linter — robustness', () => {
  test('exits 0 on empty stdin', () => {
    const r = spawnSync(process.execPath, [HOOK_PATH], {
      input: '',
      encoding: 'utf8',
      env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: configPath },
    });
    assert.equal(r.status, 0, r.stderr);
  });

  test('exits 0 on non-JSON stdin', () => {
    const r = spawnSync(process.execPath, [HOOK_PATH], {
      input: 'not-json',
      encoding: 'utf8',
      env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: configPath },
    });
    assert.equal(r.status, 0, r.stderr);
  });

  test('exits 0 when transcript_path is missing or unreadable', () => {
    const r = spawnSync(process.execPath, [HOOK_PATH], {
      input: JSON.stringify({ hook_event_name: 'Stop' }),
      encoding: 'utf8',
      env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: configPath },
    });
    assert.equal(r.status, 0, r.stderr);
  });

  test('exits 0 when transcript has no assistant messages', () => {
    fs.writeFileSync(transcriptPath, JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n');
    const r = spawnSync(process.execPath, [HOOK_PATH], {
      input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcriptPath }),
      encoding: 'utf8',
      env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: configPath },
    });
    assert.equal(r.status, 0, r.stderr);
  });
});
