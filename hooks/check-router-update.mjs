#!/usr/bin/env node
/**
 * check-router-update.mjs
 *
 * SessionStart hook. At most once per 24h, checks if a newer version of
 * obsidian-mcp-router is available on GitHub. If so, emits a notice to
 * stdout — Claude picks it up as session context and surfaces it on the
 * first response.
 *
 * Fails silently on any error (offline, GitHub down, malformed JSON,
 * cache I/O failure, etc.) — never disturbs the user. Cached in
 * ~/.claude/obsidian-mcp-router/.last-version-check.json with 24h
 * throttle.
 *
 * Opt-out:
 *   - OBSIDIAN_ROUTER_NO_UPDATE_CHECK=true  (truthy: true / 1 / yes / on)
 *   - OBSIDIAN_ROUTER_USER_ID=<slug>        (multi-tenant deployment —
 *                                            sysadmin manages updates,
 *                                            check is skipped)
 *
 * Wire-up: see hooks/hooks.example.json (SessionStart block).
 *
 * ── v0.11.4: new-hooks tips ────────────────────────────────────────────
 * On top of the version-update notice, the hook now snapshots the local
 * `hooks/` listing each run and stores it in the cache. When it detects
 * a hook present on disk but missing from the previous snapshot (= the
 * user just updated and got a new hook), AND that hook isn't already
 * wired in `~/.claude/settings.json`, it appends a 💡 tip listing the
 * new hook + the one-line command to activate it
 * (`setup-vault.mjs --install-hooks --select <name>`). Same opt-outs.
 *
 * ── v0.14.0: opt-in auto-update ────────────────────────────────────────
 * Setting `OBSIDIAN_ROUTER_AUTO_UPDATE=true` (truthy) makes the hook
 * apply the update automatically instead of just notifying. It mimics
 * what `/plugin update` does: git-pull the marketplace clone, copy the
 * new version into cache/, refresh installed_plugins.json, and rewrite
 * any pinned hook paths in ~/.claude/settings.json. The user still has
 * to run `/reload-plugins` (or restart) for the new code to take effect
 * in the current session — that part Claude Code does not let us do
 * from a hook. Fails silently and falls back to the manual notice on
 * any error. Only runs against marketplace installs; dev installs
 * (npm link or running from a checked-out repo outside the cache tree)
 * are detected and skipped.
 *
 * Implementation lives in src/helpers/plugin-auto-update.mjs (pure
 * helpers, testable without spawning this CLI).
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { compareSemver, parseSemver } from '../src/helpers/semver-compare.mjs';
import { tryAutoUpdate } from '../src/helpers/plugin-auto-update.mjs';

const TRUTHY = new Set(['true', '1', 'yes', 'on']);
const PACKAGE_JSON_URL =
  'https://raw.githubusercontent.com/tboome33/obsidian-mcp-router/main/package.json';
const CHANGELOG_URL =
  'https://github.com/tboome33/obsidian-mcp-router/blob/main/CHANGELOG.md';
const FETCH_TIMEOUT_MS = 3000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pluginRoot = path.resolve(__dirname, '..');

function isTruthy(value) {
  return TRUTHY.has(String(value || '').toLowerCase());
}

// ─── Opt-out checks ──────────────────────────────────────────────────
if (isTruthy(process.env.OBSIDIAN_ROUTER_NO_UPDATE_CHECK)) process.exit(0);
if (process.env.OBSIDIAN_ROUTER_USER_ID) process.exit(0);

const autoUpdateEnabled = isTruthy(process.env.OBSIDIAN_ROUTER_AUTO_UPDATE);

// ─── Determine installed version ──────────────────────────────────────
let installedVersion = null;
try {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'),
  );
  installedVersion = pkg.version;
} catch {
  process.exit(0);
}
if (!installedVersion || !parseSemver(installedVersion)) process.exit(0);

// ─── Cache file location ──────────────────────────────────────────────
const homeDir = os.homedir();
const cacheDir = path.join(homeDir, '.claude', 'obsidian-mcp-router');
const cacheFile = path.join(cacheDir, '.last-version-check.json');

let cached = null;
try {
  cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
} catch {
  // First run or unreadable cache — re-fetch
}

// ─── Snapshot local hooks (for new-hooks tips) ────────────────────────
// List the local hooks/ directory, filter to .mjs basenames. This is
// fast (single readdir, ~5 files). Compared against the cached snapshot
// to detect newly-added hooks since the last run.
function listLocalHookBasenames() {
  try {
    return fs.readdirSync(path.join(pluginRoot, 'hooks'))
      .filter((f) => f.endsWith('.mjs'))
      .sort();
  } catch { return []; }
}
const currentHooks = listLocalHookBasenames();

// ─── Detect which hooks the user has already wired ────────────────────
// Read ~/.claude/settings.json and walk every command string. A hook
// is "wired" if any command contains its basename (case-sensitive —
// settings.json paths are user-controlled and should be exact).
function wiredHookBasenames() {
  const settingsPath = path.join(homeDir, '.claude', 'settings.json');
  let settings;
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
  catch { return new Set(); }
  const found = new Set();
  const hooks = settings.hooks || {};
  for (const event of Object.keys(hooks)) {
    for (const block of (hooks[event] || [])) {
      for (const entry of (block.hooks || [])) {
        const cmd = entry?.command || '';
        for (const hb of currentHooks) {
          if (cmd.includes(hb)) found.add(hb);
        }
      }
    }
  }
  return found;
}

const now = Date.now();
if (cached && typeof cached.checkedAt === 'number' && now - cached.checkedAt < CACHE_TTL_MS) {
  // Within throttle window — replay cached notice if any.
  if (cached.notice && cached.installedAtCheck === installedVersion) {
    process.stdout.write(cached.notice);
  }
  process.exit(0);
}

// ─── Compute new-hooks tip (works offline; depends only on local state) ──
const cachedHooks = Array.isArray(cached?.snapshotHooks) ? cached.snapshotHooks : null;
let tipNotice = null;
if (cachedHooks !== null) {
  const wired = wiredHookBasenames();
  const newAndNotWired = currentHooks.filter(
    (h) => !cachedHooks.includes(h) && !wired.has(h),
  );
  if (newAndNotWired.length > 0) {
    tipNotice = composeNewHooksTip(newAndNotWired);
  }
}

// ─── Fetch latest version from GitHub ─────────────────────────────────
const req = https.get(
  PACKAGE_JSON_URL,
  { timeout: FETCH_TIMEOUT_MS, headers: { 'User-Agent': 'obsidian-mcp-router/check-router-update' } },
  (res) => {
    if (res.statusCode !== 200) {
      finishWithoutFetch();
      return;
    }
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      let latestVersion = null;
      try {
        latestVersion = JSON.parse(body).version;
      } catch {
        finishWithoutFetch();
        return;
      }
      if (!latestVersion || !parseSemver(latestVersion)) {
        finishWithoutFetch();
        return;
      }
      const cmp = compareSemver(latestVersion, installedVersion);
      const updateAvailable = cmp > 0;

      let versionNotice = null;
      if (updateAvailable) {
        if (autoUpdateEnabled) {
          // Try the full /plugin update sequence. On success we emit a
          // different notice (no /plugin update instructions, just a
          // /reload-plugins reminder). On failure we fall back to the
          // standard manual notice with the failure reason inline.
          const result = tryAutoUpdate({
            installedVersion,
            newVersion: latestVersion,
            homeDir,
            pluginRoot,
          });
          if (result.success) {
            versionNotice = composeAutoUpdateSuccessNotice(installedVersion, latestVersion);
          } else {
            versionNotice = composeNotice(installedVersion, latestVersion, result.error || 'unknown');
          }
        } else {
          versionNotice = composeNotice(installedVersion, latestVersion);
        }
      }

      const fullNotice = [versionNotice, tipNotice].filter(Boolean).join('') || null;
      persistCache({
        checkedAt: now,
        notice: fullNotice,
        installedAtCheck: installedVersion,
        snapshotHooks: currentHooks,
      });
      if (fullNotice) process.stdout.write(fullNotice);
      process.exit(0);
    });
  },
);

req.on('error', () => finishWithoutFetch());
req.on('timeout', () => { req.destroy(); finishWithoutFetch(); });

/**
 * Fallback path when GitHub is unreachable (offline session, rate-limit,
 * etc.). We can still emit the new-hooks tip (purely local) and update
 * the snapshot for next time. The version-update notice stays null so
 * we don't replay a stale one from cache on cmp-failure paths.
 */
