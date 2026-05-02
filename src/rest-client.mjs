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

const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });
const secureAgent = new Agent();

function agentFor(vault) {
  return vault.tlsInsecure ? insecureAgent : secureAgent;
}

function authHeaders(vault) {
  return {
    Authorization: `Bearer ${vault.apiKey}`,
    Accept: 'application/json',
  };
}

function encodePath(p) {
  // Encode each segment separately to keep slashes intact.
  return p
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
}

async function request(vault, method, urlPath, { headers = {}, body, json = true } = {}) {
  const url = `${vault.baseUrl}${urlPath}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), vault.timeoutMs);

  try {
    const res = await fetch(url, {
      method,
      dispatcher: agentFor(vault),
      headers: { ...authHeaders(vault), ...headers },
      body,
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `[${vault.name}] ${method} ${urlPath} → HTTP ${res.status} ${res.statusText}` +
          (text ? `: ${text.slice(0, 200)}` : ''),
      );
    }

    const contentType = res.headers.get('content-type') || '';
    if (json && contentType.includes('application/json')) {
      return await res.json();
    }
    return await res.text();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`[${vault.name}] ${method} ${urlPath} timed out after ${vault.timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
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

export function searchSimple(vault, query, contextLength = 100) {
  const params = new URLSearchParams({
    query,
    contextLength: String(contextLength),
  });
  return request(vault, 'POST', `/search/simple/?${params.toString()}`);
}

/**
 * Semantic search via the mcp-tools API extension to Local REST API.
 *
 * Requires both the `mcp-tools` plugin AND the `smart-connections` plugin
 * to be installed and enabled in the target vault. Smart Connections must
 * have indexed the vault (it does so automatically on plugin load).
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
 * The mcp-tools handler expects the same JSON-string-in-text/plain quirk as
 * /search/smart.
 */
export function executeTemplate(vault, { name, args = {}, createFile, targetPath } = {}) {
  const payload = JSON.stringify({
    name,
    arguments: args,
    createFile,
    targetPath,
  });
  return request(vault, 'POST', '/templates/execute', {
    headers: { 'Content-Type': 'text/plain' },
    body: payload,
  });
}
