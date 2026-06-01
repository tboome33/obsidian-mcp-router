/**
 * Tests for scripts/gen-obsidian-deploy.mjs (v0.21.0, vault-hosting Phase 1).
 *
 * The headline guarantee: the `VAULT_*` line the generator emits ROUND-TRIPS
 * through the router's real `parseEnvVaults` (registry.mjs) — so the deploy
 * generator can never drift from what the router actually accepts.
 *
 * Network model (review+ corrected):
 *   - wg/lan: REST port is published on the WG/LAN interface; the router reaches
 *     it directly (no nginx for REST → buildNginxApiServer returns null).
 *   - public: REST bound to loopback; nginx (Let's Encrypt) proxies it.
 *   - GUI: always reached via nginx (TLS for the browser), host port unique per
 *     vault (guiPort default restPort+1000) to avoid collisions.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeDeployOpts,
  computeBaseUrl,
  restBindHost,
  buildVaultEnvLine,
  buildComposeService,
  renderComposeYaml,
  buildNginxApiServer,
  buildNginxGuiServer,
  buildDeploymentPlan,
  renderPlanText,
  envKeyForName,
  WG_RANGE,
  LAN_RANGE,
  _internals as genInternals,
} from '../scripts/gen-obsidian-deploy.mjs';
import { _internals as registryInternals } from '../src/registry.mjs';

const { parseEnvVaults } = registryInternals;
const { yamlScalar, parseArgv } = genInternals;

// ---------------------------------------------------------------------------
// envKeyForName
// ---------------------------------------------------------------------------
describe('envKeyForName', () => {
  test('simple name', () => assert.equal(envKeyForName('tribu'), 'VAULT_TRIBU'));
  test('dotted name → underscores', () =>
    assert.equal(envKeyForName('portfolio.nicolasgalzy.fr'), 'VAULT_PORTFOLIO_NICOLASGALZY_FR'));
  test('hyphen name → underscores', () =>
    assert.equal(envKeyForName('smile-cabinet'), 'VAULT_SMILE_CABINET'));
  test('no leading/trailing underscores from edge chars', () =>
    assert.equal(envKeyForName('x.'), 'VAULT_X'));
});

// ---------------------------------------------------------------------------
// normalizeDeployOpts — validation
// ---------------------------------------------------------------------------
describe('normalizeDeployOpts — validation', () => {
  const base = { name: 'tribu', restPort: 27145, mode: 'wg', wgHost: '10.8.0.1' };

  test('valid wg opts pass + get defaults', () => {
    const o = normalizeDeployOpts(base);
    assert.equal(o.name, 'tribu');
    assert.equal(o.restPort, 27145);
    assert.equal(o.guiPort, 28145); // default = restPort + 1000 (unique per vault)
    assert.equal(o.timeoutMs, 15000);
    assert.equal(o.harden, true);
    assert.equal(o.apiKey, '<token>'); // placeholder, never invented
    assert.equal(o.basicPassword, '<password>');
  });

  test('invalid name (uppercase/space) rejected', () => {
    assert.throws(() => normalizeDeployOpts({ ...base, name: 'Tribu Vault' }), /name .* invalid/);
  });

  test('invalid mode rejected', () => {
    assert.throws(() => normalizeDeployOpts({ ...base, mode: 'ftp' }), /mode .* invalid/);
  });

  test('out-of-range restPort rejected', () => {
    assert.throws(() => normalizeDeployOpts({ ...base, restPort: 99999 }), /restPort .* invalid/);
    assert.throws(() => normalizeDeployOpts({ name: 'x', mode: 'wg', wgHost: '10.8.0.1' }), /restPort/);
  });

  test('wg mode requires a 10.8.0.x host', () => {
    assert.throws(() => normalizeDeployOpts({ ...base, wgHost: '192.168.0.1' }), /10\.8\.0\.x/);
  });

  test('public mode requires a valid domain', () => {
    assert.throws(
      () => normalizeDeployOpts({ name: 'x', restPort: 27145, mode: 'public', apiDomain: 'not a domain' }),
      /apiDomain/,
    );
  });

  test('SECURITY GUARD: sensitive + public mode is REFUSED', () => {
    assert.throws(
      () => normalizeDeployOpts({ name: 'smile', restPort: 27129, mode: 'public', apiDomain: 'smile.kiviri.fr', sensitive: true }),
      /refusing to generate.*sensitive/s,
    );
  });

  test('SECURITY GUARD: sensitive + LAN mode is ALSO refused (review+ P2)', () => {
    assert.throws(
      () => normalizeDeployOpts({ name: 'smile', restPort: 27129, mode: 'lan', lanHost: '192.168.0.10', sensitive: true }),
      /refusing to generate.*must use mode "wg"/s,
    );
  });

  test('sensitive + wg mode is allowed', () => {
    const o = normalizeDeployOpts({ name: 'smile', restPort: 27129, mode: 'wg', wgHost: '10.8.0.1', sensitive: true });
    assert.equal(o.sensitive, true);
    assert.equal(o.mode, 'wg');
  });

  test('--no-harden disables hardening', () => {
    const o = normalizeDeployOpts({ ...base, harden: false });
    assert.equal(o.harden, false);
  });

  test('explicitly-set invalid guiPort is rejected (not a silent fallback)', () => {
    assert.throws(() => normalizeDeployOpts({ ...base, guiPort: 'abc' }), /guiPort .* invalid/);
    assert.throws(() => normalizeDeployOpts({ ...base, guiPort: 99999 }), /guiPort .* invalid/);
  });

  test('unset guiPort defaults to restPort+1000', () => {
    assert.equal(normalizeDeployOpts(base).guiPort, 28145);
    assert.equal(normalizeDeployOpts({ ...base, restPort: 27161 }).guiPort, 28161);
  });

  test('explicit guiPort is honored', () => {
    assert.equal(normalizeDeployOpts({ ...base, guiPort: 30000 }).guiPort, 30000);
  });

  test('derived guiPort out of range (restPort+1000 > 65535) is rejected (review+ P3)', () => {
    assert.throws(
      () => normalizeDeployOpts({ ...base, restPort: 65000 }),
      /derived guiPort 66000 .* out of range/,
    );
    // …but an explicit in-range gui-port rescues a high restPort
    assert.equal(normalizeDeployOpts({ ...base, restPort: 65000, guiPort: 65001 }).guiPort, 65001);
  });

  test('dotted name error includes the FQDN → --name/--api-domain hint', () => {
    assert.throws(
      () => normalizeDeployOpts({ ...base, name: 'portfolio.nicolasgalzy.fr' }),
      /pass the subdomain as --name/,
    );
  });
});

// ---------------------------------------------------------------------------
// computeBaseUrl + restBindHost — the bind MUST match the advertised baseUrl
// ---------------------------------------------------------------------------
describe('computeBaseUrl + restBindHost (review+ P1 coherence)', () => {
  test('wg → baseUrl host == restBindHost == wgHost', () => {
    const o = normalizeDeployOpts({ name: 'tribu', restPort: 27145, mode: 'wg', wgHost: '10.8.0.10' });
    assert.equal(computeBaseUrl(o), 'http://10.8.0.10:27145');
    assert.equal(restBindHost(o), '10.8.0.10'); // published on the same interface → reachable
  });
  test('lan → baseUrl host == restBindHost == lanHost', () => {
    const o = normalizeDeployOpts({ name: 'x', restPort: 27145, mode: 'lan', lanHost: '192.168.0.10' });
    assert.equal(computeBaseUrl(o), 'http://192.168.0.10:27145');
    assert.equal(restBindHost(o), '192.168.0.10');
  });
  test('public → https domain, REST bound loopback (nginx proxies)', () => {
    const o = normalizeDeployOpts({ name: 'x', restPort: 27145, mode: 'public', apiDomain: 'x.kiviri.fr' });
    assert.equal(computeBaseUrl(o), 'https://x.kiviri.fr');
    assert.equal(restBindHost(o), '127.0.0.1');
  });
});

// ---------------------------------------------------------------------------
// buildVaultEnvLine + ROUND-TRIP through the real parseEnvVaults
// ---------------------------------------------------------------------------
describe('buildVaultEnvLine — round-trips through registry.parseEnvVaults', () => {
  test('wg vault: descriptor parsed back identically by the router', () => {
    const { key, value, descriptor } = buildVaultEnvLine({
      name: 'tribu', restPort: 27145, mode: 'wg', wgHost: '10.8.0.10',
      apiKey: 'REALTOKEN123', description: 'famille', timeoutMs: 15000,
    });
    assert.equal(key, 'VAULT_TRIBU');
    const { envVaults, warnings } = parseEnvVaults({ [key]: value });
    assert.equal(envVaults.length, 1, 'router must accept the generated line');
    const v = envVaults[0];
    assert.equal(v.name, 'tribu');
    assert.equal(v.baseUrl, 'http://10.8.0.10:27145');
    assert.equal(v.apiKey, 'REALTOKEN123');
    assert.equal(v.wireguard, true);
    assert.equal(v.timeoutMs, 15000);
    assert.equal(v.type, 'remote');
    assert.equal(warnings.length, 0, 'wg host in range → no warning');
    assert.equal(descriptor.name, 'tribu');
  });

  test('public vault: parsed back, wireguard:false, https baseUrl', () => {
    const { key, value } = buildVaultEnvLine({ name: 'coursera', restPort: 27161, mode: 'public', apiDomain: 'coursera.kiviri.fr', apiKey: 'K' });
    const { envVaults } = parseEnvVaults({ [key]: value });
    assert.equal(envVaults[0].baseUrl, 'https://coursera.kiviri.fr');
    assert.equal(envVaults[0].wireguard, false);
  });

  test('lan vault round-trips and triggers NO wg warning', () => {
    const { key, value } = buildVaultEnvLine({ name: 'notes', restPort: 27150, mode: 'lan', lanHost: '192.168.0.10', apiKey: 'K' });
    const { envVaults, warnings } = parseEnvVaults({ [key]: value });
    assert.equal(envVaults[0].baseUrl, 'http://192.168.0.10:27150');
    assert.equal(envVaults[0].wireguard, false);
    assert.equal(warnings.length, 0);
  });

  test('placeholder token still round-trips (structure valid before secret is filled)', () => {
    const { key, value } = buildVaultEnvLine({ name: 'tribu', restPort: 27145, mode: 'wg', wgHost: '10.8.0.1' });
    const { envVaults } = parseEnvVaults({ [key]: value });
    assert.equal(envVaults.length, 1);
    assert.equal(envVaults[0].apiKey, '<token>');
  });
});

// ---------------------------------------------------------------------------
// yamlScalar (review+ I1) — magic scalars quoted; tested directly
// ---------------------------------------------------------------------------
describe('yamlScalar', () => {
  test('YAML 1.1 reserved words are force-quoted', () => {
    for (const s of ['null', 'NULL', '~', 'true', 'false', 'yes', 'no', 'on', 'off']) {
      assert.equal(yamlScalar(s), `"${s}"`, `${s} must be quoted`);
    }
  });
  test('plain slug values stay bare', () => {
    assert.equal(yamlScalar('obsidian-tribu'), 'obsidian-tribu');
    assert.equal(yamlScalar('1gb'), '1gb');
  });
  test('values with spaces / em-dash / colon are quoted', () => {
    assert.match(yamlScalar('TITLE=Obsidian — tribu'), /^".*"$/);
  });
  test('numbers pass through unquoted', () => {
    assert.equal(yamlScalar(1000), '1000');
  });
});

// ---------------------------------------------------------------------------
// buildComposeService / renderComposeYaml
// ---------------------------------------------------------------------------
describe('buildComposeService', () => {
  const base = { name: 'tribu', restPort: 27145, mode: 'wg', wgHost: '10.8.0.1' };

  test('wg: REST published on the WG interface; GUI on a unique loopback port', () => {
    const { serviceName, service } = buildComposeService(base);
    assert.equal(serviceName, 'obsidian-tribu');
    assert.equal(service.image, 'lscr.io/linuxserver/obsidian:latest');
    assert.equal(service.shm_size, '1gb');
    assert.deepEqual(service.volumes, ['/srv/vaults/tribu:/config']);
    // REST on the WG host (reachable by the router over the tunnel) — review+ P1
    assert.ok(service.ports.includes('10.8.0.1:27145:27145'), 'REST must bind the WG interface, not loopback');
    // GUI on a unique loopback port (restPort+1000) — review+ P2 collision fix
    assert.ok(service.ports.includes('127.0.0.1:28145:3001'), 'GUI must bind a unique loopback host port');
  });

  test('lan: REST published on the LAN interface', () => {
    const { service } = buildComposeService({ name: 'notes', restPort: 27150, mode: 'lan', lanHost: '192.168.0.10' });
    assert.ok(service.ports.includes('192.168.0.10:27150:27150'));
  });

  test('public: REST bound to loopback (nginx proxies)', () => {
    const { service } = buildComposeService({ name: 'x', restPort: 27161, mode: 'public', apiDomain: 'x.kiviri.fr' });
    assert.ok(service.ports.includes('127.0.0.1:27161:27161'));
  });

  test('two vaults get distinct GUI host ports (no collision)', () => {
    const a = buildComposeService({ name: 'a', restPort: 27145, mode: 'wg', wgHost: '10.8.0.1' });
    const b = buildComposeService({ name: 'b', restPort: 27161, mode: 'wg', wgHost: '10.8.0.1' });
    const guiOf = (s) => s.service.ports.find((p) => p.endsWith(':3001'));
    assert.notEqual(guiOf(a), guiOf(b), 'distinct vaults must not share a GUI host port');
  });

  test('harden ON adds DISABLE_TERMINAL/DISABLE_ROOT', () => {
    const { service } = buildComposeService(base);
    assert.ok(service.environment.includes('DISABLE_TERMINAL=true'));
    assert.ok(service.environment.includes('DISABLE_ROOT=true'));
  });

  test('harden OFF omits them', () => {
    const { service } = buildComposeService({ ...base, harden: false });
    assert.ok(!service.environment.some((e) => e.startsWith('DISABLE_TERMINAL')));
  });

  test('renderComposeYaml is valid-ish YAML (parseable keys, quoted spaces)', () => {
    const yaml = renderComposeYaml(base);
    assert.match(yaml, /^services:\n {2}obsidian-tribu:\n/);
    assert.match(yaml, /shm_size: 1gb/);
    assert.match(yaml, /"TITLE=Obsidian — tribu"/);
    assert.match(yaml, /10\.8\.0\.1:27145:27145/);
  });
});

// ---------------------------------------------------------------------------
// buildNginxApiServer — ONLY public mode (wg/lan REST is direct → null)
// ---------------------------------------------------------------------------
describe('buildNginxApiServer', () => {
  test('wg mode → null (REST is direct over WG, no nginx)', () => {
    assert.equal(buildNginxApiServer({ name: 'tribu', restPort: 27145, mode: 'wg', wgHost: '10.8.0.1' }), null);
  });

  test('lan mode → null (REST is direct on the LAN, no nginx)', () => {
    assert.equal(buildNginxApiServer({ name: 'notes', restPort: 27150, mode: 'lan', lanHost: '192.168.0.10' }), null);
  });

  test('public mode → Let\'s Encrypt cert + resolver-variable proxy + no IP ACL', () => {
    const conf = buildNginxApiServer({ name: 'coursera', restPort: 27161, mode: 'public', apiDomain: 'coursera.kiviri.fr' });
    assert.ok(conf, 'public must emit a block');
    assert.doesNotMatch(conf, /deny all;/);
    assert.match(conf, /ssl_certificate\s+\/etc\/letsencrypt\/live\/coursera\.kiviri\.fr\/fullchain\.pem;/);
    assert.match(conf, /ssl_certificate_key\s+\/etc\/letsencrypt\/live\/coursera\.kiviri\.fr\/privkey\.pem;/);
    assert.match(conf, /server_name coursera\.kiviri\.fr;/);
    // self-heal: variable upstream + resolver
    assert.match(conf, /resolver 127\.0\.0\.11 valid=10s;/);
    assert.match(conf, /set \$upstream_coursera_api obsidian-coursera;/);
    assert.match(conf, /proxy_pass http:\/\/\$upstream_coursera_api:27161;/);
    assert.equal((conf.match(/X-Forwarded-For/g) || []).length, 1);
  });
});

// ---------------------------------------------------------------------------
// buildNginxGuiServer — all modes, always cert directives, per-mode ACL
// ---------------------------------------------------------------------------
describe('buildNginxGuiServer', () => {
  test('null when no guiDomain', () => {
    assert.equal(buildNginxGuiServer({ name: 'tribu', restPort: 27145, mode: 'wg', wgHost: '10.8.0.1' }), null);
  });

  test('wg GUI: WG ACL + self-signed cert directives + WebSocket upgrade', () => {
    const conf = buildNginxGuiServer({ name: 'tribu', restPort: 27145, mode: 'wg', wgHost: '10.8.0.1', guiDomain: 'tribu.kiviri.fr' });
    assert.match(conf, /server_name tribu\.kiviri\.fr;/);
    assert.match(conf, /proxy_set_header Upgrade \$http_upgrade;/);
    assert.match(conf, /proxy_set_header Connection "upgrade";/);
    assert.match(conf, /proxy_pass https:\/\/\$upstream_tribu_gui:3001;/);
    assert.match(conf, /proxy_ssl_verify off;/);
    assert.match(conf, new RegExp(`allow ${WG_RANGE.replace(/[.\/]/g, '\\$&')};`));
    assert.match(conf, /deny all;/);
    // review+ P1: real cert directives even for non-public (so nginx -t passes)
    assert.match(conf, /ssl_certificate\s+\/etc\/nginx\/ssl\/tribu\.crt;/);
    assert.match(conf, /ssl_certificate_key\s+\/etc\/nginx\/ssl\/tribu\.key;/);
  });

  test('lan GUI: LAN ACL present (review+ P2 — not accidentally public)', () => {
    const conf = buildNginxGuiServer({ name: 'notes', restPort: 27150, mode: 'lan', lanHost: '192.168.0.10', guiDomain: 'notes.kiviri.fr' });
    assert.match(conf, new RegExp(`allow ${LAN_RANGE.replace(/[.\/]/g, '\\$&')};`));
    assert.match(conf, /deny all;/);
    assert.match(conf, /ssl_certificate\s+\/etc\/nginx\/ssl\/notes\.crt;/);
  });

  test('public GUI: Let\'s Encrypt cert, no IP ACL', () => {
    const conf = buildNginxGuiServer({ name: 'coursera', restPort: 27161, mode: 'public', apiDomain: 'coursera.kiviri.fr', guiDomain: 'coursera-gui.kiviri.fr' });
    assert.match(conf, /letsencrypt\/live\/coursera-gui\.kiviri\.fr\/fullchain\.pem/);
    assert.doesNotMatch(conf, /deny all;/);
  });
});

// ---------------------------------------------------------------------------
// buildDeploymentPlan — one-shot, notes, secret-safety
// ---------------------------------------------------------------------------
describe('buildDeploymentPlan', () => {
  test('wg with no guiDomain: nginxApi AND nginxGui both null (REST-only direct)', () => {
    const plan = buildDeploymentPlan({ name: 'tribu', restPort: 27145, mode: 'wg', wgHost: '10.8.0.10' });
    assert.equal(plan.name, 'tribu');
    assert.equal(plan.mode, 'wg');
    assert.equal(plan.baseUrl, 'http://10.8.0.10:27145');
    assert.ok(plan.composeYaml.includes('obsidian-tribu'));
    assert.equal(plan.nginxApi, null, 'wg REST is direct → no nginx API block');
    assert.equal(plan.nginxGui, null, 'no guiDomain → no GUI block');
    assert.ok(plan.vaultEnv.line.startsWith('VAULT_TRIBU='));
    assert.ok(plan.notes.some((n) => /PLACEHOLDER/.test(n)));
  });

  test('public: nginxApi present (REST proxied)', () => {
    const plan = buildDeploymentPlan({ name: 'coursera', restPort: 27161, mode: 'public', apiDomain: 'coursera.kiviri.fr' });
    assert.ok(plan.nginxApi && plan.nginxApi.includes('proxy_pass'));
  });

  test('wg with guiDomain: nginxGui present, nginxApi still null', () => {
    const plan = buildDeploymentPlan({ name: 'tribu', restPort: 27145, mode: 'wg', wgHost: '10.8.0.10', guiDomain: 'tribu.kiviri.fr' });
    assert.equal(plan.nginxApi, null);
    assert.ok(plan.nginxGui && plan.nginxGui.includes('server_name tribu.kiviri.fr'));
  });

  test('SECRET-SAFETY: a real apiKey never leaks into notes/compose/nginx', () => {
    const plan = buildDeploymentPlan({ name: 'coursera', restPort: 27161, mode: 'public', apiDomain: 'coursera.kiviri.fr', apiKey: 'SUPERSECRET', guiDomain: 'g.kiviri.fr' });
    assert.ok(!plan.notes.join('\n').includes('SUPERSECRET'), 'apiKey must not appear in notes');
    assert.ok(!plan.composeYaml.includes('SUPERSECRET'), 'apiKey must not appear in compose');
    assert.ok(!plan.nginxApi.includes('SUPERSECRET'), 'apiKey must not appear in nginx api');
    assert.ok(!plan.nginxGui.includes('SUPERSECRET'), 'apiKey must not appear in nginx gui');
    assert.ok(plan.vaultEnv.line.includes('SUPERSECRET'), 'apiKey belongs in the VAULT_* line');
  });
});

// ---------------------------------------------------------------------------
// renderPlanText — CLI text rendering (review+ P2: no literal `null` block)
// ---------------------------------------------------------------------------
describe('renderPlanText', () => {
  test('wg (no REST block) → NEVER prints a literal "null" under the REST heading', () => {
    const plan = buildDeploymentPlan({ name: 'tribu', restPort: 27145, mode: 'wg', wgHost: '10.8.0.10' });
    const text = renderPlanText(plan);
    assert.doesNotMatch(text, /reverse proxy\s*\n+null/, 'must not emit a bare null block');
    assert.match(text, /none for wg mode/, 'must explain why there is no REST block');
    assert.match(text, /## docker-compose service/);
    assert.match(text, /VAULT_TRIBU=/);
  });

  test('lan (no REST block) → explanatory note, no null', () => {
    const text = renderPlanText(buildDeploymentPlan({ name: 'notes', restPort: 27150, mode: 'lan', lanHost: '192.168.0.10' }));
    assert.doesNotMatch(text, /\bnull\b/);
    assert.match(text, /none for lan mode/);
  });

  test('public → real REST block is rendered (not the "none" note)', () => {
    const text = renderPlanText(buildDeploymentPlan({ name: 'coursera', restPort: 27161, mode: 'public', apiDomain: 'coursera.kiviri.fr' }));
    assert.match(text, /## nginx — REST API reverse proxy\n\nserver \{/);
    assert.doesNotMatch(text, /none for public mode/);
  });

  test('GUI block omitted cleanly when no guiDomain', () => {
    const text = renderPlanText(buildDeploymentPlan({ name: 'tribu', restPort: 27145, mode: 'wg', wgHost: '10.8.0.10' }));
    assert.doesNotMatch(text, /Selkies GUI/);
  });
});

// ---------------------------------------------------------------------------
// parseArgv (CLI) — review+ B1: --no-harden
// ---------------------------------------------------------------------------
describe('parseArgv (CLI) — review+ B1: --no-harden', () => {
  test('--no-harden yields harden:false (was silently dropped as noHarden)', () => {
    const args = parseArgv(['--name', 'tribu', '--rest-port', '27145', '--mode', 'wg', '--no-harden']);
    assert.equal(args.harden, false);
    assert.equal(args.noHarden, undefined, 'must NOT leak a stray noHarden key');
  });

  test('--no-harden end-to-end: the compose has no DISABLE_TERMINAL', () => {
    const args = parseArgv(['--name', 'tribu', '--rest-port', '27145', '--mode', 'wg', '--wg-host', '10.8.0.1', '--no-harden']);
    const { service } = buildComposeService(args);
    assert.ok(!service.environment.some((e) => e.startsWith('DISABLE_TERMINAL')), 'CLI --no-harden must omit DISABLE_TERMINAL end-to-end');
  });

  test('without --no-harden, hardening is ON by default', () => {
    const args = parseArgv(['--name', 'tribu', '--rest-port', '27145', '--mode', 'wg', '--wg-host', '10.8.0.1']);
    const { service } = buildComposeService(args);
    assert.ok(service.environment.includes('DISABLE_TERMINAL=true'));
  });

  test('value flags + bare boolean flags parse correctly', () => {
    const args = parseArgv(['--name', 'x', '--rest-port', '27145', '--sensitive', '--mode', 'wg']);
    assert.equal(args.name, 'x');
    assert.equal(args.restPort, '27145');
    assert.equal(args.sensitive, true);
    assert.equal(args.mode, 'wg');
  });
});
