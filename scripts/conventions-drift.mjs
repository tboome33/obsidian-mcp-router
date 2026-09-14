#!/usr/bin/env node
/**
 * conventions-drift.mjs — does every copy of a convention still say the same
 * thing?
 *
 * A convention in this library lives at two addresses: the snippet under
 * `skills/conventions/snippets/`, and the section of the same name inside a
 * `CLAUDE.md` — the file an agent actually reads. Nothing compared them until
 * this script, and by the time anyone looked, five of the eight conventions
 * installed in the reference vault had drifted, two of them on substance.
 *
 * TWO MODES, AND THE DIFFERENCE BETWEEN THEM IS AUTHORITY.
 *
 *   --check   The files this REPOSITORY ships. They are governed: a divergence
 *             is either propagated or recorded in the baseline with a reason,
 *             so an undeclared one is an error and the exit code is 1. This is
 *             the CI gate — editing a snippet without propagating it turns
 *             something red, which is the whole point.
 *
 *   --fleet   The vaults on this machine. They are observed, never governed: a
 *             vault's `CLAUDE.md` belongs to its owner, who may well have
 *             edited a section on purpose. The report lists what diverges, per
 *             vault, and STOPS THERE. There is deliberately no `--fix` and no
 *             `--all`; applying anything is a decision per vault, taken by a
 *             human, with the `conventions` skill's preview-and-backup guards.
 *
 *             EXIT CODE: what a vault SAYS never fails the run — no amount of
 *             drift, in any number of vaults, returns non-zero. Being unable to
 *             LOOK does: an unreadable config, a `--vault` matching nothing, a
 *             snippet library that will not load. The distinction is the
 *             point — "no findings" and "never ran" must not share an exit
 *             code, or a broken invocation reads as a clean fleet.
 *
 *             EXCLUSIONS. Some of that drift is drift somebody has already
 *             ruled must STAY — the snippet holds the generic text and the
 *             vault holds the concrete one, so propagating would overwrite a
 *             real value with a placeholder. Those pairs are recorded beside
 *             the router config, each against BOTH texts' fingerprints, and
 *             this report renders them as `excluded` with the reason. Change
 *             either text and the record stops matching: the pair comes back for
 *             examination — `stale` if a text moved, `obsolete` if the two were
 *             reconciled — which is the whole point of pinning two fingerprints
 *             rather than exempting a convention by name. An exclusion is a
 *             non-write boundary, never a certificate that the text is right.
 *
 *             WHAT AN EXCLUSION MAY AND MAY NOT REACH. It quietens an OBSERVED
 *             drift warning to info — that is the feature. It cannot touch an
 *             error, and it cannot touch a finding that answers a different
 *             question about the same pair (a declaration verdict, a baseline
 *             verdict): those keep their own words. So the document is optional
 *             in the strong sense — absent, the report is noisier and nothing is
 *             hidden. Malformed, or in a place that cannot hold a file, is a
 *             different answer and fails the run.
 *
 * NOTHING IN THIS SCRIPT WRITES. Not to a vault, not to the baseline, not to
 * the repository. It reads and prints.
 *
 * Flags:
 *   --check              audit this repository's own CLAUDE.md templates
 *   --fleet              audit every vault in the router config (read-only)
 *   --vault <name|path>  restrict --fleet to one vault
 *   --config <path>      router config (default: the usual per-user location)
 *   --snippets <dir>     snippet library (default: this repo's)
 *   --baseline <path>    baseline document (default: contracts/…-baseline.json)
 *   --exclusions <path>  fleet exclusions record (default: beside the config)
 *   --json               emit one JSON document instead of the tables
 *   --quiet              print only what needs attention
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  auditConventionDrift,
  conventionFingerprint,
  DRIFT_STATUS,
  normaliseTargetFile,
} from '../src/helpers/convention-drift.mjs';
import { applyFleetExclusions, FLEET_EXCLUSION, readFleetExclusions } from '../src/helpers/conventions-fleet-exclusions.mjs';
import { CLAUDE_MD_CANDIDATES, resolveClaudeMd } from '../src/helpers/claude-md-conventions.mjs';
import { scanAtxHeadings } from '../src/helpers/markdown-headings.mjs';
import { configuredVaultName, referenceVaultPath, registeredVaultPaths } from '../src/helpers/vault-slug.mjs';
import { samePath } from './path-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

/**
 * The `CLAUDE.md` copies this repository ships, and therefore answers for —
 * each with the conventions it is DECLARED to carry.
 *
 * `expects` is not documentation, it is the half of the check that the two
 * texts cannot supply. Without it, deleting an installed section or renaming a
 * snippet's heading turns the pair into "never installed", which is green: a
 * convention can vanish from a shipped template and nothing says a word. With
 * it, a disappearance is an error and a deliberate uninstall is a one-line
 * edit here — the friction sits where the decision is made.
 *
 * Kept in code rather than in the baseline JSON on purpose: a declaration that
 * lives in a file the check also reads for exemptions can be emptied by a typo
 * in a key, and an empty declaration is a silent pass. This list is reviewed
 * the way code is, and a test pins every entry against the repository.
 */
