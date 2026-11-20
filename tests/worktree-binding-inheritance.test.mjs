/**
 * v0.123.0 — a git worktree with no binding of its own INHERITS its main
 * checkout's binding, read from the user's config.
 *
 * Why: bindings are keyed by the exact workspace path, so every worktree
 * Claude Code creates under `<repo>/.claude/worktrees/<name>` started unbound,
 * or bound to the wrong vault, while its repository was bound (measured on
 * 2026-11-20: a DEDIBOX worktree bound to obsidian-mcp-router by mistake).
 *
 * What is pinned here:
 *   - the detection (`worktreeMainCheckout`) on real files laid out the way
 *     git lays them out, and on every malformed shape we refuse;
 *   - the PLANTED pointer: a folder whose `.git` names another repository's
 *     worktree admin directory gets nothing (the back-pointer disagrees);
 *   - `readBinding`: inherits everything (primary, also, tiers, pause, lock,
 *     primary tier), an own entry always wins, a main checkout with no entry
 *     passes nothing on;
 *   - the write side: a write from the worktree creates the worktree's OWN
 *     entry and never touches the main checkout's; the panel's
 *     compare-and-set refuses when the main entry moved meanwhile; `clear`
 *     says what it can and cannot clear;
 *   - the surfaces: `list_vaults.workspaceBinding.inheritedFrom`, the
 *     start-up registry, and the SessionStart briefing (a real child process).
 *
 * Everything is written under `fs.mkdtempSync`; no real config is read.
 */

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { worktreeMainCheckout, linkedWorktreesOf, isBareConfig } from '../src/helpers/worktree-origin.mjs';
import { workspacesDeclaring, sharingRequirement } from '../src/helpers/vault-sharing.mjs';
import { setPrimaryVaultMode } from '../src/tools/set-primary-vault-mode.mjs';
import {
  WORKSPACE_BINDINGS_KEY,
  canonicalWorkspaceKey,
  readBinding,
  rawEntryDigest,
  rawBindingEntry,
  bindingEntryDigest,
  bindingOnFileOf,
  withBinding,
} from '../src/helpers/workspace-bindings.mjs';
import { bindingOnFile, listVaults } from '../src/tools/list-vaults.mjs';
import { confirmWorkspaceBinding } from '../src/tools/workspace-binding.mjs';
import { setSecondaryVaultMode } from '../src/tools/set-secondary-vault-mode.mjs';
import { composeBriefing } from '../src/helpers/binding-briefing.mjs';
import { homeSafeEnv } from './_home-safe-spawn.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-inherit-'));
after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

let counter = 0;
/**
 * A main checkout and one linked worktree, laid out as `git worktree add`
 * lays them out: `<main>/.git/worktrees/<name>/{commondir,gitdir}` and a
 * `<worktree>/.git` FILE pointing at that admin directory.
 */
