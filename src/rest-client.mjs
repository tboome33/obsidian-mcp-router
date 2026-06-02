/**
 * Thin HTTPS client for the Obsidian Local REST API.
 *
 * Handles:
 *  - Bearer auth
 *  - Self-signed TLS (per-vault tlsInsecure flag)
 *  - Timeouts
 *  - Path encoding
 */
import { fetch, Agent } from 'undici';
import { encodeVaultPath, normalizeAnchor } from './helpers/click-to-open.mjs';

const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });
const secureAgent = new Agent();

function agentFor(vault) {
  return vault.tlsInsecure ? insecureAgent : secureAgent;
}

/**
 * Categorized error for REST API calls. Tools can branch on `kind` instead
 * of string-matching error messages.
 *
 * Kinds:
 *  - 'unreachable'   — network failure (ECONNREFUSED, ENOTFOUND)
 *  - 'timeout'       — AbortError after vault.timeoutMs
 *  - 'unauthorized'  — HTTP 401 (bad API key, expired)
 *  - 'forbidden'     — HTTP 403 (incl. Cloudflare Access without service token)
 *  - 'cf_access'     — redirect to *.cloudflareaccess.com (CF Access policy)
 *  - 'not_found'     — HTTP 404
 *  - 'conflict'      — HTTP 409 (Apply-If-Content-Preexists)
 *  - 'server_error'  — HTTP 5xx
 *  - 'unknown'       — anything else
 */
export class RestApiError extends Error {
  constructor(message, { kind, vaultName, status, urlPath, hint } = {}) {
    super(message);
    this.name = 'RestApiError';
    this.kind = kind || 'unknown';
    this.vaultName = vaultName;
    this.status = status;
    this.urlPath = urlPath;
    this.hint = hint;
  }
}

function categorizeFetchError(err, vault, urlPath) {
  // undici wraps node errors in a `cause` chain.
  const cause = err?.cause;
  const code = err?.code || cause?.code;

  if (err.name === 'AbortError') {
    return new RestApiError(
      `[${vault.name}] timed out after ${vault.timeoutMs}ms calling ${urlPath}`,
      {
        kind: 'timeout',
        vaultName: vault.name,
        urlPath,
        hint:
          'Increase timeoutMs for this vault, or check whether the vault is reachable on the network.',
      },
    );
  }

  if (
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'ECONNRESET' ||
    code === 'EHOSTUNREACH' ||
    code === 'UND_ERR_SOCKET' ||
    /fetch failed/i.test(err.message)
  ) {
    const isLocal = vault.baseUrl.includes('127.0.0.1') || vault.baseUrl.includes('localhost');
    return new RestApiError(
      `[${vault.name}] unreachable at ${vault.baseUrl}${urlPath} (${code || 'fetch failed'})`,
      {
        kind: 'unreachable',
        vaultName: vault.name,
        urlPath,
        hint: isLocal
          ? 'Open Obsidian on this vault and confirm Local REST API plugin is enabled.'
          : 'Check the host is online (try `curl -k <baseUrl>/`) and that the tunnel/VPN is up.',
      },
    );
  }

  return new RestApiError(`[${vault.name}] ${err.message}`, {
    kind: 'unknown',
    vaultName: vault.name,
    urlPath,
  });
}

function makeCfAccessError(vault, urlPath, status = 302) {
  return new RestApiError(
    `[${vault.name}] blocked by Cloudflare Access at ${urlPath}`,
    {
      kind: 'cf_access',
      vaultName: vault.name,
      status,
      urlPath,
      hint:
        'Add a Service Token policy at Cloudflare Zero Trust and set its Client ID + Secret in this vault\'s extraHeaders.',
    },
  );
}

