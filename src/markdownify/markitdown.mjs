/**
 * Markitdown subprocess wrapper — ported from markdownify-mcp (MIT, Zach Caceres)
 * https://github.com/zcaceres/markdownify-mcp
 *
 * Spawns the `markitdown` Python CLI for file/URL→markdown conversion, and
 * `repomix` for git-repo→markdown. The router talks pure stdin/stdout to
 * these binaries; no Python embedding, no native bindings.
 *
 * Two entry points:
 *   - `toMarkdown({ filePath?, url? })` — local file or remote URL conversion
 *   - `fromRepo({ repoUrl, branch?, compress? })` — git-repo bundling via repomix
 *
 * Both return `{ text }`. Errors are wrapped with the operation context so
 * the MCP error surface stays meaningful (the original markitdown stderr can
 * be very noisy with onnxruntime/pydub warnings — those are non-fatal on a
 * successful run and we drop them).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { Agent } from 'undici';

import {
  findPythonDetailed, isShellSafePath, MARKITDOWN_TOOLS, SKIP_ENV,
} from '../helpers/conversion-readiness.mjs';
import {
  expandHome,
  validateUrl,
  validateRepoUrl,
  validateBranchName,
  isUnconvertedHtml,
  inferExtensionFromUrl,
  resolveMarkitdownPath,
  resolveRepomixCommand,
  assertPathAllowed,
  assertHostnameNotPrivate,
  resolveAndAssertPublic,
} from './utils.mjs';

// Cap URL response bodies at 50 MB. Matches the `maxBuffer` ceilings on the
// markitdown / repomix subprocess output and prevents an attacker-controlled
// URL (the whole purpose of `webpage_to_markdown` / `youtube_to_markdown` /
// `bing_search_to_markdown`) from OOM-ing the router via an unbounded body.
// merged_bug_001 from /ultrareview.
const MAX_URL_BODY_BYTES = 50 * 1024 * 1024;

const execFileAsync = promisify(execFile);

// Project root = two levels up from this file (src/markdownify/markitdown.mjs).
// Used to locate the bundled `.venv/bin/markitdown` and `node_modules/.bin/repomix`.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// EXPORTED so `list_vaults` can probe the same `.venv` this module would run
// from. A second `path.resolve(…, '..', '..')` computed from a different file's
// depth is exactly how the two would come to disagree about where the router is.
export const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Convert a local file or remote URL to markdown via `markitdown`.
 *
 * Exactly one of `filePath` or `url` must be provided. For URLs, the response
 * body is downloaded to a tempfile first (markitdown is a file-based tool)
 * and the temp is cleaned up after conversion succeeds OR fails.
 *
 * Returns `{ text }` on success. Throws a wrapped `Error` on failure — the
 * message is safe to forward as-is to the MCP client.
 */
