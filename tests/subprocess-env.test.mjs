/**
 * v0.87.0 — every child process gets a NAMED environment, not the router's.
 *
 * THE DEFECT: not one execFile/spawn in the tree passed `env`, so every child
 * received the router's whole `process.env` — the workspace `.env` the CLI
 * loads at startup, the smart-link secret, whatever the MCP host set.
 * Confirmed by an adversarial Codex review (DonSeTch lot W-0, point P3).
 *
 * THREE KINDS OF TEST, in the order the house rules ask for them:
 *
 *   INSTRUMENT — a REAL executable (compiled from tests/fixtures/env-echo/
 *                EnvEcho.cs with the csc.exe every Windows .NET Framework
 *                ships; a shebang script on POSIX) that writes its environment,
 *                cwd and argv to a file beside itself. A CONTROL test spawns it
 *                WITHOUT the helper and requires the sentinel to ARRIVE — so a
 *                green pin below cannot be the instrument failing to look.
 *   PINS       — one per production entry point, driving it with sentinels set
 *                in this process and reading the dump the child wrote. Besides
 *                a plain sentinel and one named like a real secret, the parent
 *                carries the DANGEROUS names a prefix rule would have passed
 *                (`GIT_SSH_COMMAND`, `GIT_CONFIG_VALUE_0`, `npm_config__authToken`,
 *                `SSH_ASKPASS`, `NODE_OPTIONS`) — none may arrive.
 *   GUARD      — every spawn under src/, scripts/, hooks/ and bin/ either
 *                passes `subprocessOptions(...)` AS ITS OPTIONS ARGUMENT (the
 *                last one — not anywhere in the argument list), or is listed in
 *                EXEMPT by file, by exact count AND by the command it runs,
 *                with a reason. The totals are pinned exactly, so a finder that
 *                loses a site is as red as a site that loses its guard.
 *
 * Why a compiled binary on Windows: `execFile` without a shell can only start
 * a PE image there, and every tool is launched with a fixed argv whose first
 * token is a long option (`--to md …`, `--skip-download …`) — no interpreter on
 * the machine will run a script under those arguments. Without csc.exe the
 * pins SKIP on a developer machine, loudly — and FAIL under CI, because the
 * Windows leg is where the defect lived and a skipped proof there is no proof.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  SUBPROCESS_TOOLS, NEVER_PASS, isNeverPassed, allowlistFor, buildSubprocessEnv, subprocessOptions,
  absolutizeExecutableOverride, withIsolatedCwd,
} from '../src/helpers/subprocess-env.mjs';
import { toMarkdown, fromRepo } from '../src/markdownify/markitdown.mjs';
import { toMarkdownDocling } from '../src/markdownify/docling.mjs';
import { pdfToImages } from '../src/markdownify/pdf-images.mjs';
import { fetchYoutubeTranscriptViaYtdlp } from '../src/markdownify/youtube-fallback.mjs';
import { findPythonDetailed } from '../src/helpers/conversion-readiness.mjs';
import { runInstall } from '../src/helpers/ensure-deps.mjs';
import { _internals as autoUpdate } from '../src/helpers/plugin-auto-update.mjs';
import { findLiveSnapshotVersions } from '../src/helpers/plugin-cache-purge.mjs';
import { runSetupVault } from '../src/helpers/vault-wizard-engine.mjs';
import { blankStringsAndComments } from './_source-scan.mjs';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const IS_WIN = process.platform === 'win32';
const IN_CI = Boolean(process.env.CI || process.env.GITHUB_ACTIONS);

/** Set in THIS process before every pin; must never be seen by a child. */
const SENTINEL = 'OBSIDIAN_ROUTER_TEST_SENTINEL';
/**
 * A second sentinel wearing the name of a REAL secret the router reads. A
 * future `OBSIDIAN_ROUTER_*` prefix rule would pass it — this catches that.
 */
const SECRET_SENTINEL = 'OBSIDIAN_ROUTER_SMART_LINK_SECRET';
/**
 * Names a `GIT_*` / `npm_config_*` / `SSH_*` prefix rule would have carried,
 * each of them a command, a config injection or a credential — and
 * `NODE_OPTIONS`, which a workspace `.env` can set and a Node child obeys.
 * The value of `NODE_OPTIONS` is harmless on purpose: the CONTROL child (a
 * Node script on POSIX) inherits it.
 */
const DANGEROUS = Object.freeze({
  GIT_SSH_COMMAND: 'leak-command',
  GIT_CONFIG_VALUE_0: 'leak-config',
  npm_config__authToken: 'leak-npm-token',
  SSH_ASKPASS: 'leak-askpass',
  NODE_OPTIONS: '--no-warnings',
});

// ---------------------------------------------------------------------------
// The instrument
// ---------------------------------------------------------------------------

let workRoot;
let fakeExe = null;      // win32: the compiled env-echo.exe
let fakeReason = null;   // why no fake could be built (reported on skip)
let savedEnv = {};

const POSIX_FAKE = [
  `#!${process.execPath}`,
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  'const args = process.argv.slice(2);',
  "fs.writeFileSync(path.join(__dirname, 'env-dump.json'), JSON.stringify({ cwd: process.cwd(), argv: args, env: process.env }));",
  'for (let i = 0; i < args.length - 1; i++) {',
  "  if (args[i] === '--output') { fs.mkdirSync(args[i + 1], { recursive: true }); fs.writeFileSync(path.join(args[i + 1], 'out.md'), '# env-echo\\n'); }",
  "  if (args[i] === '--out') { fs.mkdirSync(args[i + 1], { recursive: true }); fs.writeFileSync(path.join(args[i + 1], 'page-0001.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47])); }",
  "  if (args[i] === '-o') { const d = path.dirname(args[i + 1]); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'sub.en.vtt'), 'WEBVTT\\n\\n00:00:00.000 --> 00:00:01.000\\nenv-echo\\n'); }",
  '}',
  "process.stdout.write(args.includes('--version') ? 'Python 3.99.0\\n' : 'env-echo ok\\n');",
  '',
].join('\n');

/** A stand-in for scripts/setup-vault.mjs that prints what it received. */
const ENGINE_FAKE = 'process.stdout.write(JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2), env: process.env }));\n';

function cscPath() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  return ['Framework64', 'Framework']
    .map((f) => path.join(root, 'Microsoft.NET', f, 'v4.0.30319', 'csc.exe'))
    .find((p) => fs.existsSync(p)) || null;
}

before(() => {
  workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'subprocess-env-'));
  for (const k of [SENTINEL, SECRET_SENTINEL, ...Object.keys(DANGEROUS), 'MD_ALLOWED_PATHS', 'MD_SHARE_DIR']) savedEnv[k] = process.env[k];
  process.env[SENTINEL] = 'leak';
  process.env[SECRET_SENTINEL] = 'leak-secret';
  for (const [k, v] of Object.entries(DANGEROUS)) process.env[k] = v;
  // What a Claude Desktop host sets when it runs this server inside Electron:
  // a Node child started from `process.execPath` MUST receive it, or it
  // launches the application instead of the script. A real Node ignores it.
  savedEnv.ELECTRON_RUN_AS_NODE = process.env.ELECTRON_RUN_AS_NODE;
  process.env.ELECTRON_RUN_AS_NODE = '1';
  // A developer's sandbox setting would make the pins refuse their own
  // temp-dir inputs; the pins are about the environment, not the sandbox.
  delete process.env.MD_ALLOWED_PATHS;
  delete process.env.MD_SHARE_DIR;

  if (!IS_WIN) return;
  const csc = cscPath();
  if (!csc) {
    fakeReason = 'csc.exe (.NET Framework 4.x) was not found under SystemRoot — no real fake executable can be built here';
    return;
  }
  const exe = path.join(workRoot, 'env-echo.exe');
  try {
    execFileSync(csc, ['/nologo', '/optimize-', '/target:exe', `/out:${exe}`, path.join(HERE, 'fixtures', 'env-echo', 'EnvEcho.cs')], { stdio: 'pipe' });
    fakeExe = exe;
  } catch (e) {
    fakeReason = `csc.exe failed to compile the fixture: ${String(e.stdout || e.stderr || e.message).slice(0, 400)}`;
  }
});

after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { fs.rmSync(workRoot, { recursive: true, force: true, maxRetries: 3 }); } catch { /* a just-run exe may linger */ }
});

