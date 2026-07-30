/**
 * MCP Resources (v0.20.0, MCP standard #6).
 *
 * Exposes the vault's static catalogue as MCP Resources so an agent can
 * discover "what's here" at ~zero cost (one ListResources call) instead of
 * looping list_files / list_vaults / get_file. Resources are READ-ONLY by
 * nature, so this is safe on `OBSIDIAN_ROUTER_READONLY=true` instances.
 *
 * Per active vault we expose its two scaffold pages:
 *   - wiki-meta/catalog.md   → the page catalogue
 *   - wiki-meta/overview.md  → the executive summary
 * Plus one synthetic, router-wide catalogue:
 *   - obsidian-router://_catalog  → the list of vaults + type/baseUrl (no secrets)
 *
 * URI scheme: obsidian-router://<vault>/<resource-id>
 *   e.g. obsidian-router://dedibox/wiki-catalog
 * The synthetic catalogue uses the reserved URI obsidian-router://_catalog.
 *
 * v0.58.0 renamed the catalogue's file (`wiki-meta/index.md` →
 * `wiki-meta/catalog.md`, because OKF reserves the `index` basename) and its
 * resource id (`wiki-index` → `wiki-catalog`). Both the old id and the old
 * file path keep working — a published URI is a contract, and a vault can be
 * un-migrated.
 *
 * Self-contained (imports the SDK schemas + the REST read helper directly) so
 * wiring it into index.mjs is a single registerResourceHandlers() call.
 */
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getFileContent } from './rest-client.mjs';
import { sanitizeContent } from './helpers/sanitize.mjs';
import { scaffoldCandidates, shouldTryLegacyScaffold } from './helpers/wiki-meta-scaffolds.mjs';

export const RESOURCE_SCHEME = 'obsidian-router';
export const CATALOG_URI = `${RESOURCE_SCHEME}://_catalog`;

/**
 * The per-vault scaffold pages exposed as resources. `id` is the URI suffix,
 * `path` is the vault-relative file read over REST, `fallbackPaths` are older
 * names accepted on read, and `aliasIds` are older URI suffixes still
 * resolved.
 */
export const VAULT_RESOURCE_FILES = [
  {
    id: 'wiki-catalog',
    aliasIds: ['wiki-index'],
    path: scaffoldCandidates('catalog')[0],
    fallbackPaths: scaffoldCandidates('catalog').slice(1),
    title: 'Wiki catalog',
    description: 'Curated catalogue of pages in this vault (wiki-meta/catalog.md).',
  },
  {
    id: 'wiki-overview',
    aliasIds: [],
    path: 'wiki-meta/overview.md',
    fallbackPaths: [],
    title: 'Wiki overview',
    description: 'Executive summary of this vault (wiki-meta/overview.md).',
  },
];

/** Look a resource id up, accepting the pre-0.58.0 aliases. */
export function findResourceDef(id) {
  return (
    VAULT_RESOURCE_FILES.find((f) => f.id === id) ??
    VAULT_RESOURCE_FILES.find((f) => (f.aliasIds ?? []).includes(id)) ??
    null
  );
}

/** Build the canonical resource URI for a vault page. */
export function buildResourceUri(vaultName, id) {
  return `${RESOURCE_SCHEME}://${encodeURIComponent(vaultName)}/${id}`;
}

/**
 * Parse a resource URI back into { vault, id } (or { catalog: true }).
 * Returns null for anything that isn't one of our URIs.
 */
export function parseResourceUri(uri) {
  if (typeof uri !== 'string') return null;
  if (uri === CATALOG_URI) return { catalog: true };
  const prefix = `${RESOURCE_SCHEME}://`;
  if (!uri.startsWith(prefix)) return null;
  const rest = uri.slice(prefix.length);
  const slash = rest.indexOf('/');
  if (slash === -1) return null;
  const vault = decodeURIComponent(rest.slice(0, slash));
  const id = rest.slice(slash + 1);
  if (!vault || !id) return null;
  return { vault, id };
}