function finishWithoutFetch() {
  persistCache({
    checkedAt: now,
    notice: tipNotice,
    installedAtCheck: installedVersion,
    snapshotHooks: currentHooks,
  });
  if (tipNotice) process.stdout.write(tipNotice);
  process.exit(0);
}

// ─── Helpers ──────────────────────────────────────────────────────────
function composeNotice(installed, latest, autoUpdateFailureReason) {
  const lines = [
    '',
    '<!-- obsidian-mcp-router update notice — please relay to the user on your first response -->',
    `📦 **obsidian-mcp-router v${latest} is available** (you have v${installed}).`,
    '',
  ];
  if (autoUpdateFailureReason) {
    lines.push(
      `⚠️  Auto-update was enabled (\`OBSIDIAN_ROUTER_AUTO_UPDATE=true\`) but bailed out:`,
      `   ${autoUpdateFailureReason}`,
      '   Falling back to manual update.',
      '',
    );
  }
  lines.push(
    'How to update:',
    `- Try: \`/plugin update obsidian-router@obsidian-mcp-router-marketplace\``,
    `- If \`/plugin\` is unavailable in your environment, see the manual update guide at`,
    `  https://github.com/tboome33/obsidian-mcp-router/blob/main/docs/how-to-update.md`,
    '',
    `Changelog: ${CHANGELOG_URL}`,
    '',
    'To disable this once-per-day update check: set env var `OBSIDIAN_ROUTER_NO_UPDATE_CHECK=true`.',
    '',
  );
  return lines.join('\n');
}

