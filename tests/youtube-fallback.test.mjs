/**
 * yt-dlp YouTube transcript fallback — unit tests.
 *
 * Mirrors tests/markdownify.test.mjs conventions: node:test + assert/strict,
 * pure-helper coverage, and dependency-injection seams so the subprocess +
 * network paths are exercised WITHOUT spawning yt-dlp or hitting YouTube.
 *
 *   - `subtitlesToText` / `pickSubtitleFile` / `resolveYtdlpPath` — pure.
 *   - `fetchYoutubeTranscriptViaYtdlp(url, { execFileImpl, assertPublic })` —
 *     the injected `execFileImpl` writes sample caption/info files into the
 *     real mkdtemp dir (derived from the `-o` template in argv), so the fs
 *     read + parse + assembly path runs for real but no yt-dlp is needed.
 *   - `youtubeToMarkdown(_registry, { url }, { primary, fallback })` — the
 *     primary/fallback wiring, with seams so neither MarkItDown nor yt-dlp run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  subtitlesToText,
  pickSubtitleFile,
  resolveYtdlpPath,
  isYoutubeVideoUrl,
  extractYoutubeVideoId,
  fetchYoutubeTranscriptViaYtdlp,
  jsRuntimeArg,
  readYtdlpNetworkSettings,
} from '../src/markdownify/youtube-fallback.mjs';
import { classifyWorkspaceDotenvKey } from '../src/helpers/workspace-dotenv.mjs';
import { toMarkdown, describeFetchFailure } from '../src/markdownify/markitdown.mjs';

// A real 11-char YouTube video id, reused across the subprocess-seam tests.
const VID = 'dQw4w9WgXcQ';

import { youtubeToMarkdown, markdownHasTranscript } from '../src/tools/convert.mjs';

// Helper: a fake execFileImpl that writes caption + info files into the temp
// dir yt-dlp was told to use (the `-o <dir>/sub.%(ext)s` argv entry).
function writerExecFile(filesByName, { throwAfter } = {}) {
  return async (_cmd, args) => {
    const oIdx = args.indexOf('-o');
    const dir = path.dirname(args[oIdx + 1]);
    for (const [name, content] of Object.entries(filesByName)) {
      fs.writeFileSync(path.join(dir, name), content);
    }
    if (throwAfter) throw throwAfter;
    return { stdout: '', stderr: '' };
  };
}

const NOOP_PUBLIC = async () => {};

/* ---------- subtitlesToText ---------- */

test('subtitlesToText parses VTT, strips tags, decodes entities, dedupes rolling lines', () => {
  const vtt = [
    'WEBVTT',
    'Kind: captions',
    'Language: en',
    '',
    '00:00:01.000 --> 00:00:03.000 align:start position:0%',
    'hello<00:00:01.500><c> world</c>',
    '',
    '00:00:03.000 --> 00:00:05.000',
    'hello world',
    '',
    '00:00:05.000 --> 00:00:07.000',
    'this is a &amp; test',
    '',
  ].join('\n');
  assert.equal(subtitlesToText(vtt), 'hello world\nthis is a & test');
});

test('subtitlesToText parses SRT (drops cue indices + timestamps)', () => {
  const srt = [
    '1',
    '00:00:01,000 --> 00:00:03,000',
    'First line',
    '',
    '2',
    '00:00:03,000 --> 00:00:05,000',
    'Second line',
    '',
  ].join('\n');
  assert.equal(subtitlesToText(srt), 'First line\nSecond line');
});

test('subtitlesToText keeps numeric-only caption text (not just SRT cue indices)', () => {
  const srt = [
    '1',
    '00:00:01,000 --> 00:00:03,000',
    '2026', // numeric-only caption text — must be KEPT
    '',
    '2',
    '00:00:03,000 --> 00:00:05,000',
    'was a good year',
    '',
  ].join('\n');
  assert.equal(subtitlesToText(srt), '2026\nwas a good year');
});

test('subtitlesToText is empty-safe', () => {
  assert.equal(subtitlesToText(''), '');
  assert.equal(subtitlesToText(null), '');
  assert.equal(subtitlesToText(undefined), '');
});

