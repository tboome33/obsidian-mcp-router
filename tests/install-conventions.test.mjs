/**
 * install_conventions — one guarded write for many conventions, verified by
 * reading the file back.
 *
 * The REST layer is injected (`_deps`), in the shape of the real one: an
 * in-memory vault whose `writeFileIfMatch` really compares the expected hash
 * with the current bytes, and whose create-only `writeFile` really refuses an
 * existing file. Nothing touches a vault, a config or the network. The snippet
 * library is the package's own (read-only); the one test that needs a
 * different library builds it under fs.mkdtempSync.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  installConventionsTool,
  loadConventionCatalogue,
  loadRetiredCatalogue,
  SNIPPETS_DIR,
  CONVENTION_ID_RE,
  TOOL_DEFINITION,
} from '../src/tools/install-conventions.mjs';
import { contentSha256 } from '../src/helpers/content-hash.mjs';
import { findConventionSection, detectConventions } from '../src/helpers/claude-md-conventions.mjs';
import { RETIRED_DIR } from '../src/helpers/convention-catalogue.mjs';
import { readVaultLanguages, renderLanguagesSection, LANGUAGES_PLACEHOLDER } from '../src/helpers/convention-languages.mjs';
import { IF_MATCH_EXEMPT, preconditionState } from '../src/helpers/vault-sharing.mjs';
import { TOOL_WRITE_FLOOR } from '../src/helpers/skill-capabilities.mjs';
import { _internals } from '../src/index.mjs';

const VAULT = { name: 'v', baseUrl: 'http://unused.invalid' };
const registry = { resolveVault: () => VAULT };

const snippet = (id) => fs.readFileSync(path.join(SNIPPETS_DIR, `${id}.md`), 'utf8');
const headingOf = (id) => snippet(id).split('\n', 1)[0];

/**
 * An in-memory vault with the real semantics of the three REST calls the tool
 * uses. `files` maps a vault-relative path to its content. Every call is
 * recorded in `calls`, so a test can say exactly what reached the "wire".
 */
function fakeVault(files = {}, hooks = {}) {
  const store = new Map(Object.entries(files));
  const calls = [];
  const notFound = (p) => Object.assign(new Error(`not found: ${p}`), { kind: 'not_found', status: 404 });
  const conflict = (p) => Object.assign(new Error(`conflict: ${p}`), { kind: 'conflict', status: 409 });
  const deps = {
    listFilesIn: async (_v, dir = '') => {
      calls.push({ op: 'list', dir });
      const prefix = dir ? `${dir}/` : '';
      const names = new Set();
      for (const p of store.keys()) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const slash = rest.indexOf('/');
        names.add(slash === -1 ? rest : `${rest.slice(0, slash)}/`);
      }
      if (dir && names.size === 0) throw notFound(dir);
      return { files: [...names].sort() };
    },
    getFileContent: async (_v, p) => {
      calls.push({ op: 'get', path: p });
      if (hooks.onGet) {
        const override = hooks.onGet(p, calls.filter((c) => c.op === 'get').length, store);
        if (override !== undefined) return override;
      }
      if (!store.has(p)) throw notFound(p);
      return store.get(p);
    },
    writeFileIfMatch: async (_v, p, content, expectedSha) => {
      calls.push({ op: 'cas', path: p, content, expectedSha });
      if (!store.has(p)) throw conflict(p);
      if (contentSha256(store.get(p)) !== expectedSha) throw conflict(p);
      store.set(p, content);
      return { casMode: 'atomic' };
    },
    writeFile: async (_v, p, content, opts = {}) => {
      calls.push({ op: 'put', path: p, content, opts });
      if (opts.applyIfContentPreexists === false && store.has(p)) throw conflict(p);
      store.set(p, content);
    },
  };
  const writes = () => calls.filter((c) => c.op === 'cas' || c.op === 'put');
  return { store, calls, deps, writes };
}

const PREAMBLE = '# Vault rules\n\nSome text the user wrote.\n';

