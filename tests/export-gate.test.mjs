/**
 * export-gate.test.mjs — C9's three named tests, plus the ones that keep the
 * gate honest about itself.
 *
 * §2.17 asks for exactly three proofs:
 *   1. the scan catches EVERY leak category — one dedicated fixture each;
 *   2. two builds of the same input are identical byte for byte;
 *   3. the audit detects an altered artifact.
 *
 * Everything else here exists because a gate that reports "clean" while doing
 * nothing looks identical to a gate that works. So each category fixture is
 * paired with its inverse (fix the fixture, the finding disappears), the
 * category list is asserted to be exhaustively covered rather than
 * hand-counted, and the live repo is asserted to pass — so a dependency
 * upgrade that introduces a new finding turns the suite red instead of
 * quietly widening what ships.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  LEAK_CATEGORIES,
  CHECKSUM_FILE,
  MANIFEST_FILE,
  compileAllowPattern,
  isCatchAllPattern,
  applyAllowlist,
  scanEntry,
  scanEntries,
  gateFileSet,
  gateDirectory,
  buildChecksums,
  parseChecksums,
  buildGateManifest,
  serializeManifest,
  createDeterministicZip,
  readZipDirectory,
  readZipEntryContent,
  compareLocalHeader,
  auditArchive,
  looksLikeLiveCredential,
  isPlaceholderIdentifier,
  shannonEntropy,
  looksBinary,
  decodeForScan,
  sha256,
} from '../src/helpers/export-gate.mjs';
import { normalizeZipEntryName, DOS_EPOCH_DATE } from '../src/helpers/deterministic-zip.mjs';
import { buildOkfBundle } from '../src/helpers/okf-bundle-exporter.mjs';
import { checkOkfConformance } from '../src/helpers/okf-conformance-checker.mjs';
import { readContract, collectPrivateRoots } from '../scripts/export-gate.mjs';
import { stageAuthoredFiles, buildMcphubManifest } from '../scripts/build-mcpb.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Credential-shaped strings are ASSEMBLED at runtime, never written literally.
// A test file that spells out the patterns the scanner hunts for would make
// the scanner fire on the test file — the same self-reference trap the gate's
// own source comments avoid.
const AKIA = `AKIA${'Q'.repeat(4)}7EXAMPLE${'X'.repeat(4)}`;
// A high-entropy value that must READ as live. Assembled, never written
// literally: gitleaks' generic-api-key rule scans staged changes and flagged
// the literal form at entropy 4.32 — correctly, by its own lights. Both tools
// are right; this one keeps the fixture out of the diff.
const LIVE_TOKEN = ['rT8kZ2mQ', '7xW4pL9n', 'B3vC6yH1', 'jF5sD0gA'].join('');
const PEM_OPEN = `${'-'.repeat(5)}BEGIN PRIVATE KEY${'-'.repeat(5)}`;

// ---------------------------------------------------------------------------
// §2.17 test 1 — one fixture per leak category
// ---------------------------------------------------------------------------

/**
 * One entry per category, each paired with the CLEAN version of the same file.
 * The clean twin is what proves the rule discriminates: a rule that matched
 * everything would pass the dirty case and fail the clean one.
 */
const CATEGORY_FIXTURES = {
  secret: {
    dirty: { path: 'config/app.js', content: `const awsKey = "${AKIA}";\n` },
    clean: { path: 'config/app.js', content: 'const awsKey = process.env.AWS_ACCESS_KEY_ID;\n' },
  },
  'personal-email': {
    dirty: { path: 'docs/contact.md', content: 'Ping roland.doe@gmail.com if it breaks.\n' },
    clean: { path: 'docs/contact.md', content: 'Ping maintainer@example.com if it breaks.\n' },
  },
  'private-path': {
    dirty: { path: 'README.md', content: 'The vault lives at C:\\Users\\jdoe42\\VAULTS\\notes.\n' },
    clean: { path: 'README.md', content: 'The vault lives at C:\\Users\\me\\VAULTS\\notes.\n' },
  },
  symlink: {
    dirty: { path: 'lib/link.mjs', isSymlink: true, linkTarget: '../../../etc/passwd' },
    clean: { path: 'lib/link.mjs', content: 'export const x = 1;\n' },
  },
  'path-traversal': {
    dirty: { path: '../../etc/passwd', content: 'root:x:0:0\n' },
    clean: { path: 'etc/passwd', content: 'root:x:0:0\n' },
  },
};

describe('C9 · the scan catches every leak category', () => {
  test('every declared category has a dedicated fixture', () => {
    // Mechanical, not hand-counted: adding a category to LEAK_CATEGORIES
    // without a fixture fails here rather than shipping an untested rule.
    assert.deepEqual(
      [...LEAK_CATEGORIES].sort(),
      Object.keys(CATEGORY_FIXTURES).sort(),
      'LEAK_CATEGORIES and CATEGORY_FIXTURES must cover exactly the same set',
    );
  });

  for (const category of LEAK_CATEGORIES) {
    test(`${category}: the dirty fixture is caught`, () => {
      const findings = scanEntry(CATEGORY_FIXTURES[category].dirty);
      const hit = findings.filter((f) => f.category === category);
      assert.ok(hit.length > 0, `expected a ${category} finding, got ${JSON.stringify(findings)}`);
    });

    test(`${category}: the clean twin produces nothing (the rule discriminates)`, () => {
      const findings = scanEntry(CATEGORY_FIXTURES[category].clean);
      const hit = findings.filter((f) => f.category === category);
      assert.equal(hit.length, 0, `clean fixture produced ${category}: ${JSON.stringify(hit)}`);
    });
  }

  test('a scan over all dirty fixtures at once reports every category', () => {
    const result = scanEntries(Object.values(CATEGORY_FIXTURES).map((f) => f.dirty));
    assert.equal(result.ok, false);
    for (const c of LEAK_CATEGORIES) {
      assert.ok(result.byCategory[c] > 0, `category ${c} missing from the aggregate scan`);
    }
  });

  test('a scan over all clean fixtures is completely silent', () => {
    const result = scanEntries(Object.values(CATEGORY_FIXTURES).map((f) => f.clean));
    assert.equal(result.ok, true, `expected silence, got ${JSON.stringify(result.findings)}`);
  });
});

describe('C9 · secret rules, in both directions', () => {
  test('catches the shaped credential formats', () => {
    const shaped = [
      `${PEM_OPEN}\nMIIEv...\n`,
      `token=gh${'p'}_${'A1b2C3d4E5'.repeat(4)}`,
      `key: sk-ant-${'a1B2c3D4'.repeat(4)}`,
      `AIza${'B'}${'c'.repeat(34)}`,
    ];
    for (const content of shaped) {
      const f = scanEntry({ path: 'x.txt', content }).filter((x) => x.category === 'secret');
      assert.ok(f.length > 0, `not caught: ${content.slice(0, 40)}`);
    }
  });

  test('never echoes the secret it found, and reveals little of a short one', () => {
    const f = scanEntry({ path: 'x.txt', content: `k = "${AKIA}"` });
    assert.ok(f.length > 0);
    for (const finding of f) {
      assert.ok(!String(finding.evidence).includes(AKIA),
        'the finding must not reproduce the credential verbatim');
    }
    // The old redaction revealed a 4-char prefix and 2-char suffix regardless
    // of length — half of a 12-character secret, in a CI log. Below 24
    // characters nothing is revealed at all.
    const short = scanEntry({ path: 'x.txt', content: 'client_secret = "aB3$xY9!qW2z"' });
    for (const finding of short) {
      assert.equal(/aB3|qW2z/.test(String(finding.evidence)), false,
        `short credential partially echoed: ${finding.evidence}`);
    }
  });

  test('placeholders and expressions are not credentials', () => {
    for (const v of ['<password>', '${MY_TOKEN}', '%USERPROFILE%', 'changeme', 'your-api-key',
      'xxxxxxxxxxxxxx', '[type=password]', 'https://example.com/x', './relative/path',
      'aaaaaaaaaaaaaaaa']) {
      assert.equal(looksLikeLiveCredential(v), false, `${v} should not read as live`);
    }
  });

  test('a high-entropy opaque blob assigned to a credential key IS live', () => {
    assert.equal(looksLikeLiveCredential(LIVE_TOKEN), true);
  });

  test('entropy is measured, not guessed', () => {
    assert.equal(shannonEntropy(''), 0);
    assert.equal(shannonEntropy('aaaa'), 0);
    assert.ok(shannonEntropy('abcd') > 1.9);
  });

  test('DELIBERATE LIMIT: the generic credential rule does not run over vendored files', () => {
    // This is a documented trade-off, NOT a correctness property — the name of
    // this test says so, because the previous name ("does not run", framed as
    // a regression guard) read as an assertion that the blind spot is right.
    //
    // The trade-off: hono, undici and css-select each ship a documentation
    // string that trips the generic rule, and running it over ~9,300 vendored
    // files would create a permanent list of muted findings, which is how a
    // scanner stops being read. The COST is real and stated in
    // docs/export-gate.md: an unshaped credential inside a dependency is not
    // caught. If that trade ever stops being worth it, delete this test.
    const entry = { path: 'node_modules/x/doc.md', content: `secret: '${LIVE_TOKEN}'\n`, zone: 'vendored' };
    assert.equal(scanEntry(entry).filter((f) => f.rule === 'assigned-credential').length, 0);
    // The same content in the authored zone IS caught — the limit is scoped to
    // the vendored tree and has not quietly become global.
    assert.ok(scanEntry({ ...entry, path: 'src/doc.md', zone: 'authored' })
      .some((f) => f.rule === 'assigned-credential'));
  });

  test('but the SHAPED rules still run over vendored files', () => {
    const entry = { path: 'node_modules/x/leak.js', content: `const k="${AKIA}"`, zone: 'vendored' };
    const findings = scanEntry(entry).filter((f) => f.category === 'secret');
    assert.ok(findings.length > 0, 'a real AWS key inside a dependency must still be caught');
  });
});

