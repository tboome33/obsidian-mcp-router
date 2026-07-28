/**
 * Tests for src/helpers/targz-extract.mjs — the hardened tar.gz extractor
 * behind `--sync-from-github` (template-distribution Lot 3).
 *
 * Archives are synthesized in-test (ustar headers with real checksums), so
 * the traversal / link-smuggling / bomb cases exercise exactly the bytes a
 * hostile archive would carry.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

import { extractTarGz, assertSafeRepoRef } from '../src/helpers/targz-extract.mjs';

// ---- in-test tar builder ------------------------------------------------

function tarHeader(name, size, type = '0') {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii'); // mode
  header.write('0000000\0', 108, 8, 'ascii'); // uid
  header.write('0000000\0', 116, 8, 'ascii'); // gid
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii'); // mtime
  header.write('        ', 148, 8, 'ascii'); // checksum placeholder (spaces)
  header.write(type, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}

function tarEntry(name, content = '', type = '0') {
  const data = Buffer.from(content, 'utf8');
  const size = data.length;
  const parts = [tarHeader(name, size, type)];
  if (size > 0) {
    const padded = Buffer.alloc(Math.ceil(size / 512) * 512);
    data.copy(padded);
    parts.push(padded);
  }
  return Buffer.concat(parts);
}

function makeTarGz(entries) {
  return zlib.gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

// ---- fixtures -----------------------------------------------------------

let dest;
beforeEach(() => { dest = fs.mkdtempSync(path.join(os.tmpdir(), 'targz-')); });
afterEach(() => { try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* best effort */ } });

// ---- extraction ---------------------------------------------------------

describe('extractTarGz — happy path', () => {
  test('extracts files and directories, creating nested parents', () => {
    const gz = makeTarGz([
      tarEntry('repo-abc/', '', '5'),
      tarEntry('repo-abc/templates/skel/.obsidian/app.json', '{"a":1}'),
      tarEntry('repo-abc/README.md', 'hello'),
    ]);
    const result = extractTarGz(gz, dest);
    assert.equal(result.files, 2);
    assert.equal(fs.readFileSync(path.join(dest, 'repo-abc', 'templates', 'skel', '.obsidian', 'app.json'), 'utf8'), '{"a":1}');
    assert.equal(fs.readFileSync(path.join(dest, 'repo-abc', 'README.md'), 'utf8'), 'hello');
  });

  test('GNU longname entries name the following file', () => {
    const long = 'repo-abc/' + 'deep/'.repeat(25) + 'file.txt'; // > 100 chars
    const gz = makeTarGz([
      tarEntry('././@LongLink', long, 'L'),
      tarEntry('repo-abc/ignored-short-name', 'content'),
    ]);
    const result = extractTarGz(gz, dest);
    assert.equal(result.files, 1);
    assert.equal(fs.readFileSync(path.join(dest, ...long.split('/')), 'utf8'), 'content');
  });

  test('pax metadata entries are skipped without side effects', () => {
    const gz = makeTarGz([
      tarEntry('pax_global_header', '52 comment=deadbeef\n', 'g'),
      tarEntry('repo-abc/x.md', 'ok'),
    ]);
    const result = extractTarGz(gz, dest);
    assert.equal(result.files, 1);
    assert.equal(fs.existsSync(path.join(dest, 'pax_global_header')), false);
  });
});