/**
 * True when a real fake can run. On a developer's Windows machine without
 * csc.exe the test skips and says why; under CI it FAILS — the Windows leg is
 * where the defect lived, and a proof that skips there is not a proof.
 */
function fakeAvailable(t) {
  if (IS_WIN && !fakeExe) {
    if (IN_CI) assert.fail(`the Windows instrument could not be built under CI — ${fakeReason}`);
    t.skip(`SKIPPED — ${fakeReason}`);
    return false;
  }
  return true;
}

/** Put a copy of the fake at `<dir>/<name>[.exe]`; its dump lands in `dir`. */
function installFake(dir, name) {
  if (IS_WIN) {
    const target = path.join(dir, `${name}.exe`);
    fs.copyFileSync(fakeExe, target);
    return target;
  }
  const target = path.join(dir, name);
  fs.writeFileSync(target, POSIX_FAKE, { mode: 0o755 });
  return target;
}

function readDump(dir) {
  const p = path.join(dir, 'env-dump.json');
  assert.ok(fs.existsSync(p), `the fake never ran: no env-dump.json in ${dir}`);
  const dump = JSON.parse(fs.readFileSync(p, 'utf8'));
  const fold = (k) => (IS_WIN ? String(k).toUpperCase() : String(k));
  const keys = new Map(Object.keys(dump.env).map((k) => [fold(k), k]));
  dump.has = (name) => keys.has(fold(name));
  dump.get = (name) => dump.env[keys.get(fold(name))];
  return dump;
}

function assertScrubbed(dump, label) {
  assert.equal(dump.has(SENTINEL), false, `${label}: ${SENTINEL} reached the child — its environment was inherited from the router`);
  assert.equal(dump.has(SECRET_SENTINEL), false, `${label}: ${SECRET_SENTINEL} reached the child`);
  for (const name of Object.keys(DANGEROUS)) {
    assert.equal(dump.has(name), false, `${label}: ${name} reached the child — a prefix rule, or a hole in the NEVER list`);
  }
  assert.ok(dump.has('PATH'), `${label}: PATH must reach the child (it is how the executable and its helpers are found)`);
}

const foldPath = (p) => (IS_WIN ? path.resolve(p).toLowerCase() : path.resolve(p));
const samePath = (a, b) => foldPath(a) === foldPath(b);
const isUnderTmp = (p) => foldPath(p).startsWith(foldPath(os.tmpdir()));

async function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(overrides)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const withPathFirst = (dir, fn) => withEnv({ PATH: `${dir}${path.delimiter}${process.env.PATH}` }, fn);

function freshDir(name) {
  return fs.mkdtempSync(path.join(workRoot, `${name}-`));
}

// ---------------------------------------------------------------------------
// UNIT — the allowlist itself
// ---------------------------------------------------------------------------

