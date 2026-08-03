/**
 * export-gate.mjs — C9: the single gate every artifact leaves through.
 *
 * Three things built here go somewhere else: the `.mcpb` bundle (uploaded to
 * MCPHub), OKF knowledge bundles (made to be shared), and GitHub releases.
 * Each is an opportunity to leak — a real vault path, a forgotten key, a
 * personal address in a fixture, a symlink — and until this module existed
 * nothing tied a published artifact back to the commit it claims to be.
 *
 * The gate does five things, in this order:
 *
 *   1. ALLOWLIST   — a file ships because it is named, never because nobody
 *                    thought to exclude it. `build-mcpb.ps1` used to work the
 *                    other way (robocopy `/XD` + `/XF`) and the proof of what
 *                    that costs is in `docs/export-gate.md`: `.codex/config.toml`
 *                    — a live Authorization bearer token — rode into the
 *                    v0.67.1 bundle because the deny list predated the file.
 *   2. SCAN        — secrets, personal e-mail addresses, private filesystem
 *                    paths, symlinks, path traversal. One rule family per
 *                    category, one fixture per category in the test suite.
 *   3. CHECKSUMS   — a `SHA256SUMS` in the artifact, in `sha256sum -c` format.
 *   4. MANIFEST    — what was built, from which commit, under which encoder.
 *   5. AUDIT       — verify a finished artifact WITHOUT extracting it.
 *
 * ── Two zones, and why the distinction is honest rather than convenient ───
 *
 * `authored` files (everything written in this repo) get all five categories,
 * fail-closed. `vendored` files (`node_modules/`, produced by `npm ci` from
 * the committed lockfile) get the path-safety and high-confidence secret rules
 * only. The reason is that e-mail addresses and home directories inside a
 * dependency belong to *its* authors and its build machine — they are upstream
 * facts, not our leak, and treating thousands of them as findings would train
 * everyone to ignore the gate. What the gate must never miss in a dependency
 * is a symlink, a traversal name or a real credential, and those it still
 * checks. Anything narrower than that is stated here rather than implied.
 *
 * ── Fail-closed, and no quiet bypass ─────────────────────────────────────
 *
 * There is no `--skip-scan`. An unwanted finding is silenced by adding an
 * entry to `scanExceptions` in `contracts/export-allowlist.json`, which
 * REQUIRES a written `reason` — the same honesty rule C8 applies to
 * capability claims. A gate that can be switched off from the command line is
 * a gate that will be, at the worst possible moment.
 *
 * Pure functions, no clock, no I/O except where a function name says
 * otherwise (`collectFiles`, `gateDirectory`). Same input, same output.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

import {
  createDeterministicZip,
  readZipDirectory,
  readZipEntryContent,
  compareLocalHeader,
  AUDIT_LIMITS,
  DOS_EPOCH_DATE,
  DOS_EPOCH_TIME,
} from './deterministic-zip.mjs';

export { createDeterministicZip, readZipDirectory, readZipEntryContent, compareLocalHeader };

/** Bumped when the manifest shape changes in a way consumers can observe. */
export const GATE_VERSION = 1;

/**
 * The leak categories §2.17 names. Exported as data, not prose, so
 * `tests/export-gate.test.mjs` can assert that EVERY category has a dedicated
 * fixture — a category that stopped matching anything would otherwise look
 * exactly like a clean scan.
 */
export const LEAK_CATEGORIES = Object.freeze([
  'secret',
  'personal-email',
  'private-path',
  'symlink',
  'path-traversal',
]);

/** Files whose bytes the gate produces; never subject to the allowlist. */
export const CHECKSUM_FILE = 'SHA256SUMS';
export const MANIFEST_FILE = 'export-manifest.json';

// ---------------------------------------------------------------------------
// 1. Allowlist
// ---------------------------------------------------------------------------

/**
 * Compile one allowlist pattern to a RegExp.
 *
 * Supported syntax, deliberately small:
 *   `**`   any number of path segments, including none
 *   `*`    any run of characters inside ONE segment
 *   `dir/` shorthand for `dir/**`
 * Everything else is literal. No brace expansion, no negation — a whitelist
 * with negations is a deny list wearing a disguise.
 */
export function compileAllowPattern(pattern) {
  let p = String(pattern).replace(/\\/g, '/').trim();
  if (!p) throw new Error('empty allowlist pattern');
  if (p.startsWith('/')) throw new Error(`allowlist pattern must be repo-relative: ${pattern}`);
  if (p.endsWith('/')) p += '**';

  // Compiled SEGMENT BY SEGMENT so a double-star means "any number of whole
  // path segments" rather than "any characters". The first version emitted a
  // bare `.*`, which silently dropped the boundary: the vendored exception
  // pattern for `node_modules/jose` also matched
  // `src/evil-node_modules/jose/keys.js`, so an AUTHORED file in a directory
  // merely ENDING in `node_modules` inherited it and had its whole `secret`
  // category muted.
  const escapeLiteral = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const segments = p.split('/');
  let re = '^';
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const last = i === segments.length - 1;
    if (seg === '**') {
      // Trailing `**` covers the remainder; a middle/leading one consumes zero
      // or more complete segments, each with its separator.
      re += last ? '.*' : '(?:[^/]+/)*';
    } else {
      re += escapeLiteral(seg).replace(/\*/g, '[^/]*');
      if (!last) re += '/';
    }
  }
  re += '$';
  return new RegExp(re);
}

/**
 * Probe paths spanning the shapes a repository actually contains. Used to ask
 * a compiled pattern the only question that matters about a scan exception:
 * does it cover everything?
 */
const CATCH_ALL_PROBES = Object.freeze([
  'a', 'a.txt', 'src/a.mjs', 'a/b/c.md', 'node_modules/x/y.js', '.env', 'deep/a/b/c/d/e.json',
]);

/**
 * True when a pattern matches every probe path — i.e. it is a catch-all
 * however it happens to be spelled.
 *
 * The predecessor tested the pattern TEXT against a "only asterisks" regex,
 * which caught a bare double-star and nothing else. Spelling the same
 * catch-all as a double-star followed by a slash and a single star — or by
 * another double-star, or by a slash alone — sailed through validation and
 * silenced every suppressible category on every file. Three contract lines
 * re-opened the hole the round before had closed. Testing the COMPILED regex
 * against real paths cannot be out-spelled.
 */
export function isCatchAllPattern(pattern) {
  let re;
  try { re = compileAllowPattern(pattern); } catch { return false; }
  if (CATCH_ALL_PROBES.every((probe) => re.test(probe))) return true;

  // The probe test alone is necessary but not sufficient: a wildcard-only
  // pattern can miss one probe on a technicality and still cover essentially
  // everything — a double-star plus `*.*` matches every file that has an
  // extension, and `*` plus a double-star matches everything below the root.
  // So an exception must also NAME somewhere: at least one path segment made
  // entirely of literal characters. `config/**`, `tests/**` and the vendored
  // package patterns all qualify; nothing built purely from wildcards does.
  const segments = String(pattern).replace(/\\/g, '/').trim().replace(/\/$/, '').split('/');
  return !segments.some((seg) => seg.length > 0 && !seg.includes('*'));
}

/**
 * Split a candidate list into what ships and what does not.
 *
 * `zones` maps a zone name to its pattern list. The FIRST zone whose pattern
 * matches wins, so zone order is meaningful and is fixed by the contract file.
 * Anything unmatched is excluded — that is the whole point.
 *
 * @returns {{included: Array<{path, zone, pattern}>, excluded: Array<{path}>}}
 */
