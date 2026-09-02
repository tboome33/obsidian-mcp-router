/**
 * v0.87.0 — a workspace .env may set only what the router documents for it.
 *
 * THE HOLE: the router and two hooks loaded ANY absent key from the
 * workspace .env. A cloned repository carries a .env a stranger wrote, and
 * through it GIT_CONFIG_GLOBAL, NODE_OPTIONS, MARKITDOWN_PATH, HF_ENDPOINT —
 * or, had the whole OBSIDIAN_ROUTER_* family been let through,
 * OBSIDIAN_ROUTER_CONFIG and OBSIDIAN_ROUTER_VIEW_AGENT_URL — reached the
 * router's own process, and from there git, Node children, the conversion
 * tools, the vault registry itself. Found by the Code Reviewer in passes 2
 * and 3 of the v0.87.0 review, as the half the per-tool allowlist could not
 * close by itself.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  WORKSPACE_DOTENV_KEYS, WORKSPACE_DOTENV_OPTOUTS, WORKSPACE_DOTENV_COMPANION_KEYS, WORKSPACE_DOTENV_POLICY,
  WORKSPACE_DOTENV_SANDBOX_KEYS, isGatedDeployment,
  classifyWorkspaceDotenvKey, parseDotenv, applyWorkspaceDotenv,
} from '../src/helpers/workspace-dotenv.mjs';
import { blankStringsAndComments } from './_source-scan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SCAN_DIRS = ['bin', 'hooks', 'src', 'scripts'];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(mjs|cjs|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** A .env the attacker of the header wrote, plus the legitimate keys, in one file. */
const HOSTILE_ENV = [
  '# a repository .env',
  'OBSIDIAN_ROUTER_DEFAULT_VAULT=notes',
  'export OBSIDIAN_ROUTER_LOCKED="notes"',
  "VAULT_PATH='/srv/vaults/notes'",
  'MD_ALLOWED_PATHS=/srv/shared',
  'OBSIDIAN_ROUTER_NO_WIKI_QUERY_FIRST=1',
  'OBSIDIAN_API_KEY=KEY-companion-DO-NOT-LEAK-0000',
  'OBSIDIAN_BASE_URL=https://127.0.0.1:27124',
  'OBSIDIAN_ROUTER_CONFIG=./evil.json',
  'OBSIDIAN_ROUTER_VIEW_AGENT_URL=https://evil.example/agent',
  'OBSIDIAN_ROUTER_SMART_LINK_URL=https://evil.example/links',
  'OBSIDIAN_ROUTER_USER_ID=someone-else',
  'OBSIDIAN_ROUTER_NO_SUCH_OPTOUT=1',
  'GIT_CONFIG_GLOBAL=./x.gitconfig',
  'HOME=./h',
  'XDG_CONFIG_HOME=./x',
  'NODE_OPTIONS=--require=./x.js',
  'MARKITDOWN_PATH=./tools/x',
  'HF_ENDPOINT=https://evil.example',
  'HTTPS_PROXY=http://evil.example:3128',
  'SSL_CERT_FILE=./ca.pem',
  'OPENAI_API_KEY=sk-not-for-us',
  '',
].join('\n');

const HOSTILE_IGNORED = [
  'OBSIDIAN_ROUTER_CONFIG', 'OBSIDIAN_ROUTER_VIEW_AGENT_URL', 'OBSIDIAN_ROUTER_SMART_LINK_URL', 'OBSIDIAN_ROUTER_USER_ID',
  'OBSIDIAN_ROUTER_NO_SUCH_OPTOUT', 'GIT_CONFIG_GLOBAL', 'HOME', 'XDG_CONFIG_HOME', 'NODE_OPTIONS', 'MARKITDOWN_PATH',
  'HF_ENDPOINT', 'HTTPS_PROXY', 'SSL_CERT_FILE', 'OPENAI_API_KEY',
];

function tmpWorkspace(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-dotenv-'));
  if (content !== undefined) fs.writeFileSync(path.join(dir, '.env'), content);
  return dir;
}

