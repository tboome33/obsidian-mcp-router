/**
 * Markdownify utilities — ported from markdownify-mcp (MIT, Zach Caceres)
 * https://github.com/zcaceres/markdownify-mcp
 *
 * Helpers around the `markitdown` Python CLI subprocess wrapper:
 *  - path resolution (env var → bundled venv → PATH)
 *  - path sandbox (MD_ALLOWED_PATHS)
 *  - URL validation (SSRF guard: no private IPs, only http/https)
 *  - misc heuristics (was-it-converted, infer extension)
 *
 * Pure JS port — no TypeScript, no Bun, no external deps. The original
 * `private-ip` package is replaced with an inline RFC1918/loopback/link-local
 * check (see `isPrivateIp`).
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import net from 'node:net';
import dns from 'node:dns/promises';
import { URL } from 'node:url';

/**
 * Expand a leading `~` to the user's home directory.
 *
 * `~/foo` → `/home/user/foo`. `~bob/foo` is NOT expanded (Node's `os.homedir()`
 * has no way to look up another user's home).
 */
export function expandHome(filepath) {
  if (filepath === '~' || filepath.startsWith('~/')) {
    return path.join(os.homedir(), filepath.slice(1));
  }
  return filepath;
}

/**
 * Resolve the absolute path to the `markitdown` executable. Priority:
 *
 *   1. `MARKITDOWN_PATH` env var — explicit override (typically when the user
 *      did `pipx install "markitdown[all]"` and wants to point us at it).
 *   2. `<projectRoot>/.venv/bin/markitdown` (POSIX) or
 *      `<projectRoot>\.venv\Scripts\markitdown.exe` (Windows) — created by
 *      the router's `scripts/install-markitdown.mjs` at postinstall time.
 *   3. Bare `markitdown` — let `execFile` look it up on `PATH` (POSIX execvp /
 *      Windows search). Fails with ENOENT at call time if not installed.
 */
export function resolveMarkitdownPath(projectRoot) {
  if (process.env.MARKITDOWN_PATH) return process.env.MARKITDOWN_PATH;
  const isWin = process.platform === 'win32';
  const venvBin = path.join(
    projectRoot,
    '.venv',
    isWin ? 'Scripts' : 'bin',
    `markitdown${isWin ? '.exe' : ''}`,
  );
  if (fs.existsSync(venvBin)) return venvBin;
  return 'markitdown';
}

/**
 * Resolve the absolute path to the `repomix` executable, used by
 * `git_repo_to_markdown`. Same cascade as `resolveMarkitdownPath`:
 *
 *   1. `REPOMIX_PATH` env var
 *   2. `<projectRoot>/node_modules/.bin/repomix` (POSIX) or `.cmd` (Windows)
 *      — installed transitively when the router npm-installs.
 *   3. Bare `repomix` — `PATH` lookup.
 */
export function resolveRepomixPath(projectRoot) {
  if (process.env.REPOMIX_PATH) return process.env.REPOMIX_PATH;
  const isWin = process.platform === 'win32';
  // npm on Windows installs both `repomix` (shim) and `repomix.cmd`. Prefer
  // the .cmd because execFile won't auto-resolve the extensionless shim
  // through CreateProcess.
  const candidates = isWin
    ? ['repomix.cmd', 'repomix.exe', 'repomix']
    : ['repomix'];
  for (const name of candidates) {
    const local = path.join(projectRoot, 'node_modules', '.bin', name);
    if (fs.existsSync(local)) return local;
  }
  return 'repomix';
}

/**
 * Parse `MD_ALLOWED_PATHS` (or its legacy single-dir alias `MD_SHARE_DIR`)
 * into a normalized list of absolute directory paths. Returns `null` when
 * neither is set — meaning "no sandbox, every absolute path is allowed".
 */
export function getAllowedPaths() {
  const raw = process.env.MD_ALLOWED_PATHS ?? process.env.MD_SHARE_DIR;
  if (!raw) return null;
  const dirs = raw
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => path.normalize(path.resolve(expandHome(p))));
  return dirs.length > 0 ? dirs : null;
}

/**
 * Throw if `filePath` is outside every directory listed in `MD_ALLOWED_PATHS`.
 * No-op when the sandbox is not configured.
 */
