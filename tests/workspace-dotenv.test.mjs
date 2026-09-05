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
import { spawnSync, spawn } from 'node:child_process';

import {
  WORKSPACE_DOTENV_KEYS, WORKSPACE_DOTENV_OPTOUTS, WORKSPACE_DOTENV_COMPANION_KEYS, WORKSPACE_DOTENV_POLICY,
  WORKSPACE_DOTENV_SANDBOX_KEYS, WORKSPACE_DOTENV_REFUSED_VALUES, isGatedDeployment,
  classifyWorkspaceDotenvKey, parseDotenv, applyWorkspaceDotenv, workspaceDotenvValueRefusal,
  workspaceDotenvRefusals, appliedWorkspaceDotenvKeys, envKeySourceFile, envKeyOrigin, ENV_ORIGINS,
  workspaceDotenvWasConsulted,
  _resetWorkspaceDotenvProvenance,
} from '../src/helpers/workspace-dotenv.mjs';
import { VALID_MODES, canonicalizeMode, spellingsOf } from '../src/helpers/auto-enrich-mode.mjs';
import { blankStringsAndComments } from './_source-scan.mjs';
import { homeSafeEnv } from './_home-safe-spawn.mjs';

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

/**
 * An opt-out the tree reads but that must NOT be settable from a workspace
 * file goes here, by name, with its reason. Two tests read it: one requires
 * the key to classify as 'ignore', the other requires the hook that reads it
 * to do so BEFORE loading the workspace file — the inverse of the rule every
 * other opt-out follows, so the inversion is asserted rather than merely
 * allowed. Without this second list the only green exit for a new opt-out
 * would be to ACCEPT it.
 */
const HOST_ONLY_OPTOUTS = [
  // The session-start briefing is the DISCLOSURE that a workspace .env
  // proposed a vault. An opt-out this file could set would let the very file
  // being reported on switch off the report — the confused-deputy shape the
  // whole `liaison-workspace-vault-hors-depot` decision exists to close,
  // reappearing one level up as "silence the message about me". Every other
  // enumerated opt-out is a per-session convenience; this one guards a
  // disclosure, so it is taken from the host only.
  'OBSIDIAN_ROUTER_NO_BINDING_BRIEFING',
];