function categorizeHttpStatus(status, statusText, body, vault, urlPath) {
  // Cloudflare Access surface — fires on any status with cloudflareaccess.com
  // in either the body (HTML login page) or the redirect Location header.
  // Was previously gated on status === 302 which missed the case where fetch
  // followed the redirect and surfaced as 200 OK at the IDP page.
  if (/cloudflareaccess\.com/i.test(body || '')) {
    return makeCfAccessError(vault, urlPath, status);
  }

  const truncated = body ? `: ${String(body).slice(0, 200)}` : '';
  const base = `[${vault.name}] HTTP ${status} ${statusText} on ${urlPath}${truncated}`;

  if (status === 401) {
    return new RestApiError(base, {
      kind: 'unauthorized',
      vaultName: vault.name,
      status,
      urlPath,
      hint:
        'API key is wrong or expired. Open the vault in Obsidian, copy the key from Settings → Local REST API → API Key, and update the router config.',
    });
  }
  if (status === 403) {
    return new RestApiError(base, {
      kind: 'forbidden',
      vaultName: vault.name,
      status,
      urlPath,
      hint:
        'The server accepted the API key but refused the operation. If you go through Cloudflare Access, check the service token headers.',
    });
  }
  if (status === 404) {
    // The bridge plugin (obsidian-mcp-router-bridge) registers two
    // additional routes onto Local REST API: /search/smart and
    // /templates/execute. If the bridge isn't enabled in the target vault,
    // those URLs 404 — but the user wouldn't know why. Surface a hint so
    // the failure points at the missing plugin instead of a generic
    // "not_found".
    const bridgeRoutes = ['/search/smart', '/templates/execute'];
    const isBridgeRoute = bridgeRoutes.some(
      (r) => urlPath === r || urlPath.startsWith(`${r}?`),
    );
    return new RestApiError(base, {
      kind: 'not_found',
      vaultName: vault.name,
      status,
      urlPath,
      hint: isBridgeRoute
        ? `Route ${urlPath} not found. The "obsidian-mcp-router-bridge" plugin is probably not installed or not enabled in this vault. Install it from https://github.com/tboome33/obsidian-mcp-router-bridge and toggle it on in Community plugins.`
        : undefined,
    });
  }
  if (status === 409) {
    return new RestApiError(base, {
      kind: 'conflict',
      vaultName: vault.name,
      status,
      urlPath,
      hint: 'Resource state conflicts with the request (e.g. file already exists with different content).',
    });
  }
  if (status >= 500) {
    return new RestApiError(base, {
      kind: 'server_error',
      vaultName: vault.name,
      status,
      urlPath,
      hint: 'Obsidian or a plugin in the target vault threw an error. Check Obsidian dev console (Ctrl+Shift+I).',
    });
  }
  return new RestApiError(base, {
    kind: 'unknown',
    vaultName: vault.name,
    status,
    urlPath,
  });
}

function authHeaders(vault) {
  const headers = {
    Authorization: `Bearer ${vault.apiKey}`,
    Accept: 'application/json',
  };
  // Merge any vault-specific extra headers (e.g. Cloudflare Access service
  // token pair, custom reverse-proxy auth tokens). Per-call headers override
  // these in the request() helper.
  if (vault.extraHeaders) {
    Object.assign(headers, vault.extraHeaders);
  }
  return headers;
}

function encodePath(p) {
  // Encode each segment separately to keep slashes intact.
  return p
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
}

/**
 * Manual redirect follower that preserves auth headers across SAME-HOST
 * redirects. We can't use `fetch`'s built-in `redirect: 'follow'` because
 * undici (and the WHATWG fetch spec) strips `Authorization` and other auth
 * headers on cross-origin redirects — even harmless ones like `http://x` →
 * `https://x` (different origin per the spec). For Local REST API calls,
 * losing the bearer key turns a normal proxy normalization into a 401.
 *
 * Strategy:
 *  - Follow up to 3 redirects on the SAME host (auth preserved verbatim).
 *  - Treat any redirect whose Location lands on *.cloudflareaccess.com as
 *    a cf_access error immediately (don't follow — the IDP page would 200
 *    with no body we care about).
 *  - Refuse cross-host redirects to protect the API key from leaking.
 *  - Method and body are preserved across redirects (we want consistent
 *    semantics for an API client; spec-mandated 301/302→GET conversion is
 *    inappropriate when the redirect is just URL normalization).
 */