describe('install_conventions — the write', () => {
  test('installs several conventions in ONE write, guarded by the hash of the bytes it read', async () => {
    const v = fakeVault({ 'CLAUDE.md': PREAMBLE });
    const res = await installConventionsTool(registry, { ids: ['source-type', 'log-discipline', 'heading-hierarchy'] }, v.deps);

    assert.equal(v.writes().length, 1, 'more than one write for one install');
    const [w] = v.writes();
    assert.equal(w.op, 'cas', 'an existing file must be written with writeFileIfMatch');
    assert.equal(w.expectedSha, contentSha256(PREAMBLE), 'the precondition is not the hash of what was read');
    assert.ok(w.content.startsWith(PREAMBLE), 'the original bytes were not preserved as the prefix');

    assert.deepEqual(res.installed, ['source-type', 'log-discipline', 'heading-hierarchy']);
    assert.deepEqual(res.alreadyPresent, []);
    assert.equal(res.verified, true, `not verified: ${JSON.stringify(res.problems)}`);
    assert.equal(res.path, 'CLAUDE.md');
    assert.equal(res.written, true);
    assert.equal(res.contentSha256, contentSha256(v.store.get('CLAUDE.md')));
    for (const id of res.installed) {
      assert.equal(res.detection.find((d) => d.id === id).installed, true, `${id} not detected`);
    }
  });

  test('the installed text IS the package snippet — nothing is re-typed on the way', async () => {
    const v = fakeVault({ 'CLAUDE.md': PREAMBLE });
    await installConventionsTool(registry, { ids: ['log-discipline', 'path-disambiguation'] }, v.deps);
    const after = v.store.get('CLAUDE.md');
    for (const id of ['log-discipline', 'path-disambiguation']) {
      const section = findConventionSection(after, headingOf(id));
      assert.equal(section.found, true);
      assert.equal(section.text.replace(/\n+$/, ''), snippet(id).replace(/\n+$/, ''), `${id} differs from its snippet`);
    }
  });

  test('a concurrent edit between the read and the write is a 409 with an actionable message — nothing overwritten', async () => {
    const v = fakeVault({ 'CLAUDE.md': PREAMBLE }, {
      // The user saves the file in Obsidian right after the tool read it.
      onGet: (p, n, store) => {
        if (n === 1) {
          const read = store.get(p);
          store.set(p, `${read}\n## Personal\n\nwritten meanwhile\n`);
          return read;
        }
        return undefined;
      },
    });
    await assert.rejects(
      () => installConventionsTool(registry, { ids: ['source-type'] }, v.deps),
      (err) => {
        assert.equal(err.kind, 'conflict');
        assert.equal(err.status, 409);
        assert.match(err.message, /changed since it was read/);
        assert.match(err.message, /Run install_conventions again/);
        return true;
      },
    );
    assert.match(v.store.get('CLAUDE.md'), /written meanwhile/, 'the concurrent edit was clobbered');
  });

  test('already-present conventions are skipped and reported, never re-appended', async () => {
    const original = `${PREAMBLE}\n${snippet('source-type')}`;
    const v = fakeVault({ 'CLAUDE.md': original });
    const res = await installConventionsTool(registry, { ids: ['source-type', 'log-discipline'] }, v.deps);
    assert.deepEqual(res.alreadyPresent, ['source-type']);
    assert.deepEqual(res.installed, ['log-discipline']);
    assert.equal(findConventionSection(v.store.get('CLAUDE.md'), headingOf('source-type')).occurrences, 1);
    assert.equal(res.verified, true, JSON.stringify(res.problems));
  });

  test('everything already present → no write at all, and it says so', async () => {
    const original = `${PREAMBLE}\n${snippet('source-type')}`;
    const v = fakeVault({ 'CLAUDE.md': original });
    const res = await installConventionsTool(registry, { ids: ['source-type'] }, v.deps);
    assert.equal(v.writes().length, 0);
    assert.equal(res.written, false);
    assert.deepEqual(res.installed, []);
    assert.deepEqual(res.alreadyPresent, ['source-type']);
    assert.equal(res.verified, true);
  });

  test('an unknown but well-formed id is reported, and the known ones still install', async () => {
    const v = fakeVault({ 'CLAUDE.md': PREAMBLE });
    const res = await installConventionsTool(registry, { ids: ['no-such-convention', 'log-discipline'] }, v.deps);
    assert.deepEqual(res.unknown, ['no-such-convention']);
    assert.deepEqual(res.installed, ['log-discipline']);
    assert.equal(res.verified, true);
  });

  for (const hostile of ['../CLAUDE', '..', 'a/b', 'a\\b', 'Source-Type', 'log-discipline.md', '', ' log-discipline', '-x']) {
    test(`a malformed id is refused before any I/O: ${JSON.stringify(hostile)}`, async () => {
      const v = fakeVault({ 'CLAUDE.md': PREAMBLE });
      await assert.rejects(
        () => installConventionsTool(registry, { ids: ['log-discipline', hostile] }, v.deps),
        (err) => {
          assert.equal(err.kind, 'validation');
          assert.match(err.message, /malformed id/);
          return true;
        },
      );
      assert.equal(v.calls.length, 0, 'the vault was touched before the id was refused');
    });
  }

  test('no conventions file → created at the vault root, create-only', async () => {
    const v = fakeVault({ 'wiki/a.md': 'x' });
    const res = await installConventionsTool(registry, { ids: ['log-discipline', 'source-type'] }, v.deps);
    const [w] = v.writes();
    assert.equal(v.writes().length, 1);
    assert.equal(w.op, 'put');
    assert.equal(w.path, 'CLAUDE.md');
    assert.equal(w.opts.applyIfContentPreexists, false, 'the create was not create-only');
    assert.equal(res.created, true);
    assert.equal(res.verified, true, JSON.stringify(res.problems));
    assert.ok(w.content.startsWith(headingOf('log-discipline')), 'a created file must start with the first snippet');
  });

  test('a file created by someone else meanwhile is a conflict, not an overwrite', async () => {
    const v = fakeVault({ 'wiki/a.md': 'x' });
    const original = v.deps.writeFile;
    v.deps.writeFile = async (vault, p, content, opts) => {
      v.store.set(p, 'theirs\n');
      return original(vault, p, content, opts);
    };
    await assert.rejects(
      () => installConventionsTool(registry, { ids: ['log-discipline'] }, v.deps),
      (err) => err.kind === 'conflict' && /created by someone else/.test(err.message),
    );
    assert.equal(v.store.get('CLAUDE.md'), 'theirs\n');
  });

  test('two conventions files → refused, both named, nothing written', async () => {
    const v = fakeVault({ 'CLAUDE.md': PREAMBLE, 'Documentation/CLAUDE.md': PREAMBLE });
    await assert.rejects(
      () => installConventionsTool(registry, { ids: ['log-discipline'] }, v.deps),
      (err) => {
        assert.equal(err.kind, 'validation');
        assert.match(err.message, /CLAUDE\.md, Documentation\/CLAUDE\.md/);
        return true;
      },
    );
    assert.equal(v.writes().length, 0);
  });

  test('the template layout (Documentation/CLAUDE.md only) is found — no second file at the root', async () => {
    const v = fakeVault({ 'Documentation/CLAUDE.md': PREAMBLE, 'wiki-meta/hot.md': 'h' });
    const res = await installConventionsTool(registry, { ids: ['log-discipline'] }, v.deps);
    assert.equal(res.path, 'Documentation/CLAUDE.md');
    assert.equal(v.store.has('CLAUDE.md'), false);
    assert.equal(v.writes()[0].op, 'cas');
  });

  test('a read-back that lost a section → verified: false, with the id named', async () => {
    const v = fakeVault({ 'CLAUDE.md': PREAMBLE }, {
      // Second GET is the read-back: serve the written content minus log-discipline.
      onGet: (p, n, store) => {
        if (n !== 2) return undefined;
        const written = store.get(p);
        const s = findConventionSection(written, headingOf('log-discipline'));
        return written.slice(0, s.start) + written.slice(s.end);
      },
    });
    const res = await installConventionsTool(registry, { ids: ['source-type', 'log-discipline'] }, v.deps);
    assert.equal(res.written, true);
    assert.equal(res.verified, false);
    assert.ok(res.problems.some((p) => /log-discipline/.test(p)), JSON.stringify(res.problems));
    assert.equal(res.detection.find((d) => d.id === 'log-discipline').installed, false);
  });

  test('an unclosed fence above the append point is refused BEFORE writing', async () => {
    const v = fakeVault({ 'CLAUDE.md': `${PREAMBLE}\n\`\`\`markdown\nan example never closed\n` });
    await assert.rejects(
      () => installConventionsTool(registry, { ids: ['log-discipline'] }, v.deps),
      (err) => err.kind === 'validation' && /never closed/.test(err.message),
    );
    assert.equal(v.writes().length, 0);
  });

  test('a CRLF file gets CRLF sections, and still verifies', async () => {
    const crlf = PREAMBLE.replace(/\n/g, '\r\n');
    const v = fakeVault({ 'CLAUDE.md': crlf });
    const res = await installConventionsTool(registry, { ids: ['heading-hierarchy'] }, v.deps);
    const after = v.store.get('CLAUDE.md');
    assert.equal(/[^\r]\n/.test(after), false, 'a bare LF was mixed into a CRLF file');
    assert.equal(res.verified, true, JSON.stringify(res.problems));
  });
});

