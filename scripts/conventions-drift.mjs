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
// nothing AND silently allow a convention to come back here; keeping them with
// an empty expectation is what makes the exhaustiveness assertion in
// `tests/convention-drift.test.mjs` fail the day one reappears.
export const GOVERNED_TARGETS = Object.freeze([
  Object.freeze({ file: 'templates/wiki/CLAUDE.md', expects: Object.freeze([]) }),
  Object.freeze({ file: 'templates/reference-vault-skeleton/CLAUDE.md', expects: Object.freeze([]) }),
]);

export const DEFAULT_SNIPPETS_DIR = 'skills/conventions/snippets';
export const DEFAULT_BASELINE = 'contracts/conventions-drift-baseline.json';

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
    config: null, snippets: null, baseline: null,
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
  '  --baseline <path>    accepted-divergence baseline',
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
    notable: findings.filter((f) => f.severity !== 'info' || f.verdict === 'accepted'),
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
  for (const vaultPath of vaultPaths) {
    const configured = configuredVaultName(cfg, vaultPath);
    const isReference = reference !== null && samePath(vaultPath, reference);
    const name = `${configured ?? path.basename(vaultPath)}${isReference ? ' (reference)' : ''}`;
    const located = locateVaultClaudeMd(vaultPath);
    for (const u of located.unreadable) {
      unreadableTargets.push({ vault: name, path: vaultPath, reason: `cannot examine ${u.relative}: ${u.message}` });
    }
    if (located.files.length === 0) {
      if (located.unreadable.length === 0) {
        skipped.push({ vault: name, path: vaultPath, reason: 'no CLAUDE.md' });
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
        unreadableTargets.push({ vault: name, path: vaultPath, reason: `cannot read ${file.relative}` });
        continue;
      }
      targets.push({
        file: normaliseTargetFile(file.path),
        content,
        governed: false,
        label: `${name} — ${file.relative}`,
      });
    }
  }

  // No `baseline:` key at all — a baseline never applies to an observed vault,
  // and passing `null` to mean that is the very ambiguity a review round found.
  const audit = auditConventionDrift({ snippets, targets });

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
      findings: audit.findings,
      counts: audit.counts,
      ok: unreadableTargets.length === 0,
    }, null, 2));
  } else {
    console.log(c('bold', `Conventions drift across the fleet — ${targets.length} conventions file(s), ${snippets.length} snippets`));
    console.log(c('gray', `config: ${configPath}`));
    console.log(c('gray', 'Read-only. Applying a convention is a per-vault decision — nothing here changes a file.'));
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
      for (const s of skipped) console.log(c('gray', `  ${s.vault} — ${s.reason}`));
    }
    if (unreadableTargets.length > 0) {
      console.log('');
      console.log(c('bold', 'Could not be read — this run did not cover them'));
      for (const s of unreadableTargets) console.error(c('red', `  ${s.vault} — ${s.reason}`));
    }
    console.log('');
    console.log(`${audit.counts.drift} drifting, ${audit.counts.identical} identical, ${audit.counts.absent} not installed, ${audit.counts.duplicate} duplicate-identity`);
  }
  // 0 whatever the vaults SAY. A subject this run could not read is a different
  // thing — the report does not cover it, and an exit code that hid that would
  // let a permission error read as a clean fleet.
  process.exit(unreadableTargets.length === 0 ? 0 : 1);
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
