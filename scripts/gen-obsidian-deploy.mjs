#!/usr/bin/env node
/**
 * gen-obsidian-deploy.mjs — deployment-artifact generator for running a vault as a
 * `linuxserver/obsidian` (Selkies) container on a host (e.g. the Dedibox) and
 * wiring it back to the router via a `VAULT_*` env line.  (v0.21.0, vault-hosting Phase 1)
 *
 * Produces, from one vault descriptor, three artifacts:
 *   1. a docker-compose SERVICE block   (the GUI+REST container)
 *   2. an nginx REVERSE-PROXY block      (HTTPS, mode-based access control, self-heal resolver)
 *   3. a `VAULT_<NAME>=<JSON>` env line   (consumed by registry.parseEnvVaults, v0.20.0)
 *
 * Design:
 *   - Core functions are PURE (no fs/network) and return structured objects +
 *     deterministic strings → fully unit-testable.
 *   - SECRET-SAFE: `apiKey` / basic-auth password default to PLACEHOLDERS
 *     (`<token>` / `<password>`). The generator NEVER invents or logs a secret.
 *   - The emitted `VAULT_*` line is designed to round-trip through
 *     `registry.parseEnvVaults` — the test suite asserts exactly that, so the
 *     generator can't drift from what the router actually accepts.
 *
 * Modes (the security profile of a vault's exposure):
 *   - 'wg'     → WireGuard-only. baseUrl uses a 10.8.0.x host (so the router's
 *                wireguard:true sanity-check passes); nginx adds an Access List
 *                `allow 10.8.0.0/24; deny all;`. For sensitive / medical vaults.
 *   - 'public' → public HTTPS via nginx + Let's Encrypt + bearer apiKey. baseUrl
 *                is the https domain. REFUSED for sensitive vaults (guard below).
 *   - 'lan'    → plain HTTP on the LAN. baseUrl uses a 192.168.x host.
 *
 * CLI:
 *   node scripts/gen-obsidian-deploy.mjs --name tribu --rest-port 27145 \
 *        --mode wg --wg-host 10.8.0.1 [--api-domain ...] [--gui-domain ...] [--json]
 */

export const OBSIDIAN_IMAGE = 'lscr.io/linuxserver/obsidian:latest';
export const DEFAULT_GUI_PORT = 3001;
export const WG_RANGE = '10.8.0.0/24';
export const LAN_RANGE = '192.168.0.0/16';
export const ROUTER_PORT_MIN = 27124;
export const ROUTER_PORT_MAX = 27199;
export const VALID_MODES = ['wg', 'public', 'lan'];

const PLACEHOLDER_TOKEN = '<token>';
const PLACEHOLDER_PASSWORD = '<password>';

/**
 * Derive the env-var KEY for a vault name: VAULT_ + UPPER, non-alphanumerics → _.
 * e.g. "tribu" → "VAULT_TRIBU"; "portfolio.nicolasgalzy.fr" → "VAULT_PORTFOLIO_NICOLASGALZY_FR".
 */
