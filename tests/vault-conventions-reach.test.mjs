/**
 * A vault's conventions reach the session that writes into it — and the fleet
 * can say which conventions each vault is really under.
 *
 * Built from the 2026-09-26 incident, in which three things went wrong at once:
 *
 *   1. A diagnosis read the reference vault's own `CLAUDE.md.bak-*` files —
 *      copied into Kiviri-OS with its `Documentation/` folder — as Kiviri-OS's
 *      history, and concluded that four conventions had been LOST there. The
 *      fixture under tests/fixtures/kiviri-os-documentation/ is those four
 *      real files (private identifiers replaced; see its README), and the audit
 *      must call them inherited, not evidence of a loss.
 *   2. A session wrote decision pages all night without `status`, the required
 *      H2 sections or `source_type`, because no write tool ever mentioned the
 *      contract. The briefing and the page checks are exercised below.
 *   3. No plugin hook ran, and nothing said so. The heartbeat is exercised
 *      below, including by spawning the real hook.
 *
 * Nothing here touches a real vault or a real home: temp directories, a
 * throwaway HOME, and fake REST functions.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isBackupName, makeRootDocsFilter, existingConventionsFiles } from '../src/helpers/root-docs-filter.mjs';
import { auditVaultConventions, backupKey, sha256Text, RECOMMENDED_CONVENTION_IDS } from '../src/helpers/conventions-audit.mjs';
import { loadConventionCatalogue } from '../src/helpers/convention-catalogue.mjs';
import { checkWrittenPage } from '../src/helpers/write-time-page-checks.mjs';
import { createConventionsBriefing, readVaultConventionsOverRest, buildConventionsBrief } from '../src/tools/vault-conventions.mjs';
import {
  recordHookHeartbeat, readHookHeartbeat, sessionHooksStatus, heartbeatPath,
} from '../src/helpers/hooks-heartbeat.mjs';
import { describeRunningBuild, fingerprintFromEntries, gitBlobId, normaliseEol, underFingerprintRoots } from '../src/helpers/build-identity.mjs';
import { homeSafeEnv } from './_home-safe-spawn.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'kiviri-os-documentation');
const BAKS = [
  'CLAUDE.md.bak-decision-conventions-2026-09-11-160724',
  'CLAUDE.md.bak-default-vault-health-check-2026-09-11-1700',
  'CLAUDE.md.bak-wiki-query-first-2026-09-11-1730',
];

const { catalogue } = loadConventionCatalogue();
const read = (f) => fs.readFileSync(path.join(FIXTURE, f), 'utf8');

/** The Kiviri-OS state of 2026-09-26: Documentation/ is the reference vault's, byte for byte. */
function kiviriState() {
  const candidates = [{ path: 'Documentation/CLAUDE.md', content: read('CLAUDE.md') }];
  const backups = BAKS.map((b) => ({ path: `Documentation/${b}`, sha256: sha256Text(read(b)) }));
  const referenceFingerprints = new Set([sha256Text(read('CLAUDE.md')), ...BAKS.map((b) => sha256Text(read(b)))]);
  const referenceBackups = BAKS.map((b) => backupKey(b, sha256Text(read(b))));
  return { candidates, backups, referenceFingerprints, referenceBackups };
}

