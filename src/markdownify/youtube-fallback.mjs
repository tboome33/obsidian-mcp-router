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
 *   - an allowlisted environment and a private cwd (`subprocess-env.mjs`): the
 *     child never sees the router's process.env, and never reads a
 *     `yt-dlp.conf` out of the user's workspace.
 *   - `validateUrl` (textual SSRF guard) + best-effort DNS pre-flight via
 *     `assertHostnameNotPrivate` (same caveat as `fromRepo`/repomix: yt-dlp
 *     resolves its own DNS in-subprocess, so the pinned-IP dispatcher used by
 *     `safeFetch` cannot be applied here — this is pre-flight only).
 *   - Graceful degradation when yt-dlp is absent: ENOENT → clear install hint
 *     (matches the markitdown ENOENT pattern in markitdown.mjs).
 *   - `--js-runtimes=node:<this Node>` so YouTube's JavaScript challenges can be
 *     solved without deno (retried once without it on a yt-dlp that predates
 *     the option), and an explicit diagnosis when YouTube rate-limits or
 *     bot-checks the machine's IP, pointing at YTDLP_COOKIES / YTDLP_PROXY —
 *     read from the router's own environment only, never a workspace file.
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
import { subprocessOptions, absolutizeExecutableOverride } from '../helpers/subprocess-env.mjs';

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
  // A relative override is resolved against the router's cwd NOW — the spawn
  // runs in the private caption directory (subprocess-env.mjs).
  return absolutizeExecutableOverride(process.env.YTDLP_PATH) || 'yt-dlp';
}

/**
 * The `--js-runtimes` value that hands yt-dlp THIS Node as its JavaScript
 * runtime.
 *
 * Since yt-dlp 2025.11.12, full YouTube support needs an external JavaScript
 * runtime to solve YouTube's challenges (the yt-dlp-ejs scripts), and "Only
 * "deno" is enabled by default" — yt-dlp README, OPTIONS, `--js-runtimes
 * RUNTIME[:PATH]`: "Additional JavaScript runtime to enable, with an optional
 * location for the runtime (either the path to the binary or its containing
 * directory)". https://github.com/yt-dlp/yt-dlp#general-options
 * The value is split with `arg.split(':', 1)` (yt_dlp/__init__.py), so a
 * Windows drive letter in the path survives: `node:C:\…\node.exe`.
 *
 * The router always runs under a Node, so a runtime is always at hand — but
 * `process.execPath` is only a NODE when its name says so. Under an Electron
 * host it is the host application, which run without ELECTRON_RUN_AS_NODE
 * would start the app, not a script engine. Then the bare `node` is enabled
 * and yt-dlp looks it up on PATH itself.
 */
export function jsRuntimeArg(execPath = process.execPath) {
  const base = typeof execPath === 'string' ? path.basename(execPath) : '';
  return /^node(\.exe)?$/i.test(base) ? `node:${execPath}` : 'node';
}

/** yt-dlp older than 2025.11.12 does not know the option: optparse says so, verbatim. */
const NO_SUCH_JS_RUNTIMES = /no such option:?\s*--js-runtimes/i;

/**
 * YouTube refusing THIS MACHINE, not this video: a rate limit (HTTP 429) or
 * the bot check ("Sign in to confirm you're not a bot"). Typical of a
 * datacenter / VPS address. Retrying does not help; cookies or a proxy can.
 */
const YOUTUBE_BLOCKED = /HTTP Error 429|Too Many Requests|Sign in to confirm you/i;

const PROXY_SCHEMES = new Set(['http:', 'https:', 'socks4:', 'socks5:', 'socks5h:']);
// A browser cookie export is a few KB; anything this large is not one.
const MAX_COOKIES_BYTES = 5 * 1024 * 1024;

/** A proxy URL for an error message, with any credentials in it masked. */
function redactProxy(raw) {
  try {
    const u = new URL(raw);
    if (u.username || u.password) { u.username = '***'; u.password = ''; }
    return u.toString();
  } catch {
    return '(unparseable value)';
  }
}

