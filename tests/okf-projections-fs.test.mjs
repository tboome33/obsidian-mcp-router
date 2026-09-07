/**
 * Disk-side projections (helper + fleet CLI) — volet ② v0.59.0.
 * The pure grammar is covered by okf-projections.test.mjs; here we pin the
 * FILESYSTEM behaviours: idempotence on disk, conflict preservation, ghost
 * `wiki/sessions/` tidying, and the CLI's dry-run/apply/exit-code contract.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { generateProjectionsOnDisk } from '../src/helpers/okf-projections-fs.mjs';
import {
  projectionMarkerLine,
  buildProjections,
  planProjectionWrites,
  isProjectionPath,
  isWikiContentPath,
} from '../src/helpers/okf-projections.mjs';
import { parseFrontmatter } from '../src/helpers/llms-txt-exporter.mjs';
import { defaultNameFromPath } from '../src/helpers/vault-slug.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'scripts', 'okf-projections.mjs');

let tmpRoot;
before(() => { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-proj-fs-')); });
after(() => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ } });

let seq = 0;
function makeVaultNamed(dirName, files = {}) {
  const vp = path.join(tmpRoot, dirName);
  fs.mkdirSync(vp, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(vp, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return vp;
}
function makeVault(files = {}) {
  return makeVaultNamed(`v${seq++}`, files);
}

/** The `# Title` of a generated root index. */
const rootTitle = (vaultPath) =>
  (fs.readFileSync(path.join(vaultPath, 'wiki', 'index.md'), 'utf8').match(/^# (.+)$/m) || [])[1];

const PAGE = (title) =>
  `---\ntype: note\ntitle: "${title}"\ndescription: "Desc"\ncreated: 2026-07-01\n---\n\nCorps.\n`;

describe('generateProjectionsOnDisk', () => {
  test('dry-run plans but writes nothing; apply writes; re-apply is a no-op', () => {
    const vp = makeVault({ 'wiki/a/page.md': PAGE('Page') });
    const dry = generateProjectionsOnDisk(vp, { now: '2026-07-30' });
    assert.equal(dry.written.length, 3);
    assert.equal(fs.existsSync(path.join(vp, 'wiki', 'index.md')), false, 'dry-run must not write');

    const applied = generateProjectionsOnDisk(vp, { apply: true, now: '2026-07-30' });
    assert.equal(applied.written.length, 3);
    assert.ok(fs.existsSync(path.join(vp, 'wiki', 'index.md')));
    assert.ok(fs.existsSync(path.join(vp, 'wiki', 'a', 'index.md')));
    assert.ok(fs.existsSync(path.join(vp, 'wiki', 'log.md')));

    const again = generateProjectionsOnDisk(vp, { apply: true, now: '2026-07-30' });
    assert.equal(again.written.length, 0, 'idempotent');
    assert.equal(again.unchanged, 3);
  });

  test('an unmarked homonym on disk is preserved and reported', () => {
    const vp = makeVault({
      'wiki/a/page.md': PAGE('Page'),
      'wiki/a/index.md': '# Le mien\n',
    });
    const r = generateProjectionsOnDisk(vp, { apply: true, now: '2026-07-30' });
    assert.deepEqual(r.conflicts, ['wiki/a/index.md']);
    assert.equal(fs.readFileSync(path.join(vp, 'wiki', 'a', 'index.md'), 'utf8'), '# Le mien\n');
  });

  test('a stale marked index on disk is deleted when its directory empties', () => {
    const vp = makeVault({
      'wiki/a/page.md': PAGE('Page'),
      'wiki/vieux/index.md': `# Vieux\n\n${projectionMarkerLine()}\n`,
    });
    const r = generateProjectionsOnDisk(vp, { apply: true, now: '2026-07-30' });
    assert.deepEqual(r.deleted, ['wiki/vieux/index.md']);
    assert.equal(fs.existsSync(path.join(vp, 'wiki', 'vieux', 'index.md')), false);
  });
});

// ---------------------------------------------------------------------------
// The root-index TITLE must not depend on WHICH entry point generated it.
//
// Two generators produce the same projections: this disk helper (fleet CLI,
// setup-vault) and the `refresh_okf_projections` tool over REST. The tool names
// the vault `vault.name` — the REGISTRY slug. The helper used to default to
// `path.basename(vaultPath)` — the ON-DISK case. On any vault whose folder is
// not already the slug, the two wrote different `# Title` lines and each run
// undid the other, so `okf-projections --all-vaults` reported a phantom
// `1 written` forever. Measured on the fleet: 18 of 24 vaults.
//
// F2 in vault-birth-conformance.test.mjs closed this for setup-vault by fixing
// the CALLER. The helper default stayed wrong, so the fleet CLI kept falling in
// — the same class defect, one site further. These tests pin the DEFAULT.
// ---------------------------------------------------------------------------

describe('the vault title does not depend on which entry point wrote it', () => {
  test('with no explicit name the H1 is the registry default, not the on-disk case', () => {
    const vp = makeVaultNamed('MixedCaseVault', { 'wiki/a/page.md': PAGE('Page') });
    generateProjectionsOnDisk(vp, { apply: true, now: '2026-07-30' });

    assert.equal(rootTitle(vp), defaultNameFromPath(vp), 'H1 must be the slug the registry resolves');
    assert.notEqual(rootTitle(vp), path.basename(vp), 'the on-disk case must not leak into the title');
  });

  test('a leading-dot vault (.template) is titled like the registry names it', () => {
    const vp = makeVaultNamed('.TemplateLike', { 'wiki/a/page.md': PAGE('Page') });
    generateProjectionsOnDisk(vp, { apply: true, now: '2026-07-30' });
    // defaultNameFromPath strips the dot AND lowercases: `templatelike`.
    assert.equal(rootTitle(vp), 'templatelike');
  });

  // Runs the REST tool's OWN code path over the disk generator's output, rather
  // than calling the disk generator twice with a different name: a first draft
  // did the latter, and an adversarial review pointed out that it proved only
  // that the name argument works — any REST-side difference would have gone
  // unseen. `refresh_okf_projections` does exactly `buildProjections({pages,
  // vaultName: vault.name, now})` then `planProjectionWrites({generated,
  // current})`; both are reproduced here verbatim, transport aside.
  test('the REST tool, run over what the disk wrote, plans ZERO writes', () => {
    const vp = makeVaultNamed('AnotherMixedCase', { 'wiki/a/page.md': PAGE('Page') });
    generateProjectionsOnDisk(vp, { apply: true, now: '2026-07-30' });

    // Re-read the vault the way the tool does: content pages in, existing
    // projections as `current`.
    const pages = [];
    const current = new Map();
    const walk = (rel) => {
      for (const e of fs.readdirSync(path.join(vp, 'wiki', rel), { withFileTypes: true })) {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { walk(childRel); continue; }
        if (!/\.md$/i.test(e.name)) continue;
        const vaultRel = `wiki/${childRel}`;
        const raw = fs.readFileSync(path.join(vp, 'wiki', childRel), 'utf8');
        if (isProjectionPath(vaultRel)) current.set(vaultRel, raw);
        else if (isWikiContentPath(vaultRel)) {
          const { frontmatter, body } = parseFrontmatter(raw);
          pages.push({ path: vaultRel, frontmatter, body });
        }
      }
    };
    walk('');

    // `vault.name` for a vault with no vaultNames override IS defaultNameFromPath.
    const { files } = buildProjections({ pages, vaultName: defaultNameFromPath(vp), now: '2026-07-30' });
    const plan = planProjectionWrites({ generated: files, current });

    assert.deepEqual(plan.writes, [], 'the REST refresh must not rewrite what disk generation just wrote');
    assert.deepEqual(plan.deletes, [], 'nor delete any of it');
    assert.equal(plan.conflicts.length, 0);
  });

  test('an explicit name still wins — setup-vault passes the slug it computed', () => {
    const vp = makeVaultNamed('ExplicitlyNamed', { 'wiki/a/page.md': PAGE('Page') });
    generateProjectionsOnDisk(vp, { apply: true, now: '2026-07-30', vaultName: 'chosen-name' });
    assert.equal(rootTitle(vp), 'chosen-name');
  });
});

describe('okf-projections CLI', () => {
  const run = (...argv) => {
    const r = spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };

  test('dry-run reports and touches nothing; apply initialises; exit 0', () => {
    const vp = makeVault({ 'wiki/a/page.md': PAGE('Page'), 'wiki/sessions/.gitkeep': '' });
    // remove the .gitkeep so the ghost dir is truly empty
    fs.unlinkSync(path.join(vp, 'wiki', 'sessions', '.gitkeep'));

    const dry = run('--vault', vp);
    assert.equal(dry.code, 0);
    assert.match(dry.out, /3 written/);
    assert.match(dry.out, /Dry-run only/);
    assert.equal(fs.existsSync(path.join(vp, 'wiki', 'index.md')), false);
    assert.ok(fs.existsSync(path.join(vp, 'wiki', 'sessions')), 'dry-run must not tidy the ghost');

    const apply = run('--vault', vp, '--apply');
    assert.equal(apply.code, 0);
    assert.ok(fs.existsSync(path.join(vp, 'wiki', 'index.md')));
    assert.equal(fs.existsSync(path.join(vp, 'wiki', 'sessions')), false, 'empty ghost dir removed');
  });

  test('a NON-empty wiki/sessions/ is never removed', () => {
    const vp = makeVault({
      'wiki/a/page.md': PAGE('Page'),
      'wiki/sessions/note.md': '# une vraie note\n',
    });
    assert.equal(run('--vault', vp, '--apply').code, 0);
    assert.ok(fs.existsSync(path.join(vp, 'wiki', 'sessions', 'note.md')));
  });

  test('conflicts drive a non-zero exit and name the file', () => {
    const vp = makeVault({
      'wiki/a/page.md': PAGE('Page'),
      'wiki/index.md': '# Index écrit main\n',
    });
    const r = run('--vault', vp, '--apply');
    assert.equal(r.code, 1);
    assert.match(r.out, /conflict \(unmarked file, untouched\): wiki\/index\.md/);
    assert.equal(fs.readFileSync(path.join(vp, 'wiki', 'index.md'), 'utf8'), '# Index écrit main\n');
  });

  test('a vault without wiki/ is reported no-wiki, not failed', () => {
    const vp = makeVault({ 'notes/x.md': '# x\n' });
    const r = run('--vault', vp, '--apply');
    assert.equal(r.code, 0);
    assert.match(r.out, /no-wiki/);
  });

  test('--all-vaults reads portRegistry; bad usage exits 1', () => {
    const vp = makeVault({ 'wiki/a/page.md': PAGE('Page') });
    const cfg = path.join(tmpRoot, `cfg-${seq}.json`);
    fs.writeFileSync(cfg, JSON.stringify({ portRegistry: { [vp]: 27124 } }), 'utf8');
    const r = spawnSync(process.execPath, [CLI, '--all-vaults', '--apply'], {
      encoding: 'utf8', env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: cfg },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(vp, 'wiki', 'index.md')));

    assert.equal(run().code, 1);
    assert.equal(run('--vault').code, 1);
  });

  // THE regression this whole block exists for — and it needs ALTERNATING
  // entry points to show. A first draft ran the CLI twice and passed against
  // the OLD code too (both passes agreed with each other on the basename), which
  // an adversarial review called out: a test that cannot fail is worse than no
  // test. So the REST side writes first, then the CLI must find nothing to do.
  // That is the real fleet situation: the tool refreshes during a session, the
  // checker runs afterwards, and the checker used to report a phantom
  // `1 written` forever — training the reader to ignore a release signal.
  test('after the REST tool has written, the CLI plans NOTHING on a mixed-case vault', () => {
    const vp = makeVaultNamed('FleetMixedCase', { 'wiki/a/page.md': PAGE('Page') });

    // Stand in for `refresh_okf_projections`: same generator, `vault.name`.
    generateProjectionsOnDisk(vp, { apply: true, vaultName: defaultNameFromPath(vp) });

    const cli = run('--vault', vp, '--apply');
    assert.equal(cli.code, 0);
    assert.match(cli.out, /0 written/, 'the CLI must not undo what the REST tool just wrote');
  });

  test('and the reverse order converges too — CLI first, then the REST tool', () => {
    const vp = makeVaultNamed('FleetMixedCase2', { 'wiki/a/page.md': PAGE('Page') });
    assert.equal(run('--vault', vp, '--apply').code, 0);

    const asRest = generateProjectionsOnDisk(vp, {
      apply: true, vaultName: defaultNameFromPath(vp),
    });
    assert.deepEqual(asRest.written, [], 'the REST tool must not undo what the CLI just wrote');
  });

  test('a configured vaultNames override decides the title, not the folder name', () => {
    const vp = makeVaultNamed('OverriddenFolder', { 'wiki/a/page.md': PAGE('Page') });
    const cfg = path.join(tmpRoot, `cfg-override-${seq++}.json`);
    fs.writeFileSync(cfg, JSON.stringify({
      portRegistry: { [vp]: { https: 27500, http: 27600 } },
      vaultNames: { [vp]: 'DEDIBOX-LIKE' },
    }), 'utf8');

    const r = spawnSync(process.execPath, [CLI, '--all-vaults', '--apply'], {
      encoding: 'utf8', env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: cfg },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(rootTitle(vp), 'DEDIBOX-LIKE', 'the registry name wins over the directory basename');
  });

  // ASK THE DISK, DO NOT ASSUME THE OS. The CI matrix runs ubuntu AND windows,
  // and a first draft of the test below spelled the vault path in another case
  // and expected it to resolve — true on NTFS, a non-existent path on ext4,
  // which would have failed only on the Linux leg. Same class as the `i:\x`
  // fixture that broke CI before. So the fixture measures the filesystem it is
  // actually running on and the two cases are asserted separately.
  //
  // Evaluated LAZILY, inside each test, never in the describe body: `tmpRoot`
  // is assigned by a top-level `before`, and whether that hook runs before a
  // describe callback is a property of the test runner, not of this file. It
  // does on the Node this was written against (measured), but CI runs Node 20
  // AND 22 and the suite must not depend on the answer.
  let caseInsensitiveFsCache;
  const caseInsensitiveFs = () => {
    if (caseInsensitiveFsCache === undefined) {
      try {
        const probe = path.join(tmpRoot, 'CaseProbeDir');
        fs.mkdirSync(probe, { recursive: true });
        caseInsensitiveFsCache = fs.existsSync(probe.toLowerCase());
      } catch {
        caseInsensitiveFsCache = false;
      }
    }
    return caseInsensitiveFsCache;
  };

  test('--vault finds the override even spelled in another case (case-insensitive filesystems)', (t) => {
    if (!caseInsensitiveFs()) return t.skip('filesystem is case-sensitive — the alias is a different path');
    const vp = makeVaultNamed('CaseDifferentKey', { 'wiki/a/page.md': PAGE('Page') });
    const cfg = path.join(tmpRoot, `cfg-case-${seq++}.json`);
    fs.writeFileSync(cfg, JSON.stringify({
      portRegistry: { [vp]: { https: 27501, http: 27601 } },
      vaultNames: { [vp]: 'named-by-config' },
    }), 'utf8');

    const r = spawnSync(process.execPath, [CLI, '--vault', vp.toLowerCase(), '--apply'], {
      encoding: 'utf8', env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: cfg },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(rootTitle(vp), 'named-by-config');
  });

  test('on a CASE-SENSITIVE filesystem a same-spelling-different-case key is NOT this vault', (t) => {
    if (caseInsensitiveFs()) return t.skip('filesystem folds case — the two paths are one directory');
    // The reviewer's exact counterexample: `Foo` is registered as `alpha`, and
    // `foo` is a DIFFERENT, existing, unregistered directory. Exactly one key
    // folds onto it lexically — and it must still NOT inherit `alpha`.
    const registered = makeVaultNamed('FoldFoo', { 'wiki/a/page.md': PAGE('Page') });
    const other = makeVaultNamed('foldfoo', { 'wiki/a/page.md': PAGE('Page') });
    const cfg = path.join(tmpRoot, `cfg-sens-${seq++}.json`);
    fs.writeFileSync(cfg, JSON.stringify({
      portRegistry: { [registered]: { https: 27504, http: 27604 } },
      vaultNames: { [registered]: 'alpha' },
    }), 'utf8');

    const r = spawnSync(process.execPath, [CLI, '--vault', other, '--apply'], {
      encoding: 'utf8', env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: cfg },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.notEqual(rootTitle(other), 'alpha', 'a different directory must never inherit another vault\'s name');
    assert.equal(rootTitle(other), defaultNameFromPath(other));
  });

  test('an ambiguous match does not leak an override through the fallback path', () => {
    // The third review round's finding: returning the PATH on ambiguity looked
    // safe, but the path was itself a registered key, so the override came back
    // through the front door. Registers the literal vault path as `alpha` AND a
    // trailing-dot spelling of it as `beta` — both resolve to the same
    // directory, so neither may win.
    const vp = makeVaultNamed('AmbiguousLiteralKey', { 'wiki/a/page.md': PAGE('Page') });
    const cfg = path.join(tmpRoot, `cfg-literal-${seq++}.json`);
    fs.writeFileSync(cfg, JSON.stringify({
      portRegistry: {
        [vp]: { https: 27505, http: 27605 },
        [`${vp}${path.sep}.`]: { https: 27506, http: 27606 },
      },
      vaultNames: { [vp]: 'alpha', [`${vp}${path.sep}.`]: 'beta' },
    }), 'utf8');

    const r = spawnSync(process.execPath, [CLI, '--vault', vp, '--apply'], {
      encoding: 'utf8', env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: cfg },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(rootTitle(vp), defaultNameFromPath(vp), 'ambiguity must reach the path default, not an override');
  });

  test('an AMBIGUOUS match refuses to guess and falls back to the path default', () => {
    // Two registry keys resolving to one directory make the override a guess,
    // and a guess here writes one vault's name into another's wiki.
    const vp = makeVaultNamed('AmbiguousFold', { 'wiki/a/page.md': PAGE('Page') });
    const cfg = path.join(tmpRoot, `cfg-ambig-${seq++}.json`);
    fs.writeFileSync(cfg, JSON.stringify({
      portRegistry: {
        [`${vp}${path.sep}.`]: { https: 27502, http: 27602 },
        [`${path.dirname(vp)}${path.sep}.${path.sep}${path.basename(vp)}`]: { https: 27503, http: 27603 },
      },
      vaultNames: {
        [`${vp}${path.sep}.`]: 'alpha',
        [`${path.dirname(vp)}${path.sep}.${path.sep}${path.basename(vp)}`]: 'beta',
      },
    }), 'utf8');

    const r = spawnSync(process.execPath, [CLI, '--vault', vp, '--apply'], {
      encoding: 'utf8', env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: cfg },
    });
    assert.equal(r.status, 0, r.stderr);
    const title = rootTitle(vp);
    assert.notEqual(title, 'alpha', 'must not pick one of two candidates');
    assert.notEqual(title, 'beta', 'must not pick the other either');
    assert.equal(title, defaultNameFromPath(vp), 'it falls back to the path-derived default');
  });
});