describe('buildSubprocessEnv — the allowlist, not the parent', () => {
  const SOURCE = {
    PATH: '/usr/bin', HOME: '/home/u', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\u',
    [SENTINEL]: 'leak', [SECRET_SENTINEL]: 'leak-secret', OPENAI_API_KEY: 'sk-leak', GITHUB_TOKEN: 'ghp-leak',
    ...DANGEROUS,
  };

  test('a sentinel in the source is dropped; the platform base survives', () => {
    const win = buildSubprocessEnv('markitdown', { source: SOURCE, platform: 'win32' });
    assert.equal(win[SENTINEL], undefined);
    assert.equal(win[SECRET_SENTINEL], undefined);
    assert.equal(win.OPENAI_API_KEY, undefined);
    assert.equal(win.PATH, '/usr/bin');
    assert.equal(win.SystemRoot, 'C:\\Windows');
    assert.equal(win.USERPROFILE, 'C:\\Users\\u');

    const posix = buildSubprocessEnv('markitdown', { source: SOURCE, platform: 'linux' });
    assert.equal(posix[SENTINEL], undefined);
    assert.equal(posix.PATH, '/usr/bin');
    assert.equal(posix.HOME, '/home/u');
    // Windows-only names do not leak into a POSIX child's block.
    assert.equal(posix.SystemRoot, undefined);
  });

  test('Windows names match case-insensitively and keep the SOURCE spelling', () => {
    const out = buildSubprocessEnv('taskkill', { source: { Path: 'p', SYSTEMROOT: 's', systemdrive: 'C:' }, platform: 'win32' });
    assert.deepEqual(out, { Path: 'p', SYSTEMROOT: 's', systemdrive: 'C:' });
  });

  test('POSIX names are case-sensitive', () => {
    const out = buildSubprocessEnv('taskkill', { source: { path: 'p', PATH: 'P' }, platform: 'linux' });
    assert.deepEqual(out, { PATH: 'P' });
  });

  test('an unknown tool throws — a new spawn site must declare what it runs', () => {
    assert.throws(() => buildSubprocessEnv('curl', { source: {} }), /unknown tool "curl"/);
    assert.throws(() => subprocessOptions('curl', {}), /unknown tool "curl"/);
  });

  test('no allowlist carries a prefix any more: every accepted name is written out', () => {
    for (const tool of Object.keys(SUBPROCESS_TOOLS)) {
      for (const platform of ['win32', 'linux']) {
        const list = allowlistFor(tool, platform);
        assert.equal('prefixes' in list, false, `${tool}/${platform}: the allowlist API has no prefix channel`);
        assert.ok(list.names.every((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n)), `${tool}/${platform}: names only`);
      }
    }
    // The names a GIT_* / npm_config_* / SSH_* prefix would have carried, and
    // NODE_OPTIONS, reach no tool from the source…
    for (const tool of Object.keys(SUBPROCESS_TOOLS)) {
      for (const platform of ['win32', 'linux']) {
        const out = buildSubprocessEnv(tool, { source: { PATH: 'p', ...DANGEROUS, GIT_DIR: '/elsewhere', npm_config_registry: 'https://evil.example' }, platform });
        for (const name of [...Object.keys(DANGEROUS), 'GIT_DIR', 'npm_config_registry']) {
          assert.equal(name in out, false, `${tool}/${platform}: ${name} passed`);
        }
      }
    }
    // …while the identity git needs still does.
    const git = buildSubprocessEnv('git', { source: { PATH: 'p', GIT_AUTHOR_NAME: 'R', GIT_COMMITTER_EMAIL: 'r@x', SSH_AUTH_SOCK: '/s', HTTPS_PROXY: 'http://proxy:3128' }, platform: 'linux' });
    assert.equal(git.GIT_AUTHOR_NAME, 'R');
    assert.equal(git.GIT_COMMITTER_EMAIL, 'r@x');
    assert.equal(git.SSH_AUTH_SOCK, '/s');
    assert.equal(git.HTTPS_PROXY, 'http://proxy:3128', 'git talks to a remote in plugin-auto-update: the proxy must reach it');
  });

  test('the NEVER list refuses commands, injections, hijacks and credentials by name and by shape', () => {
    for (const n of ['NODE_OPTIONS', 'node_options', 'LD_PRELOAD', 'PYTHONPATH', 'GIT_SSH_COMMAND', 'GIT_DIR', 'SSH_ASKPASS',
      'GIT_CONFIG_VALUE_3', 'GIT_CONFIG_KEY_0', 'npm_config__authToken', 'npm_config_//registry.npmjs.org/:_authToken',
      'npm_config_registry', 'HF_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'MY_PASSWORD', 'X_COOKIE', 'FOO_API_KEY', 'FOO_APIKEY',
      'SOME_PRIVATE_KEY', 'DOCKER_AUTH', 'MY_TOOL_COMMAND', 'GIT_EXTERNAL_DIFF',
      // the shapes the two reviewers named: what a GIT_* / SSH_* / DOCLING_* prefix would have carried
      'GIT_PASSWORD', 'SSH_PRIVATE_KEY', 'DOCLING_SERVE_API_KEY', 'npm_config__auth',
      // credential shapes on word boundaries
      'AWS_SESSION_TOKEN', 'GH_TOKEN', 'TOKEN', 'ACCESS_TOKEN', 'SECRETS_DIR', 'MY_COOKIES', 'FOO_API_KEYS']) {
      assert.equal(isNeverPassed(n), true, `${n} must be refused`);
    }
    for (const n of ['PATH', 'HOME', 'GIT_AUTHOR_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_CONFIG_GLOBAL', 'SSH_AUTH_SOCK', 'HTTPS_PROXY',
      'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'ELECTRON_RUN_AS_NODE', 'npm_config_cache', 'HF_HOME', 'DOCLING_ARTIFACTS_PATH',
      'PYTHONIOENCODING', 'OBSIDIAN_ROUTER_CONFIG', 'OBSIDIAN_ROUTER_PROVISION_NONCE', 'LOGNAME', 'USERNAME',
      'PROCESSOR_ARCHITECTURE', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'WAYLAND_DISPLAY',
      // a real Hugging Face knob Docling's stack reads — `TOKEN` is not a substring rule
      'TOKENIZERS_PARALLELISM']) {
      assert.equal(isNeverPassed(n), false, `${n} must be allowed to be named`);
    }
    // …and none of the reviewers' shapes passes any tool from the source, whatever the tables say
    // (the fixed PYTHONIOENCODING of the Python tools is the only other key allowed to appear).
    for (const tool of Object.keys(SUBPROCESS_TOOLS)) {
      const out = buildSubprocessEnv(tool, { source: { PATH: 'p', GIT_PASSWORD: 'x', SSH_PRIVATE_KEY: 'x', DOCLING_SERVE_API_KEY: 'x', npm_config__authToken: 'x' }, platform: 'linux' });
      const { fixed } = allowlistFor(tool, 'linux');
      assert.deepEqual(Object.keys(out).filter((k) => !(k in fixed)), ['PATH'], tool);
    }
    assert.ok(NEVER_PASS.names.length > 30 && NEVER_PASS.patterns.length >= 3);
  });

  test('PYTHONIOENCODING is fixed to utf-8 for the five Python tools, and neither the source nor extraEnv overrides it', () => {
    // Measured on Windows: a piped Python stdout uses the ANSI code page unless
    // told otherwise, and the router decodes UTF-8 — `Élève` arrived as `�l�ve`.
    for (const tool of ['markitdown', 'python-probe', 'pdf-images', 'docling', 'yt-dlp']) {
      const out = buildSubprocessEnv(tool, { source: { PATH: 'p', PYTHONIOENCODING: 'cp1252' }, platform: 'win32' });
      assert.equal(out.PYTHONIOENCODING, 'utf-8', tool);
      assert.throws(
        () => buildSubprocessEnv(tool, { source: { PATH: 'p' }, platform: 'win32', extra: { PYTHONIOENCODING: 'cp1252' } }),
        /cannot override the fixed "PYTHONIOENCODING"/,
        `${tool}: extraEnv must not override a fixed value`,
      );
      assert.throws(
        () => buildSubprocessEnv(tool, { source: { PATH: 'p' }, platform: 'win32', extra: { pythonioencoding: 'cp1252' } }),
        /cannot override the fixed/,
        `${tool}: a differently-cased spelling is the same variable on Windows`,
      );
    }
    // …and only for them: repomix and git are not Python.
    for (const tool of ['repomix', 'git', 'npm', 'setup-vault', 'process-scan', 'taskkill']) {
      const out = buildSubprocessEnv(tool, { source: { PATH: 'p', PYTHONIOENCODING: 'cp1252' }, platform: 'win32' });
      assert.equal(out.PYTHONIOENCODING, undefined, tool);
    }
  });

  test('extraEnv accepts only names the tool already lists, never the parent environment, and subprocessOptions never emits an `extraEnv` key', () => {
    const opts = subprocessOptions('setup-vault', { cwd: '/x', encoding: 'utf8', extraEnv: { OBSIDIAN_ROUTER_PROVISION_NONCE: 'n1' } });
    assert.equal(opts.cwd, '/x');
    assert.equal(opts.encoding, 'utf8');
    assert.equal('extraEnv' in opts, false);
    assert.equal(opts.env.OBSIDIAN_ROUTER_PROVISION_NONCE, 'n1');
    assert.equal(opts.env[SENTINEL], undefined);
    // A name the tool does not list is refused — even a harmless-looking one.
    assert.throws(() => subprocessOptions('git', { extraEnv: { GIT_AUTHOR_NAME: 'ok', FOO_BAR: '1' } }), /"FOO_BAR" is not in the "git" allowlist/);
    // The side door is shut: the parent environment cannot be laundered back in.
    assert.throws(() => subprocessOptions('git', { extraEnv: { ...process.env } }), /is not in the "git" allowlist|NEVER list/);
    // A NEVER-listed name is refused with its own reason, before the allowlist check.
    assert.throws(() => subprocessOptions('git', { extraEnv: { GIT_SSH_COMMAND: 'x' } }), /is on the NEVER list/);
    assert.throws(() => subprocessOptions('repomix', { extraEnv: { NODE_OPTIONS: '--require=x' } }), /is on the NEVER list/);
  });

  test('subprocessOptions REFUSES an `env` option — the environment is never supplied whole', () => {
    assert.throws(() => subprocessOptions('git', { env: { ...process.env } }), /refusing an `env` option/);
  });

  test('an extraEnv KEY is judged before its value: a null under a forbidden or unlisted name still throws', () => {
    assert.throws(() => subprocessOptions('git', { extraEnv: { GIT_SSH_COMMAND: undefined } }), /is on the NEVER list/);
    assert.throws(() => subprocessOptions('git', { extraEnv: { FOO_BAR: null } }), /is not in the "git" allowlist/);
    assert.throws(() => subprocessOptions('markitdown', { extraEnv: { PYTHONIOENCODING: null } }), /cannot override the fixed/);
    // …and a null under a LISTED name is simply "not set".
    const opts = subprocessOptions('setup-vault', { extraEnv: { OBSIDIAN_ROUTER_PROVISION_NONCE: null } });
    assert.equal('OBSIDIAN_ROUTER_PROVISION_NONCE' in opts.env, false);
  });

  test('PYTHONWARNINGS and PSModulePath are NEVER passed — a warnings filter names a module Python imports, and PSModulePath is where PowerShell auto-loads modules from', () => {
    assert.equal(isNeverPassed('PYTHONWARNINGS'), true);
    assert.equal(isNeverPassed('PSModulePath'), true);
    assert.equal(isNeverPassed('psmodulepath'), true, 'case-insensitive, like every Windows name');
    const py = buildSubprocessEnv('markitdown', { source: { PATH: 'p', PYTHONWARNINGS: 'default::this.X', PYTHONUTF8: '1' }, platform: 'linux' });
    assert.equal(py.PYTHONWARNINGS, undefined);
    assert.equal(py.PYTHONUTF8, '1');
    const scan = buildSubprocessEnv('process-scan', { source: { PATH: 'p', SystemRoot: 'C:\\Windows', PSModulePath: 'C:\\evil\\modules' }, platform: 'win32' });
    assert.equal(scan.PSModulePath, undefined, 'the CIM scan was measured to work without it');
    assert.equal(scan.SystemRoot, 'C:\\Windows');
    assert.throws(() => buildSubprocessEnv('markitdown', { source: { PATH: 'p' }, platform: 'linux', extra: { PYTHONWARNINGS: 'ignore' } }), /NEVER list/);
  });

  test('a path-LIST variable (SSL_CERT_DIR) has each relative entry made absolute on its own — the child platform\'s delimiter and empty entries preserved', () => {
    const win = buildSubprocessEnv('docling', { source: { PATH: 'p', SSL_CERT_DIR: 'ca-one;ca-two;;C:\\certs' }, platform: 'win32' });
    assert.equal(win.SSL_CERT_DIR, `${path.resolve('ca-one')};${path.resolve('ca-two')};;C:\\certs`);
    const posix = buildSubprocessEnv('docling', { source: { PATH: 'p', SSL_CERT_DIR: 'ca-one:/etc/ssl/certs' }, platform: 'linux' });
    assert.equal(posix.SSL_CERT_DIR, `${path.resolve('ca-one')}:/etc/ssl/certs`);
    // a single absolute entry, and an empty value, pass byte-for-byte
    assert.equal(buildSubprocessEnv('docling', { source: { PATH: 'p', SSL_CERT_DIR: '/etc/ssl/certs' }, platform: 'linux' }).SSL_CERT_DIR, '/etc/ssl/certs');
    assert.equal(buildSubprocessEnv('docling', { source: { PATH: 'p', SSL_CERT_DIR: '' }, platform: 'linux' }).SSL_CERT_DIR, '');
    // the list-valued names are allowlisted names and are not ALSO single-path names, on every tool
    for (const tool of Object.keys(SUBPROCESS_TOOLS)) {
      const { names, paths, pathLists } = allowlistFor(tool, 'linux');
      for (const p of pathLists) {
        assert.ok(names.includes(p), `${tool}: list-valued "${p}" must be an allowlisted name`);
        assert.ok(!paths.includes(p), `${tool}: "${p}" cannot be both a single path and a list`);
      }
    }
    assert.ok(allowlistFor('docling', 'linux').pathLists.includes('SSL_CERT_DIR'));
  });

  test('a path-valued variable with a RELATIVE value is made absolute against the router cwd; absolute, empty and non-path values pass byte-for-byte', () => {
    const source = {
      PATH: 'p',
      DOCLING_ARTIFACTS_PATH: './artifacts',
      SSL_CERT_FILE: 'ca.pem',
      HF_HOME: IS_WIN ? 'C:\\hf' : '/opt/hf',
      HF_ENDPOINT: 'https://mirror.example',
      GIT_CONFIG_GLOBAL: '',
      NODE_EXTRA_CA_CERTS: ' certs/extra.pem ',
    };
    const docling = buildSubprocessEnv('docling', { source, platform: process.platform });
    assert.equal(docling.DOCLING_ARTIFACTS_PATH, path.resolve('./artifacts'), 'Docling reads ./artifacts relative to the ROUTER cwd, not the throwaway one');
    assert.equal(docling.SSL_CERT_FILE, path.resolve('ca.pem'));
    assert.equal(docling.HF_HOME, source.HF_HOME, 'an absolute value is untouched');
    assert.equal(docling.HF_ENDPOINT, 'https://mirror.example', 'a URL is not a path');
    const git = buildSubprocessEnv('repomix', { source, platform: process.platform });
    assert.equal(git.GIT_CONFIG_GLOBAL, '', 'an empty value is untouched');
    assert.equal(git.NODE_EXTRA_CA_CERTS, path.resolve('certs/extra.pem'), 'a padded relative value is trimmed and resolved');
    // The path-valued names are a subset of the names, on every tool.
    for (const tool of Object.keys(SUBPROCESS_TOOLS)) {
      const { names, paths } = allowlistFor(tool, 'linux');
      for (const p of paths) assert.ok(names.includes(p), `${tool}: path-valued "${p}" must be an allowlisted name`);
    }
  });

  test('no allowlist name looks like a secret, no allowlist name is on the NEVER list, and the usual secrets never pass', () => {
    const SECRETS = {
      [SECRET_SENTINEL]: 'x', OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN: 'x',
      OPENAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'x', AWS_SECRET_ACCESS_KEY: 'x', GITHUB_TOKEN: 'x', GH_TOKEN: 'x',
      NPM_TOKEN: 'x', HF_TOKEN: 'x', DATABASE_URL: 'x', OBSIDIAN_API_KEY: 'x', ...DANGEROUS,
    };
    for (const tool of Object.keys(SUBPROCESS_TOOLS)) {
      for (const platform of ['win32', 'linux']) {
        const { names, fixed } = allowlistFor(tool, platform);
        for (const n of names) {
          // The NEVER list is the one judge of "looks like a secret" — it knows
          // that TOKENIZERS_PARALLELISM is a knob and AWS_SESSION_TOKEN is not.
          assert.equal(isNeverPassed(n), false, `${tool}/${platform}: "${n}" is on the NEVER list`);
        }
        for (const n of Object.keys(fixed)) assert.equal(isNeverPassed(n), false, `${tool}/${platform}: fixed "${n}"`);
        const out = buildSubprocessEnv(tool, { source: { PATH: 'p', ...SECRETS }, platform });
        assert.deepEqual(Object.keys(out).filter((k) => k in SECRETS), [], `${tool}/${platform} passed a secret`);
        assert.ok(out.PATH, `${tool}/${platform}: PATH must always pass`);
      }
    }
  });

  test('an executable override with a separator is made absolute against the router cwd; a bare name is left for PATH', () => {
    assert.equal(absolutizeExecutableOverride(undefined), undefined);
    assert.equal(absolutizeExecutableOverride(''), '');
    assert.equal(absolutizeExecutableOverride('markitdown'), 'markitdown');
    assert.equal(absolutizeExecutableOverride('yt-dlp.exe'), 'yt-dlp.exe');
    const rel = IS_WIN ? '.\\venv\\Scripts\\markitdown.exe' : './venv/bin/markitdown';
    const abs = absolutizeExecutableOverride(rel);
    assert.ok(path.isAbsolute(abs), abs);
    assert.ok(samePath(abs, path.resolve(process.cwd(), rel)));
    const already = IS_WIN ? 'C:\\tools\\x.exe' : '/opt/tools/x';
    assert.equal(absolutizeExecutableOverride(already), already);
  });

  test('withIsolatedCwd: the directory exists during fn, sits under the temp root, and is gone after — even when fn throws', async () => {
    let seen;
    const result = await withIsolatedCwd('subprocess-env-unit-', async (dir) => {
      seen = dir;
      assert.ok(fs.existsSync(dir) && fs.readdirSync(dir).length === 0, 'fresh and empty');
      assert.ok(isUnderTmp(dir));
      return 42;
    });
    assert.equal(result, 42);
    assert.equal(fs.existsSync(seen), false, 'removed after a resolve');

    let seen2;
    await assert.rejects(withIsolatedCwd('subprocess-env-unit-', async (dir) => { seen2 = dir; throw new Error('boom'); }), /boom/);
    assert.equal(fs.existsSync(seen2), false, 'removed after a throw');
  });
});