function layout({ relativePointer = false, insideMain = true } = {}) {
  counter += 1;
  const base = path.join(TMP, `case-${counter}`);
  const main = path.join(base, 'Repo');
  const name = `wt-${counter}`;
  const worktree = insideMain
    ? path.join(main, '.claude', 'worktrees', name)
    : path.join(base, 'elsewhere', name);
  const admin = path.join(main, '.git', 'worktrees', name);
  fs.mkdirSync(admin, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  // git writes forward slashes on Windows too.
  const fwd = (p) => p.split(path.sep).join('/');
  fs.writeFileSync(path.join(main, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = false\n');
  fs.writeFileSync(path.join(admin, 'commondir'), '../..\n');
  fs.writeFileSync(path.join(admin, 'gitdir'), `${fwd(path.join(worktree, '.git'))}\n`);
  const pointer = relativePointer ? fwd(path.relative(worktree, admin)) : fwd(admin);
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${pointer}\n`);
  return { base, main, worktree, admin, name };
}

const MAIN_ENTRY = {
  vault: 'dedibox',
  also: ['stacks', 'nasqnap', 'archive'],
  locked: false,
  alsoWritable: ['stacks'],
  alsoLocked: ['archive'],
  alsoPaused: ['archive'],
  primaryTier: { vault: 'dedibox', mode: 'soft' },
  confirmedVia: 'tool',
  confirmedAt: '2026-11-01',
};

function configWith(entries) {
  const all = {};
  for (const [dir, entry] of entries) all[canonicalWorkspaceKey(dir)] = entry;
  return { [WORKSPACE_BINDINGS_KEY]: all };
}

describe('worktreeMainCheckout — reading git\'s own files, without running git', () => {
  test('a linked worktree answers its main checkout (absolute pointer)', () => {
    const { main, worktree } = layout();
    assert.equal(canonicalWorkspaceKey(worktreeMainCheckout(worktree)), canonicalWorkspaceKey(main));
  });

  test('a relative pointer, and a worktree outside the main checkout, both resolve', () => {
    const a = layout({ relativePointer: true });
    assert.equal(canonicalWorkspaceKey(worktreeMainCheckout(a.worktree)), canonicalWorkspaceKey(a.main));
    const b = layout({ insideMain: false });
    assert.equal(canonicalWorkspaceKey(worktreeMainCheckout(b.worktree)), canonicalWorkspaceKey(b.main));
  });

  test('the main checkout itself (a .git DIRECTORY) is not a worktree', () => {
    const { main } = layout();
    assert.equal(worktreeMainCheckout(main), null);
  });

  test('no .git at all, an empty cwd, a non-string: null', () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'plain-'));
    assert.equal(worktreeMainCheckout(dir), null);
    assert.equal(worktreeMainCheckout(''), null);
    assert.equal(worktreeMainCheckout(undefined), null);
  });

  test('an invalid .git file — garbage, empty, an oversized blob — answers null', () => {
    for (const content of ['not a pointer\n', '', `gitdir: ${'x'.repeat(5000)}\n`]) {
      const { worktree } = layout();
      fs.writeFileSync(path.join(worktree, '.git'), content);
      assert.equal(worktreeMainCheckout(worktree), null, JSON.stringify(content.slice(0, 20)));
    }
  });

  test('a pointer to a directory that does not exist: null', () => {
    const { worktree } = layout();
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(TMP, 'nowhere', '.git', 'worktrees', 'x')}\n`);
    assert.equal(worktreeMainCheckout(worktree), null);
  });

  test('a submodule-style .git file (admin dir with no commondir): null', () => {
    const { worktree, admin } = layout();
    fs.rmSync(path.join(admin, 'commondir'));
    assert.equal(worktreeMainCheckout(worktree), null);
  });

  test('an admin directory whose commondir names ANOTHER repository: null', () => {
    const { worktree, admin, base } = layout();
    // A second, real repository: its .git holds a worktrees/ directory too.
    const other = path.join(base, 'Other');
    fs.mkdirSync(path.join(other, '.git', 'worktrees'), { recursive: true });
    fs.writeFileSync(path.join(admin, 'commondir'), `${path.join(other, '.git')}\n`);
    assert.equal(worktreeMainCheckout(worktree), null);
  });

  test('a commondir or gitdir record that is not ONE short line: null', () => {
    for (const [file, content] of [['commondir', '../..\nextra\n'], ['commondir', `${'../'.repeat(3000)}\n`], ['gitdir', 'a\nb\n']]) {
      const { worktree, admin } = layout();
      fs.writeFileSync(path.join(admin, file), content);
      assert.equal(worktreeMainCheckout(worktree), null, `${file}: ${JSON.stringify(content.slice(0, 12))}`);
    }
  });

  test('a bare common directory (not named .git) has no main checkout: null', () => {
    const base = fs.mkdtempSync(path.join(TMP, 'bare-'));
    const common = path.join(base, 'repo.git');
    const admin = path.join(common, 'worktrees', 'w');
    const worktree = path.join(base, 'w');
    fs.mkdirSync(admin, { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(admin, 'commondir'), '../..\n');
    fs.writeFileSync(path.join(admin, 'gitdir'), `${path.join(worktree, '.git')}\n`);
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${admin}\n`);
    assert.equal(worktreeMainCheckout(worktree), null);
  });

  test('a BARE repository stored in a folder literally named .git: null — and the same layout non-bare resolves', () => {
    for (const bare of [true, false]) {
      const { main, worktree } = layout();
      fs.writeFileSync(path.join(main, '.git', 'config'), `[core]\n\trepositoryformatversion = 0\n\tbare = ${bare}\n`);
      const got = worktreeMainCheckout(worktree);
      if (bare) assert.equal(got, null);
      else assert.equal(canonicalWorkspaceKey(got), canonicalWorkspaceKey(main));
    }
  });

  test('`accept` is asked BEFORE anything outside the workspace is opened', () => {
    const { main, worktree } = layout();
    // EVERY filesystem call is recorded — reads, lstat and realpath — since any
    // of them on a path outside the workspace could stall on a network share.
    const touched = [];
    const readFile = (p) => { touched.push(['read', p]); return fs.readFileSync(p, 'utf8'); };
    const lstat = (p) => { touched.push(['lstat', p]); return fs.lstatSync(p); };
    const realpath = (p) => { touched.push(['realpath', p]); return fs.realpathSync.native(p); };
    assert.equal(worktreeMainCheckout(worktree, { accept: () => false, readFile, lstat, realpath }), null);
    const outside = touched.filter(([, p]) => !canonicalWorkspaceKey(p).startsWith(canonicalWorkspaceKey(worktree)));
    assert.deepEqual(outside, [], 'nothing outside the workspace was touched before accept said yes');
    assert.ok(touched.some(([op, p]) => op === 'read' && path.basename(p) === '.git'), 'the workspace\'s own pointer was read');
    const asked = [];
    worktreeMainCheckout(worktree, { accept: (c) => { asked.push(c); return true; } });
    assert.equal(asked.length, 1);
    assert.equal(canonicalWorkspaceKey(asked[0]), canonicalWorkspaceKey(main));
  });

  test('through readBinding, a pointer to a directory the config does not bind opens nothing outside the workspace', () => {
    const { worktree } = layout();
    const opened = [];
    const seams = {
      worktreeMainCheckout: (cwd, s) => worktreeMainCheckout(cwd, { ...s, readFile: (p) => { opened.push(p); return fs.readFileSync(p, 'utf8'); } }),
    };
    const other = fs.mkdtempSync(path.join(TMP, 'other-'));
    assert.equal(readBinding(configWith([[other, MAIN_ENTRY]]), worktree, seams), null);
    assert.deepEqual(opened.map((p) => path.basename(p)), ['.git']);
  });

  test('A PLANTED POINTER: a folder claiming another repository\'s worktree gets nothing (the back-pointer disagrees)', () => {
    const real = layout();
    const intruder = fs.mkdtempSync(path.join(TMP, 'downloaded-'));
    // The intruder copies the real worktree's pointer verbatim.
    fs.copyFileSync(path.join(real.worktree, '.git'), path.join(intruder, '.git'));
    assert.equal(worktreeMainCheckout(intruder), null);
    // ...while the real worktree, pointed at by that same admin dir, still resolves.
    assert.equal(canonicalWorkspaceKey(worktreeMainCheckout(real.worktree)), canonicalWorkspaceKey(real.main));
    // And through readBinding: the bound repository's binding does NOT reach the intruder,
    // and nothing is written anywhere (readBinding is a pure read of the config object).
    const cfg = configWith([[real.main, MAIN_ENTRY]]);
    const before = JSON.stringify(cfg);
    assert.equal(readBinding(cfg, intruder), null);
    assert.equal(JSON.stringify(cfg), before);
  });

  test('a .git that is a directory: null', () => {
    const { worktree } = layout();
    fs.rmSync(path.join(worktree, '.git'));
    fs.mkdirSync(path.join(worktree, '.git'));
    assert.equal(worktreeMainCheckout(worktree), null);
  });

  test('a .git that is a SYMLINK to a valid pointer file: null (lstat, never followed)', (t) => {
    const { worktree } = layout();
    const target = path.join(worktree, 'pointer-copy');
    fs.copyFileSync(path.join(worktree, '.git'), target);
    fs.rmSync(path.join(worktree, '.git'));
    try {
      fs.symlinkSync(target, path.join(worktree, '.git'), 'file');
    } catch (err) {
      t.skip(`this account cannot create symlinks here (${err.code}): the regular-file rule is still covered by the directory case`);
      return;
    }
    assert.equal(worktreeMainCheckout(worktree), null);
  });
});

describe('readBinding — inheritance from the main checkout, from the user\'s config only', () => {
  test('a worktree with no entry inherits EVERYTHING: primary, also, tiers, pause, lock, primary tier', () => {
    const { main, worktree } = layout();
    const cfg = configWith([[main, { ...MAIN_ENTRY, locked: true }]]);
    const got = readBinding(cfg, worktree);
    const own = readBinding(cfg, main);
    assert.equal(own.inheritedFrom, undefined, 'the main checkout\'s own reading is not "inherited"');
    assert.equal(canonicalWorkspaceKey(got.inheritedFrom), canonicalWorkspaceKey(main));
    const { inheritedFrom, ...rest } = got;
    assert.ok(inheritedFrom);
    assert.deepEqual(rest, own);
    assert.equal(rest.vault, 'dedibox');
    assert.deepEqual(rest.also, ['stacks', 'nasqnap', 'archive']);
    assert.deepEqual(rest.alsoWritable, ['stacks']);
    assert.deepEqual(rest.alsoLocked, ['archive']);
    assert.deepEqual(rest.alsoPaused, ['archive']);
    assert.equal(rest.locked, true);
    assert.deepEqual(rest.primaryTier, { vault: 'dedibox', mode: 'soft' });
  });

  test('a worktree WITH an entry reads its own, never the main checkout\'s', () => {
    const { main, worktree } = layout();
    const cfg = configWith([[main, MAIN_ENTRY], [worktree, { vault: 'router', also: [] }]]);
    const got = readBinding(cfg, worktree);
    assert.equal(got.vault, 'router');
    assert.equal(got.inheritedFrom, undefined);
  });

  test('an own entry the router cannot read (present null) blocks inheritance — it must be repaired, not papered over', () => {
    const { main, worktree } = layout();
    const cfg = configWith([[main, MAIN_ENTRY], [worktree, null]]);
    assert.equal(readBinding(cfg, worktree), null);
  });

  test('a main checkout with no entry passes nothing on', () => {
    const { worktree } = layout();
    const other = fs.mkdtempSync(path.join(TMP, 'other-'));
    assert.equal(readBinding(configWith([[other, MAIN_ENTRY]]), worktree), null);
    assert.equal(readBinding({}, worktree), null);
  });

  test('a main checkout whose entry is unusable passes nothing on', () => {
    const { main, worktree } = layout();
    assert.equal(readBinding(configWith([[main, { also: ['x'] }]]), worktree), null);
  });

  test('a non-worktree directory never inherits from a parent, even one that is bound', () => {
    const { main } = layout();
    const child = path.join(main, 'sub');
    fs.mkdirSync(child, { recursive: true });
    assert.equal(readBinding(configWith([[main, MAIN_ENTRY]]), child), null);
  });

  test('WINDOWS PATHS AND CASE: a key stored lowercase matches a main checkout git spelled in mixed case', (t) => {
    if (process.platform !== 'win32') {
      t.skip('Windows drive-letter paths are not absolute on this platform (measured: CI runs both)');
      return;
    }
    const seams = { worktreeMainCheckout: () => 'C:\\Work\\Dedibox' };
    const cfg = { [WORKSPACE_BINDINGS_KEY]: { 'c:\\work\\dedibox': MAIN_ENTRY } };
    const got = readBinding(cfg, 'C:\\Work\\Dedibox\\.claude\\worktrees\\chrome-naka', seams);
    assert.equal(got.vault, 'dedibox');
    assert.equal(got.inheritedFrom, 'C:\\Work\\Dedibox');
    // ...and with the case of the WORKTREE's own key differing too, its own entry still wins.
    const withOwn = { [WORKSPACE_BINDINGS_KEY]: {
      'c:\\work\\dedibox': MAIN_ENTRY,
      'C:\\WORK\\DEDIBOX\\.CLAUDE\\WORKTREES\\CHROME-NAKA': { vault: 'router', also: [] },
    } };
    assert.equal(readBinding(withOwn, 'c:\\work\\dedibox\\.claude\\worktrees\\chrome-naka', seams).vault, 'router');
  });

  test('the real layout on disk, Windows case-folding included', (t) => {
    if (process.platform !== 'win32') {
      t.skip('case-insensitive paths are a Windows property');
      return;
    }
    const { main, worktree } = layout();
    const cfg = { [WORKSPACE_BINDINGS_KEY]: { [main.toUpperCase()]: MAIN_ENTRY } };
    assert.equal(readBinding(cfg, worktree.toLowerCase()).vault, 'dedibox');
  });
});

describe('the digest a precondition compares', () => {
  test('own entry: exactly rawEntryDigest — every repair diagnostic keeps working', () => {
    const { main, worktree } = layout();
    const cfg = configWith([[main, MAIN_ENTRY], [worktree, { vault: 'router', also: [] }]]);
    assert.equal(bindingEntryDigest(cfg, worktree), rawEntryDigest(rawBindingEntry(cfg, worktree)));
  });

  test('inherited: not the "unbound" digest, and it moves when the main checkout\'s entry moves', () => {
    const { main, worktree } = layout();
    const cfg = configWith([[main, MAIN_ENTRY]]);
    const d1 = bindingEntryDigest(cfg, worktree);
    assert.notEqual(d1, rawEntryDigest(undefined));
    assert.notEqual(d1, rawEntryDigest(MAIN_ENTRY), 'the origin is part of the digest');
    const moved = configWith([[main, { ...MAIN_ENTRY, also: ['stacks'] }]]);
    assert.notEqual(bindingEntryDigest(moved, worktree), d1);
  });

  test('bindingOnFileOf reports the inherited vault/also and where they come from', () => {
    const { main, worktree } = layout();
    const onFile = bindingOnFileOf(configWith([[main, MAIN_ENTRY]]), worktree);
    assert.equal(onFile.vault, 'dedibox');
    assert.deepEqual(onFile.also, ['stacks', 'nasqnap', 'archive']);
    assert.equal(canonicalWorkspaceKey(onFile.inheritedFrom), canonicalWorkspaceKey(main));
    assert.equal(bindingOnFileOf(configWith([[main, MAIN_ENTRY]]), main).inheritedFrom, null);
  });

  test('withBinding from an inherited reading writes a COPY for the worktree, without inheritedFrom, main untouched', () => {
    const { main, worktree } = layout();
    const cfg = configWith([[main, MAIN_ENTRY]]);
    const next = withBinding(cfg, worktree, readBinding(cfg, worktree));
    const stored = rawBindingEntry(next, worktree);
    assert.equal(stored.vault, 'dedibox');
    assert.equal('inheritedFrom' in stored, false);
    assert.deepEqual(stored.alsoPaused, ['archive']);
    assert.deepEqual(rawBindingEntry(next, main), MAIN_ENTRY);
  });
});

// ---------------------------------------------------------------------------
// The tools, through the same in-memory config seams their own suites use.
// ---------------------------------------------------------------------------

const registryOf = (extra = {}) => ({
  configPath: path.join(TMP, 'cfg', 'config.json'),
  vaults: ['dedibox', 'stacks', 'nasqnap', 'archive', 'router'].map((name) => ({ name, type: 'local', path: `/v/${name}` })),
  ...extra,
});

function disk(entries) {
  const file = {
    config: {
      portRegistry: Object.fromEntries(['dedibox', 'stacks', 'nasqnap', 'archive', 'router'].map((n, i) => [`/v/${n}`, 27124 + i])),
      ...configWith(entries),
    },
    writes: 0,
  };
  const seamFor = (cwd) => ({
    cwd,
    readFile: () => JSON.stringify(file.config),
    writeFile: (_p, c) => { file.config = JSON.parse(c); file.writes += 1; },
    ping: async () => ({ online: true, identity: 'confirmed' }),
    launch: () => ({ launched: false, uri: null, reason: 'test' }),
  });
  return { file, seamFor };
}

describe('writes from a worktree — its own entry, never the main checkout\'s', () => {
  test('the panel\'s compare-and-set: read inherited, add a secondary, the worktree gets its own entry', async () => {
    const { main, worktree } = layout();
    const { file, seamFor } = disk([[main, MAIN_ENTRY]]);
    const readFile = () => JSON.stringify(file.config);
    const onFile = bindingOnFile('cfg', { cwd: worktree, readFile });
    assert.equal(onFile.vault, 'dedibox');
    assert.ok(onFile.inheritedFrom);
    const mainBefore = JSON.stringify(rawBindingEntry(file.config, main));
    await confirmWorkspaceBinding(
      registryOf({ workspaceBinding: readBinding(file.config, worktree) }),
      { vault: onFile.vault, also: [...onFile.also, 'router'], ifBindingDigest: onFile.digest, ifNoOtherSpellings: true },
      seamFor(worktree),
    );
    const own = rawBindingEntry(file.config, worktree);
    assert.ok(own, 'the worktree now has an entry of its own');
    assert.deepEqual(own.also, ['stacks', 'nasqnap', 'archive', 'router']);
    assert.equal(readBinding(file.config, worktree).inheritedFrom, undefined);
    assert.equal(JSON.stringify(rawBindingEntry(file.config, main)), mainBefore, 'the main checkout is untouched');
  });

  test('stale: the main checkout\'s entry moved since the read — the write is refused, nothing written', async () => {
    const { main, worktree } = layout();
    const { file, seamFor } = disk([[main, MAIN_ENTRY]]);
    const onFile = bindingOnFile('cfg', { cwd: worktree, readFile: () => JSON.stringify(file.config) });
    // A sibling session edits the MAIN checkout's binding.
    file.config[WORKSPACE_BINDINGS_KEY][canonicalWorkspaceKey(main)] = { ...MAIN_ENTRY, also: ['stacks'] };
    const writesBefore = file.writes;
    await assert.rejects(
      confirmWorkspaceBinding(
        registryOf({ workspaceBinding: null }),
        { vault: onFile.vault, also: [...onFile.also, 'router'], ifBindingDigest: onFile.digest },
        seamFor(worktree),
      ),
      /differs/,
    );
    assert.equal(file.writes, writesBefore);
    assert.equal(rawBindingEntry(file.config, worktree), undefined);
  });

  test('set_secondary_vault_mode from a worktree: tiers copied, the one changed, main untouched', async () => {
    const { main, worktree } = layout();
    const { file, seamFor } = disk([[main, MAIN_ENTRY]]);
    const reg = registryOf({ workspaceBinding: readBinding(file.config, worktree) });
    await setSecondaryVaultMode(reg, { vault: 'nasqnap', mode: 'writable' }, seamFor(worktree));
    const own = readBinding(file.config, worktree);
    assert.equal(own.inheritedFrom, undefined);
    assert.deepEqual(own.alsoWritable.sort(), ['nasqnap', 'stacks']);
    assert.deepEqual(own.alsoLocked, ['archive']);
    assert.deepEqual(own.alsoPaused, ['archive']);
    assert.deepEqual(own.primaryTier, { vault: 'dedibox', mode: 'soft' });
    assert.deepEqual(rawBindingEntry(file.config, main), MAIN_ENTRY);
  });

  test('clear with no entry of its own: says it inherits, changes no binding', async () => {
    const { main, worktree } = layout();
    const { file, seamFor } = disk([[main, MAIN_ENTRY]]);
    const reg = registryOf({ workspaceBinding: readBinding(file.config, worktree) });
    const out = await confirmWorkspaceBinding(reg, { clear: true }, seamFor(worktree));
    assert.equal(out.cleared, false);
    assert.equal(out.boundTo, 'dedibox');
    assert.match(out.message, /inherits the binding of its main checkout/);
    assert.deepEqual(rawBindingEntry(file.config, main), MAIN_ENTRY);
    assert.equal(rawBindingEntry(file.config, worktree), undefined);
    assert.equal(reg.workspaceBinding.vault, 'dedibox', 'the live session is left as it was');
  });

  test('clear of an own entry hands the worktree back to inheritance, live and on file', async () => {
    const { main, worktree } = layout();
    const { file, seamFor } = disk([[main, MAIN_ENTRY], [worktree, { vault: 'router', also: [] }]]);
    const reg = registryOf({
      workspaceBinding: readBinding(file.config, worktree),
      defaultVault: 'router',
      defaultVaultSource: { origin: 'binding', variable: null },
    });
    const out = await confirmWorkspaceBinding(reg, { clear: true }, seamFor(worktree));
    assert.equal(out.cleared, true);
    assert.equal(out.boundTo, 'dedibox');
    assert.match(out.message, /now uses the binding of its main checkout/);
    assert.equal(rawBindingEntry(file.config, worktree), undefined);
    assert.equal(reg.workspaceBinding.vault, 'dedibox');
    assert.ok(reg.workspaceBinding.inheritedFrom);
    assert.equal(reg.defaultVault, 'dedibox');
    assert.equal(reg.defaultVaultSource.origin, 'binding');
  });
});

describe('the surfaces say the binding is inherited, and from where', () => {
  test('list_vaults.workspaceBinding.inheritedFrom — and null for an own binding', async () => {
    const REFUSED = 'http://127.0.0.1:1';
    const v = (name) => ({ name, type: 'remote', baseUrl: REFUSED, apiKey: 'k', timeoutMs: 500 });
    const inherited = await listVaults({
      vaults: [v('dedibox')], skipped: [], configPath: '/c',
      workspaceBinding: { vault: 'dedibox', also: [], locked: false, inheritedFrom: 'C:/Users/me/dedibox' },
    });
    assert.equal(inherited.workspaceBinding.inheritedFrom, 'C:/Users/me/dedibox');
    const own = await listVaults({
      vaults: [v('dedibox')], skipped: [], configPath: '/c',
      workspaceBinding: { vault: 'dedibox', also: [], locked: false },
    });
    assert.equal(own.workspaceBinding.inheritedFrom, null);
  });

  test('the SessionStart briefing (a real hook process) names the main checkout, and writes nothing', () => {
    const { main, worktree } = layout();
    const home = fs.mkdtempSync(path.join(TMP, 'home-'));
    const configPath = path.join(TMP, `briefing-${counter}.json`);
    const config = {
      portRegistry: { [path.join(TMP, 'V', 'dedibox')]: 27124, [path.join(TMP, 'V', 'stacks')]: 27125 },
      vaultNames: { [path.join(TMP, 'V', 'dedibox')]: 'dedibox', [path.join(TMP, 'V', 'stacks')]: 'stacks' },
      // Imported by the migration IN THE MAIN CHECKOUT: the worktree must not announce it as its own.
      ...configWith([[main, { vault: 'dedibox', also: ['stacks'], confirmedVia: 'migration', confirmedAt: '2026-01-01' }]]),
    };
    const bytes = Buffer.from(JSON.stringify(config, null, 2));
    fs.writeFileSync(configPath, bytes);
    const before = crypto.createHash('sha256').update(bytes).digest('hex');
    const env = homeSafeEnv(home);
    for (const k of Object.keys(env)) if (k.startsWith('OBSIDIAN_ROUTER_') || k === 'VAULT_PATH') delete env[k];
    const r = spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'workspace-briefing.mjs')], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: worktree }),
      encoding: 'utf8',
      env: { ...env, OBSIDIAN_ROUTER_CONFIG: configPath, OBSIDIAN_ROUTER_NO_SEMANTIC_CHECK: '1' },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /bound to the vault "dedibox"/);
    assert.match(r.stdout, /INHERITED/);
    assert.ok(r.stdout.includes('Repo'), r.stdout);
    assert.doesNotMatch(r.stdout, /NOBODY CONFIRMED THIS BINDING/);
    const after = crypto.createHash('sha256').update(fs.readFileSync(configPath)).digest('hex');
    assert.equal(after, before, 'the hook reads the config, it never writes it');
  });

  test('the same hook in the MAIN checkout says nothing about inheritance', () => {
    const { main } = layout();
    const home = fs.mkdtempSync(path.join(TMP, 'home-'));
    const configPath = path.join(TMP, `briefing-main-${counter}.json`);
    fs.writeFileSync(configPath, JSON.stringify({
      portRegistry: { [path.join(TMP, 'V', 'dedibox')]: 27124 },
      vaultNames: { [path.join(TMP, 'V', 'dedibox')]: 'dedibox' },
      ...configWith([[main, { vault: 'dedibox', also: [] }]]),
    }));
    const env = homeSafeEnv(home);
    for (const k of Object.keys(env)) if (k.startsWith('OBSIDIAN_ROUTER_') || k === 'VAULT_PATH') delete env[k];
    const r = spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'workspace-briefing.mjs')], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: main }),
      encoding: 'utf8',
      env: { ...env, OBSIDIAN_ROUTER_CONFIG: configPath, OBSIDIAN_ROUTER_NO_SEMANTIC_CHECK: '1' },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /bound to the vault "dedibox"/);
    assert.doesNotMatch(r.stdout, /INHERITED/);
  });
});

/** A child env with a throwaway HOME and no OBSIDIAN_ROUTER_* from the developer's shell. */
function cleanEnv(extra = {}) {
  const env = homeSafeEnv(fs.mkdtempSync(path.join(TMP, 'home-')));
  for (const k of Object.keys(env)) if (k.startsWith('OBSIDIAN_ROUTER_') || k === 'VAULT_PATH' || k.startsWith('GIT_')) delete env[k];
  return { ...env, ...extra };
}

describe('end to end — a real git worktree, and the router\'s own start-up', () => {
  test('`git worktree add` output is recognised by the file-only detection', (t) => {
    const probe = spawnSync('git', ['--version'], { encoding: 'utf8' });
    if (probe.status !== 0) {
      t.skip(`git is not available here (${probe.error?.code ?? probe.status}): the hand-built layouts above still ran`);
      return;
    }
    const base = fs.mkdtempSync(path.join(TMP, 'realgit-'));
    const main = path.join(base, 'Main Repo');
    fs.mkdirSync(main);
    const globalCfg = path.join(base, 'gitconfig');
    fs.writeFileSync(globalCfg, '');
    // Isolated from the machine's git configuration: no system file, an empty global one.
    const env = cleanEnv({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalCfg, GIT_TRACE2: '0' });
    const git = (...args) => {
      const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: main, env, encoding: 'utf8' });
      assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    };
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', 'init');
    const wt = path.join(main, '.claude', 'worktrees', 'feature-x');
    git('worktree', 'add', '-q', '-b', 'feature-x', wt);
    // Compared PHYSICALLY: git records the long path, while os.tmpdir() can be
    // an 8.3 short name or go through a link (the Windows CI runner's is
    // `runner~1`). The answer is git's own spelling of the main checkout.
    const physical = (p) => canonicalWorkspaceKey(fs.realpathSync.native(p));
    const found = worktreeMainCheckout(wt);
    assert.ok(found, 'a real git worktree is recognised');
    assert.equal(physical(found), physical(main));
    // A session opened in the main checkout is keyed by the spelling git uses for it.
    assert.equal(readBinding(configWith([[found, MAIN_ENTRY]]), wt).vault, 'dedibox');
  });

  test('loadRegistry in a worktree (a real child process): the inherited binding is the session\'s, origin "binding"', () => {
    const { main, worktree } = layout();
    const REFUSED = 'http://127.0.0.1:1';
    const configPath = path.join(TMP, `registry-${counter}.json`);
    const bytes = JSON.stringify({
      remoteVaults: ['dedibox', 'stacks', 'router'].map((name) => ({ name, baseUrl: REFUSED, apiKey: 'k' })),
      ...configWith([[main, { vault: 'dedibox', also: ['stacks'] }]]),
    });
    fs.writeFileSync(configPath, bytes);
    const registryUrl = new URL('../src/registry.mjs', import.meta.url).href;
    const script = `const { loadRegistry } = await import(${JSON.stringify(registryUrl)});
const r = await loadRegistry({ configPath: ${JSON.stringify(configPath)} });
process.stdout.write(JSON.stringify({ binding: r.workspaceBinding, defaultVault: r.defaultVault, source: r.defaultVaultSource }));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: worktree, env: cleanEnv(), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.binding.vault, 'dedibox');
    assert.deepEqual(out.binding.also, ['stacks']);
    assert.equal(canonicalWorkspaceKey(out.binding.inheritedFrom), canonicalWorkspaceKey(main));
    assert.equal(out.defaultVault, 'dedibox');
    assert.equal(out.source.origin, 'binding');
    // The FIRST start ever opens the one-time import's window (any start does,
    // or a repository cloned later could have its .env imported) — but the
    // inheriting worktree is not recorded as having decided anything.
    const afterFirst = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual(Object.keys(afterFirst[WORKSPACE_BINDINGS_KEY]), [canonicalWorkspaceKey(main)]);
    assert.ok(afterFirst.workspaceBindingsMigration?.openedAt, 'the window is opened');
    assert.deepEqual(afterFirst.workspaceBindingsMigration.imported, [], 'the worktree is not recorded');
    // Once the window is open, a start in the worktree writes NOTHING.
    const opened = fs.readFileSync(configPath, 'utf8');
    const again = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: worktree, env: cleanEnv(), encoding: 'utf8' });
    assert.equal(again.status, 0, again.stderr);
    assert.equal(fs.readFileSync(configPath, 'utf8'), opened);
    assert.notEqual(opened, bytes);
  });
});