describe('parseDotenv — the one parser', () => {
  test('comments, blanks, export prefix, quotes, CRLF, an = inside the value', () => {
    const text = '# c\r\n\r\nexport A="x = y"\r\nB=\'q\'\r\nC=plain\r\nnoequals\r\n=novalue\r\nD=\r\nE="unterminated\r\n';
    assert.deepEqual(parseDotenv(text), [
      { key: 'A', value: 'x = y' },
      { key: 'B', value: 'q' },
      { key: 'C', value: 'plain' },
      { key: 'D', value: '' },
      { key: 'E', value: '"unterminated' },
    ]);
  });

  test('a leading byte-order mark is dropped — a .env re-saved by Notepad still names its first key', () => {
    // Built, not escaped: an editor or a shell can mangle the escape. The
    // parser relies on trim() counting U+FEFF as whitespace; this pins it.
    const BOM = String.fromCharCode(0xfeff);
    assert.equal(BOM.length, 1);
    assert.deepEqual(parseDotenv(`${BOM}OBSIDIAN_ROUTER_DEFAULT_VAULT=a\nB=1\n`), [
      { key: 'OBSIDIAN_ROUTER_DEFAULT_VAULT', value: 'a' },
      { key: 'B', value: '1' },
    ]);
    assert.equal(classifyWorkspaceDotenvKey(parseDotenv(`${BOM}VAULT_PATH=/v\n`)[0].key), 'apply');
  });
});

describe('classifyWorkspaceDotenvKey — the policy', () => {
  test('the six workspace keys and the enumerated opt-outs apply; the companion keys are skipped; everything else — the host settings included — is ignored', () => {
    for (const k of [...WORKSPACE_DOTENV_KEYS, ...WORKSPACE_DOTENV_OPTOUTS]) assert.equal(classifyWorkspaceDotenvKey(k), 'apply', k);
    for (const k of WORKSPACE_DOTENV_COMPANION_KEYS) assert.equal(classifyWorkspaceDotenvKey(k), 'companion', k);
    for (const k of [
      // the host's / the launcher's settings — never a workspace file's
      'OBSIDIAN_ROUTER_CONFIG', 'OBSIDIAN_ROUTER_VIEW_AGENT_URL', 'OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN',
      'OBSIDIAN_ROUTER_SMART_LINK_URL', 'OBSIDIAN_ROUTER_SMART_LINK_SECRET', 'OBSIDIAN_ROUTER_USER_ID',
      'OBSIDIAN_ROUTER_ALLOWED_VAULTS', 'OBSIDIAN_ROUTER_READONLY', 'OBSIDIAN_ROUTER_REQUIRE_WIREGUARD',
      'OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK', 'OBSIDIAN_ROUTER_HOOK_DEBUG', 'OBSIDIAN_ROUTER_AUTO_UPDATE',
      'OBSIDIAN_ROUTER_AUTO_PURGE_CACHE', 'OBSIDIAN_ROUTER_DONSETCH',
      // an opt-out that is not enumerated is not accepted by shape
      'OBSIDIAN_ROUTER_NO_SUCH_OPTOUT', 'OBSIDIAN_ROUTER_NO_',
      // the rest of the world
      'GIT_CONFIG_GLOBAL', 'HOME', 'XDG_CONFIG_HOME', 'NODE_OPTIONS', 'MARKITDOWN_PATH', 'DOCLING_PATH', 'REPOMIX_PATH',
      'YTDLP_PATH', 'PDF_IMAGES_PYTHON', 'HF_ENDPOINT', 'HTTPS_PROXY', 'SSL_CERT_FILE', 'PATH', 'OPENAI_API_KEY',
      'obsidian_router_locked', 'vault_path',
    ]) {
      assert.equal(classifyWorkspaceDotenvKey(k), 'ignore', k);
    }
    assert.match(WORKSPACE_DOTENV_POLICY, /OBSIDIAN_ROUTER_DEFAULT_VAULT.*MD_SHARE_DIR and the OBSIDIAN_ROUTER_NO_\* opt-outs/);
  });

  /**
   * An opt-out the tree reads but that must NOT be settable from a workspace
   * file goes here, by name, with its reason — the test then requires it to
   * classify as 'ignore'. Empty today: every enumerated opt-out is a
   * per-session convenience, none of them is a security guard. Without this
   * second list the only green exit for a new opt-out would be to ACCEPT it.
   */
  const HOST_ONLY_OPTOUTS = [];

  test('the enumerated opt-outs are exactly the OBSIDIAN_ROUTER_NO_* names the tree READS — comments and strings do not count; a host-only opt-out is refused by name, not forgotten', () => {
    const read = new Set();
    for (const dir of SCAN_DIRS) {
      for (const file of walk(path.join(ROOT, dir))) {
        if (file.endsWith(path.join('src', 'helpers', 'workspace-dotenv.mjs'))) continue;
        const code = blankStringsAndComments(fs.readFileSync(file, 'utf8'));
        for (const m of code.matchAll(/process\.env\.(OBSIDIAN_ROUTER_NO_[A-Z0-9_]+)/g)) read.add(m[1]);
      }
    }
    assert.deepEqual([...read].sort(), [...WORKSPACE_DOTENV_OPTOUTS, ...HOST_ONLY_OPTOUTS].sort(),
      'every OBSIDIAN_ROUTER_NO_* the tree reads is either accepted from a workspace .env (WORKSPACE_DOTENV_OPTOUTS) or refused by name (HOST_ONLY_OPTOUTS, here) — put the name in one of the two on purpose');
    const accepted = new Set(WORKSPACE_DOTENV_OPTOUTS);
    for (const k of accepted) assert.match(k, /^OBSIDIAN_ROUTER_NO_[A-Z0-9_]+$/);
    for (const k of HOST_ONLY_OPTOUTS) {
      assert.ok(!accepted.has(k), `${k}: in both lists`);
      assert.equal(classifyWorkspaceDotenvKey(k), 'ignore', k);
    }
  });
});

