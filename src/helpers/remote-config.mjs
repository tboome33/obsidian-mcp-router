/**
 * remote-config — construire la configuration d'un routeur qui n'a PAS les
 * disques des vaults : chaque vault y est déclaré en `remoteVaults` (ou en
 * `VAULT_*`), avec sa clé d'API dans la config plutôt que sur disque.
 *
 * POURQUOI CE MODULE EXISTE, mesuré et non supposé (banc 50/50 du 2026-08-31,
 * page `matrice-http-only-lot0`) : pour un vault LOCAL, `loadRegistry()` va
 * chercher l'`apiKey` dans le `data.json` du vault AVANT que le moindre outil
 * ne s'exécute. C'est le seul couplage universel au disque — les 50 outils le
 * paient, et c'est un prérequis d'amorçage, pas cinquante dépendances. Une fois
 * la clé en config, **aucun** des 30 outils éprouvés n'exige plus le disque.
 * Déplacer les clés n'est donc pas un lot parmi d'autres : c'est celui qui
 * débloque le profil HTTP-only.
 *
 * ── CE QUE CE MODULE NE FAIT PAS ────────────────────────────────────────────
 *
 * Il ne LIT aucun secret : les clés lui sont fournies par l'appelant, qui les
 * a lues sur disque. Il n'en INVENTE aucune. Il n'en JOURNALISE aucune — pas
 * même dans un message d'erreur, pas même tronquée. Un secret tronqué reste un
 * secret partiellement divulgué, et huit caractères suffisent à corréler une
 * clé à travers un transcript.
 *
 * ── LE POSTULAT DE SÛRETÉ ───────────────────────────────────────────────────
 *
 * Une configuration portant N clés en clair donne à TOUT processus capable de
 * la lire un accès complet en lecture ET en écriture aux N vaults. Sur une
 * machine où tournent des agents de code, c'est une élévation de privilège
 * réelle par rapport à l'existant. Le module pousse donc vers le moindre
 * privilège :
 *
 *   - `buildRemoteConfig` REFUSE un vault sans clé plutôt que d'émettre une
 *     entrée muette que le routeur ignorerait en silence ;
 *   - `redactConfig` produit la MÊME forme avec des marque-place, pour qu'on
 *     puisse relire, versionner et faire relire la structure sans le secret ;
 *   - la sélection des vaults est à la charge de l'appelant, et le CLI la rend
 *     explicite : on n'exporte pas 22 clés par défaut.
 *
 * ── L'HÔTE ─────────────────────────────────────────────────────────────────
 *
 * Les serveurs REST des vaults écoutent sur la loopback du POSTE. Un routeur
 * distant les atteint par les `RemoteForward` du tunnel SSH : côté distant,
 * l'adresse reste donc `127.0.0.1:<port>`. C'est le défaut. Un hôte non-
 * loopback est accepté mais signalé : il tombe sous la garde globale
 * `OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK`, qui refuse de démarrer si un vault
 * est servi hors loopback et hors maille WireGuard.
 */

/** Marque-place émis à la place d'une clé. Jamais une vraie valeur. */
export const API_KEY_PLACEHOLDER = '<apiKey>';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Un hôte est-il une chaîne que l'on peut sans danger interpoler dans une URL ?
 *
 * FAILLE CORRIGÉE (trouvée en revue, 2026-08-31, AVANT publication). La
 * première version testait `host.startsWith('10.8.0.')`. Or `'10.8.0.1 [arobase] attacker.example'`
 * commence bien par ce préfixe — et, interpolé dans `https://<host>:<port>`,
 * le `10.8.0.1` devient de l'**userinfo** : l'hôte réellement contacté est
 * `attacker.example`, et **la clé d'API y part**. Vérifié par exécution :
 *
 *     new URL('https://10.8.0.1 [arobase] attacker.example:27126').hostname
 *       === 'attacker.example'
 *
 * Un préfixe de chaîne n'est donc pas un test d'appartenance réseau. On refuse
 * ici tout ce qui n'est pas un hôte NU : ni userinfo (`@`), ni séparateur
 * d'URL (`/ ? # \ : espace`), ni chaîne vide.
 */
function isBareHost(host) {
  return typeof host === 'string'
    && host.length > 0
    && host.length <= 253
    && !/[@/?#\\\s[\]]/.test(host)
    && !host.includes(':');            // exclut aussi un port collé et l'IPv6 nu
}

/** Une adresse IPv4 littérale, chaque octet dans [0,255], sans zéro non significatif. */
function parseIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map((p) => (/^0\d/.test(p) ? NaN : Number(p)));
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return parts;
}

/**
 * True quand l'hôte passe la garde `ENFORCE_WG_OR_LOOPBACK` sans réglage.
 *
 * Appartenance RÉELLE à 10.8.0.0/24 — pas un préfixe de chaîne. `::1` est
 * accepté comme loopback ; `buildRemoteVaultEntry` se charge de l'encadrer de
 * crochets, sans quoi l'URL produite est invalide.
 */
