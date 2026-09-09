/**
 * Why a vault is not answering — and what, if anything, the user can do.
 *
 * ---------------------------------------------------------------------------
 * THE ONE SENTENCE THIS MODULE EXISTS TO STOP SAYING
 * ---------------------------------------------------------------------------
 * "Open this vault in Obsidian."
 *
 * It is the right advice for exactly ONE of the eight situations below, and it
 * was being given for most of them. It does not help when another process holds
 * the port (a window cannot take a port back). It does not help when the stored
 * key is stale (the server is right there, refusing). It does not help when the
 * port moved on disk (the router is now dialling the new one, and reading
 * `data.json` needed no server at all). Advice that cannot work, given
 * confidently, is worse than "I do not know": it sends someone to do something
 * for ten minutes and teaches them the tool is unreliable.
 *
 * ---------------------------------------------------------------------------
 * THREE FACTS THAT KEEP BEING CONFLATED
 * ---------------------------------------------------------------------------
 *   - A port is CONFIGURED. Read off `data.json`, no server required.
 *   - A server ANSWERS. Something is listening on that port. Not necessarily
 *     Obsidian, and not necessarily this vault.
 *   - An identity is VERIFIED. What answered accepted THIS vault's key.
 *
 * Every message below names which of the three it is claiming, and none of them
 * claims a cause it has not observed. In particular, nothing here blames
 * synchronisation for a drift: Google Drive is a plausible explanation for a
 * port that changed, and a plausible explanation stated as a fact is how a user
 * stops looking for the real one.
 *
 * PURE. No fs, no network, no clock. It is handed observations and returns a
 * verdict with the sentences to show.
 */

/** The eight distinguishable situations. */
export const REACHABILITY = Object.freeze({
  /** Disk and registry agree, the server answered, identity confirmed. */
  HEALTHY: 'healthy',
  /** The port moved on disk; the router followed it and the server answered. */
  DRIFTED_REACHABLE: 'drifted-reachable',
  /** The port moved on disk; nothing answers there. */
  DRIFTED_UNREACHABLE: 'drifted-unreachable',
  /** Something answered and refused this vault's key. */
  AUTH_FAILED: 'auth-failed',
  /** Two vaults declare the same port. */
  COLLISION: 'collision',
  /** Something answered but could not be shown to be this vault. */
  IDENTITY_UNVERIFIED: 'identity-unverified',
  /** `data.json` is missing, unreadable or damaged. */
  CONFIG_UNREADABLE: 'config-unreadable',
  /** The plaintext server is configured off. */
  HTTP_DISABLED: 'http-disabled',
  /** Nothing answered, and nothing else is known to be wrong. */
  UNREACHABLE: 'unreachable',
});

/**
 * @param {object} args
 * @param {object} args.endpointState from `resolveLocalRestState`
 * @param {{answered: boolean, authenticated: boolean|null, identity: string|null}} [args.probeResult]
 * @param {Array} [args.collisions] findings naming this vault
 * @param {string} [args.identityStatus]
 * @param {string} [args.name]
 * @returns {{status: string, diagnostics: object[], suggestedActions: object[]}}
 */
