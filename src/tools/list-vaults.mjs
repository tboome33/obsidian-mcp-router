/**
 * list_vaults — meta-tool that returns the catalogue of configured vaults
 * along with their online status and latency.
 *
 * Pings each ACTIVE vault in parallel. Disabled vaults are surfaced in a
 * separate `disabled[]` field with their reason — they are NOT pinged
 * (no point: they're hidden from the MCP surface, and pinging them
 * would just add latency and timeout noise).
 *
 * v0.10.0 — adds top-level `defaultVaultStatus` field. Surfaces whether
 * the default vault is reachable at session start, together with an
 * `obsidian://open?vault=<obsidianName>` URI the convention
 * `default-vault-health-check` uses to compose a clickable one-click
 * fix in the natural-language warning. See
 * `wiki/obsidian-mcp-router/router-ux-improvements-roadmap.md` Phase 1.
 */
import { pingVault } from '../rest-client.mjs';
import { pathBasename } from '../registry.mjs';
import { probeConversionToolbox } from '../helpers/conversion-readiness.mjs';
import { DEFAULT_PROJECT_ROOT as PROJECT_ROOT } from '../markdownify/markitdown.mjs';
import { isVaultReachable } from '../helpers/vault-reach.mjs';
import { sharingRequirement } from '../helpers/vault-sharing.mjs';
import { HINT_STATUS } from '../helpers/workspace-bindings.mjs';

/**
 * The complete vocabulary of `*Source.origin` — the ONE authoritative list.
 * The tool description explains every one of these, a test proves it does, and
 * `listVaults` refuses to emit anything outside it. A tenth value is added
 * here first, and the test says where else it has to be explained.
 */
export const SETTING_ORIGINS = Object.freeze([
  'binding', 'workspace-dotenv', 'host', 'runtime', 'config',
  'first-healthy', 'first-active', 'default', 'unset', 'unknown',
]);
const SETTING_ORIGIN_SET = new Set(SETTING_ORIGINS);
/**
 * Build the `defaultVaultStatus` summary for the list_vaults response.
 *
 * Exported as a pure helper (no I/O) so unit tests can exercise the URI
 * composition + null cases without needing to ping real vaults.
 *
 * Parameters:
 *  - `defaultVaultName`: registry.defaultVault — the resolved slug, or
 *    null/undefined when no vault matched the resolution cascade.
 *  - `pingedResults`: the `results[]` array built by `listVaults`. Each
 *    entry must carry `{ name, type, path?, online, error?, missingApiKey? }`.
 *
 * Returns null when:
 *  - `defaultVaultName` is falsy (empty registry / no cascade match)
 *  - `defaultVaultName` doesn't match any entry in `pingedResults`
 *    (post-load mutation — leave for the convention layer to surface)
 *
 * Otherwise returns a frozen-shape object: `{ name, obsidianName, type,
 * online, error, missingApiKey, openUri, path }`. `path` is `null` for
 * remote vaults (no on-disk folder to derive a basename from).
 *
 * For LOCAL vaults the obsidian:// URI handler matches against the vault
 * label registered in Obsidian itself, which is the on-disk folder
 * basename WITH its on-disk casing. The router slug is lowercased
 * (defaultNameFromPath), so we need the exact-case basename here.
 *
 * For REMOTE vaults there's no local Obsidian to open. We still emit an
 * openUri using the router slug — the convention layer can branch on
 * `type !== 'local'` to skip the suggestion, but a remote vault MAY also
 * be opened locally if the user happens to have a clone, so surfacing
 * the URI is harmless.
 */
export function buildDefaultVaultStatus(defaultVaultName, pingedResults) {
  if (!defaultVaultName) return null;
  const def = pingedResults.find((r) => r.name === defaultVaultName);
  if (!def) return null;
  const defPath = def.path; // undefined for remote vaults
  const obsidianName = defPath ? pathBasename(defPath) : def.name;
  const openUri = `obsidian://open?vault=${encodeURIComponent(obsidianName)}`;
  return {
    name: def.name,
    obsidianName,
    type: def.type,
    online: def.online,
    error: def.error || null,
    missingApiKey: def.missingApiKey || false,
    openUri,
    path: defPath || null,
  };
}

