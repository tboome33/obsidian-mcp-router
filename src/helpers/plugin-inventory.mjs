/**
 * plugin-inventory — what a vault's plugins look like ON DISK, and, when the
 * vault's REST API answers, what Obsidian actually LOADED.
 *
 * The two are different questions and the difference is the whole point.
 * `community-plugins.json` says which plugins Obsidian should enable; the
 * `.obsidian/plugins/<id>/` folders say which have code; neither says what is
 * running. A plugin can be:
 *   - installed with code (main.js + manifest.json);
 *   - SETTINGS ONLY — a folder with a data.json and no code, the shape a
 *     skeleton pre-seed or a settings-only sync leaves behind. Obsidian shows
 *     nothing for it;
 *   - ENABLED WITHOUT CODE — listed in community-plugins.json, no main.js.
 *     The silent failure this module exists to name;
 *   - installed and listed, yet not loaded — Restricted mode is on, or
 *     Obsidian has not been reloaded since the code arrived.
 * Only the last needs the live check: `GET /commands/` lists every command
 * Obsidian registered, prefixed by the id of the plugin that registered it.
 * A plugin that registers no command never appears there, so "no command
 * seen" is reported as exactly that — never as "not loaded".
 *
 * `inspectVaultPlugins` is pure over an injected fs; the live half takes an
 * injected request function. Disk reads refuse to run inside the router
 * server process (server-process.mjs), like semantic-readiness-fs.mjs.
 */

import nodeFs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { isServerProcess } from './server-process.mjs';
import { resolveLocalRestState, REST_DATA_STATUS } from './rest-endpoint-state.mjs';

export const REQUIRED_PLUGIN_IDS = Object.freeze(['obsidian-local-rest-api', 'mcp-router-bridge']);
export const BRIDGE_ID = 'mcp-router-bridge';
export const LOCAL_REST_API_ID = 'obsidian-local-rest-api';
/** A path the bridge's `/open/` route answers 404 for when it is registered. */
export const OPEN_PROBE_PATH = '/open/__mcp_plugin_health_probe__nonexistent__.md';

function assertNotServerProcess() {
  if (isServerProcess()) {
    throw new Error(
      'plugin-inventory: refusing to read a vault\'s disk inside the router server process. '
      + 'The server is HTTP-only (tests/no-vault-disk.test.mjs); plugin health is a CLI command.',
    );
  }
}

