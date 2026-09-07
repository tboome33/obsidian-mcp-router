/**
 * Two folders named "Sessions" — the detector, the seed guard, and a sweep over
 * every producer of a catalogue area.
 *
 * The defect this covers is a class, not a site. `wiki-meta/Sessions/` is the
 * home of session journals since v0.12.8; anything that seeds a `Sessions`
 * *area* under `wiki/` gives the same content type a second home, and an agent
 * looking up where a session note belongs finds whichever it reads first. Three
 * producers existed when this was found:
 *
 *   1. `WIKI_MODE_SECTIONS.code` — the one that actually shipped the collision.
 *   2. the shipped catalogue templates, which teach the convention to whoever
 *      reads `.template`.
 *   3. the `domain` mode's sections, composed by an LLM at provisioning time,
 *      which no static list and no review ever sees.
 *
 * So the last group does not assert "the `code` mode has no Sessions". It walks
 * every mode of the real imported object and every catalogue template DISCOVERED
 * under `templates/`, which is what makes a fourth producer fail here instead of
 * shipping.
 *
 * TWO LESSONS FROM THE REVIEW ROUND ARE BUILT INTO THIS FILE.
 *
 * The mode list used to be read by regex out of `scripts/setup-vault.mjs`, and
 * that regex matched single-quoted strings on single lines only: a `"Sessions"`
 * entry, or a new mode written as a multi-line array, was invisible to the very
 * test whose job was to see it. The data now lives in an importable module and
 * the test reads the object. Nothing is parsed, so nothing can be missed.
 *
 * And a scan that finds nothing to look at passes vacuously. Every sweep below
 * therefore asserts its own DENOMINATOR — how many modes, how many templates,
 * how many headings it actually inspected — so a discovery that silently returns
 * an empty set fails instead of going green.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  WIKI_META_OWNED_AREAS,
  PROJECTION_BASENAMES,
  isWikiMetaOwnedArea,
  partitionSeededAreas,
  detectSessionFolderCollision,
} from '../src/helpers/session-folder-collision.mjs';
import { WIKI_MODE_SECTIONS } from '../src/helpers/wiki-mode-sections.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('isWikiMetaOwnedArea', () => {
  test('recognises the owned names, whatever their spelling', () => {
    for (const name of WIKI_META_OWNED_AREAS) {
      assert.equal(isWikiMetaOwnedArea(name), true, name);
      assert.equal(isWikiMetaOwnedArea(name.toLowerCase()), true, `${name} lowercase`);
      assert.equal(isWikiMetaOwnedArea(name.toUpperCase()), true, `${name} uppercase`);
      assert.equal(isWikiMetaOwnedArea(`  ${name}  `), true, `${name} padded`);
      assert.equal(isWikiMetaOwnedArea(`${name}/`), true, `${name} with trailing slash`);
    }
  });

  test('sees through markdown that RENDERS as the owned name', () => {
    // A second review round's finding: `Sessions ##` passed the guard, and the
    // seeder then emitted `## Sessions ##` — a heading Markdown renders as
    // "Sessions". The template sweep asks this same predicate, so the guard and
    // its supposedly independent scan were blind together.
    for (const name of [
      'Sessions ##', 'Sessions #',
      '**Sessions**', '*Sessions*', '_Sessions_', '__Sessions__', '`Sessions`',
      '**sessions** ##', '  **Sessions**  ',
    ]) {
      assert.equal(isWikiMetaOwnedArea(name), true, name);
    }
    // The predicate also answers for the TEMPLATE sweep, which feeds it the
    // text captured from a heading line — so `## Sessions ##` on disk arrives
    // here as `Sessions ##`, already covered above. A section literally NAMED
    // `## Sessions ##` is a different thing and correctly not owned: the seeder
    // emits `## ## Sessions ##`, which renders as the literal text
    // "## Sessions", not as an area called Sessions.
    assert.equal(isWikiMetaOwnedArea('## Sessions ##'), false);
  });

  test('leaves legitimate areas alone', () => {
    for (const name of [
      'Concepts', 'Runbooks', 'Session Notes', 'Sessions de travail', 'People',
      'Sessions & Notes', 'My Sessions', 'Sessions 2026',
      // Interior markup is never stripped — only a WRAPPING pair is.
      'Ses*sions', '**Session** notes',
    ]) {
      assert.equal(isWikiMetaOwnedArea(name), false, name);
    }
  });

  test('non-strings and blanks are not owned', () => {
    for (const junk of [null, undefined, 42, {}, [], '', '   ', '/']) {
      assert.equal(isWikiMetaOwnedArea(junk), false, JSON.stringify(junk));
    }
  });
});

describe('partitionSeededAreas', () => {
  test('rejects an owned name and keeps the rest, in order', () => {
    const { areas, rejected } = partitionSeededAreas(['Codebases', 'Sessions', 'Runbooks']);
    assert.deepEqual(areas, ['Codebases', 'Runbooks']);
    assert.deepEqual(rejected, ['Sessions']);
  });

  test('a rejected section is REPORTED, never silently dropped', () => {
    // The failure mode this guards: an LLM composes `sessions` for a `domain`
    // vault, the guard drops it, and the user sees a catalogue missing an area
    // they asked for with no explanation anywhere.
    const { rejected } = partitionSeededAreas(['sessions']);
    assert.deepEqual(rejected, ['sessions'], 'the original spelling must survive into the warning');
  });

  test('a list with nothing owned passes through untouched', () => {
    const input = ['People', 'Concepts', 'Decisions'];
    const { areas, rejected } = partitionSeededAreas(input);
    assert.deepEqual(areas, input);
    assert.deepEqual(rejected, []);
  });

  test('a non-array yields empty halves rather than throwing', () => {
    for (const junk of [null, undefined, 'Sessions', 7]) {
      assert.deepEqual(partitionSeededAreas(junk), { areas: [], rejected: [] });
    }
  });
});

describe('detectSessionFolderCollision', () => {
  test('the incident: content on both sides is an ERROR', () => {
    const { findings } = detectSessionFolderCollision([
      'wiki/Sessions/2026-09-07-recapitulatif-du-projet.md',
      { path: 'wiki/Sessions/index.md', generated: true },
      'wiki-meta/Sessions/2026-09-06-1200-racontemoi-a1b.md',
      'wiki-meta/Sessions/2026-09-07-0930-racontemoi-c2d.md',
      'wiki/Concepts/okf.md',
      'wiki-meta/catalog.md',
    ]);
    assert.equal(findings.length, 1);
    const [f] = findings;
    assert.equal(f.rule, 'session-folder-collision');
    assert.equal(f.severity, 'error');
    assert.equal(f.area, 'Sessions');
    assert.deepEqual(f.wikiDirs, ['wiki/Sessions']);
    assert.deepEqual(f.metaDirs, ['wiki-meta/Sessions']);
    assert.deepEqual(f.wikiFiles, ['wiki/Sessions/2026-09-07-recapitulatif-du-projet.md']);
    assert.equal(f.metaFiles.length, 2);
  });

  test('the correct state — wiki-meta only — reports nothing', () => {
    const { findings } = detectSessionFolderCollision([
      'wiki-meta/Sessions/2026-09-07-0930-x.md',
      'wiki-meta/Sessions/2026-09-06-1200-y.md',
      'wiki/Concepts/a.md',
      'wiki/index.md',
    ]);
    assert.deepEqual(findings, []);
  });

  test('the pre-v0.12.8 leftover — wiki only — is a WARNING, not an error', () => {
    const { findings } = detectSessionFolderCollision(['wiki/sessions/2025-11-02-old.md']);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].rule, 'session-folder-stray');
    assert.equal(findings[0].severity, 'warning');
    assert.deepEqual(findings[0].wikiDirs, ['wiki/sessions'], 'the on-disk spelling is reported');
    assert.equal(findings[0].area, 'Sessions', 'the canonical name identifies the area');
  });

  test('files the CALLER marked generated do not make a folder look occupied', () => {
    // A generated `index.md` outlives the content that caused it. Counting it
    // would flag exactly the vaults whose misfiled note was just moved away.
    const { findings } = detectSessionFolderCollision([
      { path: 'wiki/Sessions/index.md', generated: true },
      { path: 'wiki/Sessions/log.md', generated: true },
      'wiki-meta/Sessions/2026-09-07-0930-x.md',
    ]);
    assert.deepEqual(findings, []);
  });

  test('a RESERVED BASENAME is not by itself proof a file was generated', () => {
    // The review finding. `planProjectionWrites` treats an unmarked file at a
    // reserved path as a user-owned conflict; assuming the basename meant
    // "generated" made a hand-written wiki/Sessions/index.md invisible.
    const byName = detectSessionFolderCollision([
      'wiki/Sessions/index.md',                       // NOT marked generated
      'wiki-meta/Sessions/2026-09-07-0930-x.md',
    ]);
    assert.equal(byName.findings.length, 1, 'an unmarked index.md under wiki/ is content');
    assert.equal(byName.findings[0].severity, 'error');

    // ...and the mirror image: an unmarked log.md on the wiki-meta side is
    // content too, so a collision must not be downgraded to a stray.
    const mirror = detectSessionFolderCollision([
      'wiki/Sessions/recap.md',
      'wiki-meta/Sessions/log.md',                    // NOT marked generated
    ]);
    assert.equal(mirror.findings[0].rule, 'session-folder-collision');
  });

  test('an explicit generated:false is content, like a bare string', () => {
    const { findings } = detectSessionFolderCollision([
      { path: 'wiki/Sessions/index.md', generated: false },
      { path: 'wiki-meta/Sessions/x.md', generated: false },
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'error');
  });

  test('every reserved basename is reachable as content, not just index.md', () => {
    // Denominator: if PROJECTION_BASENAMES grows, this covers the new one too.
    assert.ok(PROJECTION_BASENAMES.length > 0, 'the reserved list must not be empty');
    for (const basename of PROJECTION_BASENAMES) {
      const { findings } = detectSessionFolderCollision([`wiki/Sessions/${basename}`]);
      assert.equal(findings.length, 1, `an unmarked ${basename} under wiki/Sessions/ must be reported`);
    }
  });

  test('case variants are one area, and every file keeps its OWN directory', () => {
    // The order-dependence defect: one `dir` per side was overwritten by the
    // last file seen, so a file could be reported in a directory it is not in —
    // and reversing the input changed which file was misplaced.
    const inputs = [
      'wiki/Sessions/a.md',
      'wiki/sessions/b.md',
      'wiki-meta/SESSIONS/c.md',
    ];
    const forward = detectSessionFolderCollision(inputs);
    const reversed = detectSessionFolderCollision([...inputs].reverse());

    for (const [label, { findings }] of [['forward', forward], ['reversed', reversed]]) {
      assert.equal(findings.length, 1, `${label}: three spellings must collapse to one finding`);
      assert.equal(findings[0].rule, 'session-folder-collision', label);
      assert.deepEqual(
        findings[0].wikiFiles, ['wiki/Sessions/a.md', 'wiki/sessions/b.md'],
        `${label}: each file keeps the path it was given`,
      );
      assert.deepEqual(findings[0].wikiDirs, ['wiki/Sessions', 'wiki/sessions'], label);
      assert.deepEqual(findings[0].metaDirs, ['wiki-meta/SESSIONS'], label);
    }
    assert.deepEqual(forward.findings, reversed.findings, 'input order must not change the report');
  });

  test('nested files keep their full path', () => {
    const { findings } = detectSessionFolderCollision([
      'wiki/Sessions/2026/09/recap.md',
      'wiki-meta/Sessions/x.md',
    ]);
    assert.deepEqual(findings[0].wikiFiles, ['wiki/Sessions/2026/09/recap.md']);
  });

  test('a nested generated index is still excluded when the caller says so', () => {
    const { findings } = detectSessionFolderCollision([
      { path: 'wiki/Sessions/2026/index.md', generated: true },
      'wiki-meta/Sessions/x.md',
    ]);
    assert.deepEqual(findings, []);
  });

  test('backslashes are normalised into the reported path', () => {
    const { findings } = detectSessionFolderCollision([
      'wiki\\Sessions\\a.md',
      'wiki-meta\\Sessions\\b.md',
    ]);
    assert.deepEqual(findings[0].wikiFiles, ['wiki/Sessions/a.md']);
    assert.deepEqual(findings[0].metaFiles, ['wiki-meta/Sessions/b.md']);
  });

  test('unrelated paths, non-markdown, and junk are ignored', () => {
    const { findings } = detectSessionFolderCollision([
      'Sessions/a.md',              // not under wiki/ or wiki-meta/
      'wiki/Sessions',              // the directory itself, no file
      'wiki/Sessions/notes.txt',    // not markdown
      'archive/wiki/Sessions/a.md', // wiki/ not at the root
      { path: null },
      { generated: true },
      null,
      42,
    ]);
    assert.deepEqual(findings, []);
  });

  test('a non-array input yields no findings rather than throwing', () => {
    for (const junk of [null, undefined, 'wiki/Sessions/a.md', {}]) {
      assert.deepEqual(detectSessionFolderCollision(junk).findings, []);
    }
  });
});

describe('no producer seeds an area a wiki-meta/ folder owns', () => {
  // A sweep, not one assertion per known site — and every sweep states the
  // denominator it actually inspected, so an empty discovery fails loudly
  // instead of passing vacuously.

  test('every wiki mode is clear of owned area names', () => {
    const modes = Object.entries(WIKI_MODE_SECTIONS);
    assert.ok(modes.length >= 4, `expected at least the 4 static modes, got ${modes.length}`);
    let sectionsChecked = 0;
    for (const [mode, sections] of modes) {
      assert.ok(Array.isArray(sections) && sections.length > 0, `mode ${mode} has no sections`);
      for (const section of sections) {
        sectionsChecked += 1;
        assert.equal(
          isWikiMetaOwnedArea(section), false,
          `wiki mode "${mode}" seeds "${section}", which wiki-meta/${section}/ already owns`,
        );
      }
    }
    assert.ok(sectionsChecked >= 16, `only ${sectionsChecked} sections inspected — the sweep has gone blind`);
  });

  test('what the provisioner SEEDS equals the imported list, mode by mode', () => {
    // The behavioural proof, and the one that actually settles "is the imported
    // object the object being used?". A review round showed that asking the
    // question of the SOURCE — is there a second declaration, is the import
    // still written — can always be defeated by a spelling the regex misses.
    // This asks the CLI instead: seed a vault per mode and compare the headings
    // it emitted against the imported array. A shadowing copy, a stale import,
    // a guard that ate a section, and a silent fallback all show up here as a
    // difference in the file that shipped.
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-seed-'));
    try {
      const ref = path.join(workDir, '.template');
      for (const p of ['obsidian-local-rest-api', 'mcp-router-bridge', 'smart-connections']) {
        fs.mkdirSync(path.join(ref, '.obsidian', 'plugins', p), { recursive: true });
        fs.writeFileSync(path.join(ref, '.obsidian', 'plugins', p, 'main.js'), `// ${p}`);
      }
      fs.writeFileSync(
        path.join(ref, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'),
        JSON.stringify({ apiKey: 'REF-SECRET-KEY-0000000000', port: 27123 }));
      fs.writeFileSync(
        path.join(ref, '.obsidian', 'community-plugins.json'),
        JSON.stringify(['obsidian-local-rest-api', 'mcp-router-bridge', 'smart-connections']));
      const cfg = path.join(workDir, 'config.json');
      fs.writeFileSync(cfg, JSON.stringify({ referenceVault: ref, portRegistry: {}, portStart: 27600 }));

      const modes = Object.keys(WIKI_MODE_SECTIONS);
      assert.ok(modes.length >= 4, `only ${modes.length} modes to seed`);
      for (const mode of modes) {
        const target = path.join(workDir, `V-${mode}`);
        const r = spawnSync(
          process.execPath,
          [path.join(REPO_ROOT, 'scripts', 'setup-vault.mjs'), target, '--wiki-mode', mode],
          {
            encoding: 'utf8',
            env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: cfg, OBSIDIAN_ROUTER_NO_AUTO_INSTALL_HOOKS: '1' },
          },
        );
        assert.equal(r.status, 0, `${mode}: ${r.stderr}`);
        const catalog = fs.readFileSync(path.join(target, 'wiki-meta', 'catalog.md'), 'utf8');
        const headings = [...catalog.matchAll(/^##\s+(.*?)\s*$/gm)].map((m) => m[1])
          .filter((h) => h !== 'Wiki Core' && h !== 'How to read this wiki');
        assert.deepEqual(
          headings, [...WIKI_MODE_SECTIONS[mode]],
          `mode "${mode}" seeded ${JSON.stringify(headings)}, not the imported list`,
        );
      }

      // And an UNKNOWN mode must fall back loudly, not seed an empty catalogue.
      // `toString` is the witness: it resolves on Object.prototype, so a bare
      // `WIKI_MODE_SECTIONS[mode] || fallback` never reaches the fallback.
      for (const bogus of ['toString', 'constructor', 'nonsense']) {
        const target = path.join(workDir, `V-bogus-${bogus}`);
        const r = spawnSync(
          process.execPath,
          [path.join(REPO_ROOT, 'scripts', 'setup-vault.mjs'), target, '--wiki-mode', bogus],
          {
            encoding: 'utf8',
            env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: cfg, OBSIDIAN_ROUTER_NO_AUTO_INSTALL_HOOKS: '1' },
          },
        );
        assert.equal(r.status, 0, `${bogus}: ${r.stderr}`);
        const catalog = fs.readFileSync(path.join(target, 'wiki-meta', 'catalog.md'), 'utf8');
        const headings = [...catalog.matchAll(/^##\s+(.*?)\s*$/gm)].map((m) => m[1])
          .filter((h) => h !== 'Wiki Core' && h !== 'How to read this wiki');
        assert.deepEqual(headings, [...WIKI_MODE_SECTIONS.personal], `${bogus} must fall back to personal`);
        assert.match(`${r.stdout}${r.stderr}`, new RegExp(`Unknown --wiki-mode "${bogus}"`), 'and say so');
      }
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('a section that RENDERS as an owned heading never reaches the catalogue', () => {
    // The `## Sessions ##` path, end to end through the real provisioning CLI.
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-render-'));
    try {
      const ref = path.join(workDir, '.template');
      for (const p of ['obsidian-local-rest-api', 'mcp-router-bridge']) {
        fs.mkdirSync(path.join(ref, '.obsidian', 'plugins', p), { recursive: true });
        fs.writeFileSync(path.join(ref, '.obsidian', 'plugins', p, 'main.js'), `// ${p}`);
      }
      fs.writeFileSync(
        path.join(ref, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'),
        JSON.stringify({ apiKey: 'REF-SECRET-KEY-0000000000', port: 27123 }));
      fs.writeFileSync(
        path.join(ref, '.obsidian', 'community-plugins.json'),
        JSON.stringify(['obsidian-local-rest-api', 'mcp-router-bridge']));
      const cfg = path.join(workDir, 'config.json');
      fs.writeFileSync(cfg, JSON.stringify({ referenceVault: ref, portRegistry: {}, portStart: 27700 }));

      const target = path.join(workDir, 'Rendered');
      const r = spawnSync(
        process.execPath,
        [path.join(REPO_ROOT, 'scripts', 'setup-vault.mjs'), target,
          '--wiki-mode', 'domain', '--wiki-sections', 'Interviews,Sessions ##,**Sessions**,Transcripts'],
        {
          encoding: 'utf8',
          env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: cfg, OBSIDIAN_ROUTER_NO_AUTO_INSTALL_HOOKS: '1' },
        },
      );
      assert.equal(r.status, 0, r.stderr);
      const catalog = fs.readFileSync(path.join(target, 'wiki-meta', 'catalog.md'), 'utf8');
      const headings = [...catalog.matchAll(/^##\s+(.*?)\s*$/gm)].map((m) => m[1])
        .filter((h) => h !== 'Wiki Core' && h !== 'How to read this wiki');
      assert.deepEqual(headings, ['Interviews', 'Transcripts']);
      assert.ok(!/Sessions/.test(headings.join('|')), catalog);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('the mode list has exactly one definition, repo-wide', () => {
    // A SECONDARY net, and honestly labelled as one. A review round showed that
    // any source-text question can be defeated by a spelling it does not match
    // (`const unused = 0, WIKI_MODE_SECTIONS = {…}`, a comment between the
    // keyword and the name, a function-local shadow). The load-bearing proof is
    // the behavioural test above, which compares what the CLI actually SEEDS
    // against the imported object and therefore cannot be fooled by any of that.
    // This one exists to name the offending file when a second copy appears —
    // a better failure message than a diff of headings — so it is deliberately
    // over-broad: any occurrence of the identifier followed by `=` counts.
    const occurrences = [];
    const SKIP = new Set(['node_modules', 'mcpb-staging', '.git', '.venv', '.venv-docling', 'coverage', 'dist']);
    const walk = (dir) => {
      let listing;
      try { listing = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of listing) {
        if (SKIP.has(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.(mjs|js|cjs|ts|mts|cts)$/.test(e.name)) continue;
        let body;
        try { body = fs.readFileSync(p, 'utf8'); } catch { continue; }
        // Any binding of the name, however it is written — including inside a
        // multi-declarator `const a = 1, WIKI_MODE_SECTIONS = {…}`. The import
        // in setup-vault.mjs is `import { … } from`, which this does not match.
        if (/\bWIKI_MODE_SECTIONS\s*=[^=]/.test(body)) {
          occurrences.push(path.relative(REPO_ROOT, p).replace(/\\/g, '/'));
        }
      }
    };
    walk(REPO_ROOT);
    assert.deepEqual(
      occurrences.filter((f) => !f.startsWith('tests/')),
      ['src/helpers/wiki-mode-sections.mjs'],
      'a second binding of WIKI_MODE_SECTIONS could shadow the imported one',
    );
  });

  test('the provisioner seeds from that module and nothing else', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'setup-vault.mjs'), 'utf8');
    assert.match(src, /import \{ WIKI_MODE_SECTIONS \} from '\.\.\/src\/helpers\/wiki-mode-sections\.mjs'/);
    assert.match(src, /partitionSeededAreas\(requested\)/, 'the seed must pass through the guard');
  });

  test('no shipped catalogue template carries an owned area heading', () => {
    // DISCOVERED, not listed: a third template added tomorrow is scanned too.
    const templates = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (/^(catalog|index)\.md$/i.test(e.name) && /wiki-meta$/i.test(path.basename(dir))) templates.push(p);
      }
    };
    walk(path.join(REPO_ROOT, 'templates'));
    assert.ok(templates.length >= 2, `expected at least 2 catalogue templates, discovered ${templates.length}`);

    let headingsChecked = 0;
    for (const file of templates) {
      const body = fs.readFileSync(file, 'utf8');
      for (const line of body.split('\n')) {
        const heading = line.match(/^#{2,}\s+(.*?)\s*$/);
        if (!heading) continue;
        headingsChecked += 1;
        assert.equal(
          isWikiMetaOwnedArea(heading[1]), false,
          `${path.relative(REPO_ROOT, file)} has a "## ${heading[1]}" area heading, which wiki-meta/ already owns`,
        );
      }
    }
    assert.ok(headingsChecked >= 5, `only ${headingsChecked} headings inspected — an empty template would pass`);
  });

  test('the fleet CLI reads the marker instead of trusting the basename', () => {
    // Placed in the producer sweep because it proves the OTHER half: the pure
    // detector cannot read a file, so the CLI must decide `generated` for it.
    // A review round showed what happens when nobody does — a hand-written
    // wiki/Sessions/index.md was invisible to a check built to find it.
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-cli-'));
    try {
      fs.mkdirSync(path.join(vault, 'wiki', 'Sessions'), { recursive: true });
      fs.mkdirSync(path.join(vault, 'wiki-meta', 'Sessions'), { recursive: true });
      // Hand-written, at a reserved basename, with NO generated marker.
      fs.writeFileSync(
        path.join(vault, 'wiki', 'Sessions', 'index.md'),
        '---\ntype: index\n---\n\n# Mes sessions\n\nÉcrit à la main.\n',
      );
      fs.writeFileSync(
        path.join(vault, 'wiki-meta', 'Sessions', '2026-09-07-0930-x.md'),
        '---\ntype: session\n---\n\n# Session\n',
      );

      const r = spawnSync(
        process.execPath,
        [path.join(REPO_ROOT, 'scripts', 'okf-projections.mjs'), '--vault', vault],
        { encoding: 'utf8', cwd: REPO_ROOT },
      );
      const out = `${r.stdout}${r.stderr}`;
      assert.match(out, /session-folder-collision/, out);
      assert.match(out, /wiki\/Sessions\/index\.md/, 'the unmarked file must be named');
      assert.equal(r.status, 1, 'a collision exits non-zero');
    } finally {
      fs.rmSync(vault, { recursive: true, force: true });
    }
  });

  test('a MARKED projection under wiki/Sessions/ is excluded by the fleet CLI', () => {
    // The mirror of the test above, and the one that makes the marker read
    // load-bearing. Without it, a mutation that simply stops reading the marker
    // (leaving `generated = false`) passes: the other fixture's file is unmarked
    // and should stay content either way. A review round pointed that out.
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-marked-'));
    try {
      fs.mkdirSync(path.join(vault, 'wiki', 'Sessions'), { recursive: true });
      fs.mkdirSync(path.join(vault, 'wiki-meta', 'Sessions'), { recursive: true });
      fs.writeFileSync(
        path.join(vault, 'wiki', 'Sessions', 'index.md'),
        '# Sessions\n\n> Generated by obsidian-mcp-router — index de navigation généré.\n\n* nothing\n',
      );
      fs.writeFileSync(
        path.join(vault, 'wiki-meta', 'Sessions', '2026-09-07-0930-x.md'),
        '---\ntype: session\n---\n\n# Session\n',
      );

      const r = spawnSync(
        process.execPath,
        [path.join(REPO_ROOT, 'scripts', 'okf-projections.mjs'), '--vault', vault],
        { encoding: 'utf8', cwd: REPO_ROOT },
      );
      const out = `${r.stdout}${r.stderr}`;
      assert.ok(!/session-folder-(collision|stray)/.test(out), `a generated index is not content:\n${out}`);
      assert.equal(r.status, 0, out);
    } finally {
      fs.rmSync(vault, { recursive: true, force: true });
    }
  });

  test('the fleet CLI never prints "could not look" as "nothing is there"', () => {
    // The review finding: a `catch` that returns nothing turns an unreadable
    // directory into an empty one, and the vault gets summarised `ok` after an
    // inspection that never happened. A plain FILE where the scan expects a
    // directory makes readdir throw ENOTDIR — the same shape as a permissions
    // failure, without needing ACLs (which Windows CI cannot rely on).
    //
    // A MISSING directory is a different thing and must stay silent: that is a
    // fact about the vault, not a failure to observe it.
    const run = (vault) => {
      const r = spawnSync(
        process.execPath,
        [path.join(REPO_ROOT, 'scripts', 'okf-projections.mjs'), '--vault', vault],
        { encoding: 'utf8', cwd: REPO_ROOT },
      );
      return `${r.stdout}${r.stderr}`;
    };

    // (a) unreadable side, nothing else wrong → the vault is `partial`, not `ok`.
    const blind = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-blind-'));
    // (b) unreadable side AND a real stray → both are reported.
    const both = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-both-'));
    // (c) wiki-meta simply absent → no complaint at all.
    const absent = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-absent-'));
    try {
      for (const v of [blind, both]) {
        fs.mkdirSync(path.join(v, 'wiki', 'Concepts'), { recursive: true });
        fs.writeFileSync(path.join(v, 'wiki', 'Concepts', 'a.md'), '---\ntype: concept\n---\n\n# A\n');
        fs.writeFileSync(path.join(v, 'wiki-meta'), 'a file where a directory belongs\n');
      }
      fs.mkdirSync(path.join(both, 'wiki', 'Sessions'), { recursive: true });
      fs.writeFileSync(path.join(both, 'wiki', 'Sessions', 'recap.md'), '---\ntype: session\n---\n\n# Recap\n');

      fs.mkdirSync(path.join(absent, 'wiki', 'Concepts'), { recursive: true });
      fs.writeFileSync(path.join(absent, 'wiki', 'Concepts', 'a.md'), '---\ntype: concept\n---\n\n# A\n');

      const blindOut = run(blind);
      assert.match(blindOut, /could not read wiki-meta\/ .*INCOMPLETE/, blindOut);
      assert.match(blindOut, /partial/, 'an incomplete scan must not be summarised as ok');
      assert.ok(!/^\s{2}ok\s/m.test(blindOut), `still printed ok: ${blindOut}`);

      const bothOut = run(both);
      assert.match(bothOut, /session-folder-stray/, bothOut);
      assert.match(bothOut, /wiki\/Sessions\/recap\.md/, bothOut);
      assert.match(bothOut, /could not read wiki-meta\//, 'the incomplete view is still reported');

      const absentOut = run(absent);
      assert.ok(!/could not read/.test(absentOut), `a missing wiki-meta/ is not a failure: ${absentOut}`);
      assert.match(absentOut, /^\s{2}ok\s/m, absentOut);
    } finally {
      for (const v of [blind, both, absent]) fs.rmSync(v, { recursive: true, force: true });
    }
  });

  test('the seeded catalogue tells the reader where session notes DO go', () => {
    // The seed fix alone only removes the wrong answer. An agent looking up
    // where a session recap belongs still needs to find the right one in the
    // file it is already reading — that silence is what produced the incident.
    const setupVaultSrc = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'setup-vault.mjs'), 'utf8');
    assert.match(
      setupVaultSrc,
      /'- `wiki-meta\/Sessions\/` — \*\*where session notes go\*\*/,
      'the mode-seeded catalog.md must name wiki-meta/Sessions/ in its Wiki Core block',
    );
    const skeleton = fs.readFileSync(
      path.join(REPO_ROOT, 'templates', 'reference-vault-skeleton', 'wiki-meta', 'catalog.md'), 'utf8',
    );
    assert.match(skeleton, /`wiki-meta\/Sessions\/` — \*\*where session notes go\*\*/);
  });
});
