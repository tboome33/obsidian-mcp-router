#!/usr/bin/env node
/**
 * purge-plugin-cache.mjs — reclaim stale plugin-cache snapshots.
 *
 * Preview-first, sealed apply. With no flags it prints the plan and removes
 * nothing; `--confirm <seal>` replays the seal the preview printed, and the
 * apply re-derives the plan from the current state and aborts on any drift.
 * So a snapshot that became live between the two steps (someone opened a
 * session from it) stops the whole operation instead of being deleted under
 * that session's feet.
 *
 * Usage:
 *   node scripts/purge-plugin-cache.mjs                      # preview
 *   node scripts/purge-plugin-cache.mjs --confirm <seal>     # apply
 *   node scripts/purge-plugin-cache.mjs --json               # machine output
 *
 * Flags:
 *   --confirm <seal>   apply the plan whose approvedPlanSha256 is <seal>
 *   --keep-previous N  how many older versions to keep for rollback (default 1)
 *   --marketplace <m>  default: obsidian-mcp-router-marketplace
 *   --plugin <p>       default: obsidian-router
 *   --json             emit JSON instead of prose
 *
 * Exit codes: 0 = fine (nothing to do, preview shown, or apply succeeded);
 * 1 = refused (fail-closed) or an apply hit an error.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  planCachePurge, applyCachePurge, renderPurgePlan, formatBytes,
} from '../src/helpers/plugin-cache-purge.mjs';
import { PKG_VERSION } from '../src/helpers/pkg-version.mjs';
import { compareSemver, parseSemver } from '../src/helpers/semver-compare.mjs';

const DEFAULT_MARKETPLACE = 'obsidian-mcp-router-marketplace';
const DEFAULT_PLUGIN = 'obsidian-router';

function parseArgs(argv) {
  const out = {
    confirm: null, keepPrevious: 1, json: false,
    marketplace: DEFAULT_MARKETPLACE, plugin: DEFAULT_PLUGIN,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--confirm') out.confirm = argv[++i];
    else if (a === '--keep-previous') out.keepPrevious = Number(argv[++i]);
    else if (a === '--marketplace') out.marketplace = argv[++i];
    else if (a === '--plugin') out.plugin = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else { console.error(`Unknown flag: ${a}`); process.exit(2); }
  }
  if (!Number.isInteger(out.keepPrevious) || out.keepPrevious < 1) {
    console.error('--keep-previous must be an integer >= 1 — the N-1 rollback snapshot is not negotiable');
    process.exit(2);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log([
      'purge-plugin-cache — reclaim stale plugin-cache snapshots (preview first).',
      '',
      '  node scripts/purge-plugin-cache.mjs                   preview, removes nothing',
      '  node scripts/purge-plugin-cache.mjs --confirm <seal>  apply the previewed plan',
      '',
      'Never removes: the current version, anything a manifest names, the N-1',
      'rollback snapshot, or a snapshot a running process is serving from.',
      'If it cannot tell what is running, it purges nothing and says so.',
    ].join('\n'));
    return;
  }

  // The current version must come from the MANIFEST, not from this
  // checkout's package.json. Run the CLI from a stale clone and
  // `PKG_VERSION` is some older release that may still sit in the cache —
  // the rollback would then be anchored to the checkout instead of to what
  // is installed, and could purge the true N-1 of the running release. The
  // package version is only a last resort, and it is reported as such.
  const installed = installedVersionFor(args.marketplace, args.plugin);
  const currentVersion = installed || safeVersion();

  const common = {
    homeDir: os.homedir(),
    marketplace: args.marketplace,
    plugin: args.plugin,
    currentVersion,
    pluginRoot: process.env.CLAUDE_PLUGIN_ROOT || null,
    keepPrevious: args.keepPrevious,
  };

  if (!args.json && !installed) {
    console.error(`note: installed_plugins.json names no version for ${args.plugin}@${args.marketplace};`);
    console.error(`      falling back to this checkout's version (${safeVersion()}) to anchor the rollback.`);
    console.error('');
  }

  if (!args.confirm) {
    const plan = planCachePurge(common);
    if (args.json) {
      console.log(JSON.stringify({ ...plan, currentVersion, currentVersionSource: installed ? 'installed_plugins.json' : 'package.json' }, null, 2));
    } else {
      console.log(renderPurgePlan(plan));
      if (!plan.blocked && plan.purge.length > 0) {
        console.log('');
        console.log('Nothing has been deleted. To apply exactly this plan:');
        console.log('');
        // Every non-default planning option is repeated. Dropping them made
        // the apply re-derive a DIFFERENT plan, which then failed seal
        // verification — the printed command could not reproduce the plan it
        // claimed to reproduce.
        console.log(`  ${applyCommandFor(args, plan.approvedPlanSha256)}`);
      }
    }
    process.exit(plan.blocked ? 1 : 0);
  }

  let result;
  try {
    result = applyCachePurge({ ...common, approvedPlanSha256: args.confirm });
  } catch (err) {
    // PlanDriftError lands here: the cache changed since the preview.
    //
    // The shared C3 primitive phrases drift in terms of a VAULT, because
    // that is what every other sealed operation touches. Repeating that here
    // sends the reader to look at their notes when the thing that changed is
    // the plugin cache — so the domain sentence is ours, and the primitive's
    // wording is kept underneath rather than discarded.
    console.error('Refused: the plugin cache changed since the preview, so the plan you approved is not the plan that would run now. Nothing was deleted.');
    console.error('Re-run the preview to get a fresh seal, look at what it lists, and pass THAT:');
    console.error('');
    console.error('  node scripts/purge-plugin-cache.mjs');
    console.error('');
    console.error(`(underlying: ${err.message})`);
    process.exit(1);
  }

  if (args.json) {
    console.log(JSON.stringify({ ...result, currentVersion, currentVersionSource: installed ? 'installed_plugins.json' : 'package.json' }, null, 2));
  } else if (result.blocked) {
    console.error(`REFUSING TO PURGE — ${result.blockedReason}`);
  } else {
    for (const r of result.removed) console.log(`removed ${r.version}  (${formatBytes(r.bytes)})`);
    for (const f of result.failed) console.error(`FAILED  ${f.version}  ${f.error}`);
    console.log('');
    console.log(`Freed ${formatBytes(result.freedBytes)} across ${result.removed.length} snapshot(s).`);
    if (result.failed.length > 0) {
      console.log(`${result.failed.length} could not be removed — a locked directory usually means something is still using it.`);
    }
  }
  process.exit(result.blocked || result.failed.length > 0 ? 1 : 0);
}

function safeVersion() {
  return PKG_VERSION || null;
}

/**
 * The version `installed_plugins.json` currently names for this plugin.
 *
 * Two things this must NOT do, both found in review:
 *
 *   - Take the FIRST array entry. The v2 schema stores an array of SCOPED
 *     installs, and array order carries no claim about which one is active:
 *     a stale `scope: project` at 0.50.0 listed before the live
 *     `scope: user` at 0.67.0 would anchor the rollback on 0.50.0, leaving
 *     the real predecessor of the running release purgeable. The highest
 *     semver is picked instead — deterministic, and it errs toward keeping
 *     more.
 *   - Accept any non-empty string. The manifest on the machine this was
 *     written on holds ten `"version": "unknown"` entries and one commit
 *     sha. Those are not versions: `"unknown"` would become the anchor, no
 *     cached directory would match it, the anchor would silently fall back
 *     to the newest directory, and the "falling back" note would NOT print
 *     because a truthy value had been found. Non-semver values are ignored.
 *
 * Returns null when nothing usable is named — the caller then falls back
 * to the package version and SAYS so.
 */
function installedVersionFor(marketplace, plugin) {
  try {
    const raw = fs.readFileSync(
      path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8',
    );
    const data = JSON.parse(raw);
    const key = `${plugin}@${marketplace}`;
    const value = (data.plugins && data.plugins[key]) ?? data[key];
    const entries = Array.isArray(value) ? value : (value ? [value] : []);
    const versions = entries
      .map((e) => (e && typeof e.version === 'string' ? e.version.trim() : ''))
      .filter((v) => v && parseSemver(v));
    if (versions.length === 0) return null;
    return versions.sort((a, b) => compareSemver(b, a))[0];
  } catch { /* fall through to the package version */ }
  return null;
}

/** The apply command, carrying every non-default planning option. */
function applyCommandFor(args, seal) {
  const parts = ['node scripts/purge-plugin-cache.mjs'];
  if (args.marketplace !== DEFAULT_MARKETPLACE) parts.push(`--marketplace ${args.marketplace}`);
  if (args.plugin !== DEFAULT_PLUGIN) parts.push(`--plugin ${args.plugin}`);
  if (args.keepPrevious !== 1) parts.push(`--keep-previous ${args.keepPrevious}`);
  parts.push(`--confirm ${seal}`);
  return parts.join(' ');
}

main();
