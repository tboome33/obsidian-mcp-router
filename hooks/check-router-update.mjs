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
import { loadWorkspaceDotenv } from './_helpers/workspace-vault.mjs';

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
// The workspace .env is loaded first, so a NO_UPDATE_CHECK set in that file
// is honored here and not only when the parent shell carries it.
loadWorkspaceDotenv(process.env.CLAUDE_PROJECT_DIR || process.cwd());
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
  const found = new Set();

  // A hook declared in the plugin's own hooks/hooks.json is ALREADY
  // running — Claude Code activates plugin hooks with no opt-in step and
  // no settings.json entry. Counting it as wired is what stops the tip
  // below from telling the user to "activate" something already active,
  // advice that would wire a duplicate and double-fire it every event.
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'hooks', 'hooks.json'), 'utf8'));
    for (const event of Object.keys(manifest.hooks || {})) {
      for (const block of (manifest.hooks[event] || [])) {
        for (const entry of (block.hooks || [])) {
          const cmd = entry?.command || '';
          for (const hb of currentHooks) {
            if (cmd.includes(hb)) found.add(hb);
          }
        }
      }
    }
  } catch { /* no plugin manifest — pre-Lot-5 layout, nothing to add */ }

  const settingsPath = path.join(homeDir, '.claude', 'settings.json');
  let settings;
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
  catch { return found; }
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

/**
 * True when ~/.claude/settings.json still pins a hook command to the given
 * version's cache directory — i.e. when a failed path rewrite would really
 * leave the user broken. Any read/parse problem reports false: this only
 * ever gates a warning, and a spurious warning is worse than a missing one.
 */