test('subtitlesToText collapses YouTube rolling-window captions (prefix growth)', () => {
  const vtt = [
    'WEBVTT',
    '',
    '00:00:00.000 --> 00:00:02.000',
    'the quick brown',
    '',
    '00:00:02.000 --> 00:00:04.000',
    'the quick brown fox',
    '',
    '00:00:04.000 --> 00:00:06.000',
    'the quick brown fox jumps',
    '',
    '00:00:06.000 --> 00:00:08.000',
    'over the lazy dog',
    '',
  ].join('\n');
  assert.equal(subtitlesToText(vtt), 'the quick brown fox jumps\nover the lazy dog');
});

/* ---------- isYoutubeVideoUrl / extractYoutubeVideoId (SSRF surface bound) ---------- */

test('extractYoutubeVideoId / isYoutubeVideoUrl accept only real video URLs', () => {
  // Accepted shapes — all resolve to the same canonical id.
  for (const u of [
    `https://www.youtube.com/watch?v=${VID}`,
    `https://youtube.com/watch?v=${VID}&list=PLxxxx&t=42`, // extra params ignored
    `https://m.youtube.com/watch?v=${VID}`,
    `https://music.youtube.com/watch?v=${VID}`,
    `https://youtu.be/${VID}`,
    `https://youtu.be/${VID}?t=30`,
    `https://www.youtube.com/shorts/${VID}`,
    `https://www.youtube.com/embed/${VID}`,
    `https://www.youtube.com/live/${VID}`,
    `https://www.youtube.com/v/${VID}`,
    `https://www.youtube-nocookie.com/embed/${VID}`,
    // userinfo before `@` is NOT the host — this really points at youtube.com
    `https://evil.com@youtube.com/watch?v=${VID}`,
  ]) {
    assert.equal(extractYoutubeVideoId(u), VID, u);
    assert.equal(isYoutubeVideoUrl(u), true, u);
  }
  // ids legitimately contain `_` and `-` — the 11-char class must accept them.
  assert.equal(extractYoutubeVideoId('https://youtu.be/a_b-c1234XY'), 'a_b-c1234XY');
  // Refused — incl. the codex P1 open-redirect vector and YouTube-host non-video paths.
  for (const u of [
    `https://www.youtube.com/redirect?q=http://169.254.169.254/latest/meta-data`,
    'https://www.youtube.com/results?search_query=x',
    'https://www.youtube.com/playlist?list=PLxxxx',
    'https://www.youtube.com/channel/UCabc',
    'https://www.youtube.com/', // bare host, no video
    'https://www.youtube.com/watch?v=tooShort',
    `https://example.com/watch?v=${VID}`,
    `https://evil-youtube.com/watch?v=${VID}`,
    `https://youtube.com.attacker.com/watch?v=${VID}`,
    // classic userinfo spoof — host is evil.com, not youtube.com
    `https://youtube.com@evil.com/watch?v=${VID}`,
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/x',
    'not a url',
  ]) {
    assert.equal(extractYoutubeVideoId(u), null, u);
    assert.equal(isYoutubeVideoUrl(u), false, u);
  }
});

/* ---------- pickSubtitleFile ---------- */

test('pickSubtitleFile prefers the first language pref, then srt over vtt', () => {
  assert.equal(
    pickSubtitleFile(['sub.info.json', 'sub.fr.vtt', 'sub.en.vtt'], ['en', 'fr']),
    'sub.en.vtt',
  );
  // srt slightly preferred within the same language
  assert.equal(pickSubtitleFile(['sub.en.vtt', 'sub.en.srt'], ['en']), 'sub.en.srt');
  // hyphenated locale (`en-US`) matches the `en` pref
  assert.equal(pickSubtitleFile(['sub.en-US.vtt'], ['en']), 'sub.en-US.vtt');
});

test('pickSubtitleFile falls back to any subtitle when no pref matches, null when none', () => {
  assert.equal(pickSubtitleFile(['sub.es.vtt'], ['en']), 'sub.es.vtt');
  assert.equal(pickSubtitleFile(['sub.info.json', 'video.mp4'], ['en']), null);
  assert.equal(pickSubtitleFile([], ['en']), null);
});

/* ---------- resolveYtdlpPath ---------- */