// EMPTY `expects`, NOT a removed entry — and the difference is the whole point.
// The decision `conventions-livrees-par-le-modele` (2026-09-11) took the four
// stylistic conventions out of everything that seeds a new vault, and these two
// files each carried one. Dropping their rows would leave the check governing
// nothing; keeping them with an empty expectation is what makes the
// exhaustiveness assertion in `tests/convention-drift.test.mjs` fail the day one
// reappears.
//
// THE GUARANTEE IS NARROWER THAN IT SOUNDS, and review was right to press on it:
// what cannot come back unnoticed is a RECOGNISED library convention — one whose
// heading matches a snippet's identity. The same rule restored under a heading
// no snippet identity matches reads as ABSENT, the assertion compares two empty
// arrays, and it passes. That is not hypothetical here: this very file carried
// `heading-hierarchy` and `source-type` under such headings until 2026-09-11,
// which is why neither this check nor the first pass of the cut could see them.
// A human read found them. Nothing automated would have.
export const GOVERNED_TARGETS = Object.freeze([
  Object.freeze({ file: 'templates/wiki/CLAUDE.md', expects: Object.freeze([]) }),
  Object.freeze({ file: 'templates/reference-vault-skeleton/CLAUDE.md', expects: Object.freeze([]) }),
]);

export const DEFAULT_SNIPPETS_DIR = 'skills/conventions/snippets';
export const DEFAULT_BASELINE = 'contracts/conventions-drift-baseline.json';

/**
 * Where the fleet exclusions record lives — BESIDE THE ROUTER CONFIG, not in
 * this repository, and the location is an argument rather than an accident.
 *
 * The baseline in `contracts/` governs the `CLAUDE.md` copies this repo ships:
 * it is this project's business, it travels with the code, and CI enforces it.
 * An exclusion describes a section of a `CLAUDE.md` on one person's disk — it
 * names their vaults and fingerprints their private text. That record belongs
 * with the thing it describes, which is the fleet, which is the config's world.
 * Committing it here would also put the repository's tests in the position of
 * asserting things about a machine they will never see.
 */
export const DEFAULT_FLEET_EXCLUSIONS = 'conventions-fleet-exclusions.json';

