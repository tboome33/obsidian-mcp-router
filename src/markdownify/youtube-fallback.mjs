/**
 * yt-dlp transcript/caption fallback for `youtube_to_markdown`.
 *
 * Why this exists
 * ---------------
 * The primary `youtube_to_markdown` path wraps MarkItDown's YouTubeConverter
 * (page scrape + youtube-transcript-api). That path is fragile: YouTube's
 * anti-bot measures and page-shape churn make it return
 * "Error processing to Markdown: fetch failed" on videos that DO have captions
 * (observed twice on https://www.youtube.com/watch?v=iYG5tiFfK3E).
 *
 * yt-dlp is far more robust at reaching caption tracks. This module is the
 * SECOND-CHANCE path: when MarkItDown throws, `youtubeToMarkdown` calls
 * `fetchYoutubeTranscriptViaYtdlp(url)`, which shells out to yt-dlp to fetch
 * ONLY the subtitle tracks (no video — `--skip-download`), parses the VTT/SRT
 * to plain text, and assembles a markdown transcript.
 *
 * Contract preserved: returns a plain markdown STRING; writes nothing to any
 * vault, only to a private mkdtemp dir that is removed in `finally`.
 *
 * Subprocess hardening (mirrors markitdown.mjs / utils.mjs):
 *   - `execFile` (never `shell:true`) — no shell metacharacter surface.
 *   - `--` separator before the user-controlled URL so a URL beginning with
 *     `-` can't be reinterpreted as a yt-dlp flag.
 *   - `--no-playlist` / `--skip-download` so a playlist URL can't fan out into
 *     hundreds of downloads and we never pull the (large) video stream.
 *   - key=value argv form for our option values; output template constrained
 *     to the private mkdtemp dir.
 *   - `maxBuffer` cap + per-call `AbortSignal.timeout`.
 *   - `validateUrl` (textual SSRF guard) + best-effort DNS pre-flight via
 *     `assertHostnameNotPrivate` (same caveat as `fromRepo`/repomix: yt-dlp
 *     resolves its own DNS in-subprocess, so the pinned-IP dispatcher used by
 *     `safeFetch` cannot be applied here — this is pre-flight only).
 *   - Graceful degradation when yt-dlp is absent: ENOENT → clear install hint
 *     (matches the markitdown ENOENT pattern in markitdown.mjs).
 *
 * Deliberately NOT using `--convert-subs srt`: that postprocessor needs ffmpeg
 * on some yt-dlp builds. We fetch the native format (`vtt/srt/best`) and parse
 * it in-process, so the fallback depends on yt-dlp ONLY.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import { validateUrl, assertHostnameNotPrivate } from './utils.mjs';

const execFileAsync = promisify(execFile);

// yt-dlp stdout is just progress chatter (the captions land in files), so a
// modest cap is plenty.
const MAX_YTDLP_STDOUT_BYTES = 10 * 1024 * 1024;
// Caption download is quick, but allow for slow networks / yt-dlp retries.
const YTDLP_TIMEOUT_MS = 60_000;
// English variants first — the tool's primary audience, and YouTube
// auto-captions are near-universal in English. Override with a yt-dlp
// `--sub-langs` value via OBSIDIAN_ROUTER_VIDEO_SUBLANGS.
const DEFAULT_SUB_LANGS = 'en.*,en';
// Caption files are read fully into memory before parsing. yt-dlp writes them
// to our tempDir — OUTSIDE the stdout `maxBuffer` cap — so a multi-hour video
// or livestream could otherwise balloon memory. Refuse anything past this cap
// (mirrors the 50 MB body cap on the URL-fetch path). 10 MB ≈ many hours of
// VTT; legitimate transcripts are far smaller. (codex P2)
const MAX_SUBTITLE_BYTES = 10 * 1024 * 1024;

/**
 * Resolve the yt-dlp executable. yt-dlp ships as a standalone binary
 * (`yt-dlp` / `yt-dlp.exe`) — it is NOT an npm package, so there is no
 * `node_modules/.bin/yt-dlp.cmd` shim and the CVE-2024-27980 `.cmd`-spawn ban
 * handled by `resolveRepomixCommand` does not apply to a normal install.
 *
 * Cascade: `YTDLP_PATH` env override → bare `yt-dlp` (libuv's spawn appends
 * PATHEXT on Windows, so this resolves `yt-dlp.exe` on PATH). If `YTDLP_PATH`
 * points at a `.cmd`/`.bat` wrapper on Windows, `execFile` throws
 * `ERR_CHILD_PROCESS_BAD_NAME` and the caller surfaces a clear hint.
 */
