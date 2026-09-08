/**
 * Which ports the router ACTUALLY talks to, and why they differ from what the
 * registry remembers.
 *
 * ---------------------------------------------------------------------------
 * THE ASYMMETRY THIS FIXES
 * ---------------------------------------------------------------------------
 * Until now `registry.mjs` resolved the two ports of a local vault by two
 * different rules:
 *
 *     insecurePort (HTTP)  = data.json, else the registry     ← disk first
 *     baseUrl      (HTTPS) = the registry, full stop          ← registry only
 *
 * So the router could READ a vault's real HTTPS port off the disk, report a
 * drift about it, and then go on calling the old one. Measured on 2026-09-08:
 * moving `recherches-etudes-sup` to HTTPS 27192 required hand-editing BOTH the
 * vault's `data.json` and the router's `config.json`, because editing only the
 * first left the router dialling 27124 — a port that by then belonged to
 * nobody. The vault looked closed. It was not.
 *
 * `data.json` is what the Local REST API plugin actually binds. A registry that
 * disagrees with it is stale bookkeeping, not a second opinion.
 *
 * ---------------------------------------------------------------------------
 * THREE STATES FOR THE DISK, NEVER TWO
 * ---------------------------------------------------------------------------
 * The same distinction `click-to-open.mjs` had to make in v0.79.0, and for the
 * same reason — collapsing the last two is what makes a remembered port either
 * unreachable or wrongly authoritative:
 *
 *   - readable and valid → its port wins, and the source is reported as `disk`.
 *   - readable and WRONG (a port of 0, of 70000, of "27124") → the file is not
 *     silently trusted and not silently ignored either: the registry supplies
 *     the value and an `invalid-port` issue says the file disagrees with itself.
 *   - unreadable / absent / unparseable → the disk has no opinion. The registry
 *     answers, and the issue says which of the three it was. An absent file and
 *     a corrupt one are DIFFERENT facts about a vault and are never merged.
 *
 * ---------------------------------------------------------------------------
 * A PORT NUMBER IS NOT AN ANNOUNCEMENT THAT THE SERVER IS ON
 * ---------------------------------------------------------------------------
 * `enableInsecureServer: false` with an `insecurePort` still set is the normal
 * shape of a vault whose plaintext server was turned off: the plugin keeps the
 * number and stops binding it. Reading availability off the presence of the
 * number is how a click-to-open link gets emitted for a socket nobody is
 * listening on. So `httpEnabled` is a THIRD value, not a derived one:
 *
 *   true   → the file says so, in as many words.
 *   false  → the file says otherwise, or says nothing (the plugin's own default
 *            is `enableInsecureServer: false`).
 *   null   → the file could not be read. UNKNOWN, which is not `false`: the
 *            caller may still use a remembered number on a best-effort basis,
 *            exactly as `click-to-open.mjs` does, but it must not tell the user
 *            the link is known to work.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE MAY NOT DO
 * ---------------------------------------------------------------------------
 * It is PURE. No `fs`, no `net`, no clock, no `process`. It is handed the
 * already-read shapes and returns a verdict, so that the whole state machine is
 * testable without a disk. The reading lives in `registry.mjs`; the probing
 * lives behind the REST client.
 *
 * And it never mutates anything. Invariant I8: load, status, drift detection
 * and `list_vaults` do not rewrite ports. Using the disk's port IN MEMORY and
 * persisting it to the registry are two different operations, and only the
 * second one is a migration — decision D6, 2026-09-09.
 *
 * NO SECRETS EVER LEAVE HERE. `data.json` also holds the vault's API key and
 * its TLS private key. Only the three port-shaped fields are ever passed in,
 * and no diagnostic string is built from anything else. Invariant I3.
 */

import { MAX_PORT } from './port-registry.mjs';

/** The four things a vault's `data.json` can be, from the reader's side. */
export const REST_DATA_STATUS = Object.freeze({
  /** Read, parsed, and an object. Its fields may still be individually wrong. */
  OK: 'ok',
  /** No such file — the plugin was never configured for this vault. */
  ABSENT: 'absent',
  /** The file is there but this process could not read it (permissions, an
   *  unplugged drive, a path shape this runtime cannot resolve). */
  UNREADABLE: 'unreadable',
  /** Read, but not parseable JSON, or parsed to something that is not an
   *  object. A DISTINCT fact from "absent": one means unconfigured, the other
   *  means damaged, and they call for different actions. */
  INVALID: 'invalid',
});

const VALID_STATUSES = new Set(Object.values(REST_DATA_STATUS));

