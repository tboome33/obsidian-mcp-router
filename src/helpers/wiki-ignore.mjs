/**
 * `.wikiignore` filter — gitignore-style exclusion of vault paths from the
 * wiki tooling (graph build, lint, export).
 *
 * Roadmap item #5 (understand-anything-roadmap), companion of #1. A vault
 * root `.wikiignore` lets the user exclude noise (config, trash, derived
 * sidecars, binary attachments-as-content) on top of a hardcoded default
 * set. `!`-negation re-includes.
 *
 * ⚠️ SCOPE INVARIANT (Roland's binaries remark, 2026-05-29): `.wikiignore`
 * governs *content enumeration* — which files become `article` nodes / get
 * linted / get exported. It does NOT govern *reference resolution*. A binary
 * (PDF/image) a wiki page REFERENCES (frontmatter `sources:`, `^[...]`
 * citation, `![[embed]]`) still becomes a lightweight `source` node in the
 * graph even when its file matches `.wikiignore`. That promotion lives in
 * `wiki-graph-builder.mjs`, NOT here — this module is a pure path matcher
 * with no knowledge of references.
 *
 * Supported gitignore subset (documented — NOT the full spec, no `ignore`
 * npm dep, consistent with the repo's lean-dep policy à la link-extractor):
 *   - `# comment` lines and blank lines are skipped
 *   - `!pattern` negates (re-includes); LAST matching pattern wins
 *   - `dir/` trailing slash → the directory and everything under it
 *   - a pattern containing a non-trailing `/` (or a leading `/`) is ANCHORED
 *     to the vault root; otherwise it matches at ANY depth (a path segment)
 *   - `*` matches within a path segment (does not cross `/`)
 *   - `**` matches across segments (`a/​**​/b`, `**​/foo`, `foo/**`)
 *   - `?` matches a single non-`/` char
 *   - every pattern matches the named path itself AND anything nested under
 *     it (so `foo` ignores `foo` the file and `foo/bar` the dir-content)
 *
 * NOT supported (documented gaps): character classes `[a-z]`, escaped
 * metacharacters via backslash, and the gitignore "a `*` does not match a
 * leading dot" nuance. Our default patterns + typical user patterns don't
 * need them; if a real need shows up we revisit (possibly the `ignore` dep).
 *
 * Pure module — no I/O. The caller reads the `.wikiignore` file (if any) and
 * passes its lines in.
 */

/**
 * Built-in default exclusions. These are applied BEFORE user patterns, so a
 * user `!` line can re-include a default-excluded path.
 *
 * Rationale per entry group:
 *   - Obsidian/system: `.obsidian/`, `.trash/` — never content.
 *   - Derived router artifacts: `.understand-anything/` (the dashboard copy
 *     of the graph — must NOT graph itself), `wiki-meta/digests|graph|exports`
 *     (sidecars produced by the tooling, not authored content).
 *   - Scaffolds: `templates/`.
 *   - Binary attachments: images/pdf/av/archives — never `article` content.
 *     (Reminder: a referenced binary still becomes a `source` node — see the
 *     scope invariant above; that path bypasses this filter by design.)
 */
export const DEFAULT_WIKIIGNORE_PATTERNS = Object.freeze([
  '.obsidian/',
  '.trash/',
  '.understand-anything/',
  'wiki-meta/digests/',
  'wiki-meta/graph/',
  'wiki-meta/exports/',
  'templates/',
  // binary attachments (matched at any depth)
  '*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.bmp', '*.ico', '*.svg',
  '*.pdf', '*.excalidraw',
  '*.mp3', '*.wav', '*.m4a', '*.ogg',
  '*.mp4', '*.mov', '*.webm', '*.avi',
  '*.zip', '*.gz', '*.tar', '*.7z', '*.rar',
  '*.woff', '*.woff2', '*.ttf', '*.otf', '*.eot',
]);

// ---------------------------------------------------------------------------
// Glob → RegExp
// ---------------------------------------------------------------------------

const REGEX_META = /[.+^${}()|[\]\\]/g;

