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
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { compareSemver, parseSemver } from '../src/helpers/semver-compare.mjs';

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
const cacheDir = path.join(os.homedir(), '.claude', 'obsidian-mcp-router');
const cacheFile = path.join(cacheDir, '.last-version-check.json');

let cached = null;
try {
  cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
} catch {
  // First run or unreadable cache — re-fetch
}

const now = Date.now();
if (cached && typeof cached.checkedAt === 'number' && now - cached.checkedAt < CACHE_TTL_MS) {
  // Within throttle window — replay cached notice if any.
  if (cached.notice && cached.installedAtCheck === installedVersion) {
    process.stdout.write(cached.notice);
  }
  process.exit(0);
}

// ─── Fetch latest version from GitHub ─────────────────────────────────
const req = https.get(
  PACKAGE_JSON_URL,
  { timeout: FETCH_TIMEOUT_MS, headers: { 'User-Agent': 'obsidian-mcp-router/check-router-update' } },
  (res) => {
    if (res.statusCode !== 200) {
      persistCache({ checkedAt: now, notice: null, installedAtCheck: installedVersion });
      return process.exit(0);
    }
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      let latestVersion = null;
      try {
        latestVersion = JSON.parse(body).version;
      } catch {
        persistCache({ checkedAt: now, notice: null, installedAtCheck: installedVersion });
        return process.exit(0);
      }
      if (!latestVersion || !parseSemver(latestVersion)) {
        persistCache({ checkedAt: now, notice: null, installedAtCheck: installedVersion });
        return process.exit(0);
      }
      const cmp = compareSemver(latestVersion, installedVersion);
      if (cmp <= 0) {
        // Up to date or local is ahead (dev install)
        persistCache({ checkedAt: now, notice: null, installedAtCheck: installedVersion });
        return process.exit(0);
      }
      const notice = composeNotice(installedVersion, latestVersion);
      persistCache({ checkedAt: now, notice, installedAtCheck: installedVersion });
      process.stdout.write(notice);
      process.exit(0);
    });
  },
);

req.on('error', () => process.exit(0));
req.on('timeout', () => { req.destroy(); process.exit(0); });

// ─── Helpers ──────────────────────────────────────────────────────────
function composeNotice(installed, latest) {
  return [
    '',
    '<!-- obsidian-mcp-router update notice — please relay to the user on your first response -->',
    `📦 **obsidian-mcp-router v${latest} is available** (you have v${installed}).`,
    '',
    'How to update:',
    `- Try: \`/plugin update obsidian-router@obsidian-mcp-router-marketplace\``,
    `- If \`/plugin\` is unavailable in your environment, see the manual update guide at`,
    `  https://github.com/tboome33/obsidian-mcp-router/blob/main/docs/how-to-update.md`,
    '',
    `Changelog: ${CHANGELOG_URL}`,
    '',
    'To disable this once-per-day update check: set env var `OBSIDIAN_ROUTER_NO_UPDATE_CHECK=true`.',
    '',
  ].join('\n');
}

function persistCache(entry) {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(entry, null, 2) + '\n');
  } catch {
    // Cache write failure is non-fatal
  }
}
