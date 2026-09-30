/**
 * plugin-release-resolver — find a community plugin's code on GitHub, and
 * fetch it, without ever talking to a host the router did not name.
 *
 * WHY THIS EXISTS. A vault can list a plugin as enabled in
 * `.obsidian/community-plugins.json` and have no code for it on disk — a
 * skeleton cloned without binaries, a sync that carried settings and not code.
 * Obsidian then shows nothing: the plugin is simply absent. The fix is to
 * download the plugin's release, and Claude Code blocks ad-hoc third-party
 * code downloads, so the download has to be ONE named command the user can
 * authorise (`obsidian-mcp-router --install-plugins`). This module is its
 * network half; `plugin-installer.mjs` is the plan and the disk half.
 *
 * THE RESOLUTION CHAIN, the same one Obsidian's own plugin browser uses:
 *   1. the official registry — obsidianmd/obsidian-releases'
 *      community-plugins.json, which maps a plugin id to a GitHub repo;
 *   2. that repo's latest release, through the GitHub API. A repo that was
 *      renamed or moved (obsidian-style-settings now lives under
 *      community-archive/) answers with a 301 to `/repositories/<id>/…`; the
 *      redirect is FOLLOWED and the repo the release really belongs to is
 *      read back from the release itself and recorded, so the plan shows
 *      "registry says A, release lives in B" instead of hiding it;
 *   3. the release's assets: main.js (required), manifest.json (required),
 *      styles.css (optional).
 *
 * THE HOST ALLOWLIST is enforced on EVERY request AND on every redirect hop,
 * not only on the first URL: a release asset 302s from github.com to a signed
 * CDN URL, and a redirect is exactly where a request would leave the hosts
 * that were reviewed. HTTPS only, default port only, no credentials in the
 * URL, a byte cap on every body, a timeout on every request.
 *
 * THE TRANSPORT IS INJECTED. `transport(url, opts)` performs ONE request and
 * does NOT follow redirects — following them is this module's job, precisely
 * so the allowlist sees every hop. Tests pass a fake transport; nothing in the
 * test suite reaches the network.
 *
 * Network only — this module never reads or writes a disk.
 */

import https from 'node:https';
import crypto from 'node:crypto';

/** Every host a plugin download may touch, on the first request or after any redirect. */
export const GITHUB_HOSTS = Object.freeze([
  'github.com',
  'api.github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

/** Obsidian's official community-plugin registry. */
export const REGISTRY_URL =
  'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json';

/**
 * Byte caps. Generous for code (smart-connections' main.js is several MB),
 * tight for what should be small (a manifest is a few hundred bytes). A cap is
 * a refusal, never a truncation.
 */
export const CAPS = Object.freeze({
  registry: 32 * 1024 * 1024,
  apiJson: 4 * 1024 * 1024,
  'main.js': 50 * 1024 * 1024,
  'manifest.json': 64 * 1024,
  'styles.css': 8 * 1024 * 1024,
});

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_REDIRECTS = 5;

/** The release assets a plugin install fetches, and whether each must exist. */
export const PLUGIN_ASSETS = Object.freeze([
  { name: 'main.js', required: true },
  { name: 'manifest.json', required: true },
  { name: 'styles.css', required: false },
]);

/** A plugin id as Obsidian and this installer accept it: lowercase, no path characters. */
export const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** owner/repo, GitHub's own character set. */
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * A URL as a message may show it: origin and path only. Never the query — a
 * release asset redirects to a CDN URL whose query IS a signed token — and
 * never userinfo. The messages travel into reports and logs.
 */
export function displayUrl(raw) {
  try {
    const u = new URL(String(raw));
    return `${u.origin}${u.pathname}${u.search ? '?…' : ''}`;
  } catch {
    // Not parseable, so nothing in it can be told apart from a secret
    // (`https://alice:SECRET@[invalid` is one): a constant, never a slice.
    return '(malformed URL)';
  }
}

/** Raised for any refusal of this module: a host, a scheme, a size, a mismatch. */
export class PluginFetchError extends Error {
  constructor(message, { code = 'fetch_refused', url } = {}) {
    super(message);
    this.name = 'PluginFetchError';
    this.code = code;
    if (url !== undefined) this.url = url;
  }
}

/**
 * Check one URL against the allowlist. Returns the parsed URL or throws.
 * Exported so the tests can state the rule directly.
 *
 * @param {string} raw
 * @param {readonly string[]} [hosts]
 * @returns {URL}
 */
export function assertAllowedUrl(raw, hosts = GITHUB_HOSTS) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new PluginFetchError(`Refusing a malformed URL: ${displayUrl(raw)}`, { code: 'bad_url' });
  }
  if (u.protocol !== 'https:') {
    throw new PluginFetchError(`Refusing a non-HTTPS URL: ${displayUrl(u.href)}`, { code: 'not_https', url: displayUrl(u.href) });
  }
  if (u.username || u.password) {
    throw new PluginFetchError(`Refusing a URL that carries credentials (host ${u.hostname})`, { code: 'credentials_in_url' });
  }
  if (u.port && u.port !== '443') {
    throw new PluginFetchError(`Refusing a non-default port: ${u.host}`, { code: 'bad_port', url: displayUrl(u.href) });
  }
  const host = u.hostname.toLowerCase();
  if (!hosts.includes(host)) {
    throw new PluginFetchError(
      `Refusing host "${host}" — plugin downloads may only reach ${hosts.join(', ')}`,
      { code: 'host_not_allowed', url: displayUrl(u.href) },
    );
  }
  return u;
}