describe('install_conventions — dryRun and state', () => {
  test('dryRun writes nothing and returns the plan', async () => {
    const original = `${PREAMBLE}\n${snippet('source-type')}`;
    const v = fakeVault({ 'CLAUDE.md': original });
    const res = await installConventionsTool(registry, { ids: ['source-type', 'log-discipline'], dryRun: true }, v.deps);
    assert.equal(v.writes().length, 0);
    assert.equal(res.written, false);
    assert.equal(res.dryRun, true);
    assert.deepEqual(res.wouldInstall, ['log-discipline']);
    assert.deepEqual(res.alreadyPresent, ['source-type']);
    assert.equal(res.contentSha256, contentSha256(original));
  });

  test('dryRun with ids: [] returns the whole library and its detection — the pickers\' state', async () => {
    const v = fakeVault({});
    const res = await installConventionsTool(registry, { ids: [], dryRun: true }, v.deps);
    const onDisk = fs.readdirSync(SNIPPETS_DIR).filter((f) => f.endsWith('.md')).length;
    const retiredOnDisk = fs.readdirSync(RETIRED_DIR).filter((f) => f.endsWith('.md')).length;
    const offered = res.catalogue.filter((c) => !c.retired);
    const retired = res.catalogue.filter((c) => c.retired === true);
    assert.equal(offered.length, onDisk, `catalogue ${offered.length}/${onDisk} snippets`);
    assert.equal(retired.length, retiredOnDisk, `retired ${retired.length}/${retiredOnDisk}`);
    // Detection covers both: a retired convention a vault still carries must show.
    assert.equal(res.detection.length, onDisk + retiredOnDisk);
    assert.ok(res.detection.every((d) => d.installed === false));
    assert.equal(res.fileExisted, false);
    assert.equal(v.writes().length, 0);
  });

  test('an empty ids list without dryRun is refused', async () => {
    const v = fakeVault({ 'CLAUDE.md': PREAMBLE });
    await assert.rejects(() => installConventionsTool(registry, { ids: [] }, v.deps), /ids` is empty/);
    assert.equal(v.calls.length, 0);
  });

  test('the catalogue is the package library: every snippet, heading = its first line', () => {
    const cat = loadConventionCatalogue();
    const files = fs.readdirSync(SNIPPETS_DIR).filter((f) => f.endsWith('.md'));
    assert.equal(cat.length, files.length, `${cat.length}/${files.length} snippets loaded`);
    for (const c of cat) {
      assert.match(c.id, CONVENTION_ID_RE);
      assert.equal(c.heading, headingOf(c.id));
    }
  });

  test('a snippet file that is not a convention (no ## first line) is not installable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-conventions-'));
    try {
      fs.writeFileSync(path.join(dir, 'good.md'), '## Good\n\nbody\n');
      fs.writeFileSync(path.join(dir, 'bad.md'), 'no heading here\n');
      fs.writeFileSync(path.join(dir, 'Upper.md'), '## Upper\n');
      assert.deepEqual(loadConventionCatalogue(dir).map((c) => c.id), ['good']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('install_conventions — registration and classification', () => {
  test('registered as a WRITE tool, with a handler and a schema', () => {
    assert.ok(_internals.WRITE_TOOL_NAMES.has('install_conventions'));
    assert.ok(_internals.TOOLS.some((t) => t.name === 'install_conventions'));
    assert.equal(typeof _internals.TOOL_HANDLERS.install_conventions, 'function');
    assert.ok(TOOL_DEFINITION.inputSchema.properties.confirmSecondaryWrite, 'no confirmSecondaryWrite — a soft secondary could never be written');
  });

  test('the shared-vault gate exempts it, WITH a reason — it does its own compare-and-swap', () => {
    assert.ok(IF_MATCH_EXEMPT.has('install_conventions'));
    assert.match(IF_MATCH_EXEMPT.get('install_conventions'), /compare-and-swap/);
    assert.equal(preconditionState('install_conventions', { ids: ['bilingual'] }), 'not-applicable');
  });

  test('a dryRun is not a write for the tier gate, the audit line or the refresh — a real run is', () => {
    assert.equal(_internals.requiresAlsoTierCheck('install_conventions', { ids: [], dryRun: true }), false);
    assert.equal(_internals.toolActuallyWrote('install_conventions', { ids: [], dryRun: true }), false);
    assert.equal(_internals.requiresAlsoTierCheck('install_conventions', { ids: ['bilingual'] }), true);
    // The handler's test is `=== true`: the string "true" writes, so it must be gated.
    assert.equal(_internals.requiresAlsoTierCheck('install_conventions', { ids: ['bilingual'], dryRun: 'true' }), true);
  });

  test('a skill that calls it must admit append-only writes to vault content', () => {
    assert.deepEqual(TOOL_WRITE_FLOOR.install_conventions, { mode: 'append-only', atom: 'vault:content' });
  });

  test('detectConventions sees the library headings exactly as the tool reports them', () => {
    const cat = loadConventionCatalogue();
    const all = cat.map((c) => c.text).join('\n');
    assert.ok(detectConventions(all, cat).every((d) => d.installed && !d.duplicate));
  });
});

// ---------------------------------------------------------------------------
// `languages` carries a value that belongs to the vault (decision
// convention-languages-remplace-bilingual, 2026-09-26), and `bilingual` is
// retired: recognised in a file, never installed.
// ---------------------------------------------------------------------------

describe('install_conventions — the languages value, and retired conventions', () => {
  const retiredText = (id) => fs.readFileSync(path.join(RETIRED_DIR, `${id}.md`), 'utf8');
  const VALUE_LINE = '**Languages of this vault: fr, en**';

  test('`languages` without a value is refused before any I/O', async () => {
    const v = fakeVault({ 'CLAUDE.md': PREAMBLE });
    await assert.rejects(() => installConventionsTool(registry, { ids: ['languages'] }, v.deps), /carries a value/);
    assert.equal(v.calls.length, 0);
  });

  test('the value lands in the section\'s value line — never the placeholder — and is read back', async () => {
    const v = fakeVault({ 'CLAUDE.md': PREAMBLE });
    const res = await installConventionsTool(registry, { ids: ['languages'], languages: ['fr', 'en'] }, v.deps);
    assert.deepEqual(res.installed, ['languages']);
    assert.equal(res.verified, true, JSON.stringify(res.problems));
    const after = v.store.get('CLAUDE.md');
    assert.ok(after.includes(VALUE_LINE), 'value line missing');
    assert.ok(!after.includes(LANGUAGES_PLACEHOLDER), 'placeholder written');
    assert.deepEqual(readVaultLanguages(after).languages, ['fr', 'en']);
    assert.deepEqual(res.vaultLanguages.languages, ['fr', 'en']);
    // Everything but the value line IS the library snippet.
    const expected = renderLanguagesSection(snippet('languages'), ['fr', 'en']).text.replace(/\n+$/, '');
    assert.ok(after.includes(expected), 'rendered section differs from the library snippet');
  });

  test('a string value is accepted the way the owner types it', async () => {
    const v = fakeVault({ 'CLAUDE.md': PREAMBLE });
    const res = await installConventionsTool(registry, { ids: ['languages'], languages: 'FR en' }, v.deps);
    assert.deepEqual(res.vaultLanguages.languages, ['fr', 'en']);
    assert.equal(res.verified, true);
  });

  test('a value that is not ISO 639-1 is refused with the reason, before any I/O', async () => {
    const v = fakeVault({ 'CLAUDE.md': PREAMBLE });
    await assert.rejects(
      () => installConventionsTool(registry, { ids: ['languages'], languages: ['français'] }, v.deps),
      /ISO 639-1/,
    );
    assert.equal(v.calls.length, 0);
  });

  test('a value given for a call that does not name `languages` is refused, not dropped', async () => {
    const v = fakeVault({ 'CLAUDE.md': PREAMBLE });
    await assert.rejects(
      () => installConventionsTool(registry, { ids: ['source-type'], languages: ['fr'] }, v.deps),
      /not among the ids/,
    );
    assert.equal(v.calls.length, 0);
  });

  test('already in place: the value given is NOT written over the vault\'s own', async () => {
    const own = renderLanguagesSection(snippet('languages'), ['fr']).text;
    const v = fakeVault({ 'CLAUDE.md': `${PREAMBLE}\n${own}` });
    const res = await installConventionsTool(registry, { ids: ['languages'], languages: ['fr', 'en'] }, v.deps);
    assert.deepEqual(res.alreadyPresent, ['languages']);
    assert.equal(res.written, false);
    assert.equal(v.writes().length, 0);
    assert.deepEqual(res.vaultLanguages.languages, ['fr']);
  });

  test('a dryRun of `languages` needs no value, and reports the vault\'s current one', async () => {
    const v = fakeVault({ 'CLAUDE.md': PREAMBLE });
    const res = await installConventionsTool(registry, { ids: ['languages'], dryRun: true }, v.deps);
    assert.deepEqual(res.wouldInstall, ['languages']);
    assert.equal(res.vaultLanguages.installed, false);
    assert.equal(v.writes().length, 0);
  });

  test('a retired id is reported in `retired`, never installed — the known ids still install', async () => {
    const v = fakeVault({ 'CLAUDE.md': PREAMBLE });
    const res = await installConventionsTool(registry, { ids: ['bilingual', 'source-type'] }, v.deps);
    assert.deepEqual(res.retired, ['bilingual']);
    assert.deepEqual(res.unknown, []);
    assert.deepEqual(res.installed, ['source-type']);
    assert.equal(res.verified, true);
    const after = v.store.get('CLAUDE.md');
    assert.equal(findConventionSection(after, retiredText('bilingual').split('\n', 1)[0]).found, false);
  });

  test('dryRun lists retired conventions flagged, and detects one a vault still carries', async () => {
    const v = fakeVault({ 'CLAUDE.md': `${PREAMBLE}\n${retiredText('bilingual')}` });
    const res = await installConventionsTool(registry, { ids: [], dryRun: true }, v.deps);
    const bilingual = res.catalogue.find((c) => c.id === 'bilingual');
    assert.ok(bilingual, 'bilingual absent from the catalogue');
    assert.equal(bilingual.retired, true);
    assert.ok(res.catalogue.filter((c) => !c.retired).every((c) => c.retired === undefined));
    assert.equal(res.detection.find((d) => d.id === 'bilingual')?.installed, true);
    assert.equal(res.detection.find((d) => d.id === 'source-type')?.installed, false);
  });

  test('the retired folder is read like the library, and an absent folder is an empty one', () => {
    const cat = loadRetiredCatalogue();
    assert.ok(cat.some((c) => c.id === 'bilingual' && c.retired === true));
    for (const c of cat) assert.equal(c.heading, retiredText(c.id).split('\n', 1)[0]);
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'install-conventions-')), 'nothing-retired');
    assert.deepEqual(loadRetiredCatalogue(dir), []);
  });
});
