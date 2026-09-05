/**
 * MCP Resources (v0.20.0, MCP standard #6).
 *
 * Exposes the vault's static catalogue as MCP Resources so an agent can
 * discover "what's here" at ~zero cost (one ListResources call) instead of
 * looping list_files / list_vaults / get_file. Resources are READ-ONLY by
 * nature, so this is safe on `OBSIDIAN_ROUTER_READONLY=true` instances.
 *
 * Per active vault this workspace can REACH (see `reachableVaults` below) we
 * expose its two scaffold pages:
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
import { sanitizeContent, safeForMessage, NO_TRUNCATION } from './helpers/sanitize.mjs';
import { scaffoldCandidates, shouldTryLegacyScaffold } from './helpers/wiki-meta-scaffolds.mjs';
import { isVaultReachable } from './helpers/vault-reach.mjs';

/**
 * The vaults this session may NAME — the same answer `resolveVault()` gives,
 * applied to the two discovery surfaces of this channel. Without it,
 * `resources/list` advertised a resource for every registered vault and
 * `resources/read` on it then refused with "not reachable from this
 * workspace": a contract that hands out URIs it will not honour, and a
 * catalogue that leaks the `baseUrl` of vaults this workspace never declared.
 * A no-op unless `vaultReach: "declared"` is configured.
 */
function reachableVaults(registry) {
  return (registry.vaults || []).filter((v) => isVaultReachable(v.name, registry));
}

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
        // Vault names come from the router config, which a provisioning flow
        // writes from caller input — and NOTHING downstream normalizes this
        // list: it is served straight to the client by the SDK.
        name: `${safeForMessage(v.name, 120)} — ${f.title}`,
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
      // Same reasoning as buildResourceList: this JSON is the response body,
      // and the resources channel has no wrapResult to normalize it.
      vaults: vaults.map((v) => ({
        name: safeForMessage(v.name, 120),
        type: safeForMessage(v.type, 40),
        baseUrl: safeForMessage(v.baseUrl, 200),
        ...(v.description ? { description: safeForMessage(v.description, 500) } : {}),
      })),
    },
    null,
    2,
  );
}

/**
 * THE ERROR BOUNDARY FOR THIS CHANNEL — the counterpart of the CallTool `catch`
 * in index.mjs, and here for the same reason.
 *
 * The comment below says this channel "never had a boundary" and then builds
 * one out of per-throw sanitising: the two refusals this module WRITES both go
 * through `safeForMessage`. That was mistaken for coverage — the guard named
 * "resources normalize their errors" exercises exactly those two and nothing
 * else. Every throw the function merely PASSES ALONG stayed outside:
 *
 *   - `registry.resolveVault(parsed.vault)`, whose message interpolates the
 *     caller's own URI segment raw, and
 *   - `throw lastErr`, which re-raises whatever the REST read produced.
 *
 * The first was live. Driven against the real stdio server, `resources/read` on
 * `obsidian-router://<payload>/wiki-catalog` answered `Unknown vault "<payload>"`
 * byte for byte — ESC, BEL, NUL, DEL, U+009B, CR/LF and a forged
 * `</result><result>` wrapper straight into the model's context. The second is
 * clean today only because `RestApiError`'s constructor sanitises, which is a
 * fact about another class, not about this channel.
 *
 * So: one choke point rather than a list of sites, because a list only ever
 * covers the throws somebody already thought of. That is the same lesson the
 * comment below claims to have learned, generalised one level further.
 */
function normalizeResourceError(err) {
  const out = new Error(safeForMessage(err && err.message ? err.message : String(err), 2000));
  if (err && err.kind) out.kind = safeForMessage(err.kind, 80);
  if (err && err.hint) out.hint = safeForMessage(err.hint, 500);
  // `code` is preserved as-is: the SDK maps it to a JSON-RPC code. It is a
  // number, never a string that reaches the model.
  if (err && err.code !== undefined) out.code = err.code;
  return out;
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
  try {
    return await resolveResource(uri, registry, readFile);
  } catch (err) {
    throw normalizeResourceError(err);
  }
}

async function resolveResource(uri, registry, readFile) {
  // THE RESOURCES CHANNEL IS A SECOND WIRE, and until v0.71.0 it had no
  // boundary at all.
  //
  // Fourteen rounds hardened the TOOLS path — success payloads through
  // wrapResult, errors through the dispatcher catch. None of it applied here:
  // registerResourceHandlers wires this function's caller straight onto the SDK,
  // so a throw from here reached the client having passed through nothing. The
  // URI is caller-supplied, so a resource id carrying a forged tool-result
  // wrapper and a live ESC arrived verbatim.
  //
  // The lesson is the one round 13 already taught and I did not generalise:
  // "centralise the error channel" was implemented as "centralise the
  // dispatcher's error channel", and there is more than one dispatcher.
  //
  // THAT IS PAST TENSE NOW, and the tense matters: `readResource` above wraps
  // every call to this function in `normalizeResourceError`, and both SDK
  // handlers do the same. This comment kept saying a throw from here "reaches
  // the client having passed through nothing" twenty lines below the choke
  // point that makes it false — the exact shape of stale security prose that
  // this module's own docstring warns about, because a reviewer reads the
  // comment instead of the call site. The per-site `safeForMessage` calls below
  // are now redundancy, not the boundary.
  const parsed = parseResourceUri(uri);
  if (!parsed) {
    throw new Error(
      `Unknown resource URI "${safeForMessage(uri, 200)}". Expected ${CATALOG_URI} or ` +
        `${RESOURCE_SCHEME}://<vault>/<wiki-catalog|wiki-overview>.`,
    );
  }

  if (parsed.catalog) {
    return {
      contents: [
        {
          uri: CATALOG_URI,
          mimeType: 'application/json',
          text: buildVaultCatalog(reachableVaults(registry)),
        },
      ],
    };
  }

  const def = findResourceDef(parsed.id);
  if (!def) {
    throw new Error(
      `Unknown resource id "${safeForMessage(parsed.id, 80)}" for vault "${safeForMessage(parsed.vault, 80)}". ` +
        `Valid ids: ${VAULT_RESOURCE_FILES.map((f) => f.id).join(', ')}.`,
    );
  }

  // resolveVault throws a clear error for unknown / missing-key vaults. It used
  // to propagate straight to the SDK, and its message interpolates the vault
  // segment of the caller's own URI — so "a clear error" was also a verbatim
  // echo of caller-controlled bytes. `readResource` now normalises on the way
  // out; this line is left to throw because the boundary, not the call site, is
  // what makes that safe.
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
  // NO_TRUNCATION, to match the tools boundary. Reading the SAME note through
  // get_file returned it whole while reading it as a resource silently capped
  // it at 1 MiB — one document, two size policies, decided by which door the
  // caller used.
  const text = sanitizeContent(raw, { maxLen: NO_TRUNCATION });
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
    try {
      const registry = getRegistry();
      return { resources: buildResourceList(reachableVaults(registry)) };
    } catch (err) {
      // The same boundary as ReadResource, for the same reason: `getRegistry()`
      // reads a hot-reloaded config, and a config-load failure names the file it
      // could not read.
      throw normalizeResourceError(err);
    }
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    try {
      const registry = getRegistry();
      return await readResource(request.params.uri, registry, (vault, path) =>
        getFileContent(vault, path),
      );
    } catch (err) {
      throw normalizeResourceError(err);
    }
  });
}
