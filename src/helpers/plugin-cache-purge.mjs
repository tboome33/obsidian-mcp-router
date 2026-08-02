/**
 * plugin-cache-purge.mjs — reclaim the plugin cache that the auto-update
 * has been growing forever.
 *
 * THE PROBLEM, MEASURED (2026-08-02, on the author's machine). The cache at
 * `~/.claude/plugins/cache/<marketplace>/<plugin>/` held EIGHT versions —
 * 0.14.1, 0.50.0, 0.55.1, 0.56.0, 0.56.1, 0.56.2, 0.65.0, 0.66.1 — for
 * ~1.2 GB, of which ~900 MB was dead weight. `tryAutoUpdate` copies each new
 * version in beside the old ones and repoints `installed_plugins.json`; it
 * has never removed anything. Every release adds ~155 MB forever.
 *
 * WHY THIS IS NOT A ONE-LINE `rm -rf`. A version directory is not garbage
 * just because `installed_plugins.json` stopped naming it. Three things can
 * still depend on it, and the third is the one that bites:
 *
 *   1. ROLLBACK. The previous snapshot is how you go back when a release
 *      misbehaves. It must survive the purge that follows the update that
 *      replaced it.
 *
 *   2. THE MANIFESTS. `installed_plugins.json` can carry SEVERAL entries for
 *      one plugin (user scope, project scope), and `~/.claude/settings.json`
 *      can hold hook paths pinned to a version directory. Anything named
 *      there is live by definition.
 *
 *   3. RUNNING SESSIONS — the trap. A Claude Code session that started
 *      before an update stays pinned to the snapshot it booted from until
 *      `/reload-plugins`. That snapshot is typically NOT in
 *      `installed_plugins.json` any more, so a purge keyed on the manifest
 *      alone would delete a directory out from under a live MCP server.
 *      This is not hypothetical: at the moment this module was written, one
 *      node process was serving from 0.65.0 while the manifest named only
 *      0.66.1. Keeping "N-1" happened to spare it — by luck. Had that
 *      session been on 0.56.2, a manifest-only purge would have broken it.
 *
 * THE POSTURE IS FAIL-CLOSED. If the liveness scan cannot run — unsupported
 * platform, PowerShell/ps missing, permission denied, empty output — this
 * module purges NOTHING and says why. Reclaiming disk is worth far less than
 * never breaking a running session, so every uncertainty resolves toward
 * keeping the directory.
 *
 * WHAT THE LIVENESS CHECK DOES **NOT** PROMISE — stated plainly, because a
 * guarantee this module cannot keep is worse than an admitted limit (the
 * same rule C8 applies to skill contracts applies to this file):
 *
 *   - It is a BEST-EFFORT process scan, not a lock. A process whose command
 *     line reaches the snapshot by a route the scan cannot see — a relative
 *     entry point, an 8.3 short path, a mapped drive, a truncated argv —
 *     is missed, and the scan still reports success.
 *   - There is an unavoidable RACE: a session can start between the scan and
 *     the delete. The plan seal narrows the window (an apply re-derives and
 *     re-scans, so a session that appears before the apply aborts the whole
 *     operation) but does not close it.
 *
 * So the honest claim is: "no snapshot that this scan can see as in use, and
 * nothing a manifest names, and never the rollback" — not "never a running
 * snapshot". Closing the gap properly needs a lease written by session
 * startup, which is a cross-component change this module cannot make on its
 * own; until then the purge stays opt-in rather than automatic, which is why
 * the update only ever PLANS it.
 *
 * PREVIEW FIRST, like every destructive operation in this repo. `planCachePurge`
 * only computes and returns a plan, sealed with the C3 primitive; deleting
 * requires replaying that seal, and `applyCachePurge` re-derives the plan
 * from the CURRENT state and refuses on any drift. A preview that listed six
 * directories can therefore never turn into an apply that removes eight.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { compareSemver, parseSemver } from './semver-compare.mjs';
import { computePlanSeal, verifyPlanSeal } from './plan-seal.mjs';

/** Seal domain tag for this operation (see plan-seal.mjs). */
export const PURGE_OP = 'plugin-cache-purge';

/** How the preview is re-run, quoted in drift errors. */
const PREVIEW_HINT = 'npm run purge:plugin-cache';

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * The cache directory holding one subdirectory per installed version.
 */