export async function listVaults(registry, sharedConfig = null) {
  // Reachability (decision portee-et-mode-ecriture-des-vaults §1, trap 4 of
  // the page: "list_vaults must keep SHOWING what's unreachable, never hide
  // it"). Computed LIVE against `registry.workspaceBinding` for the same
  // reason `resolveVault()` does — see helpers/vault-reach.mjs's header — so
  // this partition can never go stale relative to what resolveVault() would
  // actually accept a moment later. A no-op split (everything reachable)
  // when `vaultReach` is inactive, which is the default.
  const [reachable, unreachable] = registry.vaults.reduce(
    (acc, v) => { acc[isVaultReachable(v.name, registry) ? 0 : 1].push(v); return acc; },
    [[], []],
  );

  const results = await Promise.all(
    reachable.map(async (v) => {
      const ping = await pingVault(v);
      // WHICH VAULTS DEMAND A PRECONDITION, said BEFORE a write is refused
      // rather than only by the refusal (Phase 4 of portee-ergonomie-refus-
      // roadmap, decision ergonomie-creation-liaison-vaults point 6). The
      // requirement is computed from the binding registry, so there is no
      // switch to read anywhere and no way for a caller to find out except by
      // being told: `list_vaults` is where a session looks.
      //
      // Both fields are ALWAYS present, even when false/null — the same
      // contract rule `disabled[]` follows one field down: a caller must never
      // have to tell "not shared" from "this router is too old to know".
      const sharing = sharingRequirement(v.name, registry, sharedConfig);
      return {
        name: v.name,
        type: v.type,
        baseUrl: v.baseUrl,
        path: v.path,
        description: v.description,
        isDefault: v.name === registry.defaultVault,
        online: ping.online,
        latencyMs: ping.latencyMs,
        error: ping.error,
        missingApiKey: v.missingApiKey || false,
        writesRequireIfMatch: sharing.required,
        sharingReason: sharing.reason,
      };
    }),
  );

  // Disabled vaults from the registry's skipped[] list, PLUS any vault this
  // workspace cannot currently reach (not pinged, same reasoning as a
  // genuinely disabled vault: no point spending a round-trip on a name
  // resolveVault() would refuse anyway). Read-only metadata. Each entry has
  // { name, type, reason, awaitingDeclaration }. Always returned, even when
  // empty, so callers don't have to special-case "no disabled" vs "field
  // missing".
  //
  // TWO KINDS OF ABSENCE LIVED IN ONE ARRAY, AND THAT LOCKED A DOOR FROM THE
  // INSIDE. A vault the user DISABLED (or one the registry skipped as
  // malformed) is not a candidate for anything — the operator said no. A vault
  // that is merely UNREACHABLE under `vaultReach: "declared"` is the opposite:
  // it is registered, healthy and available, and the only thing missing is the
  // declaration the `bind-workspace` wizard exists to make. The wizard read
  // the array as one kind and excluded both, so on a workspace with no binding
  // and no `openVaults` it could offer nothing at all — and binding is what
  // would have made the candidates appear. Measured by the whole-lot review
  // (2026-09-06); it is trap 3 of the decision `portee-et-mode-ecriture-des-
  // vaults`, which required the binding TOOL to stay able to name such a
  // vault, one layer above where the trap actually bit.
  //
  // So the distinction is DATA, not prose a reader has to parse out of
  // `reason`: `awaitingDeclaration: true` means "registered and healthy, this
  // workspace has simply never declared it — bind it and it answers".
  const disabled = [
    ...(registry.skipped || []).map((s) => ({
      name: s.name, type: s.type, reason: s.reason, awaitingDeclaration: false,
    })),
    ...unreachable.map((v) => ({
      name: v.name,
      type: v.type,
      reason: 'not reachable from this workspace (vaultReach: "declared" — bind this workspace '
        + 'to it, or add it to `openVaults`)',
      awaitingDeclaration: true,
    })),
  ];

  // Default vault health summary (v0.10.0) — null when no default vault
  // resolved (empty registry / no cascade match) OR when the resolved
  // default name isn't in the pinged results (pathological post-load
  // mutation; let the convention layer surface the inconsistency).
  const defaultVaultStatus = buildDefaultVaultStatus(registry.defaultVault, results);

  // Is the conversion toolbox provisioned? Eight tools go through markitdown
  // (a ninth, youtube, only degrades), and it is installed by an explicit
  // opt-in and never on its own — so a fresh install has them dormant with
  // nothing saying so until the first call ENOENTs mid-task. This is the
  // discovery call `meta-status` already makes, which is why the answer belongs
  // here rather than in a new tool. The counts live in one place,
  // `MARKITDOWN_TOOLS` / `MARKITDOWN_DEGRADED_TOOLS`, so prose like this cannot
  // drift away from them again.
  //
  // FILESYSTEM ONLY, no subprocess: the default-vault health-check convention
  // calls list_vaults at session start, and a Python probe on that path would
  // be a real cost paid by everyone to inform the few. `probeConversionToolbox`
  // never throws — a readiness check that could break discovery would be a far
  // worse trade than not knowing.
  const conversionToolbox = probeConversionToolbox({
    projectRoot: PROJECT_ROOT,
    env: process.env,
  });

  // WHERE each session setting came from (v0.88.0) — the "provenance" lot of
  // the accepted decision `liaison-workspace-vault-hors-depot`. A workspace is
  // very often a cloned repository, and its `.env` travels with it: until the
  // binding moves out of the repository, the router must at least be able to
  // say "this mode was chosen by this project's file, not by you" instead of
  // applying it silently. Each field is `{ origin, variable }`:
  //
  //   origin 'workspace-dotenv' — applied from `<cwd>/.env` by this process
  //          'host'             — already in the environment at start-up (the
  //                               MCP host's server declaration, a launcher, a shell)
  //          'runtime'          — set during this session by lock_vault /
  //                               set_auto_enrich_mode
  //          'config'           — the router's own config.json (default vault only)
  //          'first-healthy' / 'first-active' — no one chose: the cascade fell
  //                               back to a vault (default vault only)
  //          'default'          — nothing set it; the documented default applies
  //          'unset'            — no value at all (not locked, no vault resolved)
  //          'unknown'          — a registry that predates this field, or one
  //                               built by a path that does not record it
  //   variable — the environment variable that carried it, or null
  //
  // The values are validated against the registry either way: a workspace file
  // can only ever name a vault the user already registered.
  // Written as literals rather than built from a variable, so the guard in
  // tests/setting-provenance.test.mjs — which collects `origin: '<literal>'`
  // across the producers and requires the tool description to explain every
  // one of them — can actually see these three. A fallback assembled from an
  // argument was invisible to it, and `unknown` went undocumented.
  const UNKNOWN = Object.freeze({ origin: 'unknown', variable: null });
  const UNSET = Object.freeze({ origin: 'unset', variable: null });
  const BY_DEFAULT = Object.freeze({ origin: 'default', variable: null });
  // The recorded source is VALIDATED at the boundary, not trusted: a registry
  // built by another path could carry a malformed object or an origin outside
  // the documented vocabulary, and this response is a contract. Anything that
  // does not typecheck becomes `unknown` — the answer for "cannot say".
  const sourceOr = (recorded, fallback) => {
    const ok = recorded
      && typeof recorded === 'object'
      && SETTING_ORIGIN_SET.has(recorded.origin)
      && (recorded.variable === null || typeof recorded.variable === 'string');
    if (ok) return recorded;
    return recorded ? UNKNOWN : fallback;
  };
  // The binding, validated at the boundary like everything else in this
  // response. A registry built by another path could carry anything, and a
  // half-formed binding is worse than none: a caller would phrase "you are
  // bound to undefined" at the top of a session. Rebuilt rather than passed
  // through, so extra fields cannot ride along into the contract.
  const bindingOrNull = (b) => {
    const str = (v) => typeof v === 'string' && v !== '';
    if (!b || typeof b !== 'object' || Array.isArray(b) || !str(b.vault)) return null;
    return {
      vault: b.vault,
      also: Array.isArray(b.also) ? b.also.filter(str) : [],
      locked: b.locked === true,
      confirmedAt: str(b.confirmedAt) ? b.confirmedAt : null,
      confirmedVia: str(b.confirmedVia) ? b.confirmedVia : null,
      // The write tier of each secondary, for THIS workspace — what the
      // "configure-secondary-vaults" conversation reads back before asking.
      alsoLocked: Array.isArray(b.alsoLocked) ? b.alsoLocked.filter(str) : [],
      alsoWritable: Array.isArray(b.alsoWritable) ? b.alsoWritable.filter(str) : [],
    };
  };
  // The hint, same treatment. `status` must be one the classifier can produce
  // — anything else is a registry this build does not understand, and silence
  // beats a status a caller would branch on wrongly. Derived from the
  // classifier's own vocabulary rather than copied: the copy said "five" for
  // a whole release after the sixth status (`refused`) arrived, and a status
  // the classifier produces but this validator drops is a proposal the user
  // has answered being reported as no proposal at all.
  const HINT_STATUSES = new Set(Object.values(HINT_STATUS));
  // The four origins an ENVIRONMENT VARIABLE can have (ENV_ORIGINS), which is
  // a strict subset of SETTING_ORIGINS: the cascade tiers that read no
  // variable cannot be the origin of a proposal.
  const ENV_ORIGIN_SET = new Set(['workspace-dotenv', 'host', 'runtime', 'unknown']);
  const hintOrNull = (h) => {
    if (!h || typeof h !== 'object' || Array.isArray(h) || !HINT_STATUSES.has(h.status)) return null;
    return {
      status: h.status,
      hint: typeof h.hint === 'string' && h.hint ? h.hint : null,
      boundTo: typeof h.boundTo === 'string' && h.boundTo ? h.boundTo : null,
      // Whether the workspace file ITSELF says this proposal was refused here
      // before (OBSIDIAN_ROUTER_REFUSED_VAULT naming the same vault). A fact
      // about the file, carried whatever the status; it means something only
      // for a signalled one, where it is the reinstall case: the config that
      // held the answer is gone, and the file is the last memory of it.
      previouslyRefused: h.previouslyRefused === true,
      // WHERE the proposal came from. Constrained to the environment origins,
      // because a proposal only ever arrives through an environment variable:
      // an origin from elsewhere in SETTING_ORIGINS ("config", "binding", …)
      // would describe a tier that cannot make one, so it is dropped rather
      // than reported. The difference that matters here is `workspace-dotenv`
      // (this project's file) against `host` (the user's own MCP declaration);
      // naming the wrong one sends the user to the wrong file.
      origin: ENV_ORIGIN_SET.has(h.origin) ? h.origin : null,
      // WHICH of the file's two proposal lines carried it. `true` means
      // OBSIDIAN_ROUTER_LOCKED — the file is asking for a LOCKED binding, so
      // an acceptance that omits `locked: true` gives the user something other
      // than what they said yes to. False for the default-vault line, and for
      // a proposal that came from the host.
      byLock: h.byLock === true,
    };
  };
  // The one-time import's report. Three fields, all required, the vault name
  // among them — a report that could arrive half-formed would be worse than
  // none, because a caller would announce an import it cannot describe.
  const importedOrNull = (i) => {
    const str = (v) => typeof v === 'string' && v !== '';
    return i && typeof i === 'object' && !Array.isArray(i) && str(i.vault) && str(i.at)
      ? {
        vault: i.vault,
        at: i.at,
        // WHETHER THE IMPORT ALSO CARRIED A LOCK. A workspace file that had
        // `OBSIDIAN_ROUTER_LOCKED` set is migrated to a LOCKED binding, so
        // the isolation the user had persisted survives the upgrade — and a
        // caller that reported the import without saying the session is
        // restricted to one vault would be describing half of what happened.
        locked: i.locked === true,
        dotenvFile: str(i.dotenvFile) ? i.dotenvFile : null,
      }
      : null;
  };
  // The refusal has its own shape, so it has its own validator. Five string
  // fields, all required, and an origin that can only be the one origin a
  // refusal can have: a file is the only thing this rule refuses. Anything
  // else — a missing field, a number, an origin from somewhere else — is not
  // reported at all rather than reported half-true.
  const refusalOrNull = (recorded) => {
    const str = (v) => typeof v === 'string' && v !== '';
    const ok = recorded
      && typeof recorded === 'object'
      && str(recorded.value) && str(recorded.canonical) && str(recorded.reason)
      && recorded.origin === 'workspace-dotenv'
      && str(recorded.variable);
    // REBUILT, not passed through: a registry built by another path could
    // carry extra fields, and this response is a contract that says five. The
    // three source fields above are passed through because their shape is two
    // keys checked exhaustively; this one is wider and worth reconstructing.
    return ok ? {
      value: recorded.value,
      canonical: recorded.canonical,
      origin: recorded.origin,
      variable: recorded.variable,
      reason: recorded.reason,
    } : null;
  };

  return ({
    defaultVault: registry.defaultVault,
    defaultVaultStatus,
    defaultVaultSource: sourceOr(registry.defaultVaultSource, registry.defaultVault ? UNKNOWN : UNSET),
    lockSource: sourceOr(registry.lockSource, registry.lockedVault ? UNKNOWN : UNSET),
    // A mode is present but nobody recorded WHO set it: `ClaudeAsk` is the
    // documented default, but it is also a value a host, a workspace file or a
    // tool call can set explicitly — so a mode with no source is `unknown`,
    // and only a registry carrying no mode at all is `default`.
    autoEnrichModeSource: sourceOr(registry.autoEnrichModeSource, registry.autoEnrichMode ? UNKNOWN : BY_DEFAULT),
    // What a workspace file asked for and did NOT get (v0.89.0) — the accepted
    // option 4 of the same decision. A SEPARATE field, deliberately, and not a
    // tenth value of SETTING_ORIGINS: `autoEnrichModeSource` answers "who chose
    // the mode in force", and a refused value chose nothing. Naming it there
    // would credit a file for the default that replaced it, which is the exact
    // lie the provenance lot was built to stop telling.
    //
    // Validated at the boundary like the sources above: a registry built by
    // another path could carry anything, and this response is a contract.
    // Anything that does not typecheck becomes null — "no refusal to report" —
    // because a half-formed refusal is worse than none.
    autoEnrichModeRefused: refusalOrNull(registry.autoEnrichModeRefused),
    // WHICH vaults this workspace is bound to (v0.90.0) — points 1-2 of the
    // same decision. Three states, and the difference matters to every caller
    // that phrases it for a human:
    //   an object          → bound to `vault`, plus `also[]` if several
    //   null               → NO binding, which means ALL vaults: the cascade
    //                        picks the default and every registered vault
    //                        stays addressable. Never "no vault".
    // `also` is information the router did not have before this lot: `--attach
    // a --also b` wrote only `a` to the dotenv file, and `b` lived solely in a
    // CLAUDE.md prose block the router never read.
    workspaceBinding: bindingOrNull(registry.workspaceBinding),
    // What this workspace's dotenv file PROPOSED, and how it stands against
    // the binding. A SEPARATE field, never an origin: a hint that was not
    // applied is not the source of what replaced it. `status` is one of
    // HINT_STATUS's six values; `hintIsWorthSignalling` says which three are
    // worth telling the user — the other three (none, confirmed, refused) are
    // silence.
    bindingHint: hintOrNull(registry.bindingHint),
    // WHICH vaults this workspace REFUSED, by name, from the user's own config
    // (decision refus-d-une-proposition-de-liaison). Always an array, empty
    // when nothing was refused — the list a retraction picks from. Names
    // only: the dates sit in config.json for the human who reads it.
    workspaceRefusals: registry.workspaceRefusals instanceof Map
      ? [...registry.workspaceRefusals.keys()].filter((n) => typeof n === 'string' && n !== '')
      : [],
    // What the ONE-TIME import created at THIS start-up, or null. Rebuilt and
    // validated like the two above: the report of an automatic decision is
    // exactly the field a caller must be able to trust.
    bindingImported: importedOrNull(registry.bindingImported),
    conversionToolbox,
    configPath: registry.configPath,
    vaults: results,
    disabled,
    // Port collisions + registry drift detected when the config was loaded
    // (v0.77.0). This is the ANSWER to an "online: false" above that has no
    // other explanation: two vaults on one port means the second one to start
    // never bound its socket. Always an array — empty when the fleet is clean.
    portCollisions: registry.portCollisions || [],
    // Lock state — null when the router is in normal multi-vault mode,
    // a vault name when the router is restricted to a single vault for
    // the current session. See `lock_vault` / `unlock_vaults` tools.
    lockedTo: registry.lockedVault || null,
    // Auto-enrichment mode — controls whether/how Claude proactively
    // proposes wiki saves at three triggers (validation pins, result
    // digests, topic-switch checkpoints). One of:
    //   - "ClaudeAsk"  — propose, user always confirms (default)
    //   - "Hybrid"     — auto-save type-safe items, ask on high-stakes
    //   - "FullAuto"   — auto-save everything (audit log + safety nets)
    //   - "off"        — no auto-suggestions; manual /save only
    // See `set_auto_enrich_mode` tool to change this at runtime.
    // Legacy fallback: a registry from a pre-v0.8.2 boot path won't have
    // this field set. Default to 'ClaudeAsk' — the safe default that
    // matches the documented behavior (propose + always confirm). We do
    // NOT silently default to 'off' here, because absence of an explicit
    // mode means "user hasn't customized" and the safe default applies.
    autoEnrichMode: registry.autoEnrichMode || 'ClaudeAsk',
  });
}