async function fetchWithSafeRedirect(vault, urlPath, fetchOpts) {
  let currentUrl = `${vault.baseUrl}${urlPath}`;
  let res;
  for (let depth = 0; depth <= 3; depth++) {
    res = await fetch(currentUrl, { ...fetchOpts, redirect: 'manual' });

    if (res.status < 300 || res.status >= 400) return { res, currentUrl };

    const location = res.headers.get('location');
    if (!location) return { res, currentUrl }; // 3xx without Location — surface as is

    const target = new URL(location, currentUrl);

    // Cloudflare Access on the redirect target.
    if (/cloudflareaccess\.com$/i.test(target.hostname)) {
      throw makeCfAccessError(vault, urlPath, res.status);
    }

    // Block cross-host redirects — auth headers would be needed at a host
    // we did not authenticate against, which is unsafe regardless of TLS.
    const here = new URL(currentUrl);
    if (target.hostname !== here.hostname) {
      throw new RestApiError(
        `[${vault.name}] refused cross-host redirect from ${here.hostname} to ${target.hostname}`,
        {
          kind: 'unknown',
          vaultName: vault.name,
          urlPath,
          status: res.status,
          hint:
            'Cross-host redirects are blocked to keep the API key from being sent to a host you did not authenticate against. Configure your reverse proxy to keep redirects same-host.',
        },
      );
    }

    // Block HTTPS → HTTP downgrades on the same host. The redirect would
    // re-send the bearer API key and any extraHeaders (incl. Cloudflare
    // Access service tokens) in cleartext. http → https upgrades are fine
    // and common, http → http stays unchanged. Only the downgrade is
    // dangerous because it changes the security posture of the channel
    // we already authenticated over.
    if (here.protocol === 'https:' && target.protocol === 'http:') {
      throw new RestApiError(
        `[${vault.name}] refused HTTPS→HTTP downgrade redirect to ${target.toString()}`,
        {
          kind: 'unknown',
          vaultName: vault.name,
          urlPath,
          status: res.status,
          hint:
            'A redirect tried to downgrade the channel to cleartext HTTP, which would send your API key and other auth headers in the clear. Configure your reverse proxy to keep redirects on HTTPS.',
        },
      );
    }

    if (depth === 3) {
      throw new RestApiError(
        `[${vault.name}] too many redirects (>3) starting at ${urlPath}`,
        { kind: 'unknown', vaultName: vault.name, urlPath, status: res.status },
      );
    }

    currentUrl = target.toString();
    // Same host → fall through, headers (incl. Authorization) preserved verbatim.
  }
  return { res, currentUrl };
}

async function request(vault, method, urlPath, { headers = {}, body, json = true } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), vault.timeoutMs);

  let res;
  let finalUrl;
  try {
    const result = await fetchWithSafeRedirect(vault, urlPath, {
      method,
      dispatcher: agentFor(vault),
      headers: { ...authHeaders(vault), ...headers },
      body,
      signal: controller.signal,
    });
    res = result.res;
    finalUrl = result.currentUrl;
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof RestApiError) throw err;
    throw categorizeFetchError(err, vault, urlPath);
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw categorizeHttpStatus(res.status, res.statusText, text, vault, urlPath);
  }

  // Defense in depth: if a same-host redirect chain somehow ends up on a
  // cloudflareaccess.com URL with status 200 (page-served via custom domain
  // mapping, etc.), surface it as cf_access too.
  if (/cloudflareaccess\.com/i.test(finalUrl || '')) {
    throw makeCfAccessError(vault, urlPath, res.status);
  }

  const contentType = res.headers.get('content-type') || '';
  // Accept both "application/json" and any vendor-specific "+json" subtype
  // (e.g. application/vnd.olrapi.note+json from Local REST API content
  // negotiation).
  if (json && /\bapplication\/(?:[a-z0-9.+-]+\+)?json\b/i.test(contentType)) {
    return await res.json();
  }
  return await res.text();
}

// --- Public API ---

export async function pingVault(vault) {
  const start = Date.now();
  try {
    const info = await request(vault, 'GET', '/');
    return {
      online: true,
      latencyMs: Date.now() - start,
      info,
    };
  } catch (err) {
    return {
      online: false,
      latencyMs: Date.now() - start,
      error: err.message,
    };
  }
}

export function listFilesIn(vault, directory = '') {
  const dir = directory ? encodePath(directory) + '/' : '';
  return request(vault, 'GET', `/vault/${dir}`);
}

export function getFileContent(vault, filePath) {
  return request(vault, 'GET', `/vault/${encodePath(filePath)}`, { json: false });
}

/**
 * Get a file with metadata (content + frontmatter parsed as object + tags +
 * stat). Uses the Accept: application/vnd.olrapi.note+json content negotiation
 * supported by Local REST API.
 */
export function getNote(vault, filePath) {
  return request(vault, 'GET', `/vault/${encodePath(filePath)}`, {
    headers: { Accept: 'application/vnd.olrapi.note+json' },
  });
}