export function classifyVaultReachability({
  endpointState,
  probeResult = null,
  collisions = [],
  identityStatus = 'ok',
  name = 'this vault',
} = {}) {
  const diagnostics = [];
  const suggestedActions = [];

  const drift = (endpointState?.issues ?? []).concat(endpointState?.drift ?? []);
  const httpsSource = endpointState?.httpsSource ?? 'none';
  const effective = endpointState?.effectivePorts ?? { https: null, http: null };
  const registered = endpointState?.registeredPorts ?? { https: null, http: null };
  const hasDrift = Number.isInteger(registered.https)
    && Number.isInteger(effective.https)
    && registered.https !== effective.https;

  const answered = probeResult?.answered === true;

  // Ordered by how much each fact EXCLUDES, not by severity: a collision
  // explains an unreachable vault, so it has to be considered before the
  // silence it causes is reported as its own mystery.
  if (Array.isArray(collisions) && collisions.length > 0) {
    diagnostics.push({
      kind: 'collision',
      severity: 'error',
      message:
        `Another service or vault uses the port ${name} expects. Opening Obsidian may not be ` +
        'enough — whichever server starts second simply fails to bind. No port was changed.',
    });
    return { status: REACHABILITY.COLLISION, diagnostics, suggestedActions };
  }

  if (identityStatus === 'invalid' || identityStatus === 'unreadable'
    || (endpointState?.issues ?? []).some((i) => i.kind === 'rest-data-invalid' || i.kind === 'rest-data-unreadable')) {
    diagnostics.push({
      kind: 'config-unreadable',
      severity: 'error',
      message:
        `${name}'s local configuration could not be read or understood. Nothing about its ports can ` +
        'be asserted, and nothing was written.',
    });
    return { status: REACHABILITY.CONFIG_UNREADABLE, diagnostics, suggestedActions };
  }

  if (hasDrift) {
    diagnostics.push({
      kind: 'port-drift',
      severity: 'warning',
      message:
        `The HTTPS port of "${name}" changed from ${registered.https} to ${effective.https} in its ` +
        `local configuration. The router now uses ${effective.https}. Its local record can be ` +
        'refreshed; no port of the vault will be modified.',
    });
    suggestedActions.push({
      kind: 'reconcile-registry',
      // Local bookkeeping only — it never writes into the vault.
      command: 'node scripts/setup-vault.mjs --sync-port-registry',
      writesVault: false,
    });
  }

  if (answered && probeResult?.authenticated === false) {
    diagnostics.push({
      kind: 'auth-failed',
      severity: 'error',
      message:
        `A server is answering on ${name}'s port and REFUSED the key stored for it. Two causes look ` +
        'identical from here: something else holds the port, or the stored key is stale. Opening a ' +
        'window fixes neither.',
    });
    return { status: REACHABILITY.AUTH_FAILED, diagnostics, suggestedActions };
  }

  if (answered && probeResult?.identity === 'unverified') {
    diagnostics.push({
      kind: 'identity-unverified',
      severity: 'warning',
      message:
        `Something answered on ${name}'s port, but it could not be shown to be this vault. Treat ` +
        'that as liveness, never as confirmation.',
    });
    return { status: REACHABILITY.IDENTITY_UNVERIFIED, diagnostics, suggestedActions };
  }

  if (!answered) {
    if (hasDrift || httpsSource === 'disk') {
      diagnostics.push({
        kind: 'drifted-unreachable',
        severity: 'warning',
        message:
          `The configuration says HTTPS ${effective.https}, but the server does not respond. Open ` +
          `${name} in Obsidian or reload its Local REST API plugin, then check again.`,
      });
      suggestedActions.push({ kind: 'open-obsidian', writesVault: false });
      return { status: REACHABILITY.DRIFTED_UNREACHABLE, diagnostics, suggestedActions };
    }
    diagnostics.push({
      kind: 'unreachable',
      severity: 'warning',
      message: `Nothing answered on ${name}'s port. Its Obsidian may simply not be running.`,
    });
    suggestedActions.push({ kind: 'open-obsidian', writesVault: false });
    return { status: REACHABILITY.UNREACHABLE, diagnostics, suggestedActions };
  }

  // Answering, authenticated. The remaining thing worth saying is about the
  // plaintext side, which has its own switch.
  if (endpointState?.httpEnabled === false) {
    diagnostics.push({
      kind: 'http-disabled',
      severity: 'info',
      message:
        `${name} answers, but its plaintext HTTP server is switched off, so no click-to-open link ` +
        'is available for it — the port number recorded for it is not a promise that anything is ' +
        'listening.',
    });
    return {
      status: hasDrift ? REACHABILITY.DRIFTED_REACHABLE : REACHABILITY.HTTP_DISABLED,
      diagnostics,
      suggestedActions,
    };
  }

  return {
    status: hasDrift ? REACHABILITY.DRIFTED_REACHABLE : REACHABILITY.HEALTHY,
    diagnostics,
    suggestedActions,
  };
}

/**
 * What an explicit local refresh would change — registry only, never a vault.
 *
 * @returns {{changes: object[], writesVault: false, wouldChange: number}}
 */
export function planLocalRegistryReconciliation({ cfg, observations = [] } = {}) {
  const changes = [];
  for (const obs of observations) {
    const registered = obs.registeredPorts ?? { https: null, http: null };
    const effective = obs.effectivePorts ?? { https: null, http: null };
    for (const protocol of ['https', 'http']) {
      const from = registered[protocol];
      const to = effective[protocol];
      if (!Number.isInteger(to)) continue;
      if (from === to) continue;
      changes.push({ path: obs.path, protocol, from: Number.isInteger(from) ? from : null, to, source: obs.source ?? 'disk' });
    }
  }
  return {
    changes,
    // Stated as a literal in the returned plan, not merely in a comment: this
    // operation writes the router's own record and never a vault's file.
    writesVault: false,
    wouldChange: changes.length,
  };
}

/**
 * Suppress an IDENTICAL repeat, and only that.
 *
 * A boolean latch would silence a CHANGED situation — the fleet's most useful
 * message is the one that appears when something new breaks, and that is
 * precisely the one a "already warned" flag eats. Fingerprinting the finding
 * set keeps reload spam away while letting a changed state speak; the same
 * shape the port-collision report already uses.
 */
export function makeDiagnosticDeduper() {
  let lastFingerprint = null;
  return function shouldReport(diagnostics) {
    const fingerprint = (diagnostics ?? [])
      .map((d) => `${d.kind}:${d.path ?? ''}:${d.from ?? ''}:${d.to ?? ''}`)
      .sort()
      .join('|');
    if (fingerprint === '') {
      lastFingerprint = null;
      return false;
    }
    if (fingerprint === lastFingerprint) return false;
    lastFingerprint = fingerprint;
    return true;
  };
}
