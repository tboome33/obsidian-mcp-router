/**
 * The `languages` convention — decision `convention-languages-remplace-bilingual`
 * (accepted 2026-09-26).
 *
 * One describe per rule the change claims, so a mutation of one rule has one
 * declared witness: the snippet's shape, the value parser, the reader, the
 * render, the drift mask, the retired catalogue, the audit, the brief, the
 * write-time checks, and the migration a vault goes through (remove bilingual,
 * add languages, nothing else moves).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LANGUAGES_HEADING,
  LANGUAGES_PLACEHOLDER,
  BILINGUAL_EQUIVALENT,
  CHECKABLE_LANGUAGES,
  SHORT_PAGE_WORDS,
  parseLanguagesValue,
  readVaultLanguages,
  renderLanguagesSection,
  maskLanguagesValue,
  checkPageLanguages,
} from '../src/helpers/convention-languages.mjs';
import { loadConventionCatalogue, SNIPPETS_DIR, RETIRED_DIR } from '../src/helpers/convention-catalogue.mjs';
import { auditVaultConventions, RECOMMENDED_CONVENTION_IDS } from '../src/helpers/conventions-audit.mjs';
import { compareConvention, DRIFT_STATUS } from '../src/helpers/convention-drift.mjs';
import { checkWrittenPage } from '../src/helpers/write-time-page-checks.mjs';
import { buildConventionsBrief, createConventionsBriefing } from '../src/tools/vault-conventions.mjs';
import {
  findConventionSection, isConventionInstalled, removeConvention, verifyRemoval,
} from '../src/helpers/claude-md-conventions.mjs';
import { scanAtxHeadings } from '../src/helpers/markdown-headings.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
const lf = (t) => t.replace(/\r\n/g, '\n');
const SNIPPET = lf(fs.readFileSync(path.join(SNIPPETS_DIR, 'languages.md'), 'utf8'));
const BILINGUAL = lf(fs.readFileSync(path.join(RETIRED_DIR, 'bilingual.md'), 'utf8'));
const { catalogue: CATALOGUE } = loadConventionCatalogue();

/** A flag built from its region code, the way the module builds it. */
const flag = (r) => String.fromCodePoint(...[...r].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));

function rendered(langs) {
  const r = renderLanguagesSection(SNIPPET, langs);
  assert.equal(r.ok, true, r.error);
  return r.text;
}

/** A page of `words` words, with frontmatter and the given H2 sections. */
function page({ language, sections = [], words = 600, type = 'concept' }) {
  const fm = ['---', `type: ${type}`, ...(language === undefined ? [] : [`language: [${language}]`]), '---', ''];
  const per = Math.ceil(words / Math.max(sections.length, 1));
  const body = sections.length
    ? sections.map((s) => `## ${s}\n\n${'mot '.repeat(per)}\n`).join('\n')
    : `${'mot '.repeat(words)}\n`;
  return `${fm.join('\n')}\n# Title\n\n${body}`;
}

describe('the snippet', () => {
  test('its identity heading is the constant every reader looks for', () => {
    const first = scanAtxHeadings(SNIPPET)[0];
    assert.equal(first.level, 2);
    assert.equal(first.text, LANGUAGES_HEADING);
  });

  test('it holds exactly one value line, carrying the placeholder', () => {
    const lines = SNIPPET.split('\n').filter((l) => l.startsWith('**Languages of this vault:'));
    assert.deepEqual(lines, [`**Languages of this vault: ${LANGUAGES_PLACEHOLDER}**`]);
  });

  test('it keeps the multi-language layout bilingual taught — one H2 per language, inside a fence', () => {
    assert.ok(SNIPPET.includes('## 🇫🇷 Version française'));
    assert.ok(SNIPPET.includes('## 🇬🇧 English version'));
    // Fenced: the section scanner must not see them as headings of the convention.
    const h2 = scanAtxHeadings(SNIPPET).filter((h) => h.level === 2);
    assert.equal(h2.length, 1, 'only the identity heading is a real H2');
  });

  test('it states the single-language rule: whatever the language of the conversation', () => {
    assert.match(SNIPPET, /whatever the language of the conversation/);
  });
});