describe('C9 · private paths distinguish a leak from a documented example', () => {
  test('conventional stand-ins are recognised', () => {
    // `alice` and `server` are in this list as a DELIBERATE trade-off, not as
    // a claim that nobody is called alice: they are the canonical stand-ins in
    // this repo's own documentation, and treating them as real would make the
    // gate cry on its own examples. The cost — a real account named `alice`
    // goes unreported by the STRUCTURAL rules — is bounded, because the
    // `configured-private-root` rule below matches the machine's actual paths
    // regardless of the account name, and that is the rule that catches a real
    // leak with certainty.
    for (const v of ['me', 'user', 'USER', '<user>', '${USER}', '%USERNAME%', '...', 'alice', 'server']) {
      assert.equal(isPlaceholderIdentifier(v), true, `${v} should read as a placeholder`);
    }
  });

  test('the placeholder set does not weaken the rule that has certainty', () => {
    // Even for a name the placeholder set accepts, a path under the machine's
    // real root is still caught — so the trade-off above cannot hide an actual
    // private path.
    const f = scanEntry(
      { path: 'note.md', content: 'C:\\Users\\alice\\VAULTS\\notes' },
      { privatePathRoots: ['C:\\Users\\alice'] },
    );
    assert.ok(f.some((x) => x.rule === 'configured-private-root'));
  });

  test('a real-looking account name is not a stand-in', () => {
    for (const v of ['jdoe42', 'jdoe42', 'tboome33']) {
      assert.equal(isPlaceholderIdentifier(v), false, `${v} should NOT read as a placeholder`);
    }
  });

  test('the configured-root rule catches what the heuristics cannot', () => {
    // `C:\VAULTS\...` matches no structural home-directory shape; only the
    // caller-supplied root finds it. That is why the machine's real roots are
    // injected at call time and never committed.
    const f = scanEntry(
      { path: 'note.md', content: 'see C:\\VAULTS\\my vault\\wiki\\x.md' },
      { privatePathRoots: ['C:\\VAULTS'] },
    );
    assert.ok(f.some((x) => x.rule === 'configured-private-root'));
  });

  test('the configured-root rule is case-insensitive and separator-agnostic', () => {
    const f = scanEntry(
      { path: 'note.md', content: 'see c:/vaults/x' },
      { privatePathRoots: ['C:\\VAULTS'] },
    );
    assert.ok(f.some((x) => x.rule === 'configured-private-root'));
  });

  test('REGRESSION: a private root written in a JS/JSON string is caught', () => {
    // Inside source, a Windows path is escaped — `"C:\\VAULTS\\notes"` — and a
    // literal search for `C:\VAULTS` never matched it. Every private root
    // quoted in code was invisible to the one rule that has certainty.
    const f = scanEntry(
      { path: 'src/x.mjs', content: 'const p = "C:\\\\VAULTS\\\\notes";' },
      { privatePathRoots: ['C:\\VAULTS'] },
    );
    assert.ok(f.some((x) => x.rule === 'configured-private-root'),
      `escaped form not caught: ${JSON.stringify(f)}`);
  });

  test('REGRESSION: URL userinfo is not a personal address', () => {
    // `https://obsidian:pw@abc.trycloudflare.com/` is a tunnel URL, not an
    // address that reaches anyone — 11 fixtures were reported as leaks.
    for (const url of [
      "const u = 'https://pw@abc.trycloudflare.com/';",
      "url: 'https://obsidian:pw@abc.trycloudflare.com/',",
    ]) {
      assert.equal(scanEntry({ path: 't.mjs', content: url })
        .filter((f) => f.category === 'personal-email').length, 0, url);
    }
    // ...but the suppression must not spill onto a real address that merely
    // appears somewhere after a URL in the same file.
    assert.equal(scanEntry({ path: 't.md', content: 'see https://a.com/ then mail someone.real@gmail.com' })
      .filter((f) => f.category === 'personal-email').length, 1);
    assert.equal(scanEntry({ path: 't.md', content: '[m](mailto:someone.real@gmail.com)' })
      .filter((f) => f.category === 'personal-email').length, 1);
  });

  test('REGRESSION: LaTeX is not a UNC share', () => {
    // `\\frac\{1` in a latex fixture matched the UNC rule.
    assert.equal(scanEntry({ path: 't.mjs', content: 'const s = "\\\\frac\\{1}{2}";' })
      .filter((f) => f.rule === 'unc-share').length, 0);
    // The control: a real UNC path is still caught.
    assert.equal(scanEntry({ path: 't.md', content: 'copy from \\\\fileserver01\\projects' })
      .filter((f) => f.rule === 'unc-share').length, 1);
  });

  test('REGRESSION: a Windows path in a JS string does not swallow the account name', () => {
    // The capture class allowed backslashes, so `/home/u\\.claude\\plugins`
    // captured `u\.claude\plugins` as the "account" and the placeholder check
    // for `u` never applied.
    assert.equal(scanEntry({ path: 't.mjs', content: 'const p = "/home/u\\\\.claude\\\\plugins";' })
      .filter((f) => f.category === 'private-path').length, 0);
    assert.equal(scanEntry({ path: 't.mjs', content: 'const p = "/home/realperson\\\\.claude";' })
      .filter((f) => f.category === 'private-path').length, 1);
  });

  test('REGRESSION: a markdown-escaped backslash pair is not a UNC share', () => {
    // `\\host.md\`` inside a template literal used to match the UNC rule and
    // produced three findings in hooks/wiki-query-first-nudge.mjs alone.
    const f = scanEntry({ path: 'h.mjs', content: 'const s = `see \\\\host.md\\` now`;' });
    assert.equal(f.filter((x) => x.rule === 'unc-share').length, 0);
  });
});

describe('C9 · e-mail rules', () => {
  test('reserved and noreply domains are not personal addresses', () => {
    // `b@test` and `c@invalid` used to be in this fixture, but EMAIL_RE needs
    // a dotted TLD and never matched them — so they were silenced by the
    // regex, not by the reserved-domain rule this test claims to exercise.
    // Sub-domained forms actually reach the rule.
    const content = 'a@example.com b@sub.test c@sub.invalid d@users.noreply.github.com';
    const f = scanEntry({ path: 'x.md', content }).filter((x) => x.category === 'personal-email');
    assert.equal(f.length, 0, JSON.stringify(f));
    for (const addr of ['a@example.com', 'b@sub.test', 'c@sub.invalid', 'd@users.noreply.github.com']) {
      assert.match(addr, /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,24}\b/,
        `${addr} must actually reach the reserved-domain rule, or it proves nothing`);
    }
    // and the control: a real address is still caught
    assert.equal(scanEntry({ path: 'x.md', content: 'e@gmail.com' })
      .filter((x) => x.category === 'personal-email').length, 1);
  });

  test('the contract allowlist silences a named address', () => {
    const entry = { path: 'x.md', content: 'clone from git@github.com:org/repo.git' };
    assert.equal(scanEntry(entry).filter((f) => f.category === 'personal-email').length, 1);
    assert.equal(
      scanEntry(entry, { emailAllowlist: ['git@github.com'] })
        .filter((f) => f.category === 'personal-email').length,
      0,
    );
  });
});

describe('C9 · binary files are skipped by the text rules', () => {
  test('a NUL byte in the first 8 KiB marks a buffer binary', () => {
    assert.equal(looksBinary(Buffer.from([0x89, 0x50, 0x00, 0x01])), true);
    assert.equal(looksBinary(Buffer.from('plain text')), false);
  });

  test('REGRESSION: a NUL byte no longer exempts a file from every content rule', () => {
    // This test used to assert the OPPOSITE — that a credential hidden behind
    // a leading NUL must not be reported — and so pinned the blind spot in
    // place. One NUL in the first 8 KiB silenced every text rule, which meant
    // a UTF-16 file (what "Save as Unicode" and PowerShell 5.1's `>` produce,
    // plainly readable ASCII to a human) shipped completely unscanned.
    const buf = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(`k="${AKIA}"`)]);
    assert.ok(scanEntry({ path: 'x.bin', content: buf }).some((f) => f.category === 'secret'),
      'printable ASCII inside binary content must still be scanned');
  });

  test('REGRESSION: UTF-16 is decoded and scanned in EVERY shape, not just the tidy one', () => {
    // Round 1's fixture was the one UTF-16 shape that worked: LE, even length,
    // no stray NUL. The detector demanded an EXACT-ZERO NUL count at the other
    // parity, so two extra bytes — a terminator, a pad, a U+0000 in the text —
    // dropped the file into the binary branch, where UTF-16 ASCII yields
    // printable runs of ONE byte and the >=8 threshold discarded all of them.
    // Zero findings, `ok: true`, exactly the hole the fix was written to close.
    const payload = `AWS_KEY = "${AKIA}"\ncontact jdoe42.real@gmail.com\n`;
    const le = Buffer.from(payload, 'utf16le');
    const beRaw = Buffer.from(le); beRaw.swap16();

    const shapes = {
      'utf16le plain': le,
      'utf16le + BOM': Buffer.concat([Buffer.from([0xff, 0xfe]), le]),
      'utf16le + 2 leading NULs': Buffer.concat([Buffer.from([0x00, 0x00]), le]),
      'utf16le + trailing NUL pair': Buffer.concat([le, Buffer.from([0x00, 0x00])]),
      'utf16le + interior NUL char': Buffer.concat([le.subarray(0, 20), Buffer.from([0x00, 0x00]), le.subarray(20)]),
      'utf16be + BOM': Buffer.concat([Buffer.from([0xfe, 0xff]), beRaw]),
    };
    for (const [label, buf] of Object.entries(shapes)) {
      assert.equal(decodeForScan(buf).kind, 'utf16', `${label}: not detected as UTF-16`);
      const findings = scanEntry({ path: 'templates/config.md', content: buf });
      assert.ok(findings.some((f) => f.category === 'secret'), `${label}: secret missed`);
      assert.ok(findings.some((f) => f.category === 'personal-email'), `${label}: e-mail missed`);
    }
  });

  test('REGRESSION (round 2): an odd-length UTF-16BE buffer does not crash the gate', () => {
    // `swap16()` throws on an odd length. A BE file with one byte of slack (a
    // truncated write, a trailing newline) took down `npm run gate`, the build
    // and the release with an unattributable RangeError.
    const be = Buffer.from('hello world, nothing secret here', 'utf16le');
    be.swap16();
    const odd = Buffer.concat([Buffer.from([0xfe, 0xff]), be, Buffer.from([0x0a])]);
    assert.equal(odd.length % 2, 1, 'fixture must be odd-length');
    assert.doesNotThrow(() => decodeForScan(odd));
    assert.doesNotThrow(() => scanEntry({ path: 'templates/note.md', content: odd }));
  });

  test('an unreadable file is COUNTED, and the count reaches the operator', () => {
    // This test used to assert only the counter's value while its title
    // claimed a verdict ("not as clean") the code did not deliver — and the
    // counter it checked had no consumer anywhere, the same dead-mechanism
    // defect as the `scanKindOut` it replaced. Assert the tally AND that a
    // real surface prints it.
    const blob = Buffer.alloc(2000);
    assert.equal(decodeForScan(blob).kind, 'binary-unscannable');
    const result = scanEntries([{ path: 'x.bin', content: blob }]);
    assert.equal(result.scanKinds['binary-unscannable'], 1);

    const cli = execFileSync('node', ['scripts/export-gate.mjs', 'scan', 'release'],
      { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.match(cli, /read as: /,
      'the CLI must print how much was actually read, or the counter is dead again');
  });

  test('UTF-16 is decoded whatever the ALPHABET, not only when it is ASCII', () => {
    // The round-2 fixture set was six shapes of ASCII-dominant UTF-16, and the
    // detector keyed on NUL parity — so a note in Japanese or Russian, which
    // has NULs in neither position, was scanned as the empty string and
    // reported clean. UTF-32 was missed for the same reason.
    const secret = `AWS=${AKIA}  mail someone.real@gmail.com`;
    const u16 = (text, swap) => { const b = Buffer.from(text, 'utf16le'); if (swap) b.swap16(); return b; };
    const shapes = {
      'utf16le ASCII': u16(secret, false),
      'utf16le Japanese': u16(`メモ帳のノートです。\n`.repeat(20) + secret, false),
      'utf16le Russian': u16(`Заметка о проекте.\n`.repeat(20) + secret, false),
      'utf16be ASCII, no BOM': u16(secret, true),
      'utf16be Japanese, no BOM': u16(`メモ帳のノート\n`.repeat(20) + secret, true),
      'utf16be with BOM': Buffer.concat([Buffer.from([0xfe, 0xff]), u16(secret, true)]),
      'utf32le': Buffer.from(new Uint8Array([...secret].flatMap((c) => [c.charCodeAt(0), 0, 0, 0]))),
    };
    for (const [label, buf] of Object.entries(shapes)) {
      const findings = scanEntry({ path: 'src/note.md', content: buf });
      assert.ok(findings.some((f) => f.category === 'secret'), `${label}: secret missed`);
      assert.ok(findings.some((f) => f.category === 'personal-email'), `${label}: e-mail missed`);
    }
    // The control: genuine binary must NOT become a findings generator.
    const noise = Buffer.from(Array.from({ length: 4000 }, (_, i) => (i * 97 + 13) % 256));
    assert.equal(scanEntry({ path: 'a.bin', content: noise }).length, 0);
  });

  test('a genuinely binary asset yields no findings from its byte noise', () => {
    // The other direction: extracting ASCII runs must not turn every PNG into
    // a findings generator.
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(2048)]);
    assert.equal(scanEntry({ path: 'docs/assets/logo.png', content: png }).length, 0);
  });
});