/** Where an effective port came from. `none` = nobody knows it. */
export const PORT_SOURCE = Object.freeze({
  DISK: 'disk',
  REGISTRY: 'registry',
  NONE: 'none',
});

function isPort(n) {
  return Number.isInteger(n) && n > 0 && n <= MAX_PORT;
}

/**
 * True when a raw `data.json` field is PRESENT but not a usable port.
 *
 * `undefined` and `null` mean the file simply does not carry the field, which
 * is ordinary and silent. `0`, `"27124"`, `70000`, `{}` mean the file carries
 * something that was meant to be a port and is not one — that is worth saying
 * out loud, because the plugin will not bind it either and the vault will look
 * closed for a reason nobody would guess.
 */
function isPresentButNotAPort(raw) {
  if (raw === undefined || raw === null) return false;
  return !isPort(raw);
}

/**
 * Resolve the ports the router will actually use for one local vault.
 *
 * @param {object}  args
 * @param {{https: number|null, http: number|null}} [args.registryPorts]
 *        The vault's normalized `portRegistry` entry (see `normalizePortEntry`).
 * @param {object|null} [args.restData]
 *        The already-read `data.json` fields: `{ port, insecurePort,
 *        enableInsecureServer, rawPort, rawInsecurePort }`. The `raw*` fields
 *        carry the values BEFORE port validation so a present-but-invalid one
 *        can be told apart from an absent one. Never the API key.
 * @param {string} [args.restDataStatus] One of `REST_DATA_STATUS`.
 * @returns {{
 *   effectivePorts: {https: number|null, http: number|null},
 *   httpsSource: string,
 *   httpSource: string,
 *   httpEnabled: boolean|null,
 *   issues: Array<{kind: string, severity: string, message: string, protocol?: string}>
 * }}
 */
export function resolveLocalRestState({ registryPorts, restData, restDataStatus } = {}) {
  const registry = {
    https: isPort(registryPorts?.https) ? registryPorts.https : null,
    http: isPort(registryPorts?.http) ? registryPorts.http : null,
  };

  const issues = [];

  // An unrecognised status is treated as `invalid` rather than as `ok`. A typo
  // in a caller must not promote an unread file to authoritative.
  const status = VALID_STATUSES.has(restDataStatus)
    ? restDataStatus
    : REST_DATA_STATUS.INVALID;

  // `ok` with a non-object payload is the same fact as `invalid`: the reader
  // and the payload disagree, and the payload is what we would have to trust.
  const usable =
    status === REST_DATA_STATUS.OK &&
    Boolean(restData) &&
    typeof restData === 'object' &&
    !Array.isArray(restData);

  if (!usable) {
    if (status === REST_DATA_STATUS.ABSENT) {
      issues.push({
        kind: 'rest-data-absent',
        severity: 'warning',
        message:
          'No Local REST API data.json for this vault — the plugin has never been ' +
          'configured here. Ports fall back to the router\'s registry, which is a ' +
          'memory of a past setup, not what any server is binding today.',
      });
    } else if (status === REST_DATA_STATUS.UNREADABLE) {
      issues.push({
        kind: 'rest-data-unreadable',
        severity: 'warning',
        message:
          'This vault\'s Local REST API data.json could not be read (permissions, an ' +
          'unavailable drive, or a path this runtime cannot resolve). Ports fall back ' +
          'to the router\'s registry; a drift on disk would be invisible right now.',
      });
    } else {
      issues.push({
        kind: 'rest-data-invalid',
        severity: 'error',
        message:
          'This vault\'s Local REST API data.json is present but not usable JSON. It is ' +
          'NOT treated as missing: something damaged a configured file. Ports fall back ' +
          'to the router\'s registry until it is repaired.',
      });
    }

    return {
      effectivePorts: { https: registry.https, http: registry.http },
      httpsSource: registry.https === null ? PORT_SOURCE.NONE : PORT_SOURCE.REGISTRY,
      httpSource: registry.http === null ? PORT_SOURCE.NONE : PORT_SOURCE.REGISTRY,
      // UNKNOWN, not false. The file is the only thing that can say, and it
      // did not get to speak.
      httpEnabled: null,
      issues,
    };
  }

  const diskHttps = isPort(restData.port) ? restData.port : null;
  const diskHttp = isPort(restData.insecurePort) ? restData.insecurePort : null;

  if (isPresentButNotAPort(restData.rawPort)) {
    issues.push({
      kind: 'invalid-port',
      severity: 'error',
      protocol: 'https',
      message:
        'The HTTPS port in this vault\'s data.json is not a usable port number. The ' +
        'plugin will not bind it either, so the vault will look closed. The router ' +
        'falls back to its registry value for now.',
    });
  }
  if (isPresentButNotAPort(restData.rawInsecurePort)) {
    issues.push({
      kind: 'invalid-port',
      severity: 'error',
      protocol: 'http',
      message:
        'The plaintext HTTP port in this vault\'s data.json is not a usable port ' +
        'number. Click-to-open links cannot be built from it; the router falls back ' +
        'to its registry value for now.',
    });
  }

  const https = diskHttps ?? registry.https;
  const http = diskHttp ?? registry.http;

  // Strictly `=== true`. The plugin's own DEFAULT_SETTINGS has
  // `enableInsecureServer: false`, so an ABSENT field means off, and a truthy
  // string like "false" must not turn it on.
  const httpEnabled = restData.enableInsecureServer === true;

  if (httpEnabled && http === null) {
    issues.push({
      kind: 'http-enabled-without-port',
      severity: 'warning',
      protocol: 'http',
      message:
        'This vault says its plaintext HTTP server is enabled but names no port for ' +
        'it. Nothing can be dialled and no click-to-open link can be built.',
    });
  }

  return {
    effectivePorts: { https, http },
    httpsSource:
      diskHttps !== null
        ? PORT_SOURCE.DISK
        : registry.https !== null
          ? PORT_SOURCE.REGISTRY
          : PORT_SOURCE.NONE,
    httpSource:
      diskHttp !== null
        ? PORT_SOURCE.DISK
        : registry.http !== null
          ? PORT_SOURCE.REGISTRY
          : PORT_SOURCE.NONE,
    httpEnabled,
    issues,
  };
}