function settingsMentionsVersionedHookPath(version) {
  if (!version) return false;
  let raw;
  try { raw = fs.readFileSync(path.join(homeDir, '.claude', 'settings.json'), 'utf8'); }
  catch { return false; }
  const needle = `obsidian-router`;
  return raw.includes(needle) && raw.includes(String(version));
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
            versionNotice = composeAutoUpdateSuccessNotice(
              installedVersion,
              latestVersion,
              result.settingsRewrite,
              result.markitdownStatus,
              result.cachePurge,
            );
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

function composeAutoUpdateSuccessNotice(installed, latest, settingsRewrite, markitdownStatus, cachePurge) {
  // cachePurge: the plan tryAutoUpdate computed but deliberately did not
  // apply. It used to be computed and then dropped on the floor — the
  // update paid for a process scan and a directory walk on every run, and
  // nobody ever saw the number. Surfacing it here is what makes the work
  // worth doing, and it is the only place the user learns the cache has
  // grown at all.
  // settingsRewrite: { changed: boolean, settingsExists: boolean } from
  // rewriteSettingsHookPaths. When settings.json exists but nothing was
  // rewritten, hooks may still be pinned to the old version dir — warn
  // the user explicitly so they re-run install-hooks instead of silently
  // running stale code.
  //
  // markitdownStatus: 'ok' | 'will-break' | 'never-installed' from
  // detectMarkitdownStatus. Auto-update runs `npm install --ignore-scripts`
  // for supply-chain safety, which means the new cache dir's .venv won't
  // be created by `scripts/install-markitdown.mjs`. If the user was
  // relying on the bundled venv (no MARKITDOWN_PATH override), their
  // *_to_markdown tools will ENOENT after /reload-plugins. Warn + give
  // them the one-liner to fix.
  // `settingsExists && !changed` alone is NOT "the rewrite failed": for a
  // user whose hooks come from the plugin manifest, settings.json exists
  // (env vars, permissions, statusline…) and legitimately holds zero pinned
  // router paths, so nothing needed rewriting. Warning there would tell
  // them to delete entries that do not exist and to re-run --install-hooks,
  // which is exactly the action that double-wires plugin-provided hooks.
  // Only warn when a stale pinned path is genuinely still sitting there.
  const rewriteSkipped =
    settingsRewrite &&
    settingsRewrite.settingsExists &&
    !settingsRewrite.changed &&
    settingsMentionsVersionedHookPath(installed);
  const lines = [
    '',
    '<!-- obsidian-mcp-router auto-update success — please relay to the user on your first response -->',
    `🆙 **obsidian-mcp-router auto-updated v${installed} → v${latest}.**`,
    '',
  ];
  if (rewriteSkipped) {
    // Important: setup-vault.mjs --install-hooks only ADDS missing hooks
    // (matched by basename), it does NOT rewrite existing entries that
    // still point at an old version dir. So the recovery flow is a 2-step
    // manual one — remove the stale entries first, then re-run install.
    lines.push(
      'New version is installed (cache + installed_plugins.json refreshed).',
      '⚠️  Hook paths in `~/.claude/settings.json` were **not** rewritten — they may still point at the old version.',
      '   To fix: open `~/.claude/settings.json`, delete every entry whose `command` references',
      `   \`/cache/obsidian-mcp-router-marketplace/obsidian-router/${installed}/hooks/...\`,`,
      '   then re-add them via:',
      '',
      '```',
      `node ~/.claude/plugins/cache/obsidian-mcp-router-marketplace/obsidian-router/${latest}/scripts/setup-vault.mjs --install-hooks`,
      '```',
      '',
      '   Once done, activate the new version with:',
      '',
    );
  } else {
    lines.push(
      'New version is already installed (cache + installed_plugins.json + settings.json hook paths refreshed).',
      'To activate it in this session, run:',
      '',
    );
  }
  lines.push(
    '```',
    '/reload-plugins',
    '```',
    '',
  );
  if (markitdownStatus === 'will-break') {
    lines.push(
      '⚠️  **Markitdown needs to be re-installed for the new version.**',
      '    Auto-update skips post-install scripts for safety, so the new cache directory has no Python venv.',
      '    After `/reload-plugins`, any `*_to_markdown` tool will fail until you run:',
      '',
      '```',
      `node ~/.claude/plugins/cache/obsidian-mcp-router-marketplace/obsidian-router/${latest}/scripts/install-markitdown.mjs`,
      '```',
      '',
      '    Or set `MARKITDOWN_PATH` / `OBSIDIAN_ROUTER_SKIP_MARKITDOWN=1` to silence this.',
      '',
    );
  }
  // Last-resort net: a SessionStart hook must never die on a cosmetic notice.
  try { lines.push(...composeCachePurgeLines(cachePurge)); } catch { /* stay silent */ }
  lines.push(
    `New sessions will load v${latest} automatically — no action needed.`,
    '',
    `Changelog: ${CHANGELOG_URL}`,
    '',
    'To disable auto-update: unset `OBSIDIAN_ROUTER_AUTO_UPDATE` (or set it to false / 0 / no / off).',
    '',
  );
  return lines.join('\n');
}

/**
 * Render the cache-purge plan the update computed.
 *
 * Every update copies ~155 MB in and removes nothing, so without this the
 * cache grows silently forever — eight versions and ~1.2 GB by the time it
 * was first measured. Nothing is deleted here: the user gets the number and
 * the exact command, and decides.
 */
function composeCachePurgeLines(cachePurge) {
  if (!cachePurge) return [];
  const out = [];

  // An opted-in apply already ran: report what actually happened, including
  // failures, which would otherwise be invisible.
  if (cachePurge.applied) {
    const a = cachePurge.applied;
    // A BLOCKED apply used to be completely silent: this branch short-circuited
    // the `blocked` branch below, and then returned [] because `removed` and
    // `failed` are both empty on a refusal. The user had opted in, the purge
    // fail-closed, and nothing said so.
    if (a.blocked) {
      out.push(`🧹 Plugin-cache purge refused — ${a.blockedReason}`, '');
      return out;
    }
    if (Array.isArray(a.removed) && a.removed.length > 0) {
      out.push(`🧹 Reclaimed ${formatPurgeBytes(a.freedBytes)} from ${a.removed.length} stale plugin snapshot(s) (${a.removed.map((r) => r.version).join(', ')}).`, '');
    }
    if (Array.isArray(a.failed) && a.failed.length > 0) {
      out.push(`⚠️  ${a.failed.length} snapshot(s) could not be removed: ${a.failed.filter(Boolean).map((f) => `${f.version} (${f.error})`).join('; ')}`, '');
    }
    return out;
  }

  if (cachePurge.blocked) {
    // Fail-closed is not a bug, but staying silent about it is: the user
    // would never learn the cache is growing unchecked.
    out.push(`🧹 Plugin-cache purge skipped — ${cachePurge.blockedReason}`, '');
    return out;
  }

  if (!Array.isArray(cachePurge.purge) || cachePurge.purge.length === 0) return [];

  out.push(
    `🧹 **${formatPurgeBytes(cachePurge.reclaimableBytes)} of stale plugin snapshots** can be reclaimed `
    + `(${cachePurge.purge.length} old version${cachePurge.purge.length === 1 ? '' : 's'}: ${cachePurge.purge.filter(Boolean).map((p) => p.version).join(', ')}).`,
    '   Nothing has been deleted. The current version, the rollback snapshot, and anything a running session is using are never touched. To review and apply:',
    '',
    '```',
    'npm run purge:plugin-cache',
    '```',
    '',
  );
  return out;
}

/** Local byte formatter — the hook must not import from src/ at runtime. */
function formatPurgeBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
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