export function resolveYtdlpPath() {
  return process.env.YTDLP_PATH || 'yt-dlp';
}

const YT_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YT_PATH_PREFIXES = new Set(['shorts', 'embed', 'live', 'v']);

/**
 * Extract a canonical 11-char YouTube video ID from `url`, or null.
 *
 * This is the SSRF gate for the yt-dlp fallback. A host-only check is NOT
 * enough (codex P1): a YouTube host still exposes open-redirect endpoints like
 * `youtube.com/redirect?q=http://169.254.169.254/…` that yt-dlp's GENERIC
 * extractor would follow OUT of the subprocess, past the router's per-hop
 * pinned-IP SSRF guard. We therefore accept ONLY URLs from which a real video
 * id can be parsed, and the caller rebuilds a clean `…/watch?v=<id>` before
 * spawning yt-dlp — so yt-dlp never sees redirect paths, smuggled query
 * params, or playlist fan-out.
 *
 * Recognised shapes (+ www/m/music subdomains, youtube-nocookie.com):
 *   youtu.be/<id> · youtube.com/watch?v=<id> · youtube.com/{shorts,embed,live,v}/<id>
 * Everything else — /redirect, /results, /playlist, channel pages, the bare
 * host, IP literals, look-alikes like `evil-youtube.com` — returns null.
 */
export function extractYoutubeVideoId(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  const segments = u.pathname.split('/').filter(Boolean);

  if (host === 'youtu.be') {
    return segments.length === 1 && YT_VIDEO_ID.test(segments[0]) ? segments[0] : null;
  }

  const isYtHost =
    host === 'youtube.com' ||
    host.endsWith('.youtube.com') ||
    host === 'youtube-nocookie.com' ||
    host.endsWith('.youtube-nocookie.com');
  if (!isYtHost) return null;

  if (u.pathname === '/watch') {
    const v = u.searchParams.get('v');
    return v && YT_VIDEO_ID.test(v) ? v : null;
  }
  if (segments.length === 2 && YT_PATH_PREFIXES.has(segments[0]) && YT_VIDEO_ID.test(segments[1])) {
    return segments[1];
  }
  return null;
}

/** True when a real YouTube video id can be parsed from `url`. */
export function isYoutubeVideoUrl(url) {
  return extractYoutubeVideoId(url) !== null;
}

function getSubLangs() {
  const raw = process.env.OBSIDIAN_ROUTER_VIDEO_SUBLANGS;
  return raw && raw.trim() ? raw.trim() : DEFAULT_SUB_LANGS;
}

/**
 * Pick the best subtitle file from a temp-dir listing.
 *
 * Preference: each language in `langPrefs` (matched as a `.lang.` / `.lang-`
 * infix in the filename, e.g. `sub.en.vtt`), `.srt` slightly preferred over
 * `.vtt` within a language (no inline timing tags to strip). Returns the
 * filename (not a full path), or null when no subtitle file is present.
 */
export function pickSubtitleFile(filenames, langPrefs = ['en']) {
  const subs = filenames.filter((f) => /\.(vtt|srt)$/i.test(f));
  if (subs.length === 0) return null;
  const score = (f) => {
    const lower = f.toLowerCase();
    // No preferred language matched → rank after every pref. We still return
    // SOME subtitle (rather than nothing): with the default `--sub-langs=en.*,en`
    // yt-dlp writes only English, so this branch fires only if a future
    // OBSIDIAN_ROUTER_VIDEO_SUBLANGS widens the set. The chosen language is
    // always reported in the assembled markdown (`lang: …`) — never silent.
    let langRank = langPrefs.length;
    for (let i = 0; i < langPrefs.length; i++) {
      const lp = langPrefs[i].toLowerCase();
      if (lower.includes(`.${lp}.`) || lower.includes(`.${lp}-`)) {
        langRank = i;
        break;
      }
    }
    const fmtRank = lower.endsWith('.srt') ? 0 : 1;
    return langRank * 10 + fmtRank;
  };
  return subs.slice().sort((a, b) => score(a) - score(b))[0];
}

const ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};
function decodeEntities(s) {
  return s.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m);
}

/**
 * Convert raw VTT or SRT subtitle text to a plain-text transcript.
 *
 * Strips the WEBVTT header, NOTE/STYLE/REGION blocks, Kind:/Language: header
 * lines, cue indices (SRT), timestamp/cue-setting lines (anything with
 * `-->`), and inline `<...>` timing tags (`<00:00:00.000>`, `<c>`). Decodes a
 * handful of HTML entities and de-duplicates consecutive identical lines —
 * YouTube auto-captions roll the same line across adjacent cues.
 */
export function subtitlesToText(raw) {
  if (!raw) return '';
  const text = String(raw).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const out = [];
  let last = null;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line) continue;
    if (/^WEBVTT/i.test(line)) continue;
    if (/^(?:NOTE|STYLE|REGION)\b/i.test(line)) continue;
    if (/^(?:Kind|Language):/i.test(line)) continue;
    if (line.includes('-->')) continue; // timestamp / cue-settings line
    // A pure-integer line is an SRT cue index ONLY when the very next line is a
    // timestamp. A numeric-only line that is real caption text (a year like
    // "2026", a count) is kept rather than silently dropped (codex P2).
    if (/^\d+$/.test(line) && (lines[i + 1] ?? '').includes('-->')) continue;
    line = line.replace(/<[^>]+>/g, ''); // inline VTT timing / styling tags
    line = decodeEntities(line).replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (line === last) continue; // exact rolling-caption duplicate
    // YouTube auto-captions roll a GROWING window: cue N+1 is often cue N's
    // text plus a few more words. Collapse that prefix-growth so the transcript
    // isn't a staircase of redundant fragments (keep the longest form).
    if (last !== null && line.startsWith(`${last} `)) {
      out[out.length - 1] = line;
      last = line;
      continue;
    }
    if (last !== null && last.startsWith(`${line} `)) {
      continue; // shrunk prefix already represented by the previous line
    }
    out.push(line);
    last = line;
  }
  return out.join('\n');
}

function fmtDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function assembleMarkdown({ url, subFile, transcript, info }) {
  const langMatch = /\.([a-z]{2,3}(?:-[A-Za-z0-9]+)?)\.(?:vtt|srt)$/i.exec(subFile);
  const lang = langMatch ? langMatch[1] : 'unknown';
  const meta = [`**Source:** ${url}`];
  if (info.uploader) meta.push(`**Uploader:** ${info.uploader}`);
  const dur = fmtDuration(info.duration);
  if (dur) meta.push(`**Duration:** ${dur}`);
  meta.push(`_Transcript extracted via the yt-dlp fallback (captions, lang: ${lang})._`);
  return [
    `# ${info.title || 'YouTube transcript'}`,
    '',
    meta.map((m) => `> ${m}`).join('\n'),
    '',
    transcript,
    '',
  ].join('\n');
}

/**
 * Fetch a transcript for `url` via yt-dlp and return it as a markdown string.
 *
 * Throws (with a user-safe message) when yt-dlp is missing, the URL is
 * refused by the SSRF guard, or no caption track could be retrieved.
 *
 * Injection seams (default to the real implementations) keep this unit-testable
 * without spawning yt-dlp or hitting the network:
 *   - `opts.execFileImpl(cmd, args, options)` — the subprocess runner.
 *   - `opts.assertPublic(hostname)` — the DNS rebinding pre-flight.
 */
