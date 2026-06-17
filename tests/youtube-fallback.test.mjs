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
import path from 'node:path';

import {
  subtitlesToText,
  pickSubtitleFile,
  resolveYtdlpPath,
  isYoutubeVideoUrl,
  extractYoutubeVideoId,
  fetchYoutubeTranscriptViaYtdlp,
} from '../src/markdownify/youtube-fallback.mjs';

// A real 11-char YouTube video id, reused across the subprocess-seam tests.
const VID = 'dQw4w9WgXcQ';

import { youtubeToMarkdown } from '../src/tools/convert.mjs';

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

/* ---------- youtubeToMarkdown wiring ---------- */

test('youtubeToMarkdown returns the primary result without invoking the fallback', async () => {
  let fbCalled = false;
  const out = await youtubeToMarkdown(
    null,
    { url: `https://youtu.be/${VID}` },
    {
      primary: async () => '# primary ok',
      fallback: async () => {
        fbCalled = true;
        return '# fb';
      },
    },
  );
  assert.equal(out, '# primary ok');
  assert.equal(fbCalled, false);
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
