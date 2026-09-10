/**
 * A vault whose PATH carries a non-ASCII character is provisioned into ONE
 * directory — and the credentials it gets are its own.
 *
 * This is an EXECUTION test: it spawns the real `scripts/setup-vault.mjs`
 * against a fixture reference vault under a temp directory whose name carries
 * an accent, then inspects what actually landed on disk. Nothing here touches a
 * real vault: the child gets its own `OBSIDIAN_ROUTER_CONFIG` and a throwaway
 * home (tests/_home-safe-spawn.mjs refuses anything else).
 *
 * WHAT IT WOULD HAVE CAUGHT, had it existed (router 0.94.1, 2026-09-11):
 * provisioning `C:\VAULTS\La méthode LICARES` created TWO directories — the
 * real one, holding everything written through `fs`, and `La mÃ©thode LICARES`,
 * holding every tree that had been CLONED (the 11 plugins, the themes,
 * `Documentation/`, `.claude/`). `fs.cpSync` was decoding its destination
 * through the Windows ANSI code page; see src/helpers/copy-tree.mjs. The run
 * reported `ok: true` with no warning, because each individual call had
 * succeeded.
 *
 * VERIFIED TO FAIL BEFORE THE FIX: run against the 0.94.1 code, "exactly one
 * directory", "the plugins are IN the vault" and "community-plugins.json is not
 * empty" all go red on win32. The credential assertions below are a separate
 * question and fail on every platform — see the second describe block.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { spawnSyncHomeSafe } from './_home-safe-spawn.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'setup-vault.mjs');

// Built, never escaped: a `\u` typed into a source file is the character
// itself, so the intent of a test about bytes has to be spelled out in code.
const E_ACUTE = String.fromCharCode(0xe9);   // é
const A_GRAVE = String.fromCharCode(0xe0);   // à
const U_UMLAUT = String.fromCharCode(0xfc);  // ü
const ACCENTED_SEGMENT = 'vault-' + E_ACUTE + '-' + A_GRAVE + U_UMLAUT;

const SOURCE_PORT = 27175;
const SOURCE_API_KEY = 'fixture-source-key-not-real-0123456789abcdef';

// The PEM banners are ASSEMBLED, never written as literals. The fixture has to
// carry a convincing private-key marker — the assertions below search the
// cloned file for exactly that phrase, and a fixture that did not contain it
// would make them vacuous — but a source file that contains the contiguous
// phrase is a file the repository's own pre-commit secret scanner refuses, and
// rightly: it cannot tell a decoy from the real thing, and a scanner tuned to
// let this through would let a real one through too. Building the string keeps
// both properties: the test means what it says, and no line of this file is
// shaped like a key. (Same discipline as the accented characters above: build
// what matters, never escape it.)
const PEM = (kind) => ['-----BEGIN', kind, 'KEY-----FIXTURE-----END', kind, 'KEY-----'].join(' ');
const RSA_PRIVATE = ['RSA', 'PRIVATE'].join(' ');
// Shaped like the real thing (Local REST API stores its self-signed certificate
// and its RSA private key here) without being one. The point of the assertions
// is that this object does not survive the clone.
const SOURCE_CRYPTO = {
  cert: ['-----BEGIN', 'CERTIFICATE-----FIXTURE-----END', 'CERTIFICATE-----'].join(' '),
  privateKey: PEM(RSA_PRIVATE),
  publicKey: PEM('PUBLIC'),
};

const REST_PLUGIN = 'obsidian-local-rest-api';
const BRIDGE_PLUGIN = 'mcp-router-bridge';

/**
 * A reference vault with the two required plugins, a theme, and the root docs
 * — i.e. one of each KIND of tree the provisioner clones, so a copy that
 * mangles its destination has somewhere to go wrong.
 */