describe('applyWorkspaceDotenv — the loader', () => {
  test('a hostile .env sets the documented keys and nothing else; the parent wins; one warning names the rest', () => {
    const dir = tmpWorkspace(HOSTILE_ENV);
    const env = { OBSIDIAN_ROUTER_LOCKED: 'from-the-parent' };
    const warnings = [];
    const r = applyWorkspaceDotenv({ cwd: dir, env, warn: (m) => warnings.push(m) });
    assert.deepEqual(env, {
      OBSIDIAN_ROUTER_LOCKED: 'from-the-parent',
      OBSIDIAN_ROUTER_DEFAULT_VAULT: 'notes',
      VAULT_PATH: '/srv/vaults/notes',
      MD_ALLOWED_PATHS: '/srv/shared',
      OBSIDIAN_ROUTER_NO_WIKI_QUERY_FIRST: '1',
    });
    assert.deepEqual(r.applied, ['OBSIDIAN_ROUTER_DEFAULT_VAULT', 'VAULT_PATH', 'MD_ALLOWED_PATHS', 'OBSIDIAN_ROUTER_NO_WIKI_QUERY_FIRST']);
    assert.deepEqual(r.skipped, ['OBSIDIAN_API_KEY', 'OBSIDIAN_BASE_URL']);
    assert.deepEqual(r.ignored, HOSTILE_IGNORED);
    assert.equal(warnings.length, 1, 'exactly one warning');
    assert.match(warnings[0], new RegExp(`${HOSTILE_IGNORED.length} key\\(s\\) ignored`));
    assert.match(warnings[0], /OBSIDIAN_ROUTER_CONFIG, OBSIDIAN_ROUTER_VIEW_AGENT_URL, .*OPENAI_API_KEY/);
    assert.match(warnings[0], /OBSIDIAN_ROUTER_DEFAULT_VAULT, OBSIDIAN_ROUTER_LOCKED, OBSIDIAN_ROUTER_AUTO_ENRICH, VAULT_PATH, MD_ALLOWED_PATHS, MD_SHARE_DIR and the OBSIDIAN_ROUTER_NO_\* opt-outs/);
    assert.doesNotMatch(warnings[0], /OBSIDIAN_API_KEY|OBSIDIAN_BASE_URL/, 'the companion keys the router wrote itself are not nagged about');
  });

  test('a clean .env warns about nothing; a missing or unreadable file is a silent no-op; no cwd is a no-op', () => {
    const warnings = [];
    const clean = tmpWorkspace('OBSIDIAN_ROUTER_DEFAULT_VAULT=a\nVAULT_PATH=/v\n');
    const env = {};
    applyWorkspaceDotenv({ cwd: clean, env, warn: (m) => warnings.push(m) });
    assert.deepEqual(env, { OBSIDIAN_ROUTER_DEFAULT_VAULT: 'a', VAULT_PATH: '/v' });
    assert.deepEqual(warnings, []);

    const empty = {};
    assert.deepEqual(applyWorkspaceDotenv({ cwd: tmpWorkspace(undefined), env: empty, warn: (m) => warnings.push(m) }), { applied: [], ignored: [], skipped: [], withheld: [] });
    assert.deepEqual(applyWorkspaceDotenv({ cwd: clean, env: empty, warn: (m) => warnings.push(m), readFile: () => { throw new Error('EACCES'); } }), { applied: [], ignored: [], skipped: [], withheld: [] });
    assert.deepEqual(applyWorkspaceDotenv({ env: empty, warn: (m) => warnings.push(m) }), { applied: [], ignored: [], skipped: [], withheld: [] });
    assert.deepEqual(empty, {});
    assert.deepEqual(warnings, []);
  });

  test('the sandbox is ONE setting a workspace file may only NARROW: withheld when the host set either spelling or runs gated, taken when the host set none', () => {
    const file = tmpWorkspace('MD_ALLOWED_PATHS=/\nMD_SHARE_DIR=\nOBSIDIAN_ROUTER_DEFAULT_VAULT=a\n');
    // The host sandboxes through either spelling (the legacy alias included,
    // and an empty value included): the file's root and its empty value are
    // both kept out — the spelling the host used wins by name, the other is
    // withheld by the pair rule.
    for (const parent of [{ MD_SHARE_DIR: '/srv/a' }, { MD_ALLOWED_PATHS: '/srv/a' }, { MD_ALLOWED_PATHS: '' }]) {
      const env = { ...parent };
      const warnings = [];
      const r = applyWorkspaceDotenv({ cwd: file, env, warn: (m) => warnings.push(m) });
      assert.deepEqual(env, { ...parent, OBSIDIAN_ROUTER_DEFAULT_VAULT: 'a' }, JSON.stringify(parent));
      assert.deepEqual(r.applied, ['OBSIDIAN_ROUTER_DEFAULT_VAULT']);
      assert.deepEqual(r.withheld, ['MD_ALLOWED_PATHS', 'MD_SHARE_DIR'].filter((k) => !(k in parent)));
      assert.equal(warnings.length, 1, 'one warning, still');
      assert.match(warnings[0], /withheld — the conversion sandbox is the host's setting here/);
    }
    // Gated with no sandbox at all: the file must not supply one — the
    // start-up check (assertSandboxConsistent) must refuse to start instead.
    for (const parent of [{ OBSIDIAN_ROUTER_READONLY: 'true' }, { OBSIDIAN_ROUTER_ALLOWED_VAULTS: 'a,b' }, { OBSIDIAN_ROUTER_USER_ID: 'u1' }]) {
      assert.equal(isGatedDeployment(parent), true, JSON.stringify(parent));
      const env = { ...parent };
      const r = applyWorkspaceDotenv({ cwd: file, env, warn: () => {} });
      assert.deepEqual(env, { ...parent, OBSIDIAN_ROUTER_DEFAULT_VAULT: 'a' });
      assert.deepEqual(r.withheld, ['MD_ALLOWED_PATHS', 'MD_SHARE_DIR']);
    }
    assert.equal(isGatedDeployment({ OBSIDIAN_ROUTER_READONLY: 'false', OBSIDIAN_ROUTER_ALLOWED_VAULTS: '', OBSIDIAN_ROUTER_USER_ID: '  ' }), false);
    assert.equal(isGatedDeployment({}), false);
    // A single-user host that set none: the file narrows "no sandbox" to its own, silently.
    const narrow = tmpWorkspace('MD_ALLOWED_PATHS=/srv/ingest\n');
    const env = {};
    const warnings = [];
    assert.deepEqual(applyWorkspaceDotenv({ cwd: narrow, env, warn: (m) => warnings.push(m) }), { applied: ['MD_ALLOWED_PATHS'], ignored: [], skipped: [], withheld: [] });
    assert.deepEqual(env, { MD_ALLOWED_PATHS: '/srv/ingest' });
    assert.deepEqual(warnings, []);
    // Ignored AND withheld in one file: still exactly one line, naming both.
    const both = tmpWorkspace('NODE_OPTIONS=--require=./x.js\nMD_ALLOWED_PATHS=/\n');
    const w2 = [];
    applyWorkspaceDotenv({ cwd: both, env: { MD_SHARE_DIR: '/srv/a' }, warn: (m) => w2.push(m) });
    assert.equal(w2.length, 1);
    assert.match(w2[0], /1 key\(s\) ignored .* MD_ALLOWED_PATHS withheld/);
    assert.deepEqual([...WORKSPACE_DOTENV_SANDBOX_KEYS], ['MD_ALLOWED_PATHS', 'MD_SHARE_DIR']);
    for (const k of WORKSPACE_DOTENV_SANDBOX_KEYS) assert.ok(WORKSPACE_DOTENV_KEYS.includes(k), `${k}: a sandbox key is a workspace key`);
  });

  test('the warning shows ignored names through a strict alphabet, clipped and capped — a hostile .env cannot drive a terminal through it', () => {
    const lines = ['OBSIDIAN_ROUTER_DEFAULT_VAULT=ok'];
    lines.push('EVIL[2JKEY=1');                   // an ANSI "clear screen" sequence inside the name
    lines.push(`${'L'.repeat(200)}=1`);                 // a 200-character name
    for (let i = 0; i < 30; i += 1) lines.push(`JUNK_${i}=1`); // more than the cap
    const dir = tmpWorkspace(`${lines.join('\n')}\n`);
    const warnings = [];
    const r = applyWorkspaceDotenv({ cwd: dir, env: {}, warn: (m) => warnings.push(m) });
    assert.equal(r.ignored.length, 32);
    assert.equal(warnings.length, 1);
    const w = warnings[0];
    assert.doesNotMatch(w, /[ -]/, 'no control character reaches stderr');
    assert.match(w, /EVIL\?\?2JKEY/, 'control characters are replaced, not dropped silently');
    assert.doesNotMatch(w, /L{65}/, 'a name is clipped to 64 characters');
    assert.match(w, /32 key\(s\) ignored/);
    assert.match(w, / and 12 more\)/, 'only 20 names are listed; the remainder is counted');
  });

  test('the default warn writes to stderr and never throws', () => {
    const dir = tmpWorkspace('NODE_OPTIONS=--require=./x.js\n');
    assert.doesNotThrow(() => applyWorkspaceDotenv({ cwd: dir, env: {} }));
  });
});

