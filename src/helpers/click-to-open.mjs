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
 *   - no port known: neither `data.json` nor the config could supply one
 *   - data.json is READABLE and says `enableInsecureServer: false`
 *
 * Returning `null` instead of throwing lets the caller fold the URL field
 * conditionally (`...(url && { clickToOpenUrl: url })`) without making the
 * tool result fail when the bridge isn't ready. The user sees no URL — they
 * still get the tool result with the path — and the hook nudge will point
 * at the data.json setup as the missing piece.
 *
 * ---------------------------------------------------------------------------
 * LOT 2 (v0.79.0) — THE PORT NO LONGER HAS TO COME FROM A DISK
 * ---------------------------------------------------------------------------
 * Until now this helper refused outright for any vault it could not stat, and
 * `open-in-obsidian.mjs` recorded exactly why: *"that helper is local-only only
 * because it must read the LOCAL data.json to find the insecure port"*. That
 * reason is now removable. Since v0.77.0 `config.json`'s `portRegistry` carries
 * `{ https, http }` per vault, and a remote vault entry may declare its own
 * `insecurePort` — so `registry.mjs` puts the number on EVERY vault descriptor
 * and this helper reads `vault.insecurePort` when the disk cannot answer.
 *
 * THREE STATES, NOT TWO — the same distinction `effectivePortsOf` had to make
 * in `port-registry.mjs`. `data.json` can be:
 *   - readable and enabled   → its port wins, always. It is what the plugin
 *                              actually binds; a registry that disagrees is
 *                              stale bookkeeping.
 *   - readable and DISABLED  → `null`, and NO fallback. The plaintext server is
 *                              genuinely off; falling back to a remembered
 *                              number would emit a link to a dead socket.
 *   - unreadable             → the port is unknown, not absent. THIS is where
 *                              the descriptor's number is used.
 * Collapsing the last two (which the pre-v0.79.0 `catch` did) is what made the
 * remembered port unreachable.
 *
 * WHAT THE FALLBACK CAN GET WRONG, said plainly: a vault that was set up, got
 * its plaintext port recorded, and has since turned `enableInsecureServer` off
 * WHILE its disk is unreachable will produce a link that the bridge answers
 * with a 404. That is the failure mode of every click-to-open link already
 * written in the user's notes, and it is bounded — `/open` never returns file
 * content, so a stale link is a dead click, never a leak.
 *
 * ---------------------------------------------------------------------------
 * THE HOST IS ALWAYS 127.0.0.1, AND NOTHING ABOUT baseUrl CHANGES THAT
 * ---------------------------------------------------------------------------
 * The accepted decision `click-to-open-access-modes` (2026-06-03) keeps the
 * bridge's `/open` guard STRICTLY loopback: the request's SOURCE IP must be
 * loopback, or it is refused `loopback only`. That request comes from the
 * READER'S BROWSER, not from this process.
 *
 * A FIRST DRAFT OF LOT 2 GOT THIS WRONG, and the correction is worth keeping.
 * It gated emission on `baseUrl` being loopback, reasoning that a WireGuard
 * `baseUrl` would produce a dead link. That conflated two different hops. This
 * helper never interpolates the vault's host — the URL is always
 * `http://127.0.0.1:<port>/…` — so what decides whether a click works is
 * whether the READER is sitting at the machine running that vault's Obsidian.
 * `baseUrl` describes how the ROUTER reaches the REST API, over a tunnel or a
 * mesh, and answers a different question entirely. The guard was therefore
 * neither necessary nor sufficient: it refused a perfectly good link for a
 * WireGuard-reached vault whose reader is on the Obsidian host, and it passed
 * an unusable one for a loopback-reached vault whose reader is elsewhere.
 * (Found in the second pre-release review, 2026-08-31.)
 *
 * SO THE OPT-IN IS THE WHOLE GATE. `insecurePort` is optional; declaring it IS
 * the operator's assertion that "the loopback my readers resolve is the host
 * running this vault's Obsidian". Omit it on a multi-machine deployment and no
 * link is ever emitted. A local vault reads the port from its own disk, which
 * carries the same assertion implicitly — as it always has.
 *
 * When that assertion is wrong, the click reaches the reader's own loopback and
 * finds nothing — or finds an UNRELATED local service, and hands it the note's
 * path and heading. `/open` never returns file content, so what the note SAYS
 * is never disclosed; but a path can be `Patients/J. Dupont/diagnostic.md`, and
 * that is a real disclosure to whatever owns that port. It is why the generator
 * refuses to export these ports unless asked (`--with-click-to-open`) rather
 * than adding them wherever it finds one.
 *
 * ---------------------------------------------------------------------------
 * RESOLVE ONCE PER OPERATION
 * ---------------------------------------------------------------------------
 * There is no memo, so each call to `buildClickToOpenUrl` reads the file. That
 * is right for ONE link beside an HTTPS round trip, and wrong for a hundred:
 * `write_bundle` and `build_open_link`'s batch mode would pay N reads, and —
 * worse — a rewrite mid-batch could put half the links on the old port and half
 * on the new one, or make a result's `clickToOpenUrl` and its `markdownLink`
 * disagree with each other (both were real, found in the third pre-release
 * review). Callers emitting more than one link therefore call
 * `resolveInsecurePort` ONCE and pass the result as `opts.port`, so an operation
 * is a single snapshot. Freshness lives BETWEEN operations, not inside one.
 */