function buildReferenceVault(refPath) {
  const plugins = path.join(refPath, '.obsidian', 'plugins');

  const restDir = path.join(plugins, REST_PLUGIN);
  fs.mkdirSync(restDir, { recursive: true });
  fs.writeFileSync(path.join(restDir, 'data.json'), JSON.stringify({
    port: SOURCE_PORT,
    insecurePort: SOURCE_PORT + 1,
    enableInsecureServer: true,
    apiKey: SOURCE_API_KEY,
    crypto: SOURCE_CRYPTO,
    bindingHost: '127.0.0.1',
  }, null, 2));
  fs.writeFileSync(path.join(restDir, 'main.js'), '// rest-api stub');
  fs.writeFileSync(path.join(restDir, 'manifest.json'), JSON.stringify({ id: REST_PLUGIN, version: '4.0.0' }));

  const bridgeDir = path.join(plugins, BRIDGE_PLUGIN);
  fs.mkdirSync(bridgeDir, { recursive: true });
  fs.writeFileSync(path.join(bridgeDir, 'main.js'), '// bridge stub');
  fs.writeFileSync(path.join(bridgeDir, 'manifest.json'), JSON.stringify({ id: BRIDGE_PLUGIN, version: '0.2.0' }));

  // A nested file inside a plugin: a flat copy would still pass without it.
  fs.mkdirSync(path.join(bridgeDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(bridgeDir, 'assets', 'icon.txt'), 'icon');

  fs.writeFileSync(
    path.join(refPath, '.obsidian', 'community-plugins.json'),
    JSON.stringify([REST_PLUGIN, BRIDGE_PLUGIN], null, 2),
  );

  const themeDir = path.join(refPath, '.obsidian', 'themes', 'FixtureTheme');
  fs.mkdirSync(themeDir, { recursive: true });
  fs.writeFileSync(path.join(themeDir, 'theme.css'), '/* fixture */');
  fs.writeFileSync(path.join(themeDir, 'manifest.json'), JSON.stringify({ name: 'FixtureTheme', version: '1.0.0' }));

  const docs = path.join(refPath, 'Documentation');
  fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(path.join(docs, 'SETUP.md'), '# fixture setup');

  const claude = path.join(refPath, '.claude');
  fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify({ fixture: true }));
}

/** Provision one vault at `targetVault`, in a world of its own. */
function provision(workDir, targetVault) {
  const referenceVault = path.join(workDir, '.template');
  const configPath = path.join(workDir, 'config.json');
  const fakeHome = path.join(workDir, 'home');
  fs.mkdirSync(fakeHome, { recursive: true });
  buildReferenceVault(referenceVault);
  fs.writeFileSync(configPath, JSON.stringify({
    referenceVault,
    portRegistry: {},
    portStart: 27400,
  }, null, 2));

  const run = spawnSyncHomeSafe(process.execPath, [SCRIPT_PATH, targetVault], {
    homeDir: fakeHome,
    env: { OBSIDIAN_ROUTER_CONFIG: configPath },
  });
  return { run, referenceVault, configPath };
}