describe('review round 1 — what the first write, the digest, clear and the sharing guard must keep', () => {
  test('a first REPLACE write from a worktree keeps the inherited primary tier and pause (confirm_workspace_binding)', async () => {
    const { main, worktree } = layout();
    const { file, seamFor } = disk([[main, MAIN_ENTRY]]);
    await confirmWorkspaceBinding(
      registryOf({ workspaceBinding: readBinding(file.config, worktree) }),
      { vault: 'dedibox', also: ['stacks', 'nasqnap', 'archive', 'router'] },
      seamFor(worktree),
    );
    const own = rawBindingEntry(file.config, worktree);
    assert.deepEqual(own.primaryTier, { vault: 'dedibox', mode: 'soft' }, 'the narrowed primary stays narrowed');
    assert.deepEqual(own.alsoPaused, ['archive'], 'the paused secondary stays paused');
    assert.equal('inheritedFrom' in own, false);
    assert.deepEqual(rawBindingEntry(file.config, main), MAIN_ENTRY);
  });

  test('a first write that moves the primary does NOT carry the old primary\'s tier', () => {
    const { main, worktree } = layout();
    const cfg = configWith([[main, MAIN_ENTRY]]);
    const own = rawBindingEntry(withBinding(cfg, worktree, { vault: 'router', also: ['archive'] }), worktree);
    assert.equal(own.primaryTier, undefined);
    assert.deepEqual(own.alsoPaused, ['archive'], 'a pause follows the secondary that stays');
  });

  test('a hand-written inheritedFrom in an own entry is not carried through the next write', () => {
    const { worktree } = layout();
    const cfg = configWith([[worktree, { vault: 'router', also: [], inheritedFrom: '/somewhere' }]]);
    const own = rawBindingEntry(withBinding(cfg, worktree, { vault: 'router', also: ['stacks'] }), worktree);
    assert.equal('inheritedFrom' in own, false);
  });

  test('digest domains: the same main entry inherited from two origins differs, and no own entry can equal an inherited reading', () => {
    const a = layout();
    const b = layout();
    const cfg = configWith([[a.main, MAIN_ENTRY], [b.main, MAIN_ENTRY]]);
    assert.notEqual(bindingEntryDigest(cfg, a.worktree), bindingEntryDigest(cfg, b.worktree));
    // An own entry shaped like any wrapper an inherited digest could be built from.
    const forged = { inheritedFrom: canonicalWorkspaceKey(a.main), entry: MAIN_ENTRY };
    const withForged = configWith([[a.main, MAIN_ENTRY], [a.worktree, forged]]);
    assert.notEqual(bindingEntryDigest(withForged, a.worktree), bindingEntryDigest(cfg, a.worktree));
  });

  test('clear into an inherited LOCKED binding locks to it, source "binding", over a host lock', async () => {
    const { main, worktree } = layout();
    const { file, seamFor } = disk([[main, { vault: 'dedibox', also: ['stacks'], locked: true }], [worktree, { vault: 'router', also: [] }]]);
    const reg = registryOf({
      workspaceBinding: readBinding(file.config, worktree),
      lockedVault: 'stacks',
      lockSource: { origin: 'host', variable: 'OBSIDIAN_ROUTER_LOCKED' },
      defaultVault: 'router',
      defaultVaultSource: { origin: 'binding', variable: null },
    });
    const out = await confirmWorkspaceBinding(reg, { clear: true }, seamFor(worktree));
    assert.equal(out.boundTo, 'dedibox');
    assert.equal(reg.lockedVault, 'dedibox');
    assert.deepEqual(reg.lockSource, { origin: 'binding', variable: null });
    assert.equal(reg.defaultVault, 'dedibox');
    assert.match(out.message, /inherits from its main checkout, which is locked/);
  });

  test('clear into an inherited locked binding whose vault this session does not hold installs no lock', async () => {
    const { main, worktree } = layout();
    const { file, seamFor } = disk([[main, { vault: 'ghost', also: [], locked: true }], [worktree, { vault: 'router', also: [] }]]);
    const reg = registryOf({ workspaceBinding: readBinding(file.config, worktree), lockedVault: null, lockSource: { origin: 'unset', variable: null } });
    await confirmWorkspaceBinding(reg, { clear: true }, seamFor(worktree));
    assert.equal(reg.lockedVault, null);
  });

  test('set_primary_vault_mode from an inheriting worktree: the live binding stops saying "inherited"', async () => {
    const { main, worktree } = layout();
    const { file, seamFor } = disk([[main, { vault: 'dedibox', also: ['stacks'] }]]);
    const reg = registryOf({ workspaceBinding: readBinding(file.config, worktree) });
    assert.ok(reg.workspaceBinding.inheritedFrom);
    await setPrimaryVaultMode(reg, { vault: 'dedibox', mode: 'locked' }, seamFor(worktree));
    assert.ok(rawBindingEntry(file.config, worktree), 'the worktree now has its own entry');
    assert.equal(reg.workspaceBinding.inheritedFrom, undefined);
    assert.equal(reg.workspaceBinding.primaryTier.mode, 'locked');
  });

  test('the sharing guard counts an inheriting worktree as a second writer of the main checkout\'s vaults', () => {
    const { main, worktree } = layout();
    const listed = linkedWorktreesOf(main);
    assert.equal(listed.complete, true);
    assert.deepEqual(listed.dirs.map(canonicalWorkspaceKey), [canonicalWorkspaceKey(worktree)]);
    const cfg = configWith([[main, { vault: 'dedibox', also: ['stacks'] }]]);
    assert.deepEqual(workspacesDeclaring('dedibox', cfg).sort(), [canonicalWorkspaceKey(main), canonicalWorkspaceKey(worktree)].sort());
    const req = sharingRequirement('dedibox', { openVaults: [] }, cfg);
    assert.equal(req.required, true);
    assert.equal(req.reason, 'multi-workspace');
    // A worktree with its OWN entry is counted by that entry, not twice.
    const own = configWith([[main, { vault: 'dedibox', also: [] }], [worktree, { vault: 'router', also: [] }]]);
    assert.deepEqual(workspacesDeclaring('dedibox', own), [canonicalWorkspaceKey(main)]);
    assert.equal(sharingRequirement('dedibox', { openVaults: [] }, own).required, false);
  });
});

