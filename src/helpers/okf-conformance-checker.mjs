/**
 * OKF conformance checker — validate a knowledge bundle against the three
 * conformance rules of Google's Open Knowledge Format v0.1 (SPEC.md §9):
 *
 *   1. Every non-reserved `.md` file contains a parseable YAML frontmatter
 *      block.
 *   2. Every frontmatter block contains a non-empty `type` field.
 *   3. Reserved filenames (`index.md`, `log.md`) follow the structure of
 *      §6 / §7 when present.
 *
 * Calibration (deliberate — matches OKF's permissive-consumption philosophy):
 * only violations of the three rules are ERRORS. Deviations the spec shows
 * by example but never marks MUST (heading level in indexes, bullet marker,
 * log entry order) are WARNINGS. Compatibility gaps with Google's stricter
 * reference implementation (filename charset, its four required frontmatter
 * keys) are INFO — a bundle can be fully spec-conformant and still trip
 * their tooling, and the consumer of this report should know both.
 *
 * Google ships NO standalone validator (validation lives inside their
 * reference agent's write path) — this checker doubles as one of the
 * ecosystem's first. Pure-functional: no I/O; the caller reads the bundle's
 * files and passes them in.
 */

import { parseFrontmatter } from './llms-txt-exporter.mjs';

const FRONTMATTER_BLOCK_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REFERENCE_IMPL_SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9_.\-]*$/;
const REFERENCE_IMPL_REQUIRED_KEYS = ['type', 'title', 'description', 'timestamp'];

/** Reserved basenames per §3.1. */
const RESERVED = new Set(['index.md', 'log.md']);

function finding(rule, path, detail) {
  return { rule, path, detail };
}

/**
 * Coarse "is this actually parseable YAML" sanity check for rule 1. Our own
 * frontmatter reader (`parseFrontmatter`, a minimal line/colon parser, not a
 * real YAML parser) is lenient enough to silently accept syntactically
 * invalid YAML — e.g. `type: [concept` (unclosed bracket) is read as the
 * plain string `"[concept"`, a non-empty value that passes rule 2 despite
 * the frontmatter not actually being parseable YAML.
 *
 * This checks only bracket/brace balance per line, deliberately NOT quote
 * balance — an ordinary apostrophe in prose (`title: "Cole's loop"`) makes a
 * naive quote-parity check false-positive constantly, while an unbalanced
 * `[`/`]`/`{`/`}` is both rare in legitimate single-line scalar values and a
 * strong signal of genuinely broken YAML. Block-sequence item lines
 * (`- foo`) are skipped individually but still contribute to the same
 * per-line balance check, since each line of a block sequence must itself
 * be self-contained YAML.
 *
 * Bracket-counting is QUOTE-AWARE: characters inside a single- or
 * double-quoted scalar are inert to YAML structure, so `title: 'Model
 * [draft'` (a legitimate quoted value that happens to contain a literal
 * unmatched bracket — our own exporter can produce this from any source
 * title/description containing one) must NOT be flagged. Single-quote
 * escaping (`''` = a literal quote inside a single-quoted scalar) and
 * double-quote backslash-escaping are both honored while scanning.
 *
 * Quote state is carried ACROSS line boundaries (not reset per line) so a
 * legitimate YAML flow-scalar that folds onto a second line (`title: 'A
 * long\n  title'` — valid YAML) is never flagged just because its opening
 * quote doesn't close on the same line. Only when a quote is STILL open at
 * the very end of the whole frontmatter block — i.e. never closes anywhere
 * — is it flagged: that's unambiguously invalid YAML, not a legitimate
 * multi-line scalar, and would otherwise silently swallow any real bracket
 * imbalance following it (confirmed independently by two review passes).
 *
 * @param {string} rawFrontmatterBody Text between the `---` fences (no fences)
 * @returns {string[]} Offending lines (empty when nothing looks wrong)
 */
