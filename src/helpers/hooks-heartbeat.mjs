/**
 * Did this session's plugin hooks actually run?
 *
 * On 2026-09-25 a session on the Hermes VM ran a whole night with NO plugin
 * hook at all: the copy of the plugin Claude Code had placed on that machine
 * had no `hooks/` directory. `hot.md` was never injected, `decisions-recall`
 * never spoke, the workspace briefing never appeared — and nothing said so.
 * The workspace's CLAUDE.md block even promised "auto-loaded at session start".
 * A missing hook is silent by nature: the only thing that can notice is
 * something that runs anyway. The MCP server does.
 *
 * So `hot-cache-load` (session start) and `decisions-recall` (each prompt)
 * leave a heartbeat — the time they ran, per workspace — in a small file
 * beside the router config, and `list_vaults` reads it back:
 *
 *   observed           a SessionStart hook ran for this workspace since this
 *                      server started (with a margin: the two start together)
 *   absent-from-plugin the running copy of the plugin has no hooks/hooks.json —
 *                      nothing can have run, whatever the timing
 *   not-yet-observed   the server started moments ago; the hook may still be
 *                      running. Not an alarm.
 *   not-observed       no heartbeat since this server started. Hooks disabled,
 *                      not loaded by this host, or the opt-out set.
 *
 * The heartbeat is keyed by workspace (a hash of the cwd), so parallel sessions
 * in different workspaces do not see each other's. Two sessions in the SAME
 * workspace share one — the question "did hooks run here recently" is still
 * answered correctly for both.
 *
 * Writing it is best effort and never throws: a hook must not fail because
 * the heartbeat could not be written.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The router config path, as every other component resolves it. */
export function defaultRouterConfigPath(env = process.env) {
  return env.OBSIDIAN_ROUTER_CONFIG
    ? path.resolve(env.OBSIDIAN_ROUTER_CONFIG)
    : path.join(os.homedir(), '.claude', 'obsidian-mcp-router', 'config.json');
}

/** Stable per-workspace key: case-folded where the filesystem folds case. */
export function heartbeatKey(cwd) {
  // The REAL path on both sides: the hook gets the cwd Claude Code reports,
  // the server has process.cwd(), and a symlinked workspace, a subst drive or
  // an 8.3 short name spells the same directory two ways.
  let r = path.resolve(String(cwd ?? ''));
  try { r = fs.realpathSync.native(r); } catch { /* absent: keep the resolved spelling */ }
  const norm = process.platform === 'linux' ? r : r.toLowerCase();
  return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

/** Hook names become file names: nothing but a closed, safe alphabet. */
function safeHookName(hook) {
  const s = String(hook ?? '');
  return /^[a-z0-9-]{1,40}$/.test(s) ? s : null;
}

/**
 * ONE FILE PER HOOK, per workspace. A single shared file was the first
 * version, and review found the lost update: hot-cache-load and
 * decisions-recall start together, both read the old record, and the second
 * rename erased the first one's timestamp — the server then reported
 * `not-observed` for hooks that had run. Separate files cannot collide.
 */
export function heartbeatPath(configPath, cwd, hook) {
  const name = safeHookName(hook);
  if (!name) throw new Error(`invalid hook name for a heartbeat: ${JSON.stringify(hook)}`);
  return path.join(path.dirname(configPath), 'hook-heartbeats', `${heartbeatKey(cwd)}.${name}.json`);
}

/**
 * Record that `hook` ran for `cwd`. Never throws; returns true when written.
 */
export function recordHookHeartbeat({ hook, cwd, configPath = defaultRouterConfigPath(), now = new Date(), pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? null }) {
  let tmp = null;
  try {
    const file = heartbeatPath(configPath, cwd, hook);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ cwd: path.resolve(String(cwd)), hook, at: now.toISOString(), pluginRoot }, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    if (tmp) { try { fs.rmSync(tmp, { force: true }); } catch { /* nothing more to do */ } }
    return false;
  }
}

/** The hooks that leave a heartbeat — the only files a reader looks for. */
export const HEARTBEAT_HOOKS = Object.freeze(['hot-cache-load', 'decisions-recall']);

/**
 * Every hook's heartbeat for `cwd`, as `{ cwd, hooks: { name: iso } }`, or null
 * when there is none. Never throws.
 */
export function readHookHeartbeat({ cwd, configPath = defaultRouterConfigPath() }) {
  // The known files, read directly: no scan of a directory that grows with
  // every workspace ever opened (review round 2).
  try {
    const hooks = {};
    for (const name of HEARTBEAT_HOOKS) {
      try {
        const rec = JSON.parse(fs.readFileSync(heartbeatPath(configPath, cwd, name), 'utf8'));
        if (rec && typeof rec.at === 'string') hooks[name] = rec.at;
      } catch { /* absent, torn or foreign: not evidence */ }
    }
    return Object.keys(hooks).length > 0 ? { cwd: path.resolve(String(cwd)), hooks } : null;
  } catch {
    return null;
  }
}

