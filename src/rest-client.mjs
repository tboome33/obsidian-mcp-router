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
import { contentSha256 } from './helpers/content-hash.mjs';
import { applyHeadingPatch, HeadingPatchError } from './helpers/heading-patch.mjs';
import { safeForMessage } from './helpers/sanitize.mjs';

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
    // Sanitise HERE, in the constructor, and not at the twelve construction
    // sites. Every one of those composes a message from something that came off
    // the wire, and the worst is `categorizeHttpStatus`, which splices in 200
    // bytes of the HTTP RESPONSE BODY verbatim. Proven end-to-end against a
    // local server answering 500 with a hostile body: the forged
    // `</output></result><result>` wrapper and live ANSI/OSC bytes arrived in
    // the model's context through `Error: ${err.message}`, and ALSO on the
    // SUCCESS path — `move_file` surfaces this message inside its `warning`
    // field when the source delete fails.
    //
    // Redirect handling interpolates hostnames taken from a `Location` header,
    // i.e. also server-chosen. Doing this per-site would have covered the two a
    // reviewer named and left ten; the constructor is the one place every
    // present and future RestApiError must pass through.
    //
    // The cap is generous (2000) because these messages carry an actionable
    // `hint` after the untrusted part, and truncating the hint would trade a
    // security fix for a usability regression.
    super(safeForMessage(message, 2000));
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
    // `/open/<path>` (used by open_in_obsidian) is ALSO a bridge route, but a
    // 404 there is AMBIGUOUS: the file may simply not exist in the vault, OR
    // the bridge plugin may not be installed/enabled (so the route is absent).
    // The hint names both causes so the caller can disambiguate.
    const isOpenRoute = urlPath.startsWith('/open/');
    let hint;
    if (isOpenRoute) {
      hint = `Route ${urlPath} returned 404 — AMBIGUOUS: either the file doesn't exist in this vault, OR the "obsidian-mcp-router-bridge" plugin (>= 0.2.0, which registers /open) isn't installed/enabled. Check the path first, then the plugin (https://github.com/tboome33/obsidian-mcp-router-bridge).`;
    } else if (isBridgeRoute) {
      hint = `Route ${urlPath} not found. The "obsidian-mcp-router-bridge" plugin is probably not installed or not enabled in this vault. Install it from https://github.com/tboome33/obsidian-mcp-router-bridge and toggle it on in Community plugins.`;
    }
    return new RestApiError(base, {
      kind: 'not_found',
      vaultName: vault.name,
      status,
      urlPath,
      hint,
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

  // 1b. ifMatch precondition on the SOURCE (C1): refuse to move if the source
  // changed since the caller read it. Non-atomic (a writer could slip in
  // before the DELETE), but catches the stale-source case.
  if (opts.ifMatch) {
    const srcStr = typeof content === 'string' ? content : String(content);
    if (contentSha256(srcStr) !== opts.ifMatch) {
      throw makeIfMatchConflict(vault, fromPath, 'content-changed');
    }
  }

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
 * Build the actionable conflict error thrown when an ifMatch precondition
 * fails — the C1 "someone changed this since you read it" signal. Kept as one
 * helper so the atomic-route path and the fallback path phrase it identically.
 *
 * @param {object} vault
 * @param {string} filePath
 * @param {'content-changed'|'target-missing'} reason
 * @param {string|null} [currentSha]
 */
function makeIfMatchConflict(vault, filePath, reason, currentSha = null) {
  const why =
    reason === 'target-missing'
      ? `the file no longer exists (it was deleted or moved since you read it)`
      : `its content changed since you read it`;
  return new RestApiError(
    `[${vault.name}] ifMatch precondition failed for "${filePath}": ${why}.`,
    {
      kind: 'conflict',
      vaultName: vault.name,
      status: 409,
      urlPath: `/vault/${encodePath(filePath)}`,
      hint:
        'Re-read the file with get_file, rebuild your change on the CURRENT content, and retry with the fresh contentSha256. This guard prevents silently overwriting another session\'s (or your own concurrent) edit.',
    },
  );
}

/**
 * Attempt the cooperative-CAS overwrite ONLY — no fallback, tight feature
 * detection. The building block the reserved-path writer (F3-b) uses so it can
 * choose its OWN behaviour when the CAS route is unusable (a late-read backup,
 * or a strict skip) instead of the generic GET-compare fallback below.
 *
 * ATOMIC ONLY BETWEEN COOPERATING CAS WRITERS. The bridge serialises
 * read→compare→write against OTHER `/vault-cas` writes — NOT against a plain
 * core `PUT /vault`, the open Obsidian editor, or a Sync/LiveSync apply. This is
 * inherent to optimistic concurrency (see the bridge's `vault-cas.ts`).
 *
 * Outcomes:
 *   - `{ ok: true, response }`            — the CAS write applied.
 *   - THROWS `kind:'conflict'` (409)      — the precondition failed; the file
 *                                           was left intact. NEVER masked.
 *   - `{ routeUnusable: true, status }`   — the route cannot service this write
 *                                           (404 absent bridge; 400 body-not-text;
 *                                           413 too large; 415 media type). The
 *                                           caller decides the fallback.
 *   - THROWS the original error           — a real BUG or hard failure: a 400
 *                                           `bad-precondition` (a malformed sha —
 *                                           masking it would hide the bug),
 *                                           401/403, 5xx, network. Tightened on
 *                                           purpose (codex H2): only an
 *                                           established route-unusable shape
 *                                           degrades.
 *
 * @param {object} vault
 * @param {string} filePath
 * @param {string} content
 * @param {string} expectedSha  64-hex content hash
 * @returns {Promise<{ ok: true, response: object } | { routeUnusable: true, status: number }>}
 */
export async function attemptAtomicCas(vault, filePath, content, expectedSha) {
  try {
    const response = await request(vault, 'PUT', `/vault-cas/${encodePath(filePath)}`, {
      headers: {
        'If-Match-Content-Sha256': expectedSha,
        'Content-Type': 'text/plain',
      },
      body: content,
      json: true,
    });
    return { ok: true, response };
  } catch (err) {
    if (err instanceof RestApiError && err.kind === 'conflict') {
      const isMissing = /target-missing/.test(err.message);
      throw makeIfMatchConflict(vault, filePath, isMissing ? 'target-missing' : 'content-changed');
    }
    // A malformed-precondition 400 is a BUG (we compute the sha ourselves, so it
    // should never happen) — surface it, never degrade through a weaker path
    // where the same bug would pass silently.
    if (err instanceof RestApiError && err.status === 400 && /bad-precondition/.test(err.message)) {
      throw err;
    }
    const routeUnusable =
      err instanceof RestApiError &&
      (err.kind === 'not_found' || err.status === 400 || err.status === 413 || err.status === 415);
    if (routeUnusable) return { routeUnusable: true, status: err.status };
    throw err; // 401/403, 5xx, timeout, network — not recoverable this way
  }
}

/**
 * Conditional full-file write — C1 optimistic concurrency. Writes `content`
 * ONLY if the file's current content still hashes to `expectedSha` (the value
 * the caller got from get_file's contentSha256). Otherwise throws a 409 conflict
 * and writes nothing. REDUCES the clobber window; does not close it.
 *
 * Two tiers, chosen at runtime by feature-detection:
 *   1. COOPERATIVE CAS (preferred): PUT /vault-cas/<path> on the
 *      obsidian-mcp-router-bridge plugin (>= 0.7.0). The bridge
 *      reads-compares-writes inside the Obsidian process under a mutex. ATOMIC
 *      ONLY BETWEEN COOPERATING CAS WRITERS: it makes the check and the write
 *      indivisible against OTHER /vault-cas writes — but NOT against a writer
 *      that bypasses the route (a plain core PUT /vault — the router's own
 *      DEFAULT non-ifMatch write, the open Obsidian editor, an Obsidian
 *      Sync/LiveSync apply). Full clobber-prevention would need every writer to
 *      opt in. Content travels as text/plain, which does not change the bytes on
 *      disk.
 *   2. FALLBACK: if the route is unusable — a 404 (older/absent bridge) OR a
 *      400/413/415 (route present but cannot service this request shape) — the
 *      router VERIFIES THE HASH IMMEDIATELY BEFORE A NON-CONDITIONAL core PUT
 *      (GET-compare-then-PUT). This reduces the window to the interval between
 *      that GET and the PUT; a writer landing strictly inside it is still
 *      overwritten. Strictly better than the unconditional write it replaces,
 *      but NOT closed. A genuine 409 conflict is NEVER a fallback trigger — the
 *      precondition failing must surface, not be retried through a weaker path.
 *
 * The CAS path relies on the bridge's adapter.read() returning the same bytes
 * get_file (core GET /vault) returned, so `expectedSha` is comparable on both
 * sides; both hash cores strip a leading BOM to keep the two read paths in
 * agreement (helpers/content-hash.mjs). The fallback path re-reads through the
 * very same GET the caller used, so it is self-consistent.
 *
 * @param {object} vault
 * @param {string} filePath
 * @param {string} content     — the full new file content
 * @param {string} expectedSha — 64-hex content hash the edit is based on
 * @returns {Promise<{ casMode: 'atomic'|'fallback', response?: object }>}
 */
export async function writeFileIfMatch(vault, filePath, content, expectedSha) {
  // Tier 1 — the cooperative-CAS bridge route (atomic only between cooperating
  // CAS writers; the `casMode: 'atomic'` label below names that tier).
  try {
    const response = await request(vault, 'PUT', `/vault-cas/${encodePath(filePath)}`, {
      headers: {
        'If-Match-Content-Sha256': expectedSha,
        'Content-Type': 'text/plain',
      },
      body: content,
      json: true,
    });
    return { casMode: 'atomic', response };
  } catch (err) {
    if (err instanceof RestApiError && err.kind === 'conflict') {
      // The bridge rejected the precondition (a real 409). Its body carries
      // reason=content-changed|target-missing; the message includes it, but
      // we normalize to our actionable phrasing. We can't always tell the two
      // reasons apart from the truncated message, so infer from the body text.
      // A conflict is NEVER a fallback trigger — it is the guard doing its job.
      const isMissing = /target-missing/.test(err.message);
      throw makeIfMatchConflict(vault, filePath, isMissing ? 'target-missing' : 'content-changed');
    }
    // Fall back when the atomic route is UNUSABLE, not when it worked and said
    // "no". Unusable = 404 (route absent: the bridge handler itself never 404s,
    // so a 404 here unambiguously means an older/disabled bridge) OR a
    // 400/413/415 (route present but it can't service this request shape — an
    // empty body the parser turned into {}, a body over the size limit, a proxy
    // rejecting text/plain). In every such case the always-present core PUT
    // /vault path CAN service the write, and the fallback re-verifies the
    // precondition itself. Auth (401/403), 5xx, timeout, and network errors are
    // NOT recoverable this way → surface unchanged.
    const routeUnusable =
      err instanceof RestApiError &&
      (err.kind === 'not_found' ||
        err.status === 400 ||
        err.status === 413 ||
        err.status === 415);
    if (!routeUnusable) {
      throw err;
    }
    // Fall through to the GET-compare fallback below.
  }

  // Tier 2 — GET-compare-then-PUT fallback.
  let current;
  try {
    current = await getFileContent(vault, filePath);
  } catch (err) {
    if (err instanceof RestApiError && err.kind === 'not_found') {
      throw makeIfMatchConflict(vault, filePath, 'target-missing');
    }
    throw err;
  }
  const currentStr = typeof current === 'string' ? current : String(current);
  const currentSha = contentSha256(currentStr);
  if (currentSha !== expectedSha) {
    throw makeIfMatchConflict(vault, filePath, 'content-changed', currentSha);
  }
  await writeFile(vault, filePath, content);
  return { casMode: 'fallback' };
}

/**
 * Router-side precondition guard for the surgical / non-full-file write tools
 * (patch, delete, move-source, frontmatter-merge). GETs the file, hashes it,
 * and throws a 409 conflict unless it still matches `expectedSha`. This is the
 * fallback TIER only — it is NOT atomic (a writer can slip in between this
 * check and the subsequent mutation), but it reliably catches the common
 * "I read it, someone changed it, I'm about to act on stale content" case.
 * The atomic tier exists only for full-file writes (writeFileIfMatch).
 *
 * @param {object} vault
 * @param {string} filePath
 * @param {string} expectedSha
 */
export async function assertContentMatches(vault, filePath, expectedSha) {
  let current;
  try {
    current = await getFileContent(vault, filePath);
  } catch (err) {
    if (err instanceof RestApiError && err.kind === 'not_found') {
      throw makeIfMatchConflict(vault, filePath, 'target-missing');
    }
    throw err;
  }
  const currentStr = typeof current === 'string' ? current : String(current);
  if (contentSha256(currentStr) !== expectedSha) {
    throw makeIfMatchConflict(vault, filePath, 'content-changed');
  }
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
export async function patchFile(vault, filePath, args) {
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

  // Heading targets are patched ROUTER-SIDE (GET → line-based edit → PUT)
  // instead of being forwarded to Local REST API's PATCH. The plugin's heading
  // engine computes character offsets on LF-normalized content and splices
  // them into the raw bytes — on a CRLF file every line above the target
  // shifts the true offset by one byte, so appends land mid-line and replaces
  // swallow the heading (real corruption, 2026-08-02; same failure class as
  // the "heading containing a slash" bug). The line-based engine is immune
  // and keeps the file's own line endings. Trade-off: GET+PUT is the same
  // non-atomic read-modify-write tier as the plugin's own PATCH; the ifMatch
  // guard upstream still applies.
  if (targetType === 'heading') {
    if (typeof content !== 'string') {
      throw new RestApiError(
        `[${vault.name}] heading patch content must be a string`,
        { kind: 'unknown', vaultName: vault.name, urlPath: `/vault/${encodePath(filePath)}` },
      );
    }
    const raw = await getFileContent(vault, filePath);
    let result;
    try {
      result = applyHeadingPatch(typeof raw === 'string' ? raw : String(raw), {
        operation,
        target,
        content,
        targetDelimiter,
        createTargetIfMissing,
        applyIfContentPreexists,
        trimTargetWhitespace,
      });
    } catch (err) {
      if (err instanceof HeadingPatchError) {
        throw new RestApiError(`[${vault.name}] ${err.message}`, {
          kind: err.code === 'invalid-target' ? 'not_found' : 'unknown',
          vaultName: vault.name,
          status: 400,
          urlPath: `/vault/${encodePath(filePath)}`,
          hint: 'Heading targets need the FULL ancestry path joined by the delimiter (default "::") — read the file with get_file to inspect its heading structure.',
        });
      }
      throw err;
    }
    if (result.applied) {
      await writeFile(vault, filePath, result.content);
    }
    return result;
  }

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