import fs from 'node:fs';
import path from 'node:path';

// THERE IS NO CACHE ANY MORE, AND THAT IS THE FIX (v0.79.0).
//
// v0.14.9 memoised every successful read for the lifetime of the process. It
// solved the onboarding direction (a user who ENABLES the plaintext server
// mid-session is picked up, because failures were never cached) and left the
// opposite one broken: a user who DISABLES it, or moves the port, kept getting
// the old number until the router restarted. The suite could not see it — every
// cache test calls `_resetCache()` in a `beforeEach`.
//
// The first repair attempt validated the entry against the file's `mtimeMs`.
// The second review rejected that too, correctly: two writes inside one
// filesystem timestamp tick keep one mtime, so the invariant "a stale value can
// never win over a live one" still could not be stated as a guarantee — and the
// test written to defend the cache had to restore an mtime by hand, which
// engraved the collision INTO the contract rather than testing anything.
//
// So the memo is gone. Every call reads the file. The cost is a sync read of a
// few-KB JSON, against a tool call that is already paying an HTTPS round trip
// to the vault's REST API (68–76 ms, measured on this fleet) — the read is
// noise beside it, and buying an unstatable invariant with it was a bad trade.
// `_resetCache` is kept as a no-op so existing callers and tests keep working.

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
  return encodeUriMarkdownSafe(trimmed);
}

/**
 * Like `encodeURIComponent`, but also percent-encodes `(` and `)`.
 *
 * `encodeURIComponent` leaves `( ) ! ' * ~` unescaped. Inside a markdown
 * link `[label](url)` a literal `)` (or an unbalanced `(`) terminates the
 * link destination early — so a vault file named `foo (draft).md` or a
 * heading like `Step 1) Setup` would produce a broken `markdownLink`
 * (codex review finding, 2026-06-02). We escape both parens so every URL we
 * emit is safe to paste into `[..](..)`. The bridge `/open` handler decodes
 * `%28`/`%29` via `decodeURIComponent` like any other escape, so this is
 * transparent server-side and backward compatible (old links without parens
 * are byte-identical).
 *
 * @param {string} s
 * @returns {string}
 */
function encodeUriMarkdownSafe(s) {
  return encodeURIComponent(s).replace(/\(/g, '%28').replace(/\)/g, '%29');
}

/**
 * Read `<vaultPath>/.obsidian/plugins/obsidian-local-rest-api/data.json` and
 * return `{ port: number|null, enabled: boolean, readable: boolean }`. NOT
 * cached — see the note where the memo used to live.
 *
 * `readable` is the field that makes the registry fallback possible, and it is
 * NOT cosmetic: "the file says the plaintext server is off" and "I could not
 * open the file" are different facts, and only the second one licenses using a
 * remembered port. Before v0.79.0 both collapsed into `{port:null,
 * enabled:false}`, so a vault on an unplugged drive was indistinguishable from
 * one that had deliberately disabled its plaintext server.
 *
 * No throws; this helper is on the hot path of EVERY mutating tool and a disk
 * read failure must not break the tool result.
 */
function readInsecurePortConfig(vaultPath) {
  if (!vaultPath || typeof vaultPath !== 'string') {
    return { port: null, enabled: false, readable: false };
  }
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

  let result = { port: null, enabled: false, readable: false };
  try {
    const raw = fs.readFileSync(dataPath, 'utf8');
    const data = JSON.parse(raw);
    const port = Number.isInteger(data?.insecurePort) ? data.insecurePort : null;
    const enabled = data?.enableInsecureServer === true;
    // Guard against pathological port values. The Local REST API plugin
    // typically uses 27123-27143 but a user could set anything. Reject
    // anything outside the valid TCP port range, treat as "not configured".
    if (port !== null && (port < 1 || port > 65535)) {
      result = { port: null, enabled: false, readable: true };
    } else {
      result = { port, enabled, readable: true };
    }
  } catch {
    // file missing / JSON broken / permission denied → we learned NOTHING
    // about this vault's plaintext server. `readable:false` says exactly that,
    // and is what lets the caller reach for the registry's remembered port
    // instead of treating silence as a refusal.
  }

  return result;
}

/**
 * Normalise an optional heading anchor. Returns the cleaned heading TEXT
 * (no leading `#`, trimmed) or null when there's no usable anchor.
 *
 * Obsidian heading links target the heading's TEXT — the heading is its own
 * anchor, nothing is inserted into the note. We accept the value with or
 * without a leading `#` (so callers can pass either `Installation` or
 * `#Installation`). The value is later `encodeURIComponent`-d into the
 * `?h=` query param read by the bridge's /open handler (v0.3.0+).
 *
 * @param {*} anchor
 * @returns {string|null}
 */