describe('parseLanguagesValue', () => {
  test('accepts the spellings an owner types', () => {
    for (const [raw, want] of [['fr', ['fr']], ['fr, en', ['fr', 'en']], ['FR EN', ['fr', 'en']], ['[fr, en]', ['fr', 'en']], ['en;fr', ['en', 'fr']]]) {
      assert.deepEqual(parseLanguagesValue(raw), { ok: true, languages: want }, raw);
    }
  });

  test('keeps the ORDER — the first code is the primary language', () => {
    // Both directions, and one that sorting would reorder: an input already in
    // alphabetical order (`en, fr`) cannot tell "kept" from "sorted" — the
    // first version of this test used only that one and survived its mutation.
    assert.deepEqual(parseLanguagesValue('fr, en').languages, ['fr', 'en']);
    assert.deepEqual(parseLanguagesValue('en, fr').languages, ['en', 'fr']);
  });

  test('refuses what is not a two-letter code, an empty list, and a repeat', () => {
    assert.match(parseLanguagesValue('français').error, /not ISO 639-1/);
    assert.match(parseLanguagesValue('fr-FR').error, /not ISO 639-1/);
    assert.match(parseLanguagesValue('').error, /no language code/);
    assert.match(parseLanguagesValue('fr, fr').error, /more than once/);
    assert.equal(parseLanguagesValue(null).ok, false);
  });
});

describe('renderLanguagesSection', () => {
  test('fills the placeholder and nothing else', () => {
    const out = rendered(['fr', 'en']);
    const diff = out.split('\n').filter((l, i) => l !== SNIPPET.split('\n')[i]);
    assert.deepEqual(diff, ['**Languages of this vault: fr, en**']);
  });

  test('refuses a bad value rather than installing a section that declares nothing', () => {
    assert.equal(renderLanguagesSection(SNIPPET, 'français').ok, false);
  });

  test('refuses a snippet without exactly one placeholder line', () => {
    assert.match(renderLanguagesSection(SNIPPET.replace(/^\*\*Languages.*$/m, ''), 'fr').error, /exactly one value line, it holds 0/);
    assert.match(renderLanguagesSection(`${SNIPPET}\n**Languages of this vault: <languages>**\n`, 'fr').error, /it holds 2/);
    assert.match(renderLanguagesSection(rendered(['fr']), 'en').error, /does not hold the placeholder/);
  });

  test('keeps a CRLF line CRLF', () => {
    const crlf = SNIPPET.replace(/\n/g, '\r\n');
    const out = renderLanguagesSection(crlf, 'fr');
    assert.ok(out.text.includes('**Languages of this vault: fr**\r\n'));
  });
});

describe('readVaultLanguages', () => {
  const doc = (section) => `# Conventions\n\nPreamble.\n\n${section}\n## Next\n\nx\n`;

  test('reads the declared list', () => {
    assert.deepEqual(readVaultLanguages(doc(rendered(['fr', 'en']))), {
      installed: true, languages: ['fr', 'en'], problem: null, detail: null, raw: 'fr, en',
    });
  });

  test('an absent convention is not a problem', () => {
    assert.deepEqual(readVaultLanguages('# x\n'), { installed: false, languages: null, problem: null, detail: null, raw: null });
  });

  test('names each way an installed section fails to say anything', () => {
    assert.equal(readVaultLanguages(doc(SNIPPET.replace(/^\*\*Languages.*$/m, 'no value here'))).problem, 'missing-value');
    assert.equal(readVaultLanguages(doc(`${rendered(['fr'])}\n**Languages of this vault: en**\n`)).problem, 'ambiguous-value');
    assert.equal(readVaultLanguages(doc(SNIPPET)).problem, 'invalid-value', 'the unfilled placeholder is not a value');
    assert.equal(readVaultLanguages(doc(`${rendered(['fr'])}\n${rendered(['en'])}`)).problem, 'duplicate-section');
  });

  test('a value line OUTSIDE the section does not count', () => {
    const out = readVaultLanguages(`**Languages of this vault: en**\n\n${SNIPPET.replace(/^\*\*Languages.*$/m, '')}`);
    assert.equal(out.problem, 'missing-value');
  });
});