export function hostPassesTransportGuard(host) {
  if (host === '::1') return true;
  if (!isBareHost(host)) return false;
  if (LOOPBACK.has(host)) return true;
  const ip = parseIPv4(host);
  return ip !== null && ip[0] === 10 && ip[1] === 8 && ip[2] === 0;
}

/**
 * Normalise un nom de vault en suffixe de variable d'environnement.
 *
 * `VAULT_<NOM>` : le routeur ne lit que le préfixe, mais un nom comportant un
 * espace ou un tiret ne peut pas être exporté tel quel par un shell. On met
 * donc en majuscules et on remplace tout ce qui n'est pas alphanumérique.
 */
export function envKeyForVault(name) {
  const slug = String(name ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!slug) throw new Error('envKeyForVault: nom de vault vide après normalisation');
  return `VAULT_${slug}`;
}

/**
 * Une entrée `remoteVaults`, à partir d'un vault du parc local.
 *
 * @param {{name:string, port:number, apiKey:string, host?:string,
 *          tlsInsecure?:boolean, description?:string, timeoutMs?:number}} v
 * @returns {{name,baseUrl,apiKey,tlsInsecure,description?,timeoutMs?}}
 */
export function buildRemoteVaultEntry(v) {
  const name = String(v?.name ?? '').trim();
  if (!name) throw new Error('buildRemoteVaultEntry: `name` requis');
  if (!Number.isInteger(v?.port) || v.port < 1 || v.port > 65535) {
    throw new Error(`buildRemoteVaultEntry: port invalide pour "${name}"`);
  }
  if (typeof v?.apiKey !== 'string' || v.apiKey.length === 0) {
    // Le message ne cite JAMAIS la valeur — seulement le vault concerné.
    throw new Error(
      `buildRemoteVaultEntry: aucune clé d'API pour "${name}". ` +
      `Ouvrez ce vault dans Obsidian et activez Local REST API, ou retirez-le de la sélection.`,
    );
  }
  const host = v.host || '127.0.0.1';
  // REFUS AVANT INTERPOLATION. Un hôte qui n'est pas nu peut détourner l'URL
  // entière — `10.8.0.1 [arobase] attaquant.example` envoie la clé chez l'attaquant.
  // On refuse ici plutôt que de produire une URL que le client suivra.
  if (host !== '::1' && !isBareHost(host)) {
    throw new Error(
      `buildRemoteVaultEntry: hôte invalide pour "${name}". ` +
      `Un hôte doit être nu : ni identifiants (@), ni séparateur d'URL, ni port collé. ` +
      `Une valeur comme "10.8.0.1 [arobase] ailleurs.example" ferait partir la clé d'API vers "ailleurs.example".`,
    );
  }
  // IPv6 littéral : sans crochets, `https://::1:27126` n'est pas une URL valide.
  const hostForUrl = host.includes(':') ? `[${host}]` : host;
  const entry = {
    name,
    // HTTPS : le plugin Local REST API sert le TLS sur `port`; le port en clair
    // (`insecurePort`) n'est PAS exporté ici — il ne sert qu'au click-to-open
    // local, et l'exposer à distance élargirait la surface pour rien.
    baseUrl: `https://${hostForUrl}:${v.port}`,
    apiKey: v.apiKey,
    // Certificat auto-signé du plugin : la vérification échouerait toujours.
    tlsInsecure: v.tlsInsecure ?? true,
  };
  if (v.description) entry.description = String(v.description);
  if (Number.isInteger(v.timeoutMs)) entry.timeoutMs = v.timeoutMs;
  return entry;
}

/**
 * La configuration complète d'un routeur sans disque de vault.
 *
 * `portRegistry` est délibérément VIDE : c'est la branche « vault local » qui
 * déclenche la lecture de `data.json`, et la vider est précisément ce qui
 * supprime le couplage.
 *
 * @returns {{ config: object, warnings: string[] }}
 */