export function normalizeAnchor(anchor) {
  if (typeof anchor !== 'string') return null;
  const cleaned = anchor.trim().replace(/^#+/, '').trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * The plaintext port to use for a vault, or `null`.
 *
 * Order — and each step is a different question:
 *   1. `data.json`, when it can be read. It is what the plugin binds. A
 *      readable file that says the plaintext server is OFF ends the search:
 *      no fallback, because there is nothing listening to fall back TO.
 *   2. `vault.insecurePort`, put on the descriptor by `registry.mjs` from
 *      `portRegistry[path].http` (local) or the vault entry's own
 *      `insecurePort` (remote). Used only when the disk could not answer.
 *
 * Exported for tests and for callers that want the number without the URL.
 */
export function resolveInsecurePort(vault) {
  if (!vault || typeof vault !== 'object') return null;
  const declared = Number.isInteger(vault.insecurePort)
    && vault.insecurePort >= 1 && vault.insecurePort <= 65535
    ? vault.insecurePort
    : null;

  if (vault.type === 'local' && vault.path) {
    const { port, enabled, readable } = readInsecurePortConfig(vault.path);
    if (readable) return enabled && port !== null ? port : null;
  }
  return declared;
}

/**
 * Build the click-to-open URL for a vault file. Returns `null` if the URL
 * can't be produced (no port known, or the plaintext server explicitly
 * disabled — see the module docblock).
 *
 * @param {object} vault - A registry vault descriptor. `path` for local vaults;
 *   a vault declared in config needs `insecurePort`, and declaring it is the
 *   operator's assertion about where their readers sit. `baseUrl` is NOT
 *   consulted: the emitted host is always `127.0.0.1`.
 * @param {string} filePath - The vault-relative path of the file (e.g.
 *   `wiki/Divers/LIGHTRAG/lightrag.md`). Slashes can be `/` or `\`.
 * @param {object} [opts]
 * @param {string} [opts.anchor] - Optional heading to deep-link to. Emitted
 *   as a `?h=<encoded-heading>` query param (NOT a `#fragment` — browsers
 *   never send the fragment to the server, so the bridge couldn't see it).
 *   The bridge scrolls to that heading on open. Empty/non-string → ignored.
 * @param {number|null} [opts.port] - A port already resolved for this vault by
 *   `resolveInsecurePort`. Pass it when emitting MANY links in one operation:
 *   it makes the whole batch consistent and costs one disk read instead of N.
 *   See RESOLVE ONCE PER OPERATION in the module docblock.
 * @returns {string|null}
 */
export function buildClickToOpenUrl(vault, filePath, opts = {}) {
  if (!vault || typeof vault !== 'object') return null;
  if (!filePath) return null;
  if (vault.type === 'local' && !vault.path) return null;

  // VALIDATED WHATEVER ITS SOURCE. `resolveInsecurePort` already range-checks
  // what it returns, so an earlier draft trusted `opts.port` merely for being
  // defined — and `opts` is an exported escape hatch. A caller passing
  // `'80'+'@'+'evil.example'` would have produced
  // `http://127.0.0.1:80@evil.example/open/…`, whose real host is the
  // attacker's and which carries the note's PATH there. No current caller can
  // do it, but "no current caller" is not a guard, and this is the third time
  // this fleet has met that exact defect class. (Fourth pre-release review.)
  const port = opts && opts.port !== undefined ? opts.port : resolveInsecurePort(vault);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  const base = `http://127.0.0.1:${port}/open/${encodeVaultPath(filePath)}`;
  const anchor = normalizeAnchor(opts && opts.anchor);
  return anchor ? `${base}?h=${encodeUriMarkdownSafe(anchor)}` : base;
}

/**
 * Build a markdown link `[label](url)` ready to paste into a chat response.
 * Returns `null` when the URL itself is unavailable.
 *
 * @param {object} vault - Same as buildClickToOpenUrl.
 * @param {string} filePath - Same as buildClickToOpenUrl.
 * @param {string} [label] - Optional label override. Default = basename
 *   without the file extension.
 * @param {object} [opts] - Forwarded to buildClickToOpenUrl (`anchor`, `port`).
 */
export function buildClickToOpenMarkdownLink(vault, filePath, label, opts = {}) {
  const url = buildClickToOpenUrl(vault, filePath, opts);
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

/**
 * NO-OP since v0.79.0 — the per-vaultPath memo it used to clear no longer
 * exists (see the note where it used to be declared). Kept because tests and
 * callers reference it, and because removing it would turn a harmless call into
 * an import error for anyone who upgraded without reading. Every read is fresh,
 * so there is nothing left to reset.
 */
export function _resetCache() {}
