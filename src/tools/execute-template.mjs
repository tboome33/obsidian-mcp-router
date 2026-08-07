import { executeTemplate } from '../rest-client.mjs';
import { buildClickToOpenUrl } from '../helpers/click-to-open.mjs';
import { okfSafePathSuggestion } from '../helpers/okf-safe-rename.mjs';
import { canonicalVaultPath } from '../helpers/vault-path-guard.mjs';
export async function executeTemplateTool(registry, args = {}) {
  const {
    vault: name,
    arguments: templateArgs,
    createFile,
  } = args;
  if (!args.name) {
    throw new Error('Missing required argument: name (template path, e.g. "Templates/Daily.md")');
  }
  if (createFile && !args.targetPath) {
    throw new Error('targetPath is required when createFile is true');
  }
  // BOTH paths are caller-supplied and BOTH reach the plugin — in the request
  // BODY, not the URL, so `encodePath` never sees them and containment would
  // rest entirely on Templater's own resolution. Reproduced before this guard:
  //   POST /templates/execute  {"name":"../../../t.md","targetPath":"../../../../evil.md"}
  // With `createFile: true` that is a WRITE at a caller-chosen path. This tool
  // was classified as a fixed-path writer in the security inventory — an
  // assertion made from its name rather than from its code, and wrong.
  const templateName = canonicalVaultPath(args.name, 'name');
  // `createFile` must be a REAL BOOLEAN. Tool arguments arrive from CallTool
  // without per-tool runtime schema validation, so `"true"` and `1` reach this
  // handler; under truthiness they took the guarded branch, which is harmless
  // but means the gate did not say what it meant. The bridge is strict
  // (`body.createFile === true`), so matching it here makes the router's
  // contract and the plugin's contract the same sentence.
  // `!= null`, NOT `!== undefined`: this repo's own transport treats `null` as
  // "argument not provided" (`rest-client.mjs:802` is `if (createFile != null)`),
  // and clients that serialise omitted optionals as `null` are the reason that
  // line exists. The first version of this check used `!== undefined` and so
  // refused `createFile: null` — a call that worked in v0.70.2 — to tighten a
  // case the tool's own `inputSchema` (`type: 'boolean'`, `additionalProperties:
  // false`) already rejects. Strictness that contradicts your own convention is
  // not strictness, it is a break.
  if (createFile != null && typeof createFile !== 'boolean') {
    throw Object.assign(
      new Error(`Invalid createFile: expected a boolean, got ${typeof createFile}.`),
      { kind: 'validation' },
    );
  }
  // `targetPath` REFUSES when it is used, and is DROPPED when it is not. Both
  // halves were learned from a failure, and the two failures pull opposite ways.
  //
  // Refusing too much: the first version canonicalised whenever the value was
  // not `undefined`, so a render-only call carrying a leftover or empty
  // targetPath threw — calls that worked in v0.70.2 stopped working. Guarding
  // an argument the call does not act on is a regression, not caution, and
  // there is a pin holding that line.
  //
  // Refusing too little: gating on `createFile === true` let the RAW value
  // travel anyway. `rest-client` sends `targetPath` whenever it is non-null,
  // preview included, so `POST /templates/execute` carried
  // `"targetPath":"/etc/passwd"` across to the bridge. Containment then lived
  // entirely in the bridge — a separate component, correct today, which is not
  // the same as a guarantee.
  //
  // Dropping resolves both: a render-only call is never refused, and a path
  // that cannot be a vault path never leaves this process. A LEGITIMATE
  // targetPath still travels exactly as before — only the ones a vault path
  // may not carry are silenced, and those had no destination anyway.
  //
  // WHAT THIS DOES NOT FIX, stated because the first version of this comment
  // claimed it did. The audit journal does not read the value computed here: it
  // re-reads `request.params.arguments` in `pickAuditPath`, so dropping the
  // value here changed nothing there. Measured after this handler was fixed,
  // one `tools/call` with `createFile` absent:
  //
  //   WIRE body        : {"name":"Templates/t.md","arguments":{}}
  //   JOURNAL appended : [claude-write by roland] … — execute_template
  //                      path="../../../etc/passwd"
  //
  // The journal named a path the router had just refused to send anywhere. That
  // is closed in `pickAuditPath`, by the same `createFile === true` gate used
  // here, and it had to be closed THERE — a claim about a channel this file
  // does not write on was a false security claim in shipped code.
  let targetPath = args.targetPath;
  if (createFile === true) {
    targetPath = canonicalVaultPath(args.targetPath, 'targetPath');
  } else if (targetPath) {
    try {
      targetPath = canonicalVaultPath(targetPath, 'targetPath');
    } catch {
      targetPath = null;
    }
  }

  const vault = registry.resolveVault(name);
  const result = await executeTemplate(vault, {
    name: templateName,
    args: templateArgs || {},
    createFile,
    targetPath,
  });
  // Only emit a click-to-open URL when the template actually wrote a file
  // (createFile + targetPath both provided). The render-only path has no
  // file to open.
  const clickToOpenUrl = createFile && targetPath
    ? buildClickToOpenUrl(vault, targetPath)
    : null;
  // Non-blocking OKF-name guard (2026-07-29 decision) — only when a file
  // is actually created.
  const okfSuggestion = createFile && targetPath ? okfSafePathSuggestion(targetPath) : null;
  return ({
    vault: vault.name,
    template: templateName,
    targetPath: createFile ? targetPath : null,
    ...result,
    ...(clickToOpenUrl && { clickToOpenUrl }),
    ...(okfSuggestion && {
      okfNameWarning: `targetPath is not OKF-safe (2026-07-29 policy: notes use ascii-kebab names). Suggested: ${okfSuggestion}`,
    }),
  });
}
