/**
 * The `languages` convention — the first convention in the library that
 * carries a VALUE of its own, different from one vault to the next.
 *
 * WHY IT EXISTS. Decision `convention-languages-remplace-bilingual` (accepted
 * 2026-09-26). The retired `bilingual` convention answered two questions with
 * one switch — WHICH languages, and HOW to lay them out when there are several
 * — and its absence answered neither: a vault without it was not "in French",
 * it was "in whatever language the conversation happened to be in". `languages`
 * declares the list, per vault, and keeps bilingual's layout for the case of
 * several.
 *
 * WHAT A VALUE CHANGES, and every function below is one of those changes:
 *
 *   - INSTALLING stops being a copy. The snippet carries a placeholder on one
 *     identifiable line; `renderLanguagesSection` fills it, and refuses a
 *     snippet where that line is not there exactly once — a render that
 *     silently kept the placeholder would install a convention that declares
 *     no language at all.
 *   - READING needs a parser. `readVaultLanguages` finds the value inside the
 *     installed section, and distinguishes "no value line", "two value lines"
 *     and "a value that is not a list of language codes" — three different
 *     repairs, never folded into one "invalid".
 *   - COMPARING must not call the value a drift. Two vaults with different
 *     languages carry two different texts on purpose (form B of decision
 *     `exclusions-de-propagation-des-conventions`: a line that speaks of THIS
 *     vault). `maskLanguagesValue` replaces a VALID value with the placeholder
 *     before a comparison, so the drift detector compares the rule and not the
 *     value. It masks nothing else: two value lines, or a value that does not
 *     parse, are left as they are and still read as drift — hiding them would
 *     turn a damaged section into an "identical" one.
 *
 * PURE: strings in, results out.
 */
import { findConventionSection } from './claude-md-conventions.mjs';
import { classifyLines, scanAtxHeadings } from './markdown-headings.mjs';

export const LANGUAGES_CONVENTION_ID = 'languages';

/** The convention the `languages` convention replaced — recognised, never offered. */
export const RETIRED_BILINGUAL_ID = 'bilingual';

/**
 * The identity heading, WITHOUT its hashes. Pinned against the snippet's first
 * line by a test: a constant that drifted from the snippet would make every
 * reader below look for a section nobody installs.
 */
export const LANGUAGES_HEADING = 'Languages convention (declared per vault)';

/** What the snippet carries where a vault carries its list. */
export const LANGUAGES_PLACEHOLDER = '<languages>';

/** What the retired `bilingual` convention meant, expressed as a value. */
export const BILINGUAL_EQUIVALENT = Object.freeze(['fr', 'en']);

/**
 * The value line: column 0, bold, one label, the value, nothing after it.
 * Anchored at both ends so a sentence that merely MENTIONS the label (the
 * snippet's own explanation does) is not taken for the value.
 */
const VALUE_LINE = /^\*\*Languages of this vault:[ \t]*(.*?)[ \t]*\*\*[ \t]*$/;

/**
 * The ISO 639-1 codes. A LIST, not a shape: review found `xx` and `qq`
 * accepted by a two-letter pattern while the error message promised ISO 639-1.
 */
const ISO_639_1_CODES = new Set((
  'aa ab ae af ak am an ar as av ay az ba be bg bi bm bn bo br bs ca ce ch co cr cs cu cv cy '
  + 'da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu '
  + 'hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb '
  + 'lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om '
  + 'or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw '
  + 'ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu'
).split(' '));

/**
 * Is this an ISO 639-1 code? The set stays PRIVATE: `Object.freeze` does not
 * freeze a Set's contents, and an exported Set let any importer widen what the
 * parser accepts (review round 2).
 */
export function isIso6391(code) {
  return typeof code === 'string' && ISO_639_1_CODES.has(code);
}

/**
 * ASCII letters BEFORE case folding: `toLowerCase` maps the Kelvin sign
 * (U+212A) to an ASCII `k`, so folding first let a non-ASCII token become a
 * valid code (review finding).
 */
