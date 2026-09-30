/**
 * A fake GitHub for the plugin installer tests — no network, ever.
 *
 * `fakeGitHub(spec)` returns `{ transport, calls, set }`:
 *   - `transport(url, opts)` is the one-request function plugin-release-
 *     resolver.mjs expects (it does NOT follow redirects — the resolver does);
 *   - `calls` records every URL requested, so a test can assert that a host
 *     or a plugin was never contacted;
 *   - `set(url, response)` changes a route mid-test (a release published
 *     between the dry run and the apply).
 *
 * Routes are exact URLs. A response is `{ status, headers?, body? }`; a body
 * that is an object is JSON-encoded. An unknown URL answers 404.
 *
 * `standardFleet()` builds a realistic set: a registry, one plugin whose repo
 * MOVED (the API 301s to /repositories/<id>/…, and the release says where it
 * lives now), one plain plugin, the bridge's own release, and asset downloads
 * that 302 to the CDN hosts, like GitHub's.
 */

export const REGISTRY_URL =
  'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json';

export function fakeGitHub(routes = {}) {
  const table = new Map(Object.entries(routes));
  const calls = [];
  async function transport(url) {
    calls.push(url);
    const r = table.get(url);
    if (!r) return { status: 404, headers: {}, body: Buffer.from('not found') };
    const body = r.body === undefined ? Buffer.alloc(0)
      : Buffer.isBuffer(r.body) ? r.body
        : typeof r.body === 'string' ? Buffer.from(r.body)
          : Buffer.from(JSON.stringify(r.body));
    return { status: r.status ?? 200, headers: r.headers ?? {}, body };
  }
  return { transport, calls, set: (url, response) => table.set(url, response), table };
}

/** A release object as the GitHub API returns it, with CDN-redirecting assets. */
export function releaseRoutes({ repo, tag, files, apiUrl, cdnHost = 'objects.githubusercontent.com', assetIdBase = 1000 }) {
  const routes = {};
  const assets = [];
  let n = 0;
  for (const [name, content] of Object.entries(files)) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(typeof content === 'string' ? content : JSON.stringify(content));
    const dl = `https://github.com/${repo}/releases/download/${tag}/${name}`;
    const cdn = `https://${cdnHost}/github-production-release-asset/${assetIdBase + n}/${name}?sig=fake`;
    routes[dl] = { status: 302, headers: { location: cdn } };
    routes[cdn] = { status: 200, body: buf };
    assets.push({ id: assetIdBase + n, name, size: buf.length, browser_download_url: dl });
    n += 1;
  }
  routes[apiUrl ?? `https://api.github.com/repos/${repo}/releases/latest`] = {
    status: 200,
    body: {
      tag_name: tag,
      html_url: `https://github.com/${repo}/releases/tag/${tag}`,
      url: `https://api.github.com/repos/${repo}/releases/9`,
      assets,
    },
  };
  return routes;
}

export const manifestOf = (id, version) => ({ id, name: id, version, minAppVersion: '1.0.0' });

export const BRIDGE_REPO = 'example-owner/example-bridge';
export const BRIDGE_URLS = Object.freeze({
  'main.js': `https://github.com/${BRIDGE_REPO}/releases/latest/download/main.js`,
  'manifest.json': `https://github.com/${BRIDGE_REPO}/releases/latest/download/manifest.json`,
});

export const TEST_ALLOWLIST = new Set([
  'obsidian-local-rest-api',
  'mcp-router-bridge',
  'obsidian-style-settings',
  'templater-obsidian',
]);
export const TEST_REQUIRED = ['obsidian-local-rest-api', 'mcp-router-bridge'];

export function testSymbols() {
  return { allowlist: TEST_ALLOWLIST, required: TEST_REQUIRED, bridgeUrls: BRIDGE_URLS, missing: [] };
}

/**
 * The standard fleet. `styleTag` lets a test publish a new release of the
 * moved plugin between a dry run and an apply.
 */
export function standardFleet({ styleTag = '1.0.9', templaterTag = '2.3.0', bridgeTag = '0.4.0', lraTag = '3.1.0' } = {}) {
  return {
    [REGISTRY_URL]: {
      status: 200,
      body: [
        { id: 'obsidian-style-settings', name: 'Style Settings', repo: 'old-owner/obsidian-style-settings' },
        { id: 'templater-obsidian', name: 'Templater', repo: 'tmpl-owner/Templater' },
        { id: 'obsidian-local-rest-api', name: 'Local REST API', repo: 'lra-owner/obsidian-local-rest-api' },
        { id: 'some-outsider', name: 'Outsider', repo: 'outsider/plugin' },
        // A registry entry claiming the bridge's id: must NEVER be used.
        { id: 'mcp-router-bridge', name: 'Impostor', repo: 'impostor/fake-bridge' },
      ],
    },
    // The moved repo: the API answers 301 to the numeric repository route.
    'https://api.github.com/repos/old-owner/obsidian-style-settings/releases/latest': {
      status: 301,
      headers: { location: 'https://api.github.com/repositories/424242/releases/latest' },
    },
    ...releaseRoutes({
      repo: 'community-archive/obsidian-style-settings',
      tag: styleTag,
      apiUrl: 'https://api.github.com/repositories/424242/releases/latest',
      files: {
        'main.js': `/* style-settings ${styleTag} */ module.exports = {};`,
        'manifest.json': manifestOf('obsidian-style-settings', styleTag),
        'styles.css': '.style-settings {}',
      },
      assetIdBase: 2000,
    }),
    ...releaseRoutes({
      repo: 'tmpl-owner/Templater',
      tag: templaterTag,
      files: {
        'main.js': `/* templater ${templaterTag} */ module.exports = {};`,
        'manifest.json': manifestOf('templater-obsidian', templaterTag),
      },
      cdnHost: 'release-assets.githubusercontent.com',
      assetIdBase: 3000,
    }),
    ...releaseRoutes({
      repo: BRIDGE_REPO,
      tag: bridgeTag,
      files: {
        'main.js': `/* bridge ${bridgeTag} */ module.exports = {};`,
        'manifest.json': manifestOf('mcp-router-bridge', bridgeTag),
      },
      assetIdBase: 4000,
    }),
    ...releaseRoutes({
      repo: 'lra-owner/obsidian-local-rest-api',
      tag: lraTag,
      files: {
        'main.js': `/* lra ${lraTag} */ module.exports = {};`,
        'manifest.json': manifestOf('obsidian-local-rest-api', lraTag),
        'styles.css': '.lra {}',
      },
      assetIdBase: 5000,
    }),
  };
}