// ---------------------------------------------------------------------------
// Allowlist — a whitelist, and provably not a deny list
// ---------------------------------------------------------------------------

describe('C9 · the allowlist is a whitelist', () => {
  test('an unnamed file is excluded — that is the whole point', () => {
    const { included, excluded } = applyAllowlist(
      ['src/a.mjs', '.codex/config.toml', '.superpowers/notes.md', 'README.md'],
      { authored: ['src/**', 'README.md'] },
    );
    assert.deepEqual(included.map((i) => i.path), ['README.md', 'src/a.mjs']);
    assert.deepEqual(excluded.map((e) => e.path), ['.codex/config.toml', '.superpowers/notes.md']);
  });

  test('REGRESSION: the file that actually leaked is excluded by the contract', () => {
    // .codex/config.toml held a live Authorization bearer token and rode into
    // obsidian-mcp-router-v0.67.1.mcpb because robocopy's deny list predated
    // the directory. Under a whitelist it is excluded by construction.
    const { contract } = readContract(REPO_ROOT);
    const { included, excluded } = applyAllowlist(
      ['.codex/config.toml', '.superpowers/sdd/progress.md', 'src/index.mjs'],
      contract.targets.mcpb.zones,
    );
    assert.deepEqual(included.map((i) => i.path), ['src/index.mjs']);
    assert.equal(excluded.length, 2);
  });

  test('REGRESSION: the template file the deny list wrongly dropped is included', () => {
    // robocopy `/XD .claude` matched that directory name at ANY depth, which
    // silently removed the git-tracked vault-skeleton settings from the bundle.
    const { contract } = readContract(REPO_ROOT);
    const { included } = applyAllowlist(
      ['templates/reference-vault-skeleton/.claude/settings.json'],
      contract.targets.mcpb.zones,
    );
    assert.equal(included.length, 1);
  });

  test('zone order decides, and the first match wins', () => {
    const { included } = applyAllowlist(['node_modules/x/i.js'], {
      authored: ['**'],
      vendored: ['node_modules/**'],
    });
    assert.equal(included[0].zone, 'authored', 'declaration order must be respected');
  });

  test('pattern syntax: `**`, `*` and the trailing-slash shorthand', () => {
    assert.ok(compileAllowPattern('src/**').test('src/a/b/c.mjs'));
    assert.ok(compileAllowPattern('src/').test('src/a/b.mjs'));
    assert.ok(compileAllowPattern('*.md').test('README.md'));
    assert.equal(compileAllowPattern('*.md').test('docs/README.md'), false,
      '`*` must not cross a path separator');
    assert.ok(compileAllowPattern('src/**/*.mjs').test('src/helpers/x.mjs'));
  });

  test('a pattern with a leading slash is refused rather than silently ignored', () => {
    assert.throws(() => compileAllowPattern('/etc/passwd'), /repo-relative/);
  });

  test('the contract carries no negation syntax — a whitelist with negations is a deny list', () => {
    const { contract } = readContract(REPO_ROOT);
    for (const [name, spec] of Object.entries(contract.targets)) {
      for (const patterns of Object.values(spec.zones)) {
        for (const p of patterns) {
          assert.equal(p.startsWith('!'), false, `${name} declares a negated pattern: ${p}`);
        }
      }
    }
  });
});

describe('C9 · scan exceptions must be justified', () => {
  test('an exception without a written reason is itself a finding', () => {
    const result = scanEntries(
      [CATEGORY_FIXTURES.secret.dirty],
      { exceptions: [{ path: 'config/**', category: 'secret' }] },
    );
    assert.ok(result.findings.some((f) => f.rule === 'invalid-exception'));
  });

  test('BLOCKING REGRESSION: an exception cannot silence the whole scanner', () => {
    // `path`, `category` and `rule` were all optional, so a single entry
    // carrying nothing but a reason suppressed EVERY category on EVERY file —
    // the entire scanner switched off by one well-meaning line.
    const all = Object.values(CATEGORY_FIXTURES).map((f) => f.dirty);
    const result = scanEntries(all, {
      exceptions: [{ reason: 'we reviewed all of this and it is all completely fine, honestly' }],
    });
    assert.equal(result.ok, false, 'a category-less, path-less exception must suppress nothing');
    assert.equal(result.suppressed.length, 0);
    assert.ok(result.findings.some((f) => f.rule === 'invalid-exception'));
  });

  test('BLOCKING REGRESSION (round 2): a catch-all is refused HOWEVER it is spelled', () => {
    // The predecessor tested a bare double-star ONLY, and the guard was a
    // regex over the pattern text. Every other spelling of "everything" passed
    // validation and silenced the category on every file — three contract
    // lines re-opened the hole round 1 had closed. The guard now probes the
    // COMPILED pattern, so it cannot be out-spelled.
    const reason = 'a written reason long enough to clear the twenty-character floor';
    for (const p of ['**', '**/*', '**/**', '**/', '**/*.*', '*/**', '**/**/**']) {
      const result = scanEntries([CATEGORY_FIXTURES.secret.dirty], {
        exceptions: [{ path: p, category: 'secret', reason }],
      });
      assert.equal(result.ok, false, `catch-all ${JSON.stringify(p)} was accepted`);
      assert.equal(result.suppressed.length, 0, `catch-all ${JSON.stringify(p)} suppressed something`);
      assert.ok(result.findings.some((f) => f.rule === 'invalid-exception'),
        `catch-all ${JSON.stringify(p)} was not reported as invalid`);
    }
    // ...while a genuinely scoped pattern still works. The refusal rule is
    // "built only from wildcards", NOT "matches many files" — so this control
    // records what the rule really is, and what it costs: a narrow but
    // wildcard-only pattern is refused too, and a maintainer must name a
    // directory instead. That trade is deliberate (a named directory is
    // auditable; a bare glob is not), and stating it here stops the next
    // reader from mistaking the message for a breadth measurement.
    const scoped = scanEntries([CATEGORY_FIXTURES.secret.dirty], {
      exceptions: [{ path: 'config/**', category: 'secret', reason }],
    });
    assert.equal(scoped.ok, true, 'a scoped exception must still suppress');
    assert.equal(isCatchAllPattern('config/**'), false);
    assert.equal(isCatchAllPattern('**/node_modules/jose/**'), false);
    assert.equal(isCatchAllPattern('*.md'), true,
      'a wildcard-only pattern is refused even though it matches few files — that is the rule');
  });

  test('SEGMENT BOUNDARY (round 2): a vendored exception does not leak onto a lookalike directory', () => {
    // `**` compiled to a bare `.*`, so the exception for `node_modules/jose`
    // also covered `src/evil-node_modules/jose/…` — an AUTHORED file whose
    // whole `secret` category was then muted.
    const { contract } = readContract(REPO_ROOT);
    const opts = { target: 'mcpb', exceptions: contract.scanExceptions || [] };
    const content = `const k = "${AKIA}";\nconst pem = "x";\n`;
    const real = scanEntries([{ path: 'node_modules/@secretlint/x.js', content, zone: 'vendored' }], opts);
    assert.equal(real.ok, true, 'the genuine vendored path must still be excepted');

    for (const p of ['src/evil-node_modules/@secretlint/x.js', 'docs/my_node_modules/@secretlint/x.md', 'NOTnode_modules/@secretlint/x.js']) {
      const fake = scanEntries([{ path: p, content, zone: 'authored' }], opts);
      assert.equal(fake.ok, false, `${p} inherited a vendored exception`);
    }
  });

  test('a malformed exception pattern is reported, not thrown out of the scanner', () => {
    const result = scanEntries([CATEGORY_FIXTURES.secret.dirty], {
      exceptions: [{ path: '/etc/**', category: 'secret', reason: 'a written reason of sufficient length here' }],
    });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((f) => f.rule === 'invalid-exception'));
    assert.ok(result.findings.some((f) => f.category === 'secret'),
      'the real finding must survive alongside the contract complaint');
  });

  test('an exception scoped to targets does not apply to another target', () => {
    // This repo's `tests/**` exception matched a STRANGER's OKF bundle that
    // happened to contain a `tests/` folder: the exporter strips the vault's
    // `wiki/` prefix, so bundle paths look like repo paths.
    const ex = [{
      path: 'tests/**', category: 'secret', rule: 'assigned-credential',
      targets: ['mcpb', 'release'],
      reason: 'a written reason of sufficient length for the validator',
    }];
    const entry = { path: 'tests/x.md', content: 'const apiKey = "SOMETHINGRANDOM123";' };
    assert.equal(scanEntries([entry], { target: 'release', exceptions: ex }).ok, true);
    assert.equal(scanEntries([entry], { target: 'okf', exceptions: ex }).ok, false,
      "another target must not inherit this repo's exception");
  });

  test('traversal and symlinks can never be excepted', () => {
    // Not a judgement about intent: a traversal name or a symlink is a
    // structural property that breaks the consumer's extraction, and no
    // written reason makes it safe.
    for (const category of ['path-traversal', 'symlink']) {
      const result = scanEntries([CATEGORY_FIXTURES[category].dirty], {
        exceptions: [{ path: '**/*', category, reason: 'this has been reviewed and is intentional, truly' }],
      });
      assert.equal(result.ok, false, `${category} must not be suppressible`);
      assert.ok(result.findings.some((f) => f.category === category),
        `the ${category} finding must survive its own exception`);
    }
  });

  test('an exception WITH a reason suppresses and records what it silenced', () => {
    const result = scanEntries(
      [CATEGORY_FIXTURES.secret.dirty],
      { exceptions: [{ path: 'config/**', category: 'secret', reason: 'documented sample key' }] },
    );
    assert.equal(result.ok, true);
    assert.equal(result.suppressed.length, 1);
    assert.equal(result.suppressed[0].reason, 'documented sample key');
  });

  test('an unreasoned exception does not suppress anything either', () => {
    const result = scanEntries(
      [CATEGORY_FIXTURES.secret.dirty],
      { exceptions: [{ path: 'config/**', category: 'secret' }] },
    );
    assert.ok(result.findings.some((f) => f.category === 'secret'),
      'the finding must survive an exception that carries no reason');
  });

  test('every exception in the live contract carries a reason', () => {
    const { contract } = readContract(REPO_ROOT);
    for (const [i, ex] of (contract.scanExceptions || []).entries()) {
      assert.ok(ex.reason && ex.reason.trim().length > 20,
        `scanExceptions[${i}] needs a real written reason`);
    }
  });

  test('exceptions are scoped by package, not by a hashed build filename', () => {
    // A path like node_modules/@secretlint/.../index-Cq-34xZU.js carries a
    // content hash: pinning it means the exception silently stops applying at
    // the next upgrade, and the gate goes red for a reason nobody remembers.
    const { contract } = readContract(REPO_ROOT);
    for (const ex of contract.scanExceptions || []) {
      assert.equal(/-[A-Za-z0-9_-]{8,}\.(?:js|mjs|cjs)/.test(ex.path || ''), false,
        `exception pins a hashed filename: ${ex.path}`);
    }
  });
});

