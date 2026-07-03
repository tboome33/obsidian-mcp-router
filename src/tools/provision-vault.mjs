// provision_vault — LAYER 1. Applies a set of wizard answers in ONE call by
// driving the layer-0 engine (scripts/setup-vault.mjs). Returns a step-by-step
// report plus port / insecurePort / openUri / probeResult.
//
// SECURITY (spec §7.3, non-negotiable):
//   - This tool writes to the local filesystem, so it is REGISTERED ONLY on a
//     local, non-gated router. When OBSIDIAN_ROUTER_USER_ID is set (a gated
//     MCPHub/Tribu deployment) it is absent from the tool list entirely — that
//     gate is enforced in src/index.mjs (computeExposedTools + the CallTool
//     guard). This handler is the second layer of defense:
//   - It refuses any target path OUTSIDE the known vault roots (config
//     vaultsRoot + portRegistry roots) unless `allowOutsideRoots: true` is
//     passed explicitly — no remote-driven arbitrary mkdir/write. The gate
//     reuses the engine's OWN `path-outside-known-roots` computation
//     (buildProvisionPlan), so the CLI and the tool agree.
//   - The --from-vault credential exclusions (workspace.json + secret data.json
//     never copied, port + key regenerated) are applied by the engine
//     regardless of the calling layer.

import { runDryRunPlan, composeSetupVaultArgs, runSetupVault, parseProvisionResult } from '../helpers/vault-wizard-engine.mjs';

export async function provisionVaultTool(_registry, args = {}) {
  const input = { ...args, path: args.path || args.vaultPath };
  if (!input.path) {
    throw new Error('provision_vault requires `path` — the target vault location.');
  }

  // 1) Dry-run first: compute the plan, enforce the path gate, and surface any
  //    blocking condition BEFORE mutating anything.
  const plan = await runDryRunPlan(input);
  const warn = (code) => (plan.warnings || []).find((w) => w.code === code);

  if (warn('path-outside-known-roots') && !args.allowOutsideRoots) {
    const roots = (plan.context && plan.context.knownRoots) || [];
    throw new Error(
      `Refused: ${plan.path} is outside all known vault roots ` +
      `[${roots.join(', ') || 'none configured'}]. provision_vault will not create a vault ` +
      `at an arbitrary location. Pass allowOutsideRoots:true to override, or choose a path ` +
      `under a known root.`,
    );
  }
  const srcErr = warn('source-error');
  if (srcErr) throw new Error(`Refused: ${srcErr.message}`);
  const collision = warn('slug-collision');
  if (collision) throw new Error(`Refused: ${collision.message}`);

  // 2) Real run (also --json → the engine emits a ##PROVISION_RESULT## line).
  const realArgs = [...composeSetupVaultArgs(input), '--json'];
  const { code, stdout, stderr } = await runSetupVault(realArgs);
  const result = parseProvisionResult(stdout);

  if (!result) {
    throw new Error(
      `Provisioning did not produce a result (exit ${code}).\n` +
      (stderr || stdout || '').trim().slice(0, 800),
    );
  }

  // A non-zero exit with a parsed result means the probe went red (exit 3) but
  // the vault WAS provisioned — surface it as a soft failure, not a throw.
  return {
    ok: result.ok === true && (code === 0 || code === 3),
    path: result.abs,
    slug: result.slug,
    obsidianName: result.obsidianName,
    port: result.port,
    insecurePort: result.insecurePort,
    openUri: result.openUri,
    opened: result.opened,
    probeResult: result.probe,
    steps: plan.steps,
    warnings: plan.warnings,
    // Hooks are intentionally NOT auto-wired from an MCP call — the tool never
    // mutates ~/.claude/settings.json. Wire them via the skill or the CLI.
    hooksWired: false,
    exitCode: code,
  };
}