const TWO_ASCII_LETTERS = /^[A-Za-z]{2}$/;

/**
 * Parse a declared value — `fr`, `fr, en`, `FR EN`, `[fr, en]`.
 *
 * Separators are commas and whitespace, brackets are dropped, case is folded:
 * the owner may type the value by hand, and "FR EN" is exactly how the owner
 * wrote it when the decision was taken. What is NOT accepted is anything that
 * is not a current ISO 639-1 code (`français`, `fr-FR`, `f`, `xx`, a retired
 * `iw`, a non-ASCII letter that folds into one), an empty list, and a
 * code listed twice — each named in `error`, because a value the router cannot
 * read is a vault whose language nothing checks.
 *
 * @param {unknown} raw
 * @returns {{ok: true, languages: string[]} | {ok: false, error: string, languages: null}}
 */
export function parseLanguagesValue(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'the value is not text', languages: null };
  const rawTokens = raw.replace(/[[\]]/g, ' ').split(/[\s,;]+/).filter(Boolean);
  if (rawTokens.length === 0) return { ok: false, error: 'no language code', languages: null };
  const bad = rawTokens.filter((t) => !TWO_ASCII_LETTERS.test(t) || !ISO_639_1_CODES.has(t.toLowerCase()));
  const tokens = rawTokens.map((t) => t.toLowerCase());
  if (bad.length > 0) {
    return { ok: false, error: `not ISO 639-1 codes (two letters, e.g. fr, en): ${bad.join(', ')}`, languages: null };
  }
  const seen = new Set();
  const dup = tokens.filter((t) => (seen.has(t) ? true : (seen.add(t), false)));
  if (dup.length > 0) return { ok: false, error: `listed more than once: ${[...new Set(dup)].join(', ')}`, languages: null };
  return { ok: true, languages: tokens };
}

/**
 * The lines of `text` that are value lines, with their index — PROSE lines
 * only. A value line inside a fenced block or an HTML comment is an example
 * or a commented-out old value, not the vault's value. Round 1 of review found
 * fenced examples read as the value; round 2 found the fence rule written for
 * that repair disagreeing with the heading scanner's on three inputs. So there
 * is no rule here: the scanner's own line classifier decides (`classifyLines`),
 * and this reader and the section finder can no longer disagree.
 */
function valueLines(text) {
  const out = [];
  // OBSIDIAN'S OWN COMMENTS (`%% … %%`) are hidden in reading view, so a value
  // line inside one is not the vault's value (review round 3). The shared
  // scanner does not know `%%` — its headings inside `%%` are still headings,
  // a known limit of `classifyLines` left as it is because changing it would
  // change heading detection everywhere. So `%%` is handled HERE, for the value
  // line only: a line containing `%%` is never a value line, and an odd count
  // opens or closes a comment. Also a known limit, inherited from the scanner:
  // an HTML comment opener is recognised at column 0 only.
  let inObsidianComment = false;
  for (const { line, lineNo, kind } of classifyLines(String(text ?? ''))) {
    if (kind !== 'prose') continue;
    const marks = line.split('%%').length - 1;
    const hidden = inObsidianComment || marks > 0;
    if (marks % 2 === 1) inObsidianComment = !inObsidianComment;
    if (hidden) continue;
    const m = VALUE_LINE.exec(line);
    if (m) out.push({ index: lineNo - 1, value: m[1] });
  }
  return out;
}

/**
 * True when the section carries the library's placeholder where a value
 * should be — an install that appended the raw snippet. It is byte-identical
 * to the snippet, so the drift detector must be told: "identical" would call
 * a convention that declares no language clean (review finding).
 */
export function hasUnfilledPlaceholder(sectionText) {
  const lines = valueLines(sectionText);
  return lines.length === 1 && lines[0].value === LANGUAGES_PLACEHOLDER;
}