function readJson(fs, p) {
  try { return { ok: true, value: JSON.parse(fs.readFileSync(p, 'utf8')) }; } catch (err) { return { ok: false, code: err && err.code }; }
}
function isFile(fs, p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
function isDir(fs, p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * The expected set: the bundled skeleton's community-plugins.json ∪ REQUIRED.
 * A missing or unreadable skeleton degrades to REQUIRED alone.
 */
export function loadExpectedPlugins(skeletonCommunityFile, { fs = nodeFs, required = REQUIRED_PLUGIN_IDS } = {}) {
  const r = readJson(fs, skeletonCommunityFile);
  const listed = r.ok && Array.isArray(r.value) ? r.value.filter((x) => typeof x === 'string') : [];
  return [...new Set([...required, ...listed])];
}

/**
 * @param {string} vaultPath
 * @param {{ fs?: object, expected?: string[], required?: readonly string[] }} [opts]
 */
export function inspectVaultPlugins(vaultPath, { fs = nodeFs, expected = [], required = REQUIRED_PLUGIN_IDS } = {}) {
  assertNotServerProcess();
  const obsidianDir = path.join(vaultPath, '.obsidian');
  const pluginsDir = path.join(obsidianDir, 'plugins');

  const cp = readJson(fs, path.join(obsidianDir, 'community-plugins.json'));
  let communityPlugins;
  if (cp.ok && Array.isArray(cp.value)) communityPlugins = { state: 'ok', ids: cp.value.filter((x) => typeof x === 'string') };
  else if (!cp.ok && cp.code === 'ENOENT') communityPlugins = { state: 'absent', ids: [] };
  else communityPlugins = { state: 'invalid', ids: [] };
  const listed = new Set(communityPlugins.ids);

  let dirs = [];
  try {
    dirs = fs.readdirSync(pluginsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch { dirs = []; }

  const requiredSet = new Set(required);
  const expectedSet = new Set([...required, ...expected]);
  const ids = [...new Set([...communityPlugins.ids, ...dirs, ...expectedSet])].sort();

  const plugins = ids.map((id) => {
    const dir = path.join(pluginsDir, id);
    const dirPresent = isDir(fs, dir);
    const hasMainJs = dirPresent && isFile(fs, path.join(dir, 'main.js'));
    const manifest = dirPresent ? readJson(fs, path.join(dir, 'manifest.json')) : { ok: false };
    const hasManifest = manifest.ok && manifest.value && typeof manifest.value === 'object';
    const codeInstalled = hasMainJs && hasManifest;
    return {
      id,
      dirPresent,
      codeInstalled,
      hasMainJs,
      hasManifest: Boolean(hasManifest),
      version: hasManifest && typeof manifest.value.version === 'string' ? manifest.value.version : null,
      manifestIdMatches: hasManifest ? manifest.value.id === id : null,
      settingsOnly: dirPresent && !codeInstalled,
      hasDataJson: dirPresent && isFile(fs, path.join(dir, 'data.json')),
      enabledListed: listed.has(id),
      expected: expectedSet.has(id),
      required: requiredSet.has(id),
    };
  });

  const byId = new Map(plugins.map((p) => [p.id, p]));
  const bridge = byId.get(BRIDGE_ID);
  return {
    vaultPath,
    communityPlugins,
    plugins,
    enabledWithoutCode: plugins.filter((p) => p.enabledListed && !p.codeInstalled).map((p) => p.id),
    missing: plugins.filter((p) => p.expected && !p.codeInstalled).map((p) => p.id),
    bridge: bridge?.codeInstalled ? 'installed' : bridge?.dirPresent ? 'settings-only' : 'absent',
  };
}

/**
 * The local REST endpoint of a vault, for the live check. The PORTS come from
 * resolveLocalRestState — the router's own rule (disk first, then the
 * registry's memory) — so this probe dials the port the router would dial,
 * never a second answer to that question. The key comes from data.json and
 * leaves this function only inside the returned endpoint, which is never
 * printed.
 *
 * @param {string} vaultPath
 * @param {{ fs?: object, registryPorts?: {https:number|null, http:number|null} }} [opts]
 * @returns {{baseUrl:string, apiKey:string, tlsInsecure:true, insecurePort:number|null}|null}
 *   null when there is no key to authenticate with, or no port at all.
 */
export function readLocalRestEndpoint(vaultPath, { fs = nodeFs, registryPorts = null } = {}) {
  assertNotServerProcess();
  const file = path.join(vaultPath, '.obsidian', 'plugins', LOCAL_REST_API_ID, 'data.json');
  const r = readJson(fs, file);
  let restData = null;
  let status;
  if (r.ok && r.value && typeof r.value === 'object' && !Array.isArray(r.value)) {
    const d = r.value;
    const asPort = (n) => (Number.isInteger(n) && n > 0 && n <= 65535 ? n : null);
    restData = {
      port: asPort(d.port),
      insecurePort: asPort(d.insecurePort),
      enableInsecureServer: d.enableInsecureServer === true,
      rawPort: d.port,
      rawInsecurePort: d.insecurePort,
    };
    status = REST_DATA_STATUS.OK;
  } else if (r.ok) status = REST_DATA_STATUS.INVALID;
  else if (r.code === 'ENOENT') status = REST_DATA_STATUS.ABSENT;
  else status = r.code ? REST_DATA_STATUS.UNREADABLE : REST_DATA_STATUS.INVALID;

  const state = resolveLocalRestState({ registryPorts: registryPorts ?? { https: null, http: null }, restData, restDataStatus: status });
  const apiKey = status === REST_DATA_STATUS.OK && typeof r.value.apiKey === 'string' && r.value.apiKey ? r.value.apiKey : null;
  const port = state.effectivePorts.https;
  if (!apiKey || port === null) return null;
  // The one composition of this URL outside src/registry.mjs, exempted BY LINE
  // in tests/identity-ports-contracts.test.mjs: it is a CLI's probe of the
  // port resolveLocalRestState just chose, not the address the router dials.
  const pluginHealthProbeUrl = `https://127.0.0.1:${port}`;
  return {
    baseUrl: pluginHealthProbeUrl,
    apiKey,
    tlsInsecure: true,
    insecurePort: state.httpEnabled === true ? state.effectivePorts.http : null,
  };
}

/**
 * Plugin ids that registered at least one command, from a `GET /commands/`
 * body. Obsidian prefixes a plugin's command ids with the plugin id and a
 * colon; core commands (`editor:…`, `app:…`, `workspace:…`) are prefixed by
 * their own area and simply never match a community id.
 *
 * @param {unknown} body parsed JSON — `{ commands: [{ id, name }] }`
 * @returns {Set<string>|null} null when the body is not that shape
 */
export function parseCommandsEvidence(body) {
  const list = body && typeof body === 'object' && Array.isArray(body.commands) ? body.commands : null;
  if (!list) return null;
  const ids = new Set();
  for (const c of list) {
    if (!c || typeof c.id !== 'string') continue;
    const at = c.id.indexOf(':');
    if (at > 0) ids.add(c.id.slice(0, at));
  }
  return ids;
}

/** The real request: one GET, bounded, TLS verification off only when the endpoint says so. */
export function liveRequest(url, { headers = {}, tlsInsecure = false, timeoutMs = 4000, maxBytes = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { resolve({ status: null, error: 'bad URL' }); return; }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.get(u, { headers, rejectUnauthorized: !tlsInsecure, timeout: timeoutMs }, (res) => {
      const chunks = [];
      let n = 0;
      res.on('data', (c) => { n += c.length; if (n > maxBytes) req.destroy(); else chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (err) => resolve({ status: null, error: err.code || err.message }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: null, error: 'TIMEOUT' }); });
    req.on('error', (err) => resolve({ status: null, error: err.code || err.message }));
  });
}

/**
 * Ask the running Obsidian what it loaded.
 *
 * @param {{ endpoint: {baseUrl:string, apiKey:string|null, tlsInsecure?:boolean, extraHeaders?:object, insecurePort?:number|null}|null,
 *           request?: Function }} p
 * @returns {Promise<{ probed:boolean, reachable:boolean, error:string|null, loadedIds:string[]|null,
 *           bridgeRoute:'live'|'not-registered'|'unreachable'|'not-probed' }>}
 */
export async function gatherLiveEvidence({ endpoint, request = liveRequest }) {
  if (!endpoint || !endpoint.baseUrl || !endpoint.apiKey) {
    return { probed: false, reachable: false, error: endpoint ? 'no API key' : 'no REST endpoint known', loadedIds: null, bridgeRoute: 'not-probed' };
  }
  const headers = { ...(endpoint.extraHeaders || {}), authorization: `Bearer ${endpoint.apiKey}`, accept: 'application/json' };
  const res = await request(`${endpoint.baseUrl}/commands/`, { headers, tlsInsecure: endpoint.tlsInsecure === true });
  let loadedIds = null;
  let error = null;
  let reachable = false;
  if (res && res.status === 200) {
    reachable = true;
    let parsed = null;
    try { parsed = JSON.parse(res.body); } catch { parsed = null; }
    const set = parseCommandsEvidence(parsed);
    if (set) loadedIds = [...set].sort();
    else error = 'GET /commands/ answered with an unexpected body';
  } else if (res && res.status) {
    reachable = true;
    error = `GET /commands/ answered HTTP ${res.status}${res.status === 401 ? ' (API key rejected)' : ''}`;
  } else {
    error = res?.error || 'no answer';
  }

  let bridgeRoute = 'not-probed';
  // WHERE the bridge's /open/ route is asked: a local vault on its plain-HTTP
  // port on this machine; a remote vault at its declared baseUrl — the bridge
  // registers the route on the Local REST API server itself, and the route
  // answers without the API key (so a 404 for a nonexistent note means "live",
  // while an unregistered route is refused by the auth layer). Without this a
  // remote vault's bridge was never probed at all, and "bridge loaded" rested
  // on its having registered a command.
  const probeUrl = typeof endpoint.openProbeBase === 'string' && endpoint.openProbeBase
    ? `${endpoint.openProbeBase.replace(/\/+$/, '')}${OPEN_PROBE_PATH}`
    : Number.isInteger(endpoint.insecurePort) ? `http://127.0.0.1:${endpoint.insecurePort}${OPEN_PROBE_PATH}` : null;
  if (probeUrl) {
    const probe = await request(probeUrl, { headers: { ...(endpoint.extraHeaders || {}) }, tlsInsecure: endpoint.tlsInsecure === true });
    if (probe && probe.status === 404) bridgeRoute = 'live';
    else if (probe && probe.status) bridgeRoute = 'not-registered';
    else bridgeRoute = 'unreachable';
  }
  return { probed: true, reachable, error, loadedIds, bridgeRoute };
}

/**
 * The verdict per plugin row and for the vault. Exit code 1 when a REQUIRED
 * plugin (Local REST API, the bridge) has no code — absent, settings only or
 * enabled without code — 0 otherwise.
 */
export function evaluatePluginHealth(inventory, evidence = null, { vaultArg = '<vault>' } = {}) {
  const loaded = evidence && evidence.loadedIds ? new Set(evidence.loadedIds) : null;
  const arg = JSON.stringify(vaultArg);
  const rows = inventory.plugins.map((p) => {
    let live = 'unknown';
    if (evidence && evidence.probed && evidence.reachable) {
      if (p.id === LOCAL_REST_API_ID) live = 'loaded';
      else if (p.id === BRIDGE_ID && evidence.bridgeRoute === 'live') live = 'loaded';
      else if (loaded && loaded.has(p.id)) live = 'loaded';
      else if (loaded && p.enabledListed && p.codeInstalled) live = 'no-commands-seen';
      else if (loaded) live = 'not-loaded';
    }
    return { ...p, live };
  });

  const problems = [];
  for (const p of rows) {
    if (p.enabledListed && !p.codeInstalled) {
      problems.push({
        id: p.id, kind: 'enabled-without-code', required: p.required,
        message: `${p.id} is enabled in community-plugins.json but has no code on disk${p.settingsOnly ? ' (settings only)' : ''}.`,
        fix: `obsidian-mcp-router --install-plugins ${arg} --dry-run, then apply with the printed seal; reload Obsidian.`,
      });
    } else if (p.required && !p.codeInstalled) {
      problems.push({
        id: p.id, kind: p.settingsOnly ? 'settings-only' : 'absent', required: true,
        message: `${p.id} is required and has no code on disk${p.settingsOnly ? ' (settings only)' : ''}.`,
        fix: `obsidian-mcp-router --install-plugins ${arg} --only ${p.id} --dry-run, then apply with the printed seal; reload Obsidian.`,
      });
    }
    if (p.hasManifest && p.manifestIdMatches === false) {
      problems.push({
        id: p.id, kind: 'manifest-id-mismatch', required: p.required,
        message: `${p.id}: its manifest.json names a different id — Obsidian loads it under that other id.`,
        fix: `reinstall it: obsidian-mcp-router --install-plugins ${arg} --only ${p.id} --force --dry-run.`,
      });
    }
    if (p.live === 'no-commands-seen' && p.expected) {
      problems.push({
        id: p.id, kind: 'not-seen-loaded', required: p.required, soft: true,
        message: `${p.id} has code and is enabled, but registered no command in the running Obsidian — not loaded, or a plugin without commands.`,
        fix: 'reload Obsidian (Ctrl+P → "Reload app without saving"); check Settings → Community plugins → Restricted mode is OFF.',
      });
    }
  }
  if (inventory.bridge !== 'installed' && !problems.some((x) => x.id === BRIDGE_ID)) {
    problems.push({
      id: BRIDGE_ID, kind: inventory.bridge === 'settings-only' ? 'settings-only' : 'absent', required: true,
      message: `the bridge (${BRIDGE_ID}) is ${inventory.bridge === 'settings-only' ? 'settings only' : 'absent'} — click-to-open links cannot work.`,
      fix: `obsidian-mcp-router --install-plugins ${arg} --only ${BRIDGE_ID} --dry-run, then apply with the printed seal.`,
    });
  }
  if (evidence && evidence.probed && evidence.reachable && evidence.bridgeRoute === 'not-registered' && inventory.bridge === 'installed') {
    problems.push({
      id: BRIDGE_ID, kind: 'bridge-route-not-registered', required: false, soft: true,
      message: 'the bridge code is on disk but its /open/ route is not registered in the running Obsidian.',
      fix: 'reload Obsidian (Ctrl+P → "Reload app without saving"); check Restricted mode is OFF.',
    });
  }
  const hard = problems.filter((x) => x.required && !x.soft && x.kind !== 'manifest-id-mismatch');
  return { rows, problems, exitCode: hard.length ? 1 : 0 };
}

/** Human rendering: one table, then one line per problem with its fix. */
export function formatPluginHealth({ target, inventory, evidence, verdict }) {
  const lines = [];
  lines.push(`Plugin health — ${target.name ? `${target.name} (${target.vaultPath})` : target.vaultPath}`);
  if (inventory.communityPlugins.state === 'invalid') lines.push('  ! community-plugins.json is not a JSON array — Obsidian will enable nothing from it.');
  const liveNote = !evidence || !evidence.probed
    ? `live check: not run (${evidence?.error || 'no REST endpoint'})`
    : evidence.reachable ? 'live check: REST API answered' : `live check: REST API unreachable (${evidence.error})`;
  lines.push(`  ${liveNote}`);
  const header = ['plugin', 'code', 'enabled', 'version', 'loaded'];
  const cell = (r) => [
    `${r.id}${r.required ? ' *' : ''}`,
    r.codeInstalled ? 'yes' : r.settingsOnly ? 'settings only' : 'no',
    r.enabledListed ? 'yes' : 'no',
    r.version ?? '-',
    r.live === 'loaded' ? 'yes' : r.live === 'not-loaded' ? 'no' : r.live === 'no-commands-seen' ? 'no command seen' : '?',
  ];
  const table = [header, ...verdict.rows.map(cell)];
  const widths = header.map((_, i) => Math.max(...table.map((row) => String(row[i]).length)));
  for (const row of table) lines.push(`  ${row.map((v, i) => String(v).padEnd(widths[i])).join('  ')}`.trimEnd());
  lines.push('  (* required)');
  lines.push('');
  if (inventory.enabledWithoutCode.length) lines.push(`Enabled without code: ${inventory.enabledWithoutCode.join(', ')}`);
  else lines.push('Enabled without code: none');
  lines.push(`Bridge: ${inventory.bridge}`);
  for (const p of verdict.problems) {
    lines.push(`  ${p.soft ? '~' : p.required ? '✗' : '!'} ${p.message}`);
    lines.push(`      fix: ${p.fix}`);
  }
  lines.push('');
  lines.push(verdict.exitCode === 0 ? 'Required plugins: OK' : 'Required plugins: MISSING — see the fixes above');
  return lines;
}