function findUnbalancedBracketLines(rawFrontmatterBody) {
  const problems = [];
  let inSingle = false;
  let inDouble = false;
  for (const line of rawFrontmatterBody.split(/\r?\n/)) {
    const trimmed = line.trim();
    let opens = 0;
    let closes = 0;
    for (let i = 0; i < trimmed.length; i += 1) {
      const ch = trimmed[i];
      if (inSingle) {
        if (ch === "'") {
          if (trimmed[i + 1] === "'") { i += 1; continue; } // '' escape — stay quoted
          inSingle = false;
        }
        continue; // bracket chars inside a quoted scalar are inert
      }
      if (inDouble) {
        if (ch === '\\') { i += 1; continue; } // skip the escaped character
        if (ch === '"') inDouble = false;
        continue;
      }
      if (ch === "'") { inSingle = true; continue; }
      if (ch === '"') { inDouble = true; continue; }
      if (ch === '[' || ch === '{') opens += 1;
      else if (ch === ']' || ch === '}') closes += 1;
    }
    if (opens !== closes) problems.push(trimmed);
  }
  if (inSingle || inDouble) {
    problems.push('(a quoted value never closes its quote before the frontmatter ends)');
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Reserved-file structure checks (§6 index, §7 log)
// ---------------------------------------------------------------------------

function checkIndexFile(file, isRoot, out) {
  const { frontmatter, body } = parseFrontmatter(file.content);
  const hasBlock = FRONTMATTER_BLOCK_RE.test(file.content);

  if (hasBlock) {
    const keys = Object.keys(frontmatter);
    if (!isRoot) {
      out.errors.push(finding(
        'index-frontmatter-forbidden', file.path,
        'index.md files must not contain frontmatter (§6) — only the bundle-root index may, and only to declare okf_version (§11)',
      ));
    } else if (keys.some((k) => k !== 'okf_version')) {
      out.errors.push(finding(
        'index-frontmatter-extra-keys', file.path,
        `bundle-root index.md frontmatter may only declare okf_version (§11) — found: ${keys.join(', ')}`,
      ));
    }
  }
  if (isRoot && (!hasBlock || !frontmatter.okf_version)) {
    out.info.push(finding(
      'okf-version-missing', file.path,
      "bundle-root index.md carries no okf_version declaration — legal (MAY, §11), but declaring okf_version: '0.1' helps consumers",
    ));
  }

  // Body structure: `# Section` headings + `* [Title](url) - desc` bullets.
  // Blockquotes and blank lines are tolerated (real-world bundles use them).
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed || trimmed.startsWith('> ') || trimmed === '>') continue;
    if (/^#\s/.test(trimmed)) continue;
    if (/^#{2,}\s/.test(trimmed)) {
      out.warnings.push(finding(
        'index-heading-level', file.path,
        `section heading "${trimmed.slice(0, 40)}" uses level ${trimmed.match(/^#+/)[0].length} — the spec's canonical index shape uses level-1 \`# Section\` headings (§6)`,
      ));
      continue;
    }
    const bulletMatch = /^([*-])\s+(.*)$/.exec(trimmed);
    if (bulletMatch) {
      const [, marker, rest] = bulletMatch;
      if (marker === '-') {
        out.warnings.push(finding(
          'index-bullet-marker', file.path,
          `entry "${rest.slice(0, 40)}…" uses \`-\` — the spec's canonical bullets use \`*\` (§6)`,
        ));
      }
      if (!/^\[[^\]]*\]\([^)]+\)(\s+-\s+.*)?$/.test(rest)) {
        out.warnings.push(finding(
          'index-bullet-form', file.path,
          `entry "${rest.slice(0, 60)}" doesn't match \`[Title](url) - description\` (§6)`,
        ));
      }
      continue;
    }
    out.warnings.push(finding(
      'index-unexpected-content', file.path,
      `unexpected line "${trimmed.slice(0, 60)}" — indexes are heading + bullet listings (§6)`,
    ));
  }
}