/**
 * The value declared in a vault's conventions file.
 *
 * @param {string} content the whole conventions file
 * @returns {{installed: boolean, languages: string[]|null,
 *   problem: null|'missing-value'|'ambiguous-value'|'invalid-value'|'duplicate-section',
 *   detail: string|null, raw: string|null}}
 *
 * `installed: false` is the ordinary absence. The four problems are the ways an
 * INSTALLED section can fail to say anything usable, and each has its own
 * repair: add the line, delete one of the two, correct the codes, or choose
 * between two sections (the state `removeConvention` already refuses on).
 */
export function readVaultLanguages(content) {
  const found = findConventionSection(typeof content === 'string' ? content : '', LANGUAGES_HEADING);
  if (!found.found) return { installed: false, languages: null, problem: null, detail: null, raw: null };
  if (found.occurrences > 1) {
    return {
      installed: true, languages: null, problem: 'duplicate-section', raw: null,
      detail: `the languages section appears ${found.occurrences} times (lines ${found.lines.join(', ')}); there is no single value to read`,
    };
  }
  const lines = valueLines(found.text);
  if (lines.length === 0) {
    return {
      installed: true, languages: null, problem: 'missing-value', raw: null,
      detail: 'the languages section has no `**Languages of this vault: …**` line',
    };
  }
  if (lines.length > 1) {
    return {
      installed: true, languages: null, problem: 'ambiguous-value', raw: null,
      detail: `the languages section has ${lines.length} value lines (${lines.map((l) => l.value || '(empty)').join(' | ')}); keep one`,
    };
  }
  const parsed = parseLanguagesValue(lines[0].value);
  if (!parsed.ok) {
    return { installed: true, languages: null, problem: 'invalid-value', raw: lines[0].value, detail: parsed.error };
  }
  return { installed: true, languages: parsed.languages, problem: null, detail: null, raw: lines[0].value };
}

/**
 * The snippet with the vault's value in place of the placeholder — what an
 * install appends.
 *
 * @param {string} snippetText the library's `languages.md`
 * @param {string[]|string} languages
 * @returns {{ok: true, text: string, languages: string[]} | {ok: false, error: string}}
 *
 * Refuses rather than guessing, in the three cases where the result would lie:
 * a value that does not parse, a snippet whose value line is absent or doubled,
 * and a value line that does not hold the placeholder (a snippet somebody
 * already filled in is not the library's).
 */
export function renderLanguagesSection(snippetText, languages) {
  const parsed = parseLanguagesValue(Array.isArray(languages) ? languages.join(', ') : languages);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const text = String(snippetText ?? '');
  const lines = valueLines(text);
  if (lines.length !== 1) {
    return { ok: false, error: `the snippet must hold exactly one value line, it holds ${lines.length}` };
  }
  if (lines[0].value !== LANGUAGES_PLACEHOLDER) {
    return { ok: false, error: `the snippet's value line does not hold the placeholder ${LANGUAGES_PLACEHOLDER}` };
  }
  const all = text.split('\n');
  const eol = all[lines[0].index].endsWith('\r') ? '\r' : '';
  all[lines[0].index] = `**Languages of this vault: ${parsed.languages.join(', ')}**${eol}`;
  return { ok: true, text: all.join('\n'), languages: parsed.languages };
}

/**
 * A languages section with a VALID value put back to the placeholder, for a
 * comparison with the snippet. Anything else is returned unchanged — see the
 * module comment: masking a damaged value line would call a damaged section
 * "identical".
 *
 * @param {string} sectionText
 * @returns {string}
 */
export function maskLanguagesValue(sectionText) {
  const text = String(sectionText ?? '');
  const lines = valueLines(text);
  if (lines.length !== 1 || !parseLanguagesValue(lines[0].value).ok) return text;
  const all = text.split('\n');
  const eol = all[lines[0].index].endsWith('\r') ? '\r' : '';
  all[lines[0].index] = `**Languages of this vault: ${LANGUAGES_PLACEHOLDER}**${eol}`;
  return all.join('\n');
}