export async function toMarkdown({ filePath, url, projectRoot = DEFAULT_PROJECT_ROOT, transformContent } = {}) {
  let inputPath;
  let isTemporary = false;

  try {
    if (url) {
      const response = await safeFetch(url);
      const extension = inferExtensionFromUrl(url);
      // Stream the body with a byte budget instead of `response.arrayBuffer()`,
      // which would buffer the entire response into memory before we get a
      // chance to look at its size. merged_bug_001 from /ultrareview.
      let content = await readBodyWithCap(response, MAX_URL_BODY_BYTES, url);

      // v0.14.6 (Phase D.2) — optional `transformContent(buffer, ctx) →
      // Promise<Buffer|string|null>` hook lets the caller mutate the
      // fetched body before it lands in the temp file that markitdown
      // converts. Use case: pre-process HTML to convert `<math>` MathML
      // blocks to `$$LaTeX$$` dollar-delimited strings so equations
      // survive the HTML→markdown step. Returning `null` (or undefined)
      // means "no change — use original buffer" (no-op fast path).
      // Strings are coerced to UTF-8 Buffers.
      //
      // v0.14.7 (P2-2 hardening): ctx now includes parsed Content-Type
      // info. The buffer→string→buffer round-trip via `toString('utf-8')`
      // is only idempotent for UTF-8 input — Windows-1252 / Latin-1 /
      // ISO-8859-* content gets accented chars mangled to U+FFFD (3
      // bytes each, content size grows, surrounding prose corrupted).
      // Real-world risk is low (Wikipedia + modern blogs are UTF-8) but
      // the transform now sees `ctx.charset` and `ctx.contentType` so
      // it can refuse to mutate non-UTF-8 bodies. The hook is policy-
      // free — markitdown.mjs just surfaces the signals.
      if (typeof transformContent === 'function') {
        const rawCt = response.headers?.get?.('content-type') || '';
        const contentType = String(rawCt).toLowerCase().split(';')[0].trim();
        const charsetMatch = /charset\s*=\s*["']?([^"';,\s]+)/i.exec(String(rawCt));
        const charset = charsetMatch ? charsetMatch[1].toLowerCase() : null;
        const transformed = await transformContent(content, { url, extension, contentType, charset });
        if (transformed != null) {
          content = Buffer.isBuffer(transformed) ? transformed : Buffer.from(String(transformed), 'utf-8');
        }
      }

      inputPath = await saveToTempFile(content, extension);
      isTemporary = true;
    } else if (filePath) {
      const expanded = expandHome(filePath);
      assertPathAllowed(expanded);
      inputPath = expanded;
    } else {
      throw new Error('Either filePath or url must be provided');
    }

    const text = await runMarkitdown(inputPath, projectRoot);
    return { text };
  } catch (e) {
    throw new Error(`Error processing to Markdown: ${e?.message ?? 'Unknown error'}`);
  } finally {
    if (isTemporary && inputPath) {
      // Best-effort cleanup of the private mkdtemp dir (see saveToTempFile).
      // `fs.rmSync(dir, { recursive: true, force: true })` is the Node 14.14+
      // idiomatic form — survives both "dir non-empty" (unlink raced with an
      // AV scanner on Windows) and "already gone" (subprocess killed cleanup).
      try {
        fs.rmSync(path.dirname(inputPath), { recursive: true, force: true });
      } catch {}
    }
  }
}

/**
 * Convert a git repository to a single markdown document via `repomix`.
 *
 *   - `repoUrl` is either a GitHub shorthand (`owner/repo`) or a full http(s) URL.
 *   - `branch` selects branch / tag / commit (default: repo's default branch).
 *   - `compress` enables Tree-sitter compression (~70% size reduction).
 *
 * Output (~100 MB max buffer) is captured to stdout — repomix's `--stdout`
 * flag bypasses its on-disk artifact and streams directly back.
 */
export async function fromRepo({ repoUrl, branch, compress, projectRoot = DEFAULT_PROJECT_ROOT } = {}) {
  validateRepoUrl(repoUrl);
  validateBranchName(branch);
  // DNS rebinding guard for the full-URL form (the shorthand `owner/repo`
  // has no hostname to look up — repomix expands it to `github.com/owner/repo`
  // which is known-public). Skip the DNS check on shorthand. Note: repomix
  // performs its own git clone in a subprocess with its own DNS resolution,
  // so IP pinning (the `safeFetch` approach) doesn't apply here — this is
  // best-effort pre-flight only.
  if (repoUrl.includes('://')) {
    const hostname = new URL(repoUrl).hostname;
    await assertHostnameNotPrivate(hostname);
  }
  const { cmd, prefixArgs } = resolveRepomixCommand(projectRoot);

  // `--remote=<url>` (key=value form) so a hypothetical repoUrl starting with
  // `-` cannot be reinterpreted as a flag by repomix's argv parser. The
  // upstream `validateRepoUrl` regex already excludes leading `-`, but this
  // is a cheap second layer.
  const args = [
    ...prefixArgs,
    `--remote=${repoUrl}`,
    '--style',
    'markdown',
    '--stdout',
    '--quiet',
  ];
  if (branch) args.push(`--remote-branch=${branch}`);
  if (compress) args.push('--compress');

  let stdout;
  let stderr;
  try {
    ({ stdout, stderr } = await execFileAsync(cmd, args, {
      maxBuffer: 100 * 1024 * 1024,
    }));
  } catch (e) {
    if (e?.code === 'ENOENT') {
      throw new Error(
        `repomix executable not found (looked up "${cmd}"). ` +
          `Set REPOMIX_PATH or install it on PATH (\`npm install -g repomix\`).`,
      );
    }
    throw e;
  }

  if (!stdout) {
    throw new Error(`repomix produced no output${stderr ? `: ${stderr}` : ''}`);
  }

  return { text: stdout };
}

/**
 * The message for "markitdown is not here", which CHECKS PYTHON FIRST.
 *
 * The previous wording named three fixes and left the reader to discover which
 * one their machine could actually take. Those are different problems: with
 * Python 3.10+ present the toolbox is one command away; without it, sending
 * someone to `install-markitdown` points them at a script that will refuse.
 * This is the one place where spawning is worth it — an error path, once, where
 * the answer changes what the reader does next.
 *
 * The probe is best-effort by construction: if it cannot run, the message falls
 * back to naming all three routes, which is exactly what it said before.
 */
export async function missingMarkitdownMessage(markitdownPath, deps = {}) {
  // Read defensively: this runs ON the error path, and an options object that
  // throws while being read must not replace a useful ENOENT explanation with
  // an unrelated stack trace.
  let projectRoot = DEFAULT_PROJECT_ROOT;
  try {
    if (deps && typeof deps.projectRoot === 'string' && deps.projectRoot) projectRoot = deps.projectRoot;
  } catch { /* keep the default */ }
  const script = path.join(projectRoot, 'scripts', 'install-markitdown.mjs');
  // Same rule as `conversionHint`, and for the same reason: a path carrying
  // `$`, a backtick or a quote does not just look wrong inside a double-quoted
  // command — pasted into a shell it targets the wrong place, or runs something
  // else entirely. Decline to emit it.
  const install = isShellSafePath(script)
    ? `node "${script}"`
    : '`npm run install-markitdown` from the router install directory';
  const head = `markitdown executable not found (looked up "${markitdownPath}"). `
    + `${MARKITDOWN_TOOLS.length} conversion tools depend on it; the router never installs it on its own.`;
  const alternatives = 'Alternatives: `pipx install "markitdown[all]"`, '
    + 'or point MARKITDOWN_PATH at an existing install.';

  // THE OPT-OUT IS HONOURED HERE TOO. `OBSIDIAN_ROUTER_SKIP_MARKITDOWN=1` means
  // "I know, stop offering" — and until now every failed conversion call still
  // spawned a Python probe and printed install commands at someone who had
  // already answered. The one-offer rule was written into the two prose
  // surfaces and silently skipped the one place that fires on EVERY call.
  //
  // The error still has to say what went wrong, so the tool name and the cause
  // stay. What goes is the probe, the sales pitch, and the subprocess.
  const env = (deps && deps.env) || process.env;
  if (env[SKIP_ENV] === '1') {
    return `${head} ${SKIP_ENV}=1 is set, so this is expected — unset it, or `
      + `set MARKITDOWN_PATH, if you want these tools working.`;
  }

  // A FAILURE TO LOOK IS "WE DID NOT LOOK", never "there is no Python".
  // Reading `deps.execFile` can itself throw (a hostile or lazily-computed
  // options object), and the previous `catch { py = null }` sent that straight
  // to the categorical "NO Python answered on PATH" branch — fabricating the
  // exact fact this function exists to stop fabricating.
  let py = { ok: false, rejected: [], checked: false };
  try {
    py = await findPythonDetailed({ execFile: deps.execFile || execFileAsync, timeoutMs: deps.timeoutMs })
      || py;
  } catch {
    py = { ok: false, rejected: [], checked: false };
  }

  if (py?.ok) {
    return `${head} Python ${py.version} IS available (\`${py.cmd}\`), so one command fixes this: `
      + `${install}. ${alternatives}`;
  }
  if (py?.rejected?.length) {
    // Python IS there, just too old — a different problem from "no Python",
    // and one the reader can act on directly.
    //
    // A REJECTION DOES NOT MEAN WE SAW EVERYTHING. python3 reporting 3.9 while
    // `python` returns EACCES is BOTH "too old" and "one we could not read";
    // testing `rejected.length` first used to swallow the second half and send
    // the reader to upgrade an interpreter that may not even be the one that
    // would have worked.
    const found = py.rejected.map((r) => `${r.cmd} ${r.version}`).join(', ');
    const caveat = py.checked === false
      ? ' (another interpreter could not be inspected, so there may be a newer one here)'
      : '';
    return `${head} Python is installed but too old (${found})${caveat}; markitdown needs 3.10+. `
      + `Upgrade, then run ${install}. ${alternatives}`;
  }
  if (py && py.checked === false) {
    // WE COULD NOT LOOK — a timeout, a permission error, a broken shim. Saying
    // "no Python was found" here would be a fabricated fact about the machine,
    // which is the failure this whole file exists to stop making.
    return `${head} Whether Python 3.10+ is available could NOT be determined here. `
      + `If it is installed, run ${install}. ${alternatives}`;
  }
  return `${head} NO Python 3.10+ answered on PATH, so install that first — `
    + `${install} will refuse without it. ${alternatives}`;
}

/**
 * Internal: spawn `markitdown <filePath>` and return its stdout. Throws
 * descriptive errors for the two common failure modes (binary missing →
 * how-to-install hint; SPA returned raw HTML that markitdown couldn't
 * convert → user-actionable diagnostic).
 */
async function runMarkitdown(filePath, projectRoot) {
  const markitdownPath = resolveMarkitdownPath(projectRoot);

  let stdout;
  try {
    // execFile resolves bare command names against PATH (POSIX execvp / Windows
    // search). Non-zero exit codes reject; stderr alone does not (markitdown
    // emits non-fatal warnings from onnxruntime/pydub/etc. on a successful run).
    //
    // The `--` separator stops markitdown (Click-based CLI) from interpreting
    // a filename that begins with `-` as an option. Without it, a filename
    // like `--version` or `-h` would trigger help output and ship that string
    // back as "markdown" (cheap prompt-injection / info-leak surface).
    ({ stdout } = await execFileAsync(markitdownPath, ['--', filePath], {
      maxBuffer: 50 * 1024 * 1024,
    }));
  } catch (e) {
    if (e?.code === 'ENOENT') {
      throw new Error(await missingMarkitdownMessage(markitdownPath));
    }
    throw e;
  }

  if (isUnconvertedHtml(stdout)) {
    throw new Error(
      'Conversion failed: the page returned raw HTML that could not be converted to Markdown. ' +
        'This typically happens with JavaScript-rendered pages (SPAs) that require a browser to load content.',
    );
  }

  return stdout;
}

/**
 * Internal: save a Buffer to a tempfile inside a freshly-minted mkdtemp dir.
 *
 * `mkdtempSync` creates the dir with mode 0700 atomically — no other user can
 * pre-create the path. This closes the TOCTOU symlink-attack window that a
 * predictable `path.join(os.tmpdir(), 'markdown_<pid>_<ms>.html')` would open
 * on a shared POSIX system. The caller is responsible for deletion —
 * `toMarkdown` does it in `finally` (file + parent dir).
 */
async function saveToTempFile(content, suggestedExtension) {
  const ext = suggestedExtension || 'md';
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'markdownify-'));
  const tempOutputPath = path.join(tempDir, `input.${ext}`);
  try {
    fs.writeFileSync(tempOutputPath, content);
  } catch (e) {
    // writeFileSync threw (EACCES, ENOSPC, EMFILE…) — the tempDir is now an
    // orphan because the caller never receives `tempOutputPath` and its
    // `finally` cleanup has nothing to chase. Remove it here so disk doesn't
    // fill up over a long-running session with many failed conversions.
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    throw e;
  }
  return tempOutputPath;
}

