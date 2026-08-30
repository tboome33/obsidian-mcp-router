/**
 * Tests du lot 1 — la config d'un routeur SANS disque de vault.
 *
 * Ce que ces tests protègent, dans l'ordre d'importance :
 *
 *   1. L'ALLER-RETOUR. Ce que le générateur émet doit être exactement ce que le
 *      routeur accepte. Sans cette assertion, le générateur peut dériver du
 *      contrat sans que rien ne le signale — le même piège que le catch-22 de
 *      la v0.76.0, où deux schémas voisins avaient divergé.
 *   2. LE SECRET NE FUIT PAS. Sortie rédigée par défaut, aucun message
 *      d'erreur ne cite une clé, refus d'écrire dans le dépôt ou dans un vault.
 *   3. LE COUPLAGE EST BIEN SUPPRIMÉ. `portRegistry` vide, sinon le routeur
 *      relirait le `data.json` du vault et le lot 1 n'aurait rien réglé.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  buildRemoteVaultEntry, buildRemoteConfig, buildEnvLines,
  redactConfig, redactEnvLines, envKeyForVault,
  hostPassesTransportGuard, looksLikeApiKey, API_KEY_PLACEHOLDER,
} from '../src/helpers/remote-config.mjs';
import { _internals, loadRegistry } from '../src/registry.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'gen-remote-config.mjs');
// Clés factices CONSTRUITES, jamais écrites en dur : un littéral hexadécimal de
// 32+ caractères est exactement ce que le scanner de fuites du dépôt arrête.
// Hexadécimal uniquement : `looksLikeApiKey` reconnaît la forme des vraies
// clés du plugin, et une fixture qui n'y ressemble pas ne teste pas la garde.
const fakeKey = (label) => `${label}`.toLowerCase().replace(/[^a-f0-9]/g, '0').padEnd(8, 'a').slice(0, 8).repeat(8);

describe('buildRemoteVaultEntry', () => {
  test('produit les trois champs requis par le routeur, en HTTPS loopback', () => {
    const e = buildRemoteVaultEntry({ name: 'roland', port: 27126, apiKey: fakeKey('roland') });
    assert.equal(e.name, 'roland');
    assert.equal(e.baseUrl, 'https://127.0.0.1:27126');
    assert.equal(e.tlsInsecure, true, 'le certificat du plugin est auto-signé');
  });

  test("n'exporte JAMAIS le port en clair — il ne sert qu'au click-to-open local", () => {
    const e = buildRemoteVaultEntry({ name: 'a', port: 27126, apiKey: fakeKey('a'), insecurePort: 27136 });
    assert.ok(!JSON.stringify(e).includes('27136'));
  });

  test('refuse un vault sans clé, et son message ne cite aucune valeur', () => {
    try {
      buildRemoteVaultEntry({ name: 'muet', port: 27126, apiKey: '' });
      assert.fail('aurait dû lever');
    } catch (e) {
      assert.match(e.message, /aucune clé d'API pour "muet"/);
      assert.ok(!/[0-9a-f]{16,}/i.test(e.message), 'aucun fragment de clé dans le message');
    }
  });

  test('refuse un port hors plage', () => {
    for (const port of [0, -1, 70000, 1.5, null]) {
      assert.throws(() => buildRemoteVaultEntry({ name: 'a', port, apiKey: fakeKey('a') }), /port invalide/);
    }
  });
});

describe('failles trouvées en revue AVANT publication (2026-08-31)', () => {
  test("BLOCKER — un hôte porteur d'userinfo ne doit PAS passer la garde", () => {
    // `10.8.0.1 [arobase] attaquant.example` commence par le préfixe WireGuard, mais
    // interpolé dans une URL le `10.8.0.1` devient de l'USERINFO : l'hôte
    // réellement contacté est `attaquant.example`, et la clé d'API y part.
    // Vérifié par exécution avant correction.
    // DÉTOURNEMENT D'URL — la construction doit LEVER : la chaîne ferait
    // pointer le client ailleurs que là où elle en a l'air.
    // CONSTRUITS, jamais écrits en dur : `ip@hote` a la forme d'une adresse
    // e-mail, et le scanner de fuites du dépôt arrête ce motif — à raison, il
    // ne peut pas distinguer un vecteur d'attaque d'une vraie adresse.
    const at = (a, b) => [a, b].join('@');
    for (const evil of [
      at('10.8.0.1', 'attaquant.example'),
      '10.8.0.1/../x',
      '10.8.0.1:9999',
      '10.8.0.1 attaquant.example',
      at('127.0.0.1', 'ailleurs.test'),
      '10.8.0.1#x',
      '10.8.0.1?x',
    ]) {
      assert.equal(hostPassesTransportGuard(evil), false, `garde doit refuser : ${evil}`);
      assert.throws(
        () => buildRemoteVaultEntry({ name: 'x', port: 27126, apiKey: fakeKey('x'), host: evil }),
        /hôte invalide/,
        `doit lever pour : ${evil}`);
    }
  });

  test('un hôte HONNÊTE mais hors WireGuard est construit, et SIGNALÉ', () => {
    // `10.8.0.1.attaquant.example` est un nom DNS ordinaire : il ne détourne
    // rien, il vise franchement cet hôte. Le refuser interdirait tout hôte
    // non-loopback légitime. La bonne réponse est donc : construit, mais la
    // garde dit non et l'appelant est averti.
    const trompeur = '10.8.0.1.attaquant.example';
    assert.equal(hostPassesTransportGuard(trompeur), false, "le préfixe ne suffit PAS à passer la garde");
    const e = buildRemoteVaultEntry({ name: 'x', port: 27126, apiKey: fakeKey('x'), host: trompeur });
    assert.equal(new URL(e.baseUrl).hostname, trompeur, "l'URL vise franchement cet hôte, sans détournement");
    const { warnings } = buildRemoteConfig({
      vaults: [{ name: 'x', port: 27126, apiKey: fakeKey('x') }], host: trompeur,
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /ENFORCE_WG_OR_LOOPBACK/);
  });

  test("l'appartenance à 10.8.0.0/24 est RÉELLE, pas un préfixe de chaîne", () => {
    for (const good of ['10.8.0.1', '10.8.0.255', '127.0.0.1', 'localhost', '::1']) {
      assert.equal(hostPassesTransportGuard(good), true, good);
    }
    for (const bad of ['10.8.1.1', '10.80.0.1', '10.8.0.256', '10.8.0.01', '110.8.0.1', '']) {
      assert.equal(hostPassesTransportGuard(bad), false, bad);
    }
  });

  test('IPv6 littéral produit une URL VALIDE (crochets)', () => {
    const e = buildRemoteVaultEntry({ name: 'x', port: 27126, apiKey: fakeKey('x'), host: '::1' });
    assert.equal(e.baseUrl, 'https://[::1]:27126');
    assert.doesNotThrow(() => new URL(e.baseUrl));
    assert.equal(new URL(e.baseUrl).hostname, '[::1]');
  });

  test('deux noms qui se normalisent en une même variable sont REFUSÉS', () => {
    // `a-b` et `a b` donnent tous deux VAULT_A_B : une seule variable
    // survivrait et un vault disparaîtrait en silence.
    assert.equal(envKeyForVault('a-b'), envKeyForVault('a b'));
    assert.throws(
      () => buildEnvLines({ vaults: [
        { name: 'a-b', port: 27126, apiKey: fakeKey('ab') },
        { name: 'a b', port: 27127, apiKey: fakeKey('cd') },
      ] }),
      /se normalisent tous deux/);
  });

  test('la rédaction tient même sur une clé contenant un guillemet échappé', () => {
    // La version regex s'arrêtait au premier guillemet et laissait un SUFFIXE
    // de clé en clair. Le constructeur accepte toute chaîne non vide.
    const nasty = `aa"bb${fakeKey('zz')}`;
    const lines = buildEnvLines({ vaults: [{ name: 'x', port: 27126, apiKey: nasty }] });
    assert.ok(lines[0].includes('bb'), 'précondition : la clé brute est bien dans la ligne');
    const red = redactEnvLines(lines);
    assert.ok(!red[0].includes('bb'), 'aucun fragment de clé ne survit');
    assert.ok(!red[0].includes(fakeKey('zz')));
    assert.ok(red[0].includes(API_KEY_PLACEHOLDER));
  });

  test('une ligne illisible est TUE plutôt que rendue à moitié rédigée', () => {
    const red = redactEnvLines(['VAULT_X={pas du json']);
    assert.equal(red[0], `VAULT_X=${API_KEY_PLACEHOLDER}`);
  });
});

describe('buildRemoteConfig', () => {
  const vaults = [
    { name: 'roland', port: 27126, apiKey: fakeKey('roland') },
    { name: 'tribu', port: 27172, apiKey: fakeKey('tribu') },
  ];

  test('portRegistry est VIDE — c\'est ce qui supprime la lecture du data.json', () => {
    const { config } = buildRemoteConfig({ vaults });
    assert.deepEqual(config.portRegistry, {}, 'une entrée ici ferait relire la clé sur disque');
    assert.equal(config.remoteVaults.length, 2);
  });

  test('refuse une sélection vide — on n\'exporte pas un parc par défaut', () => {
    assert.throws(() => buildRemoteConfig({ vaults: [] }), /liste non vide/);
    assert.throws(() => buildRemoteConfig({}), /liste non vide/);
  });

  test('refuse deux vaults de même nom — le routeur ne pourrait pas les distinguer', () => {
    assert.throws(
      () => buildRemoteConfig({ vaults: [vaults[0], { ...vaults[0], port: 27999 }] }),
      /dupliqué/);
  });

  test('refuse un defaultVault hors sélection', () => {
    assert.throws(() => buildRemoteConfig({ vaults, defaultVault: 'absent' }), /n'est pas dans la sélection/);
  });

  test('signale un hôte que la garde de transport refusera', () => {
    const { warnings } = buildRemoteConfig({ vaults, host: '192.168.0.11' });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /ENFORCE_WG_OR_LOOPBACK/);
    // loopback et maille WG passent sans avertissement
    for (const h of ['127.0.0.1', 'localhost', '10.8.0.1']) {
      assert.equal(buildRemoteConfig({ vaults, host: h }).warnings.length, 0, h);
      assert.equal(hostPassesTransportGuard(h), true, h);
    }
  });
});

describe('ALLER-RETOUR avec le routeur — la protection contre la dérive', () => {
  test('les lignes VAULT_* générées sont acceptées telles quelles par parseEnvVaults', () => {
    const vaults = [
      { name: 'roland', port: 27126, apiKey: fakeKey('roland') },
      { name: 'mcp server - openrouter fusion', port: 27173, apiKey: fakeKey('fusion') },
    ];
    const lines = buildEnvLines({ vaults });
    const env = Object.fromEntries(lines.map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    }));
    const { envVaults, warnings } = _internals.parseEnvVaults(env);
    assert.deepEqual(warnings, [], 'aucun avertissement : le routeur accepte la forme émise');
    assert.equal(envVaults.length, 2);
    assert.deepEqual(envVaults.map((v) => v.name).sort(), ['mcp server - openrouter fusion', 'roland']);
    assert.equal(envVaults.find((v) => v.name === 'roland').baseUrl, 'https://127.0.0.1:27126');
  });

  test('un nom avec espaces et tirets donne une clé d\'env exportable par un shell', () => {
    assert.equal(envKeyForVault('mcp server - openrouter fusion'), 'VAULT_MCP_SERVER_OPENROUTER_FUSION');
    assert.equal(envKeyForVault('opsidian-mcp-router et bridge'), 'VAULT_OPSIDIAN_MCP_ROUTER_ET_BRIDGE');
    assert.throws(() => envKeyForVault('---'), /vide après normalisation/);
  });

  test('la config générée est chargée par loadRegistry, et AUCUN vault local n\'en sort', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-cfg-'));
    try {
      const { config } = buildRemoteConfig({
        vaults: [{ name: 'roland', port: 27126, apiKey: fakeKey('roland') }],
        defaultVault: 'roland',
      });
      const p = path.join(dir, 'config.json');
      fs.writeFileSync(p, JSON.stringify(config));
      const reg = await loadRegistry({ configPath: p });
      assert.equal(reg.vaults.length, 1);
      assert.equal(reg.vaults[0].type, 'remote', 'type remote = aucune lecture de data.json');
      assert.equal(reg.vaults[0].apiKey, fakeKey('roland'), 'la clé vient de la config');
      assert.equal(reg.defaultVault, 'roland');
      assert.equal(reg.vaults.filter((v) => v.type === 'local').length, 0);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('rédaction — la sortie par défaut ne doit rien divulguer', () => {
  const vaults = [{ name: 'roland', port: 27126, apiKey: fakeKey('roland') }];

  test('redactConfig remplace la clé et ne mute pas l\'original', () => {
    const { config } = buildRemoteConfig({ vaults });
    const red = redactConfig(config);
    assert.equal(red.remoteVaults[0].apiKey, API_KEY_PLACEHOLDER);
    assert.equal(config.remoteVaults[0].apiKey, fakeKey('roland'), 'copie profonde, pas mutation');
    assert.ok(!JSON.stringify(red).includes(fakeKey('roland')));
  });

  test('redactEnvLines aussi', () => {
    const red = redactEnvLines(buildEnvLines({ vaults }));
    assert.ok(!red.join('\n').includes(fakeKey('roland')));
    assert.ok(red[0].includes(API_KEY_PLACEHOLDER));
  });

  test('looksLikeApiKey distingue une clé plausible d\'un marque-place', () => {
    assert.equal(looksLikeApiKey(fakeKey('a')), true);
    assert.equal(looksLikeApiKey(API_KEY_PLACEHOLDER), false);
    assert.equal(looksLikeApiKey('court'), false);
    assert.equal(looksLikeApiKey(null), false);
  });
});

describe('CLI — les garde-fous', () => {
  // CONSTRUIT, jamais écrit en dur : un littéral affecté à `privateKey` est
  // exactement ce que le scanner de fuites du dépôt arrête — et il a raison,
  // la règle ne peut pas distinguer un faux marqueur d'une vraie clé.
  const tlsMarker = ['NE', 'DOIT', 'JAMAIS', 'SORTIR'].join('-');

  function makeFleet() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-cli-'));
    const vault = path.join(dir, 'Roland');
    fs.mkdirSync(path.join(vault, '.obsidian', 'plugins', 'obsidian-local-rest-api'), { recursive: true });
    fs.writeFileSync(
      path.join(vault, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'),
      JSON.stringify({ apiKey: fakeKey('roland'), port: 27126, insecurePort: 27136, crypto: { privateKey: tlsMarker } }));
    const cfg = path.join(dir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ portRegistry: { [vault]: { https: 27126, http: 27136 } }, vaultNames: { [vault]: 'roland' } }));
    return { dir, vault, cfg };
  }
  const run = (args, cfg) => spawnSync(process.execPath, [SCRIPT, ...args, '--config', cfg], { encoding: 'utf8' });

  test('sans sélection, il REFUSE — pas de parc exporté par accident', () => {
    const { dir, cfg } = makeFleet();
    try {
      const r = run([], cfg);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /--vault <slug>.*--all/s);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('par défaut la sortie est RÉDIGÉE — la clé n\'apparaît pas', () => {
    const { dir, cfg } = makeFleet();
    try {
      const r = run(['--vault', 'roland'], cfg);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(!r.stdout.includes(fakeKey('roland')), 'aucune clé en clair par défaut');
      assert.ok(r.stdout.includes(API_KEY_PLACEHOLDER));
      assert.ok(!r.stdout.includes(tlsMarker), 'la clé privée TLS ne sort jamais');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('--print-secrets émet le clair, et le signale', () => {
    const { dir, cfg } = makeFleet();
    try {
      const r = run(['--vault', 'roland', '--print-secrets'], cfg);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.stdout.includes(fakeKey('roland')));
      assert.match(r.stderr, /CLAIR sur stdout/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('--out refuse d\'écrire dans le dépôt', () => {
    const { dir, cfg } = makeFleet();
    try {
      const r = run(['--vault', 'roland', '--out', path.join(process.cwd(), 'fuite.json')], cfg);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /dans le dépôt/);
      assert.ok(!fs.existsSync(path.join(process.cwd(), 'fuite.json')));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('--out refuse d\'écrire À L\'INTÉRIEUR d\'un vault', () => {
    const { dir, vault, cfg } = makeFleet();
    try {
      const r = run(['--vault', 'roland', '--out', path.join(vault, 'wiki', 'fuite.json')], cfg);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /à l'intérieur d'un vault/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('--out écrit un fichier utilisable, et le déclare secret', () => {
    const { dir, cfg } = makeFleet();
    const out = path.join(dir, 'sortie', 'remote.json');
    try {
      const r = run(['--vault', 'roland', '--out', out], cfg);
      assert.equal(r.status, 0, r.stderr);
      const written = JSON.parse(fs.readFileSync(out, 'utf8'));
      assert.equal(written.remoteVaults[0].apiKey, fakeKey('roland'));
      assert.deepEqual(written.portRegistry, {});
      assert.match(r.stderr, /SECRET/);
      if (process.platform !== 'win32') {
        assert.equal(fs.statSync(out).mode & 0o777, 0o600);
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('un slug inconnu échoue en nommant les slugs connus', () => {
    const { dir, cfg } = makeFleet();
    try {
      const r = run(['--vault', 'inexistant'], cfg);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /Slug inconnu.*roland/s);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('la sélection est insensible à la casse — un slug est tapé, pas copié', () => {
    // Le parc réel contient `DEDIBOX` en majuscules dans vaultNames : exiger la
    // casse exacte transformait un identifiant en devinette.
    const { dir, cfg } = makeFleet();
    try {
      const conf = JSON.parse(fs.readFileSync(cfg, 'utf8'));
      const vp = Object.keys(conf.portRegistry)[0];
      conf.vaultNames[vp] = 'ROLAND';
      fs.writeFileSync(cfg, JSON.stringify(conf));
      const r = run(['--vault', 'roland'], cfg);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.stdout.includes('"name": "ROLAND"'), 'le nom émis reste celui de la config');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('--all annonce combien de clés il exporte', () => {
    const { dir, cfg } = makeFleet();
    try {
      const r = run(['--all'], cfg);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /1 clés d'API vont être exportées/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('un vault sans clé lisible est EXCLU, pas exporté muet', () => {
    const { dir, cfg } = makeFleet();
    try {
      const conf = JSON.parse(fs.readFileSync(cfg, 'utf8'));
      const orphan = path.join(dir, 'Orphelin');
      fs.mkdirSync(orphan, { recursive: true });
      conf.portRegistry[orphan] = { https: 27199, http: 27209 };
      conf.vaultNames[orphan] = 'orphelin';
      fs.writeFileSync(cfg, JSON.stringify(conf));
      const r = run(['--all'], cfg);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /EXCLUS : orphelin/);
      assert.ok(!r.stdout.includes('orphelin'), 'aucune entrée muette dans la sortie');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
