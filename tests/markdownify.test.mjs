/**
 * Markdownify port — smoke + unit tests.
 *
 * Does NOT exercise the actual `markitdown` subprocess (that requires a Python
 * install + ~150 MB of `markitdown[all]` deps — too heavy for a unit test).
 * What's covered here:
 *   - Pure helpers in src/markdownify/utils.mjs (SSRF guard, sandbox, etc.)
 *   - The full TOOLS / TOOL_HANDLERS surface compiled into src/index.mjs
 *     loads cleanly and includes all 10 new conversion tools (this exercises
 *     the boot-time cross-check in index.mjs by importing _internals)
 *
 * Tests that need a real markitdown live behind an env-var gate so CI can
 * skip them — none yet, but the structure is ready.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  expandHome,
  isPrivateIp,
  validateUrl,
  validateRepoUrl,
  validateBranchName,
  isUnconvertedHtml,
  inferExtensionFromUrl,
  isWithinDirectory,
  getAllowedPaths,
  assertPathAllowed,
  resolveAndAssertPublic,
  resolveRepomixCommand,
} from '../src/markdownify/utils.mjs';

import { assertSandboxConsistent } from '../src/index.mjs';

import {
  pdfToMarkdown,
  docxToMarkdown,
  xlsxToMarkdown,
  pptxToMarkdown,
  imageToMarkdown,
  audioToMarkdown,
  youtubeToMarkdown,
  bingSearchToMarkdown,
  webpageToMarkdown,
  gitRepoToMarkdown,
} from '../src/tools/convert.mjs';

import { _internals } from '../src/index.mjs';

const CONVERSION_TOOLS = [
  'pdf_to_markdown',
  'docx_to_markdown',
  'xlsx_to_markdown',
  'pptx_to_markdown',
  'image_to_markdown',
  'audio_to_markdown',
  'youtube_to_markdown',
  'bing_search_to_markdown',
  'webpage_to_markdown',
  'git_repo_to_markdown',
];

test('expandHome resolves ~/ to the user home dir', () => {
  const expanded = expandHome('~/foo');
  assert.notStrictEqual(expanded, '~/foo'); // got rewritten
  assert.ok(expanded.endsWith('foo'));
  assert.strictEqual(expandHome('/abs/path'), '/abs/path'); // pass-through
  assert.strictEqual(expandHome('relative/path'), 'relative/path'); // pass-through
});

test('isPrivateIp catches loopback, RFC1918, link-local, mDNS', () => {
  // Loopback
  assert.strictEqual(isPrivateIp('127.0.0.1'), true);
  assert.strictEqual(isPrivateIp('127.255.255.255'), true);
  assert.strictEqual(isPrivateIp('::1'), true);
  // RFC1918
  assert.strictEqual(isPrivateIp('10.0.0.1'), true);
  assert.strictEqual(isPrivateIp('172.16.0.1'), true);
  assert.strictEqual(isPrivateIp('172.31.255.255'), true);
  assert.strictEqual(isPrivateIp('192.168.1.1'), true);
  // Edge cases of RFC1918 boundary — 172.15 and 172.32 are PUBLIC
  assert.strictEqual(isPrivateIp('172.15.0.1'), false);
  assert.strictEqual(isPrivateIp('172.32.0.1'), false);
  // Link-local
  assert.strictEqual(isPrivateIp('169.254.0.1'), true);
  // CGNAT
  assert.strictEqual(isPrivateIp('100.64.0.1'), true);
  // Hostnames
  assert.strictEqual(isPrivateIp('localhost'), true);
  assert.strictEqual(isPrivateIp('app.localhost'), true);
  assert.strictEqual(isPrivateIp('foo.local'), true);
  // Public IPs / hosts
  assert.strictEqual(isPrivateIp('8.8.8.8'), false);
  assert.strictEqual(isPrivateIp('example.com'), false);
});

test('isPrivateIp — hardened against IPv4-mapped IPv6 and encoded IPv4 (Reviewer A B1)', () => {
  // IPv4-mapped IPv6 forms — must all be refused regardless of embedded address.
  // Without this, `http://[::ffff:127.0.0.1]/` was a loopback bypass.
  assert.strictEqual(isPrivateIp('::ffff:127.0.0.1'), true);
  assert.strictEqual(isPrivateIp('::ffff:8.8.8.8'), true); // safe default refuses even public-IPv4-mapped
  assert.strictEqual(isPrivateIp('64:ff9b::1.2.3.4'), true); // IPv4-translated

  // Encoded numeric IPv4 — system resolver normalizes these on POSIX/Windows.
  assert.strictEqual(isPrivateIp('2130706433'), true); // 127.0.0.1 as decimal
  assert.strictEqual(isPrivateIp('0x7f000001'), true); // hex
  assert.strictEqual(isPrivateIp('0177.0.0.1'), true); // octal first octet
  assert.strictEqual(isPrivateIp('127.0.0.01'), true); // octal last octet

  // IPv6 unique-local fc00::/7 — strict match on 4 hex chars after fc/fd
  assert.strictEqual(isPrivateIp('fc00::1'), true);
  assert.strictEqual(isPrivateIp('fd12:3456:789a::1'), true);

  // IPv6 link-local fe80::/10
  assert.strictEqual(isPrivateIp('fe80::1'), true);
  assert.strictEqual(isPrivateIp('febf::1'), true);
  // IPv6 site-local fec0::/10 — deprecated by RFC 3879 but still routable on
  // legacy LAN setups. Reviewer A pass 2: must be refused, not allowed.
  assert.strictEqual(isPrivateIp('fec0::1'), true);
  assert.strictEqual(isPrivateIp('feff::1'), true);
  // IPv6 multicast ff00::/8 — no legitimate HTTP target, refuse.
  assert.strictEqual(isPrivateIp('ff02::1'), true);
  assert.strictEqual(isPrivateIp('ff05::1'), true);

  // Trailing-dot FQDN form — `localhost.` is resolved identically to `localhost`
  // by getaddrinfo, must be refused.
  assert.strictEqual(isPrivateIp('localhost.'), true);
  assert.strictEqual(isPrivateIp('foo.local.'), true);

  // Regression: hostnames starting with "fc" must NOT be classified as IPv6 ULA
  // (the old check did `h.startsWith('fc')` which caught textual hostnames too).
  assert.strictEqual(isPrivateIp('fcafe.example.com'), false);
  assert.strictEqual(isPrivateIp('fdtest.example.com'), false);
});

test('validateUrl refuses encoded loopback variants (Reviewer A B1 regression)', () => {
  // These all resolve to 127.0.0.1 via getaddrinfo on POSIX — must be refused
  // BEFORE the HTTP request even starts.
  assert.throws(() => validateUrl('http://2130706433/'));
  assert.throws(() => validateUrl('http://0x7f000001/'));
  assert.throws(() => validateUrl('http://0177.0.0.1/'));
  assert.throws(() => validateUrl('http://[::ffff:127.0.0.1]/'));
  // Trailing-dot FQDN form + IPv6 site-local + multicast (Reviewer A pass 2).
  assert.throws(() => validateUrl('http://localhost./'));
  assert.throws(() => validateUrl('http://[fec0::1]/'));
  assert.throws(() => validateUrl('http://[ff02::1]/'));
});

test('validateUrl refuses non-http(s) and private hosts', () => {
  // Allowed
  assert.doesNotThrow(() => validateUrl('https://example.com/'));
  assert.doesNotThrow(() => validateUrl('http://example.com/'));
  // Wrong scheme
  assert.throws(() => validateUrl('file:///etc/passwd'));
  assert.throws(() => validateUrl('ssh://server'));
  // Private hosts — SSRF guard
  assert.throws(() => validateUrl('http://127.0.0.1/'));
  assert.throws(() => validateUrl('http://localhost/'));
  assert.throws(() => validateUrl('http://192.168.1.1/'));
  assert.throws(() => validateUrl('http://10.0.0.1/'));
});

test('validateBranchName refuses leading hyphen and special chars (Reviewer A N8)', () => {
  // Allowed
  assert.doesNotThrow(() => validateBranchName('main'));
  assert.doesNotThrow(() => validateBranchName('v1.2.3'));
  assert.doesNotThrow(() => validateBranchName('release/2026.05'));
  assert.doesNotThrow(() => validateBranchName('feat_xyz'));
  assert.doesNotThrow(() => validateBranchName(undefined));
  assert.doesNotThrow(() => validateBranchName(null));
  // Rejected — leading `-` would be re-interpreted as a CLI flag by repomix
  assert.throws(() => validateBranchName('-rf'));
  assert.throws(() => validateBranchName('--config'));
  // Rejected — shell metacharacters
  assert.throws(() => validateBranchName('main; rm -rf /'));
  assert.throws(() => validateBranchName('main$(whoami)'));
  assert.throws(() => validateBranchName('main\nrm'));
  assert.throws(() => validateBranchName(''));
  assert.throws(() => validateBranchName(123));
});

test('validateRepoUrl accepts shorthand and http(s) only', () => {
  // Shorthand
  assert.doesNotThrow(() => validateRepoUrl('zcaceres/markdownify-mcp'));
  assert.doesNotThrow(() => validateRepoUrl('owner/repo'));
  assert.doesNotThrow(() => validateRepoUrl('owner.dot/repo.dot'));
  // Full URL
  assert.doesNotThrow(() => validateRepoUrl('https://github.com/owner/repo'));
  assert.doesNotThrow(() => validateRepoUrl('http://github.com/owner/repo'));
  // Rejected
  assert.throws(() => validateRepoUrl(''));
  assert.throws(() => validateRepoUrl('   '));
  assert.throws(() => validateRepoUrl('git@github.com:owner/repo.git')); // ssh-like
  assert.throws(() => validateRepoUrl('file:///local/repo'));
  assert.throws(() => validateRepoUrl('ssh://git@host/repo'));
});

test('validateRepoUrl refuses private/loopback hosts (codex pass-1 finding)', () => {
  // Full-URL form must run through the SSRF guard. Codex flagged these as
  // permissively accepted in pass 1 — an MCP user could ask Claude to
  // "convert http://169.254.169.254/" and reach the AWS metadata endpoint.
  assert.throws(() => validateRepoUrl('http://127.0.0.1/repo.git'));
  assert.throws(() => validateRepoUrl('http://[::1]/repo.git'));
  assert.throws(() => validateRepoUrl('http://169.254.169.254/latest'));
  assert.throws(() => validateRepoUrl('http://10.0.0.1/repo'));
  assert.throws(() => validateRepoUrl('http://192.168.1.1/repo'));
  assert.throws(() => validateRepoUrl('http://localhost/repo'));
});

test('isUnconvertedHtml detects raw HTML payloads', () => {
  assert.strictEqual(isUnconvertedHtml('<!DOCTYPE html>'), true);
  assert.strictEqual(isUnconvertedHtml('<!doctype html>'), true);
  assert.strictEqual(isUnconvertedHtml('  <html>...'), true);
  assert.strictEqual(isUnconvertedHtml('# Heading\n\nText'), false);
  assert.strictEqual(isUnconvertedHtml(''), false);
  // bug_017 from /ultrareview — uppercase `<HTML>` (legacy CMSs, Office HTML
  // export, hand-written HTML) MUST also be caught.
  assert.strictEqual(isUnconvertedHtml('<HTML lang="en">'), true);
  assert.strictEqual(isUnconvertedHtml('<Html>...'), true);
  assert.strictEqual(isUnconvertedHtml('<HTML>...</HTML>'), true);
});

test('inferExtensionFromUrl distinguishes PDF from HTML', () => {
  assert.strictEqual(inferExtensionFromUrl('https://example.com/doc.pdf'), 'pdf');
  assert.strictEqual(inferExtensionFromUrl('https://example.com/Doc.PDF'), 'pdf');
  assert.strictEqual(inferExtensionFromUrl('https://example.com/page'), 'html');
  assert.strictEqual(inferExtensionFromUrl('https://example.com/page.html'), 'html');
  // bug_002 from /ultrareview — PDF URLs with query/fragment (signed S3,
  // Google Drive download, page bookmarks) MUST resolve as 'pdf', not fall
  // through to 'html'.
  assert.strictEqual(
    inferExtensionFromUrl('https://files.s3.amazonaws.com/doc.pdf?X-Amz-Signature=abc'),
    'pdf',
  );
  assert.strictEqual(
    inferExtensionFromUrl('https://drive.google.com/file/d/abc/view.pdf?export=download'),
    'pdf',
  );
  assert.strictEqual(inferExtensionFromUrl('https://example.com/doc.pdf#page=5'), 'pdf');
  assert.strictEqual(inferExtensionFromUrl('https://example.com/doc.pdf?utm_source=x'), 'pdf');
  // Non-PDF with .pdf in query string MUST NOT misdetect as PDF.
  assert.strictEqual(inferExtensionFromUrl('https://example.com/page?file=doc.pdf'), 'html');
});

test('resolveAndAssertPublic short-circuits IP literals (bug_013/_018 follow-up)', async () => {
  // IP literal that's public — no DNS round-trip needed.
  const pub = await resolveAndAssertPublic('8.8.8.8');
  assert.strictEqual(pub.address, '8.8.8.8');
  assert.strictEqual(pub.family, 4);

  // Bracketed IPv6 literal — strip brackets, short-circuit.
  const pubV6 = await resolveAndAssertPublic('[2001:4860:4860::8888]');
  assert.strictEqual(pubV6.address, '2001:4860:4860::8888');
  assert.strictEqual(pubV6.family, 6);

  // Private IP literal — refused.
  await assert.rejects(
    () => resolveAndAssertPublic('127.0.0.1'),
    /private\/loopback/,
  );
  // Bracketed loopback IPv6 — refused (bug_013 regression: pre-v0.11.1 the
  // bracketed form bypassed dns.lookup and produced a misleading error).
  await assert.rejects(
    () => resolveAndAssertPublic('[::1]'),
    /private\/loopback/,
  );
});

test('resolveRepomixCommand uses node-direct on Windows (bug_003)', () => {
  // On any platform, with REPOMIX_PATH env set, override wins.
  const old = process.env.REPOMIX_PATH;
  try {
    process.env.REPOMIX_PATH = '/custom/repomix';
    const r = resolveRepomixCommand('/whatever');
    assert.strictEqual(r.cmd, '/custom/repomix');
    assert.deepStrictEqual(r.prefixArgs, []);
  } finally {
    if (old !== undefined) process.env.REPOMIX_PATH = old;
    else delete process.env.REPOMIX_PATH;
  }
  // Without REPOMIX_PATH: result is at minimum a { cmd, prefixArgs } shape.
  // We can't easily assert the Windows-specific node-direct path here without
  // an installed repomix on disk, but we can guarantee the shape.
  const r = resolveRepomixCommand(process.cwd());
  assert.ok(typeof r.cmd === 'string' && r.cmd.length > 0);
  assert.ok(Array.isArray(r.prefixArgs));
});

test('assertSandboxConsistent refuses READONLY without MD_ALLOWED_PATHS (bug_015)', () => {
  // Baseline: single-user, no env vars set → no constraint.
  assert.doesNotThrow(() => assertSandboxConsistent({}));
  // READONLY set, MD_ALLOWED_PATHS missing → refuse.
  assert.throws(
    () => assertSandboxConsistent({ OBSIDIAN_ROUTER_READONLY: 'true' }),
    /MD_ALLOWED_PATHS is unset/,
  );
  // READONLY set + sandbox set → allow.
  assert.doesNotThrow(() =>
    assertSandboxConsistent({
      OBSIDIAN_ROUTER_READONLY: 'true',
      MD_ALLOWED_PATHS: '/data/ingest',
    }),
  );
  // ALLOWED_VAULTS set, sandbox missing → refuse (multi-tenant w/o sandbox is unsafe).
  assert.throws(
    () => assertSandboxConsistent({ OBSIDIAN_ROUTER_ALLOWED_VAULTS: 'a,b' }),
    /MD_ALLOWED_PATHS is unset/,
  );
  // USER_ID set, sandbox missing → refuse.
  assert.throws(
    () => assertSandboxConsistent({ OBSIDIAN_ROUTER_USER_ID: 'roland' }),
    /MD_ALLOWED_PATHS is unset/,
  );
  // MD_SHARE_DIR legacy alias also satisfies the sandbox requirement.
  assert.doesNotThrow(() =>
    assertSandboxConsistent({
      OBSIDIAN_ROUTER_READONLY: 'true',
      MD_SHARE_DIR: '/data/ingest',
    }),
  );
  // READONLY=false (env var present but truthy=false) → no constraint.
  assert.doesNotThrow(() =>
    assertSandboxConsistent({ OBSIDIAN_ROUTER_READONLY: 'false' }),
  );
});

test('isWithinDirectory uses path-segment comparison (no naive prefix)', () => {
  // /data/foobar is NOT inside /data/foo
  assert.strictEqual(isWithinDirectory('/data/foobar/x', '/data/foo'), false);
  // /data/foo/x IS inside /data/foo
  assert.strictEqual(isWithinDirectory('/data/foo/x', '/data/foo'), true);
  // Identity
  assert.strictEqual(isWithinDirectory('/data/foo', '/data/foo'), true);
  // Escape attempt
  assert.strictEqual(isWithinDirectory('/data/../etc/passwd', '/data'), false);
});

test('MD_ALLOWED_PATHS sandbox is opt-in', () => {
  const old = process.env.MD_ALLOWED_PATHS;
  try {
    delete process.env.MD_ALLOWED_PATHS;
    delete process.env.MD_SHARE_DIR;
    assert.strictEqual(getAllowedPaths(), null);
    // No-op when unset
    assert.doesNotThrow(() => assertPathAllowed('/anywhere'));
  } finally {
    if (old !== undefined) process.env.MD_ALLOWED_PATHS = old;
  }
});

test('MD_ALLOWED_PATHS rejects paths outside the sandbox', () => {
  const old = process.env.MD_ALLOWED_PATHS;
  try {
    // Set a sandbox that the test path will/won't be inside.
    process.env.MD_ALLOWED_PATHS = '/sandbox/in';
    assert.throws(() => assertPathAllowed('/sandbox/out/file.pdf'));
    assert.doesNotThrow(() => assertPathAllowed('/sandbox/in/file.pdf'));
  } finally {
    if (old !== undefined) process.env.MD_ALLOWED_PATHS = old;
    else delete process.env.MD_ALLOWED_PATHS;
  }
});

test('all 10 conversion tools are registered in TOOLS array', () => {
  const advertised = _internals.TOOLS.map((t) => t.name);
  for (const name of CONVERSION_TOOLS) {
    assert.ok(advertised.includes(name), `Missing TOOLS entry: ${name}`);
  }
});

test('all 10 conversion tools have a handler in TOOL_HANDLERS', () => {
  for (const name of CONVERSION_TOOLS) {
    assert.strictEqual(
      typeof _internals.TOOL_HANDLERS[name],
      'function',
      `Missing handler for: ${name}`,
    );
  }
});

test('conversion tools are NOT in WRITE_TOOL_NAMES (readonly mode keeps them)', () => {
  for (const name of CONVERSION_TOOLS) {
    assert.strictEqual(
      _internals.WRITE_TOOL_NAMES.has(name),
      false,
      `${name} should not be classified as a write tool — it doesn't touch any vault`,
    );
  }
});

test('convert.mjs handlers reject missing required args (Reviewer A I5)', async () => {
  // File-input handlers — must throw "Missing required argument: filepath"
  // BEFORE attempting any markitdown subprocess (so they fail cleanly even
  // without Python installed).
  await assert.rejects(() => pdfToMarkdown(null, {}), /Missing required argument: filepath/);
  await assert.rejects(() => docxToMarkdown(null, {}), /Missing required argument: filepath/);
  await assert.rejects(() => xlsxToMarkdown(null, {}), /Missing required argument: filepath/);
  await assert.rejects(() => pptxToMarkdown(null, {}), /Missing required argument: filepath/);
  await assert.rejects(() => imageToMarkdown(null, {}), /Missing required argument: filepath/);
  await assert.rejects(() => audioToMarkdown(null, {}), /Missing required argument: filepath/);
  await assert.rejects(() => pdfToMarkdown(null, { filepath: '' }), /Missing required argument: filepath/);

  // URL-input handlers — same shape for the url argument.
  await assert.rejects(() => youtubeToMarkdown(null, {}), /Missing required argument: url/);
  await assert.rejects(() => bingSearchToMarkdown(null, {}), /Missing required argument: url/);
  await assert.rejects(() => webpageToMarkdown(null, {}), /Missing required argument: url/);
  await assert.rejects(() => webpageToMarkdown(null, { url: '' }), /Missing required argument: url/);

  // Git repo handler — same.
  await assert.rejects(() => gitRepoToMarkdown(null, {}), /Missing required argument: url/);
});

test('conversion tool schemas have the expected required fields', () => {
  const byName = Object.fromEntries(
    _internals.TOOLS.map((t) => [t.name, t]),
  );
  // URL-input tools
  for (const name of ['youtube_to_markdown', 'bing_search_to_markdown', 'webpage_to_markdown']) {
    assert.deepStrictEqual(byName[name].inputSchema.required, ['url']);
  }
  // File-input tools
  for (const name of [
    'pdf_to_markdown',
    'docx_to_markdown',
    'xlsx_to_markdown',
    'pptx_to_markdown',
    'image_to_markdown',
    'audio_to_markdown',
  ]) {
    assert.deepStrictEqual(byName[name].inputSchema.required, ['filepath']);
  }
  // Git repo tool
  assert.deepStrictEqual(byName.git_repo_to_markdown.inputSchema.required, ['url']);
});