/**
 * Internal: fetch with manual redirect handling and per-hop URL validation.
 * Re-runs `validateUrl` on each redirect target so an open redirect on a
 * public host can't be used to pivot to an internal one.
 *
 * Per-request 30s timeout via `AbortSignal.timeout` (Node 17.3+) — protects
 * against slowloris-style endpoints that would otherwise hang the MCP call
 * indefinitely.
 */
async function safeFetch(url, maxRedirects = 10) {
  let currentUrl = url;
  for (let i = 0; i < maxRedirects; i++) {
    validateUrl(currentUrl);
    // SSRF — resolve hostname → IP, validate the IP is public, then PIN it
    // via a custom undici Dispatcher so fetch CANNOT re-resolve at connect
    // time and hit a different (private) address. Closes the DNS rebinding
    // TOCTOU window between the validating lookup and fetch's own
    // getaddrinfo. bug_018 from /ultrareview on v0.11.0 release.
    const hostname = new URL(currentUrl).hostname;
    const { address, family } = await resolveAndAssertPublic(hostname);
    const dispatcher = new Agent({
      connect: {
        // `lookup` is called by undici's connector with `(host, opts, cb)`.
        // We always callback with the pre-resolved address, ignoring `host`
        // entirely — that's the whole point of pinning.
        lookup: (_host, _opts, cb) => cb(null, address, family),
      },
    });
    const response = await fetch(currentUrl, {
      dispatcher,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
    if (
      response.status >= 300 &&
      response.status < 400 &&
      response.headers.get('location')
    ) {
      currentUrl = new URL(response.headers.get('location'), currentUrl).toString();
      continue;
    }
    // Reject 4xx and 5xx. The pre-v0.11.1 code returned them unchanged, so a
    // 404 HTML error page was happily converted to markdown ("# Page Not
    // Found") and shipped to the MCP client as if it were the requested
    // content. merged_bug_001 from /ultrareview.
    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} ${response.statusText || ''} when fetching ${currentUrl}`,
      );
    }
    return response;
  }
  throw new Error('Too many redirects');
}

/**
 * Read a fetch Response body into a Buffer, aborting if it exceeds
 * `capBytes`. Uses the streaming reader so we don't allocate the whole body
 * before we get a chance to look at it.
 *
 * Two checks:
 *   1. `Content-Length` (when present) — refuse upfront so we don't even
 *      start the transfer for an obviously oversized payload.
 *   2. Cumulative `chunk.byteLength` — covers chunked-encoding responses
 *      that omit Content-Length, and catches servers that lie in their
 *      Content-Length header.
 */
async function readBodyWithCap(response, capBytes, urlForError) {
  const cl = parseInt(response.headers.get('content-length') || '0', 10);
  if (Number.isFinite(cl) && cl > capBytes) {
    throw new Error(
      `Refusing ${urlForError}: Content-Length ${cl} exceeds ${capBytes}-byte cap.`,
    );
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    // Some response shapes (e.g. an empty 204) have no body stream. Fall
    // back to arrayBuffer with a post-hoc size check.
    const ab = await response.arrayBuffer();
    if (ab.byteLength > capBytes) {
      throw new Error(
        `Refusing ${urlForError}: response body ${ab.byteLength} bytes exceeds ${capBytes}-byte cap.`,
      );
    }
    return Buffer.from(ab);
  }
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > capBytes) {
      try { await reader.cancel(); } catch {}
      throw new Error(
        `Refusing ${urlForError}: body exceeded ${capBytes}-byte cap mid-stream.`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