describe('review round 2 — what the repairs of round 1 had to keep', () => {
  test('bare: every spelling git reads as true counts; false spellings do not', () => {
    for (const v of ['true', 'yes', 'on', '1', '"true"', 'true # kept by hand', 'TRUE']) {
      assert.equal(isBareConfig(`[core]\n\tbare = ${v}\n`), true, v);
    }
    assert.equal(isBareConfig('[core]\n\tbare\n'), true, 'a key with no value is true');
    for (const v of ['false', 'no', 'off', '0', '"false"']) {
      assert.equal(isBareConfig(`[core]\n\tbare = ${v}\n`), false, v);
    }
    assert.equal(isBareConfig('[core]\n\tbare = true\n\tbare = false\n'), false, 'the last assignment wins');
    assert.equal(isBareConfig('[remote "x"]\n\tbare = true\n'), false, 'only [core] counts');
  });

  test('a main repository whose config cannot be read fails closed', () => {
    const { worktree, main } = layout();
    fs.rmSync(path.join(main, '.git', 'config'));
    assert.equal(worktreeMainCheckout(worktree), null);
    // ...and one too large to be a config (read as nothing, not as "not bare").
    const other = layout();
    fs.writeFileSync(path.join(other.main, '.git', 'config'), '[core]\n\tbare = false\n' + '# padding\n'.repeat(40000));
    assert.equal(worktreeMainCheckout(other.worktree), null);
  });

  test('the answer keeps the spelling the config approved (a mapped or subst drive must not be rewritten)', () => {
    const { worktree, main } = layout();
    // A realpath that rewrites every path under another root, as a mapped drive's would.
    const alias = (p) => path.join(TMP, 'PHYSICAL', path.relative(TMP, fs.realpathSync.native(p)));
    const got = worktreeMainCheckout(worktree, { realpath: alias });
    assert.equal(got, main, 'the approved spelling, not the physical one');
  });

  test('a first write from a worktree does not turn a stale main-entry field into a live restriction', () => {
    const { main, worktree } = layout();
    // The main entry carries a tier naming ANOTHER vault and a pause of an undeclared one.
    const cfg = configWith([[main, { vault: 'alpha', also: ['beta'], primaryTier: { vault: 'beta', mode: 'locked' }, alsoPaused: ['gamma'] }]]);
    const inherited = readBinding(cfg, worktree);
    assert.equal(inherited.primaryTier, undefined);
    assert.equal(inherited.alsoPaused?.length ?? 0, 0);
    const own = rawBindingEntry(withBinding(cfg, worktree, { vault: 'beta', also: ['gamma'] }), worktree);
    assert.equal(own.primaryTier, undefined, 'beta was never narrowed where it is primary');
    assert.equal(own.alsoPaused, undefined, 'gamma was never paused');
  });

  test('a main binding imported by the migration is re-stamped, not announced as an import in the worktree', () => {
    const { main, worktree } = layout();
    const cfg = configWith([[main, { vault: 'alpha', also: [], confirmedVia: 'migration', confirmedAt: '2026-01-01' }]]);
    const own = rawBindingEntry(withBinding(cfg, worktree, { ...readBinding(cfg, worktree), primaryTier: { vault: 'alpha', mode: 'locked' } }), worktree);
    assert.equal(own.confirmedVia, 'inherited');
    assert.notEqual(own.confirmedAt, '2026-01-01');
  });

  test('a main entry the router has to repair to read is not inherited', () => {
    const { main, worktree } = layout();
    const cfg = configWith([[main, { vault: 'alpha', also: ['beta', 'beta'] }]]);
    assert.ok(readBinding(cfg, main), 'the main checkout still routes on its repaired reading');
    assert.equal(readBinding(cfg, worktree), null);
    // ...also when the locator answers without consulting the config first.
    assert.equal(readBinding(cfg, worktree, { worktreeMainCheckout: () => main }), null);
  });

  test('an own entry with a deeply nested opaque field: readBinding does not throw', () => {
    const { worktree } = layout();
    let deep = {};
    for (let i = 0; i < 20000; i += 1) deep = { d: deep };
    const cfg = configWith([[worktree, { vault: 'alpha', also: [], note: deep }]]);
    assert.equal(readBinding(cfg, worktree).vault, 'alpha');
  });

  test('clear with no own entry writes NOTHING (not even the migration record)', async () => {
    const { main, worktree } = layout();
    const { file, seamFor } = disk([[main, MAIN_ENTRY]]);
    const before = JSON.stringify(file.config);
    const out = await confirmWorkspaceBinding(registryOf({ workspaceBinding: readBinding(file.config, worktree) }), { clear: true }, seamFor(worktree));
    assert.equal(out.cleared, false);
    assert.equal(file.writes, 0);
    assert.equal(JSON.stringify(file.config), before);
  });

  test('clear never displaces a lock this session chose with lock_vault', async () => {
    const { main, worktree } = layout();
    const { file, seamFor } = disk([[main, { vault: 'dedibox', also: ['stacks'], locked: true }], [worktree, { vault: 'router', also: [] }]]);
    const reg = registryOf({
      workspaceBinding: readBinding(file.config, worktree),
      lockedVault: 'stacks',
      lockSource: { origin: 'runtime', variable: null },
    });
    const out = await confirmWorkspaceBinding(reg, { clear: true }, seamFor(worktree));
    assert.equal(reg.lockedVault, 'stacks');
    assert.equal(reg.lockSource.origin, 'runtime');
    assert.match(out.message, /own lock_vault call/);
    assert.doesNotMatch(out.message, /no longer bound/);
  });

  test('the sharing guard: a live worktree after many stale registrations is still counted; a stale one is not', () => {
    const { main, worktree } = layout();
    // 70 stale registrations sorted before the live one.
    for (let i = 0; i < 70; i += 1) {
      const admin = path.join(main, '.git', 'worktrees', `aaa-stale-${i}`);
      fs.mkdirSync(admin, { recursive: true });
      fs.writeFileSync(path.join(admin, 'gitdir'), `${path.join(TMP, 'gone', String(i), '.git')}\n`);
    }
    // A reused folder: registered, exists, but its .git is gone — the forward rule fails.
    const reused = path.join(TMP, `reused-${counter}`);
    fs.mkdirSync(reused, { recursive: true });
    const admin = path.join(main, '.git', 'worktrees', 'reused');
    fs.mkdirSync(admin, { recursive: true });
    fs.writeFileSync(path.join(admin, 'gitdir'), `${path.join(reused, '.git')}\n`);
    const cfg = configWith([[main, { vault: 'dedibox', also: [] }]]);
    assert.deepEqual(workspacesDeclaring('dedibox', cfg).sort(), [canonicalWorkspaceKey(main), canonicalWorkspaceKey(worktree)].sort());
  });

  test('a worktree listing that exists but cannot be read is "incomplete", and the guard then requires a precondition', () => {
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    assert.deepEqual(linkedWorktreesOf('/x', { readdir: () => { throw denied; } }), { dirs: [], complete: false });
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    assert.deepEqual(linkedWorktreesOf('/x', { readdir: () => { throw missing; } }), { dirs: [], complete: true });
  });

});