test('resolveYtdlpPath honours YTDLP_PATH, else bare yt-dlp', () => {
  const old = process.env.YTDLP_PATH;
  try {
    delete process.env.YTDLP_PATH;
    assert.equal(resolveYtdlpPath(), 'yt-dlp');
    process.env.YTDLP_PATH = '/opt/bin/yt-dlp';
    assert.equal(resolveYtdlpPath(), '/opt/bin/yt-dlp');
  } finally {
    if (old !== undefined) process.env.YTDLP_PATH = old;
    else delete process.env.YTDLP_PATH;
  }
});

/* ---------- fetchYoutubeTranscriptViaYtdlp ---------- */

test('fetchYoutubeTranscriptViaYtdlp assembles markdown from the downloaded captions', async () => {
  const execFileImpl = writerExecFile({
    'sub.en.vtt': 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello there\n',
    'sub.info.json': JSON.stringify({ title: 'My Vid', uploader: 'Chan', duration: 75 }),
  });
  const md = await fetchYoutubeTranscriptViaYtdlp(`https://www.youtube.com/watch?v=${VID}`, {
    execFileImpl,
    assertPublic: NOOP_PUBLIC,
  });
  assert.match(md, /^# My Vid$/m);
  assert.match(md, /\*\*Source:\*\* https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ/);
  assert.match(md, /\*\*Uploader:\*\* Chan/);
  assert.match(md, /\*\*Duration:\*\* 1:15/);
  assert.match(md, /lang: en/);
  assert.match(md, /Hello there/);
});

test('fetchYoutubeTranscriptViaYtdlp uses a generic heading when info.json is absent', async () => {
  const execFileImpl = writerExecFile({
    'sub.en.vtt': 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nNo metadata here\n',
  });
  const md = await fetchYoutubeTranscriptViaYtdlp(`https://youtu.be/${VID}`, {
    execFileImpl,
    assertPublic: NOOP_PUBLIC,
  });
  assert.match(md, /^# YouTube transcript$/m);
  assert.match(md, /No metadata here/);
});

test('fetchYoutubeTranscriptViaYtdlp throws a clear install hint when yt-dlp is absent', async () => {
  const execFileImpl = async () => {
    const e = new Error('spawn yt-dlp ENOENT');
    e.code = 'ENOENT';
    throw e;
  };
  await assert.rejects(
    () => fetchYoutubeTranscriptViaYtdlp(`https://youtu.be/${VID}`, { execFileImpl, assertPublic: NOOP_PUBLIC }),
    /yt-dlp executable not found/,
  );
});

test('fetchYoutubeTranscriptViaYtdlp hints on the Windows .cmd-spawn ban', async () => {
  const execFileImpl = async () => {
    const e = new Error('bad name');
    e.code = 'ERR_CHILD_PROCESS_BAD_NAME';
    throw e;
  };
  await assert.rejects(
    () => fetchYoutubeTranscriptViaYtdlp(`https://youtu.be/${VID}`, { execFileImpl, assertPublic: NOOP_PUBLIC }),
    /\.cmd\/\.bat wrapper/,
  );
});

test('fetchYoutubeTranscriptViaYtdlp errors clearly when no caption track was produced', async () => {
  const execFileImpl = writerExecFile({ 'sub.info.json': '{}' }); // info but no subs
  await assert.rejects(
    () => fetchYoutubeTranscriptViaYtdlp(`https://youtu.be/${VID}`, { execFileImpl, assertPublic: NOOP_PUBLIC }),
    /no captions/,
  );
});

test('fetchYoutubeTranscriptViaYtdlp tolerates a non-zero exit when a caption track was still written', async () => {
  // yt-dlp can exit non-zero because ONE requested language 429'd while another
  // succeeded. We must still return the track that landed on disk.
  const partialFail = Object.assign(new Error('one language failed'), {
    code: 1,
    stderr: 'ERROR: unable to download subtitle for fr (HTTP 429)',
  });
  const execFileImpl = writerExecFile(
    { 'sub.en.vtt': 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nPartial ok\n' },
    { throwAfter: partialFail },
  );
  const md = await fetchYoutubeTranscriptViaYtdlp(`https://youtu.be/${VID}`, {
    execFileImpl,
    assertPublic: NOOP_PUBLIC,
  });
  assert.match(md, /Partial ok/);
});

test('fetchYoutubeTranscriptViaYtdlp refuses an oversized caption file (memory cap)', async () => {
  const big = `WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n${'x'.repeat(5000)}\n`;
  const execFileImpl = writerExecFile({ 'sub.en.vtt': big });
  await assert.rejects(
    () =>
      fetchYoutubeTranscriptViaYtdlp(`https://youtu.be/${VID}`, {
        execFileImpl,
        assertPublic: NOOP_PUBLIC,
        maxSubtitleBytes: 1000,
      }),
    /exceeding the 1000-byte cap/,
  );
});

test('fetchYoutubeTranscriptViaYtdlp errors when the caption track parses to empty text', async () => {
  const execFileImpl = writerExecFile({ 'sub.en.vtt': 'WEBVTT\n\n' }); // header only
  await assert.rejects(
    () => fetchYoutubeTranscriptViaYtdlp(`https://youtu.be/${VID}`, { execFileImpl, assertPublic: NOOP_PUBLIC }),
    /parsed to empty text/,
  );
});

test('fetchYoutubeTranscriptViaYtdlp refuses SSRF / non-http URLs before spawning', async () => {
  let spawned = false;
  const execFileImpl = async () => {
    spawned = true;
    return { stdout: '' };
  };
  await assert.rejects(
    () => fetchYoutubeTranscriptViaYtdlp('http://127.0.0.1/x', { execFileImpl, assertPublic: NOOP_PUBLIC }),
    /potentially dangerous/,
  );
  await assert.rejects(
    () => fetchYoutubeTranscriptViaYtdlp('file:///etc/passwd', { execFileImpl, assertPublic: NOOP_PUBLIC }),
    /http/,
  );
  // Public but NON-YouTube URL — refused by the host gate so yt-dlp can't be
  // used as a broad network gadget (codex P1 / Code Reviewer IMPORTANT #1).
  await assert.rejects(
    () => fetchYoutubeTranscriptViaYtdlp('https://example.com/video', { execFileImpl, assertPublic: NOOP_PUBLIC }),
    /only supports YouTube/,
  );
  assert.equal(spawned, false, 'execFile must not run for a refused URL');
});

/* ---------- --js-runtimes, 429 diagnosis, YTDLP_PROXY / YTDLP_COOKIES ---------- */

const CAPTION = { 'sub.en.vtt': 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello there\n' };
const NODE_EXEC = path.join(path.sep === '\\' ? 'C:\\nodejs' : '/usr/local/bin', path.sep === '\\' ? 'node.exe' : 'node');

/** A recorder around writerExecFile: keeps every argv it was handed. */
function recordingExecFile(filesByName, behaviours = []) {
  const calls = [];
  const write = writerExecFile(filesByName);
  const impl = async (cmd, args, options) => {
    calls.push([...args]);
    const b = behaviours[calls.length - 1];
    if (b) throw b;
    return write(cmd, args, options);
  };
  return { impl, calls };
}

test('yt-dlp is handed THIS Node as its JavaScript runtime, and the URL still sits after --', async () => {
  const { impl, calls } = recordingExecFile(CAPTION);
  await fetchYoutubeTranscriptViaYtdlp(`https://youtu.be/${VID}`, {
    execFileImpl: impl, assertPublic: NOOP_PUBLIC, env: {}, execPath: NODE_EXEC,
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes(`--js-runtimes=node:${NODE_EXEC}`), calls[0].join(' '));
  const dd = calls[0].indexOf('--');
  assert.equal(dd, calls[0].length - 2, '-- must be the last-but-one argument');
  assert.equal(calls[0][dd + 1], `https://www.youtube.com/watch?v=${VID}`);
});

test('jsRuntimeArg: only a real node binary is named; an Electron host falls back to PATH lookup', () => {
  assert.equal(jsRuntimeArg('/usr/bin/node'), 'node:/usr/bin/node');
  assert.equal(jsRuntimeArg('C:\\Program Files\\nodejs\\node.exe'), 'node:C:\\Program Files\\nodejs\\node.exe');
  assert.equal(jsRuntimeArg('D:\\apps\\ElectronHost\\host.exe'), 'node');
  assert.equal(jsRuntimeArg('/opt/Electron/electron'), 'node');
  assert.equal(jsRuntimeArg(null), 'node');
  assert.equal(jsRuntimeArg(''), 'node');
});

test('an old yt-dlp that rejects --js-runtimes is retried ONCE without it, and the result says so', async () => {
  const old = Object.assign(new Error('Command failed'), {
    code: 2, stderr: 'Usage: yt-dlp [OPTIONS] URL [URL...]\n\nyt-dlp: error: no such option: --js-runtimes\n',
  });
  const { impl, calls } = recordingExecFile(CAPTION, [old]);
  const md = await fetchYoutubeTranscriptViaYtdlp(`https://youtu.be/${VID}`, {
    execFileImpl: impl, assertPublic: NOOP_PUBLIC, env: {}, execPath: NODE_EXEC,
  });
  assert.equal(calls.length, 2, 'exactly one retry');
  assert.ok(calls[0].some((a) => a.startsWith('--js-runtimes')));
  assert.equal(calls[1].some((a) => a.startsWith('--js-runtimes')), false, 'the retry drops the option');
  assert.match(md, /Hello there/);
  assert.match(md, /older than 2025\.11\.12/);
});

test('any OTHER failure is not retried', async () => {
  const other = Object.assign(new Error('Command failed'), { code: 1, stderr: 'ERROR: Video unavailable' });
  const { impl, calls } = recordingExecFile({}, [other]);
  await assert.rejects(
    () => fetchYoutubeTranscriptViaYtdlp(`https://youtu.be/${VID}`, { execFileImpl: impl, assertPublic: NOOP_PUBLIC, env: {} }),
    (e) => /no captions/.test(e.message) && /Video unavailable/.test(e.message),
  );
  assert.equal(calls.length, 1);
});

test('HTTP 429 / bot check → an explicit "your IP is blocked" diagnosis naming cookies and proxy', async () => {
  for (const stderr of [
    'ERROR: [youtube] dQw4w9WgXcQ: Unable to download API page: HTTP Error 429: Too Many Requests',
    "ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies",
  ]) {
    const { impl } = recordingExecFile({}, [Object.assign(new Error('Command failed'), { code: 1, stderr })]);
    await assert.rejects(
      () => fetchYoutubeTranscriptViaYtdlp(`https://youtu.be/${VID}`, { execFileImpl: impl, assertPublic: NOOP_PUBLIC, env: {} }),
      (e) => /rate-limited or blocked/.test(e.message)
        && /datacenter/.test(e.message)
        && /YTDLP_COOKIES=<absolute path/.test(e.message)
        && /YTDLP_PROXY=/.test(e.message)
        && /workspace \.env does NOT set these/.test(e.message),
    );
  }
});

test('YTDLP_PROXY becomes --proxy before the URL; a bad value is refused BEFORE anything spawns, credentials masked', async () => {
  const { impl, calls } = recordingExecFile(CAPTION);
  await fetchYoutubeTranscriptViaYtdlp(`https://youtu.be/${VID}`, {
    execFileImpl: impl, assertPublic: NOOP_PUBLIC, env: { YTDLP_PROXY: 'socks5h://127.0.0.1:1080' },
  });
  const i = calls[0].indexOf('--proxy=socks5h://127.0.0.1:1080');
  assert.ok(i >= 0 && i < calls[0].indexOf('--'), calls[0].join(' '));

  for (const p of ['http://10.0.0.1:3128', 'https://p.example:443', 'socks4://h:1', 'socks5://h:1']) {
    assert.equal(readYtdlpNetworkSettings({ YTDLP_PROXY: p }).proxy, p);
  }
  let spawned = 0;
  for (const bad of ['ftp://user:hunter2@h:21', 'not a url', 'file:///etc/passwd', 'http://', '--exec=calc']) {
    await assert.rejects(
      () => fetchYoutubeTranscriptViaYtdlp(`https://youtu.be/${VID}`, {
        execFileImpl: async () => { spawned += 1; return {}; }, assertPublic: NOOP_PUBLIC, env: { YTDLP_PROXY: bad },
      }),
      (e) => /YTDLP_PROXY/.test(e.message) && !e.message.includes('hunter2'),
      bad,
    );
  }
  assert.equal(spawned, 0);
});

test('YTDLP_COOKIES: absolute + existing, handed to yt-dlp as a PRIVATE COPY the user file never sees rewritten', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdlp-cookies-test-'));
  try {
    const jar = path.join(dir, 'cookies.txt');
    const original = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tabc\n';
    fs.writeFileSync(jar, original);
    let seenCopy = null;
    const impl = async (cmd, args, options) => {
      const c = args.find((a) => a.startsWith('--cookies='));
      seenCopy = c && c.slice('--cookies='.length);
      assert.equal(fs.readFileSync(seenCopy, 'utf8'), original, 'the copy carries the jar');
      fs.writeFileSync(seenCopy, 'rewritten by yt-dlp'); // what `--cookies` does on exit
      return writerExecFile(CAPTION)(cmd, args, options);
    };
    await fetchYoutubeTranscriptViaYtdlp(`https://youtu.be/${VID}`, {
      execFileImpl: impl, assertPublic: NOOP_PUBLIC, env: { YTDLP_COOKIES: jar },
    });
    assert.ok(seenCopy, '--cookies must be passed');
    assert.notEqual(path.resolve(seenCopy), path.resolve(jar), 'yt-dlp must not get the user file itself');
    assert.equal(fs.readFileSync(jar, 'utf8'), original, 'the user export is untouched');
    assert.equal(fs.existsSync(seenCopy), false, 'the copy is removed with the temp dir');

    let spawned = 0;
    const never = async () => { spawned += 1; return {}; };
    await assert.rejects(
      () => fetchYoutubeTranscriptViaYtdlp(`https://youtu.be/${VID}`, { execFileImpl: never, assertPublic: NOOP_PUBLIC, env: { YTDLP_COOKIES: 'cookies.txt' } }),
      /ABSOLUTE path/,
    );
    await assert.rejects(
      () => fetchYoutubeTranscriptViaYtdlp(`https://youtu.be/${VID}`, { execFileImpl: never, assertPublic: NOOP_PUBLIC, env: { YTDLP_COOKIES: path.join(dir, 'missing.txt') } }),
      /not an existing file/,
    );
    await assert.rejects(
      () => fetchYoutubeTranscriptViaYtdlp(`https://youtu.be/${VID}`, { execFileImpl: never, assertPublic: NOOP_PUBLIC, env: { YTDLP_COOKIES: dir } }),
      /not an existing file/,
    );
    assert.equal(spawned, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the 429 message says when cookies/proxy were ALREADY in use', async () => {
  const { impl } = recordingExecFile({}, [Object.assign(new Error('x'), { code: 1, stderr: 'HTTP Error 429: Too Many Requests' })]);
  await assert.rejects(
    () => fetchYoutubeTranscriptViaYtdlp(`https://youtu.be/${VID}`, { execFileImpl: impl, assertPublic: NOOP_PUBLIC, env: { YTDLP_PROXY: 'http://p.example:8080' } }),
    /WITH YTDLP_PROXY in use/,
  );
});

test('POLICY: a workspace .env cannot set YTDLP_PROXY or YTDLP_COOKIES', () => {
  // A cloned repository choosing the proxy every caption fetch goes through
  // is the attack; the loader's allowlist is what refuses it.
  for (const k of ['YTDLP_PROXY', 'YTDLP_COOKIES', 'YTDLP_PATH']) {
    assert.equal(classifyWorkspaceDotenvKey(k), 'ignore', k);
  }
});

test('the ENOENT hint recommends yt-dlp[default,curl-cffi] through uv or pipx', async () => {
  const execFileImpl = async () => { throw Object.assign(new Error('spawn yt-dlp ENOENT'), { code: 'ENOENT' }); };
  await assert.rejects(
    () => fetchYoutubeTranscriptViaYtdlp(`https://youtu.be/${VID}`, { execFileImpl, assertPublic: NOOP_PUBLIC, env: {} }),
    (e) => /uv tool install "yt-dlp\[default,curl-cffi\]"/.test(e.message) && /pipx install "yt-dlp\[default,curl-cffi\]"/.test(e.message),
  );
});

/* ---------- the primary path: "fetch failed" carries its cause ---------- */

test('toMarkdown: an undici "fetch failed" surfaces err.cause (code + message), host and pinned IP', async () => {
  const cases = [
    [Object.assign(new Error('Connect Timeout Error (attempted address: 142.250.0.1:443, timeout: 10000ms)'), { code: 'UND_ERR_CONNECT_TIMEOUT' }), /UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error/],
    [Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), /read ECONNRESET/],
    [Object.assign(new Error('getaddrinfo ENOTFOUND www.youtube.com'), { code: 'ENOTFOUND' }), /ENOTFOUND/],
    [Object.assign(new Error('unable to get local issuer certificate'), { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' }), /UNABLE_TO_GET_ISSUER_CERT_LOCALLY: unable to get local issuer certificate/],
  ];
  for (const [cause, re] of cases) {
    let fetched = 0;
    await assert.rejects(
      () => toMarkdown({ url: `https://www.youtube.com/watch?v=${VID}` }, {
        resolveHost: async () => ({ address: '142.250.0.1', family: 4 }),
        fetch: async () => { fetched += 1; throw new TypeError('fetch failed', { cause }); },
      }),
      (e) => /fetch failed/.test(e.message) && re.test(e.message)
        && /www\.youtube\.com \(142\.250\.0\.1\)/.test(e.message),
    );
    assert.equal(fetched, 1);
  }
});

test('describeFetchFailure: AggregateError children, timeouts, and a bounded chain', () => {
  const agg = new AggregateError([
    Object.assign(new Error('connect ETIMEDOUT 1.2.3.4:443'), { code: 'ETIMEDOUT' }),
    Object.assign(new Error('connect ENETUNREACH ::1:443'), { code: 'ENETUNREACH' }),
  ], 'all attempts failed');
  const d = describeFetchFailure(new TypeError('fetch failed', { cause: agg }));
  assert.match(d, /ETIMEDOUT/);
  assert.match(d, /ENETUNREACH/);
  const t = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  assert.match(describeFetchFailure(t), /timed out after 30 s/);
  // A self-referencing cause must not loop, and no cause = the message alone.
  const loop = new Error('fetch failed'); loop.cause = loop;
  assert.equal(describeFetchFailure(loop), 'fetch failed');
  assert.equal(describeFetchFailure(new Error('plain')), 'plain');
});

/* ---------- youtubeToMarkdown wiring ---------- */

// CHANGED DELIBERATELY: the primary here used to be '# primary ok', and "no
// fallback" was the rule for ANY successful primary. The rule is now "no
// fallback when the primary carries a transcript", so this primary has one.
const WITH_TRANSCRIPT = '# YouTube\n\n## My Vid\n\n### Description\nabout\n\n### Transcript\nhello from markitdown\n';

test('youtubeToMarkdown returns a primary WITH a transcript without invoking the fallback', async () => {
  let fbCalled = false;
  const out = await youtubeToMarkdown(
    null,
    { url: `https://youtu.be/${VID}` },
    {
      primary: async () => WITH_TRANSCRIPT,
      fallback: async () => {
        fbCalled = true;
        return '# fb';
      },
    },
  );
  assert.equal(out, WITH_TRANSCRIPT);
  assert.equal(fbCalled, false);
});

test('markdownHasTranscript: the "### Transcript" section markitdown emits, with text under it', () => {
  assert.equal(markdownHasTranscript(WITH_TRANSCRIPT), true);
  assert.equal(markdownHasTranscript('## Transcript\r\n\r\nsome words'), true);
  assert.equal(markdownHasTranscript('# Title\n\npage text only'), false);
  assert.equal(markdownHasTranscript('### Transcript\n\n### Next\nx'), false, 'an empty section is not a transcript');
  assert.equal(markdownHasTranscript('### Transcript\n'), false);
  assert.equal(markdownHasTranscript('The Transcript is below'), false, 'prose is not a heading');
  assert.equal(markdownHasTranscript(null), false);
});

test('a primary that SUCCEEDS WITHOUT a transcript → yt-dlp runs, its transcript is returned with a note', async () => {
  let fbUrl = null;
  const out = await youtubeToMarkdown(null, { url: `https://www.youtube.com/watch?v=${VID}` }, {
    primary: async () => '# Rick Astley - Never Gonna Give You Up\n\nSome page text, no captions.\n',
    fallback: async (u) => { fbUrl = u; return '# My Vid\n\n> **Source:** x\n\nHello there\n'; },
  });
  assert.equal(fbUrl, `https://www.youtube.com/watch?v=${VID}`);
  assert.match(out, /Hello there/);
  assert.match(out, /produced no transcript, so the transcript above was fetched with yt-dlp/);
});

test('primary without a transcript AND a failing yt-dlp → the primary is RETURNED with a warning naming why', async () => {
  const page = '# Page title\n\nSome page text.\n';
  const out = await youtubeToMarkdown(null, { url: `https://youtu.be/${VID}` }, {
    primary: async () => page,
    fallback: async () => {
      throw new Error("yt-dlp was refused by YouTube for x: this machine's IP address is rate-limited or blocked (HTTP 429)\nmore");
    },
  });
  assert.ok(out.endsWith(page), 'the page text is kept, not discarded');
  assert.match(out, /no transcript could be obtained/);
  assert.match(out, /rate-limited or blocked \(HTTP 429\) more/, 'the yt-dlp reason, on one line');
});

test('a non-VIDEO YouTube URL or a non-YouTube URL: a successful primary is returned untouched, no fallback', async () => {
  for (const url of ['https://www.youtube.com/channel/UCabc', 'https://www.youtube.com/playlist?list=PLxx', 'https://example.com/page']) {
    let fbCalled = false;
    const out = await youtubeToMarkdown(null, { url }, {
      primary: async () => '# no transcript here',
      fallback: async () => { fbCalled = true; return 'x'; },
    });
    assert.equal(out, '# no transcript here', url);
    assert.equal(fbCalled, false, url);
  }
});

test('youtubeToMarkdown falls back to yt-dlp when the primary path throws', async () => {
  const out = await youtubeToMarkdown(
    null,
    { url: `https://youtu.be/${VID}` },
    {
      primary: async () => {
        throw new Error('Error processing to Markdown: fetch failed');
      },
      fallback: async () => '# transcript via yt-dlp',
    },
  );
  assert.equal(out, '# transcript via yt-dlp');
});

test('youtubeToMarkdown surfaces BOTH errors when primary and fallback fail', async () => {
  await assert.rejects(
    () =>
      youtubeToMarkdown(
        null,
        { url: `https://youtu.be/${VID}` },
        {
          primary: async () => {
            throw new Error('fetch failed');
          },
          fallback: async () => {
            throw new Error('yt-dlp executable not found');
          },
        },
      ),
    (err) =>
      /fetch failed/.test(err.message) &&
      /yt-dlp fallback also failed/.test(err.message) &&
      /not found/.test(err.message),
  );
});

test('youtubeToMarkdown does NOT invoke the yt-dlp fallback for a non-YouTube URL', async () => {
  let fbCalled = false;
  await assert.rejects(
    () =>
      youtubeToMarkdown(
        null,
        { url: 'https://example.com/page' },
        {
          primary: async () => {
            throw new Error('Error processing to Markdown: fetch failed');
          },
          fallback: async () => {
            fbCalled = true;
            return '# fb';
          },
        },
      ),
    // The primary error is surfaced unchanged — no "fallback also failed" suffix.
    (err) => /fetch failed/.test(err.message) && !/yt-dlp fallback/.test(err.message),
  );
  assert.equal(fbCalled, false, 'fallback must not run for a non-YouTube host');
});

test('youtubeToMarkdown rejects a missing url WITHOUT attempting any fallback', async () => {
  let touched = false;
  await assert.rejects(
    () =>
      youtubeToMarkdown(
        null,
        {},
        {
          primary: async () => {
            touched = true;
            return 'x';
          },
          fallback: async () => {
            touched = true;
            return 'y';
          },
        },
      ),
    /Missing required argument: url/,
  );
  assert.equal(touched, false);
});