// ReDoS guards — a `.wikiignore` is attacker-influenced vault content, so a
// crafted pattern must NOT compile to a catastrophically-backtracking regex.
const MAX_PATTERN_LENGTH = 512;
// `**` → unbounded `.*`-class group; many of them (`**a**a…`) backtrack
// super-linearly. Cap hard.
const MAX_DOUBLE_STAR_RUNS = 2;
// Single `*` → segment-bounded `[^/]*` (cheaper); cap the total run count
// for defence in depth.
const MAX_WILDCARD_RUNS = 8;

/**
 * Convert a glob pattern body (no leading `!`, no trailing `/`, no anchoring
 * decision) into a regex source fragment. `*` stays within a segment, `**`
 * crosses segments, `?` is one non-slash char. All other chars are escaped.
 *
 * @param {string} glob
 * CRITICAL (ReDoS): consecutive `*` are collapsed into a SINGLE quantifier.
 * A run of N stars (e.g. `a*…*b`, 40 stars) previously compiled to N/2
 * ADJACENT `.*` groups → exponential backtracking (~80s on a 120-char
 * non-match). Collapsing the whole run makes `a*…*b` → `a.*b` (linear).
 *
 * @param {string} glob
 * @returns {{ re: string, wildcardRuns: number, doubleStarRuns: number }}
 */
function globBodyToRegex(glob) {
  let re = '';
  let i = 0;
  let wildcardRuns = 0;
  let doubleStarRuns = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      // Consume the ENTIRE run of consecutive '*' → at most one quantifier.
      let stars = 0;
      while (glob[i] === '*') {
        stars += 1;
        i += 1;
      }
      wildcardRuns += 1;
      if (stars >= 2) {
        doubleStarRuns += 1;
        if (glob[i] === '/') {
          i += 1; // consume the slash too → `**/` matches zero or more dirs
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i += 1;
      continue;
    }
    re += c.replace(REGEX_META, '\\$&');
    i += 1;
  }
  return { re, wildcardRuns, doubleStarRuns };
}

/**
 * Compile a single (already comment/blank-stripped) gitignore line into
 * `{ negated, test(path) }`, OR `{ dropped: reason }` when the line is
 * refused by a ReDoS guard, OR `null` when the line is empty.
 *
 * @param {string} rawLine
 * @returns {{ negated: boolean, test: (p: string) => boolean }
 *   | { dropped: string } | null}
 */
function compilePattern(rawLine) {
  let line = rawLine;
  // Trim trailing whitespace (we don't support escaped trailing spaces).
  line = line.replace(/\s+$/, '');
  if (!line) return null;

  // ReDoS guard: refuse absurdly long patterns outright.
  if (line.length > MAX_PATTERN_LENGTH) {
    return { dropped: `pattern too long (>${MAX_PATTERN_LENGTH} chars)` };
  }

  let negated = false;
  if (line.startsWith('!')) {
    negated = true;
    line = line.slice(1);
  }
  if (!line) return null;

  // Directory-only marker (trailing slash). We still match the dir itself
  // and its contents, so the trailing slash is informational for our subset.
  if (line.endsWith('/')) {
    line = line.slice(0, -1);
  }
  if (!line) return null;

  // Anchored when the pattern has a leading slash or any internal slash.
  const leadingSlash = line.startsWith('/');
  if (leadingSlash) line = line.slice(1);
  const anchored = leadingSlash || line.includes('/');
  if (!line) return null;

  const { re: body, wildcardRuns, doubleStarRuns } = globBodyToRegex(line);
  // ReDoS guard: refuse patterns with too many unbounded quantifiers.
  if (doubleStarRuns > MAX_DOUBLE_STAR_RUNS || wildcardRuns > MAX_WILDCARD_RUNS) {
    return {
      dropped: `too many wildcards (ReDoS guard: ${wildcardRuns} run(s), ${doubleStarRuns} '**')`,
    };
  }
  // Match the path itself OR anything nested under it: suffix `(?:/|$)`.
  // Anchored → from root; unanchored → at any segment boundary.
  const prefix = anchored ? '^' : '(?:^|/)';
  let re;
  try {
    re = new RegExp(`${prefix}${body}(?:/|$)`);
  } catch (err) {
    // Fail safe — a pattern that won't compile is dropped (with a warning),
    // never thrown into the caller.
    return { dropped: `invalid pattern: ${err.message}` };
  }

  return { negated, test: (p) => re.test(p) };
}