// ---------------------------------------------------------------------------
// §2.17 test 2 — byte-for-byte reproducibility
// ---------------------------------------------------------------------------

describe('C9 · two builds of the same input are byte-identical', () => {
  const entries = [
    { path: 'server/src/b.mjs', content: 'export const b = 2;\n' },
    { path: 'server/src/a.mjs', content: 'export const a = 1;\n' },
    { path: 'manifest.json', content: '{"name":"x"}\n' },
    { path: 'server/big.txt', content: 'compress me '.repeat(500) },
  ];

  // The headline test used to be `zip(entries).equals(zip(entries))` — two
  // calls to a pure function, on the same array, in one process. It passed
  // against a writer stamping real mtimes (DOS time has 2-second resolution),
  // so it could not fail for the reason it existed. Rebuilding the input from
  // scratch, in shuffled order, with freshly-allocated buffers, is the weakest
  // version of the claim that still tests it.
  const rebuildEntries = () => [
    { path: 'server/big.txt', content: Buffer.from('compress me '.repeat(500)) },
    { path: 'manifest.json', content: Buffer.from('{"name":"x"}\n') },
    { path: 'server/src/a.mjs', content: Buffer.from('export const a = 1;\n') },
    { path: 'server/src/b.mjs', content: Buffer.from('export const b = 2;\n') },
  ];

  test('independently constructed inputs zip to the same bytes', () => {
    assert.ok(createDeterministicZip(rebuildEntries()).equals(createDeterministicZip(entries)));
  });

  test('the writer output does not drift with the wall clock', async () => {
    // A real-mtime writer produces different bytes on either side of a DOS
    // 2-second tick. Straddle one rather than trusting that a same-process
    // comparison would notice.
    const before = createDeterministicZip(rebuildEntries());
    await new Promise((r) => setTimeout(r, 2100));
    const after = createDeterministicZip(rebuildEntries());
    assert.ok(before.equals(after), 'bytes changed across a 2.1s gap — a clock leaked into the archive');
  });

  test('entry ORDER in the input does not change the output', () => {
    const shuffled = [entries[2], entries[0], entries[3], entries[1]];
    assert.ok(createDeterministicZip(entries).equals(createDeterministicZip(shuffled)),
      'the writer must sort, not preserve caller order');
  });

  test('every entry carries the frozen DOS epoch, not a real mtime', () => {
    const { entries: read } = readZipDirectory(createDeterministicZip(entries));
    for (const e of read) {
      assert.equal(e.dosDate, DOS_EPOCH_DATE, `${e.name} kept a real date`);
      assert.equal(e.dosTime, 0, `${e.name} kept a real time`);
    }
  });

  test('no entry leaks a host OS, a unix mode or an extra field', () => {
    const { entries: read } = readZipDirectory(createDeterministicZip(entries));
    for (const e of read) {
      assert.equal(e.hostSystem, 0, `${e.name} records host system ${e.hostSystem}`);
      assert.equal(e.externalAttributes, 0, `${e.name} records external attributes`);
      assert.equal(e.extraFieldLength, 0, `${e.name} carries an extra field`);
    }
  });

  test('names are sorted by UTF-8 byte order, including non-ASCII', () => {
    // The old fixture was ASCII-only, where byte order, UTF-16 order and
    // `localeCompare` all agree — so it passed against a locale-sorting
    // writer. `Ørsted` vs `Zebra` is the case that separates them: byte order
    // puts `Z` (0x5A) before `Ø` (0xC3 0x98), Danish collation does not.
    const mixed = [
      { path: 'Ørsted.md', content: 'o' },
      { path: 'Zebra.md', content: 'z' },
      { path: 'apple.md', content: 'a' },
      { path: '日本.md', content: 'j' },
    ];
    const { entries: read } = readZipDirectory(createDeterministicZip(mixed));
    const names = read.map((e) => e.name);
    assert.deepEqual(names, ['Zebra.md', 'apple.md', 'Ørsted.md', '日本.md']);
    assert.notDeepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'da')),
      'fixture must actually distinguish byte order from collation');
  });

  test('the archive round-trips through an INDEPENDENT unzip implementation', () => {
    // Round-tripping through this module's own reader proves nothing about
    // spec-correctness: a writer/reader pair with matching offset bugs passes.
    // PowerShell's Expand-Archive is .NET's ZipFile — a wholly separate
    // implementation.
    const zip = createDeterministicZip(entries);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c9-unzip-'));
    try {
      const archive = path.join(dir, 'probe.zip');
      const out = path.join(dir, 'out');
      fs.writeFileSync(archive, zip);
      execFileSync('powershell', ['-NoProfile', '-Command',
        `Add-Type -AssemblyName System.IO.Compression.FileSystem; `
        + `[System.IO.Compression.ZipFile]::ExtractToDirectory('${archive}','${out}')`],
      { stdio: 'ignore' });
      assert.equal(fs.readFileSync(path.join(out, 'server', 'src', 'a.mjs'), 'utf8'), 'export const a = 1;\n');
      assert.equal(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'), '{"name":"x"}\n');
    } catch (err) {
      if (process.platform !== 'win32') return; // PowerShell/.NET not available
      throw err;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('STORE mode leaves no deflate stream in the archive', () => {
    // The old assertion (`a.equals(b)` twice in one process) passes in DEFLATE
    // mode too, so it tested idempotence, not the zlib-independence claim.
    // What store mode actually guarantees is that no entry is deflated.
    const a = createDeterministicZip(entries, { compression: 'store' });
    const { entries: read } = readZipDirectory(a);
    assert.ok(read.length > 0);
    for (const e of read) assert.equal(e.method, 0, `${e.name} was deflated in store mode`);
    const deflated = createDeterministicZip(entries, { compression: 'deflate' });
    assert.ok(readZipDirectory(deflated).entries.some((e) => e.method === 8),
      'the deflate fixture must actually deflate, or this test compares nothing');
  });

  test('an entry deflate cannot shrink is STORED, not expanded', () => {
    // The previous version of this test was dead code:
    //   `const incompressible = zlib.randomBytes ? null : null;`
    // is `= null` in both branches, and the closing assertion compared it to
    // null. Here is the real case: random bytes, which deflate makes bigger.
    const noise = crypto.randomBytes(4096);
    const { entries: read } = readZipDirectory(createDeterministicZip([{ path: 'noise.bin', content: noise }]));
    assert.equal(read[0].method, 0, 'incompressible data must be stored');
    assert.equal(read[0].compressedSize, noise.length, 'stored size must equal the input size');
    assert.ok(zlib.deflateRawSync(noise, { level: 9 }).length >= noise.length,
      'fixture must actually be incompressible, or this test proves nothing');
  });

  test('the manifest carries no clock, in any encoding', () => {
    const m = buildGateManifest({ target: 'mcpb', productVersion: '1.0.0', entries: [] });
    const text = JSON.stringify(m);
    assert.equal(/\b20\d\d-\d\d-\d\dT/.test(text), false, 'manifest must not embed an ISO timestamp');
    // A unix epoch would have slipped past the ISO-shape check above.
    const now = Date.now();
    for (const value of JSON.stringify(m).match(/\d{10,13}/g) || []) {
      assert.ok(Math.abs(Number(value) - now) > 86_400_000 && Math.abs(Number(value) * 1000 - now) > 86_400_000,
        `manifest embeds ${value}, which is within a day of now — that is a clock`);
    }
    assert.ok('commit' in m.source);
  });

  test('the manifest is rebuilt identically from equal inputs', () => {
    // `serializeManifest(m) === serializeManifest(m)` on ONE object is a
    // tautology: it would pass even if buildGateManifest embedded Date.now(),
    // because the value is already frozen inside `m`. Build it twice.
    const make = () => buildGateManifest({
      target: 'mcpb',
      productVersion: '1.0.0',
      entries: [{ path: 'a', content: 'x' }],
      source: { commit: 'abc', dirty: false },
    });
    assert.equal(serializeManifest(make()), serializeManifest(make()));
    assert.ok(serializeManifest(make()).endsWith('\n'));
  });

  test('duplicate entry names are refused, not silently merged', () => {
    assert.throws(() => createDeterministicZip([
      { path: 'a.txt', content: '1' },
      { path: 'a.txt', content: '2' },
    ]), /duplicate/);
  });
});

describe('C9 · unsafe entry names are refused by the writer, never sanitised', () => {
  for (const bad of ['../escape.txt', '/absolute.txt', 'C:/drive.txt', 'a//b.txt', 'dir/']) {
    test(`refuses ${JSON.stringify(bad)}`, () => {
      assert.throws(() => normalizeZipEntryName(bad));
    });
  }
  test('a backslash is normalised to a forward slash, not rejected', () => {
    assert.equal(normalizeZipEntryName('a\\b.txt'), 'a/b.txt');
  });
  test('quietly rewriting a traversal name would hide the upstream bug', () => {
    assert.throws(() => createDeterministicZip([{ path: '../../etc/passwd', content: 'x' }]),
      /escapes the archive root/);
  });
});

// ---------------------------------------------------------------------------
// §2.17 test 3 — the audit detects an altered artifact
// ---------------------------------------------------------------------------

/** Build a small but complete, gate-shaped archive for the audit tests. */
function buildFixtureArchive({ tamper = null } = {}) {
  const content = [
    { path: 'manifest.json', content: Buffer.from('{"name":"fixture"}\n') },
    { path: 'server/bin/run.mjs', content: Buffer.from('console.log("hi");\n') },
    { path: 'server/src/lib.mjs', content: Buffer.from('export const n = 42;\n') },
  ];
  const checksums = buildChecksums(content);
  const manifest = buildGateManifest({
    target: 'mcpb',
    artifact: 'fixture.mcpb',
    productVersion: '0.0.0',
    entries: content,
    checksumsSha256: sha256(checksums),
  });
  const all = [
    ...content,
    { path: CHECKSUM_FILE, content: Buffer.from(checksums) },
    { path: MANIFEST_FILE, content: Buffer.from(serializeManifest(manifest)) },
  ];
  let zip = createDeterministicZip(all);
  if (tamper === 'bitflip') {
    const { entries } = readZipDirectory(zip);
    const target = entries.find((e) => e.name === 'server/bin/run.mjs');
    const start = target.localOffset + 30 + Buffer.from(target.name, 'utf8').length;
    zip = Buffer.from(zip);
    zip[start + Math.floor(target.compressedSize / 2)] ^= 0x01;
  }
  return { zip, checksums, manifest };
}

describe('C9 · the audit detects an altered artifact', () => {
  test('an untouched archive passes', () => {
    const { zip } = buildFixtureArchive();
    const result = auditArchive(zip);
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.equal(result.entryCount, 5);
  });

  test('flipping ONE bit inside an entry is caught twice over', () => {
    const { zip } = buildFixtureArchive({ tamper: 'bitflip' });
    const result = auditArchive(zip);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.kind === 'crc-mismatch'),
      'the stored CRC-32 must no longer match the body');
    assert.ok(result.problems.some((p) => p.kind === 'content-hash-mismatch'),
      'the sha256 must no longer match SHA256SUMS');
  });

  test('replacing an entry AND its checksum still breaks the manifest link', () => {
    // The realistic attack: rewrite the file, then rewrite SHA256SUMS so the
    // per-file check passes. The manifest pins SHA256SUMS's own hash, so the
    // chain still breaks — which is what makes tampering detectable rather
    // than merely inconvenient.
    const content = [
      { path: 'manifest.json', content: Buffer.from('{"name":"fixture"}\n') },
      { path: 'server/bin/run.mjs', content: Buffer.from('console.log("EVIL");\n') },
    ];
    const honest = buildFixtureArchive();
    const forgedSums = buildChecksums(content);
    const zip = createDeterministicZip([
      ...content,
      { path: CHECKSUM_FILE, content: Buffer.from(forgedSums) },
      // the ORIGINAL manifest, which pins the original SHA256SUMS hash
      { path: MANIFEST_FILE, content: Buffer.from(serializeManifest(honest.manifest)) },
    ]);
    const result = auditArchive(zip);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.kind === 'checksums-hash-mismatch'),
      `expected the manifest→SHA256SUMS link to break, got ${JSON.stringify(result.problems)}`);
  });

  test('a COMPLETE re-forge passes internally — only an external hash refutes it', () => {
    // The test above stops one step short of a real attacker, who rewrites the
    // manifest too. Stating that plainly is the point: the internal chain
    // proves consistency, not authenticity, and the docs must not promise
    // otherwise. This test exists so nobody re-reads the chain as a signature.
    const forged = [
      { path: 'manifest.json', content: Buffer.from('{"name":"fixture"}\n') },
      { path: 'server/bin/run.mjs', content: Buffer.from('console.log("EVIL");\n') },
    ];
    const sums = buildChecksums(forged);
    const manifest = buildGateManifest({
      target: 'mcpb', artifact: 'fixture.mcpb', productVersion: '0.0.0',
      entries: forged, checksumsSha256: sha256(sums),
    });
    const zip = createDeterministicZip([
      ...forged,
      { path: CHECKSUM_FILE, content: Buffer.from(sums) },
      { path: MANIFEST_FILE, content: Buffer.from(serializeManifest(manifest)) },
    ]);
    assert.equal(auditArchive(zip).ok, true, 'a fully re-forged archive IS internally consistent');
    assert.equal(auditArchive(zip).authenticityVerified, false,
      'and the result must say authenticity was never established');

    // The external anchor is the only thing that catches it.
    const honest = buildFixtureArchive();
    const checked = auditArchive(zip, { expectArchiveSha256: sha256(honest.zip) });
    assert.equal(checked.ok, false);
    assert.ok(checked.problems.some((p) => p.kind === 'archive-hash-mismatch'));
  });

  test('an entry added after the fact is reported as unchecksummed', () => {
    const honest = buildFixtureArchive();
    const { entries } = readZipDirectory(honest.zip);
    const rebuilt = entries.map((e) => ({ path: e.name, content: readZipEntryContent(honest.zip, e) }));
    rebuilt.push({ path: 'server/backdoor.mjs', content: Buffer.from('// smuggled\n') });
    const result = auditArchive(createDeterministicZip(rebuilt));
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.kind === 'unchecksummed-entry' && p.entry === 'server/backdoor.mjs'));
  });

  test('an archive that never passed the gate is named as such', () => {
    const zip = createDeterministicZip([{ path: 'a.txt', content: 'x' }]);
    const result = auditArchive(zip);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.kind === 'missing-checksums'));
  });

  test('the expected-hash check catches a wholesale substitution', () => {
    const { zip } = buildFixtureArchive();
    const result = auditArchive(zip, { expectArchiveSha256: 'f'.repeat(64) });
    assert.ok(result.problems.some((p) => p.kind === 'archive-hash-mismatch'));
  });

  test('audit does not write to disk, and the guard covers the API it could use', () => {
    // The previous version patched only `fs.writeFileSync`/`fs.mkdirSync`
    // against a function that references neither, and called that a proof.
    // Assert the real property statically — the reader imports no filesystem
    // at all — then keep a runtime guard over the whole write surface.
    const zipSrc = fs.readFileSync(path.join(REPO_ROOT, 'src/helpers/deterministic-zip.mjs'), 'utf8');
    assert.equal(/from ['"]node:fs['"]/.test(zipSrc), false,
      'the zip reader must not import the filesystem at all');

    const { zip } = buildFixtureArchive();
    const patched = ['writeFileSync', 'mkdirSync', 'appendFileSync', 'openSync',
      'writeSync', 'createWriteStream', 'rmSync', 'unlinkSync', 'copyFileSync'];
    const saved = Object.fromEntries(patched.map((k) => [k, fs[k]]));
    for (const k of patched) fs[k] = () => { throw new Error(`audit must not call fs.${k}`); };
    try {
      assert.equal(auditArchive(zip).ok, true);
    } finally {
      for (const k of patched) fs[k] = saved[k];
    }
  });

  test('BLOCKING REGRESSION: a local header disagreeing with the central one is caught', () => {
    // The predecessor of this test renamed BOTH headers "to keep them in
    // sync" — the one case an attacker never produces. It therefore created
    // confidence in exactly the guarantee that was broken: listing tools
    // (unzip, 7z, .NET, python zipfile) read the CENTRAL directory, while
    // streaming readers (Java ZipInputStream, node unzipper, libarchive from a
    // pipe) read LOCAL headers — so one 14-byte patch made an archive list as
    // `server/abc.mjs` and extract as `../../evil.mjs`, auditing clean.
    const good = createDeterministicZip([{ path: 'server/abc.mjs', content: 'x' }]);
    const hostile = Buffer.from(good);
    const needle = Buffer.from('server/abc.mjs', 'utf8');
    const evil = Buffer.from('../../evil.mjs', 'utf8');
    assert.equal(evil.length, needle.length, 'the patch must not shift any offset');
    // ONLY the first occurrence — the local header. The central record keeps
    // the innocent name, which is what every listing tool will show.
    evil.copy(hostile, hostile.indexOf(needle));

    assert.equal(readZipDirectory(hostile).entries[0].name, 'server/abc.mjs',
      'the central directory must still look innocent, or the fixture tests nothing');

    const result = auditArchive(hostile, { deep: false });
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.kind === 'local-header-mismatch'),
      `expected a local/central mismatch, got ${JSON.stringify(result.problems)}`);
  });

  test('a hostile name in the CENTRAL directory is reported without extracting it', () => {
    const good = createDeterministicZip([{ path: 'ok.txt', content: 'x' }]);
    const hostile = Buffer.from(good);
    const needle = Buffer.from('ok.txt', 'utf8');
    const evil = Buffer.from('../evi', 'utf8');
    assert.equal(evil.length, needle.length);
    let idx = hostile.indexOf(needle);
    while (idx !== -1) {
      evil.copy(hostile, idx);
      idx = hostile.indexOf(needle, idx + 1);
    }
    const result = auditArchive(hostile, { deep: false });
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.kind === 'path-traversal'),
      `expected a traversal report, got ${JSON.stringify(result.problems)}`);
  });

  test('BLOCKING REGRESSION (round 2): APPENDING an EOCD cannot hide an entry either', () => {
    // Round 1 closed the EDIT variant and the test below claimed the general
    // property. It did not hold: instead of editing the EOCD, append a FRESH
    // one with a lower count AND a correspondingly shorter centralSize. Every
    // round-1 invariant then passes — counts agree, the parse lands exactly on
    // centralEnd, no duplicates — while the smuggled entry's central record
    // sits in the gap. The auditor said OK and `unzip` wrote the extra file.
    const honest = buildFixtureArchive().zip;
    const dir = readZipDirectory(honest);
    const eocd = honest.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const centralOffset = honest.readUInt32LE(eocd + 16);
    const centralSize = honest.readUInt32LE(eocd + 12);

    // Length of the LAST central record, so we can cut it out of the directory.
    const names = dir.entries.map((e) => e.name);
    const lastName = names[names.length - 1];
    const lastRecordLen = 46 + Buffer.byteLength(lastName, 'utf8');

    const appended = Buffer.alloc(22);
    appended.writeUInt32LE(0x06054b50, 0);
    appended.writeUInt16LE(dir.entries.length - 1, 8);
    appended.writeUInt16LE(dir.entries.length - 1, 10);
    appended.writeUInt32LE(centralSize - lastRecordLen, 12);
    appended.writeUInt32LE(centralOffset, 16);
    const hostile = Buffer.concat([honest.subarray(0, honest.length), appended]);

    const result = auditArchive(hostile);
    assert.equal(result.ok, false, 'an appended EOCD must not hide the trailing central record');
    assert.ok(result.problems.some((p) => p.kind === 'unreadable-archive'),
      `expected the directory parse to refuse it, got ${JSON.stringify(result.problems)}`);
  });

  test('BLOCKING REGRESSION: lowering the EOCD count cannot hide an entry', () => {
    // Decrementing the count left a fully-formed central record physically
    // present and simply outside the loop's range: the smuggled entry kept its
    // local header, extractors scanning for records still found it, and the
    // auditor reported clean.
    const tampered = Buffer.from(buildFixtureArchive().zip);
    const eocd = tampered.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const count = tampered.readUInt16LE(eocd + 10);
    tampered.writeUInt16LE(count - 1, eocd + 8);
    tampered.writeUInt16LE(count - 1, eocd + 10);
    const result = auditArchive(tampered);
    assert.equal(result.ok, false, 'an archive with a hidden central record must not audit clean');
    assert.ok(result.problems.some((p) => p.kind === 'unreadable-archive'),
      `expected the directory parse to refuse it, got ${JSON.stringify(result.problems)}`);
  });

  test('a shallow audit says outright that it verified no content', () => {
    const result = auditArchive(buildFixtureArchive().zip, { deep: false });
    assert.equal(result.integrityVerified, false);
    assert.ok(result.problems.some((p) => p.kind === 'integrity-not-verified'),
      'a name-only pass must never be mistakable for a verified one');
  });

  test('an empty manifest does not satisfy the manifest checks', () => {
    // `{}` used to pass: every field was verified only if present, so an
    // absent guarantee read as a waived one.
    const content = [{ path: 'manifest.json', content: Buffer.from('{}\n') }];
    const checksums = buildChecksums(content);
    const zip = createDeterministicZip([
      ...content,
      { path: CHECKSUM_FILE, content: Buffer.from(checksums) },
      { path: MANIFEST_FILE, content: Buffer.from('{}\n') },
    ]);
    const result = auditArchive(zip);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.kind === 'incomplete-manifest'));
  });

  test('the audit re-scans CONTENTS, not just names and checksums', () => {
    // An entry can be correctly named, correctly checksummed, uncorrupted —
    // and carry a credential. "Every entry matches its checksum" was true, and
    // read as "safe to publish".
    const leak = [
      { path: 'manifest.json', content: Buffer.from('{"n":1}\n') },
      { path: 'server/.config.toml', content: Buffer.from(`aws = "${AKIA}"\n`) },
    ];
    const checksums = buildChecksums(leak);
    const manifest = buildGateManifest({
      target: 'mcpb', productVersion: '0.0.0', entries: leak, checksumsSha256: sha256(checksums),
    });
    const zip = createDeterministicZip([
      ...leak,
      { path: CHECKSUM_FILE, content: Buffer.from(checksums) },
      { path: MANIFEST_FILE, content: Buffer.from(serializeManifest(manifest)) },
    ]);
    const result = auditArchive(zip);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.kind === 'leak:secret'),
      `expected a content leak report, got ${JSON.stringify(result.problems.map((p) => p.kind))}`);
  });

  test('a corrupt SHA256SUMS header is REPORTED, not thrown', () => {
    // It used to escape as a stack trace — and in the build, after the archive
    // had already been written to disk.
    const { zip } = buildFixtureArchive();
    const broken = Buffer.from(zip);
    const sums = readZipDirectory(zip).entries.find((e) => e.name === CHECKSUM_FILE);
    broken.writeUInt32LE(0xdeadbeef, sums.localOffset);
    let result;
    assert.doesNotThrow(() => { result = auditArchive(broken); });
    assert.equal(result.ok, false);
  });

  test('BLOCKING REGRESSION (round 3): a local record the directory does not declare is caught', () => {
    // The defect BOTH earlier rounds missed. They each closed a way of hiding
    // a record that IS in the central directory; nothing verified that the
    // local-header region contains only the declared entries. A complete local
    // record spliced in before `centralOffset`, with the EOCD's offset bumped
    // to cover it, was invisible to every check — and a third-party streaming
    // reader (`stream-unzip`, the Python analogue of Java's ZipInputStream)
    // extracted it, traversal names included.
    const honest = createDeterministicZip([{ path: 'server/ok.mjs', content: 'export const a = 1;\n' }]);
    // A benign name: this writer refuses to produce a traversal one, and the
    // property under test is that an UNDECLARED record is caught at all — a
    // hostile name only makes the consequence worse.
    const smuggled = createDeterministicZip([{ path: 'server/backdoor.mjs', content: '// smuggled\n' }]);
    // Take the smuggled archive's local record only (everything before its
    // own central directory) and splice it in front of the honest one.
    const smuggledEocd = smuggled.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const smuggledLocalLen = smuggled.readUInt32LE(smuggledEocd + 16);
    const prefix = smuggled.subarray(0, smuggledLocalLen);

    const hostile = Buffer.concat([prefix, honest]);
    // Shift every offset in the honest archive by the smuggled record's length.
    const eocd = hostile.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    hostile.writeUInt32LE(hostile.readUInt32LE(eocd + 16) + prefix.length, eocd + 16);
    let p = hostile.readUInt32LE(eocd + 16);
    for (let i = 0; i < hostile.readUInt16LE(eocd + 10); i++) {
      hostile.writeUInt32LE(hostile.readUInt32LE(p + 42) + prefix.length, p + 42);
      p += 46 + hostile.readUInt16LE(p + 28) + hostile.readUInt16LE(p + 30) + hostile.readUInt16LE(p + 32);
    }

    assert.ok(hostile.includes(Buffer.from('server/backdoor.mjs')), 'the fixture must really carry the record');
    const result = auditArchive(hostile);
    assert.equal(result.ok, false, 'an undeclared local record must not audit clean');
    assert.ok(result.problems.some((x) => x.kind === 'unreadable-archive'),
      `expected the directory parse to refuse it, got ${JSON.stringify(result.problems)}`);
  });

  test('BLOCKING REGRESSION (round 3): the audit honours target-scoped exceptions', () => {
    // `auditArchive` accepted `target` and dropped it, and the scoping failed
    // OPEN when it was undefined — so the audit CLI, the tool you point at a
    // stranger's archive, got every scoped suppression instead of none.
    const ex = [{
      path: 'tests/**', category: 'secret', rule: 'assigned-credential',
      targets: ['mcpb'], reason: 'a written reason of sufficient length for the validator',
    }];
    const files = [
      { path: 'manifest.json', content: Buffer.from('{"n":1}\n') },
      { path: 'tests/x.test.mjs', content: Buffer.from('const apiKey = "SOMETHINGRANDOM123";\n') },
    ];
    const sums = buildChecksums(files);
    const zip = createDeterministicZip([
      ...files,
      { path: CHECKSUM_FILE, content: Buffer.from(sums) },
      {
        path: MANIFEST_FILE,
        content: Buffer.from(serializeManifest(buildGateManifest({
          target: 'mcpb', productVersion: '0.0.0', entries: files, checksumsSha256: sha256(sums),
        }))),
      },
    ]);
    assert.equal(auditArchive(zip, { target: 'mcpb', exceptions: ex }).ok, true,
      'the declared target must get its exception');
    const other = auditArchive(zip, { target: 'okf', exceptions: ex });
    assert.equal(other.ok, false, 'another target must not inherit it');
    assert.ok(other.problems.some((p) => p.kind === 'leak:secret'));
    const unscoped = auditArchive(zip, { exceptions: ex });
    assert.equal(unscoped.ok, false, 'no target declared must mean no scoped suppression, not all of them');
  });

  test('ROUND 3: a credential parked in export-manifest.json is found', () => {
    // Both gate files were skipped by the content scan. The manifest is
    // attacker-controlled in any foreign archive, and "read by nothing" is
    // exactly the property that made the EOCD comment a hiding place.
    const files = [{ path: 'manifest.json', content: Buffer.from('{"n":1}\n') }];
    const sums = buildChecksums(files);
    const zip = createDeterministicZip([
      ...files,
      { path: CHECKSUM_FILE, content: Buffer.from(sums) },
      { path: MANIFEST_FILE, content: Buffer.from(`{"gateVersion":1,"target":"mcpb","note":"tok=${AKIA}","entries":{"count":1,"checksumsSha256":"${sha256(sums)}"}}\n`) },
    ]);
    const result = auditArchive(zip);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.kind === 'leak:secret'),
      `the gate files' own contents must be scanned, got ${JSON.stringify(result.problems.map((p) => p.kind))}`);
  });

  test('ROUND 3: a ZIP64 member is reported as unsupported, not as tampering', () => {
    // A zip64 member legally carries 0xffffffff sentinels in the 32-bit size
    // fields. Calling that a size disagreement told an operator that any
    // archive with a >4 GiB member had been altered.
    const zip = createDeterministicZip([{ path: 'a.txt', content: 'x'.repeat(64) }]);
    const t = Buffer.from(zip);
    const e = readZipDirectory(zip).entries[0];
    t.writeUInt32LE(0xffffffff, e.localOffset + 22);
    const cd = t.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    t.writeUInt32LE(0xffffffff, cd + 24);
    const cmp = compareLocalHeader(t, readZipDirectory(zip).entries[0]);
    assert.deepEqual(cmp.problems, [], 'a zip64 sentinel is not a header disagreement');
    assert.ok(cmp.unsupported.some((u) => /zip64/.test(u)));
  });

  test('ROUND 3: a credential in the EOCD COMMENT is found', () => {
    // The comment was parsed into `directory.comment` and read by nothing —
    // a byte region belonging to the archive but to no entry, carried into
    // every copy. A bearer token there audited perfectly clean.
    const { zip } = buildFixtureArchive();
    const payload = Buffer.from(`Authorization: Bearer ${AKIA}`);
    const withComment = Buffer.concat([zip, payload]);
    withComment.writeUInt16LE(payload.length, withComment.length - payload.length - 2);

    const result = auditArchive(withComment);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.kind === 'archive-comment'),
      'the presence of a comment must be reported at all');
    assert.ok(result.problems.some((p) => p.kind === 'leak:secret'),
      `the comment's contents must be scanned, got ${JSON.stringify(result.problems.map((p) => p.kind))}`);
  });

  test('ROUND 3: a local header that diverges in FLAGS or TIMESTAMP is caught', () => {
    // Round 2 compared name, method, CRC and sizes. Flags and the timestamp
    // were left out, so a local mtime differing from the normalised central
    // one — the very reproducibility claim the archive carries — was invisible.
    const { zip } = buildFixtureArchive();
    const target = readZipDirectory(zip).entries.find((e) => e.name === 'server/bin/run.mjs');

    const stamped = Buffer.from(zip);
    stamped.writeUInt16LE(0x5abc, target.localOffset + 10); // local dosTime only
    let result = auditArchive(stamped, { deep: false });
    assert.ok(result.problems.some((p) => p.kind === 'local-header-mismatch'),
      'a local/central timestamp divergence must be reported');

    const flagged = Buffer.from(zip);
    flagged.writeUInt16LE(0x0001, target.localOffset + 6); // local flags only
    result = auditArchive(flagged, { deep: false });
    assert.ok(result.problems.some((p) => p.kind === 'local-header-mismatch'),
      'a local/central flags divergence must be reported');
  });

  test('ROUND 3: archives from OTHER tools still parse with no false positives', (t) => {
    // The flags/timestamp comparison above is the kind of strictness that can
    // reject legitimate archives. .NET, PowerShell and Python are independent
    // implementations; if any of them trips it, the check is too strict.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c9-foreign-'));
    try {
      const src = path.join(dir, 'src');
      fs.mkdirSync(src);
      fs.writeFileSync(path.join(src, 'hello.txt'), 'hello from a foreign tool\n');
      fs.writeFileSync(path.join(src, 'empty.txt'), '');
      const out = path.join(dir, 'dotnet.zip');
      try {
        execFileSync('powershell', ['-NoProfile', '-Command',
          `Add-Type -AssemblyName System.IO.Compression.FileSystem; `
          + `[IO.Compression.ZipFile]::CreateFromDirectory('${src}','${out}')`], { stdio: 'ignore' });
      } catch {
        t.skip('PowerShell/.NET not available on this machine');
        return;
      }
      const buf = fs.readFileSync(out);
      const parsed = readZipDirectory(buf);
      assert.equal(parsed.entries.length, 2);
      for (const e of parsed.entries) {
        const cmp = compareLocalHeader(buf, e);
        assert.deepEqual(cmp.problems, [], `${e.name}: a .NET archive must not look tampered`);
        assert.deepEqual(cmp.unsupported, [], `${e.name}: a .NET archive must be fully readable`);
        assert.doesNotThrow(() => readZipEntryContent(buf, e));
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the result distinguishes internal consistency from authenticity', () => {
    // The checksum chain proves the archive agrees with itself. An attacker
    // rewriting payload, SHA256SUMS and manifest together produces a
    // consistent archive — only an externally-obtained hash refutes it.
    const { zip } = buildFixtureArchive();
    assert.equal(auditArchive(zip).authenticityVerified, false);
    assert.equal(auditArchive(zip, { expectArchiveSha256: sha256(zip) }).authenticityVerified, true);
  });

  test('a non-normalised mtime is reported — the archive is not reproducible', () => {
    const { zip } = buildFixtureArchive();
    const stamped = Buffer.from(zip);
    // dosDate sits at +14 of the central header; find it via the signature.
    const { entries } = readZipDirectory(zip);
    assert.ok(entries.length > 0);
    let p = stamped.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    stamped.writeUInt16LE(0x5abc, p + 14);
    const result = auditArchive(stamped, { deep: false });
    assert.ok(result.problems.some((x) => x.kind === 'non-normalized-mtime'));
  });

  test('a case-collision that silently drops a file on Windows is reported', () => {
    const zip = createDeterministicZip([
      { path: 'server/README.md', content: 'a' },
      { path: 'server/readme.md', content: 'b' },
    ]);
    const result = auditArchive(zip, { deep: false });
    assert.ok(result.problems.some((p) => p.kind === 'case-collision'));
  });

  test('a truncated file is refused as unreadable, not parsed as empty', () => {
    const { zip } = buildFixtureArchive();
    const result = auditArchive(zip.subarray(0, 40));
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.kind === 'unreadable-archive'));
  });
});