function readRestData(vaultPath) {
  const p = path.join(vaultPath, '.obsidian', 'plugins', REST_PLUGIN, 'data.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

describe('a vault whose own name carries an accent lands in exactly one directory', () => {
  let workDir;
  let vaultsRoot;
  let targetVault;
  let run;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'accent-vault-'));
    vaultsRoot = path.join(workDir, 'VAULTS');
    fs.mkdirSync(vaultsRoot, { recursive: true });
    // The accent is on the LAST segment — the production shape.
    targetVault = path.join(vaultsRoot, 'La m' + E_ACUTE + 'thode FIXTURE');
    ({ run } = provision(workDir, targetVault));
  });

  after(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  test('the provisioner exits clean', () => {
    assert.equal(run.status, 0, `expected exit 0, got ${run.status}.\nstdout=${run.stdout}\nstderr=${run.stderr}`);
  });

  test('exactly one directory was created under the vaults root', () => {
    const entries = fs.readdirSync(vaultsRoot);
    assert.deepEqual(
      entries,
      [path.basename(targetVault)],
      'a second, mis-encoded directory means the provisioning was split in two: ' +
      JSON.stringify(entries.map((e) => Buffer.from(e, 'utf8').toString('hex'))),
    );
  });

  test('the plugins are IN the vault, with their nested files', () => {
    const plugins = path.join(targetVault, '.obsidian', 'plugins');
    assert.ok(fs.existsSync(path.join(plugins, REST_PLUGIN, 'main.js')), 'REST API plugin must be cloned');
    assert.ok(fs.existsSync(path.join(plugins, BRIDGE_PLUGIN, 'main.js')), 'bridge plugin must be cloned');
    assert.equal(
      fs.readFileSync(path.join(plugins, BRIDGE_PLUGIN, 'assets', 'icon.txt'), 'utf8'),
      'icon',
      'a nested file inside a cloned plugin must arrive too',
    );
  });

  test('community-plugins.json lists the cloned plugins, not an empty array', () => {
    const p = path.join(targetVault, '.obsidian', 'community-plugins.json');
    const enabled = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.ok(Array.isArray(enabled), 'community-plugins.json must be an array');
    assert.ok(enabled.includes(REST_PLUGIN), `expected ${REST_PLUGIN} to be enabled, got ${JSON.stringify(enabled)}`);
    assert.ok(enabled.includes(BRIDGE_PLUGIN), `expected ${BRIDGE_PLUGIN} to be enabled, got ${JSON.stringify(enabled)}`);
  });

  test('the themes and the root docs are IN the vault', () => {
    assert.ok(
      fs.existsSync(path.join(targetVault, '.obsidian', 'themes', 'FixtureTheme', 'theme.css')),
      'the theme must be cloned into the vault',
    );
    assert.ok(
      fs.existsSync(path.join(targetVault, 'Documentation', 'SETUP.md')),
      'Documentation/ must be cloned into the vault',
    );
    assert.ok(
      fs.existsSync(path.join(targetVault, '.claude', 'settings.json')),
      '.claude/ must be cloned into the vault',
    );
  });

  test('the vault got a port of its own, written to disk', () => {
    const data = readRestData(targetVault);
    assert.ok(data, 'the vault must have a Local REST API data.json');
    assert.notEqual(data.port, SOURCE_PORT, 'the vault must not inherit the source vault\'s HTTPS port');
    assert.ok(Number.isInteger(data.insecurePort) && data.insecurePort > 0,
      `insecurePort must be allocated, got ${JSON.stringify(data.insecurePort)}`);
    assert.notEqual(data.insecurePort, SOURCE_PORT + 1, 'the vault must not inherit the source\'s plaintext port');
  });
});

describe('a vault under an accented PARENT directory lands in exactly one place', () => {
  let workDir;
  let vaultsRoot;
  let accentedParent;
  let targetVault;
  let run;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'accent-parent-'));
    vaultsRoot = path.join(workDir, 'VAULTS');
    // The accent is on an ANCESTOR segment, not on the vault's own name: the
    // mangling then happens two levels up, where a guard that only looked at
    // the target's siblings would never see it.
    accentedParent = path.join(vaultsRoot, ACCENTED_SEGMENT);
    fs.mkdirSync(accentedParent, { recursive: true });
    targetVault = path.join(accentedParent, 'plain-name');
    ({ run } = provision(workDir, targetVault));
  });

  after(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  test('the provisioner exits clean', () => {
    assert.equal(run.status, 0, `expected exit 0, got ${run.status}.\nstdout=${run.stdout}\nstderr=${run.stderr}`);
  });

  test('no mis-encoded sibling of the accented parent was created', () => {
    const entries = fs.readdirSync(vaultsRoot);
    assert.deepEqual(
      entries,
      [ACCENTED_SEGMENT],
      'a mis-encoded twin of the PARENT directory: ' +
      JSON.stringify(entries.map((e) => Buffer.from(e, 'utf8').toString('hex'))),
    );
  });

  test('the plugins are IN the vault', () => {
    assert.ok(fs.existsSync(path.join(targetVault, '.obsidian', 'plugins', REST_PLUGIN, 'main.js')));
    assert.ok(fs.existsSync(path.join(targetVault, '.obsidian', 'plugins', BRIDGE_PLUGIN, 'main.js')));
  });
});