/**
 * Build the ListResources payload from the active vaults[] set: one synthetic
 * catalogue + two scaffold pages per vault.
 */
export function buildResourceList(vaults = []) {
  const resources = [
    {
      uri: CATALOG_URI,
      name: 'Vault catalogue',
      description:
        'Router-wide list of configured vaults (name, type, baseUrl). Read this first to see what vaults exist.',
      mimeType: 'application/json',
    },
  ];
  for (const v of vaults) {
    for (const f of VAULT_RESOURCE_FILES) {
      resources.push({
        uri: buildResourceUri(v.name, f.id),
        name: `${v.name} — ${f.title}`,
        description: f.description,
        mimeType: 'text/markdown',
      });
    }
  }
  return resources;
}

/** Build the synthetic vault-catalogue JSON. apiKey/secrets are NEVER included. */
export function buildVaultCatalog(vaults = []) {
  return JSON.stringify(
    {
      vaults: vaults.map((v) => ({
        name: v.name,
        type: v.type,
        baseUrl: v.baseUrl,
        ...(v.description ? { description: v.description } : {}),
      })),
    },
    null,
    2,
  );
}

/**
 * Resolve a ReadResource request to its MCP `contents` payload. Pure except for
 * the REST read (injected via `readFile` for testability).
 *
 * @param {string} uri
 * @param {object} registry - the live registry ({ vaults, resolveVault }).
 * @param {(vault:object, path:string)=>Promise<string>} readFile - returns file text.
 * @returns {Promise<{contents: object[]}>}
 */
export async function readResource(uri, registry, readFile) {
  const parsed = parseResourceUri(uri);
  if (!parsed) {
    throw new Error(
      `Unknown resource URI "${uri}". Expected ${CATALOG_URI} or ` +
        `${RESOURCE_SCHEME}://<vault>/<wiki-catalog|wiki-overview>.`,
    );
  }

  if (parsed.catalog) {
    return {
      contents: [
        {
          uri: CATALOG_URI,
          mimeType: 'application/json',
          text: buildVaultCatalog(registry.vaults),
        },
      ],
    };
  }

  const def = findResourceDef(parsed.id);
  if (!def) {
    throw new Error(
      `Unknown resource id "${parsed.id}" for vault "${parsed.vault}". ` +
        `Valid ids: ${VAULT_RESOURCE_FILES.map((f) => f.id).join(', ')}.`,
    );
  }

  // resolveVault throws a clear error for unknown / missing-key vaults — let it
  // propagate so the SDK surfaces it to the client.
  const vault = registry.resolveVault(parsed.vault);
  // Sanitize vault-sourced markdown exactly like get_file does — strip control
  // chars / ANSI escapes that would corrupt the MCP stdio JSON stream or smuggle
  // escapes into the agent context. (The catalogue branch above is router-built
  // JSON, so it needs no sanitizing.)
  // Try the current name, then any legacy one. The last error propagates so
  // a genuinely missing file still surfaces the REST failure to the client.
  const candidates = [def.path, ...(def.fallbackPaths ?? [])];
  let raw;
  let lastErr;
  for (const candidate of candidates) {
    try {
      raw = await readFile(vault, candidate);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      // Only a 404 justifies trying the legacy name — see
      // `shouldTryLegacyScaffold`.
      if (!shouldTryLegacyScaffold(err)) break;
    }
  }
  if (lastErr) throw lastErr;
  const text = sanitizeContent(raw);
  return {
    contents: [
      {
        uri,
        mimeType: 'text/markdown',
        text,
      },
    ],
  };
}

/**
 * Wire the ListResources + ReadResource handlers onto the server. Called once
 * from index.mjs after the Server is created.
 *
 * @param {object} server - the MCP Server instance.
 * @param {() => object} getRegistry - returns the live registry (registryRef.current).
 */
export function registerResourceHandlers(server, getRegistry) {
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const registry = getRegistry();
    return { resources: buildResourceList(registry.vaults) };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const registry = getRegistry();
    return readResource(request.params.uri, registry, (vault, path) =>
      getFileContent(vault, path),
    );
  });
}
