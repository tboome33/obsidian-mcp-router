#!/usr/bin/env node
/**
 * gen-remote-config.mjs — produire la configuration d'un routeur qui n'a pas
 * les disques des vaults (lot 1 du chantier « interface de backend »).
 *
 * Le banc 50/50 du 2026-08-31 a montré que le SEUL couplage universel au disque
 * est la résolution de la clé d'API : `loadRegistry()` lit le `data.json` du
 * vault avant tout outil. Ce script déplace cette clé dans la config, ce qui
 * supprime le couplage — c'est le lot qui débloque le profil HTTP-only.
 *
 * ── POSTULAT DE SÛRETÉ, ET POURQUOI LES DÉFAUTS SONT PRUDENTS ───────────────
 *
 * Un fichier portant N clés en clair donne à TOUT processus capable de le lire
 * un accès complet en lecture ET en écriture aux N vaults. Sur une machine où
 * tournent des agents de code, c'est une élévation de privilège réelle. Les
 * défauts sont donc choisis pour qu'une erreur de manipulation ne divulgue
 * rien :
 *
 *   - la sortie par défaut est RÉDIGÉE (marque-place à la place des clés) ;
 *   - il n'y a pas de `--all` implicite : la sélection des vaults est explicite,
 *     et `--all` annonce bruyamment combien de clés il s'apprête à exporter ;
 *   - `--out` crée le fichier en 0600, et REFUSE d'écrire dans le dépôt, dans
 *     un vault, ou par-dessus un fichier aux permissions plus larges ;
 *   - `--print-secrets` est nécessaire pour envoyer du clair sur stdout, et
 *     sert au cas légitime : tuyauter vers un magasin de secrets sans jamais
 *     toucher le disque ;
 *   - aucune clé n'est jamais journalisée, ni tronquée, ni citée dans un
 *     message d'erreur. Huit caractères suffisent à corréler une clé.
 *
 * ── LES CLÉS SE LISENT SUR LE DISQUE, JAMAIS PAR L'API ──────────────────────
 *
 * `.obsidian/plugins/obsidian-local-rest-api/data.json` contient l'`apiKey` ET
 * la clé privée TLS en clair. Passer par l'API du plugin pour l'inventaire
 * ferait transiter les deux ; on lit le fichier, et on n'en extrait que le
 * champ nécessaire.
 *
 * ── USAGE ───────────────────────────────────────────────────────────────────
 *
 *   node scripts/gen-remote-config.mjs --vault roland --vault tribu
 *   node scripts/gen-remote-config.mjs --all --out ~/.claude/remote-config.json
 *   node scripts/gen-remote-config.mjs --all --format env --print-secrets | ...
 *
 * Drapeaux : --vault <slug> (répétable) · --all · --host <hôte> (défaut
 * 127.0.0.1, le bout du tunnel) · --format json|env · --out <fichier> ·
 * --print-secrets · --default-vault <slug> · --config <chemin>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildRemoteConfig, buildEnvLines, redactConfig, redactEnvLines,
  looksLikeApiKey, hostPassesTransportGuard,
} from '../src/helpers/remote-config.mjs';
import { normalizePortEntry } from '../src/helpers/port-registry.mjs';
import { normalizePathForCompare } from '../src/helpers/vault-path-identity.mjs';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const DEFAULT_CONFIG = path.join(os.homedir(), '.claude', 'obsidian-mcp-router', 'config.json');

const C = { red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', gray: '\x1b[90m', bold: '\x1b[1m', reset: '\x1b[0m' };
const err = (m) => { console.error(`${C.red}✗${C.reset} ${m}`); process.exit(1); };
const warn = (m) => console.error(`${C.yellow}!${C.reset} ${m}`);
const info = (m) => console.error(`${C.gray}  ${m}${C.reset}`);
const ok = (m) => console.error(`${C.green}✓${C.reset} ${m}`);

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`
gen-remote-config — config d'un routeur SANS disque de vault (profil HTTP-only)

  --vault <slug>       vault à exporter (RÉPÉTABLE). La sélection est explicite.
  --all                tout le parc — annonce le nombre de clés avant d'agir.
  --host <hôte>        défaut 127.0.0.1 (le bout du tunnel SSH côté distant).
  --format json|env    'json' = fichier config ; 'env' = lignes VAULT_<NOM>=…
  --out <fichier>      écrire en clair, fichier créé en 0600.
  --print-secrets      autoriser le clair sur stdout (pour tuyauter).
  --default-vault <s>  defaultVault de la config générée.
  --config <chemin>    config source (défaut ~/.claude/obsidian-mcp-router/config.json)

Sans --out ni --print-secrets, la sortie est RÉDIGÉE : même forme, clés
remplacées par un marque-place. C'est le défaut, pour qu'une commande lancée
par curiosité ne divulgue rien.
`.trim());
  process.exit(0);
}

const flag = (n) => argv.includes(`--${n}`);
const val = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const many = (n) => argv.reduce((a, x, i) => (x === `--${n}` && argv[i + 1] && !argv[i + 1].startsWith('--') ? [...a, argv[i + 1]] : a), []);

const selected = many('vault');
const wantAll = flag('all');
const host = val('host', '127.0.0.1');
const format = val('format', 'json');
const outPath = val('out');
const printSecrets = flag('print-secrets');
const defaultVault = val('default-vault');
const configPath = val('config', process.env.OBSIDIAN_ROUTER_CONFIG || DEFAULT_CONFIG);

if (!['json', 'env'].includes(format)) err(`--format doit être 'json' ou 'env' (reçu "${format}")`);
if (!selected.length && !wantAll) {
  err('Choisissez les vaults à exporter : --vault <slug> (répétable), ou --all.\n' +
      "  La sélection est explicite par conception : exporter 22 clés d'un parc entier ne doit jamais être le défaut.");
}

// ---------------------------------------------------------------------------
// lecture du parc — disque uniquement
// ---------------------------------------------------------------------------
if (!fs.existsSync(configPath)) err(`Config introuvable : ${configPath}`);
let cfg;
try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
catch (e) { err(`Config illisible (${configPath}) : ${e.message}`); }

const defaultNameFromPath = (p) => {
  const isWin = /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p);
  return (isWin ? path.win32 : path.posix).basename(p).replace(/^\./, '').toLowerCase();
};

/** Lit UNIQUEMENT l'apiKey du data.json. La clé privée TLS n'est jamais extraite. */
function readApiKeyFromDisk(vaultPath) {
  const p = path.join(vaultPath, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json');
  if (!fs.existsSync(p)) return null;
  try {
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    return typeof d.apiKey === 'string' && d.apiKey ? d.apiKey : null;
  } catch { return null; }
}

const names = cfg.vaultNames || {};
const fleet = [];
for (const [vaultPath, raw] of Object.entries(cfg.portRegistry || {})) {
  const name = names[vaultPath] || defaultNameFromPath(vaultPath);
  fleet.push({ name, vaultPath, port: normalizePortEntry(raw).https });
}
if (!fleet.length) err(`Aucun vault dans le portRegistry de ${configPath}.`);

// Sélection INSENSIBLE À LA CASSE : les slugs sont des identifiants qu'on
// tape, et `vaultNames` en contient des majuscules (`DEDIBOX`). Une ambiguïté
// réelle — deux vaults ne différant que par la casse — est refusée plutôt que
// tranchée en silence.
const matchesOf = (s) => fleet.filter((v) => v.name.toLowerCase() === s.toLowerCase());
const ambiguous = selected.filter((s) => matchesOf(s).length > 1);
if (ambiguous.length) {
  err(`Slug ambigu (plusieurs vaults ne diffèrent que par la casse) : ${ambiguous.join(', ')}\n` +
      `  Désambiguïsez en tapant le nom exact.`);
}
const missing = selected.filter((s) => matchesOf(s).length === 0);
if (missing.length) err(`Slug inconnu : ${missing.join(', ')}\n  Connus : ${fleet.map((v) => v.name).sort().join(', ')}`);
const wanted = wantAll ? fleet : selected.flatMap((s) => matchesOf(s));

if (wantAll) {
  warn(`--all : ${wanted.length} clés d'API vont être exportées.`);
  info("Chacune donne un accès COMPLET en lecture et en écriture à son vault, à tout processus capable de lire la sortie.");
}

// ---------------------------------------------------------------------------
// résolution des clés
// ---------------------------------------------------------------------------
const vaults = [];
const noKey = [];
for (const v of wanted) {
  const apiKey = readApiKeyFromDisk(v.vaultPath);
  if (!apiKey) { noKey.push(v.name); continue; }
  if (!looksLikeApiKey(apiKey)) warn(`${v.name} : la clé lue n'a pas la forme attendue — exportée telle quelle, à vérifier.`);
  vaults.push({ name: v.name, port: v.port, apiKey });
}
if (noKey.length) {
  warn(`Sans clé lisible sur disque, donc EXCLUS : ${noKey.join(', ')}`);
  info('Ouvrez ces vaults dans Obsidian une fois, plugin Local REST API activé, puis relancez.');
}
if (!vaults.length) err("Aucune clé lisible — rien à générer.");

let built;
try { built = buildRemoteConfig({ vaults, host, defaultVault }); }
catch (e) { err(e.message); }
for (const w of built.warnings) warn(w);
if (!hostPassesTransportGuard(host)) {
  info('Rappel : la garde OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK refusera de démarrer sur un tel hôte.');
}

const payload = format === 'env'
  ? buildEnvLines({ vaults, host }).join('\n') + '\n'
  : JSON.stringify(built.config, null, 2) + '\n';
const redacted = format === 'env'
  ? redactEnvLines(buildEnvLines({ vaults, host })).join('\n') + '\n'
  : JSON.stringify(redactConfig(built.config), null, 2) + '\n';

// ---------------------------------------------------------------------------
// sortie
// ---------------------------------------------------------------------------
function refuseUnsafeOut(target) {
  const abs = path.resolve(target);
  const under = (root) => {
    const rel = path.relative(path.resolve(root), abs);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  if (under(REPO_ROOT)) {
    err(`Refus d'écrire des clés dans le dépôt (${abs}).\n  Un secret déposé dans un arbre versionné finit par être committé.`);
  }
  for (const vaultPath of Object.keys(cfg.portRegistry || {})) {
    const relV = path.relative(normalizePathForCompare(vaultPath), normalizePathForCompare(abs));
    if (relV === '' || (!relV.startsWith('..') && !path.isAbsolute(relV))) {
      err(`Refus d'écrire des clés à l'intérieur d'un vault (${abs}).\n  Le contenu d'un vault est synchronisé, indexé et servi par REST.`);
    }
  }
  if (fs.existsSync(abs)) {
    const mode = fs.statSync(abs).mode & 0o777;
    if (process.platform !== 'win32' && (mode & 0o077)) {
      err(`Le fichier existant ${abs} est lisible au-delà de son propriétaire (mode ${mode.toString(8)}).\n  Corrigez ses permissions ou choisissez un autre chemin.`);
    }
  }
}

if (outPath) {
  refuseUnsafeOut(outPath);
  const abs = path.resolve(outPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  // 0600 dès la CRÉATION : écrire puis chmod laisserait une fenêtre pendant
  // laquelle le fichier est lisible par d'autres.
  const fd = fs.openSync(abs, 'w', 0o600);
  try { fs.writeFileSync(fd, payload, 'utf8'); } finally { fs.closeSync(fd); }
  if (process.platform !== 'win32') fs.chmodSync(abs, 0o600);
  ok(`${vaults.length} vault(s) écrits dans ${abs} (mode 0600).`);
  if (process.platform === 'win32') {
    info('Windows : le mode POSIX est indicatif. Vérifiez les ACL du dossier parent.');
  }
  info("Ce fichier est un SECRET : ne le committez pas, ne le copiez pas dans un vault, effacez-le dès qu'il a servi.");
} else if (printSecrets) {
  warn(`${vaults.length} clé(s) en CLAIR sur stdout — à tuyauter, pas à laisser dans un historique de shell.`);
  process.stdout.write(payload);
} else {
  process.stdout.write(redacted);
  info('Sortie RÉDIGÉE (défaut). Ajoutez --out <fichier> pour écrire en clair en 0600, ou --print-secrets pour tuyauter.');
}
