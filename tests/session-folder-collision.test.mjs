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
  isWikiMetaOwnedArea,
  ownedAreaFor,
  partitionSeededAreas,
  detectSessionFolderCollision,
  detectCatalogOwnedHeadings,
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

  test('ownedAreaFor names the CANONICAL folder, whatever spelling was rejected', () => {
    // The remedy printed to the operator must name a folder that exists.
    for (const name of ['sessions', 'SESSIONS', '**Sessions**', 'Sessions ##', '  sessions/ ']) {
      assert.equal(ownedAreaFor(name), 'Sessions', name);
    }
    for (const name of ['Concepts', '', null, 7]) {
      assert.equal(ownedAreaFor(name), null, JSON.stringify(name));
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

  test('no basename is special to the detector — only the caller\'s verdict is', () => {
    // The detector holds NO list of reserved names (a second copy of
    // `isProjectionPath`'s rule would drift from it). Every name the router
    // could ever reserve is plain content here unless the caller says otherwise.
    for (const basename of ['index.md', 'log.md', 'Index.md', 'LOG.MD']) {
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

/**
 * The TITLE, not the folder — the half of the trap the folder detector cannot
 * see.
 *
 * `detectSessionFolderCollision` answers "are there files in two places?". The
 * thing that CAUSED the incident is upstream of that: a `## Sessions` area in
 * `wiki-meta/catalog.md` tells the next agent that `wiki/Sessions/` is where a
 * session note belongs, and it says so in a vault where no such folder exists
 * yet — so the folder scan calls that vault clean right up until the moment an
 * agent obeys the catalogue. 16 catalogues of the fleet were in exactly that
 * state on 2026-09-07.
 *
 * The rule reuses `ownedAreaFor`, so it inherits the markdown normalisation the
 * second review round put there — but a shared predicate means a shared blind
 * spot, which is the one shape a pair of checks must never have. That is why
 * the non-matches below are as load-bearing as the matches, and why the fenced
 * block has its own case: a heading is a heading only where markdown says it is.
 */
describe('detectCatalogOwnedHeadings', () => {
  test('a plain owned area heading is reported, with its 1-based line', () => {
    const catalog = '# Catalog\n\n## People\n\n## Sessions\n\n_(none yet)_\n';
    const findings = detectCatalogOwnedHeadings(catalog);
    assert.equal(findings.length, 1);
    assert.deepEqual(findings[0], {
      rule: 'catalog-sessions-heading',
      severity: 'warning',
      area: 'Sessions',
      heading: 'Sessions',
      line: 5,
    });
  });

  test('the spellings that RENDER as the owned name are caught too', () => {
    for (const heading of ['## Sessions ##', '## **Sessions**', '##   sessions  ', '### Sessions']) {
      const findings = detectCatalogOwnedHeadings(`# Catalog\n\n${heading}\n`);
      assert.equal(findings.length, 1, `expected a finding for ${JSON.stringify(heading)}`);
      assert.equal(findings[0].area, 'Sessions', 'the CANONICAL spelling, whatever the markup');
      assert.equal(findings[0].line, 3);
    }
  });

  test('the raw heading text is preserved so the reader can find it in the file', () => {
    const [finding] = detectCatalogOwnedHeadings('# Catalog\n\n## **Sessions**\n');
    assert.equal(finding.heading, '**Sessions**', 'what is literally on the line');
    assert.equal(finding.area, 'Sessions', 'what it renders as');
  });

  test('a name that merely CONTAINS the owned word is not an owned area', () => {
    for (const heading of ['## Sessions de travail', '## My Sessions', '## Session', '## Sessions Archive']) {
      assert.deepEqual(
        detectCatalogOwnedHeadings(`# Catalog\n\n${heading}\n`),
        [],
        `${JSON.stringify(heading)} is a legitimate area name`,
      );
    }
  });

  test('a level-1 title is not an area', () => {
    assert.deepEqual(detectCatalogOwnedHeadings('# Sessions\n\nbody\n'), []);
  });

  test('a heading inside a fenced code block does not count', () => {
    const catalog = [
      '# Catalog',
      '',
      'Example of what NOT to write:',
      '',
      '```markdown',
      '## Sessions',
      '```',
      '',
      '## People',
      '',
    ].join('\n');
    assert.deepEqual(detectCatalogOwnedHeadings(catalog), []);
  });

  test('a fence that closes lets a later real heading be seen again', () => {
    const catalog = '# Catalog\n\n```\n## Sessions\n```\n\n## Sessions\n';
    const findings = detectCatalogOwnedHeadings(catalog);
    assert.equal(findings.length, 1, 'the fenced one is text, the one after it is a heading');
    assert.equal(findings[0].line, 7);
  });

  test('a tilde fence hides a heading just like a backtick one', () => {
    assert.deepEqual(detectCatalogOwnedHeadings('# Catalog\n\n~~~\n## Sessions\n~~~\n'), []);
  });

  test('a list line that merely mentions the markup is not a heading', () => {
    const catalog = '# Catalog\n\n- never write `## Sessions` here\n- ## Sessions is not a heading either\n';
    assert.deepEqual(detectCatalogOwnedHeadings(catalog), []);
  });

  test('an indented code block (4 spaces) is not a heading', () => {
    assert.deepEqual(detectCatalogOwnedHeadings('# Catalog\n\n    ## Sessions\n'), []);
  });

  test('every owned area is covered by the rule, not just the one we know', () => {
    assert.ok(WIKI_META_OWNED_AREAS.length >= 1, 'denominator: the sweep must have something to inspect');
    for (const area of WIKI_META_OWNED_AREAS) {
      const findings = detectCatalogOwnedHeadings(`# Catalog\n\n## ${area}\n`);
      assert.equal(findings.length, 1, `no rule covers the owned area ${area}`);
      assert.equal(findings[0].area, area);
    }
  });

  test('several headings in one catalogue are all reported, in file order', () => {
    const catalog = '# Catalog\n\n## Sessions\n\n## People\n\n## sessions\n';
    const findings = detectCatalogOwnedHeadings(catalog);
    assert.deepEqual(findings.map((f) => f.line), [3, 7]);
  });

  test('a non-string input yields no findings rather than throwing', () => {
    for (const junk of [null, undefined, 42, {}, ['## Sessions']]) {
      assert.deepEqual(detectCatalogOwnedHeadings(junk), []);
    }
  });

  // ---------------------------------------------------------------------------
  // The cases an adversarial review round produced. Every one of them is a place
  // where "is this line a heading?" — the half this function owns alone, since
  // the NAME half is delegated to `ownedAreaFor` — disagreed with how the file
  // actually renders. A false positive matters as much as a false negative here:
  // the finding tells a human to delete a section, so pointing at a line that
  // renders as nothing trains them to ignore the rule.
  // ---------------------------------------------------------------------------

  test('a heading inside an HTML comment does not count', () => {
    assert.deepEqual(
      detectCatalogOwnedHeadings('# Catalog\n\n<!--\n## Sessions\n-->\n'),
      [],
      'commented-out markup renders as nothing — there is no section to remove',
    );
  });

  test('a comment that closes lets a later real heading be seen again', () => {
    const findings = detectCatalogOwnedHeadings('# Catalog\n\n<!--\n## Sessions\n-->\n\n## Sessions\n');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].line, 7);
  });

  test('a one-line HTML comment does not swallow the rest of the file', () => {
    const findings = detectCatalogOwnedHeadings('# Catalog\n\n<!-- todo -->\n\n## Sessions\n');
    assert.equal(findings.length, 1, 'the comment opened and closed on its own line');
    assert.equal(findings[0].line, 5);
  });

  test('the ATX separator is a space or a tab — not any unicode whitespace', () => {
    // `##<NBSP>Sessions` is NOT a heading: CommonMark requires a space or tab
    // after the hashes. Built with fromCharCode so the byte is unambiguous in
    // the source rather than an invisible character a future edit could eat.
    // Each rejected character is built with fromCharCode so the byte is
    // unambiguous in the source. A form feed and a vertical tab are `\s` but not
    // ATX separators — without them, `[ \t\f\v]+` would pass this witness.
    for (const code of [0x00a0, 0x000c, 0x000b, 0x2003]) {
      const ws = String.fromCharCode(code);
      assert.deepEqual(
        detectCatalogOwnedHeadings(`# Catalog\n\n##${ws}Sessions\n`),
        [],
        `U+${code.toString(16).padStart(4, '0')} is not an ATX separator`,
      );
    }
    assert.equal(detectCatalogOwnedHeadings('# Catalog\n\n##\tSessions\n').length, 1, 'a tab IS a separator');
    assert.equal(detectCatalogOwnedHeadings('# Catalog\n\n## Sessions\n').length, 1, 'a space IS a separator');
  });

  test('a backtick fence whose info string contains a backtick is not a fence', () => {
    // ```lang`oops does not open a code block, so the line after it is a real
    // heading. Treating it as an opener hides one. Tested at three AND four
    // backticks, so an implementation that special-cases the exact-three form
    // does not survive.
    for (const marker of ['```', '````']) {
      const findings = detectCatalogOwnedHeadings(`# Catalog\n\n${marker}lang\`oops\n## Sessions\n`);
      assert.equal(findings.length, 1, `the invalid ${marker.length}-backtick opener must not hide the heading`);
      assert.equal(findings[0].line, 4);
    }
    // A TILDE fence has no such restriction: a backtick in its info is fine, so
    // this one really does open a block and hide the heading.
    assert.deepEqual(detectCatalogOwnedHeadings('# Catalog\n\n~~~lang`ok\n## Sessions\n'), []);
  });

  test('a closing fence may carry only spaces or tabs after it', () => {
    // With an NBSP after the closing fence the block is STILL OPEN, so the
    // line below is code, not a heading.
    const nbsp = String.fromCharCode(0x00a0);
    assert.deepEqual(
      detectCatalogOwnedHeadings(`# Catalog\n\n\`\`\`\nexample\n\`\`\`${nbsp}\n## Sessions\n`),
      [],
    );
    // ...and the mirror, so an implementation that demands `/^ *$/` and rejects
    // a legitimate trailing TAB does not survive either.
    const closed = detectCatalogOwnedHeadings('# Catalog\n\n```\nexample\n```\t\n## Sessions\n');
    assert.equal(closed.length, 1, 'a trailing tab closes the block');
    assert.equal(closed[0].line, 6);
  });

  test('a fence inside a list item does not desynchronise the scanner', () => {
    // Both directions in one input: the indented fenced heading must NOT be
    // reported, and the real top-level heading after the list MUST be.
    const catalog = [
      '# Catalog',
      '',
      '- example:',
      '  ```markdown',
      '  ## Sessions',
      '  ```',
      '',
      '## Sessions',
      '',
    ].join('\n');
    const findings = detectCatalogOwnedHeadings(catalog);
    assert.equal(findings.length, 1, `expected only the real heading, got ${JSON.stringify(findings)}`);
    assert.equal(findings[0].line, 8);
  });

  test('a fence opened ON the list-marker line does not desynchronise it either', () => {
    // The harder shape: the opener shares its line with the bullet, so a
    // scanner that only looks at column 0-3 misses it — then reports the fenced
    // heading AND takes the real closer for an opener, hiding the heading that
    // follows. One input, both failures.
    const catalog = [
      '# Catalog',
      '',
      '- ```markdown',
      '  ## Sessions',
      '  ```',
      '',
      '## Sessions',
      '',
    ].join('\n');
    const findings = detectCatalogOwnedHeadings(catalog);
    assert.equal(findings.length, 1, `expected only the real heading, got ${JSON.stringify(findings)}`);
    assert.equal(findings[0].line, 7);
  });

  // ---------------------------------------------------------------------------
  // Adversarial review round 2 — the counterexamples that broke the round-1
  // REPAIRS. Container-prefix stripping and substring comment detection each
  // fixed their own case and created a worse one: a line of literal code became
  // a closing fence, and a backtick-quoted `<!--` swallowed the rest of the
  // file. Both repairs were withdrawn in favour of a scanner that only claims
  // what it can hold: column 0, no container tracking at all.
  // ---------------------------------------------------------------------------

  test('a fence marker inside literal code does not close the block', () => {
    // The bullet-looking line is CODE. Stripping its prefix turned it into a
    // closer, which reported the line below and left the real closer opening a
    // new block.
    assert.deepEqual(
      detectCatalogOwnedHeadings('```\n- ```\n## Sessions\n```\n'),
      [],
      'line 3 is inside a fenced block',
    );
  });

  test('a fence inside a blockquote never opens the global state', () => {
    const findings = detectCatalogOwnedHeadings('> ```\n> example\n\n## Sessions\n');
    assert.equal(findings.length, 1, 'the quote ended; the top-level heading is real');
    assert.equal(findings[0].line, 4);
  });

  test('a fence inside an ordered list never opens the global state', () => {
    const findings = detectCatalogOwnedHeadings('10. ```\n    example\n    ```\n\n## Sessions\n');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].line, 5);
  });

  test('an indented-code line after a bullet does not open a fence', () => {
    const findings = detectCatalogOwnedHeadings('-     ```\n\n## Sessions\n');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].line, 3);
  });

  test('a digit that cannot start a list does not manufacture a fence', () => {
    const findings = detectCatalogOwnedHeadings('paragraph\n2. ```\n## Sessions\n');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].line, 3);
  });

  test('a backtick-quoted comment opener does not swallow the rest of the file', () => {
    const findings = detectCatalogOwnedHeadings('Use `<!--` literally.\n\n## Sessions\n');
    assert.equal(findings.length, 1, 'the comment marker was inline code, not an HTML block');
    assert.equal(findings[0].line, 3);
  });

  test('a fence whose info string contains a comment opener is still a fence', () => {
    const findings = detectCatalogOwnedHeadings('```html <!--\nexample\n```\n\n## Sessions\n');
    assert.equal(findings.length, 1, 'the fence opened and closed; line 5 is a real heading');
    assert.equal(findings[0].line, 5);
  });

  test('a heading indented inside a list item is not a top-level AREA', () => {
    assert.deepEqual(detectCatalogOwnedHeadings('- item\n  ## Sessions\n'), []);
  });

  test('a heading nested in a list item or a quote is not an AREA of the catalogue', () => {
    // The rule is about the catalogue's top-level areas. A `##` inside a
    // container renders as a heading, but it is not a section of the document
    // the reader navigates by — and the seeded Wiki Core bullet legitimately
    // mentions the markup in prose.
    for (const line of ['- ## Sessions', '> ## Sessions', '  - ## Sessions']) {
      assert.deepEqual(
        detectCatalogOwnedHeadings(`# Catalog\n\n${line}\n`),
        [],
        `${JSON.stringify(line)} is not a catalogue area`,
      );
    }
  });

  test('CRLF line endings do not break the line numbering', () => {
    const [finding] = detectCatalogOwnedHeadings('# Catalog\r\n\r\n## Sessions\r\n');
    assert.equal(finding.line, 3);
    assert.equal(finding.heading, 'Sessions', 'no stray carriage return in the reported text');
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
      // The remedy names the folder that EXISTS, not the rejected markup.
      const out = `${r.stdout}${r.stderr}`;
      assert.match(out, /"\*\*Sessions\*\*" NOT seeded[^\n]*wiki-meta\/Sessions\//, out);
      assert.ok(!/wiki-meta\/\*\*Sessions\*\*\//.test(out), 'markup must not leak into the folder name');
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

  test('"reserved" is isProjectionPath\'s word: a marked wiki/Sessions/log.md is still content', () => {
    // The router generates `index.md` at any depth under wiki/ and `log.md` at
    // the ROOT only. A `wiki/Sessions/log.md` can therefore never be a
    // projection, marker or not — a hand-written note that happens to open with
    // the marker line (a page ABOUT projections, say) must not vanish from the
    // scan. The CLI asks `isProjectionPath`, never a basename list of its own.
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-log-'));
    try {
      fs.mkdirSync(path.join(vault, 'wiki', 'Sessions'), { recursive: true });
      fs.mkdirSync(path.join(vault, 'wiki-meta', 'Sessions'), { recursive: true });
      fs.writeFileSync(
        path.join(vault, 'wiki', 'Sessions', 'log.md'),
        '# Notes\n\n> Generated by obsidian-mcp-router — quoted on purpose.\n\nHand-written.\n',
      );
      fs.writeFileSync(path.join(vault, 'wiki-meta', 'Sessions', 'x.md'), '---\ntype: session\n---\n\n# S\n');
      const r = spawnSync(
        process.execPath,
        [path.join(REPO_ROOT, 'scripts', 'okf-projections.mjs'), '--vault', vault],
        { encoding: 'utf8', cwd: REPO_ROOT },
      );
      const out = `${r.stdout}${r.stderr}`;
      assert.match(out, /session-folder-collision/, out);
      assert.match(out, /wiki\/Sessions\/log\.md/, out);
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

  test('the fleet CLI reports a catalogue heading, and a warning does NOT fail the run', () => {
    // The heading half of Check O, end to end. This vault has NO misfiled file —
    // the folder detector calls it clean — and that is exactly the state 16
    // catalogues of the fleet were in: a signpost pointing at a folder nobody
    // has created yet. The exit code is the load-bearing assertion: the contract
    // at the top of the CLI says only a collision (error) exits 1, and a rule
    // that quietly started failing runs would break every caller of the fleet
    // sweep.
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-heading-'));
    try {
      fs.mkdirSync(path.join(vault, 'wiki', 'Concepts'), { recursive: true });
      fs.writeFileSync(path.join(vault, 'wiki', 'Concepts', 'a.md'), '---\ntype: concept\n---\n\n# A\n');
      fs.mkdirSync(path.join(vault, 'wiki-meta'), { recursive: true });
      fs.writeFileSync(
        path.join(vault, 'wiki-meta', 'catalog.md'),
        '---\ntype: wiki-index\n---\n\n# Catalog\n\n## Concepts\n\n## Sessions\n\n_(none yet)_\n',
      );

      const r = spawnSync(
        process.execPath,
        [path.join(REPO_ROOT, 'scripts', 'okf-projections.mjs'), '--vault', vault],
        { encoding: 'utf8', cwd: REPO_ROOT },
      );
      const out = `${r.stdout}${r.stderr}`;
      assert.match(out, /catalog-sessions-heading/, out);
      assert.match(out, /line 9/, 'the finding names the line to edit');
      assert.equal(r.status, 0, `a warning keeps the exit code at 0:\n${out}`);
      assert.ok(!/^\s{2}ok\s/m.test(out), 'a vault with a finding is not summarised ok');
    } finally {
      fs.rmSync(vault, { recursive: true, force: true });
    }
  });

  test('the fleet CLI reads the catalogue under its LEGACY name too', () => {
    // A vault still on the pre-0.58.0 scaffold names must not be silently
    // exempt from the rule. The candidate list is `scaffoldCandidates`, not a
    // second copy of the two names kept here.
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-legacy-'));
    try {
      fs.mkdirSync(path.join(vault, 'wiki', 'Concepts'), { recursive: true });
      fs.writeFileSync(path.join(vault, 'wiki', 'Concepts', 'a.md'), '---\ntype: concept\n---\n\n# A\n');
      fs.mkdirSync(path.join(vault, 'wiki-meta'), { recursive: true });
      fs.writeFileSync(path.join(vault, 'wiki-meta', 'index.md'), '# Catalog\n\n## Sessions\n');

      const r = spawnSync(
        process.execPath,
        [path.join(REPO_ROOT, 'scripts', 'okf-projections.mjs'), '--vault', vault],
        { encoding: 'utf8', cwd: REPO_ROOT },
      );
      const out = `${r.stdout}${r.stderr}`;
      assert.match(out, /catalog-sessions-heading/, out);
      assert.match(out, /wiki-meta\/index\.md/, 'the finding names the file it actually read');
    } finally {
      fs.rmSync(vault, { recursive: true, force: true });
    }
  });

  test('a catalogue that cannot be READ is `partial`, never `ok`', () => {
    // Same rule as the directory scan, applied to the new read: "I could not
    // look" must never be printed as "there is nothing there". A DIRECTORY where
    // the catalogue belongs makes readFileSync throw EISDIR — a genuine
    // non-ENOENT failure that needs no ACLs, so it behaves the same on Windows.
    //
    // And the mirror: a vault with NO catalogue at all stays silent and `ok`.
    const run = (vault) => {
      const r = spawnSync(
        process.execPath,
        [path.join(REPO_ROOT, 'scripts', 'okf-projections.mjs'), '--vault', vault],
        { encoding: 'utf8', cwd: REPO_ROOT },
      );
      return { out: `${r.stdout}${r.stderr}`, status: r.status };
    };

    const blind = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-cat-blind-'));
    const none = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-cat-none-'));
    try {
      for (const v of [blind, none]) {
        fs.mkdirSync(path.join(v, 'wiki', 'Concepts'), { recursive: true });
        fs.writeFileSync(path.join(v, 'wiki', 'Concepts', 'a.md'), '---\ntype: concept\n---\n\n# A\n');
        fs.mkdirSync(path.join(v, 'wiki-meta'), { recursive: true });
      }
      fs.mkdirSync(path.join(blind, 'wiki-meta', 'catalog.md'));

      const blindRun = run(blind);
      assert.match(blindRun.out, /could not read wiki-meta\/catalog\.md/, blindRun.out);
      assert.match(blindRun.out, /partial/, 'an unread catalogue leaves the heading question open');
      assert.ok(!/^\s{2}ok\s/m.test(blindRun.out), `still printed ok:\n${blindRun.out}`);
      assert.equal(blindRun.status, 0, 'unreadable is not a conflict');

      const noneRun = run(none);
      assert.ok(!/could not read/.test(noneRun.out), `a missing catalogue is a fact, not a failure:\n${noneRun.out}`);
      assert.match(noneRun.out, /^\s{2}ok\s/m, noneRun.out);
    } finally {
      for (const v of [blind, none]) fs.rmSync(v, { recursive: true, force: true });
    }
  });

  test('an unreadable catalogue NEXT TO a finding still never prints ok', () => {
    // The status word is the most actionable one — `sessions` outranks
    // `partial`, exactly as it already did for the directory scan. The
    // load-bearing invariant is narrower and is what this pins: a vault whose
    // view was incomplete is NEVER summarised `ok`, and the incompleteness is
    // printed whatever the status word says. (Adversarial review round 1 was
    // right that "always `partial`" was the wrong claim.)
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-cat-mixed-'));
    try {
      fs.mkdirSync(path.join(vault, 'wiki', 'Sessions'), { recursive: true });
      fs.writeFileSync(path.join(vault, 'wiki', 'Sessions', 'recap.md'), '---\ntype: session\n---\n\n# Recap\n');
      fs.mkdirSync(path.join(vault, 'wiki-meta'), { recursive: true });
      fs.mkdirSync(path.join(vault, 'wiki-meta', 'catalog.md'));

      const r = spawnSync(
        process.execPath,
        [path.join(REPO_ROOT, 'scripts', 'okf-projections.mjs'), '--vault', vault],
        { encoding: 'utf8', cwd: REPO_ROOT },
      );
      const out = `${r.stdout}${r.stderr}`;
      assert.match(out, /session-folder-stray/, out);
      assert.match(out, /could not read wiki-meta\/catalog\.md/, 'the incomplete view is still printed');
      assert.ok(!/^\s{2}ok\s/m.test(out), `an incomplete scan must never read as ok:\n${out}`);
    } finally {
      fs.rmSync(vault, { recursive: true, force: true });
    }
  });

  test('a collision and a heading in one vault: both reported, exit 1 from the collision', () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-mixed-'));
    try {
      fs.mkdirSync(path.join(vault, 'wiki', 'Sessions'), { recursive: true });
      fs.mkdirSync(path.join(vault, 'wiki-meta', 'Sessions'), { recursive: true });
      fs.writeFileSync(path.join(vault, 'wiki', 'Sessions', 'recap.md'), '---\ntype: session\n---\n\n# Recap\n');
      fs.writeFileSync(
        path.join(vault, 'wiki-meta', 'Sessions', '2026-09-07-0930-x.md'),
        '---\ntype: session\n---\n\n# Session\n',
      );
      fs.writeFileSync(path.join(vault, 'wiki-meta', 'catalog.md'), '# Catalog\n\n## Sessions\n');

      const r = spawnSync(
        process.execPath,
        [path.join(REPO_ROOT, 'scripts', 'okf-projections.mjs'), '--vault', vault],
        { encoding: 'utf8', cwd: REPO_ROOT },
      );
      const out = `${r.stdout}${r.stderr}`;
      assert.match(out, /session-folder-collision/, out);
      assert.match(out, /catalog-sessions-heading/, 'the heading is reported alongside the collision');
      assert.equal(r.status, 1, 'the ERROR still fails the run');
    } finally {
      fs.rmSync(vault, { recursive: true, force: true });
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