export function applyAllowlist(paths, zones) {
  const compiled = Object.entries(zones).map(([zone, patterns]) => ({
    zone,
    patterns: (patterns || []).map((pattern) => ({ pattern, re: compileAllowPattern(pattern) })),
  }));

  const included = [];
  const excluded = [];
  for (const raw of paths) {
    const p = String(raw).replace(/\\/g, '/');
    let hit = null;
    for (const { zone, patterns } of compiled) {
      const match = patterns.find(({ re }) => re.test(p));
      if (match) { hit = { path: p, zone, pattern: match.pattern }; break; }
    }
    if (hit) included.push(hit);
    else excluded.push({ path: p });
  }
  included.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  excluded.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { included, excluded };
}

// ---------------------------------------------------------------------------
// 2. Scan
// ---------------------------------------------------------------------------

/**
 * High-confidence credential shapes. Each is a *format* with a checkable
 * prefix and length — not a guess — so a hit is worth stopping a release for.
 */
const SECRET_RULES = Object.freeze([
  { id: 'private-key-block', re: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g },
  { id: 'aws-access-key-id', re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[0-9A-Z]{16}\b/g },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}/g },
  { id: 'github-fine-grained-pat', re: /\bgithub_pat_[A-Za-z0-9_]{60,}/g },
  { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { id: 'anthropic-api-key', re: /\bsk-ant-[A-Za-z0-9_-]{24,}/g },
  { id: 'openai-api-key', re: /\bsk-(?:proj-)?[A-Za-z0-9]{20,}/g },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { id: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  {
    id: 'authorization-header',
    re: /\bauthorization["'\s]*[:=]\s*["'`]?\s*(?:Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{12,})/gi,
    valueGroup: 1,
  },
]);

/**
 * The generic `key = <opaque blob>` rule. Far more prone to false positives
 * than the shaped rules above, so it demands BOTH a credential-ish key name
 * and a value that survives the placeholder filter and the entropy floor.
 */
const ASSIGNED_CREDENTIAL_RE =
  /\b(api[_-]?key|apikey|secret|secret[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|password|passwd|pwd)\b["'\s]*[:=]\s*["'`]([^"'`\n]{12,})["'`]/gi;

/** Values that look like credentials but are documentation. */
const PLACEHOLDER_RE =
  /^(?:<.*>|\$\{.*\}|\$[A-Z_][A-Z0-9_]*|%[A-Za-z0-9_]+%|\.{3}|-+|x+|X+|\*+|\?+)$/;

/**
 * Documentation stand-ins, matched as WHOLE values (or as a whole value once
 * separators are stripped) — never as substrings.
 *
 * Substring matching was a hole, not a shortcut: `my` and `your` are two
 * characters, so roughly one random 32-char token in 120 contains one by
 * accident, and any author who wanted the gate quiet could arrange it in a
 * single keystroke. A live-looking token with `my` spliced into the middle
 * read as a placeholder and shipped.
 */
const PLACEHOLDER_WORD_RE = new RegExp(
  '^(?:'
  // `[a-z0-9_-]*` (not `[a-z0-9]*`) so multi-segment stand-ins like
  // `your-api-key` and `my_secret_token` match as WHOLE values.
  + 'changeme|change[-_]?me|your[-_]?[a-z0-9_-]*|my[-_]?[a-z0-9_-]*|example[a-z0-9_-]*|sample[a-z0-9_-]*'
  + '|dummy[a-z0-9_-]*|placeholder|redacted|insert[-_]?[a-z0-9_-]*|todo|fixme|fake[a-z0-9_-]*'
  + '|test[-_]?(?:key|token|secret|password)?|not[-_]?a[-_]?real[-_]?[a-z0-9_-]*'
  + '|abcdef123[a-z0-9]*|s3cr3t|hunter2|password123|secret123|secret|password|token|apikey'
  + ')$',
  'i',
);

/**
 * Shannon entropy in bits per character. A real 32-char token sits above ~3.5;
 * `supersecretpassword` sits near 3.1; `aaaaaaaaaaaa` sits at 0.
 */
export function shannonEntropy(value) {
  const s = String(value);
  if (!s.length) return 0;
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) || 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Does an assigned value look like a live credential rather than a stand-in?
 *
 * Exported so the test suite can pin the boundary in both directions: a real
 * token must be caught, and the placeholder shapes this repo actually uses
 * (`PASSWORD=<password>`, `${OBSIDIAN_ROUTER_...}`) must not be.
 */
export function looksLikeLiveCredential(value) {
  const v = String(value).trim();
  if (v.length < 12) return false;
  if (/\s/.test(v)) return false;              // credentials do not contain spaces
  if (PLACEHOLDER_RE.test(v)) return false;
  if (PLACEHOLDER_WORD_RE.test(v)) return false;
  if (/^[./~]/.test(v) || v.includes('/../')) return false;  // a path, not a key
  if (/^[a-z]+:\/\//i.test(v)) return false;   // a URL
  // A bracketed or parenthesised expression is code, not a credential:
  // css-select ships `password: "[type=password]"`, a CSS selector alias.
  if (/^[[({]/.test(v) && /[\])}]$/.test(v)) return false;
  if (new Set(v).size <= 4) return false;      // aaaa…, 1111…, abab…
  return shannonEntropy(v) >= 3.0;
}

/**
 * Structural private-path shapes that need no per-machine configuration.
 *
 * Each rule captures the identifying component (the account name, the UNC
 * host) in group 1 so `isPlaceholderIdentifier` can tell a documented example
 * from a real disclosure. Without that step the rules fire on every `C:\Users\me`
 * in the documentation, and a check that cries on its own examples is a check
 * everyone learns to skip.
 */
// The POSIX rules used to require BOTH a delimiter from a short list before
// the path and a trailing `/` after the account name, while the Windows rule
// required neither — so the three disagreed about what a private path is, and
// `/home/<account>` at end of line, `,/home/<account>/x`, and an scp target
// `host:/home/<account>/x` all went unreported. A negative lookbehind for a
// path-ish character is both stricter and simpler, and the trailing separator
// is now optional.
const PRIVATE_PATH_RULES = Object.freeze([
  // Case-INSENSITIVE, because Windows paths are: a lower-cased user-profile
  // prefix is an ordinary rendering (lower-cased `%USERPROFILE%`, `cygpath`,
  // most shells), and the macOS home prefix resolves in either case too.
  // Without the flag the primary leak category was silent on the commonest
  // spellings. (Spelled in prose, not shown as examples — a rule that quotes
  // itself matches itself.)
  { id: 'windows-user-profile', re: /\b[A-Za-z]:[\\/]+Users[\\/]+([^\\/\s"'`<>|:*?]+)/gi },
  // Backslash excluded from the capture: a Windows-style path written inside a
  // JS string (`/home/u\\.claude\\plugins`) otherwise swallowed the rest of
  // the line into the "account name" and defeated the placeholder check.
  { id: 'unix-home', re: /(?<![A-Za-z0-9._-])\/home\/([^/\\\s"'`)\]<>|:*?,;]+)/gi },
  { id: 'macos-home', re: /(?<![A-Za-z0-9._-])\/Users\/([^/\\\s"'`)\]<>|:*?,;]+)/gi },
  // The share segment must START with an alphanumeric. Without that, LaTeX in
  // a test fixture (`\\frac\{1`) read as the UNC path `\\frac\{1`.
  { id: 'unc-share', re: /\\\\([A-Za-z0-9][A-Za-z0-9._-]{1,})\\[A-Za-z0-9][^\\\s"'`<>|{}]*/g },
]);

/**
 * Conventional stand-ins that documentation uses where a real account or host
 * name would sit. Matching one means the path is an EXAMPLE, not a leak.
 *
 * Exported so the test suite can pin both directions: the placeholders this
 * repo's own docs use must stay silent, and a real account name must not
 * accidentally join the set.
 */
const PLACEHOLDER_IDENTIFIERS = new Set([
  'me', 'u', 'you', 'user', 'users', 'username', 'youruser', 'your-user',
  'someone', 'somebody', 'alice', 'bob', 'carol', 'foo', 'bar', 'baz',
  'example', 'sample', 'test', 'demo', 'name', 'account', 'login',
  'server', 'host', 'hostname', 'myserver', 'nas', 'share', 'machine',
  // `Public` and `Default` are Windows' own built-in profiles — present on
  // every machine, private to nobody. Single letters are documentation.
  'public', 'default', 'defaultuser', 'nobody',
  'x', 'y', 'z', 'a', 'b', 'c', 'n',
]);

export function isPlaceholderIdentifier(value) {
  const v = String(value ?? '').trim();
  if (!v) return true;
  // `<user>`, `{user}`, `${USER}`, `%USERNAME%`, `...`, `___`
  // `…` (U+2026) is the ellipsis documentation actually uses — this repo's own
  // docs write the home-directory prefixes that way, and without it the rules
  // fired on the table that describes them.
  if (/^(?:<.*>|\{.*\}|\$\{.*\}|\$[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z0-9_]+%|\.{2,}|…+|_+|-+)$/.test(v)) return true;
  return PLACEHOLDER_IDENTIFIERS.has(v.toLowerCase());
}

/** Windows device names — an entry so named cannot be extracted on Windows. */
const WINDOWS_RESERVED_RE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

/** RFC 2606 / RFC 6761 reserved domains, plus GitHub's noreply space. */
const NEUTRAL_EMAIL_DOMAIN_RE =
  /(?:^|\.)(?:example\.(?:com|org|net)|test|invalid|localhost|users\.noreply\.github\.com)$/i;

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,24}\b/g;

/**
 * A buffer is treated as binary — and skipped by the text rules — when a NUL
 * byte appears in its first 8 KiB. Text rules cannot say anything useful about
 * a PNG, and running them wastes the operator's attention.
 */
export function looksBinary(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? '');
  const head = b.subarray(0, 8192);
  return head.includes(0);
}

/**
 * Turn a buffer into the text the rules should run over.
 *
 * A NUL byte used to exempt a file from EVERY content rule. That is not a
 * theoretical hole: a file saved as UTF-16 — what "Save as Unicode" produces
 * in several Windows editors, and what PowerShell 5.1's `>` writes — is full
 * of NULs while being perfectly readable ASCII to anyone who opens it. One
 * such file under `src/` or `templates/` shipped completely unscanned, and
 * nothing reported that it had been skipped.
 *
 * So: UTF-16 is decoded and scanned as text. Genuinely binary content is still
 * skipped by the text rules, but the printable ASCII runs inside it are
 * extracted and scanned, which is where an embedded credential would sit. The
 * caller is told which happened, so "no leak found" can never quietly mean
 * "not looked at".
 *
 * @returns {{text: string, kind: 'text'|'utf16'|'binary-strings'}}
 */
export function decodeForScan(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? '');
  if (!looksBinary(b)) return { text: b.toString('utf8'), kind: 'text' };

  // UTF-16 detection by DOMINANCE, not by an exact-zero count at one parity.
  // The first version required `evenNuls === 0` (LE) or `oddNuls === 0` (BE),
  // so two stray NUL bytes — a terminator, a pad, a U+0000 in the text — threw
  // the file into the binary branch, where UTF-16 ASCII yields printable runs
  // of ONE byte each and the ≥8 threshold discarded every one of them. The
  // file came back with zero findings and the gate said "no leak found". That
  // is the very hole this function was written to close, reachable by
  // appending two bytes.
  // `swap16` requires an even length and THROWS otherwise. A UTF-16BE file
  // with one byte of slack (a truncated write, a trailing newline) took down
  // `npm run gate`, the build and the release with an unattributable
  // RangeError. Swap the even prefix; a dangling byte cannot form a code unit.
  const asUtf16 = (buf, swap) => {
    const even = buf.length & ~1;
    const view = Buffer.from(buf.subarray(0, even));
    if (swap) view.swap16();
    return view.toString('utf16le');
  };

  // Decided by DECODE QUALITY, not by NUL parity.
  //
  // The parity heuristic assumed the text was predominantly ASCII — every NUL
  // on one side, none on the other. A UTF-16 note in Japanese, Russian or
  // Greek has NULs in neither position, so it failed detection, fell into the
  // binary branch, produced printable runs of one byte, and was discarded by
  // the length threshold: scanned as the empty string and reported clean.
  // Trying both decodes and keeping whichever reads as text has no opinion
  // about the alphabet.
  const hasLeBom = b.length >= 2 && b[0] === 0xff && b[1] === 0xfe;
  const hasBeBom = b.length >= 2 && b[0] === 0xfe && b[1] === 0xff;
  // Two conditions, because either alone misfires. "Almost no control or
  // replacement characters" alone accepts random bytes: decoded as UTF-16 they
  // land on assigned CJK code points and look like perfectly good text. So a
  // plausible share of ASCII is required as well — real documents carry
  // spaces, newlines and punctuation whatever their script, and the things
  // this scanner hunts (keys, addresses, paths) are ASCII by construction.
  const readable = (s) => {
    if (!s.length) return { ok: false };
    const sample = [...s.slice(0, 4096)];
    let good = 0;
    let ascii = 0;
    for (const ch of sample) {
      const c = ch.codePointAt(0);
      if (c === 9 || c === 10 || c === 13 || (c >= 0x20 && c !== 0x7f && c !== 0xfffd)) good++;
      if (c === 9 || c === 10 || c === 13 || (c >= 0x20 && c <= 0x7e)) ascii++;
    }
    return { ok: good / sample.length >= 0.9 && ascii / sample.length >= 0.05 };
  };

  if (hasLeBom) return { text: asUtf16(b, false), kind: 'utf16' };
  if (hasBeBom) return { text: asUtf16(b, true), kind: 'utf16' };

  // No BOM: the endianness is genuinely ambiguous, and picking wrong turns an
  // ASCII credential into mojibake. Byte-swapped CJK decodes to *other* valid
  // CJK, so "which reads as text" cannot separate them. For a SCANNER the
  // resolution is not to choose: when either decode reads as text, scan BOTH.
  // Line numbers blur; findings do not go missing, which is the trade a leak
  // scanner should always take.
  const le = asUtf16(b, false);
  const be = asUtf16(b, true);
  const leOk = readable(le).ok;
  const beOk = readable(be).ok;
  if (leOk && beOk) return { text: `${le}\n${be}`, kind: 'utf16' };
  if (leOk) return { text: le, kind: 'utf16' };
  if (beOk) return { text: be, kind: 'utf16' };

  // Last resort before giving up on text: drop the NUL padding and see whether
  // what remains reads. This is deliberately encoding-agnostic — it catches
  // UTF-32 (three NULs per character, so no 16-bit heuristic applies) and any
  // other NUL-padded form without needing a decoder for each. A credential is
  // ASCII whatever the file is encoded in.
  const stripped = Buffer.from(b.filter((byte) => byte !== 0)).toString('latin1');
  if (stripped.length >= 8 && readable(stripped).ok) {
    return { text: stripped, kind: 'nul-padded' };
  }

  // Real binary: pull out printable ASCII runs, `strings(1)`-style, and join
  // them with newlines so line numbers stay meaningless rather than wrong.
  const runs = [];
  let current = [];
  for (const byte of b) {
    if (byte >= 0x20 && byte <= 0x7e) current.push(byte);
    else {
      if (current.length >= 8) runs.push(Buffer.from(current).toString('latin1'));
      current = [];
    }
  }
  if (current.length >= 8) runs.push(Buffer.from(current).toString('latin1'));
  const text = runs.join('\n');
  // A large file that yields almost nothing readable was not scanned in any
  // meaningful sense. Say so — silence here is what "no leak found" was
  // quietly resting on.
  const unscannable = b.length >= 512 && text.length < b.length / 64;
  return { text, kind: unscannable ? 'binary-unscannable' : 'binary-strings' };
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

/**
 * Never echo a suspected credential into a log, a CI page or a PR comment.
 *
 * The previous version revealed a 4-character prefix and a 2-character suffix
 * regardless of length, which is half of a 12-character secret in the clear —
 * in a CI log, which is exactly the kind of place a leaked value gets indexed.
 * Below 24 characters nothing is revealed; above it, just enough to recognise
 * which value is meant.
 */
function redact(value) {
  const v = String(value);
  if (v.length < 24) return `<${v.length} chars redacted>`;
  return `${v.slice(0, 2)}…${'*'.repeat(8)}…${v.slice(-2)}`;
}

/**
 * Check ONE entry against every category that applies to its zone.
 *
 * @param {{path: string, content?: Buffer|string, isSymlink?: boolean, zone?: string}} entry
 * @param {{privatePathRoots?: string[], emailAllowlist?: string[]}} [options]
 */
export function scanEntry(entry, options = {}) {
  const findings = [];
  const p = String(entry.path).replace(/\\/g, '/');
  const zone = entry.zone || 'authored';
  const vendored = zone === 'vendored';

  // --- path-traversal: name-only, so it also applies to entries we never read
  const rawName = String(entry.path);
  const segments = p.split('/');
  const traversalReasons = [];
  if (rawName.includes('\0')) traversalReasons.push('NUL byte in name');
  if (rawName.includes('\\')) traversalReasons.push('backslash separator');
  if (p.startsWith('/')) traversalReasons.push('absolute path');
  if (/^[A-Za-z]:/.test(p)) traversalReasons.push('drive letter');
  if (segments.includes('..')) traversalReasons.push('`..` segment');
  if (segments.some((s) => s === '')) traversalReasons.push('empty segment');
  if (segments.some((s) => WINDOWS_RESERVED_RE.test(s))) traversalReasons.push('Windows reserved device name');
  for (const reason of traversalReasons) {
    findings.push({ category: 'path-traversal', rule: 'unsafe-entry-name', path: p, evidence: reason });
  }

  // --- symlink: a link inside an artifact is either a way out of the
  //     extraction root or a way to smuggle a file that never passed the gate.
  if (entry.isSymlink) {
    findings.push({
      category: 'symlink',
      rule: 'symbolic-link',
      path: p,
      evidence: entry.linkTarget ? `→ ${entry.linkTarget}` : 'symbolic link',
    });
  }

  if (entry.content == null) return findings;
  const buf = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content);
  const decoded = decodeForScan(buf);
  const text = decoded.text;
  // How this entry was read is recorded on the findings array itself, so
  // `scanEntries` can total it up. The previous mechanism wrote to an optional
  // `scanKindOut` object that NO caller ever passed — the comment promised the
  // operator would be told what was skipped, and nothing told anyone anything.
  findings.scanKind = decoded.kind;

  // --- secret (both zones)
  for (const rule of SECRET_RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags);
    let m;
    while ((m = re.exec(text)) !== null) {
      const value = rule.valueGroup ? m[rule.valueGroup] : m[0];
      findings.push({
        category: 'secret',
        rule: rule.id,
        path: p,
        line: lineOf(text, m.index),
        evidence: redact(value),
      });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  // The generic `key = <blob>` rule asks whether an author MEANT this value to
  // be a credential — a judgement that can be exercised over ~340 authored
  // files and cannot be over ~9,600 vendored ones, where JSDoc examples and
  // documentation snippets trip it constantly (hono and undici each ship one,
  // css-select assigns a CSS selector to a key literally named `password`).
  // Running it there would produce a permanent list of muted findings, which
  // is how a scanner stops being read. The SHAPED rules above — real prefixes,
  // real lengths — keep running in both zones.
  //
  // Note the self-reference trap this comment is avoiding: a scanner that
  // spells out the strings it hunts for will match its own source. Describe
  // the patterns, never quote them.
  if (!vendored) {
    const re = new RegExp(ASSIGNED_CREDENTIAL_RE.source, ASSIGNED_CREDENTIAL_RE.flags);
    let m;
    while ((m = re.exec(text)) !== null) {
      if (looksLikeLiveCredential(m[2])) {
        findings.push({
          category: 'secret',
          rule: 'assigned-credential',
          path: p,
          line: lineOf(text, m.index),
          evidence: `${m[1]} = ${redact(m[2])}`,
        });
      }
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }

  // The two remaining categories describe OUR machine and OUR people. Inside a
  // dependency they describe its author's, which is upstream reality and not a
  // leak of ours — see the zone rationale in the module header.
  if (vendored) return findings;

  // --- personal-email
  {
    const allow = new Set((options.emailAllowlist || []).map((e) => e.toLowerCase()));
    const re = new RegExp(EMAIL_RE.source, EMAIL_RE.flags);
    let m;
    while ((m = re.exec(text)) !== null) {
      const addr = m[0];
      const lower = addr.toLowerCase();
      const domain = lower.slice(lower.indexOf('@') + 1);
      if (allow.has(lower) || NEUTRAL_EMAIL_DOMAIN_RE.test(domain)) continue;
      // `https://user@host/…` and `https://user:pass@host/…` are URL userinfo,
      // not addresses that reach a person. The window looks back for a `://`
      // with no whitespace or quote in between, so it catches the `user:pass@`
      // form too — which is what the tunnel fixtures actually use
      // (`https://obsidian:pw@abc.trycloudflare.com/`).
      if (/:\/\/[^\s"'`<>]*$/.test(text.slice(Math.max(0, m.index - 64), m.index))) continue;
      findings.push({
        category: 'personal-email',
        rule: 'email-address',
        path: p,
        line: lineOf(text, m.index),
        evidence: addr,
      });
    }
  }

  // --- private-path
  for (const rule of PRIVATE_PATH_RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags);
    let m;
    while ((m = re.exec(text)) !== null) {
      if (!isPlaceholderIdentifier(m[1])) {
        findings.push({
          category: 'private-path',
          rule: rule.id,
          path: p,
          line: lineOf(text, m.index),
          evidence: m[0].trim(),
        });
      }
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  // Machine-specific roots are supplied at call time and NEVER committed:
  // writing `C:\VAULTS\…` into a contract file to detect it being published
  // would publish it. `scripts/export-gate.mjs` passes the repo root, the home
  // directory and `OBSIDIAN_ROUTER_EXPORT_PRIVATE_ROOTS`.
  // `toLowerCase()` is hoisted: recomputing it inside the match loop made this
  // quadratic — 800 hits in a 12 MiB file took 7.8 s, and node_modules has
  // files that size.
  const lowerText = (options.privatePathRoots || []).length ? text.toLowerCase() : '';
  for (const root of options.privatePathRoots || []) {
    const r = String(root).trim();
    if (r.length < 4) continue;
    // The doubled-backslash variant matters more than it looks: inside a JS
    // string or a JSON value a Windows path is written `C:\\VAULTS\\notes`,
    // and a literal search for `C:\VAULTS` never matched it. Every private
    // root quoted in source code was invisible to this rule.
    const backslashed = r.replace(/\//g, '\\');
    const variants = new Set([
      r,
      r.replace(/\\/g, '/'),
      backslashed,
      backslashed.replace(/\\/g, '\\\\'),
    ]);
    for (const variant of variants) {
      const lowerVariant = variant.toLowerCase();
      let from = 0;
      for (;;) {
        const idx = lowerText.indexOf(lowerVariant, from);
        if (idx === -1) break;
        findings.push({
          category: 'private-path',
          rule: 'configured-private-root',
          path: p,
          line: lineOf(text, idx),
          evidence: variant,
        });
        from = idx + variant.length;
      }
    }
  }

  return findings;
}

/**
 * Scan a whole entry list.
 *
 * `exceptions` come from the contract's `scanExceptions` and each MUST carry a
 * `reason`; an exception without one is itself reported as a finding, so the
 * escape hatch cannot be used to quietly widen the gate.
 */
/**
 * Categories no exception may ever silence. A traversal name or a symlink is
 * not a judgement call about intent — it is a structural property of the
 * artifact that breaks the consumer's extraction, and no written reason makes
 * it safe.
 */
const UNSUPPRESSABLE_CATEGORIES = new Set(['path-traversal', 'symlink']);

export function scanEntries(entries, options = {}) {
  const findings = [];
  const suppressed = [];

  // An exception is only usable once it has survived validation. Previously
  // `path`, `category` and `rule` were all optional, so a single entry
  // carrying nothing but `{ reason: "..." }` silenced every category on every
  // file — the whole scanner, disabled by one well-meaning line.
  const exceptions = [];
  for (const [index, ex] of (options.exceptions || []).entries()) {
    // An exception scoped to named targets applies only to those. Without
    // this, THIS repo's `tests/**` exception matched a stranger's OKF bundle
    // that happened to contain a `tests/` folder — the exporter strips the
    // vault's `wiki/` prefix, so bundle paths look like repo paths — and muted
    // the generic-credential rule across someone else's shared knowledge.
    // Fail CLOSED: a scoped exception applies only when the caller says which
    // target it is gating. Requiring `options.target` to be truthy meant an
    // unscoped caller — the audit path, which is exactly the tool you point at
    // a stranger's archive — got every scoped suppression instead of none.
    if (Array.isArray(ex.targets) && !ex.targets.includes(options.target)) {
      continue;
    }
    const problems = [];
    if (!ex.reason || String(ex.reason).trim().length < 20) problems.push('no written reason');
    if (!ex.path || !String(ex.path).trim()) problems.push('no path pattern');
    // The message says what the rule actually is. "matches every file" was a
    // false statement to an operator's face: `*.md` matches four files here
    // and was refused with those words, which teaches people to rewrite a
    // narrow pattern as a WIDER one that happens to satisfy the check.
    else if (isCatchAllPattern(ex.path)) {
      problems.push('path pattern is built only from wildcards — an exception must name at least one literal directory or filename');
    }
    if (!ex.category) problems.push('no category');
    else if (UNSUPPRESSABLE_CATEGORIES.has(ex.category)) {
      problems.push(`category "${ex.category}" can never be excepted`);
    }
    // A malformed pattern must be REPORTED next to its siblings, not thrown
    // out of the scanner: a leading `/` used to abort the whole run.
    if (ex.path && !problems.length) {
      try { compileAllowPattern(ex.path); } catch (err) { problems.push(`unusable path pattern: ${err.message}`); }
    }

    if (problems.length) {
      findings.push({
        category: 'contract',
        rule: 'invalid-exception',
        path: ex.path || '(no path)',
        evidence: `scanExceptions[${index}] is not usable: ${problems.join('; ')} — it suppresses nothing`,
      });
      continue;
    }
    exceptions.push({ ...ex, index, re: compileAllowPattern(ex.path) });
  }

  const scanKinds = { text: 0, utf16: 0, 'nul-padded': 0, 'binary-strings': 0, 'binary-unscannable': 0, 'name-only': 0 };
  for (const entry of entries) {
    const entryFindings = scanEntry(entry, options);
    scanKinds[entryFindings.scanKind || 'name-only'] += 1;
    for (const f of entryFindings) {
      const ex = exceptions.find(
        (e) => e.re.test(f.path)
          && e.category === f.category
          && (!e.rule || e.rule === f.rule),
      );
      if (ex) suppressed.push({ ...f, suppressedBy: ex.index, reason: ex.reason });
      else findings.push(f);
    }
  }

  const order = (f) => LEAK_CATEGORIES.indexOf(f.category);
  findings.sort((a, b) => order(a) - order(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || (a.line || 0) - (b.line || 0));

  const byCategory = {};
  for (const c of LEAK_CATEGORIES) byCategory[c] = findings.filter((f) => f.category === c).length;

  // `scanKinds` is the honest counterpart to a clean verdict: it says how many
  // files the rules actually READ as text, and how many were bytes they could
  // make nothing of. "No leak found" over a tree that was 90% unreadable is a
  // different statement from the same words over one that was fully read.
  return { ok: findings.length === 0, findings, suppressed, byCategory, scanKinds };
}

// ---------------------------------------------------------------------------
// 3. Checksums
// ---------------------------------------------------------------------------

export function sha256(buf) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? '')).digest('hex');
}

/**
 * A `sha256sum -c` compatible manifest: `<64 hex>  <path>`, two spaces, LF
 * endings, sorted by UTF-8 byte order, trailing newline. Deliberately the
 * coreutils format so an operator can verify a bundle with tools they already
 * have, without this repo installed.
 */
export function buildChecksums(entries) {
  const rows = entries.map((e) => ({
    name: String(e.path).replace(/\\/g, '/'),
    hash: e.sha256 || sha256(e.content),
  }));
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.name, 'utf8'), Buffer.from(b.name, 'utf8')));
  return rows.map((r) => `${r.hash}  ${r.name}\n`).join('');
}

/** Parse a SHA256SUMS body back into a Map, for the audit path. */
export function parseChecksums(text) {
  const map = new Map();
  for (const line of String(text).split('\n')) {
    const m = line.match(/^([0-9a-f]{64}) [ *](.+)$/);
    if (m) map.set(m[2], m[1]);
  }
  return map;
}

// ---------------------------------------------------------------------------
// 4. Manifest
// ---------------------------------------------------------------------------

/**
 * The record that ties an artifact to its commit.
 *
 * Contains NO timestamp on purpose: a build clock is the single easiest way to
 * make "same commit, same bytes" false. `zlibVersion` is recorded instead —
 * when two builds of one commit disagree, it says whether the encoder is why.
 * Key order is fixed by construction so `JSON.stringify` is stable.
 */
export function buildGateManifest({
  target,
  artifact = null,
  productVersion,
  source = {},
  build = {},
  allowlist = {},
  scan = {},
  entries = [],
  checksumsSha256 = null,
}) {
  const totalBytes = entries.reduce((n, e) => n + (e.size ?? (e.content ? e.content.length : 0)), 0);
  return {
    gateVersion: GATE_VERSION,
    target,
    artifact,
    productVersion,
    source: {
      commit: source.commit ?? null,
      ref: source.ref ?? null,
      dirty: source.dirty ?? null,
    },
    build: {
      node: build.node ?? null,
      zlibVersion: build.zlibVersion ?? null,
      compression: build.compression ?? 'deflate',
      normalizedMtime: `dos:${DOS_EPOCH_DATE.toString(16)}:${DOS_EPOCH_TIME.toString(16)}`,
    },
    allowlist: {
      contract: allowlist.contract ?? null,
      sha256: allowlist.sha256 ?? null,
      zones: allowlist.zones ?? null,
    },
    scan: {
      categories: [...LEAK_CATEGORIES],
      findings: scan.findings ?? 0,
      suppressed: scan.suppressed ?? 0,
      byCategory: scan.byCategory ?? null,
      scanKinds: scan.scanKinds ?? null,
    },
    entries: {
      count: entries.length,
      totalBytes,
      checksumsFile: CHECKSUM_FILE,
      checksumsSha256,
    },
  };
}

/** Deterministic serialisation: 2-space JSON, LF, trailing newline. */
export function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`.replace(/\r\n/g, '\n');
}

// ---------------------------------------------------------------------------
// 5. Audit without extraction
// ---------------------------------------------------------------------------

/**
 * Verify a finished archive from its bytes alone — nothing is unpacked.
 *
 * Three independent things are checked, and each can fail on its own:
 *   - the entry NAMES are safe to extract (traversal, symlinks, device names,
 *     case collisions that silently drop a file on Windows);
 *   - every entry's stored CRC-32 matches its actual body;
 *   - every entry's sha256 matches the `SHA256SUMS` carried in the archive,
 *     and `SHA256SUMS` itself matches the hash the manifest recorded.
 *
 * That last link is what makes tampering detectable rather than merely
 * inconvenient: rewriting a file forces rewriting SHA256SUMS, which forces
 * rewriting the manifest, which changes the archive hash published alongside.
 *
 * @param {Buffer} buffer
 * @param {{expectArchiveSha256?: string, deep?: boolean}} [options]
 */
export function auditArchive(buffer, options = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const deep = options.deep !== false;
  const problems = [];
  const note = (kind, detail, entry = null) => problems.push({ kind, detail, entry });

  const archiveSha256 = sha256(buf);
  if (options.expectArchiveSha256 && options.expectArchiveSha256 !== archiveSha256) {
    note('archive-hash-mismatch',
      `archive sha256 is ${archiveSha256}, expected ${options.expectArchiveSha256}`);
  }

  let directory;
  try {
    directory = readZipDirectory(buf);
  } catch (err) {
    return {
      ok: false,
      archiveSha256,
      entryCount: 0,
      problems: [{ kind: 'unreadable-archive', detail: err.message, entry: null }],
    };
  }

  const { entries } = directory;
  if (directory.zip64) note('zip64-archive', 'archive uses ZIP64 — not produced by this gate');

  // Byte regions that belong to the archive but to no entry. Nothing read them
  // before, so they were a place to park anything: a bearer token in the EOCD
  // comment audited perfectly clean.
  const sidecarBytes = [];
  if (directory.comment && directory.comment.length) {
    note('archive-comment', `the archive carries a ${directory.comment.length}-byte comment; this gate writes none`);
    sidecarBytes.push({ path: '(archive comment)', content: directory.comment, zone: 'authored' });
  }

  // --- name safety (the whole point of auditing before extraction)
  const lowerSeen = new Map();
  for (const e of entries) {
    // Directory entries legitimately end in `/`, which the traversal rule
    // reads as an empty final segment. Checking the name without it keeps the
    // real checks (`..`, absolute, device names) while dropping the noise on
    // archives from elsewhere.
    const nameForScan = e.isDirectory ? e.name.replace(/\/+$/, '') : e.name;
    for (const f of scanEntry({ path: nameForScan, isSymlink: e.isSymlink })) {
      note(f.category, f.evidence, e.name);
    }

    // The local header is an independent copy of this entry's metadata, and
    // streaming extractors believe IT rather than the central directory. An
    // archive whose central record says `server/abc.mjs` while its local
    // header says `../../evil.mjs` passed every other check here.
    const local = compareLocalHeader(buf, e);
    for (const mismatch of local.problems) {
      note('local-header-mismatch', mismatch, e.name);
    }
    // A feature this reader cannot parse is NOT evidence of tampering. Saying
    // so separately matters: every entry of a streamed archive (data
    // descriptors — Java's ZipOutputStream, `jar`, Python to a pipe) was
    // reported as a header disagreement, which reads as an attack and made the
    // auditor unable to examine an entire class of valid archives.
    for (const u of local.unsupported) {
      note('unsupported-archive-format', `${u} — this entry was NOT verified`, e.name);
    }
    // Extra-field bytes travel with the archive and are read by nothing —
    // a credential parked there was physically present and completely
    // unexamined. Collected here and scanned with the entry bodies below.
    if (local.extraField && local.extraField.length) {
      sidecarBytes.push({ path: `${e.name} (local extra field)`, content: local.extraField, zone: 'authored' });
    }

    if (e.isDirectory) continue;
    const lower = e.name.toLowerCase();
    if (lowerSeen.has(lower) && lowerSeen.get(lower) !== e.name) {
      note('case-collision',
        `${e.name} and ${lowerSeen.get(lower)} differ only by case — one silently overwrites the other on Windows`,
        e.name);
    }
    lowerSeen.set(lower, e.name);
    if (e.dosDate !== DOS_EPOCH_DATE || e.dosTime !== DOS_EPOCH_TIME) {
      note('non-normalized-mtime',
        `entry carries a real timestamp (dosDate=0x${e.dosDate.toString(16)}) — archive is not reproducible`,
        e.name);
    }
  }

  // --- content integrity
  const fileEntries = entries.filter((e) => !e.isDirectory);
  const byName = new Map(fileEntries.map((e) => [e.name, e]));
  const actualHashes = new Map();

  // Inflated ONCE per entry, hashed AND leak-scanned in the same pass, then
  // DROPPED. Retaining every buffer to avoid a second inflate traded CPU for
  // peak memory of O(the whole 4 GiB budget): a ~2 MiB archive could make the
  // auditor hold gigabytes, on the path that by definition runs on archives
  // from elsewhere. Only the two small gate files are kept.
  const inflated = new Map();
  const scanBatch = [];
  let inflatedTotal = 0;
  let budgetExhausted = false;

  if (deep) {
    for (const e of fileEntries) {
      // The declared cumulative ceiling was exported, frozen, documented as
      // enforced — and never read. Ten thousand entries each individually
      // under the per-entry and ratio limits inflate to terabytes together.
      if (inflatedTotal + e.size > AUDIT_LIMITS.maxTotalBytes) {
        if (!budgetExhausted) {
          note('audit-budget-exhausted',
            `stopped after ${inflatedTotal} inflated bytes — the archive declares more than the `
            + `${AUDIT_LIMITS.maxTotalBytes}-byte audit ceiling, so the remaining entries were NOT verified`);
          budgetExhausted = true;
        }
        continue;
      }
      let content;
      try {
        content = readZipEntryContent(buf, e);
      } catch (err) {
        note(err.unsupportedFormat ? 'unsupported-archive-format' : 'unreadable-entry', err.message, e.name);
        continue;
      }
      // Only the two small gate files are retained; every other buffer is
      // scanned here and released, so peak memory is O(largest entry) rather
      // than O(the whole archive).
      if (e.name === CHECKSUM_FILE || e.name === MANIFEST_FILE) {
        inflated.set(e.name, content);
      } else if (options.scanContents !== false) {
        scanBatch.push({
          path: e.name,
          content,
          zone: /(?:^|\/)node_modules\//.test(e.name) ? 'vendored' : 'authored',
        });
      }
      inflatedTotal += content.length;
      if (content.length !== e.size) {
        note('size-mismatch', `inflated to ${content.length} bytes, directory says ${e.size}`, e.name);
      }
      // CRC-32 comes from zlib (Node >= 20.15; `engines` pins >= 20.18.1).
      const crc = zlib.crc32(content) >>> 0;
      if (crc !== e.crc32) {
        note('crc-mismatch',
          `body CRC-32 is 0x${crc.toString(16)}, directory says 0x${e.crc32.toString(16)} — entry was altered`,
          e.name);
      }
      actualHashes.set(e.name, sha256(content));
    }
  }

  // --- the checksum chain
  const sumsEntry = byName.get(CHECKSUM_FILE);
  const manifestEntry = byName.get(MANIFEST_FILE);
  let manifest = null;

  // A shallow audit reads names only. That is a legitimate, cheap mode — but
  // it must never be mistakable for a verified one, so it says outright that
  // integrity was not established rather than returning a bare `ok`.
  if (!deep) {
    note('integrity-not-verified',
      'shallow audit: names were checked, contents were not — no CRC, hash or manifest verification was performed');
  }

  if (!sumsEntry) {
    note('missing-checksums', `${CHECKSUM_FILE} is absent — the archive did not pass through the export gate`);
  } else if (deep) {
    let sumsText;
    try {
      sumsText = (inflated.get(CHECKSUM_FILE) ?? readZipEntryContent(buf, sumsEntry)).toString('utf8');
    } catch (err) {
      // Previously unwrapped, unlike the reads in the loop above: a corrupt
      // SHA256SUMS local header made the whole audit throw a stack trace
      // instead of returning a problem list — and in the build it threw AFTER
      // the archive had already been written to disk.
      note('unreadable-checksums', err.message, CHECKSUM_FILE);
      return { ok: false, archiveSha256, entryCount: fileEntries.length, manifest: null, problems };
    }
    const declared = parseChecksums(sumsText);
    if (declared.size === 0) {
      note('unparseable-checksums', `${CHECKSUM_FILE} contains no valid "<sha256>  <path>" line`, CHECKSUM_FILE);
    }

    for (const [name, want] of declared) {
      const got = actualHashes.get(name);
      if (got == null) note('checksummed-entry-missing', `${CHECKSUM_FILE} lists ${name}, which is not in the archive`, name);
      else if (got !== want) note('content-hash-mismatch', `sha256 is ${got}, ${CHECKSUM_FILE} says ${want}`, name);
    }
    for (const e of fileEntries) {
      if (e.name === CHECKSUM_FILE || e.name === MANIFEST_FILE) continue;
      if (!declared.has(e.name)) {
        note('unchecksummed-entry', `${e.name} is in the archive but absent from ${CHECKSUM_FILE}`, e.name);
      }
    }

    if (manifestEntry) {
      try {
        manifest = JSON.parse((inflated.get(MANIFEST_FILE) ?? readZipEntryContent(buf, manifestEntry)).toString('utf8'));
      } catch (err) {
        note('unreadable-manifest', err.message, MANIFEST_FILE);
      }
      const sumsHash = actualHashes.get(CHECKSUM_FILE);

      // The fields below were previously verified ONLY IF PRESENT, so a
      // manifest of `{}` satisfied every check and the archive audited clean.
      // An absent field is a missing guarantee, not a waived one.
      if (manifest) {
        for (const [field, value] of [
          ['gateVersion', manifest.gateVersion],
          ['target', manifest.target],
          ['entries.count', manifest.entries?.count],
          ['entries.checksumsSha256', manifest.entries?.checksumsSha256],
        ]) {
          if (value === undefined || value === null) {
            note('incomplete-manifest', `${MANIFEST_FILE} declares no ${field} — nothing to verify against`, MANIFEST_FILE);
          }
        }
        if (manifest.entries?.checksumsSha256 && sumsHash
            && manifest.entries.checksumsSha256 !== sumsHash) {
          note('checksums-hash-mismatch',
            `${MANIFEST_FILE} pins ${CHECKSUM_FILE} at ${manifest.entries.checksumsSha256}, actual ${sumsHash}`,
            CHECKSUM_FILE);
        }
        if (Number.isInteger(manifest.entries?.count)
            && manifest.entries.count !== declared.size) {
          note('entry-count-mismatch',
            `${MANIFEST_FILE} declares ${manifest.entries.count} entries, ${CHECKSUM_FILE} lists ${declared.size}`);
        }
      }
    } else {
      note('missing-manifest', `${MANIFEST_FILE} is absent — nothing ties this artifact to a commit`);
    }
  }

  // The leak scan over CONTENTS, not just names. Without it an archive can
  // carry a bearer token in a checksummed, uncorrupted, correctly-named entry
  // and the audit reports "every entry matches its checksum" — true, and
  // easily misread as "this archive is safe to publish".
  if (deep && options.scanContents !== false) {
    // Collected during the single inflate pass above, plus the byte regions
    // that belong to no entry (the archive comment, local extra fields), plus
    // the two gate files themselves — which were previously skipped, so a
    // credential parked inside `export-manifest.json` audited perfectly clean.
    // They are exempt from the CHECKSUM comparison, never from the leak scan.
    const scanEntries_ = scanBatch
      .concat(sidecarBytes)
      .concat([...inflated.entries()].map(([name, content]) => ({ path: name, content, zone: 'authored' })));
    const leaks = scanEntries(scanEntries_, {
      // Threaded, not dropped: the audit accepted `target` and never passed it
      // on, so target-scoped exceptions silently applied to every archive.
      target: options.target,
      privatePathRoots: options.privatePathRoots || [],
      emailAllowlist: options.emailAllowlist || [],
      exceptions: options.exceptions || [],
    });
    for (const f of leaks.findings) {
      note(`leak:${f.category}`, `${f.rule}${f.line ? ` (line ${f.line})` : ''}: ${f.evidence}`, f.path);
    }
  }

  return {
    ok: problems.length === 0,
    archiveSha256,
    entryCount: fileEntries.length,
    manifest,
    // The checksum chain proves the archive is INTERNALLY CONSISTENT. It does
    // not prove authenticity: an attacker who rewrites a file, the checksums
    // and the manifest together produces a consistent archive with a different
    // hash. Only comparing `archiveSha256` against a hash obtained elsewhere
    // establishes that this is the artifact the publisher built — so the
    // result says which of the two was actually done.
    authenticityVerified: Boolean(options.expectArchiveSha256),
    integrityVerified: deep,
    problems,
  };
}

// ---------------------------------------------------------------------------
// Filesystem front-end (the only I/O in this module)
// ---------------------------------------------------------------------------

/**
 * Walk a directory into gate entries.
 *
 * Uses `lstat`, never `stat`: a symlink must be REPORTED, not silently
 * followed into whatever it points at. Directory symlinks are reported and not
 * descended, so a link to `C:\Users` cannot pull a home directory into a
 * bundle.
 */
export function collectFiles(root, options = {}) {
  const out = [];
  const rootAbs = path.resolve(root);
  const walk = (dir) => {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const item of items) {
      const abs = path.join(dir, item.name);
      const rel = path.relative(rootAbs, abs).replace(/\\/g, '/');
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) {
        let linkTarget = null;
        try { linkTarget = fs.readlinkSync(abs); } catch { /* unreadable link */ }
        out.push({ path: rel, isSymlink: true, linkTarget, size: 0 });
        continue;
      }
      if (st.isDirectory()) { walk(abs); continue; }
      if (!st.isFile()) continue;
      out.push({ path: rel, isSymlink: false, size: st.size, absolute: abs });
    }
  };
  walk(rootAbs);
  if (options.withContent !== false) {
    for (const e of out) {
      if (e.isSymlink) continue;
      e.content = fs.readFileSync(e.absolute);
    }
  }
  return out;
}

/**
 * The full gate over a directory: allowlist → scan → checksums → manifest.
 *
 * Returns everything needed to build an artifact, or to explain why one must
 * not be built. It never writes; the caller decides what to do with `ok`.
 */
export function gateDirectory({
  root,
  contract,
  target,
  productVersion,
  source = {},
  privatePathRoots = [],
  contractSha256 = null,
  contractPath = null,
  compression = 'deflate',
  artifact = null,
}) {
  const spec = contract.targets?.[target];
  if (!spec) throw new Error(`export contract has no target "${target}"`);

  const all = collectFiles(root, { withContent: false });
  const { included, excluded } = applyAllowlist(all.map((e) => e.path), spec.zones);
  const zoneOf = new Map(included.map((i) => [i.path, i.zone]));
  const byPath = new Map(all.map((e) => [e.path, e]));

  const entries = included.map(({ path: p }) => {
    const src = byPath.get(p);
    return {
      path: p,
      zone: zoneOf.get(p),
      isSymlink: src.isSymlink,
      linkTarget: src.linkTarget,
      content: src.isSymlink ? null : fs.readFileSync(src.absolute),
      size: src.size,
    };
  });

  const scan = scanEntries(entries, {
    target,
    exceptions: contract.scanExceptions || [],
    privatePathRoots,
    emailAllowlist: contract.emailAllowlist || [],
  });

  const checksums = buildChecksums(entries.filter((e) => !e.isSymlink));
  const manifest = buildGateManifest({
    target,
    artifact,
    productVersion,
    source,
    build: { node: process.versions.node, zlibVersion: process.versions.zlib, compression },
    allowlist: { contract: contractPath, sha256: contractSha256, zones: Object.keys(spec.zones) },
    scan: { findings: scan.findings.length, suppressed: scan.suppressed.length, byCategory: scan.byCategory, scanKinds: scan.scanKinds },
    entries: entries.filter((e) => !e.isSymlink),
    checksumsSha256: sha256(checksums),
  });

  return { ok: scan.ok, entries, included, excluded, scan, checksums, manifest };
}

/**
 * The gate over an IN-MEMORY file set — no filesystem, no clock.
 *
 * This is the path the OKF exporter and the release notes take: their output
 * never touches disk before it has been judged, so there is no directory to
 * walk. Same allowlist, same scan, same checksums, same manifest shape as
 * `gateDirectory` — one gate, three exits.
 *
 * `files` is `[{path, content}]`. Returns the gate verdict plus the two files
 * the artifact should carry; the CALLER decides whether to publish, because
 * only the caller knows whether a finding is worth stopping for.
 */
export function gateFileSet({
  files,
  target,
  contract = null,
  productVersion = null,
  source = {},
  privatePathRoots = [],
  artifact = null,
}) {
  // A contract that does not declare this target is a typo, not a request to
  // skip the allowlist. `gateDirectory` has always thrown here; this path
  // silently degraded to "unchecked" and still returned ok:true — and this is
  // the path the OKF exit uses, so the silent one was the one in production.
  if (contract && !contract.targets?.[target]) {
    throw new Error(`export contract has no target "${target}" (declared: ${Object.keys(contract.targets || {}).join(', ') || 'none'})`);
  }
  const spec = contract?.targets?.[target] ?? null;
  const entries = files.map((f) => ({
    path: String(f.path).replace(/\\/g, '/'),
    zone: 'authored',
    content: Buffer.isBuffer(f.content) ? f.content : Buffer.from(String(f.content ?? ''), 'utf8'),
  }));

  // The allowlist is only meaningful when a contract names this target. Being
  // unable to check is NOT the same as having checked and found nothing, so an
  // unchecked run is reported as a finding rather than as a clean result.
  let allowlist = { checked: false, included: entries.length, excluded: [] };
  if (spec) {
    const { included, excluded } = applyAllowlist(entries.map((e) => e.path), spec.zones);
    allowlist = { checked: true, included: included.length, excluded: excluded.map((e) => e.path) };
  }

  const scan = scanEntries(entries, {
    target,
    exceptions: contract?.scanExceptions || [],
    privatePathRoots,
    emailAllowlist: contract?.emailAllowlist || [],
  });

  const unlisted = allowlist.excluded.map((p) => ({
    category: 'contract',
    rule: 'not-on-allowlist',
    path: p,
    evidence: 'produced by the exporter but named by no allowlist pattern',
  }));
  const unchecked = allowlist.checked ? [] : [{
    category: 'contract',
    rule: 'allowlist-not-checked',
    path: '(whole file set)',
    evidence: 'no contract was supplied, so no allowlist ran — this result says nothing about what may ship',
  }];
  const findings = [...unchecked, ...unlisted, ...scan.findings];

  const checksums = buildChecksums(entries);
  const manifest = buildGateManifest({
    target,
    artifact,
    productVersion,
    source,
    // No runtime versions here, unlike the archive path. There is no encoder
    // in an in-memory file set, so `node` and `zlibVersion` would describe
    // nothing — while making two machines emit different bundle bytes for the
    // same vault, which is the exact property this gate is supposed to give.
    build: { node: null, zlibVersion: null, compression: 'none' },
    allowlist: { contract: contract ? 'contracts/export-allowlist.json' : null, sha256: null, zones: spec ? Object.keys(spec.zones) : null },
    scan: { findings: findings.length, suppressed: scan.suppressed.length, byCategory: scan.byCategory },
    entries,
    checksumsSha256: sha256(checksums),
  });

  return {
    ok: findings.length === 0,
    findings,
    suppressed: scan.suppressed,
    byCategory: scan.byCategory,
    allowlist,
    checksums,
    manifest,
    gateFiles: [
      { path: CHECKSUM_FILE, content: checksums },
      { path: MANIFEST_FILE, content: serializeManifest(manifest) },
    ],
  };
}

/** Human-readable rendering shared by the CLI, the build and the release. */
export function renderFindings(findings) {
  if (!findings.length) return 'export gate: OK — no leak found.';
  const lines = [`export gate: ${findings.length} finding${findings.length > 1 ? 's' : ''}`, ''];
  for (const f of findings) {
    const where = f.line ? `${f.path}:${f.line}` : f.path;
    lines.push(`  [${f.category}/${f.rule}] ${where}`);
    lines.push(`      ${f.evidence}`);
  }
  lines.push('');
  lines.push('  Fix the file, or add an entry with a written reason to');
  lines.push(`  contracts/export-allowlist.json → scanExceptions.`);
  return lines.join('\n');
}