// ---------------------------------------------------------------------------
// Checksums + manifest
// ---------------------------------------------------------------------------

describe('C9 · checksums are coreutils-compatible and stable', () => {
  test('the `sha256sum -c` line shape, sorted, LF, trailing newline', () => {
    const text = buildChecksums([
      { path: 'b.txt', content: 'b' },
      { path: 'a.txt', content: 'a' },
    ]);
    assert.match(text, /^[0-9a-f]{64} {2}a\.txt\n[0-9a-f]{64} {2}b\.txt\n$/);
    assert.equal(text.includes('\r'), false, 'CRLF would break sha256sum -c');
  });

  test('parseChecksums round-trips what buildChecksums writes', () => {
    const entries = [{ path: 'x/y.txt', content: 'hello' }];
    const parsed = parseChecksums(buildChecksums(entries));
    assert.equal(parsed.get('x/y.txt'), sha256('hello'));
  });

  test('backslash paths are normalised before hashing', () => {
    const a = buildChecksums([{ path: 'x\\y.txt', content: 'z' }]);
    const b = buildChecksums([{ path: 'x/y.txt', content: 'z' }]);
    assert.equal(a, b);
  });
});

// ---------------------------------------------------------------------------
// The in-memory gate (the OKF path)
// ---------------------------------------------------------------------------