describe('GUARD — every workspace .env loader in the tree goes through applyWorkspaceDotenv', () => {
  const LOADERS = ['bin/obsidian-mcp-router.mjs', 'hooks/_helpers/workspace-vault.mjs', 'hooks/vault-link-linter.mjs'];
  const SILENT_HOOK_LOADERS = ['hooks/_helpers/workspace-vault.mjs', 'hooks/vault-link-linter.mjs'];

  test('the three loaders delegate; the two hook loaders are silent (a hook\'s stderr is the block message Claude reads)', () => {
    for (const rel of LOADERS) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      assert.match(blankStringsAndComments(src), /applyWorkspaceDotenv\s*\(/, `${rel}: must call applyWorkspaceDotenv`);
    }
    for (const rel of SILENT_HOOK_LOADERS) {
      const code = blankStringsAndComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
      assert.match(code, /applyWorkspaceDotenv\s*\(\s*\{[^}]*warn\s*:\s*\(\s*\)\s*=>\s*\{\s*\}/, `${rel}: the hook loader must pass a silent warn`);
    }
    // And not only those two: EVERY direct call under hooks/ is silent — a
    // fourth hook importing the module itself gets no default warn.
    for (const file of walk(path.join(ROOT, 'hooks'))) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const code = blankStringsAndComments(fs.readFileSync(file, 'utf8'));
      const calls = (code.match(/applyWorkspaceDotenv\s*\(/g) || []).length;
      if (!calls) continue;
      const silent = (code.match(/applyWorkspaceDotenv\s*\(\s*\{[^}]*warn\s*:\s*\(\s*\)\s*=>\s*\{\s*\}/g) || []).length;
      assert.equal(silent, calls, `${rel}: every applyWorkspaceDotenv call under hooks/ must pass a silent warn`);
    }
    // The binary is the one place the ignored keys are named: it must keep the
    // default warn, and it must also say what it DID take from the file.
    const binSrc = fs.readFileSync(path.join(ROOT, LOADERS[0]), 'utf8');
    assert.doesNotMatch(blankStringsAndComments(binSrc), /applyWorkspaceDotenv\s*\(\s*\{[^}]*\bwarn\s*:/, `${LOADERS[0]}: the router binary keeps the default warn — its stderr is the MCP log`);
    assert.match(binSrc, /\.env: applied \$\{applied\.join/, `${LOADERS[0]}: the binary names the keys it applied — the log must say a vault, lock or mode came from the workspace file`);
  });

  test('no computed-key write into process.env, no Object.assign onto it, no alias of it, no dotenv package — anywhere but the policy module', () => {
    const offenders = [];
    const RULES = [
      [/process\.env\s*\[[^\]]+\]\s*(?:\?\?|\|\|)?=(?!=)/, 'computed-key write into process.env'],
      [/Object\.assign\(\s*process\.env\b/, 'Object.assign onto process.env'],
      [/(?:Reflect\.set|Object\.defineProperty|Object\.defineProperties)\(\s*process\.env\b/, 'reflective write onto process.env'],
      [/(?<![\w$.])process\.env\s*=(?!=)/, 'reassigns process.env'],
      // The policy module itself writes `env[key] = value` with `env = process.env`
      // as a default parameter: that is the exempted file. A bare alias
      // anywhere else (`const env = process.env;` then `env[k] = v`) would be
      // the same loop, wearing a name the first rule cannot see.
      [/\b(?:const|let|var)\s+\w+\s*=\s*process\.env\s*[;\n]/, 'aliases process.env under another name'],
      [/\{\s*env\s*\}\s*=\s*process\b/, 'destructures env out of process'],
      // The house style takes `env = process.env` as a DEFAULT PARAMETER (ten
      // legitimate readers do), and an alias rule cannot see that form
      // without exempting them all. So the guard stands on the WRITE side:
      // a computed-key write through an identifier named env is the policy
      // module's own loop, copied — and only that module may carry it.
      [/(?<![\w$.])env\s*\[[^\]]+\]\s*(?:\?\?|\|\|)?=(?!=)/, 'computed-key write through an identifier named env'],
    ];
    for (const dir of SCAN_DIRS) {
      for (const file of walk(path.join(ROOT, dir))) {
        const rel = path.relative(ROOT, file).replace(/\\/g, '/');
        if (rel === 'src/helpers/workspace-dotenv.mjs') continue; // exempt BY PATH, never by mention
        const src = fs.readFileSync(file, 'utf8');
        const code = blankStringsAndComments(src);
        for (const [re, why] of RULES) if (re.test(code)) offenders.push(`${rel}: ${why}`);
        // Any spelling of the package — a static import, a require, a dynamic
        // import, the `dotenv/config` side-effect entry — by its string alone.
        if (/['"]dotenv(?:\/[^'"]*)?['"]/.test(src)) offenders.push(`${rel}: names the dotenv package`);
      }
    }
    assert.deepEqual(offenders, [], `the old any-key loop, or a cousin of it, is back: ${offenders.join('; ')}`);
  });

  test('every hook that reads an opt-out loads the workspace .env FIRST — otherwise a NO_* in that file is a dead letter for that hook', () => {
    const late = [];
    let checked = 0;
    for (const file of walk(path.join(ROOT, 'hooks'))) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const code = blankStringsAndComments(fs.readFileSync(file, 'utf8'));
      const read = code.search(/process\.env\.OBSIDIAN_ROUTER_NO_/);
      if (read < 0) continue;
      checked += 1;
      const load = code.search(/\b(?:loadWorkspaceDotenv|applyWorkspaceDotenv)\s*\(/);
      if (load < 0) late.push(`${rel}: reads an opt-out and never loads the workspace .env`);
      else if (load > read) late.push(`${rel}: reads an opt-out (offset ${read}) before loading the workspace .env (offset ${load})`);
    }
    assert.ok(checked >= 10, `expected the opt-out-reading hooks to be found (found ${checked})`);
    assert.deepEqual(late, []);
  });

  test('the only files that name a .env file are the loader, the writers and two bystanders — a new reader is added HERE, by path', () => {
    const ALLOWED = new Set([
      'src/helpers/workspace-dotenv.mjs', // the one loader
      'src/tools/auto-enrich.mjs', 'src/tools/lock.mjs', 'scripts/setup-vault.mjs', // the writers
      'src/helpers/dotenv-scalar.mjs', // a refusal message that names the file
      'src/helpers/export-gate.mjs', // a fixture list of the export gate
    ]);
    const strangers = [];
    const seen = new Set();
    for (const dir of SCAN_DIRS) {
      for (const file of walk(path.join(ROOT, dir))) {
        const rel = path.relative(ROOT, file).replace(/\\/g, '/');
        if (!/['"]\.env['"]/.test(fs.readFileSync(file, 'utf8'))) continue;
        seen.add(rel);
        if (!ALLOWED.has(rel)) strangers.push(rel);
      }
    }
    assert.deepEqual(strangers, [], `a file names '.env' and is not listed here: ${strangers.join(', ')} — a second loader would be a second policy`);
    for (const rel of ALLOWED) assert.ok(seen.has(rel), `${rel}: listed here but no longer names '.env' — drop it from the list`);
  });
});
