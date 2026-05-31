/**
 * Tests for scripts/gen-obsidian-deploy.mjs (v0.21.0, vault-hosting Phase 1).
 *
 * The headline guarantee: the `VAULT_*` line the generator emits ROUND-TRIPS
 * through the router's real `parseEnvVaults` (registry.mjs) — so the deploy
 * generator can never drift from what the router actually accepts.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeDeployOpts,
  computeBaseUrl,
  buildVaultEnvLine,
  buildComposeService,
  renderComposeYaml,
  buildNginxApiServer,
  buildNginxGuiServer,
  buildDeploymentPlan,
  envKeyForName,
  WG_RANGE,
  _internals,
} from '../scripts/gen-obsidian-deploy.mjs';
import { _internals as registryInternals } from '../src/registry.mjs';

const { parseEnvVaults } = registryInternals;

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
    assert.equal(o.guiPort, 3001);
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
      () =>
        normalizeDeployOpts({
          name: 'smile',
          restPort: 27129,
          mode: 'public',
          apiDomain: 'smile.kiviri.fr',
          sensitive: true,
        }),
      /refusing to generate.*sensitive/s,
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
});

// ---------------------------------------------------------------------------
// computeBaseUrl — per mode
// ---------------------------------------------------------------------------
describe('computeBaseUrl', () => {
  test('wg → http://10.8.0.x:port', () => {
    assert.equal(computeBaseUrl({ name: 'tribu', restPort: 27145, mode: 'wg', wgHost: '10.8.0.10' }), 'http://10.8.0.10:27145');
  });
  test('lan → http://192.168.x:port', () => {
    assert.equal(computeBaseUrl({ name: 'x', restPort: 27145, mode: 'lan', lanHost: '192.168.0.10' }), 'http://192.168.0.10:27145');
  });
  test('public → https://domain (no port)', () => {
    assert.equal(computeBaseUrl({ name: 'x', restPort: 27145, mode: 'public', apiDomain: 'x.kiviri.fr' }), 'https://x.kiviri.fr');
  });
});

// ---------------------------------------------------------------------------
// buildVaultEnvLine + ROUND-TRIP through the real parseEnvVaults
// ---------------------------------------------------------------------------
describe('buildVaultEnvLine — round-trips through registry.parseEnvVaults', () => {
  test('wg vault: descriptor parsed back identically by the router', () => {
    const { key, value, descriptor } = buildVaultEnvLine({
      name: 'tribu',
      restPort: 27145,
      mode: 'wg',
      wgHost: '10.8.0.10',
      apiKey: 'REALTOKEN123',
      description: 'famille',
      timeoutMs: 15000,
    });
    assert.equal(key, 'VAULT_TRIBU');
    // Feed EXACTLY the emitted env into the router's parser.
    const { envVaults, warnings } = parseEnvVaults({ [key]: value });
    assert.equal(envVaults.length, 1, 'router must accept the generated line');
    const v = envVaults[0];
    assert.equal(v.name, 'tribu');
    assert.equal(v.baseUrl, 'http://10.8.0.10:27145');
    assert.equal(v.apiKey, 'REALTOKEN123');
    assert.equal(v.wireguard, true);
    assert.equal(v.timeoutMs, 15000);
    assert.equal(v.type, 'remote');
    // No WG sanity warning: host IS in 10.8.0.x
    assert.equal(warnings.length, 0, 'wg host in range → no warning');
    assert.equal(descriptor.name, 'tribu');
  });

  test('public vault: parsed back, wireguard:false, https baseUrl', () => {
    const { key, value } = buildVaultEnvLine({
      name: 'coursera',
      restPort: 27161,
      mode: 'public',
      apiDomain: 'coursera.kiviri.fr',
      apiKey: 'K',
    });
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

  test('the placeholder token still round-trips (structure valid even before secret is filled)', () => {
    const { key, value } = buildVaultEnvLine({ name: 'tribu', restPort: 27145, mode: 'wg', wgHost: '10.8.0.1' });
    const { envVaults } = parseEnvVaults({ [key]: value });
    assert.equal(envVaults.length, 1);
    assert.equal(envVaults[0].apiKey, '<token>');
  });
});

// ---------------------------------------------------------------------------
// buildComposeService / renderComposeYaml
// ---------------------------------------------------------------------------
describe('buildComposeService', () => {
  const base = { name: 'tribu', restPort: 27145, mode: 'wg', wgHost: '10.8.0.1' };

  test('service shape: image, shm, loopback-bound ports, /config volume', () => {
    const { serviceName, service } = buildComposeService(base);
    assert.equal(serviceName, 'obsidian-tribu');
    assert.equal(service.image, 'lscr.io/linuxserver/obsidian:latest');
    assert.equal(service.shm_size, '1gb');
    assert.deepEqual(service.volumes, ['/srv/vaults/tribu:/config']);
    // Ports MUST bind to 127.0.0.1 (only nginx on the same host reaches them).
    assert.ok(service.ports.every((p) => p.startsWith('127.0.0.1:')), 'ports must be loopback-bound');
    assert.ok(service.ports.includes('127.0.0.1:27145:27145'));
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
    // The TITLE has a space + em dash → must be quoted
    assert.match(yaml, /"TITLE=Obsidian — tribu"/);
    // Loopback port mapping present
    assert.match(yaml, /127\.0\.0\.1:27145:27145/);
  });
});

// ---------------------------------------------------------------------------
// buildNginxApiServer — per mode
// ---------------------------------------------------------------------------
describe('buildNginxApiServer', () => {
  test('wg mode → WG Access List + resolver-variable proxy_pass', () => {
    const conf = buildNginxApiServer({ name: 'tribu', restPort: 27145, mode: 'wg', wgHost: '10.8.0.1' });
    assert.match(conf, new RegExp(`allow ${WG_RANGE.replace(/[.\/]/g, '\\$&')};`));
    assert.match(conf, /deny all;/);
    // self-heal pattern: a variable upstream + resolver
    assert.match(conf, /resolver 127\.0\.0\.11 valid=10s;/);
    assert.match(conf, /set \$upstream_tribu_api obsidian-tribu;/);
    assert.match(conf, /proxy_pass http:\/\/\$upstream_tribu_api:27145;/);
    // exactly one X-Forwarded-For
    assert.equal((conf.match(/X-Forwarded-For/g) || []).length, 1);
  });

  test('public mode → no IP restriction, Let\'s Encrypt cert paths', () => {
    const conf = buildNginxApiServer({ name: 'coursera', restPort: 27161, mode: 'public', apiDomain: 'coursera.kiviri.fr' });
    assert.doesNotMatch(conf, /deny all;/);
    assert.match(conf, /letsencrypt\/live\/coursera\.kiviri\.fr\/fullchain\.pem/);
    assert.match(conf, /server_name coursera\.kiviri\.fr;/);
  });

  test('lan mode → LAN allow + loopback', () => {
    const conf = buildNginxApiServer({ name: 'notes', restPort: 27150, mode: 'lan', lanHost: '192.168.0.10' });
    assert.match(conf, /allow 192\.168\.0\.0\/16;/);
    assert.match(conf, /allow 127\.0\.0\.1;/);
    assert.match(conf, /deny all;/);
  });
});

// ---------------------------------------------------------------------------
// buildNginxGuiServer
// ---------------------------------------------------------------------------
describe('buildNginxGuiServer', () => {
  test('null when no guiDomain', () => {
    assert.equal(buildNginxGuiServer({ name: 'tribu', restPort: 27145, mode: 'wg', wgHost: '10.8.0.1' }), null);
  });

  test('with guiDomain → WebSocket upgrade headers + https upstream', () => {
    const conf = buildNginxGuiServer({
      name: 'tribu',
      restPort: 27145,
      mode: 'wg',
      wgHost: '10.8.0.1',
      guiDomain: 'tribu.kiviri.fr',
    });
    assert.match(conf, /server_name tribu\.kiviri\.fr;/);
    assert.match(conf, /proxy_set_header Upgrade \$http_upgrade;/);
    assert.match(conf, /proxy_set_header Connection "upgrade";/);
    assert.match(conf, /proxy_pass https:\/\/\$upstream_tribu_gui:3001;/);
    assert.match(conf, /proxy_ssl_verify off;/);
    // wg gui still WG-restricted
    assert.match(conf, /allow 10\.8\.0\.0\/24;/);
  });
});

// ---------------------------------------------------------------------------
// buildDeploymentPlan — one-shot, notes, secret-safety
// ---------------------------------------------------------------------------
describe('buildDeploymentPlan', () => {
  test('assembles all artifacts + placeholder warnings in notes', () => {
    const plan = buildDeploymentPlan({ name: 'tribu', restPort: 27145, mode: 'wg', wgHost: '10.8.0.10' });
    assert.equal(plan.name, 'tribu');
    assert.equal(plan.mode, 'wg');
    assert.equal(plan.baseUrl, 'http://10.8.0.10:27145');
    assert.ok(plan.composeYaml.includes('obsidian-tribu'));
    assert.ok(plan.nginxApi.includes('proxy_pass'));
    assert.equal(plan.nginxGui, null); // no guiDomain
    assert.ok(plan.vaultEnv.line.startsWith('VAULT_TRIBU='));
    // notes must warn that the apiKey + password are placeholders
    assert.ok(plan.notes.some((n) => /PLACEHOLDER/.test(n)));
  });

  test('SECRET-SAFETY: a real apiKey is never duplicated into notes/compose plaintext logs', () => {
    const plan = buildDeploymentPlan({ name: 'tribu', restPort: 27145, mode: 'wg', wgHost: '10.8.0.10', apiKey: 'SUPERSECRET' });
    // The token legitimately appears ONCE in the vaultEnv line (that's its purpose),
    // but must NOT leak into the notes array.
    assert.ok(!plan.notes.join('\n').includes('SUPERSECRET'), 'apiKey must not appear in notes');
  });
});