describe('C9 · gateFileSet — the same gate, without a filesystem', () => {
  test('a clean file set passes and gets its two gate files', () => {
    const result = gateFileSet({
      files: [{ path: 'index.md', content: '# Hi\n' }, { path: 'a/b.md', content: 'body\n' }],
      target: 'okf',
      contract: readContract(REPO_ROOT).contract,
    });
    assert.equal(result.ok, true, JSON.stringify(result.findings));
    assert.deepEqual(result.gateFiles.map((f) => f.path).sort(), [MANIFEST_FILE, CHECKSUM_FILE].sort());
  });

  test('a leaking file set fails and names the category', () => {
    const result = gateFileSet({
      files: [{ path: 'note.md', content: 'mail me at someone.real@gmail.com\n' }],
      target: 'okf',
      contract: readContract(REPO_ROOT).contract,
    });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((f) => f.category === 'personal-email'));
  });

  test('a file the allowlist does not name is a finding, not a silent drop', () => {
    const result = gateFileSet({
      files: [{ path: 'secrets.env', content: 'x\n' }],
      target: 'okf',
      contract: readContract(REPO_ROOT).contract,
    });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((f) => f.rule === 'not-on-allowlist'));
  });

  test('without a contract the result is NOT ok — being unable to check is a finding', () => {
    // This test used to assert only `allowlist.checked === false` while
    // `ok` was `true`. Its own comment said a vacuous pass "must be reported
    // as unchecked, never as clean" — and the flag it checked was dropped by
    // the only production consumer, so nobody could see it. It blessed the
    // hole it was named after.
    const result = gateFileSet({ files: [{ path: 'x.md', content: 'y' }], target: 'okf' });
    assert.equal(result.allowlist.checked, false);
    assert.equal(result.ok, false, 'an unchecked allowlist must not report a clean gate');
    assert.ok(result.findings.some((f) => f.rule === 'allowlist-not-checked'));
  });

  test('a contract that does not declare the target throws, rather than skipping the allowlist', () => {
    // `gateDirectory` always threw here; `gateFileSet` degraded silently to
    // "unchecked" and returned ok — and gateFileSet is the path the OKF exit
    // uses, so the silent one was the one in production.
    assert.throws(
      () => gateFileSet({
        files: [{ path: 'x.md', content: 'y' }],
        target: 'typo',
        contract: readContract(REPO_ROOT).contract,
      }),
      /has no target "typo"/,
    );
  });

  test('the same file set gates to identical checksums twice', () => {
    const files = [{ path: 'a.md', content: 'x' }, { path: 'b.md', content: 'y' }];
    const one = gateFileSet({ files, target: 'okf' });
    const two = gateFileSet({ files, target: 'okf' });
    assert.equal(one.checksums, two.checksums);
    assert.equal(serializeManifest(one.manifest), serializeManifest(two.manifest));
  });
});