export function envKeyForName(name) {
  return 'VAULT_' + String(name).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Normalize + validate deploy options. Returns a frozen, fully-defaulted opts
 * object. Throws Error with a clear message on invalid input (fail-fast — this
 * feeds production infra, so we refuse ambiguous config rather than guess).
 *
 * @param {object} raw
 * @returns {object} normalized opts
 */
export function normalizeDeployOpts(raw = {}) {
  const errors = [];
  const o = { ...raw };

  // --- name: docker-service- + slug-safe ---
  o.name = typeof o.name === 'string' ? o.name.trim() : '';
  if (!/^[a-z0-9][a-z0-9-]*$/.test(o.name)) {
    const dotHint = o.name.includes('.')
      ? ` If your vault has a FQDN (e.g. "portfolio.nicolasgalzy.fr"), pass the ` +
        `subdomain as --name (e.g. "portfolio") and the FQDN as --api-domain/--gui-domain.`
      : '';
    errors.push(
      `name "${o.name}" is invalid — must be a lowercase slug [a-z0-9-], ` +
        `starting alphanumeric (e.g. "tribu", "smile-cabinet").` + dotHint,
    );
  }

  // --- mode ---
  o.mode = o.mode || 'wg';
  if (!VALID_MODES.includes(o.mode)) {
    errors.push(`mode "${o.mode}" invalid — one of: ${VALID_MODES.join(', ')}.`);
  }

  // --- restPort (the Local REST API port the plugin serves inside the container) ---
  o.restPort = Number(o.restPort);
  if (!Number.isInteger(o.restPort) || o.restPort < 1 || o.restPort > 65535) {
    errors.push(`restPort "${raw.restPort}" invalid — integer 1-65535 required.`);
  }

  // --- guiPort (Selkies GUI host-published port) ---
  // Must be UNIQUE per vault: every container's GUI is :3001 internally, so
  // publishing all of them on the same host port collides (review+ P2). Default
  // to restPort+1000 (a disjoint band from the 27124-27199 REST block →
  // 28124-28199), overridable. Mirror restPort's fail-fast strictness (N1).
  if (o.guiPort === undefined || o.guiPort === null || o.guiPort === '') {
    // Derived default = restPort+1000. Range-check it too (review+ P3): a valid
    // high restPort like 65000 would derive 66000 (>65535) → require an explicit
    // --gui-port instead of silently returning an out-of-range value.
    const derived = Number.isInteger(o.restPort) ? o.restPort + 1000 : DEFAULT_GUI_PORT;
    if (derived > 65535) {
      errors.push(
        `derived guiPort ${derived} (restPort+1000) is out of range — restPort ` +
          `${o.restPort} is too high for the default. Pass an explicit --gui-port 1-65535.`,
      );
    } else {
      o.guiPort = derived;
    }
  } else if (!Number.isInteger(Number(o.guiPort)) || Number(o.guiPort) < 1 || Number(o.guiPort) > 65535) {
    errors.push(`guiPort "${raw.guiPort}" invalid — integer 1-65535 required (omit for default restPort+1000).`);
  } else {
    o.guiPort = Number(o.guiPort);
  }

  // --- sensitivity (medical/sensitive flag drives the security guard) ---
  o.sensitive = o.sensitive === true || o.sensitive === 'true';

  // --- SECURITY GUARD: a sensitive vault may ONLY be exposed in wg mode ---
  // (review+ P2: previously only `public` was refused, so `--sensitive --mode lan`
  // slipped through and would expose medical data on the LAN.)
  if (o.sensitive && o.mode !== 'wg') {
    errors.push(
      `refusing to generate: vault "${o.name}" is marked sensitive but mode is ` +
        `"${o.mode}". Sensitive/medical vaults must use mode "wg" (WireGuard-only — ` +
        `the REST port binds to the WG interface and nginx/ACL restrict to ` +
        `10.8.0.0/24). Use --mode wg, or drop --sensitive only if this vault truly ` +
        `holds no protected data.`,
    );
  }

  // --- host / domain per mode ---
  if (o.mode === 'wg') {
    o.wgHost = (o.wgHost || '10.8.0.1').trim();
    if (!/^10\.8\.0\.\d{1,3}$/.test(o.wgHost)) {
      errors.push(
        `wg mode: wgHost "${o.wgHost}" must be in the 10.8.0.x WireGuard range ` +
          `(else the router's wireguard:true sanity-check warns).`,
      );
    }
  } else if (o.mode === 'lan') {
    o.lanHost = (o.lanHost || '192.168.0.10').trim();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(o.lanHost)) {
      errors.push(`lan mode: lanHost "${o.lanHost}" must be an IPv4 address.`);
    }
  } else if (o.mode === 'public') {
    o.apiDomain = (o.apiDomain || '').trim();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(o.apiDomain)) {
      errors.push(`public mode: apiDomain "${o.apiDomain}" must be a valid hostname (e.g. tribu-api.kiviri.fr).`);
    }
  }

  // --- optional GUI domain (for the Selkies web viewer behind nginx) ---
  o.guiDomain = typeof o.guiDomain === 'string' ? o.guiDomain.trim() : '';
  if (o.guiDomain && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(o.guiDomain)) {
    errors.push(`guiDomain "${o.guiDomain}" is not a valid hostname.`);
  }

  // --- defaults (non-secret) ---
  o.configPath = (o.configPath || `/srv/vaults/${o.name || 'vault'}`).trim();
  o.upstreamHost = (o.upstreamHost || `obsidian-${o.name || 'vault'}`).trim();
  o.puid = o.puid ?? 1000;
  o.pgid = o.pgid ?? 1000;
  o.tz = o.tz || 'Europe/Paris';
  o.timeoutMs = Number.isInteger(Number(o.timeoutMs)) && Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : 15000;
  o.description = typeof o.description === 'string' ? o.description : '';
  o.harden = o.harden !== false && o.harden !== 'false'; // default ON (disable terminal/sudo)

  // --- secrets: PLACEHOLDERS by default; never invented ---
  o.apiKey = typeof o.apiKey === 'string' && o.apiKey.length > 0 ? o.apiKey : PLACEHOLDER_TOKEN;
  o.basicUser = typeof o.basicUser === 'string' && o.basicUser.length > 0 ? o.basicUser : 'obsidian';
  o.basicPassword =
    typeof o.basicPassword === 'string' && o.basicPassword.length > 0 ? o.basicPassword : PLACEHOLDER_PASSWORD;

  if (errors.length > 0) {
    const err = new Error('Invalid deploy options:\n  - ' + errors.join('\n  - '));
    err.validationErrors = errors;
    throw err;
  }
  return o;
}