describe('the drift detector compares the rule, never the value', () => {
  const snippet = { id: 'languages', heading: LANGUAGES_HEADING, text: SNIPPET };

  test('two vaults with different languages are both in step', () => {
    for (const langs of [['fr'], ['fr', 'en'], ['en']]) {
      assert.equal(compareConvention(snippet, `# C\n\n${rendered(langs)}`).status, DRIFT_STATUS.IDENTICAL, langs.join(','));
    }
  });

  test('a damaged value line is NOT masked — it still reads as drift', () => {
    const invalid = rendered(['fr']).replace('fr**', 'français**');
    assert.equal(compareConvention(snippet, `# C\n\n${invalid}`).status, DRIFT_STATUS.DRIFT);
    const doubled = rendered(['fr']).replace(/(\*\*Languages of this vault: fr\*\*)/, '$1\n**Languages of this vault: en**');
    assert.equal(compareConvention(snippet, `# C\n\n${doubled}`).status, DRIFT_STATUS.DRIFT);
  });

  test('an edit to the RULE still reads as drift, whatever the value', () => {
    const edited = rendered(['fr']).replace('whatever the language of the conversation', 'unless the user writes in English');
    assert.equal(compareConvention(snippet, `# C\n\n${edited}`).status, DRIFT_STATUS.DRIFT);
  });

  test('the mask applies to the languages convention only', () => {
    const other = { id: 'other', heading: 'Other', text: '## Other\n\n**Languages of this vault: <languages>**\n' };
    assert.equal(compareConvention(other, '## Other\n\n**Languages of this vault: fr**\n').status, DRIFT_STATUS.DRIFT);
  });

  test('maskLanguagesValue leaves an unreadable section byte-identical', () => {
    assert.equal(maskLanguagesValue(SNIPPET), SNIPPET);
    const two = `${rendered(['fr'])}\n**Languages of this vault: en**\n`;
    assert.equal(maskLanguagesValue(two), two);
  });
});