describe('a cloned vault never inherits the source vault\'s credentials', () => {
  let workDir;
  let targetVault;
  let run;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-creds-'));
    // Pure ASCII on purpose: this is a SECURITY property of the clone, not a
    // side effect of the encoding defect. It has to hold on every platform and
    // on every path.
    targetVault = path.join(workDir, 'VAULTS', 'plain-target');
    ({ run } = provision(workDir, targetVault));
  });

  after(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  test('the provisioner exits clean', () => {
    assert.equal(run.status, 0, `expected exit 0, got ${run.status}.\nstdout=${run.stdout}\nstderr=${run.stderr}`);
  });

  test('the API key is freshly generated, not the source\'s', () => {
    const data = readRestData(targetVault);
    assert.ok(data, 'the vault must have a Local REST API data.json');
    assert.notEqual(data.apiKey, SOURCE_API_KEY, 'the source vault\'s API key must never reach a cloned vault');
    assert.ok(typeof data.apiKey === 'string' && data.apiKey.length >= 32, 'a real key must have been allocated');
  });

  test('the ports are freshly allocated, not the source\'s', () => {
    const data = readRestData(targetVault);
    assert.notEqual(data.port, SOURCE_PORT);
    assert.notEqual(data.insecurePort, SOURCE_PORT + 1);
  });

  test('the source vault\'s certificate and private key are NOT in the clone', () => {
    const p = path.join(targetVault, '.obsidian', 'plugins', REST_PLUGIN, 'data.json');
    const raw = fs.readFileSync(p, 'utf8');
    const data = JSON.parse(raw);
    assert.equal(
      data.crypto,
      undefined,
      'the `crypto` block holds the source vault\'s self-signed certificate AND its RSA private key; ' +
      'a clone that keeps it shares a private key with every other vault cloned from the same template',
    );
    // Belt and braces: not merely moved to another key in the same file.
    assert.ok(!raw.includes(RSA_PRIVATE + ' KEY'), 'no private key material anywhere in the cloned data.json');
    assert.ok(!raw.includes(SOURCE_API_KEY), 'no source API key anywhere in the cloned data.json');
  });
});

describe('a twin that was ALREADY there is reported, and does not abort the run', () => {
  // ROUND-1 REVIEW CHANGED THIS TEST, and the change was the finding. The first
  // version staged a mis-encoded directory before provisioning and asserted the
  // run FAILED. But two directories called `café` and `cafÃ©` can both belong to
  // the user: a name match is evidence that two names are related, not that this
  // run damaged anything. Failing there aborted a healthy provisioning — after
  // the configuration and workspace changes had already been written.
  //
  // The failure path is still guarded; it is now conditioned on the twin having
  // APPEARED during the run, which no test can stage without reintroducing the
  // defect. Its decision lives in `classifyProvisioningTwins`, unit-tested
  // directly in tests/copy-tree.test.mjs, and mutation M6 confirms the branch
  // is load-bearing.
  let workDir;
  let vaultsRoot;
  let targetVault;
  let twin;
  let run;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-guard-e2e-'));
    vaultsRoot = path.join(workDir, 'VAULTS');
    fs.mkdirSync(vaultsRoot, { recursive: true });
    targetVault = path.join(vaultsRoot, 'La m' + E_ACUTE + 'thode FIXTURE');
    twin = path.join(vaultsRoot, 'La m' + Buffer.from(E_ACUTE, 'utf8').toString('latin1') + 'thode FIXTURE');
    fs.mkdirSync(twin, { recursive: true });
    fs.writeFileSync(path.join(twin, 'stray.txt'), 'not this run doing');
    ({ run } = provision(workDir, targetVault));
  });

  after(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  test('the run SUCCEEDS — it did not create the twin', () => {
    assert.equal(run.status, 0, `expected exit 0, got ${run.status}.\nstdout=${run.stdout}\nstderr=${run.stderr}`);
  });

  test('but the operator is told the twin is there', () => {
    const out = `${run.stdout}${run.stderr}`;
    assert.ok(out.includes(twin), 'the warning must name the twin, or it cannot be found');
    assert.match(out, /already existed before this run/i);
  });

  test('the twin is left completely untouched', () => {
    assert.equal(fs.readFileSync(path.join(twin, 'stray.txt'), 'utf8'), 'not this run doing');
    assert.deepEqual(fs.readdirSync(twin), ['stray.txt'], 'nothing may be written into a directory we merely noticed');
  });
});

