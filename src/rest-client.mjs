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

  const isFrontmatterObject = targetType === 'frontmatter' && typeof content === 'object';
  const headers = {
    Operation: operation,
    'Target-Type': targetType,
    Target: encodeURIComponent(target),
    'Content-Type': isFrontmatterObject ? 'application/json' : 'text/markdown',
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

  const body = isFrontmatterObject ? JSON.stringify(content) : content;

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