/**
 * The two network settings a user may give yt-dlp: a proxy and a cookie file.
 *
 * WHERE THEY COME FROM — the router's own environment (the MCP host's server
 * declaration, a launcher, a shell), and deliberately NOT a workspace .env
 * file: workspace-dotenv.mjs accepts only the keys it names, and these are not
 * among them. A cloned repository's .env file able to set YTDLP_PROXY would
 * route every caption fetch — and whatever cookies travel with it — through a
 * host the repository's author chose. The same reasoning already keeps
 * `YTDLP_PATH` and `HTTPS_PROXY` out of workspace files.
 *
 * VALIDATED BEFORE ANYTHING RUNS, and refused loudly rather than ignored: a
 * setting the user made that silently does nothing is a debugging session.
 *
 *   YTDLP_PROXY    http/https/socks4/socks5/socks5h URL with a host.
 *   YTDLP_COOKIES  an ABSOLUTE path to an existing regular file (a Netscape
 *                  cookies.txt). Absolute because the child runs in a private
 *                  temp directory, and a relative path would silently mean
 *                  something else there.
 *
 * @returns {{proxy: string|null, cookies: string|null}}
 */
export function readYtdlpNetworkSettings(env = process.env, io = fs) {
  const out = { proxy: null, cookies: null };
  const rawProxy = typeof env.YTDLP_PROXY === 'string' ? env.YTDLP_PROXY.trim() : '';
  if (rawProxy) {
    let u = null;
    try { u = new URL(rawProxy); } catch { /* reported below */ }
    // eslint-disable-next-line no-control-regex
    if (!u || !PROXY_SCHEMES.has(u.protocol) || !u.hostname || /[\s\x00-\x1f]/.test(rawProxy)) {
      throw new Error(
        `YTDLP_PROXY is set to ${redactProxy(rawProxy)}, which is not a usable proxy URL. `
          + 'Expected http://, https://, socks4://, socks5:// or socks5h:// followed by a host '
          + '(e.g. socks5h://127.0.0.1:1080). Fix it or unset it.',
      );
    }
    out.proxy = rawProxy;
  }
  const rawCookies = typeof env.YTDLP_COOKIES === 'string' ? env.YTDLP_COOKIES.trim() : '';
  if (rawCookies) {
    if (!path.isAbsolute(rawCookies)) {
      throw new Error(
        `YTDLP_COOKIES must be an ABSOLUTE path to a Netscape-format cookies.txt (got "${rawCookies}"). `
          + 'yt-dlp runs in a private temporary directory, so a relative path would point somewhere else.',
      );
    }
    let st = null;
    try { st = io.statSync(rawCookies); } catch { /* reported below */ }
    if (!st || !st.isFile()) {
      throw new Error(`YTDLP_COOKIES points at "${rawCookies}", which is not an existing file. Export a Netscape-format cookies.txt there, or unset it.`);
    }
    if (st.size > MAX_COOKIES_BYTES) {
      throw new Error(`YTDLP_COOKIES points at a ${st.size}-byte file — too large for a cookie export (cap ${MAX_COOKIES_BYTES} bytes).`);
    }
    out.cookies = rawCookies;
  }
  return out;
}