export function cacheDirFor({ homeDir, marketplace, plugin }) {
  return path.join(homeDir, '.claude', 'plugins', 'cache', marketplace, plugin);
}

/**
 * A marketplace/plugin name must be ONE ordinary path segment.
 *
 * `path.join` happily swallows separators and `..`, so an unvalidated
 * `plugin: '../../..'` produced a lexically valid "cache dir" pointing at
 * the home directory — and the direct-child check before deletion is
 * relative to that already-escaped root, so it proved nothing. Names come
 * from a CLI flag and from `parseMarketplaceCachePath`, neither of which is
 * a trust boundary worth betting a recursive delete on.
 */
export function isSafeSegment(name) {
  const s = String(name ?? '');
  if (s === '' || s === '.' || s === '..') return false;
  if (/[\\/]/.test(s)) return false;
  if (/^[A-Za-z]:/.test(s)) return false;   // drive-relative
  if (s.includes('\0')) return false;
  return true;
}

/**
 * The canonical `<home>/.claude/plugins/cache` root, realpath-resolved.
 * Every deletion must sit beneath THIS, not beneath a computed string —
 * a symlink or junction anywhere in the parent chain would otherwise
 * redirect a lexically-valid path somewhere else entirely.
 */
function canonicalCacheBase(homeDir) {
  const base = path.join(homeDir, '.claude', 'plugins', 'cache');
  try { return fs.realpathSync(base); } catch { return null; }
}

/**
 * List the version directories in a plugin cache.
 *
 * Only entries that parse as semver AND are real directories count. A
 * stray file, or a directory named something else, is returned under
 * `ignored` rather than silently dropped — an unexplained directory in the
 * cache is exactly the kind of thing a purge must not decide about on its
 * own. Symlinks are NOT followed and never become candidates: deleting
 * through one would escape the cache.
 */
export function listCachedVersions(cacheDir) {
  let entries;
  try {
    entries = fs.readdirSync(cacheDir, { withFileTypes: true });
  } catch (err) {
    // A cache directory that does not exist holds nothing to purge — that is
    // an empty result, not a failure. A directory that exists but cannot be
    // READ is different: something is there and we cannot see it, so the
    // fail-closed rule applies and the caller must refuse.
    if (err.code === 'ENOENT') {
      return { ok: true, error: null, versions: [], ignored: [] };
    }
    return { ok: false, error: `cannot read cache dir ${cacheDir}: ${err.message}`, versions: [], ignored: [] };
  }
  const versions = [];
  const ignored = [];
  for (const ent of entries) {
    const full = path.join(cacheDir, ent.name);
    if (ent.isSymbolicLink()) { ignored.push({ name: ent.name, why: 'symlink — never a purge candidate' }); continue; }
    if (!ent.isDirectory()) { ignored.push({ name: ent.name, why: 'not a directory' }); continue; }
    if (!parseSemver(ent.name)) { ignored.push({ name: ent.name, why: 'not a semver directory name' }); continue; }
    versions.push({ version: ent.name, dir: full });
  }
  versions.sort((a, b) => compareSemver(a.version, b.version));
  return { ok: true, error: null, versions, ignored };
}

/**
 * Total bytes under a directory. Best-effort: an unreadable subtree
 * contributes 0 and sets `partial`, because a size estimate must never be
 * the thing that aborts a purge — it is only shown to the user.
 */
export function directorySize(dir) {
  let bytes = 0;
  let partial = false;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); }
    catch { partial = true; return; }
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) { walk(full); continue; }
      try { bytes += fs.statSync(full).size; } catch { partial = true; }
    }
  };
  walk(dir);
  return { bytes, partial };
}

// ---------------------------------------------------------------------------
// Liveness — which snapshots are a running process serving from?
// ---------------------------------------------------------------------------

function defaultProcessScan(platform) {
  if (platform === 'win32') {
    // -NoProfile so a slow user profile cannot stall a SessionStart hook.
    const ps = spawnSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine',
    ], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    return ps;
  }
  return spawnSync('ps', ['-eo', 'args'], { encoding: 'utf8', timeout: 20000 });
}