/**
 * The real transport: one HTTPS GET, no redirect following, a byte cap and a
 * timeout. Resolves `{ status, headers, body }`; a 3xx is returned as-is for
 * the caller to judge.
 */
export function httpsTransport(url, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      const status = res.statusCode;
      if (status >= 300 && status < 400) {
        res.resume();
        resolve({ status, headers: res.headers, body: Buffer.alloc(0) });
        return;
      }
      const declared = Number(res.headers['content-length']);
      if (maxBytes && Number.isFinite(declared) && declared > maxBytes) {
        res.resume();
        req.destroy();
        reject(new PluginFetchError(`${displayUrl(url)}: ${declared} bytes declared, cap is ${maxBytes}`, { code: 'too_large', url: displayUrl(url) }));
        return;
      }
      const chunks = [];
      let received = 0;
      res.on('data', (chunk) => {
        received += chunk.length;
        if (maxBytes && received > maxBytes) {
          req.destroy(new PluginFetchError(`${displayUrl(url)}: body exceeds the ${maxBytes}-byte cap`, { code: 'too_large', url: displayUrl(url) }));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new PluginFetchError(`Timeout after ${timeoutMs} ms: ${displayUrl(url)}`, { code: 'timeout', url: displayUrl(url) })));
    req.on('error', reject);
  });
}

/**
 * A GET that follows redirects itself and checks EVERY hop against the host
 * allowlist.
 *
 * @param {object} [opts]
 * @param {Function} [opts.transport] one-request function, see httpsTransport
 * @param {readonly string[]} [opts.hosts]
 * @param {number} [opts.maxRedirects]
 * @param {number} [opts.timeoutMs]
 * @returns {(url: string, o?: {maxBytes?: number, accept?: string}) => Promise<{status:number, body:Buffer, finalUrl:string, chain:string[]}>}
 */
export function createGuardedFetch({
  transport = httpsTransport,
  hosts = GITHUB_HOSTS,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  return async function guardedFetch(url, { maxBytes = CAPS.apiJson, accept = '*/*' } = {}) {
    const chain = [];
    let current = assertAllowedUrl(url, hosts).href;
    for (let hop = 0; ; hop += 1) {
      chain.push(current);
      const res = await transport(current, {
        headers: { 'user-agent': 'obsidian-mcp-router (install-plugins)', accept },
        timeoutMs,
        maxBytes,
      });
      const status = Number(res && res.status);
      if (status >= 300 && status < 400) {
        const location = res.headers && (res.headers.location ?? res.headers.Location);
        if (!location) throw new PluginFetchError(`HTTP ${status} without a Location header: ${displayUrl(current)}`, { code: 'bad_redirect', url: displayUrl(current) });
        if (hop >= maxRedirects) throw new PluginFetchError(`Too many redirects (> ${maxRedirects}) from ${displayUrl(url)}`, { code: 'too_many_redirects', url: displayUrl(url) });
        // Resolved against the hop that sent it, then judged like a first URL.
        // A Location that does not resolve is refused as a controlled error:
        // the native TypeError carries the raw input in its own properties.
        let resolved;
        try {
          resolved = new URL(String(location), current).href;
        } catch {
          throw new PluginFetchError(`HTTP ${status} with an unusable Location header from ${displayUrl(current)}`, { code: 'bad_redirect', url: displayUrl(current) });
        }
        current = assertAllowedUrl(resolved, hosts).href;
        continue;
      }
      if (status !== 200) {
        // Unauthenticated GitHub API calls are limited to 60 an hour per IP; a
        // 403/429 there is almost always that, and saying so saves a hunt.
        const limited = (status === 403 || status === 429) && new URL(current).hostname === 'api.github.com';
        throw new PluginFetchError(
          `HTTP ${status} for ${displayUrl(current)}${limited ? ' (GitHub API rate limit? unauthenticated calls get 60 an hour — retry later)' : ''}`,
          { code: 'http_status', url: displayUrl(current) },
        );
      }
      const body = Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body ?? '');
      if (body.length > maxBytes) {
        throw new PluginFetchError(`${displayUrl(current)}: ${body.length} bytes, cap is ${maxBytes}`, { code: 'too_large', url: displayUrl(current) });
      }
      return { status, body, finalUrl: current, chain };
    }
  };
}