/** The message for "YouTube is refusing this machine", naming what is already in use. */
function blockedMessage(url, settings, stderr) {
  const tried = [settings.cookies && 'YTDLP_COOKIES', settings.proxy && 'YTDLP_PROXY'].filter(Boolean);
  const already = tried.length
    ? ` This happened WITH ${tried.join(' and ')} in use — the cookies may be stale or signed out, or the proxy's address blocked as well.`
    : '';
  return `yt-dlp was refused by YouTube for ${url}: this machine's IP address is rate-limited or `
    + 'blocked (HTTP 429 / "Sign in to confirm you\'re not a bot"), which is typical of datacenter '
    + 'and VPS addresses — retrying soon will not help.'
    + `${already} Two ways through, set in the router's own environment (the MCP server `
    + 'declaration; a workspace .env does NOT set these): YTDLP_COOKIES=<absolute path to a Netscape '
    + 'cookies.txt exported from a browser signed in to YouTube>, or YTDLP_PROXY=<http(s):// or '
    + `socks5:// proxy URL, e.g. a residential proxy>. yt-dlp said: ${String(stderr).slice(0, 300)}`;
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

function assembleMarkdown({ url, subFile, transcript, info, ranWithoutJsRuntime = false }) {
  const langMatch = /\.([a-z]{2,3}(?:-[A-Za-z0-9]+)?)\.(?:vtt|srt)$/i.exec(subFile);
  const lang = langMatch ? langMatch[1] : 'unknown';
  const meta = [`**Source:** ${url}`];
  if (info.uploader) meta.push(`**Uploader:** ${info.uploader}`);
  const dur = fmtDuration(info.duration);
  if (dur) meta.push(`**Duration:** ${dur}`);
  meta.push(`_Transcript extracted via the yt-dlp fallback (captions, lang: ${lang})._`);
  if (ranWithoutJsRuntime) {
    meta.push('_Note: this yt-dlp is older than 2025.11.12 (it rejected --js-runtimes) and ran without a JavaScript runtime; upgrade it._');
  }
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
 *   - `opts.env` — where YTDLP_PROXY / YTDLP_COOKIES are read (default: the
 *     router's own environment; see `readYtdlpNetworkSettings`).
 *   - `opts.execPath` — the Node handed to `--js-runtimes` (see `jsRuntimeArg`).
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

  // Read and validated BEFORE the temp dir exists and before anything spawns:
  // a malformed setting is the user's to fix, and must not be half-applied.
  const env = opts.env || process.env;
  const settings = readYtdlpNetworkSettings(env);
  const jsRuntime = jsRuntimeArg(opts.execPath || process.execPath);

  const cmd = resolveYtdlpPath();
  const subLangs = getSubLangs();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdlp-subs-'));
  try {
    // yt-dlp's `--cookies FILE` both reads the jar AND "dump[s] cookie jar in"
    // it (README) — it REWRITES the file on exit. It gets a private copy inside
    // the temp dir, which `finally` removes, so the user's export is never
    // modified and no refreshed session cookie is left behind in it.
    let cookiesCopy = null;
    if (settings.cookies) {
      cookiesCopy = path.join(tempDir, 'cookies.txt');
      fs.copyFileSync(settings.cookies, cookiesCopy);
    }
    const buildArgs = (withJsRuntime) => [
      '--skip-download',
      '--no-playlist',
      '--no-warnings',
      ...(withJsRuntime ? [`--js-runtimes=${jsRuntime}`] : []),
      ...(settings.proxy ? [`--proxy=${settings.proxy}`] : []),
      ...(cookiesCopy ? [`--cookies=${cookiesCopy}`] : []),
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

    // ONE spawn site, called at most twice (see the retry below).
    // `tempDir` is also the working directory. MEASURED: yt-dlp reads a
    // `yt-dlp.conf` from its cwd (its "home configuration"), and the
    // router's cwd is the user's workspace — a repository carrying that
    // file could have appended `--exec …` to every caption fetch. The
    // environment is the yt-dlp allowlist (proxies, CA bundles, the profile
    // roots for its own config), never the router's (subprocess-env.mjs).
    const runYtdlp = (args) => execFileImpl(cmd, args, subprocessOptions('yt-dlp', {
      cwd: tempDir,
      maxBuffer: MAX_YTDLP_STDOUT_BYTES,
      signal: AbortSignal.timeout(YTDLP_TIMEOUT_MS),
    }));

    let execErr = null;
    let ranWithoutJsRuntime = false;
    try {
      try {
        await runYtdlp(buildArgs(true));
      } catch (e) {
        // A yt-dlp older than 2025.11.12 rejects the option before doing
        // anything. Retry ONCE without it rather than fail on our own flag —
        // and say so in the result, because such a yt-dlp is likely to be
        // refused by YouTube's current challenges anyway.
        if (!NO_SUCH_JS_RUNTIMES.test(String(e?.stderr || e?.message || ''))) throw e;
        ranWithoutJsRuntime = true;
        await runYtdlp(buildArgs(false));
      }
    } catch (e) {
      if (e?.code === 'ENOENT') {
        throw new Error(
          `yt-dlp executable not found (looked up "${cmd}"). ` +
            `Install it without admin rights with \`uv tool install "yt-dlp[default,curl-cffi]"\` or ` +
            `\`pipx install "yt-dlp[default,curl-cffi]"\` — the [default] extra brings the JavaScript ` +
            `challenge solver YouTube now requires (https://github.com/yt-dlp/yt-dlp#installation) — ` +
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
      // yt-dlp's stderr (and a spawn error's message, which quotes the
      // command line) can carry the proxy URL, credentials included: masked
      // before any of it reaches an error message.
      let stderr = execErr ? String(execErr.stderr || execErr.message || '') : '';
      if (settings.proxy && stderr.includes(settings.proxy)) stderr = stderr.split(settings.proxy).join(redactProxy(settings.proxy));
      if (YOUTUBE_BLOCKED.test(stderr)) throw new Error(blockedMessage(url, settings, stderr));
      const oldNote = ranWithoutJsRuntime
        ? ' (this yt-dlp predates --js-runtimes, i.e. is older than 2025.11.12 — upgrade it: current YouTube needs its JavaScript challenge solver)'
        : '';
      const detail = execErr ? `: ${stderr.slice(0, 300)}` : '';
      throw new Error(`yt-dlp returned no captions for ${url}${oldNote}${detail}`);
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

    return assembleMarkdown({ url: canonicalUrl, subFile, transcript, info, ranWithoutJsRuntime });
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}