export function buildRemoteConfig({ vaults, host, defaultVault } = {}) {
  if (!Array.isArray(vaults) || vaults.length === 0) {
    throw new Error('buildRemoteConfig: `vaults` doit être une liste non vide — la sélection est explicite par conception.');
  }
  const warnings = [];
  const effectiveHost = host || '127.0.0.1';
  if (!hostPassesTransportGuard(effectiveHost)) {
    warnings.push(
      `L'hôte "${effectiveHost}" n'est ni loopback ni dans la maille WireGuard (10.8.0.0/24). ` +
      `Le routeur REFUSERA de démarrer si OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK est activé.`,
    );
  }

  const seen = new Set();
  const remoteVaults = [];
  for (const v of vaults) {
    const entry = buildRemoteVaultEntry({ ...v, host: effectiveHost });
    if (seen.has(entry.name)) {
      throw new Error(`buildRemoteConfig: nom de vault dupliqué "${entry.name}" — le routeur ne pourrait pas les distinguer.`);
    }
    seen.add(entry.name);
    remoteVaults.push(entry);
  }

  const config = {
    _comment: 'Profil HTTP-only : les vaults sont adressés par REST, la clé vient de CE fichier. Généré par scripts/gen-remote-config.mjs — voir la page de vault matrice-http-only-lot0.',
    referenceVault: null,
    // VIDE À DESSEIN : une entrée ici ferait relire le data.json du vault sur
    // disque pour y prendre la clé, ce que ce profil existe pour éviter.
    portRegistry: {},
    remoteVaults,
  };
  if (defaultVault) {
    if (!seen.has(defaultVault)) {
      throw new Error(`buildRemoteConfig: defaultVault "${defaultVault}" n'est pas dans la sélection.`);
    }
    config.defaultVault = defaultVault;
  }
  return { config, warnings };
}

/**
 * Les lignes `VAULT_<NOM>=<json>` équivalentes, pour un hôte qui préfère les
 * variables d'environnement au fichier (MCPHub, systemd, conteneur).
 *
 * Même contenu, autre transport — et la SEULE différence de sûreté est qui peut
 * lire l'environnement d'un processus contre qui peut lire un fichier.
 */
export function buildEnvLines({ vaults, host } = {}) {
  const { config } = buildRemoteConfig({ vaults, host });
  // COLLISION DE NORMALISATION (trouvée en revue) : `a-b` et `a b` donnent tous
  // deux `VAULT_A_B`. Deux vaults distincts se réduiraient à une seule variable,
  // et le routeur n'en verrait qu'un — une PERTE silencieuse. La forme JSON,
  // elle, garde les deux : seule la sortie `env` est concernée.
  const byKey = new Map();
  for (const v of config.remoteVaults) {
    const key = envKeyForVault(v.name);
    if (byKey.has(key)) {
      throw new Error(
        `buildEnvLines: "${byKey.get(key)}" et "${v.name}" se normalisent tous deux en ${key}. ` +
        `Une seule variable survivrait et un vault disparaîtrait en silence. ` +
        `Renommez-en un, ou utilisez le format JSON qui n'a pas cette contrainte.`,
      );
    }
    byKey.set(key, v.name);
  }
  return config.remoteVaults.map((v) => `${envKeyForVault(v.name)}=${JSON.stringify(v)}`);
}

/**
 * La même structure, clés remplacées par un marque-place.
 *
 * C'est la sortie PAR DÉFAUT du CLI : on peut la relire, la coller dans une
 * revue, la versionner. Rien ici ne doit jamais redevenir un secret par
 * accident, d'où une copie profonde plutôt qu'une mutation.
 */
export function redactConfig(config) {
  const clone = JSON.parse(JSON.stringify(config ?? {}));
  for (const v of clone.remoteVaults ?? []) {
    if ('apiKey' in v) v.apiKey = API_KEY_PLACEHOLDER;
  }
  return clone;
}

/**
 * Idem pour les lignes d'environnement.
 *
 * PARSE puis re-sérialise, plutôt qu'une expression régulière sur la chaîne.
 * La version regex (`"apiKey":"[^"]*"`) s'arrêtait au premier guillemet et
 * laissait donc un SUFFIXE de clé en clair dès qu'elle contenait un guillemet
 * échappé. Les clés du plugin sont hexadécimales, donc le cas ne se présente
 * pas aujourd'hui — mais le constructeur accepte n'importe quelle chaîne non
 * vide, et une rédaction qui ne tient que par la forme de son entrée n'est pas
 * une rédaction. (Trouvé en revue, 2026-08-31.)
 */
export function redactEnvLines(lines) {
  return (lines ?? []).map((line) => {
    const i = String(line).indexOf('=');
    if (i === -1) return line;
    const key = line.slice(0, i);
    const json = line.slice(i + 1);
    try {
      const parsed = JSON.parse(json);
      if (parsed && typeof parsed === 'object' && 'apiKey' in parsed) {
        parsed.apiKey = API_KEY_PLACEHOLDER;
      }
      return `${key}=${JSON.stringify(parsed)}`;
    } catch {
      // Illisible : on ne peut PAS garantir la rédaction, donc on ne rend pas
      // la ligne. Taire la valeur vaut mieux que la laisser passer à moitié.
      return `${key}=${API_KEY_PLACEHOLDER}`;
    }
  });
}

/**
 * Vrai si la valeur ressemble à une clé du plugin Local REST API.
 *
 * Sert de garde-fou au CLI : refuser d'écrire un fichier « de secrets » qui
 * n'en contient aucun (signe d'une lecture ratée) est plus utile que de le
 * produire vide et de le croire bon.
 */
export function looksLikeApiKey(s) {
  return typeof s === 'string' && /^[0-9a-f]{32,}$/i.test(s);
}