/**
 * The session-start hook that leaves a heartbeat. Only one: the other
 * session-start hook, workspace-briefing, is pinned to write NO file anywhere
 * (it is the disclosure a project file must not be able to shape), and that
 * invariant outranks a second witness.
 */
export const SESSION_START_HOOKS = Object.freeze(['hot-cache-load']);

/** Margin before server start: the hook and the server are launched together. */
const START_MARGIN_MS = 5 * 60 * 1000;
/** How long after server start silence is not yet meaningful. */
const GRACE_MS = 30 * 1000;

/**
 * Pure verdict.
 * @param {object} input
 * @param {object|null} input.heartbeat readHookHeartbeat() result
 * @param {Date} input.startedAt when this server process started
 * @param {Date} input.now
 * @param {boolean} input.hooksManifest whether the running plugin copy has hooks/hooks.json
 */
export function sessionHooksStatus({ heartbeat, startedAt, now, hooksManifest, workspace = null }) {
  const floor = startedAt.getTime() - START_MARGIN_MS;
  const seen = {};
  for (const [hook, at] of Object.entries(heartbeat?.hooks ?? {})) {
    const t = Date.parse(at);
    if (Number.isFinite(t)) seen[hook] = at;
  }
  const recent = (h) => Boolean(seen[h]) && Date.parse(seen[h]) >= floor;
  const startSeen = SESSION_START_HOOKS.filter(recent).map((h) => ({ hook: h, at: seen[h] }));
  // What the verdict is ABOUT, stated with it: the server reads the heartbeat
  // of ITS OWN working directory. A server the host started elsewhere (Claude
  // Desktop, a launcher) is not the one the hooks talked to, and its verdict
  // says nothing about any workspace's session.
  const scope = workspace ? { workspace } : {};
  const scopeNote = ' This verdict is about the workspace this server was started in (`workspace`); a server started by the host outside any workspace cannot see a session\'s hooks.';

  if (startSeen.length > 0) {
    // `observed` means the hook RAN, not that hot.md was injected: it exits
    // silently on a workspace with no vault or a vault with no hot.md.
    return { status: 'observed', lastRun: startSeen[0], lastSeen: seen, ...scope };
  }
  if (hooksManifest === false) {
    // An earlier run on record (from another copy, or before a reconnect onto
    // this one) makes the injection into this session UNKNOWN — the missing
    // manifest proves only that THIS copy cannot run hooks (review round 3).
    const injection = seen['hot-cache-load']
      ? `hot-cache-load last ran at ${seen['hot-cache-load']}, from elsewhere or before this server started — whether hot.md is in your context is UNKNOWN from here`
      : 'hot.md was not injected, decisions-recall and the workspace briefing do not run';
    return {
      status: 'absent-from-plugin',
      message: `The copy of the plugin this server runs from has no hooks/hooks.json, so no plugin hook can run from it: ${injection}. Do not assume that context is loaded; read wiki-meta/hot.md with get_file if you need it. Seen when Claude Code places the plugin on a remote machine without its hooks/ folder; reinstall or update the plugin there.`,
      lastSeen: seen,
      ...scope,
    };
  }
  if (now.getTime() - startedAt.getTime() < GRACE_MS) {
    return { status: 'not-yet-observed', message: 'The server started moments ago; the session-start hooks may still be running. Ask again in a minute.', lastSeen: seen, ...scope };
  }
  const othersRan = recent('decisions-recall');
  // An OLDER run changes what can be said. A server restarted in the middle of
  // a session (a /mcp reconnect) starts AFTER that session's hooks ran, so with
  // an earlier hot-cache-load run on record the injection is UNKNOWN — never
  // asserted absent, never blamed on a switched-off hook (review round 2).
  if (seen['hot-cache-load']) {
    return {
      status: 'not-observed',
      message: `No session-start hook has run since this server started; hot-cache-load last ran at ${seen['hot-cache-load']}, before it. If this server was restarted during the session, that run may be this session's — whether hot.md is in your context is UNKNOWN from here. Read wiki-meta/hot.md with get_file if you need it.${scopeNote}`,
      lastSeen: seen,
      ...scope,
    };
  }
  return {
    status: 'not-observed',
    message: (othersRan
      ? 'hot-cache-load has never run for this workspace, although decisions-recall has: plugin hooks work here, but hot.md was NOT injected — hot-cache-load is switched off (OBSIDIAN_ROUTER_NO_HOT_CACHE_LOAD) or failing. Read wiki-meta/hot.md with get_file if you need it.'
      : 'No session-start hook has ever run for this workspace: hot.md was NOT injected into this session. Do not assume that context is loaded; read wiki-meta/hot.md with get_file if you need it. Causes: plugin hooks disabled or not loaded by this host, or hot-cache-load switched off (OBSIDIAN_ROUTER_NO_HOT_CACHE_LOAD).')
      + scopeNote,
    lastSeen: seen,
    ...scope,
  };
}