/**
 * Move/rename a file. There is no native endpoint on Local REST API, so we
 * fall back to GET source → PUT destination → DELETE source.
 *
 * If the destination already exists and `overwrite` is not true, we throw
 * before writing anything (a non-atomic check, but acceptable for a single
 * user). If DELETE source fails after PUT succeeds, the file is duplicated;
 * the function returns sourceDeleted: false and a warning instead of throwing,
 * so the caller can decide whether to clean up.
 */
export async function moveFileFromTo(vault, fromPath, toPath, opts = {}) {
  if (fromPath === toPath) {
    return { moved: false, sourceDeleted: false, warning: 'Source and destination are the same.' };
  }

  // 1. Read source (errors propagate — typically not_found if source missing)
  const content = await getFileContent(vault, fromPath);

  // 2. Refuse to overwrite if the user did not opt in
  if (!opts.overwrite) {
    try {
      await getFileContent(vault, toPath);
      // Got here = destination exists
      throw new RestApiError(
        `[${vault.name}] cannot move to "${toPath}": destination already exists. Pass overwrite: true to replace.`,
        { kind: 'conflict', vaultName: vault.name, urlPath: `/vault/${encodePath(toPath)}` },
      );
    } catch (err) {
      if (!(err instanceof RestApiError) || err.kind !== 'not_found') {
        throw err;
      }
      // 404 → destination does not exist → we are good to write
    }
  }

  // 3. Write at destination
  await writeFile(vault, toPath, content);

  // 4. Delete source — non-fatal failure
  try {
    await deleteFile(vault, fromPath);
    return { moved: true, sourceDeleted: true };
  } catch (err) {
    return {
      moved: true,
      sourceDeleted: false,
      warning: `Wrote ${toPath} but failed to delete source ${fromPath}: ${err.message}`,
    };
  }
}

/**
 * Create a file or replace its content. Always overwrites if the file exists,
 * unless `applyIfContentPreexists` is set to false (server returns 409 then).
 *
 * @param {object} vault
 * @param {string} filePath  — path relative to vault root
 * @param {string} content   — new file content (markdown text)
 * @param {object} [opts]
 */
export function writeFile(vault, filePath, content, opts = {}) {
  const headers = { 'Content-Type': 'text/markdown' };
  if (opts.applyIfContentPreexists === false) {
    headers['Apply-If-Content-Preexists'] = 'false';
  }
  return request(vault, 'PUT', `/vault/${encodePath(filePath)}`, {
    headers,
    body: content,
    json: false,
  });
}

/**
 * Append content at the end of a file. Creates the file if it doesn't exist.
 */
export function appendToFile(vault, filePath, content, opts = {}) {
  const headers = { 'Content-Type': 'text/markdown' };
  if (opts.createTargetIfMissing === false) {
    headers['Create-Target-If-Missing'] = 'false';
  }
  return request(vault, 'POST', `/vault/${encodePath(filePath)}`, {
    headers,
    body: content,
    json: false,
  });
}

/**
 * Delete a file from the vault.
 */
export function deleteFile(vault, filePath) {
  return request(vault, 'DELETE', `/vault/${encodePath(filePath)}`, {
    json: false,
  });
}

/**
 * Surgical edit: patch a heading, block, or frontmatter field.
 *
 * @param {object} vault
 * @param {string} filePath
 * @param {object} args
 *   @param {"append"|"prepend"|"replace"} args.operation
 *   @param {"heading"|"block"|"frontmatter"} args.targetType
 *   @param {string} args.target           — heading path / block id / frontmatter key
 *   @param {string|object} args.content   — new content (string for heading/block, any for frontmatter)
 *   @param {string} [args.targetDelimiter]
 *   @param {boolean} [args.createTargetIfMissing]
 *   @param {boolean} [args.applyIfContentPreexists]
 *   @param {boolean} [args.trimTargetWhitespace]
 */