function parseJson(buf, what) {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (err) {
    throw new PluginFetchError(`${what} is not valid JSON (${err.message})`, { code: 'bad_json' });
  }
}

/**
 * Fetch the official registry and index it by plugin id.
 * @returns {Promise<Map<string, string>>} id → "owner/repo"
 */
export async function fetchRegistry(fetch, { url = REGISTRY_URL } = {}) {
  const { body } = await fetch(url, { maxBytes: CAPS.registry, accept: 'application/json' });
  const list = parseJson(body, 'The community-plugins registry');
  if (!Array.isArray(list)) throw new PluginFetchError('The community-plugins registry is not a JSON array', { code: 'bad_registry' });
  const byId = new Map();
  for (const e of list) {
    if (!e || typeof e.id !== 'string' || typeof e.repo !== 'string') continue;
    if (!REPO_RE.test(e.repo)) continue;
    // First entry wins; the registry has no duplicates, and if it ever did a
    // later line must not be able to shadow an earlier one silently.
    if (!byId.has(e.id)) byId.set(e.id, e.repo);
  }
  return byId;
}

/**
 * Read `owner/repo` out of a GitHub release object. `html_url` first
 * (https://github.com/<o>/<r>/releases/tag/<t>), then the API `url`
 * (https://api.github.com/repos/<o>/<r>/releases/<id>). This is how a
 * redirected lookup learns where the release actually lives.
 */
export function repoOfRelease(release) {
  const tryParse = (raw, host, prefix) => {
    if (typeof raw !== 'string') return null;
    let u;
    try { u = new URL(raw); } catch { return null; }
    if (u.hostname.toLowerCase() !== host) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    const at = prefix ? parts.indexOf(prefix) : -1;
    const [o, r] = prefix ? parts.slice(at + 1, at + 3) : parts.slice(0, 2);
    if (prefix && at !== 0) return null;
    const repo = `${o}/${r}`;
    return o && r && REPO_RE.test(repo) ? repo : null;
  };
  return tryParse(release?.html_url, 'github.com', null)
    ?? tryParse(release?.url, 'api.github.com', 'repos');
}

/**
 * Resolve a repo's latest release. Follows the API's redirect for a moved
 * repo and reports where it landed.
 *
 * @returns {Promise<{requestedRepo:string, resolvedRepo:string, redirected:boolean, tag:string,
 *   assets: Array<{name:string, size:number, id:number|null, url:string}>}>}
 */
export async function resolveLatestRelease(fetch, repo) {
  if (!REPO_RE.test(String(repo))) throw new PluginFetchError(`Not an owner/repo: ${repo}`, { code: 'bad_repo' });
  const { body, chain } = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    maxBytes: CAPS.apiJson,
    accept: 'application/vnd.github+json',
  });
  const release = parseJson(body, `The latest release of ${repo}`);
  const tag = typeof release?.tag_name === 'string' ? release.tag_name : '';
  if (!tag) throw new PluginFetchError(`The latest release of ${repo} has no tag_name`, { code: 'bad_release' });
  const resolvedRepo = repoOfRelease(release);
  if (!resolvedRepo) throw new PluginFetchError(`Cannot tell which repository the release of ${repo} belongs to`, { code: 'bad_release' });
  const assets = [];
  for (const a of Array.isArray(release.assets) ? release.assets : []) {
    if (!a || typeof a.name !== 'string' || typeof a.browser_download_url !== 'string') continue;
    assets.push({
      name: a.name,
      size: Number.isInteger(a.size) ? a.size : null,
      id: Number.isInteger(a.id) ? a.id : null,
      url: a.browser_download_url,
    });
  }
  return {
    requestedRepo: repo,
    resolvedRepo,
    redirected: chain.length > 1 || resolvedRepo.toLowerCase() !== String(repo).toLowerCase(),
    tag,
    assets,
  };
}

