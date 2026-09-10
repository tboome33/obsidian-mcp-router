/**
 * claude-md-conventions — the state a conventions picker must know before it
 * asks anything, and the cut that removing one is allowed to make.
 *
 * ---------------------------------------------------------------------------
 * WHAT WENT WRONG (measured 2026-09-11, router 0.94.1)
 * ---------------------------------------------------------------------------
 * A vault was created from the reference template and the `meta-attach-vault`
 * wizard offered its conventions picker: eight options, four pre-checked. The
 * user kept six and explicitly UNCHECKED `bilingual` and `auto-enrichment`.
 * The vault's `Documentation/CLAUDE.md` then contained all eight — because the
 * template ships all eight, and the picker had never looked. Three defects, and
 * only the second one hurts:
 *
 *   1. every positive choice was a no-op ("0 installed, 6 already present"),
 *      reported file-by-file as a benign skip, which reads globally as "your
 *      configuration was applied";
 *   2. the two NEGATIVE choices were violated in silence. Unchecking, to a
 *      human, means "I do not want this". `auto-enrichment` governs automatic
 *      saves into the vault — a rule believed off and actually on is not
 *      cosmetic;
 *   3. the skill could not see either, because nothing ever compared the state
 *      the user asked for against the state on disk. It only knew how to add
 *      what was missing.
 *
 * A fourth defect surfaced while removing `bilingual` by hand: the documented
 * cut ("from the H2 line through the line before the NEXT H2") stops at a `## `
 * displayed INSIDE that snippet's fenced markdown example. It left two thirds
 * of the convention in place, declared it removed, and cut the fence open. That
 * half of the fix lives in `markdown-headings.mjs`, shared with the catalogue
 * scanner that had already solved it.
 *
 * ---------------------------------------------------------------------------
 * EVERY REFUSAL HERE IS A REVIEW FINDING
 * ---------------------------------------------------------------------------
 * This module cuts text out of a file a human wrote in. Adversarial review
 * found four ways the first version ate the wrong bytes, and each is now a
 * refusal rather than a cleverer guess:
 *
 *   - an H1 named like a convention was accepted as that convention's heading,
 *     so `remove` deleted the whole document below it → the identity carries a
 *     LEVEL, and only that level matches;
 *   - a heading the user indented was skipped as a BOUNDARY, so the cut ran
 *     straight through their own section → boundaries are every heading the
 *     scanner sees, whatever its indent or style;
 *   - the same identity appearing twice was silently half-removed, reported as
 *     done, and still installed → duplicates refuse to cut and say so;
 *   - `## Alpha<NBSP>##` normalised to `Alpha` → the closing-hash rule is
 *     ASCII-only, in `normaliseHeadingText`.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE DOES NOT DECIDE
 * ---------------------------------------------------------------------------
 * `planConventionPicker` reports an unchecked-but-installed convention as an
 * intention to REMOVE. It does not remove it: the caller must show the user
 * what would disappear and get a yes, exactly as the `conventions` skill's
 * `remove` guards require. That split is deliberate — "unchecked" is genuinely
 * ambiguous (it can mean "do not install" as easily as "delete what is there"),
 * and the resolution this repository chose is to ASK, never to guess in either
 * direction. Silence was the bug; a silent deletion would be a worse one.
 *
 * PURE: strings in, plans out. Every path probe and every write belongs to the
 * caller, which is the only one that knows whether it is talking to a
 * filesystem or to a router tool.
 */

import { scanHeadings, scanAtxHeadings, normaliseHeadingText } from './markdown-headings.mjs';

