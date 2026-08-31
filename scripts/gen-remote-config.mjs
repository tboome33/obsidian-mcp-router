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
  --with-click-to-open exporter aussi le port EN CLAIR de chaque vault, pour
                       que le routeur distant émette des liens click-to-open.
                       ABSENT PAR DÉFAUT : voir plus bas ce que ça suppose.
  --host <hôte>        défaut 127.0.0.1 (le bout du tunnel SSH côté distant).
  --format json|env    'json' = fichier config ; 'env' = lignes VAULT_<NOM>=…
  --out <fichier>      écrire en clair, fichier créé en 0600.
  --print-secrets      autoriser le clair sur stdout (pour tuyauter).
  --default-vault <s>  defaultVault de la config générée.
  --config <chemin>    config source (défaut ~/.claude/obsidian-mcp-router/config.json)

Sans --out ni --print-secrets, la sortie est RÉDIGÉE : même forme, clés
remplacées par un marque-place. C'est le défaut, pour qu'une commande lancée
par curiosité ne divulgue rien.

--with-click-to-open, et pourquoi ce n'est PAS le défaut. Le lien émis vaut
toujours http://127.0.0.1:<port>/open/<chemin> : il ne fonctionne que si vos
lecteurs cliquent DEPUIS la machine qui fait tourner Obsidian. Sinon le clic
part vers LEUR loopback — et si un service sans rapport y écoute, il reçoit le
CHEMIN de la note et son titre de section. Le contenu n'est jamais transmis
(/open ne le renvoie pas), mais un chemin peut déjà être une information.
Poser ce drapeau, c'est affirmer que vos lecteurs sont bien sur cette machine.
`.trim());
  process.exit(0);
}

const flag = (n) => argv.includes(`--${n}`);
const val = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const many = (n) => argv.reduce((a, x, i) => (x === `--${n}` && argv[i + 1] && !argv[i + 1].startsWith('--') ? [...a, argv[i + 1]] : a), []);

const selected = many('vault');
const wantAll = flag('all');
const withClickToOpen = flag('with-click-to-open');
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

/**
 * Lit du data.json l'apiKey ET le port en clair — rien d'autre.
 *
 * La clé privée TLS est dans le même fichier et n'est JAMAIS extraite. Le port
 * en clair sert au click-to-open du profil distant (lot 2) : sans lui, un vault
 * déclaré en `remoteVaults` n'a aucune source pour ce nombre et les 13 outils
 * qui émettent un lien émettent `null`.
 *
 * LE DISQUE DÉCIDE QUAND IL PARLE. Trois revues ont porté sur cette fonction et
 * son appelant. La première a montré qu'elle confondait « serveur en clair
 * ÉTEINT » et « fichier illisible », ce qui faisait exporter le port mémorisé
 * d'un serveur délibérément coupé. La deuxième a montré que le repli mélangeait
 * les sources — port en clair du disque, port HTTPS du registre — et pouvait
 * accuser à tort un vault sain. La réparation a d'abord exclu tout vault sans
 * port HTTPS sur disque ; la troisième revue a montré que c'était trop large.
 *
 * La règle finale tient à la notion de PAIRE. Comparer deux ports n'a de sens
 * que s'ils viennent de la même source, donc :
 *   - avec `--with-click-to-open` (une paire est exportée) → les deux ports
 *     viennent du disque, ou le vault est exclu ;
 *   - sans le drapeau (seul le HTTPS sort, aucune comparaison) → le registre
 *     reste un repli légitime, signalé.
 * `readable` reste exposé pour dire l'état, mais l'appelant n'en a plus besoin :
 * un fichier illisible n'a pas non plus de clé, et le vault sort avant.
 */
function readVaultSecretsFromDisk(vaultPath) {
  const unreadable = { apiKey: null, port: null, insecurePort: null, readable: false };
  const p = path.join(vaultPath, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json');
  if (!fs.existsSync(p)) return unreadable;
  const asPort = (n) => (Number.isInteger(n) && n > 0 && n <= 65535 ? n : null);
  try {
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      apiKey: typeof d.apiKey === 'string' && d.apiKey ? d.apiKey : null,
      // LES DEUX PORTS, depuis LA MÊME SOURCE. La première version ne lisait que
      // le port en clair, puis le comparait au port HTTPS du REGISTRE — deux
      // sources différentes (trouvé en 2ᵉ revue). Un registre périmé faisait
      // alors accuser à tort un vault parfaitement sain d'avoir deux ports
      // égaux, et laissait passer le cas inverse. Une comparaison entre deux
      // sources ne compare rien.
      port: asPort(d.port),
      // Lisible : ce fichier DÉCIDE. Serveur éteint, ou port absent/aberrant →
      // pas de port, et surtout pas de repli.
      insecurePort: d.enableInsecureServer === true ? asPort(d.insecurePort) : null,
      readable: true,
    };
  } catch { return unreadable; }
}

const names = cfg.vaultNames || {};
const fleet = [];
for (const [vaultPath, raw] of Object.entries(cfg.portRegistry || {})) {
  const name = names[vaultPath] || defaultNameFromPath(vaultPath);
  // Seul le port HTTPS du registre est retenu. Il sert à SIGNALER un désaccord
  // avec le disque, et — sans `--with-click-to-open` seulement — de repli quand
  // le data.json n'écrit pas son port. Dès qu'une PAIRE est exportée, les deux
  // ports viennent du disque ou le vault est exclu : c'est la comparaison entre
  // deux sources qu'il faut empêcher, pas l'usage du registre en soi.
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
const noLink = [];
const noHttpsPort = [];
for (const v of wanted) {
  const { apiKey, port: diskPort, insecurePort } = readVaultSecretsFromDisk(v.vaultPath);
  // Un data.json illisible n'a pas de clé non plus : le vault sort ici, ce qui
  // rend TOUT le reste de cette boucle conditionné à `readable === true`. (Un
  // repli « registre » pour un fichier illisible serait donc du code mort —
  // relevé en 3ᵉ revue, et retiré plutôt que commenté.)
  if (!apiKey) { noKey.push(v.name); continue; }
  if (!looksLikeApiKey(apiKey)) warn(`${v.name} : la clé lue n'a pas la forme attendue — exportée telle quelle, à vérifier.`);

  // LE DISQUE DÉCIDE QUAND IL PARLE. La règle « les deux ports ou aucun » n'a de
  // sens que si l'on exporte une PAIRE : c'est elle qui interdit de comparer un
  // port en clair venu du disque à un port HTTPS venu du registre. Sans
  // `--with-click-to-open` il n'y a pas de paire, donc pas de comparaison, donc
  // aucune raison de refuser un vault dont le data.json n'écrit pas son `port`
  // — ce qu'un plugin fait couramment quand la valeur est celle par défaut.
  // Exclure ce cas était une régression gratuite (4ᵉ revue).
  if (diskPort === null && withClickToOpen) {
    noHttpsPort.push(v.name);
    continue;
  }
  const httpsPort = diskPort ?? v.port;
  if (diskPort === null) {
    warn(`${v.name} : son data.json n'écrit pas de port HTTPS — le registre (${v.port}) est utilisé.`);
  } else if (diskPort !== v.port) {
    warn(`${v.name} : le registre déclare ${v.port} en HTTPS, son data.json lie ${diskPort} — c'est ${diskPort} qui est exporté.`);
    info('Réconciliez avec `node scripts/setup-vault.mjs --sync-port-registry`.');
  }

  let clickPort = withClickToOpen ? insecurePort : null;
  // Deux ports identiques, comparés DEPUIS LA MÊME SOURCE : la donnée est
  // fausse quelque part. On le signale et on n'exporte PAS le port, plutôt que
  // de laisser le constructeur lever et faire échouer l'export entier à cause
  // d'un seul vault mal configuré.
  if (clickPort !== null && clickPort === diskPort) {
    warn(`${v.name} : ${clickPort} déclaré à la fois en HTTPS et en clair — port en clair NON exporté, à corriger dans Obsidian.`);
    clickPort = null;
  }
  if (withClickToOpen && clickPort === null) noLink.push(v.name);
  vaults.push({
    name: v.name,
    port: httpsPort,
    apiKey,
    ...(clickPort !== null ? { insecurePort: clickPort } : {}),
  });
}
if (noHttpsPort.length) {
  warn(`--with-click-to-open exige les DEUX ports depuis le data.json ; sans port HTTPS lisible, donc EXCLUS : ${noHttpsPort.join(', ')}`);
  info("Comparer un port en clair venu du disque à un port HTTPS venu du registre, c'est comparer deux sources. Relancez sans le drapeau pour les exporter quand même.");
}
if (noKey.length) {
  warn(`Sans clé lisible sur disque, donc EXCLUS : ${noKey.join(', ')}`);
  info('Ouvrez ces vaults dans Obsidian une fois, plugin Local REST API activé, puis relancez.');
}
if (noLink.length) {
  warn(`--with-click-to-open demandé mais sans port en clair utilisable : ${noLink.join(', ')}`);
  info("Ces vaults fonctionneront normalement ; seuls leurs `clickToOpenUrl` resteront à null.");
}
if (!vaults.length) {
  // Le message nomme la VRAIE cause : avec `--with-click-to-open`, un vault peut
  // avoir une clé parfaitement lisible et sortir quand même faute de port HTTPS
  // sur disque. Annoncer « aucune clé lisible » enverrait chercher au mauvais
  // endroit (4ᵉ revue).
  const causes = [];
  if (noKey.length) causes.push(`${noKey.length} sans clé lisible`);
  if (noHttpsPort.length) causes.push(`${noHttpsPort.length} sans port HTTPS sur disque`);
  err(`Aucun vault exportable — rien à générer${causes.length ? ` (${causes.join(', ')})` : ''}.`);
}
const withPorts = vaults.filter((v) => v.insecurePort !== undefined);
if (withPorts.length) {
  // CE QUE CE MESSAGE NE DIT PLUS. Une première version annonçait qu'un hôte
  // non-loopback empêcherait tout lien — c'était faux, et la 2ᵉ revue l'a
  // relevé : le lien émis vaut TOUJOURS 127.0.0.1, jamais l'hôte de `baseUrl`.
  // Ce que `--host` décrit, c'est le chemin du ROUTEUR vers l'API REST ; ce qui
  // décide du clic, c'est où se trouve le LECTEUR. Deux sauts différents.
  warn(`${withPorts.length} port(s) en clair exportés : les liens vaudront http://127.0.0.1:<port>/open/<chemin>.`);
  info("Si un lecteur clique AILLEURS que sur la machine qui fait tourner Obsidian, le CHEMIN de la note et son titre de section partent vers ce qui écoute sur son propre loopback. Le contenu, lui, ne sort jamais.");

  // ---------------------------------------------------------------------------
  // L'AUTO-TEST — comment vérifier une hypothèse que le routeur ne peut pas mesurer
  // ---------------------------------------------------------------------------
  //
  // Déclarer `insecurePort` est une AFFIRMATION de l'opérateur : « mes lecteurs
  // cliquent depuis la machine qui fait tourner Obsidian ». Le routeur ne peut
  // pas la vérifier — il observe son propre saut vers l'API REST, jamais la
  // position du navigateur qui cliquera. Chercher à la mesurer d'ici est une
  // impasse, et une affirmation qu'on ne peut ni prouver ni infirmer est le
  // genre de chose qui se révèle fausse le jour où ça compte.
  //
  // Mais elle est vérifiable AILLEURS, gratuitement, grâce à une propriété que
  // le pont a déjà. Sa route `/open` applique deux gardes, dans cet ordre :
  // d'abord l'IP source (loopback, sinon `loopback only`), ensuite le chemin
  // (vide ou remontant, sinon `path traversal refused`). Donc une requête avec
  // un chemin VIDE passe la première et meurt sur la seconde.
  //
  // `path traversal refused` est par conséquent une PREUVE D'IDENTITÉ : seul le
  // pont répond cela, et il ne le dit qu'à un appelant en loopback. Ce message
  // qui a l'air d'une erreur est le seul témoin fiable qu'on puisse obtenir. Un
  // écouteur intrus répondrait autre chose, ou rien.
  //
  // Un port par ligne, dédupliqué : deux vaults sur le même port n'ont qu'une
  // seule machine à prouver.
  const testPorts = [...new Set(withPorts.map((v) => v.insecurePort))].sort((a, b) => a - b);
  console.error('');
  // « la machine où vous lisez » était imprécis (revue) : ce qui compte est la
  // machine dont le NAVIGATEUR déréférence l'URL. Bureau à distance, navigateur
  // délégué, téléphone : ce n'est pas toujours celle où l'œil se trouve.
  info('VÉRIFIEZ CETTE HYPOTHÈSE UNE FOIS — depuis le NAVIGATEUR qui ouvrira réellement vos liens');
  info('(pas forcément la machine où vous lisez : bureau à distance, mobile…) :');
  for (const p of testPorts) console.error(`      http://127.0.0.1:${p}/open/`);
  info('  → « path traversal refused » = un pont a répondu ; vos liens l\'atteindront.');
  info('  → une page inconnue, une erreur de connexion, ou rien = NON. Relancez sans --with-click-to-open.');
  // CE QUE CE TEST NE PROUVE PAS, et il faut le dire : il établit qu'UN pont
  // écoute sur ce port depuis cette machine — pas que c'est celui de CE vault.
  // Ce dépôt a mesuré neuf collisions de ports sur un parc de 27 vaults
  // (v0.77.0) : la nuance n'est pas théorique. Un pont voisin répondrait le même
  // message et ouvrirait ensuite les notes d'un AUTRE vault.
  info('  ⚠ Ce test prouve qu\'un pont écoute là, pas que c\'est celui de ce vault.');
  info('    Si votre parc a connu des collisions de ports (`setup-vault.mjs --check-ports`),');
  info('    ouvrez ensuite UN vrai lien de note et vérifiez que c\'est la bonne qui s\'ouvre.');
}

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