/**
 * Pick the plugin assets out of a release and check each download URL points
 * into THAT release's repository on github.com. The API response could name
 * any URL; the only ones accepted are the release's own.
 */
export function selectPluginAssets(release) {
  const out = [];
  const prefix = `/${release.resolvedRepo.toLowerCase()}/releases/download/`;
  for (const spec of PLUGIN_ASSETS) {
    const a = release.assets.find((x) => x.name === spec.name);
    if (!a) {
      if (spec.required) {
        throw new PluginFetchError(`Release ${release.tag} of ${release.resolvedRepo} has no ${spec.name}`, { code: 'missing_asset' });
      }
      continue;
    }
    let u;
    try { u = new URL(a.url); } catch { u = null; }
    if (!u || u.protocol !== 'https:' || u.hostname.toLowerCase() !== 'github.com' || !u.pathname.toLowerCase().startsWith(prefix)) {
      throw new PluginFetchError(
        `${spec.name} of ${release.resolvedRepo} points outside that release (${displayUrl(a.url)})`,
        { code: 'foreign_asset_url' },
      );
    }
    if (a.size !== null && a.size > CAPS[spec.name]) {
      throw new PluginFetchError(`${spec.name} of ${release.resolvedRepo} is ${a.size} bytes, cap is ${CAPS[spec.name]}`, { code: 'too_large' });
    }
    out.push({ name: a.name, size: a.size, id: a.id, url: a.url });
  }
  return out;
}

/** Download one asset and check it against the size the release declared. */
export async function downloadAsset(fetch, asset) {
  const { body } = await fetch(asset.url, { maxBytes: CAPS[asset.name] ?? CAPS['main.js'], accept: 'application/octet-stream' });
  if (asset.size !== null && body.length !== asset.size) {
    throw new PluginFetchError(
      `${asset.name}: downloaded ${body.length} bytes, the release declares ${asset.size}`,
      { code: 'size_mismatch' },
    );
  }
  return body;
}

/**
 * The manifest check every install goes through — the generalisation of
 * setup-vault's validateBridgePlugin to any plugin. An HTML error page served
 * with a 200, a wrong asset, or a release that ships a DIFFERENT plugin under
 * this repo are all refused here.
 *
 * @returns {{ id: string, version: string, manifest: object }}
 */
export function verifyManifest(buf, expectedId) {
  let manifest;
  try {
    manifest = JSON.parse(buf.toString('utf8'));
  } catch (err) {
    throw new PluginFetchError(`manifest.json is not valid JSON — likely an HTML error page: ${err.message}`, { code: 'bad_manifest' });
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new PluginFetchError('manifest.json is not a JSON object', { code: 'bad_manifest' });
  }
  if (manifest.id !== expectedId) {
    throw new PluginFetchError(
      `manifest.json id mismatch: the release ships "${String(manifest.id).slice(0, 80)}", expected "${expectedId}" — refusing`,
      { code: 'manifest_id_mismatch' },
    );
  }
  if (typeof manifest.version !== 'string' || !manifest.version.trim()) {
    throw new PluginFetchError(`manifest.json of ${expectedId} has no version`, { code: 'bad_manifest' });
  }
  return { id: manifest.id, version: manifest.version, manifest };
}

/** main.js must be non-empty and must not be an HTML page. */
export function verifyMainJs(buf, id) {
  if (!buf || buf.length === 0) throw new PluginFetchError(`main.js of ${id} is empty`, { code: 'bad_main_js' });
  const head = buf.subarray(0, 64).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    throw new PluginFetchError(`main.js of ${id} looks like an HTML page, not a JS bundle`, { code: 'bad_main_js' });
  }
}

/**
 * `owner/repo` out of a github.com release-download URL — how the bridge's
 * repository is read from setup-vault's BRIDGE_PLUGIN_URLS, so that constant
 * stays the one place the bridge's home is written.
 */
export function repoFromGithubUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== 'github.com') return null;
  const [o, r] = u.pathname.split('/').filter(Boolean);
  const repo = `${o}/${r}`;
  return o && r && REPO_RE.test(repo) ? repo : null;
}

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