// ---------------------------------------------------------------------------
// Checks on a page just written
// ---------------------------------------------------------------------------

/**
 * A flag emoji from a two-letter region code, BUILT from code points — never
 * typed as an escape, which this project's editing tools have turned into raw
 * bytes before.
 */
function flag(region) {
  return String.fromCodePoint(...[...region.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/**
 * How a language section can be recognised: its flags, and the labels that
 * name it (already folded). A code missing from this table cannot be checked
 * — and is reported as unchecked, never passed as present.
 */
const LANGUAGE_MARKERS = Object.freeze({
  fr: { regions: ['FR'], labels: ['version francaise', 'version en francais', 'en francais', 'francais', 'french version', 'french', 'in french'] },
  en: { regions: ['GB', 'US'], labels: ['english version', 'english', 'in english', 'version anglaise', 'version en anglais', 'en anglais'] },
  es: { regions: ['ES'], labels: ['version en espanol', 'version espanola', 'en espanol', 'espanol', 'spanish version', 'spanish'] },
  de: { regions: ['DE'], labels: ['deutsche version', 'auf deutsch', 'deutsch', 'german version', 'german'] },
  it: { regions: ['IT'], labels: ['versione italiana', 'in italiano', 'italiano', 'italian version', 'italian'] },
  pt: { regions: ['PT', 'BR'], labels: ['versao em portugues', 'versao portuguesa', 'em portugues', 'portugues', 'portuguese version', 'portuguese'] },
  nl: { regions: ['NL'], labels: ['nederlandse versie', 'in het nederlands', 'nederlands', 'dutch version', 'dutch'] },
});

export const CHECKABLE_LANGUAGES = Object.freeze(Object.keys(LANGUAGE_MARKERS));

/** U+0300..U+036F, built rather than escaped (see flag()). */
const COMBINING_MARKS = new RegExp(`[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`, 'g');

function fold(text) {
  return String(text ?? '').normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

/** The language a `## H2` heading opens, or null. */
function languageOfHeading(text) {
  // Every rule here leans toward NOT recognising: a false warning is
  // non-blocking, a missing section passed in silence is the defect. Three
  // review rounds each found a heading that is about something else being
  // counted as a language section:
  //   - a BARE CODE never opens one (`## IT` is information technology,
  //     `## En (bref)`, `## Fr.` — round 2);
  //   - a FLAG opens one only alone or followed by a label of the same
  //     language (`## 🇺🇸 Élections américaines` is a topic — round 3);
  //   - a ONE-WORD name opens one only as the whole heading: `## English`
  //     yes, `## English (grammar lesson)` or `## German · histoire` no — only
  //     a multi-word label (`Version française`, `English version`) may be
  //     qualified after a separator (round 3).
  const raw = String(text ?? '').trim();
  const labelOf = (s, { qualified }) => {
    const whole = fold(s);
    const first = fold(String(s).split(/\s[·|—–-]\s|\s*[·|(]\s*/)[0]);
    for (const [code, m] of Object.entries(LANGUAGE_MARKERS)) {
      if (m.labels.includes(whole)) return code;
      if (qualified && first.includes(' ') && m.labels.includes(first)) return code;
    }
    return null;
  };
  for (const [code, m] of Object.entries(LANGUAGE_MARKERS)) {
    const f = m.regions.map(flag).find((fl) => raw.startsWith(fl));
    if (f === undefined) continue;
    const rest = raw.slice(f.length).trim();
    if (rest === '' || labelOf(rest, { qualified: true }) === code) return code;
    return null;
  }
  return labelOf(raw, { qualified: true });
}

/** Navigation files: one-line entries, never the section layout. */
const NAVIGATION_BASENAMES = new Set(['catalog.md', 'hot.md', 'journal.md', 'overview.md', 'index.md', 'log.md']);

/** Pages this check never applies to. */
export function isExemptFromLanguageChecks(path) {
  const base = String(path ?? '').split(/[\\/]/).pop().toLowerCase();
  return NAVIGATION_BASENAMES.has(base) || base.startsWith('claude.md');
}

/** Below this many words, parallel lists replace the section layout. */
export const SHORT_PAGE_WORDS = 500;

/** Words outside fenced code. */
function countWords(body) {
  let inFence = false;
  let words = 0;
  for (const line of String(body ?? '').split('\n')) {
    if (/^(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (!inFence) words += line.split(/\s+/).filter(Boolean).length;
  }
  return words;
}

/** A frontmatter `language:` value as a list of lowercase primary subtags. */
function pageLanguages(value) {
  if (value === undefined || value === null || value === '') return null;
  const items = Array.isArray(value) ? value : String(value).replace(/[[\]]/g, ' ').split(/[\s,;]+/);
  const out = items.map((v) => String(v).trim().toLowerCase().split(/[-_]/)[0]).filter(Boolean);
  // `language: []` declares nothing — reported as missing, never passed.
  return out.length > 0 ? out : null;
}

/**
 * Language findings for a page just written into a vault that declares its
 * languages. Never blocking — the page is already written.
 *
 * @param {{path: string, frontmatter: object, body: string, vaultLanguages: string[]}} input
 * @returns {Array<{rule: string, severity: 'warning'|'info', detail: string}>}
 */
export function checkPageLanguages({ path, frontmatter = {}, body = '', vaultLanguages }) {
  if (!Array.isArray(vaultLanguages) || vaultLanguages.length === 0 || isExemptFromLanguageChecks(path)) return [];
  const findings = [];
  const declared = pageLanguages(frontmatter?.language);
  const list = vaultLanguages.join(', ');

  if (declared === null) {
    findings.push({
      rule: 'language-missing',
      severity: 'info',
      detail: `no \`language:\` — this vault declares its languages (${list}); the page should carry them`,
    });
  } else {
    const outside = declared.filter((l) => !vaultLanguages.includes(l));
    if (outside.length > 0) {
      findings.push({
        rule: 'language-outside-vault-list',
        severity: 'warning',
        detail: `\`language:\` names ${outside.join(', ')}, outside this vault's declared languages (${list})`,
      });
    }
  }

  // The sections a page owes: the vault's languages, narrowed to the ones the
  // page says it contains when it says so (decision §5: "or the part really
  // written"). One language owes no section.
  const inList = declared ? declared.filter((l) => vaultLanguages.includes(l)) : [];
  const owed = inList.length > 0 ? vaultLanguages.filter((l) => inList.includes(l)) : vaultLanguages;
  if (owed.length < 2 || countWords(body) < SHORT_PAGE_WORDS) return findings;

  const uncheckable = owed.filter((l) => !LANGUAGE_MARKERS[l]);
  if (uncheckable.length > 0) {
    findings.push({
      rule: 'language-sections-unchecked',
      severity: 'info',
      detail: `the router cannot recognise a section for ${uncheckable.join(', ')}; those sections were NOT checked`,
    });
  }
  const seen = scanAtxHeadings(String(body))
    .filter((h) => h.level === 2 && h.indent === 0)
    .map((h) => languageOfHeading(h.text))
    .filter(Boolean);
  const checkable = owed.filter((l) => LANGUAGE_MARKERS[l]);
  const missing = checkable.filter((l) => !seen.includes(l));
  if (missing.length > 0) {
    findings.push({
      rule: 'language-sections-missing',
      severity: 'warning',
      detail: `no \`## \` section for ${missing.join(', ')} — a substantive page of this vault holds one section per language (${owed.join(', ')}), e.g. \`## ${flag(LANGUAGE_MARKERS[missing[0]].regions[0])} …\``,
    });
  } else {
    const order = checkable.map((l) => seen.indexOf(l));
    if (order.some((pos, i) => i > 0 && pos < order[i - 1])) {
      findings.push({
        rule: 'language-sections-order',
        severity: 'warning',
        detail: `the language sections are not in the vault's order (${owed.join(', ')})`,
      });
    }
  }
  return findings;
}