describe('review round 3 — the repairs of round 2, attacked', () => {
  test('bare: git\'s comment and integer syntax; a value git accepts but we cannot place counts as bare', () => {
    for (const v of ['true#comment', 'true ;c', '+1', '0x1', '1k', '2G']) {
      assert.equal(isBareConfig(`[core]\n\tbare = ${v}\n`), true, v);
    }
    for (const v of ['0', '0x0', '-0', '""', 'off']) {
      assert.equal(isBareConfig(`[core]\n\tbare = ${v}\n`), false, v);
    }
    assert.equal(isBareConfig('[core]\n\tbare = maybe\n'), true, 'undetermined fails closed');
  });

  test('git\'s common directory must be the approved checkout\'s own .git, not a sibling spelled differently', () => {
    const { worktree, main, admin } = layout();
    // The pointer is spelled through `.GIT`; physically (identity realpath, as a
    // case-sensitive directory would answer) that is not `<main>/.git`.
    const spelled = admin.replace(`${path.sep}.git${path.sep}`, `${path.sep}.GIT${path.sep}`);
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${spelled}\n`);
    const identity = (p) => path.resolve(p);
    assert.equal(worktreeMainCheckout(worktree, { realpath: identity }), null);
    // Control: the genuine spelling under the same identity realpath still resolves.
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${admin}\n`);
    assert.equal(canonicalWorkspaceKey(worktreeMainCheckout(worktree, { realpath: identity })), canonicalWorkspaceKey(main));
  });

  test('a main entry whose primary tier cannot be read is not inherited (its fail-closed reading would be persisted)', () => {
    const { main, worktree } = layout();
    for (const primaryTier of ['broken', null, { vault: 'alpha', mode: 'weird' }, { mode: 'locked' }]) {
      const cfg = configWith([[main, { vault: 'alpha', also: [], primaryTier }]]);
      assert.equal(readBinding(cfg, worktree), null, JSON.stringify(primaryTier));
      assert.equal(readBinding(cfg, worktree, { worktreeMainCheckout: () => main }), null, `${JSON.stringify(primaryTier)} (locator bypassing accept)`);
    }
    // A tier that names ANOTHER vault is stale, not unreadable: inheritance proceeds without it.
    const stale = configWith([[main, { vault: 'alpha', also: [], primaryTier: { vault: 'beta', mode: 'locked' } }]]);
    assert.equal(readBinding(stale, worktree).primaryTier, undefined);
  });

  test('set_primary_vault_mode: the live binding takes the file\'s re-stamped provenance', async () => {
    const { main, worktree } = layout();
    const { file, seamFor } = disk([[main, { vault: 'dedibox', also: [], confirmedVia: 'migration', confirmedAt: '2026-01-01' }]]);
    const reg = registryOf({ workspaceBinding: readBinding(file.config, worktree) });
    await setPrimaryVaultMode(reg, { vault: 'dedibox', mode: 'locked' }, seamFor(worktree));
    assert.equal(rawBindingEntry(file.config, worktree).confirmedVia, 'inherited');
    assert.equal(reg.workspaceBinding.confirmedVia, 'inherited');
    assert.notEqual(reg.workspaceBinding.confirmedAt, '2026-01-01');
  });

  test('the sharing guard resolves a relative stored key the way the forward lookup does', () => {
    const { main, worktree, base } = layout();
    const cfg = { [WORKSPACE_BINDINGS_KEY]: { [path.relative(base, main)]: { vault: 'dedibox', also: [] } } };
    const before = process.cwd();
    process.chdir(base);
    try {
      assert.equal(readBinding(cfg, worktree)?.vault, 'dedibox', 'the forward lookup resolves the relative key');
      assert.ok(workspacesDeclaring('dedibox', cfg).includes(canonicalWorkspaceKey(worktree)), 'and so does the guard');
    } finally {
      process.chdir(before);
    }
  });

  test('the sharing guard follows a registered location that is a link to the moved worktree', (t) => {
    const { main, worktree, admin, base } = layout({ insideMain: false });
    const moved = path.join(base, 'moved-here');
    fs.renameSync(worktree, moved);
    try {
      fs.symlinkSync(moved, worktree, 'junction');
    } catch (err) {
      t.skip(`this account cannot create a directory link here (${err.code})`);
      return;
    }
    assert.ok(fs.existsSync(path.join(admin, 'gitdir')));
    const cfg = configWith([[main, { vault: 'dedibox', also: [] }]]);
    const writers = workspacesDeclaring('dedibox', cfg);
    assert.ok(writers.includes(canonicalWorkspaceKey(fs.realpathSync.native(moved))), 'the moved worktree is still a writer, at its physical place');
    assert.ok(writers.length >= 2);
  });

  test('the briefing sends a stale INHERITED primary to the main checkout, not to a clear that clears nothing', () => {
    const out = composeBriefing({
      binding: { vault: 'gone', also: [], locked: false, inheritedFrom: 'C:/work/Repo' },
      registeredCount: 2,
      isRegistered: (n) => n !== 'gone',
    });
    assert.match(out, /Repair the binding of its main checkout/);
    assert.doesNotMatch(out, /clear it with/);
  });
});