function composeAutoUpdateSuccessNotice(installed, latest) {
  return [
    '',
    '<!-- obsidian-mcp-router auto-update success — please relay to the user on your first response -->',
    `🆙 **obsidian-mcp-router auto-updated v${installed} → v${latest}.**`,
    '',
    'New version is already installed (cache + installed_plugins.json + settings.json hook paths refreshed).',
    'To activate it in this session, run:',
    '',
    '```',
    '/reload-plugins',
    '```',
    '',
    `New sessions will load v${latest} automatically — no action needed.`,
    '',
    `Changelog: ${CHANGELOG_URL}`,
    '',
    'To disable auto-update: unset `OBSIDIAN_ROUTER_AUTO_UPDATE` (or set it to false / 0 / no / off).',
    '',
  ].join('\n');
}

/**
 * Compose a tip-style notice listing newly-available router hooks that
 * the user hasn't wired yet. Style matches Claude CLI's `💡` tips so it
 * blends into the session-start context.
 */
function composeNewHooksTip(newHookBasenames) {
  const slugs = newHookBasenames.map((bn) => bn.replace(/\.mjs$/, ''));
  const slugList = slugs.join(',');
  const lines = [
    '',
    '<!-- obsidian-mcp-router new-hooks tip — please relay to the user on your first response -->',
    `💡 **${newHookBasenames.length} new router hook(s) available** that you haven\'t activated yet:`,
    '',
  ];
  for (const slug of slugs) {
    lines.push(`  • \`${slug}\``);
  }
  lines.push('');
  lines.push('Activate them with:');
  lines.push('```');
  lines.push(`node <router-repo>/scripts/setup-vault.mjs --install-hooks --select ${slugList}`);
  lines.push('```');
  lines.push('');
  lines.push('Or activate everything (idempotent):');
  lines.push('```');
  lines.push('node <router-repo>/scripts/setup-vault.mjs --install-hooks');
  lines.push('```');
  lines.push('');
  lines.push('Inspect current status: `node <router-repo>/scripts/setup-vault.mjs --hooks-status`.');
  lines.push('Opt-out of these tips: set env var `OBSIDIAN_ROUTER_NO_UPDATE_CHECK=true` (also disables the version notice).');
  lines.push('');
  return lines.join('\n');
}

function persistCache(entry) {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(entry, null, 2) + '\n');
  } catch {
    // Cache write failure is non-fatal
  }
}