/**
 * Which version directories of THIS plugin cache a live process is running
 * from.
 *
 * Returns `{ ok: true, versions: Set }` or `{ ok: false, reason }`. A
 * `false` here means "unknown", and callers must treat unknown as "all
 * versions are in use" — never as "none are".
 *
 * Matching is on the command line of every process, looking for the cache
 * path followed by a version segment. It is deliberately broad: a session
 * pins a snapshot through several different argv shapes (the MCP server
 * entry point, a hook script, an npm wrapper), and missing one of them is
 * the failure that deletes a live directory.
 */
export function findLiveSnapshotVersions({ cacheDir, platform = process.platform, scan = defaultProcessScan } = {}) {
  let res;
  try { res = scan(platform); }
  catch (err) { return { ok: false, reason: `process scan threw: ${err.message}`, versions: new Set() }; }

  if (!res || res.error) {
    return { ok: false, reason: `process scan failed: ${res && res.error ? res.error.message : 'no result'}`, versions: new Set() };
  }
  if (res.status !== 0) {
    return { ok: false, reason: `process scan exited ${res.status}`, versions: new Set() };
  }
  const out = String(res.stdout || '');
  if (out.trim() === '') {
    // An empty listing cannot be right — this very process would appear in
    // it. Treat it as a failed scan, not as "nothing is running".
    return { ok: false, reason: 'process scan returned no output', versions: new Set() };
  }

  // Compare separator-agnostically, and case-insensitively only where the
  // filesystem is. `platform` MUST be threaded through: it was dropped here
  // while the rest of the module became platform-aware, so both calls fell
  // back to `process.platform`. On a Linux runner that made an injected
  // `win32` behave like Linux — the scan returned `ok: true` with an EMPTY
  // set for a snapshot that was in use, which is precisely the "I believe
  // nothing is running" answer that authorises deleting a served directory.
  const needle = normalizePathKey(cacheDir, platform);
  const versions = new Set();
  for (const line of out.split(/\r?\n/)) {
    const norm = normalizePathKey(line, platform);
    let from = norm.indexOf(needle);
    while (from !== -1) {
      const rest = norm.slice(from + needle.length);
      const m = rest.match(/^\/+([^/"'\s]+)/);
      if (m && parseSemver(m[1])) versions.add(m[1]);
      from = norm.indexOf(needle, from + 1);
    }
  }
  return { ok: true, reason: null, versions };
}

/**
 * Forward slashes always; lowercase ONLY on Windows.
 *
 * Unconditional lowercasing aliases two genuinely distinct paths
 * (`/home/u/Cache` and `/home/u/cache` are different directories on Linux),
 * which would let one cache's plan seal authorise a purge of another's.
 *
 * macOS was folded in here at first because HFS+/APFS default to
 * case-insensitive — but that is a VOLUME setting, not a platform one, and
 * APFS case-sensitive volumes are ordinary. Since the only cost of being
 * case-sensitive on a case-insensitive volume is a seal that refuses and
 * asks for a fresh preview, while the cost of the reverse is a seal that
 * authorises deleting a DIFFERENT cache, `darwin` is treated as
 * case-sensitive. The safe direction is the one that refuses.
 */
export function normalizePathKey(s, platform = process.platform) {
  const slashed = String(s ?? '').replace(/\\/g, '/');
  return platform === 'win32' ? slashed.toLowerCase() : slashed;
}

// ---------------------------------------------------------------------------
// Manifest references
// ---------------------------------------------------------------------------

/**
 * Every version of this plugin cache referenced by a JSON manifest.
 *
 * Scans the raw TEXT rather than walking a parsed shape on purpose:
 * `installed_plugins.json` has had three schemas (flat, nested, and the
 * current array-of-scoped-entries), and `settings.json` hides paths at
 * arbitrary depth inside hook definitions. A structural walk that missed one
 * shape would silently under-report a reference, and under-reporting here
 * deletes something live. Text scanning cannot miss a path that is present.
 */
export function referencedVersions({ files, cacheDir, platform = process.platform, pluginKey = null }) {
  const needle = normalizePathKey(cacheDir, platform);
  const found = new Map(); // version -> [file, ...]
  const unreadable = [];
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (err) {
      // A file that does not exist references nothing. A file that EXISTS
      // but cannot be read is different: it may name the very version we
      // are about to delete, and skipping it silently is how a purge
      // removes something live. The caller blocks on `unreadable`.
      if (err.code !== 'ENOENT') unreadable.push({ file, error: err.message });
      continue;
    }
    // JSON escapes Windows separators as `\\`; normalize both.
    const norm = normalizePathKey(text.replace(/\\\\/g, '\\'), platform);
    let from = norm.indexOf(needle);
    while (from !== -1) {
      const rest = norm.slice(from + needle.length);
      const m = rest.match(/^\/+([^/"'\s]+)/);
      if (m && parseSemver(m[1])) {
        if (!found.has(m[1])) found.set(m[1], []);
        const list = found.get(m[1]);
        if (!list.includes(file)) list.push(file);
      }
      from = norm.indexOf(needle, from + 1);
    }

    // Belt and braces for installed_plugins.json: read the plugin's entries
    // STRUCTURALLY too, so a reference we would miss as text — a relative
    // `installPath`, an entry carrying only a `version`, a path spelled
    // through a mapped drive — still protects its version.
    for (const v of structuralVersions(text, pluginKey)) {
      if (!found.has(v)) found.set(v, []);
      const list = found.get(v);
      if (!list.includes(file)) list.push(file);
    }
  }
  found.unreadable = unreadable;
  return found;
}

/**
 * Every `"version": "x.y.z"` the manifest names FOR THIS PLUGIN.
 *
 * Scoped to the plugin's own key on purpose. A whole-file walk also picked
 * up every other installed plugin's versions — harmless while the result was
 * only used to protect directories that happen to share a number, but once
 * those versions became rollback ANCHORS it started protecting "the
 * predecessor of 6.2.0" inside this plugin's cache: over-keeping for a
 * reason that makes no sense to whoever reads the plan.
 *
 * Still schema-agnostic BELOW that key: the entry shape has had three
 * versions (flat object, nested object, array of scoped entries) and the
 * point is not to model them but to miss nothing inside them.
 */
function structuralVersions(text, pluginKey) {
  const out = new Set();
  let data;
  try { data = JSON.parse(text); } catch { return out; }
  const scoped = (data && data.plugins && data.plugins[pluginKey]) ?? (data && data[pluginKey]);
  if (scoped === undefined || scoped === null) return out;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'version' && typeof v === 'string' && parseSemver(v)) out.add(v);
      else walk(v);
    }
  };
  walk(scoped);
  return out;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/**
 * Compute — and seal — which cached versions may be removed.
 *
 * @param {object} opts
 * @param {string} opts.homeDir
 * @param {string} opts.marketplace
 * @param {string} opts.plugin
 * @param {string} [opts.currentVersion]  the version just installed / in use
 * @param {string} [opts.pluginRoot]      the directory THIS process runs from
 * @param {number} [opts.keepPrevious=1]  how many older versions to keep for rollback
 * @param {Function} [opts.scan]          process-scan injection point (tests)
 * @param {string} [opts.platform]
 * @param {boolean} [opts.measureSize=true]
 *
 * @returns {{
 *   ok: boolean, blocked: boolean, blockedReason: string|null,
 *   cacheDir: string, keep: Array, purge: Array, ignored: Array,
 *   reclaimableBytes: number, approvedPlanSha256: string|null,
 * }}
 */
export function planCachePurge({
  homeDir,
  marketplace,
  plugin,
  currentVersion = null,
  pluginRoot = null,
  keepPrevious = 1,
  scan = defaultProcessScan,
  platform = process.platform,
  measureSize = true,
} = {}) {
  const cacheDir = cacheDirFor({ homeDir, marketplace, plugin });
  const blockedBase = {
    ok: false, blocked: true, blockedReason: null, cacheDir,
    keep: [], purge: [], ignored: [], reclaimableBytes: 0, approvedPlanSha256: null,
  };

  // --- containment, before anything reads or plans a delete ---------------
  if (!isSafeSegment(marketplace) || !isSafeSegment(plugin)) {
    return { ...blockedBase, blockedReason: `marketplace and plugin must each be a single path segment (got ${JSON.stringify(marketplace)} / ${JSON.stringify(plugin)})` };
  }
  // `keepPrevious: 0` would delete the rollback snapshot, which the whole
  // design says must survive the update that replaced it. It is not an
  // option, so it is not accepted.
  const keepCount = Number(keepPrevious);
  if (!Number.isInteger(keepCount) || keepCount < 1) {
    return { ...blockedBase, blockedReason: `keepPrevious must be an integer >= 1 (got ${JSON.stringify(keepPrevious)}); the N-1 rollback snapshot is not negotiable` };
  }
  const canonBase = canonicalCacheBase(homeDir);
  let canonCache = null;
  try { canonCache = fs.realpathSync(cacheDir); } catch { canonCache = null; }
  if (canonCache !== null) {
    if (canonBase === null) {
      return { ...blockedBase, blockedReason: `cannot resolve the plugin cache root under ${homeDir}` };
    }
    const rel = path.relative(canonBase, canonCache);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return { ...blockedBase, blockedReason: `${cacheDir} resolves to ${canonCache}, which is outside the plugin cache root ${canonBase} — refusing (a symlink or junction in the parent chain would redirect every delete)` };
    }
    // Global containment is NOT enough. A link from
    // `cache/<marketplace>/<plugin>` to a SIBLING plugin's directory stays
    // inside the cache root, so the check above accepts it — while the
    // manifest and process matching keep using the alias path and `rmSync`
    // follows the link. The result is another plugin's live snapshot being
    // deleted under a plan that looks perfectly well-formed. The canonical
    // directory must therefore be exactly the one we were asked for.
    const expected = path.join(canonBase, marketplace, plugin);
    // Case folding here is NOT the seal-identity rule. `realpath` returns the
    // on-disk casing, while `expected` carries whatever casing the caller
    // typed — so on a case-INSENSITIVE volume a legitimate
    // `--plugin obsidian-Router` would compare unequal and be blocked
    // forever, with "re-run the preview" unable to help. Seal identity stays
    // strict (a wrong seal must refuse); this path check tolerates casing on
    // the platforms whose filesystems commonly do, because here the failure
    // costs a usable install rather than an unwanted delete.
    const foldForPathCheck = (s) => (
      platform === 'win32' || platform === 'darwin'
        ? String(s).replace(/\\/g, '/').toLowerCase()
        : String(s).replace(/\\/g, '/')
    );
    if (foldForPathCheck(canonCache) !== foldForPathCheck(expected)) {
      return {
        ...blockedBase,
        blockedReason: `${cacheDir} resolves to ${canonCache}, not to ${expected} — refusing: a link to a different plugin's cache would have its snapshots deleted under this plugin's plan`,
      };
    }
  }

  const listing = listCachedVersions(cacheDir);
  const base = { ...blockedBase, ignored: listing.ignored };

  if (!listing.ok) {
    return { ...base, blockedReason: listing.error };
  }
  if (listing.versions.length === 0) {
    return { ...base, ok: true, blocked: false, blockedReason: null };
  }

  // --- protection reasons, accumulated per version ------------------------
  /** @type {Map<string, string[]>} */
  const protectedBy = new Map();
  const protect = (version, why) => {
    if (!version) return;
    if (!protectedBy.has(version)) protectedBy.set(version, []);
    const list = protectedBy.get(version);
    if (!list.includes(why)) list.push(why);
  };

  // (1) the version in use / just installed
  if (currentVersion) protect(currentVersion, 'current version');

  // (2) the snapshot THIS process is running from — deleting it would pull
  //     the floor out from under the very run doing the deleting.
  if (pluginRoot) {
    const rel = path.relative(cacheDir, pluginRoot);
    const seg = rel.split(/[\\/]/).filter(Boolean)[0];
    if (seg && !rel.startsWith('..') && parseSemver(seg)) protect(seg, 'this process is running from it');
  }

  // (3) anything a manifest names
  const manifestFiles = [
    path.join(homeDir, '.claude', 'plugins', 'installed_plugins.json'),
    path.join(homeDir, '.claude', 'settings.json'),
  ];
  const installedPath = manifestFiles[0];
  if (!fs.existsSync(installedPath)) {
    // Without the manifest we cannot know what is installed. Refuse.
    return { ...base, blockedReason: `installed_plugins.json not found at ${installedPath} — refusing to purge without knowing what is installed` };
  }
  const refs = referencedVersions({ files: manifestFiles, cacheDir, platform, pluginKey: `${plugin}@${marketplace}` });
  if (refs.unreadable && refs.unreadable.length > 0) {
    return {
      ...base,
      blockedReason: `a manifest exists but could not be read (${refs.unreadable.map((u) => `${path.basename(u.file)}: ${u.error}`).join('; ')}) — it may name the very snapshot we would delete`,
    };
  }
  for (const [version, files] of refs) {
    protect(version, `referenced by ${files.map((f) => path.basename(f)).join(', ')}`);
  }

  // (4) rollback headroom, anchored to the CURRENT version — not to the
  //     highest directory present.
  //
  //     Those differ exactly when they matter: after a rollback the current
  //     version is no longer the newest on disk, and anchoring to the newest
  //     would have "protected" the release we just backed away from while
  //     offering up the predecessor of the one actually running.
  const ordered = [...listing.versions].sort((a, b) => compareSemver(b.version, a.version));
  const anchor = currentVersion && ordered.some((o) => o.version === currentVersion)
    ? currentVersion
    : (ordered[0] && ordered[0].version) || null;
  //     The predecessor of EVERY manifest-named version is protected, not
  //     just the anchor's. `installed_plugins.json` holds one entry per
  //     SCOPE, so a project-scope install can name a different version than
  //     the user-scope one; protecting only the anchor's predecessor left
  //     the other install's rollback purgeable, and array order is no basis
  //     for deciding which of the two deserves it.
  const anchors = new Set([anchor, ...refs.keys()].filter(Boolean));
  for (const a of anchors) {
    const below = ordered.filter((o) => compareSemver(o.version, a) < 0);
    for (const { version } of below.slice(0, keepCount)) {
      protect(version, `kept for rollback (predecessor of ${a})`);
    }
  }
  if (ordered.length > 0) protect(ordered[0].version, 'newest cached version');

  // (5) LIVENESS — the fail-closed gate.
  const live = findLiveSnapshotVersions({ cacheDir, platform, scan });
  if (!live.ok) {
    return {
      ...base,
      blockedReason:
        `cannot determine which snapshots are in use (${live.reason}). Refusing to purge: `
        + `a session that started before an update stays pinned to its snapshot, and removing it would break that session.`,
    };
  }
  for (const version of live.versions) protect(version, 'a running process is serving from it');

  // --- split ---------------------------------------------------------------
  const keep = [];
  const purge = [];
  for (const entry of listing.versions) {
    const reasons = protectedBy.get(entry.version);
    if (reasons && reasons.length > 0) {
      keep.push({ version: entry.version, dir: entry.dir, reasons });
    } else {
      const size = measureSize ? directorySize(entry.dir) : { bytes: 0, partial: false };
      purge.push({ version: entry.version, dir: entry.dir, bytes: size.bytes, sizePartial: size.partial });
    }
  }
  keep.sort((a, b) => compareSemver(a.version, b.version));
  purge.sort((a, b) => compareSemver(a.version, b.version));

  // --- seal ----------------------------------------------------------------
  // The seal covers the cache identity AND the exact directory set, so an
  // apply cannot remove anything the preview did not show. Sizes are
  // deliberately EXCLUDED: they wobble while npm writes logs, and a purge
  // that refused because a directory grew by a byte would be useless.
  const approvedPlanSha256 = computePlanSeal({
    op: PURGE_OP,
    identity: { cacheDir: normalizePathKey(canonCache || cacheDir, platform) },
    plan: {
      purge: purge.map((p) => p.version),
      keep: keep.map((k) => k.version),
    },
  });

  return {
    ok: true,
    blocked: false,
    blockedReason: null,
    cacheDir,
    keep,
    purge,
    ignored: listing.ignored,
    reclaimableBytes: purge.reduce((a, p) => a + p.bytes, 0),
    sealIdentity: normalizePathKey(canonCache || cacheDir, platform),
    approvedPlanSha256,
  };
}

/**
 * Apply a purge plan.
 *
 * Re-derives the plan from the CURRENT state and verifies it against
 * `approvedPlanSha256` before removing anything — so a version that became
 * live between preview and apply (a session just started from it) aborts the
 * whole operation instead of being deleted under that session's feet.
 *
 * Returns `{ ok, removed: [], failed: [], freedBytes }`. A directory that
 * fails to delete (Windows file locks are the usual cause) is reported, not
 * thrown: the remaining candidates are still worth reclaiming, and a locked
 * directory is itself a signal that something is using it.
 */
export function applyCachePurge({ approvedPlanSha256, ...opts }) {
  const plan = planCachePurge(opts);
  if (plan.blocked) {
    return { ok: false, blocked: true, blockedReason: plan.blockedReason, removed: [], failed: [], freedBytes: 0 };
  }

  // Throws PlanDriftError on mismatch — the caller surfaces it. This is the
  // C3 contract: refuse before any destructive I/O, never partway through.
  verifyPlanSeal({
    op: PURGE_OP,
    identity: { cacheDir: plan.sealIdentity },
    plan: {
      purge: plan.purge.map((p) => p.version),
      keep: plan.keep.map((k) => k.version),
    },
    approvedPlanSha256,
    previewHint: PREVIEW_HINT,
  });

  const removed = [];
  const failed = [];
  let freedBytes = 0;
  // The canonical root every deletion must sit beneath. Computed once,
  // immediately before the deletes, from the real filesystem — not from the
  // string the plan carries.
  const canonBase = canonicalCacheBase(opts.homeDir);

  for (const entry of plan.purge) {
    // Belt and braces: never delete anything that is not a direct child of
    // the cache dir, whatever the plan says.
    const rel = path.relative(plan.cacheDir, entry.dir);
    if (rel.startsWith('..') || path.isAbsolute(rel) || rel.split(/[\\/]/).filter(Boolean).length !== 1) {
      failed.push({ version: entry.version, dir: entry.dir, error: 'refused: not a direct child of the cache dir' });
      continue;
    }
    // …and the CANONICAL target must still land inside the canonical cache
    // root. The lexical check above is relative to a computed string; if a
    // symlink or junction redirects the chain, that string proves nothing.
    // Resolved per-entry so a link swapped in after the plan was sealed is
    // caught here rather than followed.
    let canonTarget = null;
    try { canonTarget = fs.realpathSync(entry.dir); } catch { canonTarget = null; }
    if (canonTarget === null || canonBase === null) {
      failed.push({ version: entry.version, dir: entry.dir, error: 'refused: cannot resolve the target or the cache root' });
      continue;
    }
    const canonRel = path.relative(canonBase, canonTarget);
    if (canonRel.startsWith('..') || path.isAbsolute(canonRel)) {
      failed.push({ version: entry.version, dir: entry.dir, error: `refused: resolves to ${canonTarget}, outside ${canonBase}` });
      continue;
    }
    try {
      fs.rmSync(entry.dir, { recursive: true, force: true });
      removed.push({ version: entry.version, dir: entry.dir, bytes: entry.bytes });
      freedBytes += entry.bytes;
    } catch (err) {
      failed.push({ version: entry.version, dir: entry.dir, error: err.message });
    }
  }
  return { ok: failed.length === 0, blocked: false, blockedReason: null, removed, failed, freedBytes };
}

/** Human-readable byte size. */
export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Render a plan for a terminal. */
export function renderPurgePlan(plan) {
  const lines = [];
  lines.push(`plugin cache: ${plan.cacheDir}`);
  if (plan.blocked) {
    lines.push('');
    lines.push(`REFUSING TO PURGE — ${plan.blockedReason}`);
    return lines.join('\n');
  }
  lines.push('');
  lines.push(`KEEP (${plan.keep.length}):`);
  for (const k of plan.keep) lines.push(`  ${k.version.padEnd(10)} ${k.reasons.join(' · ')}`);
  lines.push('');
  if (plan.purge.length === 0) {
    lines.push('PURGE: nothing — every cached version is protected.');
  } else {
    lines.push(`PURGE (${plan.purge.length}) — ${formatBytes(plan.reclaimableBytes)} reclaimable:`);
    for (const p of plan.purge) {
      lines.push(`  ${p.version.padEnd(10)} ${formatBytes(p.bytes)}${p.sizePartial ? ' (partial measure)' : ''}`);
    }
  }
  if (plan.ignored.length > 0) {
    lines.push('');
    lines.push(`IGNORED (${plan.ignored.length}) — left alone, never candidates:`);
    for (const i of plan.ignored) lines.push(`  ${i.name} — ${i.why}`);
  }
  return lines.join('\n');
}
