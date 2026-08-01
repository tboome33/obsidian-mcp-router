#!/usr/bin/env node
/**
 * bridge-fleet-update.mjs — force the fleet's bridge plugin up to date.
 *
 * Every vault already self-updates the obsidian-mcp-router-bridge plugin via
 * BRAT (`updateAtStartup: true`, propagated by the living template) — but
 * BRAT's startup check is lazy: it can lag by minutes and gives no feedback.
 * This script is the DETERMINISTIC layer proven on 2026-08-01 during the
 * bridge 0.7.0 rollout: for each registered vault whose on-disk bridge
 * manifest is older than the target version, it fires BRAT's
 * `checkForUpdatesAndUpdate` command through the vault's Local REST API
 * command endpoint. Closed vaults are reported as "closed" — BRAT's startup
 * check covers them at their next launch.
 *
 * Target version resolution (fail-closed — never guesses):
 *   1. `--target X.Y.Z` when given;
 *   2. otherwise the GitHub latest release tag of
 *      tboome33/obsidian-mcp-router-bridge (bare-semver tags).
 *
 * Usage:
 *   node scripts/bridge-fleet-update.mjs [--target X.Y.Z] [--dry-run]
 *                                        [--wait [minutes]] [--json]
 *
 *   --dry-run   report what WOULD be triggered, trigger nothing
 *   --wait [m]  after triggering, poll the on-disk manifests until every
 *               triggered vault reaches the target (default 10 minutes)
 *   --json      machine-readable report on stdout
 *
 * Security posture: reads each vault's Local REST API `data.json` only for
 * its `apiKey` + `insecurePort`, talks to 127.0.0.1 exclusively, and never
 * prints the key. The only mutation is asking BRAT — inside Obsidian — to do
 * what it is already configured to do at startup.
 *
 * Exit codes: 0 = nothing stale or everything triggered (and, with --wait,
 * confirmed); 1 = unexpected error / target unresolvable; 2 = --wait timed
 * out with at least one vault still stale.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { compareSemver, parseSemver } from '../src/helpers/semver-compare.mjs';

const BRIDGE_REPO = 'tboome33/obsidian-mcp-router-bridge';
const BRAT_COMMAND = 'obsidian42-brat%3AcheckForUpdatesAndUpdate';
const BRIDGE_PLUGIN_DIR = '.obsidian/plugins/mcp-router-bridge';
const LRA_DATA = '.obsidian/plugins/obsidian-local-rest-api/data.json';

/**
 * Pure classification of one vault's bridge state against the target.
 * Exported for tests.
 *
 * @param {string|null} localVersion  — on-disk manifest version, null if absent
 * @param {string} targetVersion
 * @returns {'missing'|'stale'|'up-to-date'|'ahead'|'unparseable'}
 */
