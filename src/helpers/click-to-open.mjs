/**
 * click-to-open URL builder for vault files.
 *
 * Composes the `http://127.0.0.1:<insecurePort>/open/<encoded-path>` URL that
 * the `mcp-router-bridge` plugin (v0.2.0+) serves on every Obsidian vault
 * that has Local REST API's insecure HTTP server enabled. A click on the URL
 * opens the file in Obsidian — no copy-paste of paths, no manual port
 * lookup.
 *
 * The whole point of this helper is to remove the failure mode of the LLM
 * composing the URL by hand: port digits memorised wrong, slashes not
 * encoded, `enableInsecureServer:false` ignored. Tools that touch vault
 * files call this once at the end of their handler and put the URL in their
 * result. The caller (an LLM, a script) reads the URL verbatim and never
 * has to think about the format.
 *
 * Returns `null` (not throws) whenever a URL can't be produced. Reasons:
 *   - remote vault (no local `.obsidian/...` path to read)
 *   - data.json missing or unreadable
 *   - data.json doesn't have `enableInsecureServer: true`
 *   - data.json doesn't have a valid `insecurePort` number
 *
 * Returning `null` instead of throwing lets the caller fold the URL field
 * conditionally (`...(url && { clickToOpenUrl: url })`) without making the
 * tool result fail when the bridge isn't ready. The user sees no URL — they
 * still get the tool result with the path — and the hook nudge will point
 * at the data.json setup as the missing piece.
 */

import fs from 'node:fs';
import path from 'node:path';

// Module-level cache: vault.path → { port: number, enabled: true } (only
// successful reads are cached). Cleared by `_resetCache()` in tests.
//
// Why only successful reads: a user who starts the router BEFORE enabling
// `enableInsecureServer:true` (very plausible during onboarding) would
// otherwise see `{ port: null, enabled: false }` cached for the lifetime
// of the process — every tool call would then suppress the URL even after
// the user fixed data.json + reloaded Obsidian. By only caching successes
// we re-attempt the disk read on every miss, paying a cheap sync read when
// the bridge is not yet configured but transitioning to cached fast-path
// the moment it works. v0.14.9 hardening (Reviewer A IMPORTANT-1).
const CACHE = new Map();

/**
 * URL-encode a vault-relative path component for use in the `/open/<path>`
 * segment. Slashes are encoded (`%2F`), spaces and accents too, dots and
 * dashes are preserved. The bridge's path matcher does
 * `decodeURIComponent` + `getAbstractFileByPath` so the full encoded path
 * (including the `.md` extension) must round-trip cleanly.
 *
 * encodeURIComponent on POSIX-style paths produces the right output as-is
 * (`/` → `%2F`, space → `%20`, accented chars → UTF-8 percent-encoded).
 * Backslashes (if the caller passed Windows-style) are also encoded as
 * `%5C` — the bridge normalises both to `/` server-side. The forward-slash
 * normalisation happens here, not in the bridge, so the URL the user sees
 * is portable and copy-pastable.
 *
 * @param {string} vaultRelPath - e.g. `wiki/Divers/LIGHTRAG/lightrag.md`.
 * @returns {string} URL-safe encoded path with slashes as %2F.
 */
export function encodeVaultPath(vaultRelPath) {
  // Normalise backslashes to forward slashes BEFORE encoding so a Windows
  // caller that passed `wiki\Divers\LIGHTRAG\lightrag.md` produces the
  // same URL as a POSIX caller. Done at the string level — not via
  // path.posix.normalize — because Node's path module would also collapse
  // `..` and other segments we don't want to silently mutate.
  const normalised = String(vaultRelPath).replace(/\\/g, '/');
  // Strip any leading slash so the result is always relative under the
  // `/open/` prefix.
  const trimmed = normalised.replace(/^\/+/, '');
  return encodeURIComponent(trimmed);
}

/**
 * Read `<vaultPath>/.obsidian/plugins/obsidian-local-rest-api/data.json` and
 * return `{ port: number|null, enabled: boolean }`. Cached per vaultPath.
 *
 * Errors (missing file, JSON parse) collapse to `{ port: null, enabled: false }`
 * — the caller will return `null` from `buildClickToOpenUrl` in that case.
 * No throws; this helper is on the hot path of EVERY mutating tool and a
 * disk read failure must not break the tool result.
 */
