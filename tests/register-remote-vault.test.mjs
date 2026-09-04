/**
 * v0.90.0 — `register_remote_vault`. Decision ergonomie-creation-liaison-
 * vaults §2: register an already-open remote vault from the conversation
 * without a hand edit of config.json.
 *
 * Every test drives the tool through injected read/write seams. Nothing here
 * touches a real config file.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { registerRemoteVaultTool } from '../src/tools/register-remote-vault.mjs';

const CONFIG_PATH = path.join('/cfg', 'config.json');

function seams({ config = { portRegistry: {}, remoteVaults: [] } } = {}) {
  const written = [];
  return {
    written,
    seam: {
      readFile: () => JSON.stringify(config),
      writeFile: (p, c) => written.push({ path: p, config: JSON.parse(c) }),
    },
  };
}

const registry = { configPath: CONFIG_PATH };

describe('register_remote_vault', () => {
  test('registers a new entry, written ONLY to config.json (never a workspace .env)', async () => {
    const { written, seam } = seams();
    const out = await registerRemoteVaultTool(
      registry,
      { name: 'qnap', baseUrl: 'https://10.8.0.5:27125', apiKey: 'SECRET' },
      seam,
    );
    assert.equal(out.registered, true);
    assert.equal(out.name, 'qnap');
    assert.equal(written.length, 1, 'exactly one write, to config.json — nothing else touched');
    assert.equal(written[0].path, CONFIG_PATH);
    assert.deepEqual(written[0].config.remoteVaults, [
      { name: 'qnap', baseUrl: 'https://10.8.0.5:27125', apiKey: 'SECRET', tlsInsecure: false },
    ]);
  });

  test('tlsInsecure defaults to false (verify), and is honored when passed true', async () => {
    const { written, seam } = seams();
    await registerRemoteVaultTool(
      registry,
      { name: 'qnap', baseUrl: 'https://10.8.0.5:27125', apiKey: 'SECRET', tlsInsecure: true },
      seam,
    );
    assert.equal(written[0].config.remoteVaults[0].tlsInsecure, true);
  });

  test('a trailing slash on baseUrl is stripped, matching how registry.mjs stores it', async () => {
    const { written, seam } = seams();
    await registerRemoteVaultTool(
      registry,
      { name: 'qnap', baseUrl: 'https://10.8.0.5:27125/', apiKey: 'SECRET' },
      seam,
    );
    assert.equal(written[0].config.remoteVaults[0].baseUrl, 'https://10.8.0.5:27125');
  });

  test('optional fields (description, insecurePort, timeoutMs) pass through when given', async () => {
    const { written, seam } = seams();
    await registerRemoteVaultTool(
      registry,
      {
        name: 'qnap', baseUrl: 'https://10.8.0.5:27125', apiKey: 'SECRET',
        description: 'NAS vault', insecurePort: 27135, timeoutMs: 15000,
      },
      seam,
    );
    const entry = written[0].config.remoteVaults[0];
    assert.equal(entry.description, 'NAS vault');
    assert.equal(entry.insecurePort, 27135);
    assert.equal(entry.timeoutMs, 15000);
  });

  test('requires `name`', async () => {
    const { seam } = seams();
    await assert.rejects(
      () => registerRemoteVaultTool(registry, { baseUrl: 'https://h:1', apiKey: 'k' }, seam),
      /requires `name`/,
    );
  });

  test('requires an absolute http(s) `baseUrl` — rejects a malformed or non-http URL', async () => {
    const { seam } = seams();
    await assert.rejects(
      () => registerRemoteVaultTool(registry, { name: 'x', baseUrl: 'not-a-url', apiKey: 'k' }, seam),
      /requires `baseUrl`/,
    );
    await assert.rejects(
      () => registerRemoteVaultTool(registry, { name: 'x', baseUrl: 'ftp://h/', apiKey: 'k' }, seam),
      /requires `baseUrl`/,
    );
  });

  // Regression (found by codex review): rest-client.mjs builds every request
  // as plain string concatenation (`${baseUrl}${urlPath}`), never URL
  // resolution — a query string or fragment on baseUrl swallows the real
  // endpoint path, breaking every request this vault would ever receive.
  test('rejects a baseUrl carrying a query string', async () => {
    const { written, seam } = seams();
    await assert.rejects(
      () => registerRemoteVaultTool(registry, { name: 'x', baseUrl: 'https://vault.example.com/?debug=1', apiKey: 'k' }, seam),
      /requires `baseUrl`/,
    );
    assert.equal(written.length, 0);
  });

  test('rejects a baseUrl carrying a fragment', async () => {
    const { written, seam } = seams();
    await assert.rejects(
      () => registerRemoteVaultTool(registry, { name: 'x', baseUrl: 'https://vault.example.com/#section', apiKey: 'k' }, seam),
      /requires `baseUrl`/,
    );
    assert.equal(written.length, 0);
  });

  test('requires `apiKey`', async () => {
    const { seam } = seams();
    await assert.rejects(
      () => registerRemoteVaultTool(registry, { name: 'x', baseUrl: 'https://h:1' }, seam),
      /requires `apiKey`/,
    );
  });

  test('insecurePort must be an integer in 1..65535', async () => {
    const { seam } = seams();
    await assert.rejects(
      () => registerRemoteVaultTool(
        registry, { name: 'x', baseUrl: 'https://h:1', apiKey: 'k', insecurePort: 0 }, seam,
      ),
      /insecurePort/,
    );
    await assert.rejects(
      () => registerRemoteVaultTool(
        registry, { name: 'x', baseUrl: 'https://h:1', apiKey: 'k', insecurePort: 70000 }, seam,
      ),
      /insecurePort/,
    );
  });

  test('insecurePort cannot equal baseUrl\'s own port — one of the two would be wrong', async () => {
    const { seam } = seams();
    await assert.rejects(
      () => registerRemoteVaultTool(
        registry, { name: 'x', baseUrl: 'https://h:27125', apiKey: 'k', insecurePort: 27125 }, seam,
      ),
      /same port/,
    );
  });

  test('refuses a `name` that already names a REMOTE vault, config re-read inside the lock', async () => {
    const { written, seam } = seams({
      config: { portRegistry: {}, remoteVaults: [{ name: 'qnap', baseUrl: 'https://old', apiKey: 'old' }] },
    });
    await assert.rejects(
      () => registerRemoteVaultTool(registry, { name: 'qnap', baseUrl: 'https://new:1', apiKey: 'k' }, seam),
      /already a registered vault name/,
    );
    assert.equal(written.length, 0, 'no write on refusal');
  });

  test('refuses a `name` that already names a LOCAL vault', async () => {
    const { written, seam } = seams({
      config: { portRegistry: { 'C:\\VAULTS\\Notes': 27124 }, vaultNames: {}, remoteVaults: [] },
    });
    await assert.rejects(
      () => registerRemoteVaultTool(registry, { name: 'notes', baseUrl: 'https://new:1', apiKey: 'k' }, seam),
      /already a registered vault name/,
    );
    assert.equal(written.length, 0);
  });

  test('refuses a `name` that collides with a LIVE registry vault invisible to config.json (e.g. VAULT_*)', async () => {
    // VAULT_* env-var vaults never appear in config.json at all (registry.mjs:
    // they are a 3rd config source, merged from process.env) — only the LIVE
    // registry knows about them. Re-reading the file inside the lock cannot
    // catch this collision; the check against registry.vaults must.
    const { written, seam } = seams();
    const liveRegistry = {
      configPath: CONFIG_PATH,
      vaults: [{ name: 'from-env-var', type: 'remote' }],
    };
    await assert.rejects(
      () => registerRemoteVaultTool(liveRegistry, { name: 'from-env-var', baseUrl: 'https://h:1', apiKey: 'k' }, seam),
      /already a registered vault name/,
    );
    assert.equal(written.length, 0, 'no write on refusal');
  });

  test('an existing remoteVaults entry survives being added to (never clobbered)', async () => {
    const { written, seam } = seams({
      config: { portRegistry: {}, remoteVaults: [{ name: 'existing', baseUrl: 'https://e:1', apiKey: 'e' }] },
    });
    await registerRemoteVaultTool(registry, { name: 'new', baseUrl: 'https://n:1', apiKey: 'n' }, seam);
    const names = written[0].config.remoteVaults.map((r) => r.name);
    assert.deepEqual(names, ['existing', 'new']);
  });

  test('no config path on the registry → clear refusal, no write attempted', async () => {
    const { written, seam } = seams();
    await assert.rejects(
      () => registerRemoteVaultTool({ configPath: null }, { name: 'x', baseUrl: 'https://h:1', apiKey: 'k' }, seam),
      /no config path/,
    );
    assert.equal(written.length, 0);
  });

  // Regression (found in review): a collision that differs only in CASE must
  // still be refused, matching vault-slug.mjs's resolveVaultBySlug convention
  // (case-insensitive — used by --attach and confirm_workspace_binding).
  // registry.mjs's own resolveVault() is exact-match, but that is a DIFFERENT
  // question (can a caller name this vault later) from the one this collision
  // check answers (would this name be ambiguous elsewhere in the router).
  test('refuses a `name` that collides case-insensitively with an existing LOCAL vault', async () => {
    const { written, seam } = seams({
      config: { portRegistry: { 'C:\\VAULTS\\Notes': 27124 }, vaultNames: {}, remoteVaults: [] },
    });
    await assert.rejects(
      () => registerRemoteVaultTool(registry, { name: 'Notes', baseUrl: 'https://new:1', apiKey: 'k' }, seam),
      /already a registered vault name/,
    );
    assert.equal(written.length, 0);
  });

  test('refuses a `name` that collides case-insensitively with an existing REMOTE vault', async () => {
    const { written, seam } = seams({
      config: { portRegistry: {}, remoteVaults: [{ name: 'Existing', baseUrl: 'https://e:1', apiKey: 'e' }] },
    });
    await assert.rejects(
      () => registerRemoteVaultTool(registry, { name: 'existing', baseUrl: 'https://new:1', apiKey: 'k' }, seam),
      /already a registered vault name/,
    );
    assert.equal(written.length, 0);
  });

  test('refuses a `name` that collides case-insensitively on the LIVE registry', async () => {
    const { seam } = seams();
    const liveRegistry = { configPath: CONFIG_PATH, vaults: [{ name: 'From-Env-Var', type: 'remote' }] };
    await assert.rejects(
      () => registerRemoteVaultTool(liveRegistry, { name: 'from-env-var', baseUrl: 'https://h:1', apiKey: 'k' }, seam),
      /already a registered vault name/,
    );
  });

  test('the stored `name` keeps the caller\'s original casing (only the comparison is case-insensitive)', async () => {
    const { written, seam } = seams();
    await registerRemoteVaultTool(registry, { name: 'QNAP', baseUrl: 'https://h:1', apiKey: 'k' }, seam);
    assert.equal(written[0].config.remoteVaults[0].name, 'QNAP');
  });

  // Regression (found in review): URL.port is '' for a URL with no explicit
  // port, and Number('') === 0 — never a valid insecurePort — so the "same
  // port twice" guard used to never fire for a default-port baseUrl.
  test("insecurePort matching baseUrl's IMPLICIT default port (443) is refused", async () => {
    const { seam } = seams();
    await assert.rejects(
      () => registerRemoteVaultTool(
        registry, { name: 'x', baseUrl: 'https://vault.example.com', apiKey: 'k', insecurePort: 443 }, seam,
      ),
      /same port/,
    );
  });

  test('insecurePort NOT matching the implicit default port is accepted', async () => {
    const { written, seam } = seams();
    await registerRemoteVaultTool(
      registry, { name: 'x', baseUrl: 'https://vault.example.com', apiKey: 'k', insecurePort: 8080 }, seam,
    );
    assert.equal(written[0].config.remoteVaults[0].insecurePort, 8080);
  });

  describe('OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK', () => {
    let prevEnforce, prevLegacy;
    const restore = () => {
      if (prevEnforce === undefined) delete process.env.OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK;
      else process.env.OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK = prevEnforce;
      if (prevLegacy === undefined) delete process.env.OBSIDIAN_ROUTER_REQUIRE_WIREGUARD;
      else process.env.OBSIDIAN_ROUTER_REQUIRE_WIREGUARD = prevLegacy;
    };

    // Regression (found in review): register_remote_vault used to accept ANY
    // http(s) baseUrl regardless of this deployment-wide flag, returning a
    // confident "registered" response for an entry that would then make
    // loadRegistry refuse to reload — a silently-broken success, discoverable
    // only from the server's own stderr.
    test('refuses a non-loopback, non-WG baseUrl when the flag is enabled — BEFORE writing', async () => {
      prevEnforce = process.env.OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK;
      prevLegacy = process.env.OBSIDIAN_ROUTER_REQUIRE_WIREGUARD;
      process.env.OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK = 'true';
      try {
        const { written, seam } = seams();
        await assert.rejects(
          () => registerRemoteVaultTool(
            registry, { name: 'x', baseUrl: 'https://vault.example.com', apiKey: 'k' }, seam,
          ),
          /ENFORCE_WG_OR_LOOPBACK/,
        );
        assert.equal(written.length, 0, 'refused before any write');
      } finally { restore(); }
    });

    test('a loopback baseUrl is accepted when the flag is enabled', async () => {
      prevEnforce = process.env.OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK;
      prevLegacy = process.env.OBSIDIAN_ROUTER_REQUIRE_WIREGUARD;
      process.env.OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK = 'true';
      try {
        const { written, seam } = seams();
        await registerRemoteVaultTool(registry, { name: 'x', baseUrl: 'https://127.0.0.1:27125', apiKey: 'k' }, seam);
        assert.equal(written.length, 1);
      } finally { restore(); }
    });

    test('a 10.8.0.0/24 WireGuard-mesh baseUrl is accepted when the flag is enabled', async () => {
      prevEnforce = process.env.OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK;
      prevLegacy = process.env.OBSIDIAN_ROUTER_REQUIRE_WIREGUARD;
      process.env.OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK = 'true';
      try {
        const { written, seam } = seams();
        await registerRemoteVaultTool(registry, { name: 'x', baseUrl: 'https://10.8.0.5:27125', apiKey: 'k' }, seam);
        assert.equal(written.length, 1);
      } finally { restore(); }
    });

    test('a public baseUrl is accepted when the flag is NOT set (default)', async () => {
      const { written, seam } = seams();
      await registerRemoteVaultTool(registry, { name: 'x', baseUrl: 'https://vault.example.com', apiKey: 'k' }, seam);
      assert.equal(written.length, 1);
    });
  });
});