/**
 * Compute the baseUrl the ROUTER uses to reach this vault, per mode. This MUST
 * match how the REST port is published (see buildComposeService):
 *   - wg   → http://<wgHost>:<restPort>   (port bound to the WG interface; the
 *            router reaches it directly over the encrypted tunnel — Roland's
 *            proven model. No nginx in front of REST.)
 *   - lan  → http://<lanHost>:<restPort>  (port bound to the LAN interface)
 *   - public → https://<apiDomain>        (port bound to loopback; nginx
 *            terminates TLS on 443 and proxies to it)
 */
export function computeBaseUrl(opts) {
  const o = normalizeDeployOpts(opts);
  if (o.mode === 'wg') return `http://${o.wgHost}:${o.restPort}`;
  if (o.mode === 'lan') return `http://${o.lanHost}:${o.restPort}`;
  return `https://${o.apiDomain}`; // public — nginx terminates TLS on 443
}

/**
 * The host interface the REST port is published on, per mode. The advertised
 * baseUrl (above) and this bind MUST agree, or the router can't reach the vault
 * (review+ P1): wg/lan bind to the reachable interface; public binds loopback so
 * only the same-host nginx reaches it.
 */
export function restBindHost(o) {
  if (o.mode === 'wg') return o.wgHost;
  if (o.mode === 'lan') return o.lanHost;
  return '127.0.0.1'; // public
}

/**
 * Build the `VAULT_<NAME>=<JSON>` line for the router's mcp_settings.json env.
 * The JSON is exactly what registry.parseEnvVaults expects; the round-trip is
 * asserted in tests so this can never drift from the router's parser.
 *
 * @returns {{ key: string, value: string, line: string, descriptor: object }}
 */
export function buildVaultEnvLine(opts) {
  const o = normalizeDeployOpts(opts);
  const descriptor = {
    name: o.name,
    baseUrl: computeBaseUrl(o),
    apiKey: o.apiKey,
  };
  if (o.description) descriptor.description = o.description;
  descriptor.wireguard = o.mode === 'wg';
  // public = real Let's Encrypt cert → verify TLS; wg/lan = plain HTTP → flag irrelevant but explicit
  descriptor.tlsInsecure = false;
  descriptor.timeoutMs = o.timeoutMs;

  const key = envKeyForName(o.name);
  const value = JSON.stringify(descriptor);
  return { key, value, line: `${key}=${value}`, descriptor };
}

/**
 * Build the docker-compose SERVICE as a structured object (the source of truth).
 * Render it to YAML with renderComposeYaml().
 *
 * @returns {{ serviceName: string, service: object }}
 */