/**
 * Say, per protocol, how the port the router is using differs from the one its
 * registry declares — and where the difference came from.
 *
 * ONLY DESCRIBES. Detecting a drift never allocates, never repairs and never
 * writes: the user is told the old value, the new value and the source, and
 * decides. That is decision D6 — the drift is used in memory, and reconciling
 * the registry is a separate, explicit act.
 *
 * A drift needs BOTH values to exist. A registry that has never recorded a port
 * has not drifted from anything; that is a different diagnostic
 * (`port-unrecorded`), because the action it calls for is recording, not
 * reconciling.
 *
 * @param {object} args
 * @param {string|null} [args.vaultId] The durable vault UUID once lot 4 lands;
 *        carried through now so diagnostics do not have to be re-shaped later.
 * @param {string} args.path
 * @param {string} args.name
 * @param {{https: number|null, http: number|null}} args.registeredPorts
 * @param {{https: number|null, http: number|null}} args.effectivePorts
 * @param {{https?: string, http?: string}} [args.sources]
 * @returns {Array<object>} Diagnostics. Never contains a secret.
 */
export function describeEndpointDrift({
  vaultId = null,
  path,
  name,
  registeredPorts,
  effectivePorts,
  sources = {},
} = {}) {
  const diagnostics = [];

  for (const protocol of ['https', 'http']) {
    const registered = isPort(registeredPorts?.[protocol]) ? registeredPorts[protocol] : null;
    const effective = isPort(effectivePorts?.[protocol]) ? effectivePorts[protocol] : null;
    const source = sources?.[protocol] ?? PORT_SOURCE.NONE;

    if (registered !== null && effective !== null && registered !== effective) {
      const label = protocol === 'https' ? 'HTTPS' : 'plaintext HTTP';
      diagnostics.push({
        kind: 'port-drift',
        severity: 'warning',
        protocol,
        vaultId,
        path,
        name,
        from: registered,
        to: effective,
        source,
        message:
          `The ${label} port of "${name}" changed from ${registered} to ${effective} in ` +
          `its own configuration. The router now uses ${effective}. Its local record can ` +
          `be refreshed; no port of the vault will be modified.`,
      });
      continue;
    }

    if (registered === null && effective !== null && source === PORT_SOURCE.DISK) {
      const label = protocol === 'https' ? 'HTTPS' : 'plaintext HTTP';
      diagnostics.push({
        kind: 'port-unrecorded',
        severity: 'info',
        protocol,
        vaultId,
        path,
        name,
        from: null,
        to: effective,
        source,
        message:
          `"${name}" binds ${label} port ${effective} on disk, and the router's registry ` +
          `records no ${label} port for it. Nothing is broken; the record is incomplete.`,
      });
    }
  }

  return diagnostics;
}