export async function fetchYoutubeTranscriptViaYtdlp(url, opts = {}) {
  const execFileImpl = opts.execFileImpl || execFileAsync;
  const assertPublic = opts.assertPublic || assertHostnameNotPrivate;
  const maxSubtitleBytes = opts.maxSubtitleBytes ?? MAX_SUBTITLE_BYTES;

  // Textual SSRF guard (scheme + private/loopback literals). Throws on
  // file://, http://127.0.0.1/, encoded-loopback, etc.
  validateUrl(url);
  // Bound the fallback's network surface to a real YouTube VIDEO. A host-only
  // check is insufficient (codex P1): YouTube open-redirect endpoints
  // (`/redirect?q=…`) on a youtube.com host would let yt-dlp's generic
  // extractor follow a redirect to a private/metadata target, OUTSIDE the
  // router's per-hop SSRF guard. So we extract a canonical 11-char video id and
  // hand yt-dlp a freshly-rebuilt `…/watch?v=<id>` — never the caller's raw
  // URL — eliminating redirect paths, smuggled params, and playlist fan-out.
  const videoId = extractYoutubeVideoId(url);
  if (!videoId) {
    throw new Error(
      `the yt-dlp transcript fallback only supports YouTube video URLs ` +
        `(could not extract a video id from "${url}").`,
    );
  }
  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
  // Pre-flight DNS check on the canonical host (always youtube.com → public).
  // Kept for parity with `fromRepo` and as an injection seam in tests.
  await assertPublic('www.youtube.com');

  const cmd = resolveYtdlpPath();
  const subLangs = getSubLangs();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdlp-subs-'));
  try {
    const args = [
      '--skip-download',
      '--no-playlist',
      '--no-warnings',
      '--write-subs',
      '--write-auto-subs',
      `--sub-langs=${subLangs}`,
      '--sub-format=vtt/srt/best',
      '--write-info-json',
      '-o',
      path.join(tempDir, 'sub.%(ext)s'),
      '--',
      canonicalUrl,
    ];

    let execErr = null;
    try {
      await execFileImpl(cmd, args, {
        maxBuffer: MAX_YTDLP_STDOUT_BYTES,
        signal: AbortSignal.timeout(YTDLP_TIMEOUT_MS),
      });
    } catch (e) {
      if (e?.code === 'ENOENT') {
        throw new Error(
          `yt-dlp executable not found (looked up "${cmd}"). ` +
            `Install it (https://github.com/yt-dlp/yt-dlp#installation — e.g. ` +
            `\`pipx install yt-dlp\`, \`winget install yt-dlp\`, or \`brew install yt-dlp\`) ` +
            `or set YTDLP_PATH to its absolute location.`,
        );
      }
      if (e?.code === 'ERR_CHILD_PROCESS_BAD_NAME') {
        throw new Error(
          `yt-dlp could not be spawned because "${cmd}" resolves to a .cmd/.bat wrapper, ` +
            `which Node refuses to run without a shell (CVE-2024-27980). ` +
            `Point YTDLP_PATH at the real yt-dlp executable (.exe).`,
        );
      }
      // Non-zero exit (e.g. one requested subtitle language 429'd) — yt-dlp may
      // still have written usable tracks. Remember the error and check the dir.
      execErr = e;
    }

    const files = fs.readdirSync(tempDir);
    const langPrefs = subLangs
      .split(',')
      .map((l) => l.split('.')[0].trim())
      .filter(Boolean);
    const subFile = pickSubtitleFile(files, langPrefs.length ? langPrefs : ['en']);
    if (!subFile) {
      const detail = execErr ? `: ${String(execErr.stderr || execErr.message).slice(0, 300)}` : '';
      throw new Error(`yt-dlp returned no captions for ${url}${detail}`);
    }

    const subPath = path.join(tempDir, subFile);
    const subSize = fs.statSync(subPath).size;
    if (subSize > maxSubtitleBytes) {
      throw new Error(
        `caption file for ${canonicalUrl} is ${subSize} bytes, exceeding the ${maxSubtitleBytes}-byte cap.`,
      );
    }
    const transcript = subtitlesToText(fs.readFileSync(subPath, 'utf-8'));
    if (!transcript.trim()) {
      throw new Error(`yt-dlp downloaded a caption track for ${url} but it parsed to empty text.`);
    }

    let info = {};
    try {
      const infoName = files.find((f) => f.endsWith('.info.json'));
      if (infoName) {
        const infoPath = path.join(tempDir, infoName);
        if (fs.statSync(infoPath).size <= maxSubtitleBytes) {
          const j = JSON.parse(fs.readFileSync(infoPath, 'utf-8'));
          info = { title: j.title, uploader: j.uploader || j.channel, duration: j.duration };
        }
      }
    } catch {
      // Malformed/absent/oversized info.json — fall back to a generic heading.
    }

    return assembleMarkdown({ url: canonicalUrl, subFile, transcript, info });
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}
