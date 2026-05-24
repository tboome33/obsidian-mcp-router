/**
 * Single source of truth for the package version, read once at module
 * load from `package.json`. Importable from any module without creating
 * circular dependencies (src/index.mjs used to do the read inline, but
 * tools that wanted the version had to either duplicate the read or
 * hardcode the string — both led to drift, cf. v0.13.4 review+ finding
 * P3 about `USER_AGENT = 'obsidian-mcp-router/0.13.0-dev'` staleness).
 *
 * Synchronous read at module init — runs once across the whole process.
 */

import fs from 'node:fs';

export const PKG_VERSION = JSON.parse(
  fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).version;

/**
 * Canonical User-Agent string for outbound HTTP requests originating
 * from router-side tools (`extract_page_metadata`, `propose_linked_sources`,
 * future `download_page_assets`, etc.). Auto-updated when `package.json`
 * is bumped — no per-tool hardcoding.
 */
export const USER_AGENT = `obsidian-mcp-router/${PKG_VERSION} (+https://github.com/tboome33/obsidian-mcp-router)`;