describe('extractTarGz — hostile archives', () => {
  test('path traversal via .. aborts the whole extraction', () => {
    const gz = makeTarGz([tarEntry('repo/../../evil.txt', 'pwned')]);
    assert.throws(() => extractTarGz(gz, dest), /traversal|escapes/i);
    assert.equal(fs.existsSync(path.join(path.dirname(dest), 'evil.txt')), false);
  });

  test('absolute POSIX and Windows-drive paths are rejected', () => {
    assert.throws(() => extractTarGz(makeTarGz([tarEntry('/etc/passwd', 'x')]), dest), /absolute/i);
    assert.throws(() => extractTarGz(makeTarGz([tarEntry('C:/Windows/evil', 'x')]), dest), /absolute/i);
  });

  test('backslash separators cannot smuggle a traversal', () => {
    const gz = makeTarGz([tarEntry('repo\\..\\..\\evil.txt', 'x')]);
    assert.throws(() => extractTarGz(gz, dest), /traversal|escapes/i);
  });

  test('symlinks and hardlinks are skipped and reported, never materialized', () => {
    const gz = makeTarGz([
      tarEntry('repo/link-out', '', '2'),
      tarEntry('repo/hard', '', '1'),
      tarEntry('repo/real.txt', 'data'),
    ]);
    const result = extractTarGz(gz, dest);
    assert.equal(result.files, 1);
    assert.deepEqual(result.skippedLinks, ['repo/link-out', 'repo/hard']);
    assert.equal(fs.existsSync(path.join(dest, 'repo', 'link-out')), false);
  });

  test('entry-count and total-size caps abort with a clear error', () => {
    const many = Array.from({ length: 5 }, (_, i) => tarEntry(`repo/f${i}.txt`, 'x'));
    assert.throws(() => extractTarGz(makeTarGz(many), dest, { maxEntries: 3 }), /entry limit/i);
    const big = makeTarGz([tarEntry('repo/big.bin', 'A'.repeat(4096))]);
    assert.throws(() => extractTarGz(big, dest, { maxTotalBytes: 1024 }), /extraction limit/i);
  });

  test('a truncated archive fails instead of silently extracting a prefix', () => {
    const whole = Buffer.concat([tarEntry('repo/a.txt', 'A'.repeat(2000))]);
    const truncated = zlib.gzipSync(whole.subarray(0, 700));
    assert.throws(() => extractTarGz(truncated, dest), /truncated/i);
  });

  test('metadata payloads (pax/longname) count toward the size cap', () => {
    // Review finding: only regular-file bytes were counted — a 2 MB pax
    // payload sailed under a 1 KB cap.
    const gz = makeTarGz([
      tarEntry('pax_global_header', 'B'.repeat(2 * 1024 * 1024), 'g'),
      tarEntry('repo/ok.txt', 'x'),
    ]);
    assert.throws(() => extractTarGz(gz, dest, { maxTotalBytes: 1024 }), /extraction limit/i);
  });

  test('GNU base-256 numeric fields are refused, not silently parsed as 0', () => {
    // Review finding: 'ascii' decoding masked the high bit and the binary
    // size parsed as 0 — the payload was then re-parsed as tar headers.
    const entry = tarEntry('repo/big.bin', 'A'.repeat(600));
    entry[124] = 0x80;
    assert.throws(() => extractTarGz(makeTarGz([entry]), dest), /base-256/i);
  });

  test('a directory entry declaring a payload cannot desync the stream', () => {
    // Review finding: the dir branch did not advance past its data, so a
    // smuggled header inside the payload was parsed as a real entry.
    const smuggled = Buffer.concat([tarHeader('repo/hidden.js', 3), Buffer.alloc(512, 0x78)]);
    const raw = Buffer.concat([tarHeader('repo/d/', 1024, '5'), smuggled, Buffer.alloc(1024)]);
    const result = extractTarGz(zlib.gzipSync(raw), dest);
    assert.equal(result.files, 0);
    assert.equal(fs.existsSync(path.join(dest, 'repo', 'hidden.js')), false);
  });

  test('Windows trailing-dot/space components are rejected', () => {
    assert.throws(() => extractTarGz(makeTarGz([tarEntry('repo/.. /x.txt', 'a')]), dest), /traversal|escapes/i);
    assert.throws(() => extractTarGz(makeTarGz([tarEntry('repo/.../x.txt', 'a')]), dest), /traversal|escapes/i);
  });

  test('a legitimate name starting with .. is NOT rejected (segment-accurate test)', () => {
    const result = extractTarGz(makeTarGz([tarEntry('..foo/ok.txt', 'x')]), dest);
    assert.equal(result.files, 1);
    assert.equal(fs.readFileSync(path.join(dest, '..foo', 'ok.txt'), 'utf8'), 'x');
  });
});

// ---- repo/ref validation ------------------------------------------------

describe('assertSafeRepoRef', () => {
  test('accepts normal repos and refs', () => {
    assertSafeRepoRef('tboome33/obsidian-mcp-router', 'main');
    assertSafeRepoRef('a-b.c/d_e', 'v0.54.1');
    assertSafeRepoRef('o/r', 'feature/x');
  });

  test('rejects URL-injection attempts', () => {
    assert.throws(() => assertSafeRepoRef('o/r/extra', 'main'), /repo/i);
    assert.throws(() => assertSafeRepoRef('o r', 'main'), /repo/i);
    assert.throws(() => assertSafeRepoRef('o/r', 'main?x=1'), /ref/i);
    assert.throws(() => assertSafeRepoRef('o/r', 'a..b'), /ref/i);
    assert.throws(() => assertSafeRepoRef('o/r', 'a b'), /ref/i);
  });

  test('rejects dot-segment repos and dash-leading refs (review findings)', () => {
    assert.throws(() => assertSafeRepoRef('a/..', 'main'), /repo/i);
    assert.throws(() => assertSafeRepoRef('../a', 'main'), /repo/i);
    assert.throws(() => assertSafeRepoRef('./x', 'main'), /repo/i);
    assert.throws(() => assertSafeRepoRef('o/r', '-force'), /ref/i);
  });
});