// ---------------------------------------------------------------------------
// The OKF exit, end to end
// ---------------------------------------------------------------------------

describe('C9 · the OKF bundle goes through the same gate', () => {
  const cleanPages = [
    { path: 'wiki/concepts/alpha.md', content: '---\ntype: concept\ntitle: Alpha\ndescription: The first one.\n---\n\n# Alpha\n\nSee [[beta]].\n' },
    { path: 'wiki/concepts/beta.md', content: '---\ntype: concept\ntitle: Beta\ndescription: The second one.\n---\n\n# Beta\n\nBack to [[alpha]].\n' },
  ];
  const build = (pages) => buildOkfBundle({
    vaultName: 'demo',
    pages,
    now: '2026-08-03T00:00:00.000Z',
    summary: 'Demo.',
    gateContract: readContract(REPO_ROOT).contract,
    gatePrivatePathRoots: [],
  });

  test('a clean bundle passes and carries its checksums', () => {
    const { files, report } = build(cleanPages);
    assert.equal(report.gate.ok, true, JSON.stringify(report.gate.findings));
    assert.ok(files.some((f) => f.path === CHECKSUM_FILE));
    assert.ok(files.some((f) => f.path === MANIFEST_FILE));
  });

  test('the two non-.md gate files do NOT break OKF conformance', () => {
    // The reason the gate can add them at all: the conformance checker only
    // inspects `.md` files. If that ever changes, this fails here rather than
    // in someone else's OKF consumer.
    const { files } = build(cleanPages);
    const conformance = checkOkfConformance(files);
    assert.equal(conformance.errors.length, 0,
      `gate files broke conformance: ${JSON.stringify(conformance.errors)}`);
  });

  test('a leaking bundle is refused — and returns NOTHING to write', () => {
    // Withholding only the checksums was not a refusal: the skill's documented
    // next step is "write each returned file", so the leaking pages were still
    // handed over ready to publish. This test previously called that
    // "refused". A refusal returns an empty file list.
    const leaking = [...cleanPages, {
      path: 'wiki/concepts/leak.md',
      content: '---\ntype: concept\ntitle: Leak\ndescription: oops\n---\n\nmail personal.name@gmail.com\n',
    }];
    const { files, report } = build(leaking);
    assert.equal(report.gate.ok, false);
    assert.ok(report.gate.findings.some((f) => f.category === 'personal-email'));
    assert.deepEqual(files, [], 'a refused bundle must yield no publishable files at all');
  });

  test('the gate inputs are mandatory — no blind mode exists', () => {
    // They defaulted to `null` / `[]`, and the documented production caller
    // passed neither: the allowlist never ran and the one rule that catches a
    // machine-specific vault root was off, while the bundle came back ok:true
    // wearing a valid SHA256SUMS.
    assert.throws(() => buildOkfBundle({
      vaultName: 'demo', pages: cleanPages, now: '2026-08-03T00:00:00.000Z',
    }), /gateContract is required/);
    assert.throws(() => buildOkfBundle({
      vaultName: 'demo', pages: cleanPages, now: '2026-08-03T00:00:00.000Z',
      gateContract: readContract(REPO_ROOT).contract, gatePrivatePathRoots: null,
    }), /gatePrivatePathRoots is required/);
  });

  test('a private vault root inside a page is caught in the OKF exit', () => {
    // The case measured on a real 174-page vault, where it fired 59 times.
    const leaking = [...cleanPages, {
      path: 'wiki/concepts/paths.md',
      content: '---\ntype: concept\ntitle: Paths\ndescription: d\n---\n\nMy vault is at C:\\VAULTS\\Kiviri Stack\\wiki.\n',
    }];
    const { files, report } = buildOkfBundle({
      vaultName: 'demo', pages: leaking, now: '2026-08-03T00:00:00.000Z',
      gateContract: readContract(REPO_ROOT).contract,
      gatePrivatePathRoots: ['C:\\VAULTS'],
    });
    assert.equal(report.gate.ok, false);
    assert.ok(report.gate.findings.some((f) => f.rule === 'configured-private-root'));
    assert.deepEqual(files, []);
  });

  test('a packaged OKF bundle passes the archive audit', () => {
    const { files } = build(cleanPages);
    const zip = createDeterministicZip(files.map((f) => ({ path: f.path, content: f.content })));
    const audit = auditArchive(zip);
    assert.equal(audit.ok, true, JSON.stringify(audit.problems));
  });

  test('the gate does not disturb the exporter’s own determinism', () => {
    const a = build(cleanPages);
    const b = build(cleanPages);
    assert.deepEqual(a.files, b.files);
  });
});

// ---------------------------------------------------------------------------
// The live repo — a drift gate, C8-style
// ---------------------------------------------------------------------------