export function buildComposeService(opts) {
  const o = normalizeDeployOpts(opts);
  const env = [
    `PUID=${o.puid}`,
    `PGID=${o.pgid}`,
    `TZ=${o.tz}`,
    `TITLE=Obsidian — ${o.name}`,
    // Basic auth on the Selkies GUI. Weak by design → ALSO put nginx in front.
    `CUSTOM_USER=${o.basicUser}`,
    `PASSWORD=${o.basicPassword}`,
  ];
  if (o.harden) {
    // Hardening: disable in-GUI terminal / sudo / file-transfer (medical safety).
    env.push('DISABLE_TERMINAL=true', 'DISABLE_ROOT=true');
  }
  const restHost = restBindHost(o);
  const service = {
    image: OBSIDIAN_IMAGE,
    container_name: o.upstreamHost,
    environment: env,
    volumes: [`${o.configPath}:/config`],
    // REST port: published on the interface the router actually uses (wg/lan) so
    // baseUrl is reachable; loopback for public (nginx proxies it). GUI port:
    // always loopback (nginx terminates TLS for the browser) + UNIQUE per vault
    // host port (guiPort, default restPort+1000) so multiple vaults don't collide.
    ports: [`127.0.0.1:${o.guiPort}:3001`, `${restHost}:${o.restPort}:${o.restPort}`],
    shm_size: '1gb', // required for the Electron app
    restart: 'unless-stopped',
  };
  return { serviceName: o.upstreamHost, service };
}

/** Minimal deterministic YAML renderer for the fixed compose shape. */
export function renderComposeYaml(opts) {
  const { serviceName, service } = buildComposeService(opts);
  const lines = ['services:', `  ${serviceName}:`];
  const ind = '    ';
  for (const [k, v] of Object.entries(service)) {
    if (Array.isArray(v)) {
      lines.push(`${ind}${k}:`);
      for (const item of v) lines.push(`${ind}  - ${yamlScalar(item)}`);
    } else {
      lines.push(`${ind}${k}: ${yamlScalar(v)}`);
    }
  }
  return lines.join('\n') + '\n';
}

// YAML 1.1 "magic" scalars that a parser would reinterpret as non-string
// (null/bool) if left bare. A user-supplied PASSWORD=null / CUSTOM_USER=off must
// stay a string → force-quote these. (review+ I1)
const YAML_RESERVED = /^(null|~|true|false|yes|no|on|off|nan|\.inf|-\.inf)$/i;