/**
 * Where a vault's conventions file lives, in priority order.
 *
 * These are the three locations the v0.12.1 fleet audit actually found. The
 * order is a PREFERENCE among files that exist, never a claim about which one a
 * vault has: in the present fleet the reference template ships
 * `Documentation/CLAUDE.md` and has no root file at all, which is precisely how
 * a naive `get_file("CLAUDE.md")` 404 turns into "not installed" and then into
 * a second, competing conventions file at the root.
 *
 * `scripts/setup-vault.mjs` carries the same three paths in its own
 * `findClaudeMdCandidates`, and — being edited elsewhere at the time this
 * shipped — was not converted to import this constant. So this is not yet one
 * definition: it is two definitions with a test that fails when they disagree
 * (`tests/claude-md-conventions.test.mjs`, "the two definitions agree"). Say it
 * that way rather than claiming a single source of truth that does not exist.
 */
export const CLAUDE_MD_CANDIDATES = Object.freeze([
  'CLAUDE.md',
  'wiki-meta/CLAUDE.md',
  'Documentation/CLAUDE.md',
]);

/** The heading level every convention identity in the library is written at. */
export const CONVENTION_LEVEL = 2;

/**
 * The identity a heading string denotes — ONE parser, used for every side of
 * every comparison.
 *
 * Accepts `## Foo` and `Foo` alike, because callers hold both: the snippet's
 * first line, and the id-to-heading map they built from it. Review found the
 * cost of having two: `verifyRemoval` stripped the hashes from its target and
 * not from the catalogue entries, so a correct removal was rejected — the
 * target was compared against `## Foo` and never matched itself.
 */