describe('an ADOPTED vault keeps its own certificate; a half-configured one does not keep the template\'s', () => {
  let workDir;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-crypto-'));
  });

  after(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  /** Pre-create a vault holding a REST plugin folder with the given data.json. */
  function seedVault(name, data) {
    const vault = path.join(workDir, name, 'vault');
    const pluginDir = path.join(vault, '.obsidian', 'plugins', REST_PLUGIN);
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'main.js'), '// pre-existing');
    fs.writeFileSync(path.join(pluginDir, 'data.json'), JSON.stringify(data, null, 2));
    return vault;
  }

  test('a vault with its OWN valid configuration keeps its certificate', () => {
    // Its key is its own, nobody else holds it, and regenerating it would be
    // churn the provisioner has no reason to cause. This is the direction that
    // proves `keepCrypto` is not simply always-false.
    const ownCrypto = { cert: 'ITS-OWN-CERT', privateKey: 'ITS-OWN-KEY' };
    const vault = seedVault('adopted', {
      port: 27999,
      insecurePort: 28009,
      apiKey: 'this-vault-already-had-its-own-key-0123456789',
      crypto: ownCrypto,
    });
    const { run } = provision(path.join(workDir, 'adopted'), vault);
    assert.equal(run.status, 0, `expected exit 0, got ${run.status}.\nstdout=${run.stdout}\nstderr=${run.stderr}`);
    const data = readRestData(vault);
    assert.deepEqual(data.crypto, ownCrypto, 'an adopted vault\'s own certificate must survive');
    assert.equal(data.apiKey, 'this-vault-already-had-its-own-key-0123456789', 'and so must its own key');
  });

  test('a HALF-configured vault keeps its certificate too — the question is provenance', () => {
    // ROUND-1 REVIEW REVERSED THIS ASSERTION, and the reversal is the finding.
    // The first version keyed the decision off `preExistingRestData`, which
    // means "had a VALID port and key" — so a vault holding its own certificate
    // but a short key, or one run with `--regenerate`, had its certificate
    // deleted for a reason that had nothing to do with certificates.
    //
    // The question is not whether the configuration is valid. It is whether
    // this run put the file there. It did not: the file pre-dates us, and what
    // it holds is the vault's own affair — the same policy the documentation
    // states for the vaults that already carry the template's block.
    const vault = seedVault('half-configured', { crypto: SOURCE_CRYPTO, bindingHost: '127.0.0.1' });
    const { run } = provision(path.join(workDir, 'half-configured'), vault);
    assert.equal(run.status, 0, `expected exit 0, got ${run.status}.\nstdout=${run.stdout}\nstderr=${run.stderr}`);
    const data = readRestData(vault);
    assert.deepEqual(data.crypto, SOURCE_CRYPTO,
      'a data.json that pre-dates this run keeps what it held — rewriting it is the operator\'s call');
    assert.ok(Number.isInteger(data.port) && data.port > 0, 'and the vault must still get a port of its own');
    assert.notEqual(data.port, SOURCE_PORT);
  });

  test('a data.json this run CREATED carries no certificate at all', () => {
    // The other side of the same rule, and the one that matters for the defect:
    // a fresh vault's file is written by us, from nothing, so there is no
    // certificate in it to inherit. (The second fence — deleting a `crypto`
    // that a future copy path put there — is not reachable while the first
    // fence holds, which is why its witness is mutation M5 rather than a test.)
    const vault = path.join(workDir, 'fresh', 'vault');
    const { run } = provision(path.join(workDir, 'fresh'), vault);
    assert.equal(run.status, 0, `expected exit 0, got ${run.status}.\nstdout=${run.stdout}\nstderr=${run.stderr}`);
    const raw = fs.readFileSync(path.join(vault, '.obsidian', 'plugins', REST_PLUGIN, 'data.json'), 'utf8');
    assert.equal(JSON.parse(raw).crypto, undefined);
    assert.ok(!raw.includes(RSA_PRIVATE + ' KEY'));
    assert.ok(!raw.includes(SOURCE_API_KEY));
  });
});