export function classifyBridge(localVersion, targetVersion) {
  if (localVersion == null) return 'missing';
  if (!parseSemver(localVersion) || !parseSemver(targetVersion)) return 'unparseable';
  const cmp = compareSemver(localVersion, targetVersion);
  if (cmp < 0) return 'stale';
  if (cmp > 0) return 'ahead';
  return 'up-to-date';
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function localBridgeVersion(vaultPath) {
  const m = readJson(path.join(vaultPath, BRIDGE_PLUGIN_DIR, 'manifest.json'));
  return m?.version ?? null;
}

async function resolveTarget(argTarget) {
  if (argTarget) {
    if (!parseSemver(argTarget)) throw new Error(`--target "${argTarget}" is not X.Y.Z semver`);
    return { version: argTarget.replace(/^v/, ''), source: '--target' };
  }
  const res = await fetch(`https://api.github.com/repos/${BRIDGE_REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'obsidian-mcp-router-fleet-update' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`GitHub latest-release lookup failed: HTTP ${res.status}. Pass --target X.Y.Z explicitly.`);
  const tag = (await res.json()).tag_name?.replace(/^v/, '');
  if (!parseSemver(tag)) throw new Error(`GitHub returned an unparseable tag "${tag}". Pass --target X.Y.Z.`);
  return { version: tag, source: 'github-latest' };
}

async function triggerBrat(vaultPath) {
  const lra = readJson(path.join(vaultPath, LRA_DATA));
  const key = lra?.apiKey;
  const port = lra?.insecurePort;
  if (!key || !port) return { ok: false, why: 'no-lra-config' };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/commands/${BRAT_COMMAND}/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(4000),
    });
    return res.status === 204 || res.ok
      ? { ok: true }
      : { ok: false, why: `http-${res.status}` };
  } catch {
    return { ok: false, why: 'closed' };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const json = args.includes('--json');
  const targetIdx = args.indexOf('--target');
  const argTarget = targetIdx !== -1 ? args[targetIdx + 1] : null;
  const waitIdx = args.indexOf('--wait');
  const waitMinutes = waitIdx !== -1 ? Number(args[waitIdx + 1]) || 10 : 0;

  const cfgPath = path.join(os.homedir(), '.claude', 'obsidian-mcp-router', 'config.json');
  const cfg = readJson(cfgPath);
  if (!cfg?.portRegistry) throw new Error(`No portRegistry in ${cfgPath}`);
  const disabled = new Set(cfg.disabledVaults || []);

  const { version: target, source } = await resolveTarget(argTarget);

  const rows = [];
  for (const vaultPath of Object.keys(cfg.portRegistry)) {
    if (disabled.has(vaultPath)) continue;
    const name = vaultPath.split(/[\\/]/).pop();
    const local = localBridgeVersion(vaultPath);
    const state = classifyBridge(local, target);
    const row = { name, vaultPath, local: local ?? '—', state, action: 'none' };
    if (state === 'stale') {
      if (dryRun) {
        row.action = 'would-trigger';
      } else {
        const t = await triggerBrat(vaultPath);
        row.action = t.ok ? 'triggered' : t.why; // 'closed' | 'no-lra-config' | 'http-*'
      }
    }
    rows.push(row);
  }

  const triggered = rows.filter((r) => r.action === 'triggered');
  let waitResult = null;
  if (waitMinutes > 0 && triggered.length > 0) {
    const deadline = Date.now() + waitMinutes * 60_000;
    const pending = new Set(triggered.map((r) => r.vaultPath));
    while (pending.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15_000));
      for (const vp of [...pending]) {
        if (classifyBridge(localBridgeVersion(vp), target) !== 'stale') pending.delete(vp);
      }
    }
    waitResult = { confirmed: triggered.length - pending.size, pending: [...pending].map((p) => p.split(/[\\/]/).pop()) };
    for (const r of rows) {
      if (r.action === 'triggered') r.action = waitResult.pending.includes(r.name) ? 'triggered-pending' : 'updated ✓';
    }
  }

  if (json) {
    console.log(JSON.stringify({ target, targetSource: source, dryRun, rows, waitResult }, null, 2));
  } else {
    console.log(`Cible bridge ${target} (${source})${dryRun ? ' — DRY RUN' : ''}\n`);
    for (const r of rows) {
      console.log(`  ${r.name.padEnd(32)} ${String(r.local).padEnd(7)} ${r.state.padEnd(11)} ${r.action}`);
    }
    const closed = rows.filter((r) => r.action === 'closed').length;
    if (closed) console.log(`\n${closed} vault(s) fermé(s) : BRAT (updateAtStartup) les mettra à jour à leur prochaine ouverture.`);
    if (waitResult) console.log(`\n--wait : ${waitResult.confirmed}/${triggered.length} confirmé(s) sur disque${waitResult.pending.length ? ' — encore en attente : ' + waitResult.pending.join(', ') : ''}.`);
  }

  if (waitResult && waitResult.pending.length > 0) process.exit(2);
}

// Run only when invoked directly (keeps `classifyBridge` importable in tests).
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((err) => {
    console.error('bridge-fleet-update:', err.message);
    process.exit(1);
  });
}
