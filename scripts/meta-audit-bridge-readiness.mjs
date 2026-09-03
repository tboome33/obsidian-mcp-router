#!/usr/bin/env node
/**
 * meta-audit-bridge-readiness.mjs
 *
 * Read-only audit of every configured Obsidian vault for click-to-open
 * (`GET /open/<path>`) readiness. Checks the FOUR prerequisites the
 * feature depends on:
 *
 *   1. mcp-router-bridge plugin ≥ 0.2.0 installed (route handler exists)
 *   2. Local REST API plugin ≥ 4.0.0 installed (exposes `addPublicRoute()`)
 *   3. enableInsecureServer: true + insecurePort set (HTTP server listening)
 *   4. LIVE PROBE: GET http://127.0.0.1:<insecurePort>/open/<nonexistent>
 *      returns 404 (= route registered) rather than 401 (= auth middleware
 *      catch-all, meaning the route never registered)
 *
 * The live probe catches the case the static-version checks can't:
 * files on disk are correct but Obsidian still has stale code in memory
 * (user hasn't reloaded after a sync).
 *
 * Output:
 *   - Compact table (vault, bridge, LRA, insecure, route, verdict)
 *   - Per-failure remediation hints
 *   - Exit code 0 if all ready, 1 if any vault is not ready
 *
 * Flags:
 *   --json    Emit a single JSON document instead of the human table.
 *             Useful for the meta-audit-bridge-readiness skill, scripts,
 *             or CI checks. Exit code semantics unchanged.
 *   --vault <name|path>
 *             Audit a single vault by slug (from config.vaultNames) or
 *             absolute path. Defaults to all configured vaults.
 *
 * No writes, no side effects.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { normalizePortEntry } from '../src/helpers/port-registry.mjs';
import {
  configuredVaultName,
  disabledVaultEntries,
  registeredVaultPaths,
  vaultNamesOf,
} from '../src/helpers/vault-slug.mjs';

const CONFIG_PATH = path.join(os.homedir(), '.claude', 'obsidian-mcp-router', 'config.json');

const MIN_BRIDGE = '0.2.0';
const MIN_LRA = '4.0.0';

const COLORS = {
  reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', gray: '\x1b[90m', bold: '\x1b[1m',
};
const c = (color, s) => `${COLORS[color]}${s}${COLORS.reset}`;

function gte(a, b) {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return true;
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

function probeOpenRoute(insecurePort) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: insecurePort, method: 'GET',
      path: '/open/__mcp_audit_probe__nonexistent_file__.md',
      timeout: 3000,
    }, (res) => {
      res.on('data', () => {}); // drain
      res.on('end', () => resolve({ status: res.statusCode, error: null }));
    });
    req.on('error', (err) => resolve({ status: null, error: err.code || err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: null, error: 'TIMEOUT' }); });
    req.end();
  });
}

async function auditVault(vaultPath, vaultName, httpsPort) {
  const bridgeManifest = readJson(path.join(vaultPath, '.obsidian', 'plugins', 'mcp-router-bridge', 'manifest.json'));
  const lraManifest = readJson(path.join(vaultPath, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'manifest.json'));
  const lraData = readJson(path.join(vaultPath, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'));

  const bridgeVersion = bridgeManifest?.version ?? null;
  const lraVersion = lraManifest?.version ?? null;
  const insecurePort = lraData?.insecurePort ?? null;
  const enableInsecureServer = lraData?.enableInsecureServer === true;

  const checks = {
    bridgeInstalled: !!bridgeManifest,
    bridgeOk: !!bridgeVersion && gte(bridgeVersion, MIN_BRIDGE),
    lraInstalled: !!lraManifest,
    lraOk: !!lraVersion && gte(lraVersion, MIN_LRA),
    insecureEnabled: enableInsecureServer && Number.isInteger(insecurePort),
    routeLive: null,
    probeResult: null,
  };

  if (checks.insecureEnabled) {
    const probe = await probeOpenRoute(insecurePort);
    checks.probeResult = probe;
    checks.routeLive = probe.status === 404;
  }

  const ready = checks.bridgeOk && checks.lraOk && checks.insecureEnabled && checks.routeLive === true;

  return {
    vaultName, vaultPath, httpsPort, insecurePort,
    bridgeVersion, lraVersion, enableInsecureServer,
    checks, ready,
  };
}

function renderTable(results) {
  const headers = ['vault', 'bridge', 'LRA', 'insecure', '/open route', ''];
  const rows = results.map((r) => {
    const probe = r.checks.probeResult;
    let routeCell;
    if (r.checks.routeLive === true) routeCell = c('green', 'live (404)');
    else if (r.checks.routeLive === false) {
      if (probe?.error === 'ECONNREFUSED') routeCell = c('red', 'no HTTP server');
      else if (probe?.status === 401) routeCell = c('red', 'stale (HTTP 401)');
      else routeCell = c('red', probe?.error || `HTTP ${probe?.status}`);
    } else routeCell = c('gray', '— (not probed)');

    return [
      r.vaultName,
      r.bridgeVersion ? (r.checks.bridgeOk ? r.bridgeVersion : c('yellow', r.bridgeVersion)) : c('red', '(missing)'),
      r.lraVersion ? (r.checks.lraOk ? r.lraVersion : c('yellow', r.lraVersion)) : c('red', '(missing)'),
      r.checks.insecureEnabled ? `:${r.insecurePort}` : c('red', 'OFF'),
      routeCell,
      r.ready ? c('green', '✅') : c('red', '❌'),
    ];
  });

  // strip color for width calc
  const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
  const widths = headers.map((h, i) => Math.max(
    stripAnsi(h).length,
    ...rows.map((r) => stripAnsi(r[i]).length),
  ));
  const fmtRow = (cells) => '  ' + cells.map((cell, i) => {
    const visible = stripAnsi(cell);
    return cell + ' '.repeat(widths[i] - visible.length);
  }).join('  ');

  console.log(fmtRow(headers.map((h) => c('bold', h))));
  console.log('  ' + widths.map((w) => '─'.repeat(w)).join('  '));
  rows.forEach((r) => console.log(fmtRow(r)));
}

function renderRemediation(failures) {
  console.log('');
  console.log(c('bold', `Found ${failures.length} vault(s) not ready:`));
  console.log('');
  for (const r of failures) {
    console.log(`  ${c('cyan', r.vaultName)}  ${c('gray', r.vaultPath)}`);
    if (!r.checks.bridgeInstalled) {
      console.log(`    • bridge plugin missing → ${c('cyan', `node scripts/setup-vault.mjs "${r.vaultPath}" --sync-plugins --force`)}`);
    } else if (!r.checks.bridgeOk) {
      console.log(`    • bridge v${r.bridgeVersion} < required v${MIN_BRIDGE} → in obsidian-mcp-router-bridge repo: ${c('cyan', 'npm run deploy:all')}`);
    }
    if (!r.checks.lraInstalled) {
      console.log(`    • Local REST API missing → install via Obsidian Settings → Community plugins`);
    } else if (!r.checks.lraOk) {
      console.log(`    • Local REST API v${r.lraVersion} < required v${MIN_LRA} → update via Obsidian Settings → Community plugins, OR copy v4.x main.js+manifest+styles.css into .template then ${c('cyan', 'node scripts/setup-vault.mjs --sync-all --force')}`);
    }
    if (!r.checks.insecureEnabled) {
      console.log(`    • enableInsecureServer false OR insecurePort missing → edit ${c('gray', '.obsidian/plugins/obsidian-local-rest-api/data.json')}, set ${c('cyan', '"enableInsecureServer": true')} + a free insecurePort, reload Obsidian`);
    }
    if (r.checks.insecureEnabled && r.checks.routeLive === false) {
      const probe = r.checks.probeResult;
      if (probe?.error === 'ECONNREFUSED') {
        console.log(`    • HTTP server not responding on :${r.insecurePort} → Obsidian closed, OR Local REST API plugin disabled, OR insecure server toggle off`);
      } else if (probe?.status === 401) {
        console.log(`    • /open route NOT registered (auth middleware catch-all returned 401) → files on disk look right but Obsidian has stale code in memory → ${c('cyan', 'Ctrl+P → "Reload app without saving"')} in this vault's Obsidian instance`);
      } else {
        console.log(`    • /open probe unexpected: ${probe?.error || `HTTP ${probe?.status}`} → investigate manually`);
      }
    }
    console.log('');
  }
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const vaultIdx = args.indexOf('--vault');
  const vaultFilter = vaultIdx >= 0 ? args[vaultIdx + 1] : null;

  if (!fs.existsSync(CONFIG_PATH)) {
    const msg = `Router config not found at ${CONFIG_PATH}. Run setup-vault.mjs --init-reference first.`;
    if (asJson) console.log(JSON.stringify({ error: msg }));
    else console.error(c('red', '✗ ') + msg);
    process.exit(2);
  }

  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  // Through the accessor: the container is validated there, so a hand-edited
  // `"portRegistry": "AB"` yields no vaults instead of the paths "0" and
  // "1". Sixth key of the `vaultNames` class, swept in the final review.
  let entries = registeredVaultPaths(cfg).map((vp) => [vp, cfg.portRegistry[vp]]);
  // Same container defect as bridge-fleet-update.mjs: a bare string built a set
  // of characters instead of throwing, and a number threw. (v0.90.0)
  const disabled = new Set(disabledVaultEntries(cfg));
  entries = entries.filter(([p]) => !disabled.has(p));

  if (vaultFilter) {
    const before = entries.length;
    // `configuredVaultName` rather than a raw `cfg.vaultNames?.[p]`: the filter
    // is unchanged (a vault is still selected by its PATH or by its CUSTOM
    // name), but a non-string entry now reads as "no custom name" instead of
    // being compared as one. Same reason the listing below is filtered — a
    // hand-edited number has no business being offered as a slug to type.
    entries = entries.filter(([p]) => p === vaultFilter || configuredVaultName(cfg, p) === vaultFilter);
    if (entries.length === 0) {
      const known = Object.values(vaultNamesOf(cfg) || {}).filter((n) => typeof n === 'string' && n !== '');
      const msg = `No vault matched "${vaultFilter}". Known slugs: ${known.join(', ')}`;
      if (asJson) console.log(JSON.stringify({ error: msg, candidates: before }));
      else console.error(c('red', '✗ ') + msg);
      process.exit(2);
    }
  }

  if (entries.length === 0) {
    if (asJson) console.log(JSON.stringify({ results: [], message: 'No vaults registered.' }));
    else console.log('No vaults registered in portRegistry.');
    return;
  }

  if (!asJson) {
    console.log(c('bold', `Auditing ${entries.length} vault(s) for click-to-open readiness…`));
    console.log(c('gray', `  Requires: mcp-router-bridge ≥ ${MIN_BRIDGE} · Local REST API ≥ ${MIN_LRA} · enableInsecureServer: true · live /open/* route`));
    console.log('');
  }

  // A portRegistry value is the legacy number OR { https, http } (v0.77.0) —
  // normalize before use, or the object would be printed as the vault's HTTPS
  // port in the report.
  const results = await Promise.all(entries.map(([p, value]) =>
    // The report LABELS a vault, so the fallback stays `path.basename` (on-disk
    // case preserved) rather than the lowercased router slug. Only the lookup
    // changed: `?? cfg.vaultNames?.[p]` accepted a number, and an empty string,
    // as the label. (v0.90.0)
    auditVault(p, configuredVaultName(cfg, p) ?? path.basename(p), normalizePortEntry(value).https),
  ));

  if (asJson) {
    console.log(JSON.stringify({
      minBridge: MIN_BRIDGE,
      minLra: MIN_LRA,
      results,
      summary: {
        total: results.length,
        ready: results.filter((r) => r.ready).length,
        notReady: results.filter((r) => !r.ready).length,
      },
    }, null, 2));
  } else {
    renderTable(results);
    console.log('');
    const failures = results.filter((r) => !r.ready);
    if (failures.length === 0) {
      console.log(c('green', '🎉 All ' + results.length + ' vault(s) are click-to-open ready.'));
    } else {
      renderRemediation(failures);
    }
  }

  process.exit(results.every((r) => r.ready) ? 0 : 1);
}

main().catch((err) => {
  console.error(c('red', '✗ Audit crashed: ') + (err?.stack || err));
  process.exit(2);
});