function identityOf(heading) {
  return normaliseHeadingText(String(heading ?? '').replace(/^\s*#{1,6}[ \t]+/, ''));
}

/** Vault-relative path, normalised for comparison: `/` joins, no `./`, case kept. */
function normalisePath(p) {
  if (typeof p !== 'string') return null;
  const parts = p.split(/[/\\]+/).filter((s) => s && s !== '.');
  return parts.length ? parts.join('/') : null;
}

/**
 * Pick the vault's conventions file out of the candidates that EXIST.
 *
 * @param {string[]} existingPaths vault-relative paths the caller has probed
 *   and found. Anything that is not a known candidate is ignored: this function
 *   answers "which conventions file", not "what files does this vault have".
 * @returns {{path: string | null, ambiguous: boolean, present: string[],
 *   createAt: string, missing: string[]}}
 *
 * WHEN TWO CANDIDATES EXIST, `path` IS NULL. Two conventions files means two
 * sets of rules, one of which is not being read; the caller must SAY SO rather
 * than silently picking the first. Returning a usable path beside
 * `ambiguous: true` invites exactly the accidental use it was meant to prevent
 * — an adversarial review finding — so the ambiguity is expressed in the type,
 * not in a flag the caller may forget to read. `present` still lists them, so
 * the caller can name the files to the user.
 *
 * `createAt` is where a first install should write when nothing exists yet: the
 * vault root, the standard Claude Code location. It is never used to override a
 * file that is already there.
 */
export function resolveClaudeMd(existingPaths) {
  const have = new Set(
    (Array.isArray(existingPaths) ? existingPaths : [])
      .map(normalisePath)
      .filter(Boolean),
  );
  const present = CLAUDE_MD_CANDIDATES.filter((c) => have.has(c));
  const ambiguous = present.length > 1;
  return {
    path: ambiguous ? null : (present[0] ?? null),
    ambiguous,
    present,
    missing: CLAUDE_MD_CANDIDATES.filter((c) => !have.has(c)),
    createAt: CLAUDE_MD_CANDIDATES[0],
  };
}

/**
 * Locate a convention's section: from its identifying heading through the line
 * before the next heading of the SAME level or higher, or end of file.
 *
 * @param {string} content the conventions file
 * @param {string} heading the convention's identifying heading, with or
 *   without its leading hashes (`## Foo` and `Foo` both work)
 * @param {{level?: number}} [options] the level the identity is written at;
 *   defaults to `CONVENTION_LEVEL` (2), which every snippet in the library uses
 * @returns {{found: boolean, start?: number, end?: number, text?: string,
 *   line?: number, level?: number, occurrences: number, lines?: number[]}}
 *
 * MATCHING IS EXACT — same level, column 0, same text after trimming and ATX
 * closing hashes. Three separate refusals, each with its own counterexample:
 *
 *   - `## Bilingual convention de test` is not the convention, and neither is
 *     `## Bilingual convention (FR + EN, FR primary) — mes ajouts`. A prefix or
 *     `includes()` test turns a user's own note into a convention the installer
 *     believes it owns, and `remove` then deletes it.
 *   - `# Bilingual convention (FR + EN, FR primary)` is an H1. Accepting it —
 *     the first version did, because the hashes were stripped before comparing
 *     — makes the section run to the end of the document, so `remove` deletes
 *     the whole file below the title.
 *   - an INDENTED `## …` is inside a list item or a quoted example. Starting a
 *     cut there would cut from the middle of somebody's prose.
 *
 * THE BOUNDARY IS EVERY HEADING, though. Identity is narrow because a wrong
 * match deletes the wrong thing; the end of the section is wide because a
 * MISSED boundary deletes more than the thing. So the terminator may be
 * indented, and it may be setext (`Personal rules` underlined with `===`) —
 * both render as headings, and both must stop a cut. A convention's own `###`
 * subsections belong to it; an `#` H1 below it ends it just as a sibling H2
 * would.
 *
 * `occurrences` counts every heading that matched the identity. More than one
 * is not a section — it is a question for the caller (see `removeConvention`).
 */
export function findConventionSection(content, heading, options = {}) {
  if (typeof content !== 'string') return { found: false, occurrences: 0 };
  const level = Number.isInteger(options.level) ? options.level : CONVENTION_LEVEL;
  const want = identityOf(heading);
  if (!want) return { found: false, occurrences: 0 };

  const all = scanHeadings(content);
  const matches = scanAtxHeadings(content).filter(
    (h) => h.indent === 0 && h.level === level && normaliseHeadingText(h.text) === want,
  );
  if (matches.length === 0) return { found: false, occurrences: 0 };

  const ranges = matches.map((self) => {
    const next = all.find((h) => h.start > self.start && h.level <= self.level);
    return { start: self.start, end: next ? next.start : content.length, line: self.line };
  });

  const wanted = Number.isInteger(options.occurrence) ? options.occurrence : 1;
  const pick = ranges[wanted - 1] ?? ranges[0];
  return {
    found: true,
    start: pick.start,
    end: pick.end,
    text: content.slice(pick.start, pick.end),
    line: pick.line,
    level,
    occurrences: matches.length,
    lines: matches.map((m) => m.line),
    ranges,
  };
}

/**
 * Is this convention installed?
 *
 * Fence-aware by construction, which is the whole difference from the
 * `includes()` the skill used to specify: a `CLAUDE.md` that DOCUMENTS a
 * convention inside a code block — the shape every one of these snippets uses
 * to show a page template — is not a vault that has installed it.
 *
 * @param {string} content
 * @param {string} heading
 * @param {{level?: number}} [options]
 * @returns {boolean}
 */
export function isConventionInstalled(content, heading, options) {
  return findConventionSection(content, heading, options).found === true;
}

/**
 * Remove a convention's section, byte-exactly — or refuse, and say why.
 *
 * @param {string} content
 * @param {string} heading
 * @param {{level?: number}} [options]
 * @returns {{content: string, removed: boolean, section: string | null,
 *   reason: string | null, occurrences: number, lines?: number[]}}
 *
 * `reason` is `"not-installed"` when the identity is absent, and
 * `"duplicate-identity"` when it appears more than once. THE SECOND REFUSAL IS
 * THE ONE REVIEW FOUND: cutting the first copy of a duplicated convention
 * returns a file where the convention is still installed, after reporting the
 * removal as done — the exact "reads as closed while the second site keeps
 * failing" shape. Two copies is a question about which one is the user's, and
 * the caller must put it to them.
 *
 * A REFUSAL THAT CANNOT BE ANSWERED IS A DEAD END, so the refusal carries
 * `lines` and `ranges` (every occurrence), and `options.occurrence` (1-based)
 * cuts the one the user chose. That is the whole continuation: ask, then pass
 * the answer back. `verifyRemoval` must then be told `expectAbsent: false` — a
 * deliberately kept second copy is not a failed removal.
 *
 * No whitespace surgery at the seam: the section carries its own trailing blank
 * lines up to the next heading, so cutting `[start, end)` leaves the separation
 * the file already had. The skill's standing anti-pattern says the same thing —
 * trimming the boundary is how a "remove" starts editing the sections around
 * it.
 */
export function removeConvention(content, heading, options = {}) {
  const found = findConventionSection(content, heading, options);
  if (!found.found) {
    return { content, removed: false, section: null, reason: 'not-installed', occurrences: 0 };
  }
  const chosen = Number.isInteger(options.occurrence);
  if (found.occurrences > 1 && !chosen) {
    return {
      content,
      removed: false,
      section: found.text,
      reason: 'duplicate-identity',
      occurrences: found.occurrences,
      lines: found.lines,
      ranges: found.ranges,
    };
  }
  if (chosen && (options.occurrence < 1 || options.occurrence > found.occurrences)) {
    return {
      content,
      removed: false,
      section: null,
      reason: 'no-such-occurrence',
      occurrences: found.occurrences,
      lines: found.lines,
    };
  }
  return {
    content: content.slice(0, found.start) + content.slice(found.end),
    removed: true,
    section: found.text,
    reason: null,
    occurrences: found.occurrences,
    start: found.start,
    end: found.end,
  };
}

/**
 * Check a proposed removal BEFORE it is written.
 *
 * @param {{before: string, after: string, heading: string,
 *   catalogue?: Array<{id: string, heading: string}>, occurrence?: number,
 *   expectAbsent?: boolean}} input
 * @returns {{ok: boolean, problems: string[]}}
 *
 * WHY THIS EXISTS AS CODE AND NOT AS A SENTENCE. The skill used to say "check
 * your own work afterwards", which left the agent to invent the check — and the
 * obvious invention, counting fence lines for parity, is not a balance test at
 * all: a four-backtick block may legitimately contain a literal triple-backtick
 * line. Review named both defects.
 *
 * THE PRIMARY CHECK IS AN EXACT SPLICE, and the first version did not have it.
 * It asked "is the target gone, and are the other CONVENTIONS intact?" — which
 * accepts the deletion of everything that is not a convention. A user's own
 * `## Personal` section between two conventions could disappear and this
 * returned ok. So the question is now the strict one: does `after` equal
 * `before` with exactly the located byte range removed? Anything else — a
 * trimmed seam, an edited preamble, a swallowed personal section — fails.
 *
 * The catalogue pass stays as a SECOND, independent question: it is the one
 * that catches a range which was located wrongly, because a cut that severs a
 * fence hides every convention below it. Two checks with different failure
 * modes; the splice cannot see a wrong range, and the catalogue cannot see
 * damage outside a convention.
 *
 * `expectAbsent: false` says a copy is meant to remain (the duplicate flow,
 * where the user chose which occurrence to cut).
 */
export function verifyRemoval({
  before, after, heading, catalogue = [], occurrence, expectAbsent = true,
} = {}) {
  const problems = [];
  if (typeof before !== 'string' || typeof after !== 'string') {
    return { ok: false, problems: ['before/after must both be strings'] };
  }

  const located = findConventionSection(before, heading, Number.isInteger(occurrence) ? { occurrence } : {});
  if (!located.found) {
    problems.push('the target was not found in `before` — nothing could have been removed');
  } else {
    const expected = before.slice(0, located.start) + before.slice(located.end);
    if (after !== expected) {
      problems.push('the result is not `before` minus exactly the located section — '
        + 'something outside the cut changed');
    }
  }

  if (expectAbsent && isConventionInstalled(after, heading)) {
    problems.push(`the target is still installed after the cut: ${identityOf(heading)}`);
  }
  if (after.length >= before.length) {
    problems.push('the cut removed nothing');
  }

  const target = identityOf(heading);
  for (const entry of Array.isArray(catalogue) ? catalogue : []) {
    const h = entry?.heading;
    if (!h || identityOf(h) === target) continue;
    const was = findConventionSection(before, h);
    if (!was.found) continue;
    const now = findConventionSection(after, h);
    if (!now.found) {
      problems.push(`${entry.id ?? h} was installed and is no longer detectable — the cut damaged the file`);
    } else if (now.text !== was.text) {
      problems.push(`${entry.id ?? h} changed: its section is not byte-identical after the cut`);
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * The installed/absent state of a whole convention catalogue against one file.
 *
 * @param {string} content the conventions file (`''` for "the file does not
 *   exist" — an absent file is a vault with no conventions, not an error)
 * @param {Array<{id: string, heading: string}>} catalogue the snippet library,
 *   as globbed by the caller
 * @returns {Array<{id: string, heading: string, installed: boolean,
 *   line: number | null, duplicate: boolean}>} in catalogue order
 */
export function detectConventions(content, catalogue) {
  const text = typeof content === 'string' ? content : '';
  return (Array.isArray(catalogue) ? catalogue : []).map((entry) => {
    const found = findConventionSection(text, entry?.heading ?? '');
    return {
      id: entry?.id ?? null,
      heading: entry?.heading ?? null,
      installed: found.found === true,
      line: found.found === true ? found.line : null,
      duplicate: (found.occurrences ?? 0) > 1,
    };
  });
}

/**
 * Turn a picker answer into the four things that can happen to a convention.
 *
 * @param {{content?: string, catalogue: Array<{id: string, heading: string}>,
 *   selected: string[]}} input `selected` is the ids left CHECKED.
 * @returns {{install: object[], remove: object[], keep: object[],
 *   skip: object[], unknown: string[], duplicates: object[], plan: string}}
 *
 * `catalogue` MUST BE EXACTLY WHAT THE PICKER DISPLAYED. Review found the
 * failure mode: pass a globbed library wider than the eight options on screen,
 * and a convention the user was never shown lands in `remove` — after which the
 * confirmation says "you did not check these", which is false and invites a
 * deletion nobody asked for. One collection, displayed and planned.
 *
 * The four outcomes are the answer to defect 1 and defect 2 at once:
 *
 *   `install` checked + absent   → the only case the old flow handled
 *   `keep`    checked + present  → a no-op, and it must be REPORTED as
 *                                  "already in place", never as "installed"
 *   `remove`  unchecked + present → the signal. An intention, not an action:
 *                                  the caller asks before anything is cut
 *   `skip`    unchecked + absent → the only true silent no-op
 *
 * `plan` is the line to print BEFORE acting — it counts intentions, not
 * outcomes, and it says so in its own words. The closing summary of a run must
 * be built from what actually happened (installed / removed / declined /
 * failed): review caught the earlier field being used for both, where declining
 * every removal still reported "2 to remove".
 */
export function planConventionPicker({ content = '', catalogue = [], selected = [] } = {}) {
  const picked = new Set((Array.isArray(selected) ? selected : []).filter((s) => typeof s === 'string'));
  const state = detectConventions(content, catalogue);
  const known = new Set(state.map((s) => s.id));

  const install = [];
  const remove = [];
  const keep = [];
  const skip = [];

  for (const entry of state) {
    const bucket = picked.has(entry.id)
      ? (entry.installed ? keep : install)
      : (entry.installed ? remove : skip);
    bucket.push(entry);
  }

  const unknown = [...picked].filter((id) => !known.has(id));
  const duplicates = state.filter((s) => s.duplicate);

  const plan = `planned: ${install.length} to install, ${keep.length} already in place, `
    + `${remove.length} unchecked but present (confirm before removing), ${skip.length} untouched`;

  return { install, remove, keep, skip, unknown, duplicates, plan };
}