// ---------------------------------------------------------------------------
// PINS — real executables through the production spawn sites
// ---------------------------------------------------------------------------

describe('PINS — the sentinel does not reach any guarded child (real executables)', () => {
  test('CONTROL: spawned WITHOUT the helper, the same fake DOES receive the sentinels', async (t) => {
    // The instrument must be shown to see inheritance, or a green pin below
    // proves only that the fake did not look.
    if (!fakeAvailable(t)) return;
    const dir = freshDir('control');
    const fake = installFake(dir, 'control');
    await execFileAsync(fake, ['--version'], { cwd: dir });
    const dump = readDump(dir);
    assert.equal(dump.get(SENTINEL), 'leak', 'the control child must inherit the sentinel');
    assert.equal(dump.get(SECRET_SENTINEL), 'leak-secret');
    for (const [name, value] of Object.entries(DANGEROUS)) {
      assert.equal(dump.get(name), value, `the control child must inherit ${name} — or a green pin proves nothing about it`);
    }
    assert.ok(samePath(dump.cwd, dir));
  });

  test('markitdown (src/markdownify/markitdown.mjs): scrubbed env, private cwd, UTF-8 pipe', async (t) => {
    if (!fakeAvailable(t)) return;
    const dir = freshDir('markitdown');
    const fake = installFake(dir, 'markitdown');
    const input = path.join(dir, 'input.txt');
    fs.writeFileSync(input, 'hello');
    const { text } = await withEnv({ MARKITDOWN_PATH: fake }, () => toMarkdown({ filePath: input }));
    assert.match(text, /env-echo ok/);
    const dump = readDump(dir);
    assertScrubbed(dump, 'markitdown');
    assert.equal(dump.get('PYTHONIOENCODING'), 'utf-8');
    assert.ok(!samePath(dump.cwd, process.cwd()), 'the child must not run in the router cwd');
    assert.ok(isUnderTmp(dump.cwd), `cwd ${dump.cwd} is not a temp directory`);
    assert.equal(fs.existsSync(dump.cwd), false, 'the private cwd is removed afterwards');
    assert.ok(path.isAbsolute(dump.argv[dump.argv.length - 1]), 'the file path handed over is absolute');
  });

  test('markitdown: a RELATIVE executable override still resolves against the router cwd, not the private one', async (t) => {
    if (!fakeAvailable(t)) return;
    // The fake lives under the router's cwd so a relative override can name it —
    // in a git-ignored corner of tests/, never at the repository root, where an
    // interrupted run would leave an untracked .exe for `git add -A` to swallow.
    const corner = path.join(ROOT, 'tests', 'fixtures', '.tmp');
    fs.mkdirSync(corner, { recursive: true });
    const local = fs.mkdtempSync(path.join(corner, 'subprocess-env-'));
    try {
      const fake = installFake(local, 'markitdown');
      const rel = path.relative(process.cwd(), fake);
      assert.ok(!path.isAbsolute(rel) && /[\\/]/.test(rel));
      const input = path.join(local, 'input.txt');
      fs.writeFileSync(input, 'hello');
      const { text } = await withEnv({ MARKITDOWN_PATH: rel }, () => toMarkdown({ filePath: input }));
      assert.match(text, /env-echo ok/, 'a relative MARKITDOWN_PATH used to work — it must still');
      const dump = readDump(local);
      assertScrubbed(dump, 'markitdown (relative override)');
      assert.ok(isUnderTmp(dump.cwd));
    } finally {
      try { fs.rmSync(local, { recursive: true, force: true, maxRetries: 3 }); } catch { /* a just-run exe may linger */ }
    }
  });

  test('repomix (src/markdownify/markitdown.mjs fromRepo): scrubbed env, private cwd', async (t) => {
    if (!fakeAvailable(t)) return;
    const dir = freshDir('repomix');
    const fake = installFake(dir, 'repomix');
    const { text } = await withEnv({ REPOMIX_PATH: fake }, () => fromRepo({ repoUrl: 'octocat/hello-world' }));
    assert.match(text, /env-echo ok/);
    const dump = readDump(dir);
    assertScrubbed(dump, 'repomix');
    assert.equal(dump.has('NODE_OPTIONS'), false, 'NODE_OPTIONS from the parent must not reach a Node child');
    assert.ok(!samePath(dump.cwd, process.cwd()));
    assert.ok(isUnderTmp(dump.cwd));
    assert.equal(fs.existsSync(dump.cwd), false, 'the private cwd is removed afterwards');
    assert.ok(dump.argv.includes('--remote=octocat/hello-world'));
  });

  test('docling (src/markdownify/docling.mjs): scrubbed env, cwd = its own output dir', async (t) => {
    if (!fakeAvailable(t)) return;
    const dir = freshDir('docling');
    const fake = installFake(dir, 'docling');
    const input = path.join(dir, 'doc.pdf');
    fs.writeFileSync(input, '%PDF-1.4 fake');
    const { text } = await withEnv({ DOCLING_PATH: fake }, () => toMarkdownDocling({ filePath: input }));
    assert.match(text, /# env-echo/);
    const dump = readDump(dir);
    assertScrubbed(dump, 'docling');
    assert.equal(dump.get('PYTHONIOENCODING'), 'utf-8');
    const outDir = dump.argv[dump.argv.indexOf('--output') + 1];
    assert.ok(samePath(dump.cwd, outDir), `cwd ${dump.cwd} should be the --output dir ${outDir}`);
    assert.ok(isUnderTmp(outDir));
  });

  test('pdf_to_images (src/markdownify/pdf-images.mjs): scrubbed env, cwd = its own output dir', async (t) => {
    if (!fakeAvailable(t)) return;
    const dir = freshDir('pdf-images');
    const fake = installFake(dir, 'python');
    const input = path.join(dir, 'doc.pdf');
    fs.writeFileSync(input, '%PDF-1.4 fake');
    const result = await withEnv({ PDF_IMAGES_PYTHON: fake }, () => pdfToImages({ filePath: input, maxPages: 1 }));
    assert.match(result.content[0].text, /Rendered 1 page image/);
    const dump = readDump(dir);
    assertScrubbed(dump, 'pdf-images');
    const outDir = dump.argv[dump.argv.indexOf('--out') + 1];
    assert.ok(samePath(dump.cwd, outDir), `cwd ${dump.cwd} should be the --out dir ${outDir}`);
  });

  test('yt-dlp (src/markdownify/youtube-fallback.mjs): scrubbed env, cwd = its own caption dir (no yt-dlp.conf from the workspace)', async (t) => {
    if (!fakeAvailable(t)) return;
    const dir = freshDir('yt-dlp');
    const fake = installFake(dir, 'yt-dlp');
    const md = await withEnv({ YTDLP_PATH: fake }, () =>
      fetchYoutubeTranscriptViaYtdlp('https://youtu.be/dQw4w9WgXcQ', { assertPublic: async () => {} }));
    assert.match(md, /env-echo/);
    const dump = readDump(dir);
    assertScrubbed(dump, 'yt-dlp');
    const template = dump.argv[dump.argv.indexOf('-o') + 1];
    assert.ok(samePath(dump.cwd, path.dirname(template)), `cwd ${dump.cwd} should be the caption dir of ${template}`);
    assert.ok(!samePath(dump.cwd, process.cwd()), 'yt-dlp must not read a yt-dlp.conf from the router cwd');
  });

  test('python probe (src/helpers/conversion-readiness.mjs): scrubbed env, private cwd, version parsed', async (t) => {
    if (!fakeAvailable(t)) return;
    const bin = freshDir('python-probe');
    installFake(bin, 'python3');
    const r = await withPathFirst(bin, () => findPythonDetailed({ execFile: execFileAsync }));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.version, '3.99');
    assert.equal(r.cmd, 'python3');
    const dump = readDump(bin);
    assertScrubbed(dump, 'python-probe');
    assert.equal(dump.get('PYTHONIOENCODING'), 'utf-8');
    assert.ok(isUnderTmp(dump.cwd) && !samePath(dump.cwd, process.cwd()));
    assert.equal(fs.existsSync(dump.cwd), false, 'the probe cwd is removed afterwards');
  });

  test('npm (src/helpers/ensure-deps.mjs runInstall): scrubbed env, the opt-out flag still added, no registry redirect', async (t) => {
    if (!fakeAvailable(t)) return;
    const bin = freshDir('npm-bin');
    installFake(bin, 'npm');
    const packageRoot = freshDir('npm-root');
    const res = await withEnv({ npm_config_registry: 'https://evil.example/' }, () => withPathFirst(bin, () => runInstall(packageRoot)));
    assert.equal(res.ok, true, res.stderr);
    const dump = readDump(bin);
    assertScrubbed(dump, 'npm');
    assert.equal(dump.get('OBSIDIAN_ROUTER_SKIP_MARKITDOWN'), '1', 'the belt-and-braces flag must still reach npm');
    assert.equal(dump.has('npm_config_registry'), false, 'a registry set in the parent (a workspace .env can do that) must not reach npm');
    assert.ok(samePath(dump.cwd, packageRoot), 'npm must still run in the package root');
    assert.deepEqual(dump.argv.slice(0, 2), ['install', '--omit=dev']);
  });

  test('git (src/helpers/plugin-auto-update.mjs default runner): scrubbed env', async (t) => {
    if (!fakeAvailable(t)) return;
    const bin = freshDir('git-bin');
    installFake(bin, 'git');
    const cwd = freshDir('git-cwd');
    const res = await withPathFirst(bin, () => autoUpdate.defaultGitRun(['status', '--porcelain'], { cwd }));
    assert.equal(res.status, 0, res.stderr);
    const dump = readDump(bin);
    assertScrubbed(dump, 'git');
    assert.ok(samePath(dump.cwd, cwd));
    assert.deepEqual(dump.argv, ['status', '--porcelain']);
  });

  test('process scan (src/helpers/plugin-cache-purge.mjs): scrubbed env', async (t) => {
    if (!fakeAvailable(t)) return;
    const bin = freshDir('scan-bin');
    installFake(bin, IS_WIN ? 'powershell' : 'ps');
    const r = await withPathFirst(bin, () => findLiveSnapshotVersions({ cacheDir: path.join(bin, 'cache') }));
    assert.equal(r.ok, true, r.reason);
    const dump = readDump(bin);
    assertScrubbed(dump, 'process-scan');
  });

  test('setup-vault engine (src/helpers/vault-wizard-engine.mjs): scrubbed env, the three router variables still delivered, cwd inherited on purpose', async () => {
    // A Node child — no compiled fake needed, so this pin runs everywhere.
    const dir = freshDir('engine');
    const scriptPath = path.join(dir, 'fake-engine.mjs');
    fs.writeFileSync(scriptPath, ENGINE_FAKE);
    const cfg = path.join(dir, 'router.json');
    const { code, stdout, stderr } = await runSetupVault(['--dry-run', '--json'], {
      scriptPath,
      configPath: cfg,
      extraEnv: { OBSIDIAN_ROUTER_PROVISION_NONCE: 'nonce-1' },
    });
    assert.equal(code, 0, stderr);
    const dump = JSON.parse(stdout);
    const fold = (k) => (IS_WIN ? k.toUpperCase() : k);
    const env = Object.fromEntries(Object.entries(dump.env).map(([k, v]) => [fold(k), v]));
    assert.equal(env[fold(SENTINEL)], undefined, 'the sentinel reached the provisioning engine');
    assert.equal(env[fold(SECRET_SENTINEL)], undefined);
    for (const name of Object.keys(DANGEROUS)) assert.equal(env[fold(name)], undefined, `${name} reached the provisioning engine`);
    assert.equal(env.OBSIDIAN_ROUTER_CONFIG, cfg);
    assert.equal(env.OBSIDIAN_ROUTER_PROVISION_NONCE, 'nonce-1');
    assert.equal(env.OBSIDIAN_ROUTER_NO_AUTO_INSTALL_HOOKS, '1');
    assert.equal(env.ELECTRON_RUN_AS_NODE, '1', 'under an Electron host the engine must be started as Node, not as the app');
    assert.ok(env.PATH);
    assert.deepEqual(dump.argv, ['--dry-run', '--json']);
    // The engine resolves a relative vault path against the caller's cwd, so
    // the cwd is the one thing it MUST inherit.
    assert.ok(samePath(dump.cwd, process.cwd()));
  });
});