describe('C9 · the live repository passes its own gate', () => {
  test('the contract parses and declares the three exits', () => {
    const { contract } = readContract(REPO_ROOT);
    assert.deepEqual(Object.keys(contract.targets).sort(), ['mcpb', 'okf', 'release']);
  });

  test('the release surface of THIS repo is clean', () => {
    const { contract, sha256: contractSha, path: contractPath } = readContract(REPO_ROOT);
    const result = gateDirectory({
      root: REPO_ROOT,
      contract,
      target: 'release',
      productVersion: '0.0.0',
      privatePathRoots: collectPrivateRoots({ repoRoot: REPO_ROOT }),
      contractSha256: contractSha,
      contractPath,
    });
    assert.equal(result.ok, true,
      `the repo would leak on release:\n${result.scan.findings.map((f) => `  [${f.category}/${f.rule}] ${f.path}:${f.line ?? ''} ${f.evidence}`).join('\n')}`);
  });

  test('EVERY TRACKED BLOB is clean — that is what a GitHub release publishes', () => {
    // The allowlist governs what WE assemble; it cannot shrink the source
    // archive GitHub generates, which contains every tracked file. Scanning
    // only the 309 allowlisted files left 156 published ones — `tests/`,
    // `docs/`, `.github/`, the deployment examples — completely unexamined.
    const { contract } = readContract(REPO_ROOT);
    const tracked = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean)
      .filter((p) => fs.existsSync(path.join(REPO_ROOT, p)));
    assert.ok(tracked.length > 400, `expected the whole tracked tree, got ${tracked.length}`);

    const result = scanEntries(
      tracked.map((p) => ({ path: p, content: fs.readFileSync(path.join(REPO_ROOT, p)) })),
      {
        target: 'release',
        exceptions: contract.scanExceptions || [],
        privatePathRoots: collectPrivateRoots({ repoRoot: REPO_ROOT }),
        emailAllowlist: contract.emailAllowlist || [],
      },
    );
    assert.equal(result.ok, true,
      `a release would publish these:\n${result.findings.map((f) => `  [${f.category}/${f.rule}] ${f.path}:${f.line ?? ''} ${f.evidence}`).join('\n')}`);
  });

  test('the tests/ exception mutes ONLY the generic rule, not shaped credentials', () => {
    // The one exception scoped to tests/ is the widest in the contract. Pin
    // its edges: a fixture-shaped assignment is muted, a real AWS key in the
    // same file is not, and neither e-mail nor private-path is affected.
    const { contract } = readContract(REPO_ROOT);
    const opts = { target: 'release', exceptions: contract.scanExceptions || [], privatePathRoots: ['C:\\VAULTS'] };
    const muted = scanEntries([{ path: 'tests/x.test.mjs', content: 'const apiKey = "SOMETHINGRANDOM123";' }], opts);
    assert.equal(muted.ok, true, 'a fixture-shaped assignment should be suppressed in tests/');

    for (const [content, category] of [
      [`const k = "${AKIA}";`, 'secret'],
      ['// contact someone.real@gmail.com', 'personal-email'],
      ['const p = "C:\\\\VAULTS\\\\notes";', 'private-path'],
    ]) {
      const r = scanEntries([{ path: 'tests/x.test.mjs', content }], opts);
      assert.equal(r.ok, false, `${category} must still be caught inside tests/`);
      assert.ok(r.findings.some((f) => f.category === category));
    }
  });

  test('the release surface is not accidentally empty', () => {
    // A gate that selects nothing passes every scan. Assert it actually
    // selected the tree, so an allowlist typo cannot read as "clean".
    const { contract } = readContract(REPO_ROOT);
    const result = gateDirectory({
      root: REPO_ROOT, contract, target: 'release', productVersion: '0.0.0',
    });
    assert.ok(result.included.length > 200,
      `expected the whole source surface, got ${result.included.length} files`);
    for (const required of ['package.json', 'bin/obsidian-mcp-router.mjs', 'src/index.mjs', 'LICENSE']) {
      assert.ok(result.included.some((i) => i.path === required), `${required} must ship`);
    }
  });

  test('the mcpb allowlist covers every path package.json declares in `files`', () => {
    // Two lists that must not drift: npm's publish surface and the bundle's.
    // Anything the bundle ships BEYOND npm's list needs a written reason.
    const { contract } = readContract(REPO_ROOT);
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    const authored = contract.targets.mcpb.zones.authored;
    for (const f of pkg.files) {
      const base = f.replace(/\/$/, '');
      const covered = authored.some((p) => p === base || p === `${base}/**`);
      assert.ok(covered, `package.json files[] declares "${f}" which no mcpb allowlist pattern covers`);
    }
    // The fixture must be non-trivial, or "everything is covered" is vacuous.
    assert.ok(pkg.files.length >= 10, `package.json files[] has only ${pkg.files.length} entries`);
  });

  test('anything shipped beyond package.json `files` carries a written reason', () => {
    const { contract } = readContract(REPO_ROOT);
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    // npm ships package.json unconditionally, whether or not `files` lists it.
    const pkgKeys = new Set([...pkg.files.map((f) => f.replace(/\/$/, '')), 'package.json']);
    const justified = new Set((contract.beyondPackageFiles || []).map((b) => b.pattern.replace(/\/\*\*$/, '')));
    for (const p of contract.targets.mcpb.zones.authored) {
      const base = p.replace(/\/\*\*$/, '').replace(/\/$/, '');
      if (pkgKeys.has(base)) continue;
      assert.ok(justified.has(base), `mcpb ships "${p}" which is neither in package.json files[] nor justified in beyondPackageFiles`);
    }
    for (const b of contract.beyondPackageFiles || []) {
      assert.ok(b.reason && b.reason.trim().length > 20, `beyondPackageFiles ${b.pattern} needs a real reason`);
    }
  });
});

// ---------------------------------------------------------------------------
// The build script's own pieces
// ---------------------------------------------------------------------------

describe('C9 · the bundle build', () => {
  test('the MCPHub manifest carries no timestamp', () => {
    const m = buildMcphubManifest('1.2.3');
    assert.equal(/\b20\d\d-\d\d-\d\d/.test(JSON.stringify(m)), false);
    assert.equal(m.version, '1.2.3');
  });

  test('the MCPHub entrypoint path is derived, not written twice', () => {
    const m = buildMcphubManifest('1.2.3');
    assert.match(m.server.mcp_config.args[0], /server-obsidian-mcp-router\/server\/bin\//);
  });

  test('staging copies only what the whitelist names', (t) => {
    const tmp = fs.mkdtempSync(path.join(REPO_ROOT, 'mcpb-staging-test-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const src = path.join(tmp, 'src-repo');
    const dst = path.join(tmp, 'staged');
    fs.mkdirSync(path.join(src, 'src'), { recursive: true });
    fs.mkdirSync(path.join(src, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(src, 'src', 'index.mjs'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(src, '.codex', 'config.toml'), 'secret\n');
    fs.writeFileSync(path.join(src, 'LICENSE'), 'MIT\n');
    fs.mkdirSync(dst, { recursive: true });

    const contract = { targets: { mcpb: { zones: { authored: ['src/**', 'LICENSE'] } } } };
    const { staged } = stageAuthoredFiles({ repoRoot: src, serverDir: dst, contract });

    assert.equal(staged, 2);
    assert.ok(fs.existsSync(path.join(dst, 'src', 'index.mjs')));
    assert.ok(fs.existsSync(path.join(dst, 'LICENSE')));
    assert.equal(fs.existsSync(path.join(dst, '.codex', 'config.toml')), false,
      'the file that actually leaked must not reach staging');
  });

  test('CI REGRESSION: the scan prunes what the contract says the build prunes', (t) => {
    // Found by the real CI run of v0.68.0, not by three review rounds: the
    // gate was green on Windows and RED on both ubuntu legs with seven
    // symlink findings under `node_modules/.bin` — a directory the BUILD
    // already prunes (it is npm-generated, real files on Windows, symlinks on
    // Linux). `vendoredPrune` was honoured by the build and ignored by the
    // scan, so the scan judged a surface that never ships.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c9-prune-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'node_modules/.bin'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'node_modules/repomix/bin'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src/index.mjs'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(tmp, 'node_modules/repomix/bin/repomix.cjs'), '#!/usr/bin/env node\n');
    try {
      fs.symlinkSync('../repomix/bin/repomix.cjs', path.join(tmp, 'node_modules/.bin/repomix'));
    } catch {
      t.skip('symlink creation not permitted on this machine');
      return;
    }

    const { contract } = readContract(REPO_ROOT);
    const result = gateDirectory({ root: tmp, contract, target: 'mcpb', productVersion: '0.0.0' });
    assert.equal(result.scan.findings.filter((f) => f.category === 'symlink').length, 0,
      'a pruned directory must not produce findings');
    assert.equal(result.included.some((i) => i.path.startsWith('node_modules/.bin/')), false,
      'a pruned directory must not be selected');
    // The control: the package content beside it still ships, so the prune is
    // scoped and did not quietly swallow the vendored zone.
    assert.ok(result.included.some((i) => i.path === 'node_modules/repomix/bin/repomix.cjs'));
    assert.equal(result.ok, true);
  });

  test('a symlink matched by the whitelist is reported, never followed', (t) => {
    const tmp = fs.mkdtempSync(path.join(REPO_ROOT, 'mcpb-staging-test-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const src = path.join(tmp, 'r');
    const dst = path.join(tmp, 's');
    fs.mkdirSync(path.join(src, 'src'), { recursive: true });
    fs.mkdirSync(dst, { recursive: true });
    fs.writeFileSync(path.join(src, 'src', 'real.mjs'), 'x\n');
    try {
      fs.symlinkSync(path.join(src, 'src', 'real.mjs'), path.join(src, 'src', 'link.mjs'));
    } catch {
      t.skip('symlink creation not permitted on this machine');
      return;
    }
    const contract = { targets: { mcpb: { zones: { authored: ['src/**'] } } } };
    const { symlinks } = stageAuthoredFiles({ repoRoot: src, serverDir: dst, contract });
    assert.deepEqual(symlinks, ['src/link.mjs']);
    assert.equal(fs.existsSync(path.join(dst, 'src', 'link.mjs')), false);
  });
});

describe('C9 · private roots are derived, never committed', () => {
  test('the repo root and the home directory are always included', () => {
    const roots = collectPrivateRoots({ repoRoot: 'C:\\repo', env: {}, homedir: 'C:\\Users\\x' });
    assert.ok(roots.includes('C:\\repo'));
    assert.ok(roots.includes('C:\\Users\\x'));
  });

  test('the env var accepts Windows drive paths without splitting on the colon', () => {
    const roots = collectPrivateRoots({
      repoRoot: null, homedir: null,
      env: { OBSIDIAN_ROUTER_EXPORT_PRIVATE_ROOTS: 'C:\\VAULTS;D:\\work' },
    });
    assert.deepEqual(roots, ['C:\\VAULTS', 'D:\\work']);
  });

  test('the env var still splits POSIX roots on the colon', () => {
    const roots = collectPrivateRoots({
      repoRoot: null, homedir: null,
      env: { OBSIDIAN_ROUTER_EXPORT_PRIVATE_ROOTS: '/srv/a:/srv/b' },
    });
    assert.deepEqual(roots, ['/srv/a', '/srv/b']);
  });

  test('no machine-specific root is hard-coded in the committed contract', () => {
    // Writing `C:\VAULTS\…` into a tracked file in order to detect it being
    // published would itself publish it.
    const raw = fs.readFileSync(path.join(REPO_ROOT, 'contracts/export-allowlist.json'), 'utf8');
    assert.equal(/[A-Za-z]:\\\\Users\\\\(?!me\b)/.test(raw), false);
    assert.equal(raw.includes('I:\\\\DEVELOPPEMENT'), false);
  });
});
