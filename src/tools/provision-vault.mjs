// provision_vault — LAYER 1. Applies a set of wizard answers in ONE call by
// driving the layer-0 engine (scripts/setup-vault.mjs). Returns a step-by-step
// report plus port / insecurePort / openUri / probeResult.
//
// SECURITY (spec §7.3, non-negotiable):
//   - LOCAL-ONLY + a read-only gate: registered only on a non-gated router
//     (absent when OBSIDIAN_ROUTER_USER_ID is set) AND hidden/refused under
//     OBSIDIAN_ROUTER_READONLY (it is in WRITE_TOOL_NAMES). Both gates are in
//     src/index.mjs. This handler is the second layer of defense:
//   - It refuses any target path OUTSIDE the known vault roots (config
//     vaultsRoot + portRegistry roots) unless `allowOutsideRoots: true`. The
//     gate is FAIL-CLOSED: when the config has NO known roots at all, an
//     arbitrary path is still refused without the explicit opt-in (review+ W2).
//   - The --from-vault credential exclusions (workspace.json + secret data.json
//     never copied, port + key regenerated) are applied by the engine
//     regardless of the calling layer.

import {
  runDryRunPlan as defaultRunDryRunPlan,
  runProvision as defaultRunProvision,
  provisionPlanCore,
  provisionExecOptions,
} from '../helpers/vault-wizard-engine.mjs';
import { verifyPlanSeal, isPlanSeal, PlanDriftError } from '../helpers/plan-seal.mjs';
export async function provisionVaultTool(registry, args = {}, _deps = {}) {
  const runDryRunPlan = _deps.runDryRunPlan || defaultRunDryRunPlan;
  const runProvision = _deps.runProvision || defaultRunProvision;
  const input = { ...args, path: args.path || args.vaultPath };
  if (!input.path) {
    throw new Error('provision_vault requires `path` — the target vault location.');
  }
  // Validate the seal SHAPE before spawning the planner — a typo must surface
  // as a validation error, not silently behave like "no seal".
  if (args.approvedPlanSha256 !== undefined && !isPlanSeal(args.approvedPlanSha256)) {
    // PlanDriftError so the refusal classifies as validation, not unknown.
    throw new PlanDriftError(
      'Invalid approvedPlanSha256: expected a 64-char lowercase hex plan seal (the value plan_vault returned).',
      { op: 'provision', provided: String(args.approvedPlanSha256) },
    );
  }
  // Drive the child against the SERVER'S active config, not setup-vault's
  // default (which may point elsewhere when the router was launched with
  // --config). review+ W2 P2.
  const configPath = registry && registry.configPath;

  // 1) Dry-run first: compute the plan, enforce the path gate, and surface any
  //    blocking condition BEFORE mutating anything.
  const plan = await runDryRunPlan(input, { configPath });
  const warn = (code) => (plan.warnings || []).find((w) => w.code === code);

  const roots = (plan.context && plan.context.knownRoots) || [];
  // FAIL-CLOSED: refuse when the target is outside known roots OR when there are
  // NO known roots at all — either way, no arbitrary-directory creation without
  // the explicit opt-in. Gated on the plan's OWN warnings (path-outside-known-
  // roots / no-known-roots), so plan_vault surfaces the same condition and the
  // frontend can request allowOutsideRoots BEFORE this write call (review+ W2).
  const outsideRoots = Boolean(warn('path-outside-known-roots') || warn('no-known-roots'));
  if (outsideRoots && !args.allowOutsideRoots) {
    throw new Error(
      `Refused: ${plan.path} is outside all known vault roots ` +
      `[${roots.join(', ') || '(none configured)'}]. provision_vault will not create a vault ` +
      `at an arbitrary location. Pass allowOutsideRoots:true to override, or choose a path ` +
      `under a known root (a registered vault's parent dir, or config vaultsRoot).`,
    );
  }
  const srcErr = warn('source-error');
  if (srcErr) throw new Error(`Refused: ${srcErr.message}`);
  const collision = warn('slug-collision');
  if (collision) throw new Error(`Refused: ${collision.message}`);

  // C3 sealed preview: if the caller approved a plan_vault preview, refuse to
  // provision when the freshly-recomputed plan no longer matches — BEFORE the
  // real (filesystem-mutating) run. The gate checks above already surface the
  // blocking drifts (collision / source-error / outside-roots) with specific
  // messages; the seal is the final catch-all for subtler environmental drift
  // (a changed source plugin set, a flipped non-blocking warning) and for
  // cross-target replay. Verified against the SAME curated core plan_vault
  // sealed, so an identical environment passes.
  if (args.approvedPlanSha256 !== undefined) {
    verifyPlanSeal({
      op: 'provision',
      identity: { target: plan.path ?? null },
      plan: { core: provisionPlanCore(plan), exec: provisionExecOptions(input) },
      approvedPlanSha256: args.approvedPlanSha256,
      previewHint: 'call plan_vault with the same arguments',
    });
  }

  // 2) Real run (nonce'd --json → the engine emits a spoof-proof result line).
  const { code, stdout, stderr, result } = await runProvision(input, { configPath });

  if (!result) {
    throw new Error(
      `Provisioning did not produce a result (exit ${code}).\n` +
      (stderr || stdout || '').trim().slice(0, 800),
    );
  }

  // A non-zero exit WITH a parsed result means the probe went red (exit 3) but
  // the vault WAS provisioned — surface it as a soft failure, not a throw.
  return ({
    ok: result.ok === true && (code === 0 || code === 3),
    kind: result.kind || plan.source.kind,
    path: result.abs,
    slug: result.slug,
    obsidianName: result.obsidianName,
    port: result.port ?? null,
    insecurePort: result.insecurePort ?? null,
    openUri: result.openUri,
    opened: result.opened,
    probeResult: result.probe ?? null,
    ...(result.bridgeDownloaded !== undefined ? { bridgeDownloaded: result.bridgeDownloaded } : {}),
    ...(result.message ? { message: result.message } : {}),
    steps: plan.steps,
    warnings: plan.warnings,
    // Hooks are intentionally NOT auto-wired from an MCP call — the tool never
    // mutates ~/.claude/settings.json. Wire them via the skill or the CLI.
    hooksWired: false,
    exitCode: code,
  });
}