/** Quote a YAML scalar only when needed (keeps output clean + valid). */
function yamlScalar(v) {
  if (typeof v === 'number') return String(v);
  const s = String(v);
  // Force-quote YAML 1.1 reserved words even though they're "clean" char-wise.
  if (YAML_RESERVED.test(s) || s === '') return `"${s.replace(/"/g, '\\"')}"`;
  // Quote if it contains YAML-significant chars or could be misparsed.
  if (/^[\w./@=:-]+$/.test(s) && !/^\d+$/.test(s)) return s;
  if (/^\d/.test(s) || /[:#{}\[\],&*?|<>=!%@`"']/.test(s) || s.includes(' ')) {
    return `"${s.replace(/"/g, '\\"')}"`;
  }
  return s;
}

/** TLS directive lines for an nginx server block, per mode (always real paths). */
function nginxTlsLines(o, domain) {
  // review+ P1: ALWAYS emit ssl_certificate / ssl_certificate_key so the block
  // is `nginx -t`-loadable as-is. public → Let's Encrypt; wg/lan → a self-signed
  // path the runbook tells you to generate (openssl), never just a comment.
  if (o.mode === 'public') {
    return [
      `    ssl_certificate     /etc/letsencrypt/live/${domain}/fullchain.pem;`,
      `    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;`,
    ];
  }
  return [
    `    # self-signed cert — generate once: openssl req -x509 -newkey rsa:2048 -nodes \\`,
    `    #   -keyout /etc/nginx/ssl/${o.name}.key -out /etc/nginx/ssl/${o.name}.crt -days 825 -subj "/CN=${o.name}"`,
    `    ssl_certificate     /etc/nginx/ssl/${o.name}.crt;`,
    `    ssl_certificate_key /etc/nginx/ssl/${o.name}.key;`,
  ];
}

/** Per-mode access-control lines, indented for INSIDE `location { }` (8 spaces). */
function nginxAccessLines(o, label) {
  if (o.mode === 'wg') {
    return [`        # WireGuard-only — sensitive/medical ${label}`, `        allow ${WG_RANGE};`, '        deny all;'];
  }
  if (o.mode === 'lan') {
    return [`        # LAN-only ${label}`, `        allow ${LAN_RANGE};`, '        deny all;'];
  }
  return [`        # public ${label}: no IP restriction — auth is the gate (bearer apiKey / basic auth)`];
}

/**
 * Build the nginx REVERSE-PROXY block for the vault's REST API.
 *
 * IMPORTANT (review+ P1): only **public** mode needs an nginx REST proxy. In
 * `wg`/`lan` the REST port is published directly on the WG/LAN interface and the
 * router reaches it without nginx (see buildComposeService / computeBaseUrl), so
 * this returns **null** for those modes — emitting a bogus cert-less block would
 * be misleading and fail `nginx -t`.
 *
 * For public: resolver-variable `proxy_pass` to the container over the Docker
 * network (self-heals on container IP-shuffle — the 2026-05-29 502 class), real
 * Let's Encrypt cert, no IP ACL (the Local REST API bearer apiKey is the gate).
 *
 * @returns {string|null} nginx server { } block, or null for wg/lan
 */
export function buildNginxApiServer(opts) {
  const o = normalizeDeployOpts(opts);
  if (o.mode !== 'public') return null;
  const upstreamVar = `$upstream_${o.name.replace(/-/g, '_')}_api`;

  return [
    'server {',
    '    listen 443 ssl http2;',
    ...nginxTlsLines(o, o.apiDomain),
    `    server_name ${o.apiDomain};`,
    '',
    '    # Self-heal on container IP-shuffle: re-resolve via Docker DNS every 10s',
    '    resolver 127.0.0.11 valid=10s;',
    `    set ${upstreamVar} ${o.upstreamHost};`,
    '',
    '    location / {',
    ...nginxAccessLines(o, 'REST API'),
    `        proxy_pass http://${upstreamVar}:${o.restPort};`,
    '        proxy_set_header Host $host;',
    '        proxy_set_header X-Real-IP $remote_addr;',
    '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '        proxy_set_header X-Forwarded-Proto $scheme;',
    '    }',
    '}',
  ].join('\n') + '\n';
}

/**
 * Build the nginx block for the Selkies GUI (the web viewer). Emitted for ALL
 * modes when a guiDomain is given (the browser always needs TLS termination).
 * WebSocket upgrade headers; resolver-variable proxy to the container over the
 * Docker network; real cert directives in every mode (review+ P1); per-mode ACL
 * so a wg/lan GUI isn't accidentally public (review+ P2).
 *
 * @returns {string|null}
 */
export function buildNginxGuiServer(opts) {
  const o = normalizeDeployOpts(opts);
  if (!o.guiDomain) return null;
  const upstreamVar = `$upstream_${o.name.replace(/-/g, '_')}_gui`;

  return [
    'server {',
    '    listen 443 ssl http2;',
    ...nginxTlsLines(o, o.guiDomain),
    `    server_name ${o.guiDomain};`,
    '',
    '    # Self-heal on container IP-shuffle: re-resolve via Docker DNS every 10s',
    '    resolver 127.0.0.11 valid=10s;',
    `    set ${upstreamVar} ${o.upstreamHost};`,
    '',
    '    location / {',
    ...nginxAccessLines(o, 'GUI'),
    '        # the container serves the GUI over HTTPS on 3001 (self-signed)',
    `        proxy_pass https://${upstreamVar}:3001;`,
    '        proxy_ssl_verify off;',
    '        proxy_http_version 1.1;',
    '        proxy_set_header Upgrade $http_upgrade;',
    '        proxy_set_header Connection "upgrade";',
    '        proxy_set_header Host $host;',
    '        proxy_read_timeout 3600s;',
    '    }',
    '}',
  ].join('\n') + '\n';
}

/**
 * One-shot: build every artifact + human-facing notes for a vault deployment.
 * @returns {{ name, mode, baseUrl, composeYaml, nginxApi, nginxGui, vaultEnv, notes }}
 */
export function buildDeploymentPlan(opts) {
  const o = normalizeDeployOpts(opts);
  const vaultEnv = buildVaultEnvLine(o);
  const restHost = restBindHost(o);
  const notes = [
    `Vault "${o.name}" → mode ${o.mode}; router reaches it at ${vaultEnv.descriptor.baseUrl}.`,
    o.apiKey === PLACEHOLDER_TOKEN
      ? 'apiKey is a PLACEHOLDER — replace <token> with the vault\'s real Local REST API key before use.'
      : 'apiKey provided (kept out of logs).',
    o.basicPassword === PLACEHOLDER_PASSWORD
      ? 'GUI PASSWORD is a PLACEHOLDER — set a real one before exposing the GUI.'
      : 'GUI password provided.',
    o.mode === 'wg'
      ? `WG mode: REST port published on ${restHost} (WG interface) — reachable only over the encrypted tunnel; ensure WireGuard is up on the host. No nginx needed for REST.`
      : o.mode === 'public'
        ? 'PUBLIC mode: REST bound to 127.0.0.1; nginx (Let\'s Encrypt) terminates TLS + bearer apiKey is the gate — never use for sensitive/medical vaults.'
        : `LAN mode: REST port published on ${restHost} (LAN interface); not for sensitive vaults.`,
    `GUI port published on 127.0.0.1:${o.guiPort} (unique per vault → no collision); nginx terminates TLS for the browser.`,
    o.guiDomain
      ? `GUI viewer at https://${o.guiDomain} (nginx → container :3001).`
      : 'No --gui-domain given → no web-viewer nginx block generated (REST-only deployment).',
  ];
  return {
    name: o.name,
    mode: o.mode,
    baseUrl: vaultEnv.descriptor.baseUrl,
    composeYaml: renderComposeYaml(o),
    nginxApi: buildNginxApiServer(o),
    nginxGui: buildNginxGuiServer(o),
    vaultEnv,
    notes,
  };
}

/**
 * Render a deployment plan to the human-facing text the CLI prints. Pure +
 * exported so the rendering (esp. the "no REST block in wg/lan" handling — a
 * literal `null` here would be pasteable garbage, review+ P2) is unit-testable.
 *
 * @param {object} plan - from buildDeploymentPlan
 * @returns {string}
 */
export function renderPlanText(plan) {
  const out = [];
  out.push(`# === Deployment plan: vault "${plan.name}" (mode: ${plan.mode}) ===\n`);
  out.push('## docker-compose service\n');
  out.push(plan.composeYaml);
  if (plan.nginxApi) {
    out.push('## nginx — REST API reverse proxy\n');
    out.push(plan.nginxApi);
  } else {
    const iface = plan.mode === 'wg' ? 'WireGuard' : 'LAN';
    out.push(
      `## nginx — REST API reverse proxy\n\n(none for ${plan.mode} mode — the REST ` +
        `port is reached directly on the ${iface} interface; no nginx block needed.)\n`,
    );
  }
  if (plan.nginxGui) {
    out.push('## nginx — Selkies GUI (web viewer) reverse proxy\n');
    out.push(plan.nginxGui);
  }
  out.push('## router VAULT_* env line (add to the MCPHub instance env)\n');
  out.push(plan.vaultEnv.line + '\n');
  out.push('## notes\n');
  out.push(plan.notes.map((n) => '  - ' + n).join('\n'));
  return out.join('\n');
}

// Exposed for tests. (parseArgv is a hoisted function declaration below.)
export const _internals = { yamlScalar, parseArgv, PLACEHOLDER_TOKEN, PLACEHOLDER_PASSWORD };

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const rawKey = a.slice(2);
    // `--no-xxx` is a boolean negation → set xxx=false (review+ B1: --no-harden
    // was silently dropped because the generic camelCase made it `noHarden`).
    if (rawKey.startsWith('no-')) {
      const k = rawKey.slice(3).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      out[k] = false;
      continue;
    }
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function isMain() {
  // ESM "run directly" check without import.meta in a way tests can avoid.
  return process.argv[1] && /gen-obsidian-deploy\.mjs$/.test(process.argv[1]);
}

if (isMain()) {
  const args = parseArgv(process.argv.slice(2));
  if (args.help || args.h) {
    console.log(
      [
        'Usage: node scripts/gen-obsidian-deploy.mjs --name <slug> --rest-port <n> --mode <wg|public|lan> [opts]',
        '',
        'Required: --name, --rest-port, --mode',
        'Mode-specific: --wg-host 10.8.0.x | --lan-host 192.168.x | --api-domain host.tld',
        'Optional: --gui-domain, --config-path, --description, --sensitive, --timeout-ms,',
        '          --puid, --pgid, --tz, --no-harden, --json',
        '',
        'Secrets are NEVER required or invented — apiKey/password default to placeholders.',
      ].join('\n'),
    );
    process.exit(0);
  }
  try {
    const plan = buildDeploymentPlan(args);
    if (args.json) {
      console.log(JSON.stringify(plan, null, 2));
    } else {
      console.log(renderPlanText(plan));
    }
  } catch (err) {
    console.error('[gen-obsidian-deploy] ' + err.message);
    process.exit(1);
  }
}
