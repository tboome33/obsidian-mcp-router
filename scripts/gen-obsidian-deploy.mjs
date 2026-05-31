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
    errors.push(
      `name "${o.name}" is invalid — must be a lowercase slug [a-z0-9-], ` +
        `starting alphanumeric (e.g. "tribu", "smile-cabinet").`,
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

  // --- guiPort (Selkies HTTPS) ---
  o.guiPort = Number.isInteger(Number(o.guiPort)) ? Number(o.guiPort) : DEFAULT_GUI_PORT;

  // --- sensitivity (medical/sensitive flag drives the public-mode guard) ---
  o.sensitive = o.sensitive === true || o.sensitive === 'true';

  // --- SECURITY GUARD: a sensitive vault may NEVER be exposed in public mode ---
  if (o.mode === 'public' && o.sensitive) {
    errors.push(
      `refusing to generate: vault "${o.name}" is marked sensitive but mode is ` +
        `"public" (bearer-only HTTPS, no network restriction). Sensitive/medical ` +
        `vaults must use mode "wg" (WireGuard-only). Override the sensitivity ` +
        `only if this vault truly holds no protected data.`,
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
 * Compute the baseUrl the ROUTER uses to reach this vault, per mode.
 * (wg → http://10.8.0.x:port · public → https://domain · lan → http://192.168.x:port)
 */
export function computeBaseUrl(opts) {
  const o = normalizeDeployOpts(opts);
  if (o.mode === 'wg') return `http://${o.wgHost}:${o.restPort}`;
  if (o.mode === 'lan') return `http://${o.lanHost}:${o.restPort}`;
  return `https://${o.apiDomain}`; // public — nginx terminates TLS on 443
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
  const service = {
    image: OBSIDIAN_IMAGE,
    container_name: o.upstreamHost,
    environment: env,
    volumes: [`${o.configPath}:/config`],
    // Expose the GUI (3001) and the Local REST API port. Bind to loopback on the
    // host so ONLY nginx (same host) can reach them — never the raw internet.
    ports: [`127.0.0.1:${o.guiPort}:3001`, `127.0.0.1:${o.restPort}:${o.restPort}`],
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

/** Quote a YAML scalar only when needed (keeps output clean + valid). */
function yamlScalar(v) {
  if (typeof v === 'number') return String(v);
  const s = String(v);
  // Quote if it contains YAML-significant chars or could be misparsed.
  if (/^[\w./@=:-]+$/.test(s) && !/^\d+$/.test(s)) return s;
  if (/^\d/.test(s) || /[:#{}\[\],&*?|<>=!%@`"']/.test(s) || s.includes(' ')) {
    return `"${s.replace(/"/g, '\\"')}"`;
  }
  return s;
}

/**
 * Build the nginx REVERSE-PROXY block for the vault's REST API.
 * Critical features:
 *   - resolver-variable `proxy_pass` (self-heals on container IP-shuffle — the
 *     exact 502 bug from 2026-05-29-mcphub-502-ip-shuffle-fix).
 *   - mode-based access control: wg → WG-only Access List; lan → LAN allow;
 *     public → no IP restriction (the Local REST API bearer is the gate).
 *
 * @returns {string} nginx server { } block
 */
export function buildNginxApiServer(opts) {
  const o = normalizeDeployOpts(opts);
  const serverName = o.mode === 'public' ? o.apiDomain : `${o.name}-api.local`;
  const upstreamVar = `$upstream_${o.name.replace(/-/g, '_')}_api`;

  // Access-control lines, already indented for INSIDE `location { }` (8 spaces).
  const access = [];
  if (o.mode === 'wg') {
    access.push('        # WireGuard-only — sensitive/medical vault', `        allow ${WG_RANGE};`, '        deny all;');
  } else if (o.mode === 'lan') {
    access.push('        # LAN-only', `        allow ${LAN_RANGE};`, '        allow 127.0.0.1;', '        deny all;');
  } else {
    access.push('        # public: no IP restriction — the Local REST API bearer apiKey is the gate');
  }

  const tls =
    o.mode === 'public'
      ? [
          '    listen 443 ssl http2;',
          `    ssl_certificate     /etc/letsencrypt/live/${o.apiDomain}/fullchain.pem;`,
          `    ssl_certificate_key /etc/letsencrypt/live/${o.apiDomain}/privkey.pem;`,
        ]
      : ['    listen 443 ssl http2;', '    # self-signed or internal CA cert for non-public modes'];

  return [
    'server {',
    ...tls,
    `    server_name ${serverName};`,
    '',
    '    # Self-heal on container IP-shuffle: re-resolve via Docker DNS every 10s',
    '    resolver 127.0.0.11 valid=10s;',
    `    set ${upstreamVar} ${o.upstreamHost};`,
    '',
    '    location / {',
    ...access,
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
 * Build the nginx block for the Selkies GUI (the web viewer). Needs WebSocket
 * upgrade headers. Only emitted when a guiDomain is given.
 *
 * @returns {string|null}
 */
export function buildNginxGuiServer(opts) {
  const o = normalizeDeployOpts(opts);
  if (!o.guiDomain) return null;
  const upstreamVar = `$upstream_${o.name.replace(/-/g, '_')}_gui`;
  // Access-control lines, indented for INSIDE `location { }` (8 spaces).
  const access =
    o.mode === 'wg'
      ? [`        allow ${WG_RANGE};`, '        deny all;']
      : ['        # public GUI: rely on container basic auth + (recommended) an extra auth layer'];

  const tls =
    o.mode === 'public'
      ? [
          `    ssl_certificate     /etc/letsencrypt/live/${o.guiDomain}/fullchain.pem;`,
          `    ssl_certificate_key /etc/letsencrypt/live/${o.guiDomain}/privkey.pem;`,
        ]
      : ['    # self-signed or internal CA cert'];

  return [
    'server {',
    '    listen 443 ssl http2;',
    `    server_name ${o.guiDomain};`,
    ...tls,
    '',
    '    resolver 127.0.0.11 valid=10s;',
    `    set ${upstreamVar} ${o.upstreamHost};`,
    '',
    '    location / {',
    ...access,
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
  const notes = [
    `Vault "${o.name}" → mode ${o.mode}; router reaches it at ${vaultEnv.descriptor.baseUrl}.`,
    o.apiKey === PLACEHOLDER_TOKEN
      ? 'apiKey is a PLACEHOLDER — replace <token> with the vault\'s real Local REST API key before use.'
      : 'apiKey provided (kept out of logs).',
    o.basicPassword === PLACEHOLDER_PASSWORD
      ? 'GUI PASSWORD is a PLACEHOLDER — set a real one before exposing the GUI.'
      : 'GUI password provided.',
    o.mode === 'wg'
      ? 'WG mode: nginx Access List restricts to 10.8.0.0/24. Ensure WireGuard is up on the host.'
      : o.mode === 'public'
        ? 'PUBLIC mode: HTTPS + bearer apiKey only — never use for sensitive/medical vaults.'
        : 'LAN mode: reachable on the local network; not for sensitive vaults.',
    'Ports are bound to 127.0.0.1 on the host → only nginx (same host) reaches the container.',
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

// Exposed for tests.
export const _internals = { yamlScalar, PLACEHOLDER_TOKEN, PLACEHOLDER_PASSWORD };

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
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
      console.log(`# === Deployment plan: vault "${plan.name}" (mode: ${plan.mode}) ===\n`);
      console.log('## docker-compose service\n');
      console.log(plan.composeYaml);
      console.log('## nginx — REST API reverse proxy\n');
      console.log(plan.nginxApi);
      if (plan.nginxGui) {
        console.log('## nginx — Selkies GUI (web viewer) reverse proxy\n');
        console.log(plan.nginxGui);
      }
      console.log('## router VAULT_* env line (add to the MCPHub instance env)\n');
      console.log(plan.vaultEnv.line + '\n');
      console.log('## notes\n');
      for (const n of plan.notes) console.log('  - ' + n);
    }
  } catch (err) {
    console.error('[gen-obsidian-deploy] ' + err.message);
    process.exit(1);
  }
}