describe('classifyWorkspaceDotenvKey — the policy', () => {
  test('the seven workspace keys and the enumerated opt-outs apply; the companion keys are skipped; everything else — the host settings included — is ignored', () => {
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
    assert.match(warnings[0], /OBSIDIAN_ROUTER_DEFAULT_VAULT, OBSIDIAN_ROUTER_LOCKED, OBSIDIAN_ROUTER_AUTO_ENRICH, OBSIDIAN_ROUTER_REFUSED_VAULT, VAULT_PATH, MD_ALLOWED_PATHS, MD_SHARE_DIR and the OBSIDIAN_ROUTER_NO_\* opt-outs/);
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
    const NOTHING = { applied: [], ignored: [], skipped: [], withheld: [], refused: [] };
    assert.deepEqual(applyWorkspaceDotenv({ cwd: tmpWorkspace(undefined), env: empty, warn: (m) => warnings.push(m) }), NOTHING);
    assert.deepEqual(applyWorkspaceDotenv({ cwd: clean, env: empty, warn: (m) => warnings.push(m), readFile: () => { throw new Error('EACCES'); } }), NOTHING);
    assert.deepEqual(applyWorkspaceDotenv({ env: empty, warn: (m) => warnings.push(m) }), NOTHING);
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
    assert.deepEqual(applyWorkspaceDotenv({ cwd: narrow, env, warn: (m) => warnings.push(m) }), { applied: ['MD_ALLOWED_PATHS'], ignored: [], skipped: [], withheld: [], refused: [] });
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

  test('every hook that reads an opt-out loads the workspace .env FIRST — otherwise a NO_* in that file is a dead letter for that hook; a HOST-ONLY opt-out is read BEFORE, and that inversion is required, not merely tolerated', () => {
    const late = [];
    const early = [];
    let checked = 0;
    let hostOnlyChecked = 0;
    // A host-only opt-out must be read where the workspace file cannot have
    // touched the environment yet. The policy module refuses the key by name
    // as well, so this is the second of two independent reasons — and the one
    // that survives somebody adding the name to the accepted list.
    const HOST_ONLY_RE = new RegExp(`process\\.env\\.(?:${HOST_ONLY_OPTOUTS.join('|')})\\b`);
    for (const file of walk(path.join(ROOT, 'hooks'))) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const code = blankStringsAndComments(fs.readFileSync(file, 'utf8'));
      const load = code.search(/\b(?:loadWorkspaceDotenv|applyWorkspaceDotenv)\s*\(/);

      const hostOnly = code.search(HOST_ONLY_RE);
      if (hostOnly >= 0) {
        hostOnlyChecked += 1;
        if (load < 0) {
          early.push(`${rel}: reads a host-only opt-out and never loads the workspace .env at all`);
        } else if (load < hostOnly) {
          early.push(`${rel}: reads a host-only opt-out (offset ${hostOnly}) AFTER loading the workspace .env (offset ${load})`);
        }
      }

      // The general rule, applied to every OTHER opt-out this file reads.
      const read = code.replace(HOST_ONLY_RE, (m) => ' '.repeat(m.length))
        .search(/process\.env\.OBSIDIAN_ROUTER_NO_/);
      if (read < 0) continue;
      checked += 1;
      if (load < 0) late.push(`${rel}: reads an opt-out and never loads the workspace .env`);
      else if (load > read) late.push(`${rel}: reads an opt-out (offset ${read}) before loading the workspace .env (offset ${load})`);
    }
    assert.ok(checked >= 10, `expected the opt-out-reading hooks to be found (found ${checked})`);
    assert.equal(hostOnlyChecked, HOST_ONLY_OPTOUTS.length, 'every host-only opt-out has a hook that reads it');
    assert.deepEqual(late, []);
    assert.deepEqual(early, []);
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

/**
 * v0.89.0 — one accepted key, one value it may not carry from a file.
 *
 * Accepted option 4 of the decision `liaison-workspace-vault-hors-depot`
 * (Roland, 2026-09-03): FullAuto is the only auto-enrichment mode that turns a
 * file travelling with a cloned repository into standing permission to write
 * into one of the user's vaults without asking again. It keeps the MCP host's
 * server declaration and a call during the session; it loses the file.
 *
 * The two traps these tests exist for, both named in advance:
 *   - refusing the KEY instead of the VALUE (a Hybrid from a file must keep
 *     working — it is a legitimate and common per-project setting);
 *   - comparing the RAW string (auto, full, full-auto, fullauto and every
 *     casing of them are FullAuto; a rule that refused only the obvious
 *     spelling would read as closed and be open).
 */
describe('the one value an accepted key may not carry from a workspace file', () => {
  /** Every spelling of FullAuto, in every casing a file can plausibly carry. */
  const FULLAUTO_SPELLINGS = spellingsOf('FullAuto');
  const casings = (s) => [...new Set([s, s.toLowerCase(), s.toUpperCase()])];

  test('THE FIXTURE IS REAL: the spellings enumerated here are the ones the shared table actually canonicalises', () => {
    // A test that enumerates spellings from a hand-written list proves nothing
    // when a new alias is added to the table and not to the list. So the list
    // comes FROM the table, and this asserts the table still holds the ones the
    // rule was written for — a new alias makes the sweep below cover it for
    // free, and dropping one of these fails here.
    assert.deepEqual(FULLAUTO_SPELLINGS.slice().sort(), ['FullAuto', 'auto', 'full', 'full-auto', 'fullauto']);
    for (const s of FULLAUTO_SPELLINGS) for (const c of casings(s)) assert.equal(canonicalizeMode(c), 'FullAuto', c);
  });

  test('NO spelling and NO casing of FullAuto is applied from a file: refused, absent from the environment, absent from the provenance register', () => {
    for (const spelling of FULLAUTO_SPELLINGS) {
      for (const written of casings(spelling)) {
        _resetWorkspaceDotenvProvenance();
        const env = {};
        const dir = tmpWorkspace(`OBSIDIAN_ROUTER_DEFAULT_VAULT=notes\nOBSIDIAN_ROUTER_AUTO_ENRICH=${written}\n`);
        const warnings = [];
        const r = applyWorkspaceDotenv({ cwd: dir, env, warn: (m) => warnings.push(m) });

        // Not applied — the mode is simply not in the environment.
        assert.equal('OBSIDIAN_ROUTER_AUTO_ENRICH' in env, false, `${written}: reached the environment`);
        assert.deepEqual(env, { OBSIDIAN_ROUTER_DEFAULT_VAULT: 'notes' }, written);
        // The KEY is still accepted policy — it is the value that was refused.
        assert.equal(classifyWorkspaceDotenvKey('OBSIDIAN_ROUTER_AUTO_ENRICH'), 'apply');
        // Reported, with what it was written as and what it means.
        assert.equal(r.refused.length, 1, written);
        assert.deepEqual(r.refused[0], {
          key: 'OBSIDIAN_ROUTER_AUTO_ENRICH',
          value: written,
          canonical: 'FullAuto',
          reason: r.refused[0].reason,
        }, written);
        assert.match(r.refused[0].reason, /not applied from a workspace file/);
        // NOT recorded as applied: the provenance register describes what took
        // effect, and this did not. `envKeyOrigin` must answer as if the file
        // had never named the key.
        assert.deepEqual(appliedWorkspaceDotenvKeys(env), ['OBSIDIAN_ROUTER_DEFAULT_VAULT'], written);
        assert.equal(envKeyOrigin('OBSIDIAN_ROUTER_AUTO_ENRICH', env), ENV_ORIGINS.HOST, written);
        assert.notEqual(envKeyOrigin('OBSIDIAN_ROUTER_AUTO_ENRICH', env), ENV_ORIGINS.WORKSPACE_DOTENV, written);
        // And the refusal is remembered for the session, against THIS env.
        assert.deepEqual(workspaceDotenvRefusals(env).map((x) => x.key), ['OBSIDIAN_ROUTER_AUTO_ENRICH'], written);
        assert.equal(workspaceDotenvRefusals(env)[0].file, path.join(dir, '.env'), written);
        // The other keys of the same file are untouched by the refusal.
        assert.deepEqual(r.applied, ['OBSIDIAN_ROUTER_DEFAULT_VAULT'], written);
        assert.equal(warnings.length, 1, `${written}: exactly one warning`);
      }
    }
  });

  test('THE OTHER HALF: the three other modes, and their aliases, still apply from a file exactly as before', () => {
    const others = VALID_MODES.filter((m) => m !== 'FullAuto');
    assert.deepEqual(others, ['ClaudeAsk', 'Hybrid', 'off']);
    for (const mode of others) {
      for (const spelling of spellingsOf(mode)) {
        for (const written of casings(spelling)) {
          _resetWorkspaceDotenvProvenance();
          const env = {};
          const dir = tmpWorkspace(`OBSIDIAN_ROUTER_AUTO_ENRICH=${written}\n`);
          const warnings = [];
          const r = applyWorkspaceDotenv({ cwd: dir, env, warn: (m) => warnings.push(m) });
          // Applied VERBATIM: this module does not canonicalise what it takes,
          // it only refuses what it must. The server canonicalises later.
          assert.equal(env.OBSIDIAN_ROUTER_AUTO_ENRICH, written, written);
          assert.deepEqual(r.applied, ['OBSIDIAN_ROUTER_AUTO_ENRICH'], written);
          assert.deepEqual(r.refused, [], written);
          assert.deepEqual(appliedWorkspaceDotenvKeys(env), ['OBSIDIAN_ROUTER_AUTO_ENRICH'], written);
          assert.equal(envKeyOrigin('OBSIDIAN_ROUTER_AUTO_ENRICH', env), ENV_ORIGINS.WORKSPACE_DOTENV, written);
          assert.deepEqual(warnings, [], `${written}: a legitimate mode is not worth a warning`);
        }
      }
    }
  });

  test('R5 — a FullAuto the PARENT set stays, and the file that repeats it is not reported as refused', () => {
    // The rule is about files. A host, a launcher or a shell that set the mode
    // has chosen it deliberately, and a file that says the same thing has
    // changed nothing — reporting a refusal there would be a false alarm about
    // a mode that is legitimately in force.
    // The PARENT's spelling varies too. The exemption canonicalises the host's
    // value before comparing — a host that wrote `auto` chose FullAuto just as
    // deliberately as one that wrote `FullAuto`. Review pass 5 measured that
    // comparing the parent's raw string instead left this suite green: R5 had
    // only ever tried the canonical spelling on the host side, so the rule
    // "a refusal is not reported when the parent chose the same value" had no
    // witness for the case where the parent chose it under an alias.
    for (const parentWrote of spellingsOf('FullAuto')) {
      for (const written of ['FullAuto', 'fullauto', 'auto']) {
        _resetWorkspaceDotenvProvenance();
        const env = { OBSIDIAN_ROUTER_AUTO_ENRICH: parentWrote };
        const dir = tmpWorkspace(`OBSIDIAN_ROUTER_AUTO_ENRICH=${written}\n`);
        const warnings = [];
        const r = applyWorkspaceDotenv({ cwd: dir, env, warn: (m) => warnings.push(m) });
        const label = `host=${parentWrote} file=${written}`;
        assert.equal(env.OBSIDIAN_ROUTER_AUTO_ENRICH, parentWrote, `${label}: the parent's own spelling stays`);
        assert.deepEqual(r.applied, [], label);
        assert.deepEqual(r.refused, [], `${label}: the parent chose the same mode; nothing was refused`);
        assert.equal(envKeyOrigin('OBSIDIAN_ROUTER_AUTO_ENRICH', env), ENV_ORIGINS.HOST, label);
        assert.deepEqual(workspaceDotenvRefusals(env), [], label);
        assert.deepEqual(warnings, [], `${label}: nothing happened, nothing to say`);
      }
    }
  });

  test('R4bis — a parent holding a DIFFERENT value does not silence the refusal: that is exactly when the dead line needs naming', () => {
    // Found by review. The first version put the value rule after the
    // parent-wins rule, so ANY parent value skipped it: host=Hybrid plus a
    // file naming FullAuto produced `refused: []` and not one word. Safe —
    // FullAuto still did not apply — but the stale line in the user's own file
    // was never named, and the migration hint never arrived, in the one case
    // where its owner has no other way to find out.
    for (const parentValue of ['Hybrid', 'ClaudeAsk', 'off', 'semi', 'not-a-mode']) {
      _resetWorkspaceDotenvProvenance();
      const env = { OBSIDIAN_ROUTER_AUTO_ENRICH: parentValue };
      const dir = tmpWorkspace('OBSIDIAN_ROUTER_AUTO_ENRICH=FullAuto\n');
      const warnings = [];
      const r = applyWorkspaceDotenv({ cwd: dir, env, warn: (m) => warnings.push(m) });
      assert.equal(env.OBSIDIAN_ROUTER_AUTO_ENRICH, parentValue, `${parentValue}: the parent still wins`);
      assert.deepEqual(r.applied, [], parentValue);
      assert.equal(r.refused.length, 1, `${parentValue}: the dead line must be reported`);
      assert.equal(r.refused[0].canonical, 'FullAuto', parentValue);
      assert.equal(warnings.length, 1, parentValue);
      assert.match(warnings[0], /auto-mode persist/, `${parentValue}: with its migration hint`);
      // And the provenance is untouched by the report: the parent chose.
      assert.equal(envKeyOrigin('OBSIDIAN_ROUTER_AUTO_ENRICH', env), ENV_ORIGINS.HOST, parentValue);
      assert.deepEqual(appliedWorkspaceDotenvKeys(env), [], parentValue);
    }
  });

  test('ONE report per key however many times the file repeats it — a 37 KB file must not become a 460 KB stderr line', () => {
    // Found by review, measured: the refusal loop emitted the full diagnostic
    // once per occurrence, so a thousand duplicate lines produced a single
    // ~460 KB line on the router's stderr at start-up. A cloned repository
    // slowing or wedging the MCP handshake through a message ABOUT ITSELF is
    // the amplification the warning's name-cap already guards against for
    // ignored keys.
    const N = 1000;
    const text = 'OBSIDIAN_ROUTER_AUTO_ENRICH=FullAuto\n'.repeat(N);
    assert.ok(text.length > 30_000, 'the fixture must really be large');
    _resetWorkspaceDotenvProvenance();
    const warnings = [];
    const env = {};
    const r = applyWorkspaceDotenv({ cwd: 'x', env, warn: (m) => warnings.push(m), readFile: () => text });
    assert.equal(r.refused.length, 1, `${N} duplicate lines must produce ONE report`);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].length < 2000, `the warning stays bounded (was ${warnings[0].length} bytes)`);
    assert.equal('OBSIDIAN_ROUTER_AUTO_ENRICH' in env, false, 'and none of the thousand applied');
    // Per LOAD, not per process: a second file gets its own report.
    const second = applyWorkspaceDotenv({ cwd: 'y', env: {}, warn: () => {}, readFile: () => 'OBSIDIAN_ROUTER_AUTO_ENRICH=auto\n' });
    assert.equal(second.refused.length, 1, 'a later load reports its own file');
  });

  test('a file that names the key twice, once refused and once not: the good line applies, the bad one is reported', () => {
    _resetWorkspaceDotenvProvenance();
    const env = {};
    const dir = tmpWorkspace('OBSIDIAN_ROUTER_AUTO_ENRICH=FullAuto\nOBSIDIAN_ROUTER_AUTO_ENRICH=Hybrid\n');
    const r = applyWorkspaceDotenv({ cwd: dir, env, warn: () => {} });
    // Both are true at once and neither contradicts the other: the file asked
    // twice, one ask was refused and the other took effect.
    assert.deepEqual(r.refused.map((x) => x.canonical), ['FullAuto']);
    assert.deepEqual(r.applied, ['OBSIDIAN_ROUTER_AUTO_ENRICH']);
    assert.equal(env.OBSIDIAN_ROUTER_AUTO_ENRICH, 'Hybrid');
    assert.equal(envKeyOrigin('OBSIDIAN_ROUTER_AUTO_ENRICH', env), ENV_ORIGINS.WORKSPACE_DOTENV);
  });

  test('the two env-less accessors got the SAME identity rule as the other two — the class defect swept, 4/4', () => {
    // Review called this the third latent site of the defect v0.88.1 had to
    // repair on `envKeyOrigin`: a record describes the environment object it
    // was written into. `envKeySourceFile` and `appliedWorkspaceDotenvKeys`
    // answered from the register with no `env` at all. No production caller
    // today — which is why it was latent rather than exploitable — but an
    // exported accessor is a caller waiting to happen.
    _resetWorkspaceDotenvProvenance();
    const mine = {};
    const dir = tmpWorkspace('OBSIDIAN_ROUTER_LOCKED=notes\n');
    applyWorkspaceDotenv({ cwd: dir, env: mine, warn: () => {} });
    assert.deepEqual(appliedWorkspaceDotenvKeys(mine), ['OBSIDIAN_ROUTER_LOCKED']);
    assert.equal(envKeySourceFile('OBSIDIAN_ROUTER_LOCKED', mine), path.join(dir, '.env'));
    // A different object: all four accessors decline to answer from it.
    const other = { OBSIDIAN_ROUTER_LOCKED: 'notes' };
    assert.deepEqual(appliedWorkspaceDotenvKeys(other), []);
    assert.equal(envKeySourceFile('OBSIDIAN_ROUTER_LOCKED', other), null);
    assert.equal(envKeyOrigin('OBSIDIAN_ROUTER_LOCKED', other), ENV_ORIGINS.UNKNOWN);
    assert.deepEqual(workspaceDotenvRefusals(other), []);
  });

  test('THE DECLARED LIMIT: the fifth accessor is process-wide, and here is exactly what that costs', () => {
    // Review pass 3 measured this and was right to refuse the CHANGELOG's
    // unqualified "the fifth is not one". `workspaceDotenvWasConsulted` is a
    // process-wide flag, and `envKeyOrigin` uses it as its PRECONDITION while
    // checking record identity per object — so the two halves disagree in one
    // corner. This test PINS the corner rather than leaving it as folklore:
    // measured, not assumed, and the day someone makes consultation per-object
    // (a v0.88.0 contract change, hence not this lot) this pin says what they
    // are changing.
    _resetWorkspaceDotenvProvenance();
    const mine = {};
    applyWorkspaceDotenv({ cwd: tmpWorkspace('OBSIDIAN_ROUTER_LOCKED=notes\n'), env: mine, warn: () => {} });
    const other = { OBSIDIAN_ROUTER_DEFAULT_VAULT: 'notes' };

    // A key PRESENT in the register: the identity check catches the mismatch.
    assert.equal(envKeyOrigin('OBSIDIAN_ROUTER_LOCKED', other), ENV_ORIGINS.UNKNOWN,
      'the recorded half is per-object and answers honestly');
    // A key ABSENT from it: the precondition is process-wide, so this answers
    // `host` — a positive claim about an object no file was read into. THE
    // LIMIT. Honest would be `unknown`.
    assert.equal(envKeyOrigin('OBSIDIAN_ROUTER_DEFAULT_VAULT', other), ENV_ORIGINS.HOST,
      'known and accepted: the precondition does not distinguish environments');
    assert.equal(workspaceDotenvWasConsulted(), true, 'and the flag itself says only "somewhere"');
    // Why it is not reachable in production: the entry points record into
    // process.env and ask about process.env, where the two coincide.
    assert.equal(envKeyOrigin('OBSIDIAN_ROUTER_LOCKED', mine), ENV_ORIGINS.WORKSPACE_DOTENV);
  });

  test('R4 — the warning names the refusal AND what to do about a line an earlier `auto-mode persist` wrote', () => {
    const dir = tmpWorkspace('OBSIDIAN_ROUTER_AUTO_ENRICH=FullAuto\n');
    const warnings = [];
    applyWorkspaceDotenv({ cwd: dir, env: {}, warn: (m) => warnings.push(m) });
    assert.equal(warnings.length, 1);
    const w = warnings[0];
    assert.match(w, /OBSIDIAN_ROUTER_AUTO_ENRICH=FullAuto refused \(canonicalises to FullAuto\)/);
    // The two legitimate homes, so the message is a redirection and not a wall.
    assert.match(w, /MCP host's server declaration/);
    assert.match(w, /set_auto_enrich_mode during the session/);
    // The migration line — nothing changes in silence.
    assert.match(w, /auto-mode persist/);
    assert.match(w, /remove it/);
    // And it says the assignment ONCE. The first version led with
    // `KEY=value refused (…)` and then repeated `KEY=FullAuto` inside the
    // reason, with three em-dashes between: a line an operator has to parse
    // twice to learn one thing.
    assert.equal((w.match(/OBSIDIAN_ROUTER_AUTO_ENRICH=FullAuto/g) || []).length, 1,
      `the assignment is stated once, not twice: ${w}`);
  });

  test('ignored, withheld AND refused in one file: still exactly ONE warning line, naming all three', () => {
    const dir = tmpWorkspace([
      'NODE_OPTIONS=--require=./x.js',
      'MD_ALLOWED_PATHS=/',
      'OBSIDIAN_ROUTER_AUTO_ENRICH=full-auto',
      'OBSIDIAN_ROUTER_DEFAULT_VAULT=notes',
      '',
    ].join('\n'));
    const warnings = [];
    const env = { MD_SHARE_DIR: '/srv/a' };
    const r = applyWorkspaceDotenv({ cwd: dir, env, warn: (m) => warnings.push(m) });
    assert.deepEqual(r.ignored, ['NODE_OPTIONS']);
    assert.deepEqual(r.withheld, ['MD_ALLOWED_PATHS']);
    assert.deepEqual(r.refused.map((x) => x.value), ['full-auto']);
    assert.deepEqual(r.applied, ['OBSIDIAN_ROUTER_DEFAULT_VAULT']);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /1 key\(s\) ignored .* MD_ALLOWED_PATHS withheld .* OBSIDIAN_ROUTER_AUTO_ENRICH=full-auto refused/s);
  });

  test('the spelling shown comes from an untrusted file and goes through the same strict alphabet as the ignored names', () => {
    // Reachable, not hypothetical: parseDotenv strips the quotes and leaves
    // what is inside them, and canonicalizeMode trims before matching — so a
    // quoted value with interior whitespace canonicalises to FullAuto while
    // still carrying characters that have no business on a terminal.
    // Built with fromCharCode rather than written as an escape: an editor or a
    // shell mangles the escape, and the test would silently stop testing.
    const TAB = String.fromCharCode(9);
    assert.equal(TAB.length, 1);
    const dir = tmpWorkspace(`OBSIDIAN_ROUTER_AUTO_ENRICH="${TAB}FullAuto "\n`);
    const warnings = [];
    const r = applyWorkspaceDotenv({ cwd: dir, env: {}, warn: (m) => warnings.push(m) });
    assert.equal(r.refused.length, 1, 'the interior whitespace must not have saved it from the rule');
    assert.equal(r.refused[0].canonical, 'FullAuto');
    assert.equal(r.refused[0].value, '?FullAuto?', 'shown through the strict alphabet, not raw');
    assert.doesNotMatch(warnings[0], new RegExp(TAB), 'no control character reaches stderr');
  });

  test('a refusal recorded against ANOTHER environment object is not reported for this one', () => {
    // The identity-before-value rule v0.88.1 had to restore on the applied
    // half of the register, applied to this half at the same time rather than
    // waiting for the same defect to be found twice.
    _resetWorkspaceDotenvProvenance();
    const mine = {};
    const dir = tmpWorkspace('OBSIDIAN_ROUTER_AUTO_ENRICH=FullAuto\n');
    applyWorkspaceDotenv({ cwd: dir, env: mine, warn: () => {} });
    assert.equal(workspaceDotenvRefusals(mine).length, 1);
    assert.deepEqual(workspaceDotenvRefusals({}), [], 'a different object: the record says nothing about it');
    assert.deepEqual(workspaceDotenvRefusals({ OBSIDIAN_ROUTER_AUTO_ENRICH: 'FullAuto' }), [],
      'not even one that happens to carry the same value');
    _resetWorkspaceDotenvProvenance();
    assert.deepEqual(workspaceDotenvRefusals(mine), [], 'the reset seam clears this half too');
  });

  test('the policy table is the authority: one key, one refused value, and the predicate agrees with it', () => {
    // The table is what a reviewer reads to know what the rule covers, so it is
    // pinned. A second refused value is added there on purpose, and this test
    // is where the decision to add it gets recorded.
    assert.deepEqual(Object.keys(WORKSPACE_DOTENV_REFUSED_VALUES), ['OBSIDIAN_ROUTER_AUTO_ENRICH']);
    assert.equal(WORKSPACE_DOTENV_REFUSED_VALUES.OBSIDIAN_ROUTER_AUTO_ENRICH.refused, 'FullAuto');
    for (const key of Object.keys(WORKSPACE_DOTENV_REFUSED_VALUES)) {
      assert.ok(WORKSPACE_DOTENV_KEYS.includes(key), `${key}: refusing a value of a key that is not accepted anyway is a no-op`);
    }
    // The predicate, directly: a listed key with a refused value, a listed key
    // with anything else, an unlisted key, and the junk inputs.
    assert.equal(workspaceDotenvValueRefusal('OBSIDIAN_ROUTER_AUTO_ENRICH', 'AUTO')?.canonical, 'FullAuto');
    assert.equal(workspaceDotenvValueRefusal('OBSIDIAN_ROUTER_AUTO_ENRICH', 'Hybrid'), null);
    assert.equal(workspaceDotenvValueRefusal('OBSIDIAN_ROUTER_AUTO_ENRICH', 'not-a-mode'), null);
    assert.equal(workspaceDotenvValueRefusal('OBSIDIAN_ROUTER_AUTO_ENRICH', ''), null);
    assert.equal(workspaceDotenvValueRefusal('OBSIDIAN_ROUTER_DEFAULT_VAULT', 'FullAuto'), null);
    assert.equal(workspaceDotenvValueRefusal('constructor', 'FullAuto'), null, 'no prototype walk');
    assert.equal(workspaceDotenvValueRefusal('toString', 'x'), null);
  });
});

describe('the refusal is visible to the operator and invisible to Claude-through-a-hook', () => {
  const BIN = path.join(ROOT, 'bin', 'obsidian-mcp-router.mjs');
  const HOOK = path.join(ROOT, 'hooks', 'vault-link-linter.mjs');

  /**
   * A child env with a throwaway HOME and NO auto-enrich mode of its own —
   * the variable has to be genuinely absent, not empty, or the parent-wins
   * rule would skip the file's line and there would be nothing to refuse.
   * `homeSafeEnv` builds it (and refuses a real home); the delete is why this
   * does not go through `spawnSyncHomeSafe`, whose extras cannot unset a key.
   */
  function childEnv(homeDir) {
    const env = homeSafeEnv(homeDir);
    delete env.OBSIDIAN_ROUTER_AUTO_ENRICH;
    delete env.OBSIDIAN_ROUTER_DEFAULT_VAULT;
    return env;
  }

  test('the router binary NAMES the refusal on its stderr — executed, not grepped for in the source', () => {
    const ws = tmpWorkspace('OBSIDIAN_ROUTER_AUTO_ENRICH=fullauto\n');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-dotenv-home-'));
    // `--version` exits inside parseArgs, which runs AFTER the .env load and
    // BEFORE the dependency self-heal — so this reaches the policy and nothing
    // heavier. stdout carries the version, stderr carries the log.
    const r = spawnSync(process.execPath, [BIN, '--version'], {
      cwd: ws, env: childEnv(home), encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /OBSIDIAN_ROUTER_AUTO_ENRICH=fullauto refused/,
      'the operator must be told which line of their own file stopped working');
    assert.match(r.stderr, /auto-mode persist/, 'and what to do about it');
    assert.doesNotMatch(r.stdout, /refused/, 'stdout is the MCP stdio channel — nothing but the answer goes there');
  });

  test('END TO END: the refusal survives the whole start-up and reaches the Ready line', async () => {
    // Review's one demand for an EXECUTED proof. Everything between the loader
    // and `list_vaults` was pinned by regexes over the source: that the
    // start-up assigns the field, that the reload carries it. Regexes cannot
    // see the junction they depend on — the loader writes into `process.env`,
    // and `autoEnrichModeRefusal()` reads it back from there. So: start the
    // real server, in a real workspace, and read the line an operator reads.
    const ws = tmpWorkspace('OBSIDIAN_ROUTER_AUTO_ENRICH=full-auto\n');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-dotenv-home-'));
    const cfg = path.join(home, 'cfg.json');
    fs.writeFileSync(cfg, JSON.stringify({ vaults: [] }));
    const env = childEnv(home);

    const line = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [BIN, '--no-watch', '--config', cfg], {
        cwd: ws, env, stdio: ['ignore', 'ignore', 'pipe'],
      });
      let buf = '';
      const done = (err, value) => {
        clearTimeout(timer);
        try { child.kill(); } catch { /* already gone */ }
        if (err) reject(err); else resolve(value);
      };
      const timer = setTimeout(() => done(new Error(`no Ready line in 25s. stderr so far:\n${buf}`)), 25_000);
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        buf += chunk;
        // COMPLETE lines only. `split('\n')` leaves the unterminated tail as
        // its last element, and a pipe may break a chunk anywhere: matching
        // that tail would resolve on a HALF line, and the refusal note sits at
        // the very END of the Ready line — so the assertion below would fail
        // for a reason that has nothing to do with the code. A red that only
        // appears on a loaded CI runner, in the one test that proves the whole
        // chain. Dropping the tail costs one more chunk and removes the race.
        const ready = buf.split('\n').slice(0, -1).find((l) => l.includes('] Ready.'));
        if (ready) done(null, ready);
      });
      child.on('error', (e) => done(e));
      child.on('exit', (code) => done(new Error(`exited (${code}) before Ready. stderr:\n${buf}`)));
    });

    // The whole chain in one assertion: the file said full-auto, the policy
    // canonicalised and refused it, the register kept it against process.env,
    // start-up read it back, and the operator is told — with the spelling the
    // file actually used, so they can find the line.
    assert.match(line, /asked for auto-enrich mode FullAuto \(written "full-auto"\) and was refused/, line);
    assert.doesNotMatch(line, /Auto-enrich mode: FullAuto/, 'and the mode itself did NOT take effect');
  });

  test('a hook loading the same file says NOTHING on stderr — its stderr is the message Claude reads when it blocks', () => {
    const ws = tmpWorkspace('OBSIDIAN_ROUTER_AUTO_ENRICH=FullAuto\n');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-dotenv-home-'));
    const r = spawnSync(process.execPath, [HOOK], {
      cwd: ws, env: childEnv(home), encoding: 'utf8', input: '', timeout: 30_000,
    });
    // Whatever the hook decides about its (empty) input, it must not have
    // editorialised about a .env in front of it: a line about a workspace file
    // ahead of a block reason is read by Claude as an instruction.
    //
    // And it must have RUN. Three `doesNotMatch` on stderr are satisfied by a
    // hook that crashed at import with a stack trace containing none of the
    // words — review pass 5's "green for the wrong reason". Exit 0 says the
    // silence came from a hook that finished, not one that never started.
    assert.equal(r.status, 0, `the hook must exit 0, not die silently:\n${r.stderr}`);
    assert.doesNotMatch(r.stderr, /\.env:/, r.stderr);
    assert.doesNotMatch(r.stderr, /refused/, r.stderr);
    assert.doesNotMatch(r.stderr, /FullAuto/, r.stderr);
  });
});