// ---------------------------------------------------------------------------
// GUARD — the whole tree
// ---------------------------------------------------------------------------

describe('GUARD — every spawn in src/, scripts/, hooks/, bin/ passes subprocessOptions as its options, or is listed here with a reason', () => {
  /**
   * The exact shape of the tree. A finder that loses a site, a site that
   * loses its guard, and an exemption that grows are all the same red.
   */
  const EXPECTED = Object.freeze({ total: 37, guarded: 22, exempt: 15, sdkTransports: 1 });

  /**
   * Sites that inherit the environment ON PURPOSE. Each entry pins the file,
   * the exact count AND the commands those spawns run (the first argument of
   * each call, as written): a new spawn in one of these files, or one of them
   * changed to run something else, fails the guard until it is either routed
   * through `subprocessOptions` or this table is updated, in review.
   */
  const EXEMPT = [
    { file: 'scripts/build-mcpb.mjs', commands: ['git', 'npm'], why: 'release tooling run in the developer shell: git and `npm ci` need that shell (credential helpers, npm auth, proxies) and the parent holds no router secret' },
    { file: 'scripts/bump-version.mjs', commands: ['git', 'git'], why: 'release tooling in the developer shell: `git config core.hooksPath`' },
    { file: 'scripts/create-release.mjs', commands: ['gh', 'git', 'git', 'git', 'git'], why: 'release tooling in the developer shell: git, and `gh`, which authenticates through GH_TOKEN or its own keyring' },
    { file: 'scripts/export-gate.mjs', commands: ['git'], why: 'release tooling in the developer shell: `git ls-tree`' },
    { file: 'scripts/install-docling.mjs', commands: ['cmd'], why: 'interactive installer in the user shell: pip mirrors, proxies and CA bundles are open-ended configuration, and the parent IS the shell' },
    { file: 'scripts/install-markitdown.mjs', commands: ['cmd'], why: 'interactive installer in the user shell (same reasoning as install-docling.mjs)' },
    { file: 'scripts/setup-vault.mjs', commands: ['cmd', 'open', 'xdg-open'], why: 'launching the user desktop app through the OS protocol handler (cmd start / open / xdg-open) — it must see the user session' },
  ];

  const SCAN_DIRS = ['src', 'scripts', 'hooks', 'bin'];
  const CP_NAMES = ['execFileSync', 'execFile', 'execSync', 'exec', 'spawnSync', 'spawn'];

  function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(mjs|cjs|js)$/.test(e.name)) out.push(p);
    }
    return out;
  }

  /**
   * The identifiers a file can spawn through: what it imports from
   * child_process (respecting `as` renames), plus locals bound to a promisified
   * or injected spawner (`promisify(execFile)`, `deps.execFile`,
   * `opts.execFileImpl || execFileAsync`). A local merely ASSIGNED a spawn's
   * result (`const child = spawn(…)`) is not a spawner and is not collected.
   * A default or namespace import (`import cp from …`, `import * as cp from …`,
   * `const cp = require(…)`) is returned separately: its spawns are
   * `cp.spawn(…)`, member calls the bare-name regex deliberately ignores.
   */
  function spawnerNames(src, code) {
    const names = new Set();
    const namespaces = new Set();
    let m;
    const nsEsm = /import\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s+from\s*['"](?:node:)?child_process['"]/g;
    while ((m = nsEsm.exec(src))) namespaces.add(m[1]);
    const nsCjs = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"](?:node:)?child_process['"]\s*\)/g;
    while ((m = nsCjs.exec(src))) namespaces.add(m[1]);
    const esm = /import\s*\{([^}]*)\}\s*from\s*['"](?:node:)?child_process['"]/g;
    while ((m = esm.exec(src))) {
      for (const part of m[1].split(',')) {
        const p = part.trim();
        if (!p) continue;
        const as = p.split(/\s+as\s+/);
        names.add((as[1] || as[0]).trim());
      }
    }
    const cjs = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*['"](?:node:)?child_process['"]\s*\)/g;
    while ((m = cjs.exec(src))) {
      for (const part of m[1].split(',')) {
        const p = part.trim();
        if (!p) continue;
        const as = p.split(':');
        names.add((as[1] || as[0]).trim());
      }
    }
    // `promisify(<an imported spawner>)` — whatever the import was renamed to.
    const spawners = [...names, 'execFile', 'exec'].map((n) => n.replace(/[$]/g, '\\$'));
    const alias = new RegExp(
      `(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:promisify\\s*\\(\\s*(?:${spawners.join('|')})\\s*\\)|[^;\\n]*\\.(?:execFile|execFileImpl|execFileAsync|execFileSync|spawn|spawnSync)\\b[^;\\n]*)`,
      'g',
    );
    while ((m = alias.exec(code))) names.add(m[1]);
    return { names, namespaces };
  }

  /**
   * Split a call's argument text at depth-0 commas. The depth is read on the
   * BLANKED code (a comma or a parenthesis inside a string literal does not
   * count) and the segments are cut from the RAW source at the same offsets
   * — the blanked text keeps every offset. Whether an argument EXISTS is
   * decided on the raw segment: a string-literal argument (`'git'`) is all
   * blank in the blanked text and used to vanish from the count, so a
   * four-argument call with a literal command counted as three; a trailing
   * comma — the multi-line call style used all over this tree — still yields
   * no empty last argument. Returns aligned { code, raw } pairs.
   */
  function splitTopLevelArgs(argsCode, argsSrc = argsCode) {
    const pairs = [];
    let depth = 0;
    let start = 0;
    const push = (from, to) => {
      const raw = argsSrc.slice(from, to).trim();
      if (raw) pairs.push({ code: argsCode.slice(from, to).trim(), raw });
    };
    for (let i = 0; i < argsCode.length; i += 1) {
      const c = argsCode[i];
      if (c === '(' || c === '[' || c === '{') depth += 1;
      else if (c === ')' || c === ']' || c === '}') depth -= 1;
      else if (c === ',' && depth === 0) { push(start, i); start = i + 1; }
    }
    push(start, argsCode.length);
    return pairs;
  }

  /** True when `text` (blanked code) is one `subprocessOptions(...)` call and nothing else. */
  function isExactHelperCall(text) {
    const m = /^subprocessOptions\s*\(/.exec(text);
    if (!m) return false;
    let depth = 0;
    for (let i = m[0].length - 1; i < text.length; i += 1) {
      if (text[i] === '(') depth += 1;
      else if (text[i] === ')') { depth -= 1; if (depth === 0) return text.slice(i + 1).trim() === ''; }
    }
    return false;
  }

  /** True when raw argument text names an `env` property in any spelling — not `extraEnv`, not `envelope`. */
  function namesEnvProperty(rawText) {
    return /(?<![\w$.'"`])(?:env|'env'|"env"|`env`)(?![\w$])\s*(?::|,|\}|\])/.test(rawText);
  }

  /**
   * The spawn sites of ONE source. `guarded` means the call's OPTIONS argument
   * — the last one — is a `subprocessOptions(...)` call; a helper call buried
   * in the argv array does not count. `tool` is the literal that call names,
   * read from that argument and nowhere else. `command` is the first argument
   * as written, quotes stripped, for the exemption pins.
   */
  function sitesIn(src, file) {
    const code = blankStringsAndComments(src);
    const { names, namespaces } = spawnerNames(src, code);
    if (names.size === 0 && namespaces.size === 0) return [];
    const esc = (n) => n.replace(/[$]/g, '\\$');
    const alternatives = [
      ...[...names].map(esc),
      ...[...namespaces].map((ns) => `${esc(ns)}\\.(?:${CP_NAMES.join('|')})`),
    ].sort((a, b) => b.length - a.length);
    const CALLEE = new RegExp(`(?<![\\w$.])(${alternatives.join('|')})\\s*\\(`, 'g');
    const sites = [];
    let m;
    while ((m = CALLEE.exec(code))) {
      const open = m.index + m[0].length - 1;
      let depth = 0;
      let j = open;
      for (; j < code.length; j += 1) {
        if (code[j] === '(') depth += 1;
        else if (code[j] === ')') { depth -= 1; if (depth === 0) break; }
      }
      // The blanked code keeps every offset, so the same slice of the ORIGINAL
      // source holds the literals (tool name, command) the blanked one hides.
      const argsCode = code.slice(open + 1, j);
      const argsSrc = src.slice(open + 1, j);
      const pairs = splitTopLevelArgs(argsCode, argsSrc);
      const args = pairs.map((p) => p.code);
      const argsWithLiterals = pairs.map((p) => p.raw);
      const last = args[args.length - 1] || '';
      const lastRaw = argsWithLiterals[argsWithLiterals.length - 1] || '';
      // Guarded = the options argument IS EXACTLY a subprocessOptions(...)
      // call — nothing after its closing parenthesis (`subprocessOptions('x').env`
      // or `subprocessOptions('x') || opts` hand something else to the spawn) —
      // and that call names no `env` property of its own, in any spelling
      // (`env:`, the `{ env }` shorthand, `'env':`, `['env']:`): such a call
      // throws at runtime, and is refused statically here. A spread —
      // `{ ...subprocessOptions('x'), env: process.env }` — starts with `{`
      // and is therefore unguarded, as it must be.
      // Node reads the options from a FIXED position — the third argument of
      // spawn/spawnSync/execFile/execFileSync/fork (after the command and the
      // argv), the second of exec/execSync — and ignores anything after it. A
      // helper call in FOURTH position behind a `{ env: process.env }` third
      // is therefore not the options at all, and the last-argument rule used
      // to call that guarded. So: never more than three arguments; with
      // three, the middle one must not be an object literal (Node would take
      // THAT as the options); and no argument but the last may name `env`.
      const tooMany = args.length > 3;
      const middleIsObject = args.length === 3 && args[1].startsWith('{');
      const envBeforeOptions = argsWithLiterals.slice(0, -1).some((a) => namesEnvProperty(a));
      const guarded = !tooMany && !middleIsObject && !envBeforeOptions && isExactHelperCall(last) && !namesEnvProperty(lastRaw);
      let tool = null;
      if (guarded) {
        const lit = /^subprocessOptions\s*\(\s*'([^']+)'/.exec(argsWithLiterals[argsWithLiterals.length - 1] || '');
        tool = lit ? lit[1] : null;
      }
      const first = (argsWithLiterals[0] || '').trim();
      const q = /^['"`]([^'"`]*)['"`]$/.exec(first);
      sites.push({
        file,
        line: code.slice(0, m.index).split('\n').length,
        callee: m[1],
        guarded,
        tool,
        command: q ? q[1] : first,
      });
    }
    return sites;
  }

  /**
   * Files that import child_process in a form the finder cannot follow (a
   * dynamic `import()`, an unusual binding): reported, never skipped — a
   * spawn could hide behind such an import.
   */
  function orphanSpawnerFiles(src, file) {
    const code = blankStringsAndComments(src);
    const { names, namespaces } = spawnerNames(src, code);
    const imports = /(?:from\s*|require\s*\(\s*|import\s*\(\s*)['"](?:node:)?child_process['"]/.test(src);
    return imports && names.size === 0 && namespaces.size === 0 ? [file] : [];
  }

  /**
   * A spawn that does not go through child_process at all: the MCP SDK's
   * `StdioClientTransport` starts a process too, with whatever `env` it is
   * handed. The finder cannot see it as a spawner, so it is counted here,
   * separately, and pinned by file and count like the exemptions.
   */
  function sdkTransportSites(src, file) {
    const code = blankStringsAndComments(src);
    const sites = [];
    const re = /(?<![\w$.])new\s+StdioClientTransport\s*\(/g;
    let m;
    while ((m = re.exec(code))) sites.push({ file, line: code.slice(0, m.index).split('\n').length });
    return sites;
  }

  function scanTree() {
    const sites = [];
    const orphans = [];
    const sdk = [];
    for (const dir of SCAN_DIRS) {
      for (const file of walk(path.join(ROOT, dir))) {
        const src = fs.readFileSync(file, 'utf8');
        const rel = path.relative(ROOT, file).replace(/\\/g, '/');
        sites.push(...sitesIn(src, rel));
        orphans.push(...orphanSpawnerFiles(src, rel));
        sdk.push(...sdkTransportSites(src, rel));
      }
    }
    return { sites, orphans, sdk };
  }

  function spawnSites() {
    return scanTree().sites;
  }

  /**
   * Processes started through the MCP SDK rather than child_process, each
   * with its reason. `serve-http` starts one ROUTER per HTTP session: the
   * child is this same program, and it needs the router's own configuration
   * and secrets to serve — it is not a tool being handed the parent's keys.
   */
  const EXEMPT_SDK = [
    { file: 'scripts/serve-http.mjs', sites: 1, why: 'the child IS the router (one per HTTP session): it needs the router\'s own configuration and secrets to serve, and inherits them on purpose' },
  ];

  test('the finder sees the known spawners (a regressed finder must not pass as "nothing to guard")', () => {
    const src = "import { execFile as ef, spawn } from 'node:child_process';\nimport * as cp from 'node:child_process';\nconst x = promisify(ef);\nconst run = deps.execFile;\nconst child = spawn('a');\n";
    const { names, namespaces } = spawnerNames(src, blankStringsAndComments(src));
    assert.deepEqual([...names].sort(), ['ef', 'run', 'spawn', 'x']);
    assert.deepEqual([...namespaces], ['cp']);
    const cjs = "const cp2 = require('node:child_process');\nconst { spawnSync: ss } = require('child_process');\n";
    const found = spawnerNames(cjs, blankStringsAndComments(cjs));
    assert.deepEqual([...found.names], ['ss']);
    assert.deepEqual([...found.namespaces], ['cp2']);
    assert.equal(CP_NAMES.length, 6);
  });

  test('the finder judges the OPTIONS argument, ignores comments, strings and templates, and reads the tool name from the site itself', () => {
    const src = [
      "import { execFile, spawnSync, execSync } from 'node:child_process';",
      "import * as cp from 'node:child_process';",
      "// spawnSync('commented-out', [], subprocessOptions('git'))",
      "const doc = `spawnSync('in-a-template')`;",
      "const s = \"execFile('in-a-string')\";",
      "execFile('git', ['status'], subprocessOptions('git', { cwd }));",               // guarded, tool git
      "execFile('git', [subprocessOptions('git')], { cwd });",                        // NOT guarded: helper in argv, options inherit
      "spawnSync('npm', ['ci'], subprocessOptions('npm', { shell: true, extraEnv: { CI: '1' } }));", // guarded, tool npm
      "cp.spawn('xdg-open', [uri], { stdio: 'ignore' });",                            // namespace call, not guarded
      "spawnSync(process.execPath, [script], subprocessOptions('setup-vault', {}));", // guarded, command = expression
      "execFile(cmd, args, subprocessOptions(toolName));",                            // guarded but no literal tool
      "spawnSync('git', a, { ...subprocessOptions('git'), env: process.env });",      // NOT guarded: a spread re-widens env
      "execFile('git', [], subprocessOptions('git', { env: process.env }));",         // NOT guarded: env inside the helper call
      "execFile('git', [], subprocessOptions('git', { cwd, env }));",                 // NOT guarded: shorthand env
      "execFile('git', [], subprocessOptions('git', { 'env': x }));",                 // NOT guarded: quoted env
      "execFile('git', [], subprocessOptions('git', { ['env']: x }));",               // NOT guarded: computed env
      "execFile('git', [], subprocessOptions('git').env);",                           // NOT guarded: the env object handed as options
      "execFile('git', [], subprocessOptions('git') || opts);",                       // NOT guarded: not exactly the helper call
      "execFile('git', [], subprocessOptions('git', { extraEnv: { CI: '1' }, envelope: 2 }));", // guarded: extraEnv / envelope are not env
      "execFile('git', [], subprocessOptions('git', { cwd },));",                     // guarded: trailing comma inside the call
      "spawnSync('git', a, { env: process.env }, subprocessOptions('git'));",         // NOT guarded: Node reads the THIRD argument; a helper in fourth position is ignored (codex pass 3)
      "execSync('git', { env: process.env }, subprocessOptions('git'));",             // NOT guarded: exec-style options are the SECOND argument
      "spawnSync('git', { env: process.env }, subprocessOptions('git'));",            // NOT guarded: an object literal where the argv goes IS the options to Node
      "execFile('git', [], subprocessOptions('git'), () => {});",                     // NOT guarded here: four arguments — a callback site is judged by hand, never by the last-argument rule
      "spawnSync('git', a, { stdio: 'ignore' }, subprocessOptions('git'));",          // NOT guarded: four arguments and no env anywhere — Node takes the third as options, the child inherits everything
      "spawnSync('git', { stdio: 'ignore' }, subprocessOptions('git'));",             // NOT guarded: an object literal as argv and no env anywhere — same outcome
      '',
    ].join('\n');
    const sites = sitesIn(src, 'fixture.mjs');
    assert.deepEqual(sites.map((s) => [s.callee, s.guarded, s.tool, s.command]), [
      ['execFile', true, 'git', 'git'],
      ['execFile', false, null, 'git'],
      ['spawnSync', true, 'npm', 'npm'],
      ['cp.spawn', false, null, 'xdg-open'],
      ['spawnSync', true, 'setup-vault', 'process.execPath'],
      ['execFile', true, null, 'cmd'],
      ['spawnSync', false, null, 'git'],
      ['execFile', false, null, 'git'],
      ['execFile', false, null, 'git'],
      ['execFile', false, null, 'git'],
      ['execFile', false, null, 'git'],
      ['execFile', false, null, 'git'],
      ['execFile', false, null, 'git'],
      ['execFile', true, 'git', 'git'],
      ['execFile', true, 'git', 'git'],
      ['spawnSync', false, null, 'git'],
      ['execSync', false, null, 'git'],
      ['spawnSync', false, null, 'git'],
      ['execFile', false, null, 'git'],
      ['spawnSync', false, null, 'git'],
      ['spawnSync', false, null, 'git'],
    ]);
    assert.deepEqual(sites.map((s) => s.line), [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26]);
  });

  test('a file that imports child_process without a spawner the finder recognises is a problem, not silence', () => {
    // `await import('node:child_process')` binds no name the finder tracks:
    // such a file must be reported, or a spawn could hide behind it.
    assert.deepEqual(orphanSpawnerFiles("const cp = await import('node:child_process');\ncp.spawn('x');\n", 'f.mjs'), ['f.mjs']);
    assert.deepEqual(orphanSpawnerFiles("import { spawn } from 'node:child_process';\nspawn('x');\n", 'g.mjs'), []);
    assert.deepEqual(orphanSpawnerFiles('// a comment that says child_process\n', 'h.mjs'), []);
  });

  test('every spawn site passes subprocessOptions(...) as its options, or is exempt by file, by count and by command, with a reason', (t) => {
    const { sites, orphans, sdk } = scanTree();
    assert.deepEqual(orphans, [], `files importing child_process in a form the finder cannot follow: ${orphans.join(', ')}`);

    // The SDK transports: counted apart, pinned by file and count, with a reason.
    const sdkByFile = new Map();
    for (const s of sdk) sdkByFile.set(s.file, (sdkByFile.get(s.file) || 0) + 1);
    const sdkProblems = [];
    for (const [file, n] of sdkByFile) {
      const ex = EXEMPT_SDK.find((e) => e.file === file);
      if (!ex) sdkProblems.push(`${file}: ${n} StdioClientTransport start(s) not listed in EXEMPT_SDK`);
      else if (ex.sites !== n) sdkProblems.push(`${file}: EXEMPT_SDK declares ${ex.sites} but the file has ${n}`);
    }
    for (const ex of EXEMPT_SDK) {
      if (!sdkByFile.has(ex.file)) sdkProblems.push(`${ex.file}: listed in EXEMPT_SDK but starts no transport any more`);
      assert.ok(ex.why && ex.why.length > 20, `${ex.file}: an SDK exemption needs a reason`);
    }
    assert.deepEqual(sdkProblems, [], sdkProblems.join('\n'));
    assert.equal(sdk.length, EXPECTED.sdkTransports, 'the number of SDK-started processes changed — recount, and say why in the changelog');

    const unguarded = sites.filter((s) => !s.guarded);
    const byFile = new Map();
    for (const s of unguarded) byFile.set(s.file, [...(byFile.get(s.file) || []), s]);

    const problems = [];
    for (const [file, list] of byFile) {
      const ex = EXEMPT.find((e) => e.file === file);
      const found = list.map((s) => s.command).sort();
      if (!ex) {
        problems.push(`${file}: ${list.length} spawn(s) without subprocessOptions as their options — ${list.map((s) => `${s.callee}(${s.command})@${s.line}`).join(', ')}`);
      } else if (JSON.stringify([...ex.commands].sort()) !== JSON.stringify(found)) {
        problems.push(`${file}: EXEMPT pins ${JSON.stringify([...ex.commands].sort())} but the file spawns ${JSON.stringify(found)} — ${list.map((s) => `${s.callee}(${s.command})@${s.line}`).join(', ')}`);
      }
    }
    for (const ex of EXEMPT) {
      if (!byFile.has(ex.file)) problems.push(`${ex.file}: listed in EXEMPT but has no unguarded spawn any more — remove the entry`);
      assert.ok(ex.why && ex.why.length > 20, `${ex.file}: an exemption needs a reason`);
    }
    assert.deepEqual(problems, [], problems.join('\n'));

    const exempt = EXEMPT.reduce((n, e) => n + e.commands.length, 0);
    const guarded = sites.length - unguarded.length;
    assert.equal(guarded + exempt, sites.length);
    t.diagnostic(`spawn sites: ${sites.length} child_process total — ${guarded} through subprocessOptions, ${exempt} inheriting by name (${EXEMPT.length} files); ${sdk.length} SDK transport(s) inheriting by name`);
    // Exact, not a floor: a finder that loses a site is as red as a site that loses its guard.
    assert.deepEqual({ total: sites.length, guarded, exempt, sdkTransports: sdk.length }, EXPECTED, 'the shape of the tree changed — recount, and say why in the changelog');
  });

  test('no `...process.env` spread anywhere but in the files exempted above — the header\'s "never ...process.env" is a rule, not an intention', () => {
    const allowed = new Set([...EXEMPT.map((e) => e.file), ...EXEMPT_SDK.map((e) => e.file)]);
    const offenders = [];
    for (const dir of SCAN_DIRS) {
      for (const file of walk(path.join(ROOT, dir))) {
        const rel = path.relative(ROOT, file).replace(/\\/g, '/');
        if (allowed.has(rel)) continue;
        const code = blankStringsAndComments(fs.readFileSync(file, 'utf8'));
        if (/\.\.\.\s*process\.env\b/.test(code)) offenders.push(rel);
      }
    }
    assert.deepEqual(offenders, [], `spreads the whole environment: ${offenders.join(', ')}`);
  });

  test('every guarded site names, at the site, a literal tool the table knows', () => {
    const sites = spawnSites().filter((s) => s.guarded);
    const known = new Set(Object.keys(SUBPROCESS_TOOLS));
    for (const s of sites) {
      assert.ok(s.tool, `${s.file}:${s.line}: subprocessOptions must be called with a literal tool name, at the site`);
      assert.ok(known.has(s.tool), `${s.file}:${s.line}: tool "${s.tool}" is not in SUBPROCESS_TOOLS`);
    }
    assert.equal(sites.length, EXPECTED.guarded);
  });
});