export function assertPathAllowed(filePath) {
  const allowed = getAllowedPaths();
  if (!allowed) return;
  // Resolve symlinks BEFORE the sandbox check. A lexical `path.resolve` would
  // let an attacker drop a symlink inside `MD_ALLOWED_PATHS` that points at
  // `~/.ssh/id_rsa` (or anywhere) — markitdown follows links transparently
  // and would happily extract the target. `fs.realpathSync` collapses every
  // symlink/junction to its on-disk target. If the path doesn't exist yet,
  // fall back to the lexical resolution (the file open downstream will fail
  // with ENOENT, which is the correct UX — better than a confusing "allowed
  // directories" error on a typo). Codex P2 finding during /review+ pass 1.
  const expanded = expandHome(filePath);
  let resolved;
  try {
    resolved = fs.realpathSync(expanded);
  } catch {
    resolved = path.normalize(path.resolve(expanded));
  }
  // Resolve symlinks on the allowed roots too — otherwise a sandbox root
  // that is itself a symlink wouldn't match the realpath of an inner file.
  const resolvedRoots = allowed.map((dir) => {
    try { return fs.realpathSync(dir); } catch { return dir; }
  });
  if (!resolvedRoots.some((dir) => isWithinDirectory(resolved, dir))) {
    throw new Error(
      `Path "${filePath}" is outside the allowed directories. ` +
        `Set MD_ALLOWED_PATHS to a ${path.delimiter}-separated list that includes a parent directory ` +
        `(currently allowed: ${allowed.join(path.delimiter)}).`,
    );
  }
}

/**
 * Async SSRF guard: after textual hostname validation, resolve the URL via
 * DNS and refuse if the resolved IP is private/loopback.
 *
 * This closes the DNS rebinding hole — a public hostname (`evil.com`) that
 * happens to resolve to `127.0.0.1` passes the textual `isPrivateIp` check
 * but `fetch` then hits loopback. Per-hop DNS resolution must happen on every
 * redirect target, hence why `safeFetch` calls this BEFORE each `fetch`.
 *
 * Failure modes:
 *   - `dns.lookup` throws ENOTFOUND / ECONNREFUSED → caller's fetch will
 *     fail similarly; we re-throw a "DNS failed" error so the caller can
 *     distinguish "user typo" from "we blocked the request".
 *   - The resolved IP is private → we throw a "refusing" error.
 *
 * Cost: one `getaddrinfo` per hop (cached by the OS resolver). Typically
 * sub-millisecond on a warm cache, ~5-50ms on a cold one. Worth the SSRF
 * coverage.
 */
export async function assertHostnameNotPrivate(hostname) {
  if (!hostname) {
    throw new Error('Missing hostname for SSRF DNS check.');
  }
  // If the textual hostname is ALREADY an IP, `dns.lookup` returns it
  // verbatim — we still run the check (defense in depth) but the no-op is fine.
  let resolved;
  try {
    resolved = await dns.lookup(hostname);
  } catch (e) {
    // ENOTFOUND etc. — let the original fetch surface its own error. We don't
    // synthesize a clearer message because the caller might WANT the raw DNS
    // failure (e.g. user mistyped the URL).
    throw new Error(`DNS lookup failed for ${hostname}: ${e.message}`);
  }
  if (isPrivateIp(resolved.address)) {
    throw new Error(
      `Refusing to fetch ${hostname}: resolves to private/loopback IP ${resolved.address}.`,
    );
  }
}

/**
 * Validate a URL before we fetch it.
 *
 *   - Only http(s) — refuses file://, ssh://, gopher://, …
 *   - Refuses RFC1918 / loopback / link-local hosts — SSRF guard so the tool
 *     can't be coerced into hitting internal services. See `isPrivateIp`.
 */
export function validateUrl(url) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http: and https: schemes are allowed.');
  }
  if (isPrivateIp(parsed.hostname)) {
    throw new Error(`Fetching ${url} is potentially dangerous, aborting.`);
  }
}

/**
 * Validate a repository URL passed to `git_repo_to_markdown`. Accepts:
 *
 *   - GitHub shorthand: `owner/repo` (e.g. `zcaceres/markdownify-mcp`)
 *   - Full http(s) URL pointing at a git host
 *
 * Rejects file://, ssh://, git:// — that'd let an attacker exfiltrate any
 * local repo or SSH-tunnel to internal hosts.
 */