describe('review round 4 — the repairs of round 3, attacked', () => {
  test('bare: a variable on the header\'s own line, and a quoted value git does not trim', () => {
    assert.equal(isBareConfig('[core] bare = true\n'), true);
    assert.equal(isBareConfig('[core]\n\tbare = " false "\n'), true, 'git rejects it: undetermined, fails closed');
    assert.equal(isBareConfig('[core]\n\tbare = "false"\n'), false);
    assert.equal(isBareConfig('[core]\n\tbare = false # kept\n'), false);
  });

  test('a main repository made bare in config.worktree has no main checkout; an unreadable one fails closed', () => {
    const { main, worktree } = layout();
    fs.writeFileSync(path.join(main, '.git', 'config.worktree'), '[core]\n\tbare = true\n');
    assert.equal(worktreeMainCheckout(worktree), null);
    fs.writeFileSync(path.join(main, '.git', 'config.worktree'), '[core]\n\tbare = false\n');
    assert.equal(canonicalWorkspaceKey(worktreeMainCheckout(worktree)), canonicalWorkspaceKey(main));
    fs.rmSync(path.join(main, '.git', 'config.worktree'));
    fs.mkdirSync(path.join(main, '.git', 'config.worktree'));
    assert.equal(worktreeMainCheckout(worktree), null, 'present but not a readable file');
  });

  test('the sharing guard counts an inheriting worktree only toward the vaults it really inherits', () => {
    const { main, worktree } = layout();
    // A second spelling of the main checkout (a hand edit) bound elsewhere: the reader
    // selects the canonical entry, so the worktree inherits dedibox, never router.
    const alias = `${canonicalWorkspaceKey(main)}${path.sep}`;
    const cfg = { [WORKSPACE_BINDINGS_KEY]: {
      [canonicalWorkspaceKey(main)]: { vault: 'dedibox', also: [] },
      [alias]: { vault: 'router', also: [] },
    } };
    assert.equal(readBinding(cfg, worktree).vault, 'dedibox');
    assert.ok(workspacesDeclaring('dedibox', cfg).includes(canonicalWorkspaceKey(worktree)));
    assert.equal(workspacesDeclaring('router', cfg).includes(canonicalWorkspaceKey(worktree)), false);
  });

  test('set_primary_vault_mode on an OWN binding leaves the live provenance alone', async () => {
    const { worktree } = layout();
    const { file, seamFor } = disk([[worktree, { vault: 'dedibox', also: [], confirmedVia: 'tool', confirmedAt: '2026-11-19' }]]);
    const reg = registryOf({ workspaceBinding: { ...readBinding(file.config, worktree), confirmedVia: 'live-copy' } });
    await setPrimaryVaultMode(reg, { vault: 'dedibox', mode: 'locked' }, seamFor(worktree));
    assert.equal(reg.workspaceBinding.confirmedVia, 'live-copy');
  });
});