function readInsecurePortConfig(vaultPath) {
  if (!vaultPath || typeof vaultPath !== 'string') {
    return { port: null, enabled: false };
  }
  const cached = CACHE.get(vaultPath);
  // Cache only holds successful reads (enabled:true with a valid port).
  // On a `null` cache entry we deliberately re-read disk so a user who
  // fixed their `data.json` mid-session starts producing URLs immediately.
  if (cached !== undefined) return cached;

  // Determine path separator: the registry stores Windows paths verbatim
  // even when the runtime is POSIX (CI matrix, WSL). path.join would pick
  // the runtime's separator, which would produce a path that Node's fs
  // can't read on the foreign platform. Same trick as registry.mjs:
  // structural detection of Windows-style paths.
  const isWindowsStyle = /^[A-Za-z]:[\\/]/.test(vaultPath) || /^\\\\/.test(vaultPath);
  const lib = isWindowsStyle ? path.win32 : path.posix;
  const dataPath = lib.join(
    vaultPath,
    '.obsidian',
    'plugins',
    'obsidian-local-rest-api',
    'data.json',
  );

  let result = { port: null, enabled: false };
  try {
    const raw = fs.readFileSync(dataPath, 'utf8');
    const data = JSON.parse(raw);
    const port = Number.isInteger(data?.insecurePort) ? data.insecurePort : null;
    const enabled = data?.enableInsecureServer === true;
    // Guard against pathological port values. The Local REST API plugin
    // typically uses 27123-27143 but a user could set anything. Reject
    // anything outside the valid TCP port range, treat as "not configured".
    if (port !== null && (port < 1 || port > 65535)) {
      result = { port: null, enabled: false };
    } else {
      result = { port, enabled };
    }
  } catch {
    // file missing / JSON broken / permission denied → all collapse to
    // null. Caller will treat as "no click-to-open available".
  }

  // Only cache successful reads — see CACHE declaration comment for why.
  if (result.enabled && result.port !== null) {
    CACHE.set(vaultPath, result);
  }
  return result;
}

/**
 * Build the click-to-open URL for a vault file. Returns `null` if the URL
 * can't be produced (remote vault, no local data.json, insecure server
 * disabled, etc.).
 *
 * @param {object} vault - A registry vault descriptor (must have `path` for
 *   local vaults; remote vaults always return null).
 * @param {string} filePath - The vault-relative path of the file (e.g.
 *   `wiki/Divers/LIGHTRAG/lightrag.md`). Slashes can be `/` or `\`.
 * @returns {string|null}
 */
export function buildClickToOpenUrl(vault, filePath) {
  if (!vault || typeof vault !== 'object') return null;
  if (vault.type !== 'local') return null; // remote vaults have no local data.json
  if (!vault.path || !filePath) return null;

  const { port, enabled } = readInsecurePortConfig(vault.path);
  if (!enabled || port === null) return null;

  return `http://127.0.0.1:${port}/open/${encodeVaultPath(filePath)}`;
}

/**
 * Build a markdown link `[label](url)` ready to paste into a chat response.
 * Returns `null` when the URL itself is unavailable.
 *
 * @param {object} vault - Same as buildClickToOpenUrl.
 * @param {string} filePath - Same as buildClickToOpenUrl.
 * @param {string} [label] - Optional label override. Default = basename
 *   without the file extension.
 */
export function buildClickToOpenMarkdownLink(vault, filePath, label) {
  const url = buildClickToOpenUrl(vault, filePath);
  if (!url) return null;
  const text = escapeMarkdownLabel(label || basenameNoExt(filePath));
  return `[${text}](${url})`;
}

/**
 * Escape characters that would break the `[label](url)` markdown shape.
 *
 * Without this, a vault file legitimately named `foo]bar.md` would yield
 * `[foo]bar](http://...)` — the renderer closes the label at the first `]`
 * and the rest leaks into the surrounding text. Escape `[` / `]` to match
 * CommonMark spec, and `\` to preserve any user-intended literal backslash
 * in the label. URL side is already encoded by `encodeURIComponent`, so we
 * don't need to touch the destination — but if a future caller passes a
 * raw URL it would still be safe as long as it contains no unescaped `)`.
 *
 * v0.14.9 hardening (Reviewer B P3).
 */
function escapeMarkdownLabel(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\\[\]]/g, (c) => '\\' + c);
}

function basenameNoExt(p) {
  if (!p) return '';
  // Path-separator-agnostic basename (the caller may pass / or \).
  const normalised = String(p).replace(/\\/g, '/');
  const base = normalised.slice(normalised.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

// Test-only: clear the per-vaultPath cache. Called by tests that mutate
// data.json mid-test to verify cache invalidation semantics.
export function _resetCache() {
  CACHE.clear();
}