export function validateRepoUrl(repoUrl) {
  if (!repoUrl || !repoUrl.trim()) {
    throw new Error('Repository URL is required');
  }
  // GitHub shorthand `owner/repo` — no hostname to SSRF-check.
  if (/^[\w.-]+\/[\w.-]+$/.test(repoUrl)) return;
  // Full URL: must be http(s) AND not point at a private/loopback host —
  // otherwise `repomix --remote=<url>` becomes an SSRF gadget that can reach
  // localhost (`http://127.0.0.1/`), the AWS metadata endpoint
  // (`http://169.254.169.254/`), internal git servers, etc. The upstream
  // markdownify-mcp's `validateRepoUrl` was missing this check too — codex
  // flagged it during /review+ pass 1.
  let parsed;
  try {
    parsed = new URL(repoUrl);
  } catch {
    throw new Error(
      `Invalid repository URL or shorthand: ${repoUrl}. Use a GitHub URL ` +
        `(https://github.com/owner/repo) or shorthand (owner/repo).`,
    );
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http: and https: repository URLs are allowed.');
  }
  if (isPrivateIp(parsed.hostname)) {
    throw new Error(`Fetching ${repoUrl} is potentially dangerous, aborting.`);
  }
}

/**
 * Validate a branch / tag / commit name passed to `git_repo_to_markdown`.
 * The value is forwarded to `repomix` via `--remote-branch <branch>`, which in
 * turn passes it to `git` as a refspec — so we constrain it to characters
 * that can legitimately appear in a git ref:
 *
 *   letters / digits / `.` / `-` / `_` / `/`
 *
 * In particular, leading `-` is refused so the value can't be reinterpreted
 * by repomix's argument parser as a flag.
 */
export function validateBranchName(branch) {
  if (branch === undefined || branch === null) return;
  if (typeof branch !== 'string' || branch.length === 0) {
    throw new Error('branch must be a non-empty string when provided.');
  }
  if (!/^[\w./-]+$/.test(branch) || branch.startsWith('-')) {
    throw new Error(
      `Invalid branch name: ${JSON.stringify(branch)}. ` +
        `Allowed characters: letters, digits, ".", "-", "_", "/". Must not start with "-".`,
    );
  }
}

/**
 * Detect output that's still raw HTML — typically a SPA where the server
 * returned the empty shell and the content gets injected client-side. We
 * can't feed that to the user as "markdown".
 */
export function isUnconvertedHtml(output) {
  const trimmed = output.trimStart();
  return (
    trimmed.startsWith('<!DOCTYPE') ||
    trimmed.startsWith('<!doctype') ||
    trimmed.startsWith('<html')
  );
}

/**
 * Best-effort extension inference for a URL we're about to fetch. Drives
 * the tempfile naming so markitdown picks the right converter.
 */
export function inferExtensionFromUrl(url) {
  if (url.toLowerCase().endsWith('.pdf')) return 'pdf';
  return 'html';
}

/**
 * Is `filePath` inside `directory` (after both are resolved)?
 *
 * Uses a path-segment comparison rather than a naive string prefix — so
 * `/data/foobar` is NOT considered inside `/data/foo`. Cross-platform: on
 * Windows the comparison is case-insensitive (NTFS).
 */