describe('Fable 5.2 review — the sentences and the guard', () => {
  test('refusing an inherited primary does not send the user to a clear that clears nothing', async () => {
    const { main, worktree } = layout();
    const { seamFor, file } = disk([[main, { vault: 'dedibox', also: [] }]]);
    await assert.rejects(
      confirmWorkspaceBinding(registryOf({ workspaceBinding: readBinding(file.config, worktree) }), { refuse: 'dedibox' }, seamFor(worktree)),
      (err) => /inherits "dedibox" as its primary/.test(err.message) && !/Clear the binding first/.test(err.message),
    );
  });

  test('clearing into an inherited binding whose primary this session does not hold says it is ignored', async () => {
    const { main, worktree } = layout();
    const { file, seamFor } = disk([[main, { vault: 'ghost', also: [] }], [worktree, { vault: 'router', also: [] }]]);
    const reg = registryOf({ workspaceBinding: readBinding(file.config, worktree) });
    const out = await confirmWorkspaceBinding(reg, { clear: true }, seamFor(worktree));
    assert.match(out.message, /That primary is not a vault this session holds, so it is ignored here/);
  });

  test('the sharing guard: a listing that cannot be read in full adds a writer, so a precondition is required', () => {
    const { main } = layout();
    const cfg = configWith([[main, { vault: 'dedibox', also: [] }]]);
    const writers = workspacesDeclaring('dedibox', cfg, { listWorktrees: () => ({ dirs: [], complete: false }) });
    assert.equal(writers.length, 2, 'the main checkout, and an unknown writer');
    assert.ok(writers.some((w) => /linked worktrees unreadable/.test(w)));
    assert.deepEqual(workspacesDeclaring('dedibox', cfg, { listWorktrees: () => ({ dirs: [], complete: true }) }), [canonicalWorkspaceKey(main)]);
  });

});