describe('backups and conventions files never travel with the reference vault\'s docs', () => {
  test('a backup is recognised by a whole `.bak` segment, nothing looser', () => {
    for (const yes of ['CLAUDE.md.bak', 'CLAUDE.md.bak-2026-09-11', 'CLAUDE.md.bak.1', 'x.BAK-y']) {
      assert.equal(isBackupName(yes), true, yes);
    }
    for (const no of ['CLAUDE.md', 'backlog.md', 'bakery.md', 'CLAUDE.mdbak', 'notes.bakery']) {
      assert.equal(isBackupName(no), false, no);
    }
  });

  test('the filter refuses every backup, whatever the target holds', () => {
    const ref = path.join(os.tmpdir(), 'ref');
    const skipped = [];
    const filter = makeRootDocsFilter({ referenceVault: ref, targetConventions: [], onSkip: (e) => skipped.push(e.relative) });
    assert.equal(filter(path.join(ref, 'Documentation', BAKS[0])), false);
    assert.equal(filter(path.join(ref, 'Documentation', 'SETUP.md')), true);
    assert.deepEqual(skipped, [`Documentation/${BAKS[0]}`]);
  });

  test('a conventions file is copied into a vault that has none, and refused where one exists', () => {
    const ref = path.join(os.tmpdir(), 'ref');
    const src = path.join(ref, 'Documentation', 'CLAUDE.md');
    assert.equal(makeRootDocsFilter({ referenceVault: ref, targetConventions: [] })(src), true, 'a fresh vault gets the template conventions');
    for (const existing of [['CLAUDE.md'], ['wiki-meta/CLAUDE.md'], ['Documentation/CLAUDE.md']]) {
      assert.equal(makeRootDocsFilter({ referenceVault: ref, targetConventions: existing })(src), false, `target already holds ${existing}`);
    }
  });

  test('existingConventionsFiles probes the three candidate locations', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-probe-'));
    try {
      fs.mkdirSync(path.join(root, 'wiki-meta'));
      fs.writeFileSync(path.join(root, 'wiki-meta', 'CLAUDE.md'), '# x');
      assert.deepEqual(existingConventionsFiles(root, fs.existsSync), ['wiki-meta/CLAUDE.md']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the Kiviri-OS reproduction: inherited backups are not a loss', () => {
  test('the fixture is the real shape — the current file carries the four core conventions, the oldest backup eight', () => {
    const ids = (text) => catalogue.filter((c) => new RegExp(`^## ${c.heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(text)).map((c) => c.id).sort();
    assert.deepEqual(ids(read('CLAUDE.md')), ['default-vault-health-check', 'path-disambiguation', 'roadmap-discipline', 'wiki-query-first']);
    assert.equal(ids(read(BAKS[0])).length, 8, 'the pre-decision template carried eight');
  });

  test('the audit names the backups inherited, the file a template copy, and the four as never installed', () => {
    const { candidates, backups, referenceFingerprints, referenceBackups } = kiviriState();
    const a = auditVaultConventions({ vault: 'Kiviri-OS', candidates, backups, referenceFingerprints, referenceBackups, catalogue });
    assert.equal(a.conventionsFile, 'Documentation/CLAUDE.md');
    assert.equal(a.ambiguous, false);
    assert.equal(a.candidates[0].templateCopy, true);
    assert.deepEqual(a.backups.map((b) => b.inherited), [true, true, true]);
    assert.deepEqual(a.missingRecommended.sort(), ['auto-enrichment', 'heading-hierarchy', 'languages', 'source-type']);
    const kinds = a.findings.map((f) => f.kind).sort();
    assert.deepEqual(kinds, ['inherited-backups', 'missing-recommended']);
    const missing = a.findings.find((f) => f.kind === 'missing-recommended');
    assert.match(missing.message, /do not conclude a loss/);
    assert.equal(missing.repair.steps.length, 4);
    assert.ok(missing.repair.steps.every((s) => /conventions install .+ on Kiviri-OS/.test(s.command)), 'reinstalled from the snippet, never from a backup');
    assert.equal(a.verdict, 'attention');
  });

  test('a vault\'s OWN backup of the template\'s text is not inherited — the La méthode LICARES case', () => {
    // Measured on the real fleet, 2026-09-26: LICARES was born from the
    // template (eight conventions), then removed `bilingual` itself, leaving
    // `CLAUDE.md.bak-bilingual-2026-09-11-0034` — whose BYTES are the template's
    // pre-decision file. Bytes alone called it inherited and hid a real edit.
    const { candidates, backups, referenceFingerprints, referenceBackups } = kiviriState();
    const own = { path: 'Documentation/CLAUDE.md.bak-bilingual-2026-09-11-0034', sha256: sha256Text(read(BAKS[0])) };
    const a = auditVaultConventions({
      vault: 'licares', candidates, backups: [...backups, own], referenceFingerprints, referenceBackups, catalogue,
    });
    assert.deepEqual(a.backups.map((b) => b.inherited), [true, true, true, false]);
    assert.match(a.findings.find((f) => f.kind === 'inherited-backups').message, /^3\/4 backups/);
  });

  test('without the reference, "inherited" is UNKNOWN — said, never implied', () => {
    const { candidates, backups } = kiviriState();
    const a = auditVaultConventions({ vault: 'Kiviri-OS', candidates, backups, referenceFingerprints: null, catalogue });
    assert.deepEqual(a.backups.map((b) => b.inherited), [null, null, null]);
    assert.equal(a.candidates[0].templateCopy, null);
    assert.ok(a.findings.some((f) => f.kind === 'reference-unknown'));
    assert.ok(!a.findings.some((f) => f.kind === 'inherited-backups'));
  });

  test('two files, one a template copy: broken, and the repair renames the copy out of the way', () => {
    const own = '# Mine\n\n' + read(BAKS[0]).slice(read(BAKS[0]).indexOf('## Read order'));
    const candidates = [
      { path: 'CLAUDE.md', content: own },
      { path: 'Documentation/CLAUDE.md', content: read('CLAUDE.md') },
    ];
    const { referenceFingerprints } = kiviriState();
    const a = auditVaultConventions({
      vault: 'coursera', candidates, backups: [], referenceFingerprints, catalogue, now: new Date('2026-09-26T12:00:00Z'),
    });
    assert.equal(a.verdict, 'broken');
    assert.equal(a.conventionsFile, null);
    const f = a.findings.find((x) => x.kind === 'ambiguous-conventions-file');
    assert.deepEqual(f.repair.steps, [{
      tool: 'move_file',
      args: {
        vault: 'coursera',
        from: 'Documentation/CLAUDE.md',
        to: 'Documentation/CLAUDE.md.from-template-2026-09-26',
        ifMatch: sha256Text(read('CLAUDE.md')),
      },
    }]);
    // Measured against the file the repair KEEPS: the vault's own eight — the
    // pre-2026-09-26 set, so `bilingual` where `languages` is now recommended.
    // The retired convention is NOT reported for migration yet, and no value
    // is read: while two files exist, none is in force (review finding).
    assert.deepEqual(a.missingRecommended, ['languages']);
    assert.ok(!a.findings.some((x) => x.kind === 'bilingual-to-migrate'));
    assert.equal(a.languages, null);
  });

  test('a template copy beside TWO files of the vault\'s own: no rename, since it would not repair', () => {
    const { referenceFingerprints } = kiviriState();
    const candidates = [
      { path: 'CLAUDE.md', content: '# mine A\n' },
      { path: 'wiki-meta/CLAUDE.md', content: '# mine B\n' },
      { path: 'Documentation/CLAUDE.md', content: read('CLAUDE.md') },
    ];
    const a = auditVaultConventions({ vault: 'v', candidates, backups: [], referenceFingerprints, catalogue });
    const f = a.findings.find((x) => x.kind === 'ambiguous-conventions-file');
    assert.deepEqual(f.repair.steps, []);
    assert.match(f.repair.summary, /No single rename resolves this/);
  });

  test('two files, neither a template copy: no rename is proposed on a guess', () => {
    const candidates = [
      { path: 'CLAUDE.md', content: '## Roadmap discipline — création + maintenance dans le vault courant\n' },
      { path: 'wiki-meta/CLAUDE.md', content: '# other\n' },
    ];
    const a = auditVaultConventions({ vault: 'v', candidates, backups: [], referenceFingerprints: new Set(), catalogue });
    const f = a.findings.find((x) => x.kind === 'ambiguous-conventions-file');
    assert.deepEqual(f.repair.steps, []);
    assert.match(f.repair.summary, /ask the user/);
  });

  test('no conventions file: every recommended convention is missing and the picker is proposed', () => {
    const a = auditVaultConventions({ vault: 'v', candidates: [], backups: [], referenceFingerprints: new Set(), catalogue });
    assert.equal(a.verdict, 'attention');
    assert.deepEqual(a.missingRecommended, RECOMMENDED_CONVENTION_IDS.filter((id) => catalogue.some((c) => c.id === id)));
    assert.ok(a.findings.some((f) => f.kind === 'no-conventions-file'));
  });
});

describe('a decision page is checked as it is written', () => {
  const page = (fm, body) => `---\n${fm}\n---\n\n# T\n\n${body}\n`;
  const FULL_BODY = '## Context\n\nc\n\n## Decision\n\nd\n\n## Consequences\n\nq\n\n## Alternatives considered\n\nNo serious alternative: fixed by a licence.\n';

  test('the night of 2026-09-25: no status, no sections, no source_type', () => {
    const r = checkWrittenPage({ path: 'wiki/d.md', content: page('type: decision\ntitle: x', 'Some text.'), vaultHasSourceType: true });
    const rules = r.findings.map((f) => f.rule).sort();
    for (const want of ['status-missing', 'section-missing-context', 'section-missing-decision', 'section-missing-consequences', 'alternatives-missing', 'description-missing', 'source-type-missing', 'scope-missing']) {
      assert.ok(rules.includes(want), `expected ${want} in ${rules}`);
    }
    assert.equal(r.findings.find((f) => f.rule === 'source-type-missing').severity, 'warning');
  });

  test('a complete page yields nothing', () => {
    const r = checkWrittenPage({
      path: 'wiki/d.md',
      content: page('type: decision\nstatus: proposed\nscope: here\ndescription: One line.\nsource_type: inferred', FULL_BODY),
      vaultHasSourceType: true,
    });
    assert.deepEqual(r.findings, []);
  });

  test('an invalid status is named with its migration', () => {
    const r = checkWrittenPage({ path: 'd.md', content: page('type: adr\nstatus: decided\nscope: s\ndescription: d\nsource_type: stated', FULL_BODY) });
    const f = r.findings.find((x) => x.rule === 'status-invalid');
    assert.ok(f, JSON.stringify(r.findings));
    assert.match(f.detail, /accepted/);
  });

  test('bilingual decorated headings count; a heading inside a code fence does not', () => {
    const body = '## Contexte · Context\n\nc\n\n## Décision · Decision\n\nd\n\n## Conséquences · Consequences\n\nq\n\n## Alternatives envisagées\n\nAucune.\n';
    const ok = checkWrittenPage({ path: 'd.md', content: page('type: decision\nstatus: proposed\nscope: s\ndescription: d\nsource_type: stated', body) });
    assert.deepEqual(ok.findings, []);
    const fenced = '```\n## Context\n```\n\n## Decision\n\nd\n\n## Consequences\n\nq\n\n## Alternatives considered\n\nNone.\n';
    const bad = checkWrittenPage({ path: 'd.md', content: page('type: decision\nstatus: proposed\nscope: s\ndescription: d\nsource_type: stated', fenced) });
    assert.deepEqual(bad.findings.map((f) => f.rule), ['section-missing-context']);
  });

  test('a label that merely CONTAINS a section word does not count — "## Decision context" is neither', () => {
    const body = '## Decision context\n\nc\n\n## Consequences\n\nq\n\n## Alternatives considered\n\nNone: licence.\n';
    const r = checkWrittenPage({ path: 'd.md', content: page('type: decision\nstatus: proposed\nscope: s\ndescription: d\nsource_type: stated', body) });
    assert.deepEqual(r.findings.map((f) => f.rule).sort(), ['section-missing-context', 'section-missing-decision']);
    const numbered = '## 1. Context\n\nc\n\n## 2. Decision (final)\n\nd\n\n## Consequences / Conséquences\n\nq\n\n## Alternatives considered\n\nNone: licence.\n';
    const ok = checkWrittenPage({ path: 'd.md', content: page('type: decision\nstatus: proposed\nscope: s\ndescription: d\nsource_type: stated', numbered) });
    assert.deepEqual(ok.findings, [], 'numbering, a trailing parenthetical and a slash pair are decoration');
  });

  test('a decision-input needs its Context, not a verdict\'s sections', () => {
    const r = checkWrittenPage({ path: 'd.md', content: page('type: decision-input\nstatus: proposed\nscope: s\ndescription: d\nsource_type: stated', '## Context\n\nx\n') });
    assert.deepEqual(r.findings, []);
  });

  test('source_type is only INFO where the vault does not carry the convention', () => {
    const r = checkWrittenPage({ path: 'd.md', content: page('type: decision\nstatus: proposed\nscope: s\ndescription: d', FULL_BODY), vaultHasSourceType: false });
    assert.deepEqual(r.findings.map((f) => [f.rule, f.severity]), [['source-type-missing', 'info']]);
  });

  test('a corpus rule is not reported from one page', () => {
    const r = checkWrittenPage({ path: 'd.md', content: page('type: decision\nstatus: proposed\nscope: s\ndescription: d\nsource_type: stated\naffects:\n  - "[[nowhere]]"', FULL_BODY) });
    assert.deepEqual(r.findings, []);
  });

  test('a page that is not a decision is not checked', () => {
    assert.equal(checkWrittenPage({ path: 'n.md', content: page('type: concept', 'x') }).checked, false);
    assert.equal(checkWrittenPage({ path: 'n.md', content: 'no frontmatter' }).checked, false);
  });
});

/** A fake REST vault: a map of vault-relative path → content. */
function fakeVault(files) {
  const reads = [];
  const deps = {
    listFilesIn: async (_v, dir) => {
      const prefix = dir ? `${dir}/` : '';
      const names = new Set();
      for (const p of Object.keys(files)) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        names.add(rest.includes('/') ? `${rest.split('/')[0]}/` : rest);
      }
      if (dir && names.size === 0) { const e = new Error('HTTP 404 Not Found'); e.status = 404; throw e; }
      return { files: [...names] };
    },
    getFileContent: async (_v, p) => {
      reads.push(p);
      if (!(p in files)) { const e = new Error('HTTP 404'); e.status = 404; throw e; }
      return files[p];
    },
  };
  return { deps, reads };
}
const registryFor = (name) => ({ resolveVault: (n) => ({ name: n ?? name }) });

describe('the first write into a vault carries its conventions', () => {
  test('REST reading finds the candidate and its backups', async () => {
    const { deps } = fakeVault({
      'Documentation/CLAUDE.md': read('CLAUDE.md'),
      [`Documentation/${BAKS[0]}`]: read(BAKS[0]),
      'Documentation/SETUP.md': 'x',
      'wiki/a.md': 'x',
    });
    const r = await readVaultConventionsOverRest({ name: 'v' }, deps);
    assert.deepEqual(r.candidates.map((c) => c.path), ['Documentation/CLAUDE.md']);
    assert.deepEqual(r.backups.map((b) => b.path), [`Documentation/${BAKS[0]}`]);
  });

  test('once per vault per session, with the file to read and the decision contract', async () => {
    const { deps } = fakeVault({ 'Documentation/CLAUDE.md': read('CLAUDE.md'), 'wiki/a.md': '---\ntype: concept\n---\n' });
    const briefing = createConventionsBriefing(deps);
    const reg = registryFor('Kiviri-OS');
    const first = await briefing.forWrite(reg, 'write_file', { vault: 'Kiviri-OS', path: 'wiki/a.md', content: '---\ntype: concept\n---\n' }, { vault: 'Kiviri-OS' });
    assert.equal(first.vaultConventions.conventionsFile, 'Documentation/CLAUDE.md');
    assert.deepEqual(first.vaultConventions.installed.sort(), ['default-vault-health-check', 'path-disambiguation', 'roadmap-discipline', 'wiki-query-first']);
    assert.match(first.vaultConventions.read, /get_file\(\{ vault: "Kiviri-OS", path: "Documentation\/CLAUDE.md" \}\)/);
    assert.deepEqual(first.vaultConventions.decisionPages.status, ['proposed', 'accepted', 'superseded', 'rejected']);
    const second = await briefing.forWrite(reg, 'write_file', { vault: 'Kiviri-OS', path: 'wiki/a.md', content: '---\ntype: concept\n---\n' }, { vault: 'Kiviri-OS' });
    assert.equal(second, null, 'no second brief, and nothing else to say about a concept page');
  });

  test('a decision page written badly comes back with its checks — the write itself untouched', async () => {
    const { deps } = fakeVault({ 'CLAUDE.md': '## Source provenance — `source_type` frontmatter (mandatory for substantive pages, since 2026-05-18 v0.8.8)\n' });
    const briefing = createConventionsBriefing(deps);
    const out = await briefing.forWrite(registryFor('v'), 'write_file', { path: 'wiki/d.md', content: '---\ntype: decision\n---\n\nbody\n' }, { vault: 'v' });
    assert.ok(out.vaultConventions);
    const rules = out.pageChecks[0].findings.map((f) => f.rule);
    assert.ok(rules.includes('status-missing'));
    assert.equal(out.pageChecks[0].findings.find((f) => f.rule === 'source-type-missing').severity, 'warning', 'this vault carries source-type');
  });

  test('a patch is checked on the page as it now stands, read back', async () => {
    const { deps, reads } = fakeVault({ 'wiki/d.md': '---\ntype: decision\nstatus: done\n---\n' });
    const briefing = createConventionsBriefing(deps);
    const out = await briefing.forWrite(registryFor('v'), 'patch_file', { path: 'wiki/d.md', content: 'x' }, { vault: 'v' });
    assert.ok(reads.includes('wiki/d.md'));
    assert.ok(out.pageChecks[0].findings.some((f) => f.rule === 'status-invalid'));
  });

  test('the brief costs no GET per backup — only the conventions file is read', async () => {
    const { deps, reads } = fakeVault({
      'Documentation/CLAUDE.md': read('CLAUDE.md'),
      ...Object.fromEntries(BAKS.map((b) => [`Documentation/${b}`, read(b)])),
    });
    await createConventionsBriefing(deps).forWrite(registryFor('v'), 'write_file', { path: 'wiki/a.md', content: 'x' }, { vault: 'v' });
    assert.deepEqual(reads, ['Documentation/CLAUDE.md']);
  });

  test('a bundle is checked on what its pages say AFTER every step, read back', async () => {
    // The bundle's `write` step carried a complete decision; a later step of
    // the same bundle left the page without its status. The vault is the truth.
    const good = '---\ntype: decision\nstatus: proposed\nscope: s\ndescription: d\nsource_type: stated\n---\n\n## Context\n\nc\n\n## Decision\n\nd\n\n## Consequences\n\nq\n\n## Alternatives considered\n\nNone: licence.\n';
    const { deps } = fakeVault({ 'wiki/d.md': good.replace('status: proposed\n', '') });
    const out = await createConventionsBriefing(deps).forWrite(registryFor('v'), 'write_bundle', {
      steps: [{ op: 'write', path: 'wiki/d.md', content: good }, { op: 'set_frontmatter', path: 'wiki/d.md', key: 'status', value: '' }],
    }, { vault: 'v' });
    assert.ok(out.pageChecks[0].findings.some((f) => f.rule === 'status-missing'), JSON.stringify(out.pageChecks));
  });

  test('a hung vault cannot hold the write: past the deadline the brief is unavailable and checks are SKIPPED, said so', async () => {
    const hang = () => new Promise(() => {});
    const deps = { listFilesIn: hang, getFileContent: hang, deadlineMs: 200 };
    const t0 = Date.now();
    const out = await createConventionsBriefing(deps).forWrite(registryFor('v'), 'patch_file', { path: 'wiki/d.md', content: 'x' }, { vault: 'v' });
    assert.ok(Date.now() - t0 < 2000, `returned in ${Date.now() - t0} ms`);
    assert.match(out.vaultConventions.unavailable, /longer than/);
    assert.deepEqual(out.pageChecksSkipped.paths, ['wiki/d.md'], 'unchecked is reported, not passed off as clean');
  });

  test('past the deadline, no further request is issued — the late listing does not go on to read', async () => {
    const reads = [];
    const deps = {
      deadlineMs: 100,
      listFilesIn: (_v, dir) => new Promise((r) => setTimeout(() => r({ files: dir === '' ? ['CLAUDE.md'] : [] }), 300)),
      getFileContent: async (_v, p) => { reads.push(p); return '# c'; },
    };
    await createConventionsBriefing(deps).forWrite(registryFor('v'), 'write_file', { path: 'wiki/a.md', content: 'x' }, { vault: 'v' });
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(reads, [], 'the listing resolved after the deadline and no read followed it');
  });

  test('pages past the per-call cap are reported unchecked, never dropped', async () => {
    const files = {};
    const steps = [];
    for (let i = 0; i < 11; i += 1) {
      files[`wiki/p${i}.md`] = '---\ntype: concept\n---\n';
      steps.push({ op: 'write', path: `wiki/p${i}.md`, content: 'x' });
    }
    const { deps } = fakeVault(files);
    const out = await createConventionsBriefing(deps).forWrite(registryFor('v'), 'write_bundle', { steps }, { vault: 'v' });
    assert.deepEqual(out.pageChecksSkipped.overLimit, ['wiki/p10.md']);
  });

  test('a page deleted by a later step of the same bundle is not checked', async () => {
    const { deps, reads } = fakeVault({});
    await createConventionsBriefing(deps).forWrite(registryFor('v'), 'write_bundle', {
      steps: [{ op: 'write', path: 'wiki/tmp.md', content: 'x' }, { op: 'delete', path: 'wiki/tmp.md', confirm: true }],
    }, { vault: 'v' });
    assert.ok(!reads.includes('wiki/tmp.md'));
  });

  test('two conventions files: the brief says the router cannot tell, and asks', async () => {
    const { deps } = fakeVault({ 'CLAUDE.md': '# a\n', 'Documentation/CLAUDE.md': read('CLAUDE.md') });
    const out = await createConventionsBriefing(deps).forWrite(registryFor('v'), 'write_file', { path: 'wiki/a.md', content: 'x' }, { vault: 'v' });
    assert.equal(out.vaultConventions.ambiguous.length, 2);
    assert.match(out.vaultConventions.read, /cannot tell which is in force/);
  });

  test('an unreadable vault gives a brief that says so, never a thrown write', async () => {
    const deps = { listFilesIn: async () => { throw new Error('ECONNREFUSED'); }, getFileContent: async () => '' };
    const out = await createConventionsBriefing(deps).forWrite(registryFor('v'), 'append_to_file', { path: 'wiki/a.md' }, { vault: 'v' });
    assert.match(out.vaultConventions.unavailable, /could not be read/);
  });

  test('a call that wrote nothing spends no brief — the next real write still gets it', async () => {
    const { deps } = fakeVault({ 'CLAUDE.md': '# c\n' });
    const briefing = createConventionsBriefing(deps);
    assert.equal(await briefing.forWrite(registryFor('v'), 'patch_file', { path: 'wiki/a.md' }, { vault: 'v', patched: false }), null);
    assert.equal(await briefing.forWrite(registryFor('v'), 'merge_frontmatter', { path: 'wiki/a.md' }, { vault: 'v', applied: 0 }), null);
    const real = await briefing.forWrite(registryFor('v'), 'write_file', { path: 'wiki/a.md', content: 'x' }, { vault: 'v' });
    assert.ok(real.vaultConventions, 'the brief was kept for the first write that happened');
  });

  test('an append is not read back — no whole-page download on every journal line', async () => {
    const { deps, reads } = fakeVault({ 'CLAUDE.md': '# c\n', 'wiki-meta/journal.md': '---\ntype: decision\n---\n' });
    await createConventionsBriefing(deps).forWrite(registryFor('v'), 'append_to_file', { path: 'wiki-meta/journal.md', content: 'x' }, { vault: 'v' });
    assert.ok(!reads.includes('wiki-meta/journal.md'));
  });

  test('a tool that writes no page gets nothing', async () => {
    const { deps } = fakeVault({});
    assert.equal(await createConventionsBriefing(deps).forWrite(registryFor('v'), 'delete_file', { path: 'a.md' }, {}), null);
  });

  test('buildConventionsBrief with no file says no convention is in force', () => {
    const a = auditVaultConventions({ vault: 'v', candidates: [], backups: [], referenceFingerprints: null, catalogue });
    assert.match(buildConventionsBrief(a).read, /no convention is in force/);
  });
});

describe('the hooks heartbeat', () => {
  const started = new Date('2026-09-26T08:00:00Z');

  test('record then read, per workspace', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-'));
    try {
      const configPath = path.join(dir, 'config.json');
      assert.equal(recordHookHeartbeat({ hook: 'hot-cache-load', cwd: '/w/a', configPath, now: started }), true);
      const hb = readHookHeartbeat({ cwd: '/w/a', configPath });
      assert.equal(hb.hooks['hot-cache-load'], started.toISOString());
      assert.equal(readHookHeartbeat({ cwd: '/w/b', configPath }), null, 'another workspace sees nothing');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the four verdicts', () => {
    const at = (ms) => new Date(started.getTime() + ms).toISOString();
    assert.equal(sessionHooksStatus({ heartbeat: { hooks: { 'hot-cache-load': at(2000) } }, startedAt: started, now: new Date(started.getTime() + 60000), hooksManifest: true }).status, 'observed');
    assert.equal(sessionHooksStatus({ heartbeat: null, startedAt: started, now: new Date(started.getTime() + 60000), hooksManifest: false }).status, 'absent-from-plugin');
    assert.equal(sessionHooksStatus({ heartbeat: null, startedAt: started, now: new Date(started.getTime() + 5000), hooksManifest: true }).status, 'not-yet-observed');
    const stale = sessionHooksStatus({ heartbeat: { hooks: { 'hot-cache-load': at(-3600000) } }, startedAt: started, now: new Date(started.getTime() + 60000), hooksManifest: true });
    assert.equal(stale.status, 'not-observed', 'a heartbeat from an earlier session proves nothing about this one');
    assert.match(stale.message, /UNKNOWN/, 'a stale run proves nothing either way');
    const noManifestEarlier = sessionHooksStatus({ heartbeat: { hooks: { 'hot-cache-load': at(-3600000) } }, startedAt: started, now: new Date(started.getTime() + 60000), hooksManifest: false });
    assert.equal(noManifestEarlier.status, 'absent-from-plugin');
    assert.match(noManifestEarlier.message, /UNKNOWN/, 'a missing manifest proves THIS copy cannot run hooks, not that the session never got hot.md');
    const never = sessionHooksStatus({ heartbeat: null, startedAt: started, now: new Date(started.getTime() + 60000), hooksManifest: true });
    assert.match(never.message, /has ever run.*hot\.md was NOT injected/, 'with no run on record at all, the absence IS established');
    const promptOnly = sessionHooksStatus({ heartbeat: { hooks: { 'decisions-recall': at(2000) } }, startedAt: started, now: new Date(started.getTime() + 60000), hooksManifest: true });
    assert.equal(promptOnly.status, 'not-observed', 'only a session-start hook proves hot.md was loadable');
  });

  test('a run from before this server started is REPORTED, not hidden (a mid-session restart)', () => {
    const s = sessionHooksStatus({ heartbeat: { hooks: { 'hot-cache-load': new Date(started.getTime() - 3600000).toISOString() } }, startedAt: started, now: new Date(started.getTime() + 60000), hooksManifest: true });
    assert.equal(s.status, 'not-observed');
    assert.match(s.message, /last ran at .*, before it. .*UNKNOWN/);
    assert.doesNotMatch(s.message, /was NOT injected/, 'an earlier run makes the injection unknown, never asserted absent');
  });

  test('two hooks recording at once cannot erase each other (one file per hook)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-race-'));
    try {
      const configPath = path.join(dir, 'config.json');
      // The lost update of a shared file: the second writer's record replaced
      // the first's. With a file per hook, both survive whatever the order.
      recordHookHeartbeat({ hook: 'hot-cache-load', cwd: '/w/a', configPath, now: started });
      recordHookHeartbeat({ hook: 'decisions-recall', cwd: '/w/a', configPath, now: new Date(started.getTime() + 1000) });
      const hb = readHookHeartbeat({ cwd: '/w/a', configPath });
      assert.deepEqual(Object.keys(hb.hooks).sort(), ['decisions-recall', 'hot-cache-load']);
      assert.throws(() => heartbeatPath(configPath, '/w/a', '../evil'), /invalid hook name/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('hot-cache-load silent while decisions-recall ran: the message blames hot-cache-load only', () => {
    const at = (ms) => new Date(started.getTime() + ms).toISOString();
    const s = sessionHooksStatus({ heartbeat: { hooks: { 'decisions-recall': at(2000) } }, startedAt: started, now: new Date(started.getTime() + 60000), hooksManifest: true, workspace: '/w/a' });
    assert.equal(s.status, 'not-observed');
    assert.match(s.message, /plugin hooks work here, but hot\.md was NOT injected/);
    assert.doesNotMatch(s.message, /decisions-recall does not run/);
    assert.equal(s.workspace, '/w/a', 'the verdict names the workspace it is about');
  });

  test('the real hot-cache-load hook leaves a heartbeat, and its opt-out leaves none', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-hook-'));
    try {
      const home = path.join(dir, 'home');
      const ws = path.join(dir, 'ws');
      fs.mkdirSync(home);
      fs.mkdirSync(ws);
      const configPath = path.join(dir, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({ vaultsById: {} }));
      const run = (extra) => spawnSync(process.execPath, [path.join(REPO, 'hooks', 'hot-cache-load.mjs')], {
        input: JSON.stringify({ cwd: ws, hook_event_name: 'SessionStart' }),
        encoding: 'utf8',
        cwd: ws,
        env: homeSafeEnv(home, { OBSIDIAN_ROUTER_CONFIG: configPath, ...extra }),
      });
      const optedOut = run({ OBSIDIAN_ROUTER_NO_HOT_CACHE_LOAD: 'true' });
      assert.equal(optedOut.status, 0, optedOut.stderr);
      assert.equal(fs.existsSync(heartbeatPath(configPath, ws, 'hot-cache-load')), false, 'an opted-out hook did not load hot.md, and says so by silence');
      const r = run({ OBSIDIAN_ROUTER_NO_HOT_CACHE_LOAD: '' });
      assert.equal(r.status, 0, r.stderr);
      const hb = readHookHeartbeat({ cwd: ws, configPath });
      assert.ok(hb?.hooks?.['hot-cache-load'], `heartbeat expected at ${heartbeatPath(configPath, ws, 'hot-cache-load')}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a session opened in a vault is told where its conventions are', () => {
  function runIn(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-conv-'));
    try {
      const home = path.join(dir, 'home');
      const vault = path.join(dir, 'vault');
      fs.mkdirSync(home);
      for (const [rel, content] of Object.entries({ 'wiki-meta/catalog.md': '# catalog', ...files })) {
        const p = path.join(vault, ...rel.split('/'));
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
      }
      const configPath = path.join(dir, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({ vaultsById: {} }));
      const r = spawnSync(process.execPath, [path.join(REPO, 'hooks', 'hot-cache-load.mjs')], {
        input: JSON.stringify({ cwd: vault, hook_event_name: 'SessionStart' }),
        encoding: 'utf8',
        cwd: vault,
        env: homeSafeEnv(home, { OBSIDIAN_ROUTER_CONFIG: configPath, OBSIDIAN_ROUTER_NO_HOT_CACHE_LOAD: '' }),
      });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  test('Documentation/CLAUDE.md, which Claude Code never reads, is named', () => {
    const out = runIn({ 'Documentation/CLAUDE.md': '# conv', 'wiki-meta/hot.md': '# Hot\n' });
    assert.match(out, /CONVENTIONS: this vault's rules .* are in `Documentation\/CLAUDE\.md` — NOT loaded/);
    assert.match(out, /# Hot/, 'hot.md still follows');
  });

  test('a root CLAUDE.md in the vault itself IS loaded by Claude Code: no pointer', () => {
    const out = runIn({ 'CLAUDE.md': '# conv', 'wiki-meta/hot.md': '# Hot\n' });
    assert.doesNotMatch(out, /CONVENTIONS:/);
  });

  test('two conventions files: the session is told the router cannot choose', () => {
    const out = runIn({ 'CLAUDE.md': '# a', 'Documentation/CLAUDE.md': '# b', 'wiki-meta/hot.md': '# Hot\n' });
    assert.match(out, /2 conventions files \(CLAUDE\.md, Documentation\/CLAUDE\.md\)/);
  });

  test('no hot.md yet: the pointer still goes out, alone', () => {
    const out = runIn({ 'Documentation/CLAUDE.md': '# conv' });
    assert.match(out, /^<!-- CONVENTIONS:/);
  });
});

describe('the running build is identified by its files, not its version string', () => {
  test('a CRLF checkout fingerprints like the LF one', () => {
    const lf = Buffer.from('a\nb\n');
    const crlf = Buffer.from('a\r\nb\r\n');
    assert.equal(gitBlobId(normaliseEol(crlf)), gitBlobId(lf));
  });

  test('gitBlobId is git\'s own blob id', (t) => {
    const r = spawnSync('git', ['hash-object', '--stdin'], { input: 'hello\n', encoding: 'utf8' });
    if (r.status !== 0) { t.skip('git unavailable — not a pass'); return; }
    assert.equal(gitBlobId(Buffer.from('hello\n')), r.stdout.trim());
  });

  test('every fingerprinted file is committed with LF endings — the precondition the tree side relies on', (t) => {
    // The tree side hashes git's blob ids as committed; the disk side folds
    // CRLF to LF. The two agree only while no fingerprinted file is committed
    // with CRLF (or mixed) endings. Pinned here so the day one is, this fails
    // instead of identify-build quietly naming no commit.
    const r = spawnSync('git', ['ls-files', '--eol', '--', 'bin', 'src', 'hooks', 'package.json', '.claude-plugin/plugin.json'], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 });
    if (r.status !== 0) { t.skip('git unavailable — not a pass'); return; }
    const lines = r.stdout.split('\n').filter(Boolean);
    assert.ok(lines.length > 50);
    const bad = lines.filter((l) => /^i\/(crlf|mixed)/.test(l));
    assert.deepEqual(bad, []);
  });

  test('OS clutter in a copy does not move the fingerprint; a real file does', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-junk-'));
    try {
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
      fs.writeFileSync(path.join(dir, 'package.json'), '{"version":"0.0.0"}\n');
      const before = describeRunningBuild(dir).fingerprint;
      fs.writeFileSync(path.join(dir, 'src', 'Thumbs.db'), 'junk');
      fs.writeFileSync(path.join(dir, 'src', '.DS_Store'), 'junk');
      assert.equal(describeRunningBuild(dir).fingerprint, before);
      fs.writeFileSync(path.join(dir, 'src', 'b.mjs'), 'export const b = 2;\n');
      assert.notEqual(describeRunningBuild(dir).fingerprint, before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the tree side excludes exactly what the disk side skips — one predicate for both', () => {
    assert.equal(underFingerprintRoots('src/index.mjs'), true);
    assert.equal(underFingerprintRoots('src/Thumbs.db'), false, 'a TRACKED clutter file would otherwise count on one side only');
    assert.equal(underFingerprintRoots('src/node_modules/x.js'), false);
    assert.equal(underFingerprintRoots('src/.gitkeep'), true, 'a tracked .gitkeep is a file of the tree');
    assert.equal(underFingerprintRoots('skills/x/SKILL.md'), false);
  });

  test('gitHead is read inside a git worktree too (where .git is a file)', () => {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' });
    assert.equal(describeRunningBuild(REPO).gitHead, r.stdout.trim());
  });

  test('the fingerprint is order-independent and moves with any file', () => {
    const a = [{ path: 'src/a.mjs', blob: '1'.repeat(40) }, { path: 'src/b.mjs', blob: '2'.repeat(40) }];
    assert.equal(fingerprintFromEntries(a), fingerprintFromEntries([...a].reverse()));
    assert.notEqual(fingerprintFromEntries(a), fingerprintFromEntries([a[0], { path: 'src/b.mjs', blob: '3'.repeat(40) }]));
  });

  test('a copy on disk and the commit it came from give the same fingerprint', () => {
    // Positive control for the identify script: materialise HEAD's files in a
    // temp directory (`git show`, one per file — written with CRLF endings, the
    // shape an autocrlf checkout has), fingerprint the copy, and compare with
    // the fingerprint of HEAD computed from `git ls-tree`.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-id-'));
    try {
      const ls = spawnSync('git', ['ls-tree', '-r', 'HEAD', '--', 'bin', 'src', 'hooks', 'package.json', '.claude-plugin/plugin.json'], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 });
      assert.equal(ls.status, 0, ls.stderr);
      const entries = ls.stdout.split('\n').map((l) => /^\d+ blob ([0-9a-f]{40})\t(.+)$/.exec(l)).filter(Boolean).map((m) => ({ path: m[2], blob: m[1] }));
      assert.ok(entries.length > 50, 'HEAD has the server\'s files');
      const out = path.join(dir, 'copy');
      for (const e of entries) {
        const blob = spawnSync('git', ['cat-file', 'blob', e.blob], { cwd: REPO, maxBuffer: 1 << 26 });
        const dst = path.join(out, ...e.path.split('/'));
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.writeFileSync(dst, Buffer.from(blob.stdout.toString('binary').replace(/\n/g, '\r\n'), 'binary'));
      }
      assert.equal(describeRunningBuild(out).fingerprint, fingerprintFromEntries(entries));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