describe('the catalogue: bilingual is recognised, never offered', () => {
  test('the server catalogue carries languages offered and bilingual retired', () => {
    const lang = CATALOGUE.find((c) => c.id === 'languages');
    const bil = CATALOGUE.find((c) => c.id === 'bilingual');
    assert.ok(lang && !lang.retired);
    assert.equal(bil?.retired, true);
    assert.equal(bil.heading, 'Bilingual convention (FR + EN, FR primary)');
  });

  test('the picker globs the library, and the library no longer holds bilingual', () => {
    const offered = fs.readdirSync(SNIPPETS_DIR).filter((f) => f.endsWith('.md'));
    assert.ok(offered.includes('languages.md'));
    assert.ok(!offered.includes('bilingual.md'));
  });

  test('a convention both offered and retired is an error, not a merge', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-'));
    try {
      const lib = path.join(root, 'snippets');
      const ret = path.join(root, 'retired');
      fs.mkdirSync(lib); fs.mkdirSync(ret);
      fs.writeFileSync(path.join(lib, 'x.md'), '## X\n');
      fs.writeFileSync(path.join(ret, 'x.md'), '## X\n');
      const out = loadConventionCatalogue(lib, { retiredDir: ret });
      assert.deepEqual(out.catalogue.map((c) => c.id), ['x']);
      assert.match(out.errors.join('\n'), /both the library and the retired folder/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('an absent retired folder is an empty one; an absent library is an error', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-'));
    try {
      const lib = path.join(root, 'snippets');
      fs.mkdirSync(lib);
      fs.writeFileSync(path.join(lib, 'x.md'), '## X\n');
      assert.deepEqual(loadConventionCatalogue(lib, { retiredDir: path.join(root, 'none') }).errors, []);
      assert.equal(loadConventionCatalogue(path.join(root, 'none')).errors.length, 1);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('the audit', () => {
  const audit = (content) => auditVaultConventions({
    vault: 'v', candidates: [{ path: 'CLAUDE.md', content }], referenceFingerprints: new Set(), catalogue: CATALOGUE,
  });

  test('languages replaced bilingual in the recommended set', () => {
    assert.ok(RECOMMENDED_CONVENTION_IDS.includes('languages'));
    assert.ok(!RECOMMENDED_CONVENTION_IDS.includes('bilingual'));
  });

  test('reports the declared value', () => {
    const a = audit(`# C\n\n${rendered(['fr', 'en'])}`);
    assert.deepEqual(a.languages, ['fr', 'en']);
    assert.ok(!a.missingRecommended.includes('languages'));
  });

  test('a vault still carrying bilingual is reported TO MIGRATE, with the two steps', () => {
    const a = audit(`# C\n\n${BILINGUAL}`);
    assert.equal(a.languages, null);
    const f = a.findings.find((x) => x.kind === 'bilingual-to-migrate');
    assert.ok(f, JSON.stringify(a.findings.map((x) => x.kind)));
    assert.equal(f.severity, 'warning');
    assert.match(f.message, /the owner decides the value/);
    assert.deepEqual(f.repair.steps.map((s) => s.command), [
      '/obsidian-router:conventions install languages on v',
      '/obsidian-router:conventions remove bilingual on v',
    ]);
  });

  test('bilingual beside languages: only the removal remains', () => {
    const a = audit(`# C\n\n${rendered(['fr'])}\n${BILINGUAL}`);
    const f = a.findings.find((x) => x.kind === 'bilingual-to-migrate');
    assert.match(f.message, /already carries languages \(fr\)/);
    assert.deepEqual(f.repair.steps.map((s) => s.command), ['/obsidian-router:conventions remove bilingual on v']);
  });

  test('an unreadable value is a finding of its own', () => {
    const a = audit(`# C\n\n${SNIPPET}`);
    const f = a.findings.find((x) => x.kind === 'languages-value-unreadable');
    assert.match(f.message, /invalid-value/);
    assert.equal(a.languages, null);
  });

  test('bilingual is never reported as a missing recommendation', () => {
    assert.ok(!audit('# C\n').missingRecommended.includes('bilingual'));
  });

  test('BILINGUAL_EQUIVALENT is what the retired snippet says it meant', () => {
    assert.deepEqual([...BILINGUAL_EQUIVALENT], ['fr', 'en']);
    assert.match(BILINGUAL, /French first, English second/);
  });
});

describe('the brief tells the writer which language to write in', () => {
  const brief = (content) => buildConventionsBrief(auditVaultConventions({
    vault: 'v', candidates: [{ path: 'CLAUDE.md', content }], referenceFingerprints: null, catalogue: CATALOGUE,
  }));

  test('one language', () => {
    const b = brief(`# C\n\n${rendered(['fr'])}`);
    assert.deepEqual(b.languages, ['fr']);
    assert.match(b.writeIn, /Write every page in `fr`, whatever the language of the conversation/);
  });

  test('several languages — the order and the primary', () => {
    const b = brief(`# C\n\n${rendered(['fr', 'en'])}`);
    assert.match(b.writeIn, /in this order: fr, en/);
    assert.match(b.writeIn, /`fr` is primary/);
  });

  test('no declaration, no instruction — and bilingual is named as to repair', () => {
    const b = brief(`# C\n\n${BILINGUAL}`);
    assert.equal(b.writeIn, undefined);
    assert.deepEqual(b.conventionsToRepair.map((x) => x.kind), ['bilingual-to-migrate']);
  });
});

describe('write-time checks on a vault that declares its languages', () => {
  const FR = `${flag('FR')} Version française`;
  const EN = `${flag('GB')} English version`;
  const rules = (content, langs, p = 'wiki/a.md') => checkWrittenPage({ path: p, content, vaultLanguages: langs }).findings.map((f) => f.rule);

  test('a language outside the list is a warning — on ANY page, not only decisions', () => {
    const r = checkWrittenPage({ path: 'wiki/a.md', content: page({ language: 'fr, de', words: 10 }), vaultLanguages: ['fr'] });
    assert.equal(r.checked, true);
    const f = r.findings.find((x) => x.rule === 'language-outside-vault-list');
    assert.equal(f.severity, 'warning');
    assert.match(f.detail, /names de/);
  });

  test('no language: is an info, never a warning', () => {
    const f = checkWrittenPage({ path: 'wiki/a.md', content: page({ words: 10 }), vaultLanguages: ['fr'] }).findings;
    assert.deepEqual(f.map((x) => [x.rule, x.severity]), [['language-missing', 'info']]);
  });

  test('multi-language: a substantive page without a section per language', () => {
    assert.ok(rules(page({ language: 'fr, en', sections: [FR] }), ['fr', 'en']).includes('language-sections-missing'));
  });

  test('multi-language: both sections present, in order → nothing', () => {
    assert.deepEqual(rules(page({ language: 'fr, en', sections: [FR, EN] }), ['fr', 'en']), []);
  });

  test('a section is recognised by its label as well as its flag', () => {
    assert.deepEqual(rules(page({ language: 'fr, en', sections: ['Version française', 'English version'] }), ['fr', 'en']), []);
  });

  test('sections out of the vault order', () => {
    assert.ok(rules(page({ language: 'fr, en', sections: [EN, FR] }), ['fr', 'en']).includes('language-sections-order'));
  });

  test('a short page may inline its languages', () => {
    assert.deepEqual(rules(page({ language: 'fr, en', words: SHORT_PAGE_WORDS - 50 }), ['fr', 'en']), []);
  });

  test('a page that declares ONE of the vault languages owes no section', () => {
    assert.deepEqual(rules(page({ language: 'fr' }), ['fr', 'en']), []);
  });

  test('navigation files and the conventions file are exempt', () => {
    for (const p of ['wiki-meta/hot.md', 'wiki-meta/catalog.md', 'wiki-meta/journal.md', 'wiki/index.md', 'CLAUDE.md']) {
      assert.deepEqual(rules(page({ language: 'de' }), ['fr', 'en'], p), [], p);
    }
  });

  test('a language the router cannot recognise is said to be unchecked, not passed', () => {
    const r = rules(page({ language: 'fr, ja', sections: [FR] }), ['fr', 'ja']);
    assert.ok(r.includes('language-sections-unchecked'));
    assert.ok(!CHECKABLE_LANGUAGES.includes('ja'));
  });

  test('a vault without the convention checks nothing, and a non-decision page stays unchecked', () => {
    const r = checkWrittenPage({ path: 'wiki/a.md', content: page({ language: 'de' }) });
    assert.equal(r.checked, false);
    assert.deepEqual(r.findings, []);
  });

  test('a decision page gets both families of rules', () => {
    const r = rules(page({ language: 'de', type: 'decision', words: 10 }), ['fr']);
    assert.ok(r.includes('language-outside-vault-list'));
    assert.ok(r.includes('status-missing'));
  });
});

describe('the write wiring passes the vault languages to the checks', () => {
  function fakeVault(files) {
    return {
      listFilesIn: async (_v, dir) => {
        const prefix = dir ? `${dir}/` : '';
        const names = new Set();
        for (const p of Object.keys(files)) {
          if (!p.startsWith(prefix)) continue;
          const rest = p.slice(prefix.length);
          names.add(rest.includes('/') ? `${rest.split('/')[0]}/` : rest);
        }
        if (dir && names.size === 0) { const e = new Error('HTTP 404'); e.status = 404; throw e; }
        return { files: [...names] };
      },
      getFileContent: async (_v, p) => {
        if (!(p in files)) { const e = new Error('HTTP 404'); e.status = 404; throw e; }
        return files[p];
      },
    };
  }
  const reg = { resolveVault: (n) => ({ name: n ?? 'v' }) };

  test('a page outside the declared languages comes back with its warning, and the brief says the language', async () => {
    const deps = fakeVault({ 'CLAUDE.md': `# C\n\n${rendered(['fr'])}` });
    const out = await createConventionsBriefing(deps).forWrite(reg, 'write_file',
      { path: 'wiki/a.md', content: page({ language: 'en', words: 10 }) }, { vault: 'v' });
    assert.deepEqual(out.vaultConventions.languages, ['fr']);
    assert.ok(out.pageChecks[0].findings.some((f) => f.rule === 'language-outside-vault-list'));
  });

  test('an ambiguous vault (two conventions files) checks no language', async () => {
    const deps = fakeVault({ 'CLAUDE.md': `# C\n\n${rendered(['fr'])}`, 'wiki-meta/CLAUDE.md': '# other\n' });
    const out = await createConventionsBriefing(deps).forWrite(reg, 'write_file',
      { path: 'wiki/a.md', content: page({ language: 'en', words: 10 }) }, { vault: 'v' });
    assert.equal(out.pageChecks, undefined);
  });
});

describe('review round 1 — each repair with its witness', () => {
  const snippetEntry = { id: 'languages', heading: LANGUAGES_HEADING, text: SNIPPET };

  test('R1 an ambiguous vault yields no value, even when the audit knows which file a repair would keep', () => {
    // The vault's own root file declares `de`; Documentation/CLAUDE.md is a
    // byte copy of the template — the "renameable" case, where the audit
    // picks the vault's own file as `effective`.
    const template = '# Template conventions\n\nx\n';
    const a = auditVaultConventions({
      vault: 'v',
      candidates: [
        { path: 'CLAUDE.md', content: `# Mine\n\n${rendered(['de'])}` },
        { path: 'Documentation/CLAUDE.md', content: template },
      ],
      referenceFingerprints: new Set([sha(template)]),
      catalogue: CATALOGUE,
    });
    assert.equal(a.ambiguous, true);
    assert.equal(a.languages, null);
    assert.equal(buildConventionsBrief(a).writeIn, undefined);
  });

  test('R1b the brief refuses to instruct beside an ambiguity even if handed a value', () => {
    const b = buildConventionsBrief({ vault: 'v', ambiguous: true, conventionsFile: null, candidates: [], missingRecommended: [], findings: [], languages: ['de'] });
    assert.equal(b.writeIn, undefined);
    assert.equal(b.languages, undefined);
  });

  test('R2 the raw snippet appended as-is is a drift, not an install', () => {
    const r = compareConvention(snippetEntry, `# C\n\n${SNIPPET}`);
    assert.equal(r.status, DRIFT_STATUS.DRIFT);
    assert.equal(r.driftLines, 1);
  });

  test('R3 a value line inside a code fence is an example, not the value', () => {
    const fenced = (line) => SNIPPET.replace(/^\*\*Languages of this vault:.*$/m, `\`\`\`markdown\n${line}\n\`\`\``);
    assert.equal(readVaultLanguages(`# C\n\n${fenced('**Languages of this vault: de**')}`).problem, 'missing-value');
    const both = `${rendered(['fr'])}\n\`\`\`markdown\n**Languages of this vault: de**\n\`\`\`\n`;
    assert.deepEqual(readVaultLanguages(`# C\n\n${both}`).languages, ['fr']);
  });

  test('R7 only real ISO 639-1 codes, and no non-ASCII letter that folds into one', () => {
    assert.equal(parseLanguagesValue('xx').ok, false);
    assert.equal(parseLanguagesValue('qq, fr').ok, false);
    assert.equal(parseLanguagesValue(`${String.fromCharCode(0x212a)}o`).ok, false, 'Kelvin sign + o must not become ko');
    assert.deepEqual(parseLanguagesValue('ko').languages, ['ko']);
  });

  test('R2-1 beside an ambiguity, no `install languages` step at all — which file comes first', () => {
    const template = '# Template conventions\n\nx\n';
    const a = auditVaultConventions({
      vault: 'v',
      candidates: [
        { path: 'CLAUDE.md', content: `# Mine\n\n${BILINGUAL}` },
        { path: 'Documentation/CLAUDE.md', content: template },
      ],
      referenceFingerprints: new Set([sha(template)]),
      catalogue: CATALOGUE,
    });
    assert.equal(a.ambiguous, true);
    const steps = a.findings.flatMap((f) => f.repair?.steps ?? []).map((s) => s.command ?? '');
    assert.ok(!steps.some((c) => /install languages/.test(c)), JSON.stringify(steps));

    // And WITHOUT bilingual — otherwise the bilingual clause alone removes the
    // step and this witness cannot see the ambiguity clause (its first version
    // survived that mutation).
    const b = auditVaultConventions({
      vault: 'v',
      candidates: [
        { path: 'CLAUDE.md', content: '# Mine\n\nNo conventions here.\n' },
        { path: 'Documentation/CLAUDE.md', content: template },
      ],
      referenceFingerprints: new Set([sha(template)]),
      catalogue: CATALOGUE,
    });
    assert.equal(b.ambiguous, true);
    assert.ok(b.missingRecommended.includes('languages'), 'it IS missing — only the install step is withheld');
    const stepsB = b.findings.flatMap((f) => f.repair?.steps ?? []).map((s) => s.command ?? '');
    assert.ok(!stepsB.some((c) => /install languages/.test(c)), JSON.stringify(stepsB));
  });

  test('R2-4 the ISO list is the 183 current codes and cannot be widened from outside', async () => {
    const mod = await import('../src/helpers/convention-languages.mjs');
    assert.equal(mod.ISO_639_1_CODES, undefined, 'not exported');
    const all = [];
    for (let a = 97; a <= 122; a += 1) for (let b = 97; b <= 122; b += 1) {
      const c = String.fromCharCode(a, b);
      if (mod.isIso6391(c)) all.push(c);
    }
    assert.equal(all.length, 183);
    for (const retired of ['sh', 'in', 'iw', 'ji', 'jw', 'mo']) assert.equal(mod.isIso6391(retired), false, retired);
  });

  test('R8 a bilingual vault is offered `install languages` once — by the migration, not twice', () => {
    const a = auditVaultConventions({
      vault: 'v', candidates: [{ path: 'CLAUDE.md', content: `# C\n\n${BILINGUAL}` }], referenceFingerprints: new Set(), catalogue: CATALOGUE,
    });
    const installs = a.findings.flatMap((f) => f.repair?.steps ?? []).filter((s) => /install languages/.test(s.command ?? ''));
    assert.equal(installs.length, 1);
  });

  test('R9 `language: []` is missing, not satisfied', () => {
    const r = checkWrittenPage({ path: 'wiki/a.md', content: '---\ntype: concept\nlanguage: []\n---\n\nx\n', vaultLanguages: ['fr'] });
    assert.ok(r.findings.some((f) => f.rule === 'language-missing'), JSON.stringify(r.findings));
  });

  test('R9a checkPageLanguages exempts navigation files on its own — not only through its caller', () => {
    // Two guards now say "exempt": this one and checkWrittenPage's. Each needs
    // its own witness, or removing either one stays green.
    assert.deepEqual(checkPageLanguages({ path: 'wiki-meta/hot.md', frontmatter: { language: ['de'] }, body: '', vaultLanguages: ['fr'] }), []);
  });

  test('R9b an exempt page reports that it was not checked', () => {
    assert.equal(checkWrittenPage({ path: 'Documentation/CLAUDE.md', content: page({ language: 'de' }), vaultLanguages: ['fr'] }).checked, false);
  });

  test('R9c `## Version en français` and a qualified label open a language section', () => {
    const r = checkWrittenPage({ path: 'wiki/a.md', content: page({ language: 'fr, en', sections: ['Version en français', 'In English'] }), vaultLanguages: ['fr', 'en'] });
    assert.deepEqual(r.findings, []);
    const q = checkWrittenPage({ path: 'wiki/a.md', content: page({ language: 'fr, en', sections: ['Version française — détail', 'English version · summary'] }), vaultLanguages: ['fr', 'en'] });
    assert.deepEqual(q.findings, []);
  });

  test('R2-3 a bare code, or a heading that merely starts like one, never opens a section', () => {
    // Review round 2: each of these let a missing second section pass.
    for (const [langs, second] of [[['fr', 'it'], 'IT'], [['fr', 'de'], 'DE'], [['fr', 'en'], 'En (bref)'], [['en', 'fr'], 'Fr.'], [['fr', 'en'], 'EN']]) {
      const first = langs[0] === 'fr' ? 'Version française' : 'English version';
      const rules = checkWrittenPage({ path: 'wiki/a.md', content: page({ language: langs.join(', '), sections: [first, second] }), vaultLanguages: langs }).findings.map((f) => f.rule);
      assert.ok(rules.includes('language-sections-missing'), `${langs} + "## ${second}" must still miss a section; got ${rules}`);
    }
  });

  test('R3-1 a one-word name or a flag followed by a topic never opens a section', () => {
    // Review round 3: each let a missing second section pass.
    for (const [langs, second] of [
      [['fr', 'en'], 'English (grammar lesson)'],
      [['fr', 'de'], 'German · histoire'],
      [['fr', 'en'], `${flag('US')} Élections américaines`],
    ]) {
      const rules = checkWrittenPage({ path: 'wiki/a.md', content: page({ language: langs.join(', '), sections: ['Version française', second] }), vaultLanguages: langs }).findings.map((f) => f.rule);
      assert.ok(rules.includes('language-sections-missing'), `"## ${second}" must not count; got ${rules}`);
    }
    // And the shapes that DO count stay counted: flag alone, flag + label, whole one-word name.
    for (const second of [flag('GB'), `${flag('GB')} English version`, 'English']) {
      const rules = checkWrittenPage({ path: 'wiki/a.md', content: page({ language: 'fr, en', sections: ['Version française', second] }), vaultLanguages: ['fr', 'en'] }).findings.map((f) => f.rule);
      assert.deepEqual(rules, [], `"## ${second}" must count`);
    }
  });

  test('R3-2 a value line inside an Obsidian `%%` comment is not the value', () => {
    const only = SNIPPET.replace(/^\*\*Languages of this vault:.*$/m, '%%\n**Languages of this vault: de**\n%%');
    assert.equal(readVaultLanguages(`# C\n\n${only}`).problem, 'missing-value');
    const beside = `${rendered(['fr'])}\n%%\n**Languages of this vault: de**\n%%\n`;
    assert.deepEqual(readVaultLanguages(`# C\n\n${beside}`).languages, ['fr']);
    const inline = `${rendered(['fr'])}\n%% **Languages of this vault: de** %%\n`;
    assert.deepEqual(readVaultLanguages(`# C\n\n${inline}`).languages, ['fr']);
  });

  test('R2-2 a value line in an HTML comment, or behind a fence the scanner does not close, is not the value', () => {
    const comment = `${rendered(['fr'])}\n<!--\n**Languages of this vault: de**\n-->\n`;
    assert.deepEqual(readVaultLanguages(`# C\n\n${comment}`).languages, ['fr'], 'a commented-out old value');
    const onlyComment = SNIPPET.replace(/^\*\*Languages of this vault:.*$/m, '<!--\n**Languages of this vault: de**\n-->');
    assert.equal(readVaultLanguages(`# C\n\n${onlyComment}`).problem, 'missing-value');
    // A backtick in the info string: not a fence (CommonMark), so the value after it is read.
    const tickInfo = `${SNIPPET.replace(/^\*\*Languages of this vault:.*$/m, '``` `x` ```\n**Languages of this vault: fr**')}`;
    assert.deepEqual(readVaultLanguages(`# C\n\n${tickInfo}`).languages, ['fr']);
    // A closer followed by a non-breaking space does not close: the "de" line stays inside.
    const nbsp = String.fromCharCode(0xa0);
    const hidden = SNIPPET.replace(/^\*\*Languages of this vault:.*$/m, `\`\`\`\n\`\`\`${nbsp}\n**Languages of this vault: de**\n\`\`\`\n**Languages of this vault: fr**`);
    assert.deepEqual(readVaultLanguages(`# C\n\n${hidden}`).languages, ['fr']);
  });
});

describe('the migration of one vault: remove bilingual, add languages, nothing else moves', () => {
  const OTHER = CATALOGUE.find((c) => c.id === 'source-type');
  const otherText = lf(fs.readFileSync(path.join(SNIPPETS_DIR, 'source-type.md'), 'utf8'));
  const before = `# Vault conventions\n\nMy preamble.\n\n${otherText.trimEnd()}\n\n${BILINGUAL.trimEnd()}\n\n## Personal rules\n\nKeep me.\n`;
  const bilingualHeading = CATALOGUE.find((c) => c.id === 'bilingual').heading;

  test('the helpers the procedure names do exactly that', () => {
    const cut = removeConvention(before, bilingualHeading);
    assert.equal(cut.removed, true);
    const check = verifyRemoval({ before, after: cut.content, heading: bilingualHeading, catalogue: CATALOGUE });
    assert.deepEqual(check.problems, []);
    const after = `${cut.content.trimEnd()}\n\n${rendered(['fr'])}`;

    assert.equal(isConventionInstalled(after, bilingualHeading), false);
    assert.deepEqual(readVaultLanguages(after).languages, ['fr']);
    assert.equal(findConventionSection(after, OTHER.heading).text, findConventionSection(before, OTHER.heading).text,
      'every other convention byte for byte');
    assert.ok(after.includes('## Personal rules\n\nKeep me.'), 'and the owner\'s own section');
    assert.ok(after.startsWith('# Vault conventions\n\nMy preamble.'));
  });
});