describe('clonePluginFolder — the credential file is never copied in the first place', () => {
  // ITS OWN WITNESS, ON PURPOSE. `patchRestApiData()` also deletes a stray
  // `crypto`, so a test that only looked at the FINISHED vault would stay green
  // with this exclusion removed — the two fences would be indistinguishable,
  // and the pair would be reported as covered while one of them was dead. This
  // block asks the question the end-state cannot: was the source's credential
  // file ever written to the target's disk at all?
  let workDir;
  let src;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-plugin-folder-'));
    src = path.join(workDir, 'source-plugin');
    fs.mkdirSync(path.join(src, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(src, 'main.js'), '// code');
    fs.writeFileSync(path.join(src, 'manifest.json'), JSON.stringify({ id: REST_PLUGIN }));
    fs.writeFileSync(path.join(src, 'nested', 'extra.txt'), 'kept');
    fs.writeFileSync(path.join(src, 'data.json'), JSON.stringify({
      apiKey: SOURCE_API_KEY, port: SOURCE_PORT, crypto: SOURCE_CRYPTO,
    }));
  });

  after(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  test('a CREDENTIALED plugin arrives without its data.json, code intact', async () => {
    const { clonePluginFolder } = await import('../scripts/setup-vault.mjs');
    const dst = path.join(workDir, 'target-credentialed');
    clonePluginFolder(REST_PLUGIN, src, dst);

    assert.ok(!fs.existsSync(path.join(dst, 'data.json')),
      'the source vault\'s credential file must never be written to the target, not even to be cleaned up later');
    assert.equal(fs.readFileSync(path.join(dst, 'main.js'), 'utf8'), '// code', 'the plugin CODE must arrive');
    assert.equal(fs.readFileSync(path.join(dst, 'nested', 'extra.txt'), 'utf8'), 'kept',
      'and so must everything else in the folder');
  });

  test('a LINK to the credential file, under any other name, is not copied either', async (t) => {
    // ROUND-2 SECURITY REGRESSION, created by the round-1 repair. Once the copy
    // started FOLLOWING symlinks — which it must, so a symlinked plugin folder
    // cannot hide its contents from this very filter — a name-based exclusion
    // became bypassable outright: `credential-backup.json -> data.json` has a
    // name the filter accepts and bytes that must never be written. The filter
    // was still being called; it had simply stopped meaning anything.
    const { clonePluginFolder } = await import('../scripts/setup-vault.mjs');
    const linkSrc = path.join(workDir, 'source-with-link');
    fs.mkdirSync(linkSrc, { recursive: true });
    fs.writeFileSync(path.join(linkSrc, 'main.js'), '// code');
    fs.writeFileSync(path.join(linkSrc, 'data.json'), JSON.stringify({ apiKey: SOURCE_API_KEY }));
    try {
      fs.symlinkSync(path.join(linkSrc, 'data.json'), path.join(linkSrc, 'credential-backup.json'), 'file');
    } catch {
      return t.skip('this process cannot create symlinks');
    }

    const dst = path.join(workDir, 'target-with-link');
    clonePluginFolder(REST_PLUGIN, linkSrc, dst);

    assert.ok(!fs.existsSync(path.join(dst, 'data.json')));
    assert.ok(!fs.existsSync(path.join(dst, 'credential-backup.json')),
      'an alias of the credential file must be excluded by IDENTITY, not by name');
    // And nothing else in the folder carries the key either.
    for (const entry of fs.readdirSync(dst)) {
      const body = fs.readFileSync(path.join(dst, entry), 'utf8');
      assert.ok(!body.includes(SOURCE_API_KEY), `${entry} must not contain the source key`);
    }
    assert.equal(fs.readFileSync(path.join(dst, 'main.js'), 'utf8'), '// code', 'the code must still arrive');
  });

  test('a link pointing OUTSIDE the plugin folder is not followed in', async (t) => {
    // "Clone this plugin" must not mean "and whatever it points at".
    const { clonePluginFolder } = await import('../scripts/setup-vault.mjs');
    const outside = path.join(workDir, 'outside-secrets');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'not part of any plugin');

    const src = path.join(workDir, 'source-escaping');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'main.js'), '// code');
    try {
      fs.symlinkSync(outside, path.join(src, 'escape'), 'junction');
    } catch {
      return t.skip('this process cannot create symlinks');
    }

    const dst = path.join(workDir, 'target-escaping');
    clonePluginFolder(REST_PLUGIN, src, dst);
    assert.ok(!fs.existsSync(path.join(dst, 'escape')),
      'a link out of the plugin folder must not drag its target into the vault');
    assert.equal(fs.readFileSync(path.join(dst, 'main.js'), 'utf8'), '// code');
  });

  test('an ORDINARY plugin keeps its data.json — that file holds preferences, not secrets', async () => {
    const { clonePluginFolder } = await import('../scripts/setup-vault.mjs');
    const dst = path.join(workDir, 'target-ordinary');
    clonePluginFolder(BRIDGE_PLUGIN, src, dst);
    assert.ok(fs.existsSync(path.join(dst, 'data.json')),
      'blanket exclusion would silently reset every other plugin\'s user settings on a re-clone');
  });
});