export function isWithinDirectory(filePath, directory) {
  const normPath = path.normalize(path.resolve(filePath));
  const normDir = path.normalize(path.resolve(directory));
  const rel = path.relative(normDir, normPath);
  if (rel.startsWith('..')) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

/**
 * Inline replacement for the `private-ip` npm package. Returns true when the
 * given host is:
 *
 *   - Loopback (127.0.0.0/8, ::1)
 *   - RFC1918 private (10/8, 172.16/12, 192.168/16)
 *   - Link-local (169.254/16, fe80::/10)
 *   - Carrier-grade NAT (100.64.0.0/10)
 *   - Unique-local IPv6 (fc00::/7)
 *   - Hostnames `localhost`, `*.localhost`, `*.local` (mDNS)
 *   - **IPv4-mapped IPv6** (`::ffff:127.0.0.1`) — refused by default
 *   - **Encoded numeric IPv4** (decimal `2130706433`, hex `0x7f000001`, octal
 *     `0177.0.0.1`) — refused by default. The system resolver (`getaddrinfo`)
 *     normalizes these to the underlying IPv4 on POSIX/Windows, so a permissive
 *     string-match validator would let SSRF requests through to loopback.
 *
 * Hostnames that look like regular DNS names (e.g. `example.com`) return
 * false — we don't perform DNS resolution here (would be async + slow + DNS
 * rebinding still possible). Markitdown's fetch step is documented to be the
 * second line of defense if the resolved IP turns out to be private at the
 * actual connection time.
 */
export function isPrivateIp(host) {
  if (!host) return true;
  // Node's URL.hostname returns IPv6 addresses with `[...]` brackets — strip
  // them at the entry so range checks below see the raw address.
  let h = host.toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) {
    h = h.slice(1, -1);
  }
  // Trailing-dot FQDN form (`localhost.`, `example.com.`) is resolved
  // identically to the dotless form by `getaddrinfo` on POSIX and Windows —
  // strip the terminator before the hostname literal checks.
  if (h.endsWith('.') && h.length > 1) {
    h = h.slice(0, -1);
  }

  // 1. Hostname literal rules — apply BEFORE IP parsing so `localhost` is
  //    refused even though `net.isIP('localhost') === 0`.
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) {
    return true;
  }

  // 2. Standard IP parsing via Node's `net.isIP`. Returns 4 for IPv4, 6 for
  //    IPv6, 0 for anything else (including encoded numeric variants like
  //    "2130706433" or "0x7f000001").
  const family = net.isIP(h);
  if (family === 4) return isPrivateIPv4(h);
  if (family === 6) return isPrivateIPv6(h);

  // 3. family === 0 — not a standard IP per net.isIP. The remaining concern is
  //    encoded IPv4 numeric forms that `getaddrinfo` normalizes (POSIX) or
  //    that the URL constructor accepts as `hostname` (some browser libs).
  //    Refusing these by default closes the SSRF bypass without needing async
  //    DNS resolution.
  if (/^\d+$/.test(h)) return true; // pure decimal IPv4 (e.g. "2130706433")
  if (/^0x[\da-f]+$/.test(h)) return true; // hex IPv4 (e.g. "0x7f000001")
  // Any octet beginning with a 0 followed by another digit is octal-encoded
  // (e.g. "0177.0.0.1" or "127.0.0.01"). A lone "0" octet is fine (covered by
  // the `a === 0` branch in isPrivateIPv4, which only matches CANONICAL form).
  if (/(?:^|\.)0\d+(?:\.|$)/.test(h)) return true;
  return false;
}

/**
 * IPv4-specific range check. Caller guarantees `h` is in canonical
 * `A.B.C.D` form (validated upstream by `net.isIP(h) === 4`).
 */
function isPrivateIPv4(h) {
  const parts = h.split('.').map((s) => parseInt(s, 10));
  if (parts.length !== 4) return false;
  const [a, b] = parts;
  if (a === 0) return true; // "this network" — 0.0.0.0/8
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC6598)
  return false;
}

/**
 * IPv6-specific range check. Caller guarantees `h` is a valid IPv6 string
 * (validated upstream by `net.isIP(h) === 6`). Handles:
 *
 *   - `::` (unspecified) and `::1` (loopback)
 *   - `fe80::/10` link-local (`fe80:` through `febf:`)
 *   - `fc00::/7` unique-local (`fc00:`-`fdff:`)
 *   - **IPv4-mapped IPv6** (`::ffff:a.b.c.d` or `::ffff:hhhh:hhhh`) — refused
 *     regardless of the embedded IPv4 (safe default; an attacker can't smuggle
 *     a loopback hit via this notation).
 */
function isPrivateIPv6(h) {
  if (h === '::' || h === '::1') return true;
  // Link-local fe80::/10 = first 10 bits set to fe80 ... febf
  if (/^fe[89ab][0-9a-f]?:/.test(h)) return true;
  // Unique-local fc00::/7 = fc/fd prefix on exactly 4 hex chars (strict to
  // avoid matching `fcafe:` which doesn't exist as an address — but more
  // importantly to avoid false positives on hostnames that happen to start
  // with "fc"; those don't reach here anyway since net.isIP returns 0 for them).
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
  // Site-local fec0::/10 — deprecated by RFC 3879 but still routable on many
  // legacy LANs. Block to avoid LAN-side SSRF gadgets.
  if (/^fe[cdef][0-9a-f]?:/.test(h)) return true;
  // Multicast ff00::/8. No legitimate HTTP fetch target; allowing it would
  // turn the conversion tools into a LAN scanner.
  if (/^ff[0-9a-f]{2}:/.test(h)) return true;
  // IPv4-mapped IPv6 (::ffff:x.y.z.w) or IPv4-translated (64:ff9b::/96).
  // Refused unconditionally — safe default that prevents loopback bypass via
  // `::ffff:127.0.0.1` and similar.
  if (h.startsWith('::ffff:') || h.startsWith('64:ff9b:')) return true;
  return false;
}