const COLORS = {
  reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', gray: '\x1b[90m', bold: '\x1b[1m',
};
const c = (color, s) => `${COLORS[color]}${s}${COLORS.reset}`;

/**
 * Read the snippet library.
 *
 * The identity is the snippet's FIRST heading, taken with the shared scanner
 * rather than by slicing the first line: a snippet that ever acquires a lead
 * paragraph, or a frontmatter block, must still be read correctly, and the
 * scanner is the one definition of what a heading is in this repository.
 *
 * WHAT IS COMPARED IS THE SECTION, NOT THE FILE. A review round found the
 * asymmetry: the target side is a section extracted at its heading, while the
 * snippet side was the whole file — so a snippet carrying a distribution
 * comment or a frontmatter block above its heading reported DRIFT against a
 * copy of its own bytes. `text` therefore runs from the identity heading to
 * end of file. To end of file and not to the next heading, because `install`
 * appends the whole file: what lands in a `CLAUDE.md` is everything from the
 * heading down.
 *
 * Two refusals rather than guesses, each with its counterexample:
 *
 *   - a first heading that is not a level-2 one at column 0. The library's
 *     identity rule is exactly that shape, and a file breaking it would be
 *     compared against a heading no `CLAUDE.md` can contain, reporting
 *     "absent" everywhere forever.
 *   - MORE THAN ONE level-2 heading at column 0. `install` would append both
 *     sections while the target-side extractor stops at the second, so the
 *     pair could never be in step. That is a snippet that cannot be checked,
 *     and it must say so rather than drift permanently.
 *
 * @param {string} dir
 * @returns {{snippets: Array<{id: string, heading: string, text: string,
 *   sha256: string}>, errors: string[]}}
 */
export function loadSnippetLibrary(dir) {
  const snippets = [];
  const errors = [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')).sort();
  } catch (err) {
    return { snippets, errors: [`cannot read snippet library ${dir}: ${err.message}`] };
  }
  for (const f of files) {
    const full = path.join(dir, f);
    let raw;
    try {
      raw = fs.readFileSync(full, 'utf8');
    } catch (err) {
      errors.push(`cannot read ${f}: ${err.message}`);
      continue;
    }
    const tops = scanAtxHeadings(raw).filter((h) => h.indent === 0 && h.level === 2);
    const first = scanAtxHeadings(raw)[0];
    if (!first || first.level !== 2 || first.indent !== 0) {
      errors.push(`${f}: first heading is not a level-2 heading at column 0 — not a convention snippet`);
      continue;
    }
    if (tops.length > 1) {
      errors.push(`${f}: ${tops.length} level-2 headings — a snippet must carry exactly one convention, or it can never compare equal to an installed copy`);
      continue;
    }
    const text = raw.slice(first.start);
    snippets.push({
      id: f.replace(/\.md$/i, ''),
      heading: first.text,
      text,
      sha256: conventionFingerprint(text),
    });
  }
  return { snippets, errors };
}

function readFileOrNull(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Read a file, keeping ABSENT and FAILED apart.
 *
 * `readFileOrNull` folds the two, which is right where the file is required —
 * either way the caller has nothing to work with. It is wrong where the file is
 * OPTIONAL: there, "not there" is an ordinary state and "there but unreadable"
 * is this run failing to look, and a single `null` would let a permissions
 * error read as a deliberate absence.
 *
 * ONLY `ENOENT` IS ABSENCE. `locateVaultClaudeMd` also accepts `ENOTDIR`,
 * because there a missing parent directory genuinely means the candidate file
 * is not there. Here the path was NAMED — by `--exclusions`, or by the config's
 * own directory — and `ENOTDIR` means a component of it is a file: a malformed
 * location, not a missing optional record. A review round found this exact
 * conflation letting `--exclusions <a-regular-file>/x.json` report "no
 * exclusions" and exit 0.
 *
 * @param {string} p
 * @returns {{content: string|null, absent: boolean, error: string|null}}
 */
function readFileOrAbsent(p) {
  try {
    return { content: fs.readFileSync(p, 'utf8'), absent: false, error: null };
  } catch (err) {
    if (err.code !== 'ENOENT') return { content: null, absent: false, error: err.message };
    // ENOENT IS NOT PROOF OF ABSENCE ON EVERY PLATFORM. Measured 2026-09-14:
    // reading `<a regular file>/x.json` raises ENOTDIR on POSIX and ENOENT on
    // Windows — so the error code alone cannot tell "nobody put a record here"
    // from "this path is impossible". Walking up answers it the same way
    // everywhere, and the answer is cheap: an ancestor that exists and is not a
    // directory means the location is malformed.
    //
    // A DANGLING SYMLINK AT THE PATH ITSELF also reads ENOENT, and the walk
    // starts at the PARENT, so it would never look at the link. `lstat` on the
    // leaf answers that one: something is there, it just does not resolve.
    try {
      fs.lstatSync(p);
      return { content: null, absent: false, error: `${p} exists but does not resolve (broken link?)` };
    } catch (probe) {
      // ONLY ENOENT MEANS "NOTHING IS THERE". A probe that failed for any other
      // reason — a permission change between the two calls, most plainly — has
      // established nothing, and swallowing it would turn "I could not look"
      // into "I looked and it was empty", which is the one conversion this
      // whole function exists to prevent.
      if (probe.code !== 'ENOENT') {
        return { content: null, absent: false, error: `cannot probe ${p}: ${probe.message}` };
      }
    }
    const broken = firstBrokenAncestor(p);
    if (broken !== null) return { content: null, absent: false, error: broken };
    return { content: null, absent: true, error: null };
  }
}

/**
 * Why the path cannot hold a file — as a sentence — or `null` if nothing along
 * it exists at all.
 *
 * WALKS TO THE ROOT, with no iteration budget, and a review round is why the
 * first version's budget of 64 was wrong rather than merely arbitrary: a
 * blocking file sitting above 64 non-existent components exhausted the budget
 * and returned the same `null` as a verified-empty tree. "I gave up" and "I
 * looked everywhere" must not share a return value.
 *
 * `lstat` FIRST, THEN `stat`, and the order is the second review finding. A
 * plain `stat` FOLLOWS a symlink, so an ancestor that is a link to a directory
 * somebody has since deleted fails exactly like a component that was never
 * there — the walk climbs straight past it and reports absence for a location
 * that demonstrably exists and is broken. `lstat` sees the link itself; `stat`
 * then says whether it leads anywhere.
 *
 * Termination does not need a counter. `path.dirname` strictly shortens the
 * path until it reaches a fixed point (`/`, `C:\`, or a UNC share root), and
 * that fixed point is the loop's only exit besides finding something.
 *
 * @param {string} p
 * @returns {string|null}
 */
function firstBrokenAncestor(p) {
  let dir = path.dirname(path.resolve(p));
  for (;;) {
    let link;
    try {
      link = fs.lstatSync(dir);
    } catch (err) {
      if (err.code !== 'ENOENT') return `cannot probe ${dir}: ${err.message}`;
      const parent = path.dirname(dir);
      if (parent === dir) return null; // reached the root: nothing exists along the path
      dir = parent;
      continue;
    }
    if (link.isSymbolicLink()) {
      try {
        return fs.statSync(dir).isDirectory() ? null : `${dir} is not a directory`;
      } catch (err) {
        return `${dir} is a link that does not resolve (${err.code})`;
      }
    }
    return link.isDirectory() ? null : `${dir} is not a directory`;
  }
}

function readJsonOrNull(p) {
  const raw = readFileOrNull(p);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * EVERY conventions file a vault has on disk — not the one the skill would
 * write to.
 *
 * `resolveClaudeMd` refuses to choose between two candidates, and it is right
 * to: an installer that picks one of two rule sets writes into a file nobody
 * may be reading. But THIS tool asks a different question — "what do the
 * conventions in this vault currently say?" — and for that question the
 * refusal is blindness. Measured on 2026-09-11: eleven of the twenty-eight
 * vaults on this machine carry two `CLAUDE.md` copies, so honouring the
 * refusal here reported nothing at all for the majority of the fleet while
 * looking like a clean run.
 *
 * So every present candidate is examined and labelled, and the caller is told
 * when there was more than one — which is itself worth knowing, since it is
 * exactly the state that stops the `conventions` skill from acting.
 *
 * @param {string} vaultPath
 * @returns {{files: Array<{path: string, relative: string}>, ambiguous: boolean}}
 */
export function locateVaultClaudeMd(vaultPath) {
  const present = [];
  const unreadable = [];
  for (const rel of CLAUDE_MD_CANDIDATES) {
    try {
      if (fs.statSync(path.join(vaultPath, ...rel.split('/'))).isFile()) present.push(rel);
    } catch (err) {
      // ABSENCE AND FAILURE ARE DIFFERENT ANSWERS. `catch { return false }`
      // turned a permission error on a directory into "this vault has no
      // CLAUDE.md" — a vault silently dropped from the report while the run
      // exited 0. Only the errors that MEAN absence are absence.
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') {
        unreadable.push({ relative: rel, message: err.message });
      }
    }
  }
  return {
    files: present.map((rel) => ({ path: path.join(vaultPath, ...rel.split('/')), relative: rel })),
    ambiguous: resolveClaudeMd(present).ambiguous,
    unreadable,
  };
}

/** The level-2 headings of a file that match no snippet identity. */
function unmatchedSections(content, snippets) {
  const known = new Set(snippets.map((s) => s.heading));
  return scanAtxHeadings(content)
    .filter((h) => h.indent === 0 && h.level === 2 && !known.has(h.text))
    .map((h) => ({ heading: h.text, line: h.line }));
}

function parseArgs(argv) {
  const opts = {
    mode: null, json: false, quiet: false, vault: null,
    config: null, snippets: null, baseline: null, exclusions: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--check') opts.mode = 'check';
    else if (a === '--fleet') opts.mode = 'fleet';
    else if (a === '--json') opts.json = true;
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--vault') { opts.vault = argv[i + 1] ?? null; i += 1; }
    else if (a === '--config') { opts.config = argv[i + 1] ?? null; i += 1; }
    else if (a === '--snippets') { opts.snippets = argv[i + 1] ?? null; i += 1; }
    else if (a === '--baseline') { opts.baseline = argv[i + 1] ?? null; i += 1; }
    else if (a === '--exclusions') { opts.exclusions = argv[i + 1] ?? null; i += 1; }
    else if (a === '--help' || a === '-h') opts.mode = 'help';
    else if (a.startsWith('-')) opts.unknown = a;
  }
  return opts;
}

const USAGE = [
  'Usage: node scripts/conventions-drift.mjs --check | --fleet [options]',
  '',
  '  --check              audit the CLAUDE.md templates this repo ships (exit 1 on error)',
  '  --fleet              audit the vaults in the router config, read-only (drift never',
  '                       fails the run; being unable to scan does)',
  '  --vault <name|path>  restrict --fleet to one vault',
  '  --config <path>      router config to read for --fleet',
  '  --snippets <dir>     snippet library to compare against',
  '  --baseline <path>    accepted-divergence baseline (--check)',
  '  --exclusions <path>  fleet exclusions record (--fleet); default: next to the config',
  '  --json               emit JSON instead of tables',
  '  --quiet              print only what needs attention',
  '',
  'Nothing here writes. --fleet reports; applying a convention is a per-vault',
  'decision, taken through the conventions skill and its backup guards.',
].join('\n');

/**
 * The size of a divergence, in the words the count deserves.
 *
 * ONE formatter, used by every caller that prints a count. The accepted branch
 * had its own, which dropped `exactCount` — so a large reordering, where the
 * degraded fallback returns a lower bound of 0, printed "accepted (0 lines)"
 * for a pair whose exact figure was in the thousands. A number presented as
 * exact when it is a floor is worse than no number.
 */
export function driftSize(f) {
  const unit = f.driftLines === 1 ? 'line' : 'lines';
  return f.exactCount ? `${f.driftLines} ${unit}` : `at least ${f.driftLines} ${unit}`;
}

export function statusLabel(f) {
  if (f.verdict === 'accepted') return c('cyan', `accepted (${driftSize(f)})`);
  if (f.verdict === FLEET_EXCLUSION.EXCLUDED) return c('cyan', `excluded — do not propagate (${driftSize(f)})`);
  if (f.verdict === FLEET_EXCLUSION.STALE) return c('yellow', 'exclusion STALE — re-examine');
  if (f.verdict === FLEET_EXCLUSION.OBSOLETE) return c('yellow', 'exclusion OBSOLETE');
  if (f.verdict === FLEET_EXCLUSION.UNVERIFIABLE) return c('yellow', 'exclusion UNVERIFIABLE');
  if (f.verdict === FLEET_EXCLUSION.UNMATCHED) return c('yellow', 'exclusion UNMATCHED');
  if (f.verdict === 'baseline-stale') return c('red', 'baseline STALE');
  if (f.verdict === 'baseline-obsolete') return c('red', 'baseline OBSOLETE');
  if (f.verdict === 'baseline-unmatched') return c('red', 'baseline UNMATCHED');
  if (f.verdict === 'missing-convention') return c('red', 'DECLARED but absent');
  if (f.verdict === 'unexpected-convention') return c('red', 'present but UNDECLARED');
  if (f.verdict === 'duplicate-identity') {
    return c(f.severity === 'error' ? 'red' : 'yellow', 'duplicate identity');
  }
  if (f.status === DRIFT_STATUS.DRIFT) {
    return c(f.severity === 'error' ? 'red' : 'yellow', `drift — ${driftSize(f)}`);
  }
  if (f.status === DRIFT_STATUS.ABSENT) return c('gray', 'not installed');
  return c('green', 'identical');
}

/**
 * How many CONVENTIONS of this target are in each state — counted over
 * distinct convention ids, not over findings.
 *
 * One pair can produce two findings (an undeclared section is reported AND
 * still compared), and counting findings printed "2 identical" for a file
 * carrying one convention. A diagnostic must not inflate a total.
 *
 * `notable` KEEPS THE INFO-SEVERITY VERDICTS THAT NAME A HUMAN DECISION —
 * `accepted` and `excluded`. Both describe a live divergence somebody signed
 * for, and both are the reason the pair is quiet; dropping them from the render
 * would leave the pair reported nowhere at all. A drift that is deliberately
 * not being fixed must still be visible, or the record stops being read.
 */
export function summariseTarget(findings) {
  const byStatus = (status, predicate = () => true) => {
    const ids = new Set();
    for (const f of findings) {
      if (f.status === status && predicate(f)) ids.add(f.convention);
    }
    return ids.size;
  };
  return {
    identical: byStatus(DRIFT_STATUS.IDENTICAL),
    absent: byStatus(DRIFT_STATUS.ABSENT, (f) => f.severity === 'info'),
    notable: findings.filter((f) => (
      f.severity !== 'info'
      || f.verdict === 'accepted'
      || f.verdict === FLEET_EXCLUSION.EXCLUDED
    )),
  };
}

function printTarget(label, findings, extra, quiet) {
  // All of the renderer's arithmetic lives in `summariseTarget`, so there is
  // nothing here that can diverge from what a test pins.
  const { identical, absent, notable } = summariseTarget(findings);

  if (quiet && notable.length === 0) return;

  console.log('');
  console.log(c('bold', label));
  if (extra) console.log(c('gray', `  ${extra}`));
  if (notable.length === 0) {
    console.log(c('green', `  ✓ ${identical} identical, ${absent} not installed`));
    return;
  }
  for (const f of notable) {
    console.log(`  ${f.convention.padEnd(28)} ${statusLabel(f)}`);
    if (f.reason) console.log(c('gray', `  ${' '.repeat(28)}   reason: ${f.reason}`));
    if (f.detail) console.log(c('gray', `  ${' '.repeat(28)}   ${f.detail}`));
  }
  console.log(c('gray', `  (${identical} identical, ${absent} not installed)`));
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.mode === 'help' || opts.mode === null) {
    console.log(USAGE);
    process.exit(opts.mode === 'help' ? 0 : 2);
  }

  const snippetsDir = opts.snippets
    ? path.resolve(opts.snippets)
    : path.join(REPO, ...DEFAULT_SNIPPETS_DIR.split('/'));
  const { snippets, errors: libraryErrors } = loadSnippetLibrary(snippetsDir);
  const baselinePath = opts.baseline
    ? path.resolve(opts.baseline)
    : path.join(REPO, ...DEFAULT_BASELINE.split('/'));

  // A PARTIAL LIBRARY IS A FAILED SCAN, not a smaller one. The first version
  // only bailed when NOTHING loaded, so one refused snippet among twelve
  // printed a warning and then reported on the eleven — a clean-looking run
  // that had silently stopped checking a convention. An EMPTY library is the
  // same failure with no message at all: zero comparisons, exit 0, "no drift".
  for (const e of libraryErrors) console.error(c('red', `✗ ${e}`));
  if (snippets.length === 0) {
    libraryErrors.push(`no convention snippets loaded from ${snippetsDir} — nothing could be compared`);
    console.error(c('red', `✗ ${libraryErrors[libraryErrors.length - 1]}`));
  }
  if (libraryErrors.length > 0 && opts.mode === 'fleet') {
    if (opts.json) console.log(JSON.stringify({ mode: 'fleet', libraryErrors, ok: false }, null, 2));
    process.exit(1);
  }

  if (opts.mode === 'check') {
    // A BASELINE THAT CANNOT BE READ IS NOT AN EMPTY BASELINE. Falling back to
    // `{entries: []}` on a missing or unparseable file means deleting it, or
    // breaking its JSON, silently discharges every acceptance it held — and
    // with them the duty to remove an obsolete one. `readDriftBaseline` refuses
    // the malformed shapes; this refuses the missing and unreadable file.
    const baselineRaw = readFileOrNull(baselinePath);
    // UNDEFINED, not null: if the file could not be read there is no document,
    // and handing the audit a `null` to validate makes TWO guards answer the
    // same question — which is how a mutation removing the exit-code guard
    // stayed green. The audit now sees a clean run and `baselineIoErrors` alone
    // decides, while a file that genuinely CONTAINS `null` still reaches the
    // audit and is refused there. One question, one guard, each with a witness.
    let baseline;
    const baselineIoErrors = [];
    if (baselineRaw === null) {
      baselineIoErrors.push(`cannot read the baseline at ${baselinePath}`);
    } else {
      try {
        baseline = JSON.parse(baselineRaw);
      } catch (err) {
        baselineIoErrors.push(`the baseline at ${baselinePath} is not valid JSON: ${err.message}`);
      }
    }
    const targets = [];
    const missing = [];
    for (const { file: rel, expects } of GOVERNED_TARGETS) {
      const content = readFileOrNull(path.join(REPO, ...rel.split('/')));
      if (content === null) { missing.push(rel); continue; }
      // Keyed through the same normaliser the audit uses: a caller that builds
      // its key any other way stops matching its own findings.
      targets.push({
        file: normaliseTargetFile(rel), content, governed: true, label: rel, expects: [...expects],
      });
    }
    const audit = auditConventionDrift({ snippets, targets, baseline });
    const extras = new Map(
      targets.map((t) => [t.file, unmatchedSections(t.content, snippets)]),
    );
    const baselineErrors = [...baselineIoErrors, ...audit.baselineErrors];
    const ok = audit.ok
      && missing.length === 0
      && libraryErrors.length === 0
      && baselineIoErrors.length === 0;

    if (opts.json) {
      console.log(JSON.stringify({
        mode: 'check',
        snippets: snippets.map((s) => ({ id: s.id, heading: s.heading, sha256: s.sha256 })),
        baseline: baselinePath,
        baselineErrors,
        libraryErrors,
        missingTargets: missing,
        unmatchedSections: Object.fromEntries(extras),
        findings: audit.findings,
        counts: audit.counts,
        ok,
      }, null, 2));
    } else {
      console.log(c('bold', `Conventions drift — ${snippets.length} snippets, ${targets.length} governed files`));
      for (const e of baselineErrors) console.error(c('red', `✗ baseline: ${e}`));
      for (const m of missing) console.error(c('red', `✗ governed file missing: ${m}`));
      for (const t of targets) {
        const other = extras.get(t.file) ?? [];
        printTarget(
          t.file,
          audit.findings.filter((f) => f.file === t.file),
          other.length > 0
            ? `${other.length} level-2 section(s) here match no snippet identity: ${other.map((o) => `"${o.heading}"`).join(', ')}`
            : null,
          opts.quiet,
        );
      }
      console.log('');
      if (ok) {
        console.log(c('green', `✓ no undeclared drift (${audit.counts.accepted} accepted divergence(s))`));
      } else {
        console.log(c('red', `✗ ${audit.counts.errors + baselineIoErrors.length} error(s) — propagate the change, or record it in ${DEFAULT_BASELINE} with a reason`));
      }
    }
    process.exit(ok ? 0 : 1);
  }

  // --fleet
  const configPath = opts.config
    ? path.resolve(opts.config)
    : path.join(os.homedir(), '.claude', 'obsidian-mcp-router', 'config.json');
  const cfg = readJsonOrNull(configPath);
  if (cfg === null) {
    console.error(c('red', `✗ cannot read router config: ${configPath}`));
    process.exit(1);
  }

  // The reference vault is NOT in the registry — it is a separate config field
  // — and it is the single most important file this report can look at: every
  // vault provisioned from it inherits its conventions verbatim. The 2026-09-11
  // measurement was taken on it, and a fleet report that silently omits it
  // would miss the drift it exists to find.
  // Through the boundary helper, never off the config object: `referenceVault`
  // is hand-editable, and the sinks below are `path.resolve` and `path.join`,
  // which throw a TypeError on a non-string rather than failing closed.
  let vaultPaths = registeredVaultPaths(cfg);
  const reference = referenceVaultPath(cfg);
  // `samePath`, not a lowercased string compare. On a case-sensitive
  // filesystem `/srv/vaults/Docs` and `/srv/vaults/docs` are two directories:
  // folding the case concludes the reference is already registered, never scans
  // it, and labels the OTHER vault as the reference. The helper asks the
  // filesystem instead, which is also what `setup-vault`'s self-skip learned to
  // do after a `--force` sync ate the source's own plugin folder.
  if (reference && !vaultPaths.some((p) => samePath(p, reference))) {
    vaultPaths = [reference, ...vaultPaths];
  }
  if (opts.vault) {
    const want = opts.vault.toLowerCase();
    // Both names, not one. The router's slug strips a leading dot, so the
    // reference vault at `C:\VAULTS\.template` is configured as `template` —
    // and `--vault .template`, which is what a reader types after looking at
    // the path, matched nothing at all.
    // A PATH is compared as a path (`samePath` asks the filesystem); a NAME is
    // compared case-insensitively, because a name is something a human types.
    // The two questions were folded together in the first version, which made
    // a path comparison inherit the name comparison's case-blindness.
    vaultPaths = vaultPaths.filter((p) => (
      samePath(p, opts.vault)
      || (configuredVaultName(cfg, p) ?? '').toLowerCase() === want
      || path.basename(p).toLowerCase() === want
    ));
    if (vaultPaths.length === 0) {
      console.error(c('red', `✗ no configured vault matches "${opts.vault}"`));
      process.exit(1);
    }
  }

  const targets = [];
  const skipped = [];
  const multiFile = [];
  const unreadableTargets = [];
  const selectedVaultNames = [];
  for (const vaultPath of vaultPaths) {
    const configured = configuredVaultName(cfg, vaultPath);
    selectedVaultNames.push(configured ?? path.basename(vaultPath));
    const isReference = reference !== null && samePath(vaultPath, reference);
    const name = `${configured ?? path.basename(vaultPath)}${isReference ? ' (reference)' : ''}`;
    const located = locateVaultClaudeMd(vaultPath);
    for (const u of located.unreadable) {
      // `relative` alongside the prose, because the exclusions record is keyed
      // on (vault, relative file): a vault with two conventions files, one
      // readable and one not, must not have the readable one vouch for the
      // other's coverage.
      unreadableTargets.push({ vault: configured ?? path.basename(vaultPath), label: name, relative: u.relative, path: vaultPath, reason: `cannot examine ${u.relative}: ${u.message}` });
    }
    if (located.files.length === 0) {
      if (located.unreadable.length === 0) {
        // `vault` is the plain configured name the exclusions record is keyed
        // on; `label` keeps the "(reference)" marker for the reader.
        skipped.push({ vault: configured ?? path.basename(vaultPath), label: name, path: vaultPath, reason: 'no CLAUDE.md' });
      }
      continue;
    }
    if (located.ambiguous) {
      multiFile.push({ vault: name, files: located.files.map((f) => f.relative) });
    }
    for (const file of located.files) {
      const content = readFileOrNull(file.path);
      if (content === null) {
        // The subject of the audit could not be read. That is not an absence
        // and not a finding: it is this run failing to look, and it belongs in
        // the exit code.
        unreadableTargets.push({ vault: configured ?? path.basename(vaultPath), label: name, relative: file.relative, path: vaultPath, reason: `cannot read ${file.relative}` });
        continue;
      }
      targets.push({
        file: normaliseTargetFile(file.path),
        content,
        governed: false,
        label: `${name} — ${file.relative}`,
        // The identity an exclusion is written in terms of. `name` carries the
        // " (reference)" suffix for the reader; `configured` is what a human
        // writes in the record, and keying on the label instead would make the
        // reference vault's entries stop matching the day it stops being the
        // reference.
        vault: configured ?? path.basename(vaultPath),
        relative: file.relative,
      });
    }
  }

  // No `baseline:` key at all — a baseline never applies to an observed vault,
  // and passing `null` to mean that is the very ambiguity a review round found.
  const audit = auditConventionDrift({ snippets, targets });

  // THE EXCLUSIONS RECORD. Optional by design (see the header): absent, the
  // report simply says so and every drift stays `observed`. Present but
  // unreadable or malformed is this run failing to look, and fails the run —
  // the same line the exit code already draws between "the fleet says X" and
  // "this scan did not happen".
  const exclusionsPath = opts.exclusions
    ? path.resolve(opts.exclusions)
    : path.join(path.dirname(configPath), DEFAULT_FLEET_EXCLUSIONS);
  const exclusionIoErrors = [];
  let exclusionEntries = [];
  let exclusionErrors = [];
  const read = readFileOrAbsent(exclusionsPath);
  if (read.error !== null) {
    exclusionIoErrors.push(`cannot read the exclusions record at ${exclusionsPath}: ${read.error}`);
  } else if (!read.absent) {
    let doc;
    try {
      doc = JSON.parse(read.content);
    } catch (err) {
      exclusionIoErrors.push(`the exclusions record at ${exclusionsPath} is not valid JSON: ${err.message}`);
    }
    if (doc !== undefined) {
      const parsed = readFleetExclusions(doc);
      exclusionEntries = parsed.entries;
      exclusionErrors = parsed.errors;
    }
  }
  const applied = applyFleetExclusions({
    findings: audit.findings,
    locations: targets,
    entries: exclusionEntries,
    examinedWholeFleet: opts.vault === null,
    // Per (vault, file), so a readable sibling cannot vouch for a file this run
    // failed to open.
    unread: unreadableTargets,
    // Vaults the run enumerated successfully, INCLUDING those that turned out
    // to hold no conventions file: "nothing there" is an answer, not a failure.
    inspected: skipped.map((sk) => sk.vault),
    // What was actually compared, so an entry naming a convention the library
    // no longer provides is told that, rather than "not found in this file".
    compared: snippets.map((sn) => sn.id),
    // SELECTED, not examined. `targets` holds the files this run actually read;
    // this list holds every vault it set out to look at, including the ones it
    // could not open and the ones with no conventions file. Without it, a vault
    // this run chose and failed to cover has its record filed as "about another
    // vault" — a statement that is simply false.
    selected: selectedVaultNames,
  });
  audit.findings = applied.findings;
  const exclusionCounts = applied.counts;
  const exclusionBlocking = exclusionIoErrors.length > 0 || exclusionErrors.length > 0;

  if (opts.json) {
    console.log(JSON.stringify({
      mode: 'fleet',
      config: configPath,
      referenceVault: reference,
      files: targets.length,
      libraryErrors,
      multipleConventionsFiles: multiFile,
      unreadable: unreadableTargets,
      skipped,
      exclusions: {
        path: exclusionsPath,
        present: !read.absent && read.error === null,
        entries: exclusionEntries.length,
        ioErrors: exclusionIoErrors,
        errors: exclusionErrors,
        counts: exclusionCounts,
      },
      findings: audit.findings,
      counts: audit.counts,
      ok: unreadableTargets.length === 0 && !exclusionBlocking,
    }, null, 2));
  } else {
    console.log(c('bold', `Conventions drift across the fleet — ${targets.length} conventions file(s), ${snippets.length} snippets`));
    console.log(c('gray', `config: ${configPath}`));
    console.log(c('gray', 'Read-only. Applying a convention is a per-vault decision — nothing here changes a file.'));
    if (read.absent) {
      console.log(c('gray', `no exclusions record at ${exclusionsPath} — every divergence below is reported as observed`));
    } else {
      console.log(c('gray', `exclusions: ${exclusionEntries.length} recorded — ${exclusionsPath}`));
    }
    for (const e of exclusionIoErrors) console.error(c('red', `✗ exclusions: ${e}`));
    for (const e of exclusionErrors) console.error(c('red', `✗ exclusions: ${e}`));
    for (const t of targets) {
      printTarget(t.label, audit.findings.filter((f) => f.file === t.file), null, opts.quiet);
    }
    if (multiFile.length > 0) {
      console.log('');
      console.log(c('bold', 'Two conventions files in one vault'));
      console.log(c('gray', '  Both are reported above. Only one of them is being read at session start, and'));
      console.log(c('gray', '  the conventions skill refuses to install or remove anything while both exist.'));
      for (const m of multiFile) console.log(c('yellow', `  ${m.vault} — ${m.files.join(' + ')}`));
    }
    if (skipped.length > 0) {
      console.log('');
      console.log(c('bold', 'Not examined — nothing there to read'));
      for (const s of skipped) console.log(c('gray', `  ${s.label ?? s.vault} — ${s.reason}`));
    }
    if (unreadableTargets.length > 0) {
      console.log('');
      console.log(c('bold', 'Could not be read — this run did not cover them'));
      // `label` keeps the "(reference)" marker the reader knows the vault by;
      // `vault` is the plain configured name the exclusions record is keyed on.
      for (const s of unreadableTargets) console.error(c('red', `  ${s.label ?? s.vault} — ${s.reason}`));
    }
    const unmatched = audit.findings.filter((f) => f.verdict === FLEET_EXCLUSION.UNMATCHED);
    if (unmatched.length > 0) {
      console.log('');
      console.log(c('bold', 'Exclusions this scan never matched'));
      // IN SCOPE IS PRINTED, OUT OF SCOPE IS COLLAPSED — and the split is the
      // helper's `inScope`, not this renderer's guess. On a one-vault run every
      // record about ANOTHER vault is legitimately unexamined, and listing
      // hundreds of them buries the report under noise a reader learns to skip.
      // But a record about THE vault being examined, whose file was not found,
      // is a real finding: a conventions file moved between candidate locations
      // looks exactly like this. The first version collapsed both together
      // under "outside this run", which filed the only real one under a
      // sentence saying it did not apply.
      const inScope = unmatched.filter((f) => f.inScope);
      for (const f of inScope) {
        console.log(c('yellow', `  ${f.convention} — ${f.label}`));
        console.log(c('gray', `    ${f.detail}`));
      }
      const elsewhere = unmatched.filter((f) => !f.inScope);
      if (elsewhere.length > 0) {
        if (opts.vault !== null) {
          console.log(c('gray', `  ${elsewhere.length} record(s) about other vaults — re-run without --vault to check them`));
        } else {
          for (const f of elsewhere) {
            console.log(c('yellow', `  ${f.convention} — ${f.label}`));
            console.log(c('gray', `    ${f.detail}`));
          }
        }
      }
    }
    console.log('');
    console.log(`${audit.counts.drift} drifting, ${audit.counts.identical} identical, ${audit.counts.absent} not installed, ${audit.counts.duplicate} duplicate-identity`);
    // Printed even when every figure is zero: an exclusions record whose
    // entries all silently stopped applying is exactly the state this line has
    // to make visible, and a line that disappears when it has nothing good to
    // say is a line nobody learns to look for.
    console.log(
      `${exclusionCounts.excluded} excluded by record`
      + `, ${exclusionCounts.stale} stale`
      + `, ${exclusionCounts.obsolete} obsolete`
      + `, ${exclusionCounts.unverifiable} unverifiable`,
    );
    // UNMATCHED IS SPLIT, because one total mixes three different messages: a
    // record that is wrong, a record this run failed to cover, and a record
    // about a vault nobody asked about. On a restricted run the third dominates,
    // and a single figure trained the reader to ignore all three.
    const unevaluated = audit.findings.filter((f) => f.verdict === FLEET_EXCLUSION.UNEVALUATED);
    if (unevaluated.length > 0) {
      console.log('');
      console.log(c('bold', 'Exclusions this scan could not check'));
      for (const f of unevaluated) {
        console.log(c('yellow', `  ${f.convention} — ${f.label}`));
        console.log(c('gray', `    ${f.detail}`));
      }
    }
    console.log(
      `${exclusionCounts.unmatched} unmatched`
      + ` — ${exclusionCounts.examined} examined and not found`
      + `, ${exclusionCounts.unread} selected but unreadable`
      + `, ${exclusionCounts['unknown-convention']} naming a convention the library does not provide`
      + `, ${exclusionCounts.outside} about vaults this run did not select`
      + (exclusionCounts.unevaluated > 0 ? ` · ${exclusionCounts.unevaluated} matched but UNCHECKABLE` : ''),
    );
  }
  // 0 whatever the vaults SAY. A subject this run could not read is a different
  // thing — the report does not cover it, and an exit code that hid that would
  // let a permission error read as a clean fleet.
  //
  // A BROKEN EXCLUSIONS RECORD IS THE SAME KIND OF THING, not a finding about a
  // vault: the run could not tell which divergences a human had already ruled
  // on. A STALE or UNMATCHED entry is the opposite — it IS a finding, the one
  // the two fingerprints exist to produce, and it stays a warning like every
  // other thing a vault says.
  process.exit(unreadableTargets.length === 0 && !exclusionBlocking ? 0 : 1);
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
