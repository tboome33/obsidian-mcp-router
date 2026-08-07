// plan_vault — LAYER 1, READ-ONLY. Returns a structured questionnaire + the
// computed defaults for creating a new local vault, so ANY harness (Claude,
// Codex, Hermes…) can drive the wizard conversation and then call
// provision_vault. Zero mutation: it runs the layer-0 engine in
// `--dry-run --json` mode and shapes the result into { context, defaults,
// questions, warnings, steps }.
//
// The wizard lives in THIS DATA, not in any harness: every option list (the 5
// wiki modes with explanations, the themes actually installed in the source,
// the registered vaults you can copy config from, the plugin profiles) is
// emitted here so all frontends present the same choices (spec §4.2, §7.1).

import { runDryRunPlan as defaultRunDryRunPlan, provisionPlanCore, provisionExecOptions } from '../helpers/vault-wizard-engine.mjs';
import { computePlanSeal } from '../helpers/plan-seal.mjs';
import { WIKI_MODES } from '../../scripts/vault-plan.mjs';
function buildQuestions(plan) {
  const ctx = plan.context || {};
  const copyable = ctx.copyableVaults || [];
  const themes = ctx.availableThemes || [];

  const sourceOptions = [
    { id: 'reference', label: 'Reference template (.template)', description: 'Clone the configured reference vault — the default.', isDefault: plan.source.kind === 'reference' },
    { id: 'from-vault', label: 'Copy config from an existing vault', description: copyable.length
        ? `Config-only copy (plugins/themes/appearance/CLAUDE.md; secrets regenerated). Copyable: ${copyable.map((v) => v.slug).join(', ')}.`
        : 'Config-only copy — but no other vault is registered yet.', isDefault: plan.source.kind === 'from-vault' },
    { id: 'skeleton', label: 'Fresh GitHub skeleton', description: 'Scaffold from the shipped skeleton + download the bridge (finish plugin install in Obsidian).', isDefault: plan.source.kind === 'skeleton' },
    { id: 'bare', label: 'Bare minimal', description: 'Only the 2 REQUIRED plugins.', isDefault: plan.source.kind === 'bare' },
  ];

  const pluginOptions = [
    { id: 'recommended', label: `Recommended (${plan.plugins.resolved.length})`, description: `The source's full enabled set: ${plan.plugins.resolved.join(', ')}.`, isDefault: plan.plugins.profile === 'recommended' },
    { id: 'minimal', label: 'Minimal', description: 'REQUIRED plugins only (Local REST API + bridge).', isDefault: plan.plugins.profile === 'minimal' },
    { id: 'custom', label: 'Custom', description: 'Pick an explicit list (REQUIRED always included).', isDefault: plan.plugins.profile === 'custom' },
  ];

  const wikiOptions = WIKI_MODES.map((m) => ({
    id: m.id, label: m.label, description: m.description, isDefault: m.id === plan.wikiMode.mode,
  }));

  const themeOptions = themes.map((t) => ({
    id: t.id, label: t.label, description: t.id === 'obsidian-default' ? 'No custom theme.' : `Installed in the source.`,
    isDefault: plan.theme ? plan.theme.name === t.id : t.id === 'obsidian-default',
  }));

  const questions = [
    { id: 'source', label: 'Template source', description: 'Where the new vault gets its plugins/config.', options: sourceOptions },
    { id: 'plugins', label: 'Plugin profile', description: 'Which plugins to clone.', options: pluginOptions },
    { id: 'wikiMode', label: 'Wiki mode', description: 'Seeds the index/overview sections. All 5 shown with explanations.', options: wikiOptions },
    { id: 'theme', label: 'Theme', description: 'Applied via --theme (currently blocked on the Lot 2 chantier — recorded but not yet written).', options: themeOptions },
    {
      id: 'claudeWorkspace', label: 'Install slash commands in the workspace', description: 'Enables the router plugin in the bound workspace .claude/settings.json (~10k context tokens/session).',
      options: [
        { id: 'yes', label: 'Yes (pre-checked)', description: 'Recommended when a code workspace is bound.', isDefault: true },
        { id: 'no', label: 'No', description: 'Skip — the vault still gets its own slash commands.', isDefault: false },
      ],
    },
  ];
  return questions;
}

export async function planVaultTool(registry, args = {}, _deps = {}) {
  const runDryRunPlan = _deps.runDryRunPlan || defaultRunDryRunPlan;
  const input = { ...args, path: args.path || args.vaultPath };
  if (!input.path) {
    throw new Error('plan_vault requires `path` — the intended vault location (e.g. "C:\\\\VAULTS\\\\MyProject"). The frontend proposes a default; pass it here.');
  }
  // Plan against the server's active config (review+ W2 P2).
  const configPath = registry && registry.configPath;
  const plan = await runDryRunPlan(input, { configPath });
  // C3 sealed preview: bind the plan to its resolved target so provision_vault
  // refuses to apply it if the environment drifted (a slug collision appeared,
  // the source vault changed, a root vanished) between this call and the apply.
  // The identity is the resolved target path — the vault does not exist yet, so
  // the target IS "the resolved vault". Pass this back to provision_vault
  // together with the SAME args you passed here.
  const approvedPlanSha256 = computePlanSeal({
    op: 'provision',
    identity: { target: plan.path ?? null },
    plan: { core: provisionPlanCore(plan), exec: provisionExecOptions(input) },
  });
  return ({
    context: plan.context,
    approvedPlanSha256,
    defaults: {
      name: plan.name,
      slug: plan.slug,
      path: plan.path,
      source: plan.source,
      plugins: plan.plugins,
      theme: plan.theme,
      wikiMode: plan.wikiMode,
      conventions: plan.conventions,
      claudeWorkspace: plan.claudeWorkspace,
      open: plan.open,
      probe: plan.probe,
      gitInit: plan.gitInit,
    },
    questions: buildQuestions(plan),
    warnings: plan.warnings,
    steps: plan.steps,
  });
}