export function patchFile(vault, filePath, args) {
  const {
    operation,
    targetType,
    target,
    content,
    targetDelimiter,
    createTargetIfMissing,
    applyIfContentPreexists,
    trimTargetWhitespace,
  } = args;

  // For frontmatter targets, anything that is not a string should be JSON-
  // encoded so types are preserved (numbers stay numbers, booleans stay
  // booleans, arrays/objects keep their structure). Strings still go through
  // as plain text/markdown — the YAML parser on the server side handles them.
  const isFrontmatterJson = targetType === 'frontmatter' && typeof content !== 'string';
  const headers = {
    Operation: operation,
    'Target-Type': targetType,
    Target: encodeURIComponent(target),
    'Content-Type': isFrontmatterJson ? 'application/json' : 'text/markdown',
  };
  if (targetDelimiter) headers['Target-Delimiter'] = targetDelimiter;
  if (createTargetIfMissing != null) {
    headers['Create-Target-If-Missing'] = String(createTargetIfMissing);
  }
  if (applyIfContentPreexists != null) {
    headers['Apply-If-Content-Preexists'] = String(applyIfContentPreexists);
  }
  if (trimTargetWhitespace != null) {
    headers['Trim-Target-Whitespace'] = String(trimTargetWhitespace);
  }

  const body = isFrontmatterJson ? JSON.stringify(content) : content;

  return request(vault, 'PATCH', `/vault/${encodePath(filePath)}`, {
    headers,
    body,
    json: false,
  });
}

export function searchSimple(vault, query, contextLength = 100) {
  const params = new URLSearchParams({
    query,
    contextLength: String(contextLength),
  });
  return request(vault, 'POST', `/search/simple/?${params.toString()}`);
}

/**
 * Semantic search via the obsidian-mcp-router-bridge plugin's API extension
 * to Local REST API (which registers the /search/smart route).
 *
 * Requires both the `obsidian-mcp-router-bridge` plugin AND the
 * `smart-connections` plugin to be installed and enabled in the target vault.
 * Smart Connections must have indexed the vault (it does so automatically on
 * plugin load).
 *
 * Quirk: the endpoint expects the body as a JSON string in plain text — i.e.
 * Content-Type is text/plain and the body is a stringified JSON object. The
 * handler does its own JSON.parse. Sending Content-Type: application/json
 * with a JSON object directly fails with "must be a string (was an object)".
 */
export function searchSmart(vault, query, filter = {}) {
  const payload = JSON.stringify({ query, filter });
  return request(vault, 'POST', '/search/smart', {
    headers: { 'Content-Type': 'text/plain' },
    body: payload,
  });
}

/**
 * Execute a Templater template against the vault, optionally creating a new
 * note from it. Requires the `templater-obsidian` plugin to be installed.
 *
 * Quirk note: unlike /search/smart (which expects a JSON-string body in
 * text/plain), /templates/execute is validated by a different schema that
 * requires a real JSON object — so we send application/json here.
 */
export function executeTemplate(vault, { name, args = {}, createFile, targetPath } = {}) {
  const payload = { name, arguments: args };
  if (createFile != null) payload.createFile = createFile;
  if (targetPath != null) payload.targetPath = targetPath;
  return request(vault, 'POST', '/templates/execute', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/**
 * Navigate the Obsidian instance serving this vault to a file — and bring its
 * window to the front — by calling the bridge plugin's public `/open` route
 * SERVER-SIDE. No browser is involved: this is the browser-free counterpart to
 * a click-to-open *link*. In clients that proxy link clicks through a browser
 * (notably Claude Desktop's web link handling), a clicked http link always pops
 * a browser tab; calling /open from here (the router process) never does — the
 * bridge does the workspace navigation + focus dance directly.
 *
 * We discard the tiny HTML page /open returns (`json: false` → text, ignored).
 * request() throws a categorized RestApiError on 404 (file not in the vault),
 * connection refused (Obsidian / Local REST API not running), etc.
 *
 * @param {object} vault - registry vault descriptor (uses baseUrl/timeoutMs).
 * @param {string} filePath - vault-relative path of the file to open.
 * @param {object} [opts]
 * @param {string} [opts.anchor] - optional heading to scroll to (emitted as
 *   `?h=`, exactly like click-to-open). Leading `#` optional; empty → ignored.
 * @returns {Promise<{ ok: true, anchor: string|null }>}
 */
export async function openInObsidian(vault, filePath, { anchor } = {}) {
  const cleanAnchor = normalizeAnchor(anchor);
  const encodedPath = encodeVaultPath(filePath);
  const query = cleanAnchor ? `?h=${encodeURIComponent(cleanAnchor)}` : '';
  await request(vault, 'GET', `/open/${encodedPath}${query}`, { json: false });
  return { ok: true, anchor: cleanAnchor || null };
}