/**
 * Normalise a path for matching: backslashes → forward slashes, strip a
 * single leading `./` and any leading `/`, collapse `//`.
 *
 * @param {string} p
 * @returns {string}
 */
function normalisePath(p) {
  if (typeof p !== 'string') return '';
  let s = p.replace(/\\/g, '/');
  s = s.replace(/^\.\//, '');
  s = s.replace(/^\/+/, '');
  s = s.replace(/\/{2,}/g, '/');
  return s;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a wiki-ignore matcher.
 *
 * @param {string|string[]} [userPatterns=[]] Raw `.wikiignore` content (a
 *   single string with newlines) OR an array of pattern lines. Comments and
 *   blank lines are tolerated.
 * @param {object} [opts]
 * @param {boolean} [opts.useDefaults=true] Prepend DEFAULT_WIKIIGNORE_PATTERNS.
 * @returns {{ isIgnored: (relPath: string) => boolean, patterns: string[], warnings: string[], hasNegation: boolean }}
 *   `warnings` lists patterns dropped by a ReDoS guard (too long / too many
 *   wildcards / uncompilable), so the caller can surface them. `hasNegation`
 *   is true when any kept pattern is a `!`-negation (lets callers prune ignored
 *   subtrees safely when there are none).
 */
export function createWikiIgnore(userPatterns = [], opts = {}) {
  const { useDefaults = true } = opts;

  const userLines = Array.isArray(userPatterns)
    ? userPatterns
    : String(userPatterns ?? '').split(/\r?\n/);

  const allLines = [
    ...(useDefaults ? DEFAULT_WIKIIGNORE_PATTERNS : []),
    ...userLines,
  ];

  const compiled = [];
  const kept = [];
  const warnings = [];
  let hasNegation = false;
  for (const raw of allLines) {
    const line = String(raw ?? '');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const c = compilePattern(line);
    if (!c) continue;
    if (c.dropped) {
      warnings.push(`dropped pattern "${trimmed}": ${c.dropped}`);
      continue;
    }
    if (c.negated) hasNegation = true;
    compiled.push(c);
    kept.push(trimmed);
  }

  function isIgnored(relPath) {
    const p = normalisePath(relPath);
    if (!p) return false;
    // gitignore semantics: last matching pattern decides. A `!` (negated)
    // match un-ignores.
    let ignored = false;
    for (const { negated, test } of compiled) {
      if (test(p)) ignored = !negated;
    }
    return ignored;
  }

  // `hasNegation` lets callers (e.g. the graph builder's enumeration) safely
  // PRUNE ignored directories when no `!`-pattern could re-include anything
  // inside them — a conservative "no descendant negation can match" proxy.
  return { isIgnored, patterns: kept, warnings, hasNegation };
}

/**
 * Generate a commented starter `.wikiignore` for first-run scaffolding
 * (deterministic — no LLM). Lists the built-in defaults as documentation
 * (commented, since they're already applied) plus a couple of example user
 * patterns the user can uncomment.
 *
 * @returns {string}
 */
export function generateStarter() {
  return [
    '# .wikiignore — exclude paths from the wiki tooling (graph / lint / export).',
    '# gitignore syntax (documented subset). `!pattern` re-includes.',
    '#',
    '# The following defaults are ALWAYS applied (listed here for reference,',
    '# no need to repeat them):',
    ...DEFAULT_WIKIIGNORE_PATTERNS.map((p) => `#   ${p}`),
    '#',
    '# NOTE: a file you EXCLUDE here can still appear in the graph as a',
    '# lightweight `source` node if a wiki page references it (frontmatter',
    '# sources:, ^[citation], or ![[embed]]). Exclusion = "not content",',
    '# not "invisible".',
    '#',
    '# Add your own patterns below. Examples (commented):',
    '#   Archive/',
    '#   *.draft.md',
    '#   !Archive/keep-this.md',
    '',
  ].join('\n');
}

export const _internals = {
  compilePattern,
  globBodyToRegex,
  normalisePath,
};