function checkLogFile(file, out) {
  const { frontmatter, body } = parseFrontmatter(file.content);
  if (FRONTMATTER_BLOCK_RE.test(file.content) && Object.keys(frontmatter).length > 0) {
    // §7 doesn't grant log.md a frontmatter carve-out the way §11 does for
    // the root index, but it doesn't forbid one either — surface, don't fail.
    out.warnings.push(finding(
      'log-frontmatter-unexpected', file.path,
      'log.md carries frontmatter — the spec defines none for it (§7); consumers may treat it as opaque',
    ));
  }
  const dates = [];
  for (const line of body.split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.+)$/.exec(line.trimEnd());
    if (!heading) continue;
    const text = heading[1].trim();
    // Only date-shaped headings are §7 date groups; a title like
    // `# Update Log` is tolerated.
    if (/^\d/.test(text)) {
      if (!ISO_DATE_RE.test(text)) {
        out.errors.push(finding(
          'log-date-not-iso', file.path,
          `date heading "${text}" — §7 requires ISO 8601 YYYY-MM-DD`,
        ));
      } else {
        dates.push(text);
      }
    }
  }
  for (let i = 1; i < dates.length; i += 1) {
    if (dates[i] > dates[i - 1]) {
      out.warnings.push(finding(
        'log-not-newest-first', file.path,
        `date ${dates[i]} appears after ${dates[i - 1]} — §7 describes newest-first ordering`,
      ));
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Main checker
// ---------------------------------------------------------------------------

/**
 * Check a bundle (as a list of in-memory files) against OKF v0.1.
 *
 * @param {Array<{ path: string, content: string }>} files
 *   Every file of the bundle, with bundle-relative posix paths.
 * @returns {{
 *   conformant: boolean,
 *   errors: Array<{ rule: string, path: string, detail: string }>,
 *   warnings: Array<{ rule: string, path: string, detail: string }>,
 *   info: Array<{ rule: string, path: string, detail: string }>,
 *   stats: { documents: number, indexes: number, logs: number, skipped: number },
 * }}
 */
export function checkOkfConformance(files) {
  if (!Array.isArray(files)) {
    throw new TypeError('checkOkfConformance: files is required (array of {path, content})');
  }
  const out = { errors: [], warnings: [], info: [] };
  const stats = { documents: 0, indexes: 0, logs: 0, skipped: 0 };

  const mdFiles = files
    .filter((f) => f && typeof f.path === 'string' && typeof f.content === 'string')
    .map((f) => ({ ...f, path: f.path.replace(/\\/g, '/').replace(/^\.?\//, '') }))
    .filter((f) => f.path.toLowerCase().endsWith('.md'))
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path));

  let rootIndexSeen = false;

  for (const file of mdFiles) {
    const basename = file.path.split('/').pop();
    const lowerBase = basename.toLowerCase();

    if (lowerBase === 'index.md') {
      stats.indexes += 1;
      const isRoot = !file.path.includes('/');
      if (isRoot) rootIndexSeen = true;
      checkIndexFile(file, isRoot, out);
      continue;
    }
    if (lowerBase === 'log.md') {
      stats.logs += 1;
      checkLogFile(file, out);
      continue;
    }
    if (lowerBase === 'readme.md') {
      // Not reserved by the spec, so rule 1 technically applies — but the
      // ecosystem convention (Cole Medin bundle) ships a frontmatter-less
      // README as agent onboarding. Surface as info, don't fail the bundle.
      stats.skipped += 1;
      if (!FRONTMATTER_BLOCK_RE.test(file.content)) {
        out.info.push(finding(
          'readme-without-frontmatter', file.path,
          'README.md has no frontmatter — strictly a rule-1 violation, but the common agent-onboarding convention; add frontmatter with a type to be pedantically conformant',
        ));
      }
      continue;
    }

    // Concept document — rules 1 + 2.
    stats.documents += 1;
    const blockMatch = FRONTMATTER_BLOCK_RE.exec(file.content);
    if (!blockMatch) {
      out.errors.push(finding(
        'frontmatter-missing', file.path,
        'no parseable YAML frontmatter block (conformance rule 1, §9)',
      ));
      continue;
    }
    const unbalancedLines = findUnbalancedBracketLines(blockMatch[1]);
    if (unbalancedLines.length > 0) {
      out.errors.push(finding(
        'frontmatter-not-parseable', file.path,
        `frontmatter is not valid YAML despite matching the \`---\` fences — unbalanced brackets or an unterminated quote (conformance rule 1, §9): "${unbalancedLines[0].slice(0, 60)}"`,
      ));
    }
    const { frontmatter } = parseFrontmatter(file.content);
    const type = frontmatter.type;
    if (typeof type !== 'string' || !type.trim()) {
      out.errors.push(finding(
        'type-missing', file.path,
        'frontmatter has no non-empty `type` field (conformance rule 2, §9)',
      ));
    }

    // Reference-implementation compatibility (info level).
    const missingKeys = REFERENCE_IMPL_REQUIRED_KEYS.filter((k) => {
      const v = frontmatter[k];
      return typeof v !== 'string' || !v.trim();
    });
    if (missingKeys.length > 0 && missingKeys.join() !== 'type') {
      out.info.push(finding(
        'reference-impl-keys', file.path,
        `missing ${missingKeys.join(', ')} — legal per the spec (only type is required), but Google's reference implementation refuses documents without type, title, description, timestamp`,
      ));
    }

    for (const segment of file.path.split('/')) {
      const stem = segment.replace(/\.md$/i, '');
      if (!REFERENCE_IMPL_SEGMENT_RE.test(stem)) {
        out.warnings.push(finding(
          'filename-charset', file.path,
          `path segment "${segment}" contains characters outside [A-Za-z0-9_.-] — legal per the spec, but Google's reference tooling rejects it (bundle/paths.py)`,
        ));
        break;
      }
    }

    // Obsidian syntax leaking into a bundle (wikilinks are not OKF links, §5).
    const { body } = parseFrontmatter(file.content);
    if (/\[\[[^\]]+\]\]/.test(body)) {
      out.warnings.push(finding(
        'wikilink-syntax', file.path,
        'body contains [[wikilinks]] — OKF links are standard markdown links (§5); Obsidian-only consumers can read them, everyone else cannot',
      ));
    }
  }

  if (mdFiles.length > 0 && !rootIndexSeen) {
    out.info.push(finding(
      'root-index-missing', '.',
      'no bundle-root index.md — legal (§6 says MAY; consumers can synthesize one), but a root index is the entry point most consumers expect',
    ));
  }

  return {
    conformant: out.errors.length === 0,
    errors: out.errors,
    warnings: out.warnings,
    info: out.info,
    stats,
  };
}
