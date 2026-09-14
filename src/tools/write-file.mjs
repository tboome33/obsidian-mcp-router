import { writeFile, writeFileIfMatch } from '../rest-client.mjs';
import { buildClickToOpenUrl } from '../helpers/click-to-open.mjs';
import { okfSafePathSuggestion } from '../helpers/okf-safe-rename.mjs';
import { isProjectionPath } from '../helpers/okf-projections.mjs';
import { contentSha256, isContentSha256 } from '../helpers/content-hash.mjs';
import { canonicalVaultPath } from '../helpers/vault-path-guard.mjs';
import { detectFrontmatterDefects } from '../helpers/frontmatter-validate.mjs';
export async function writeFileTool(registry, args = {}) {
  const { vault: name, content, ifNew = false, ifMatch } = args;
  // Containment BEFORE anything else touches the path: `..` survives
  // `encodeURIComponent`, and the URL parser then collapses it onto a sibling
  // route (`/commands/`, `/active/`) instead of `/vault/`. See vault-path-guard.
  const filePath = canonicalVaultPath(args.path, 'path');
  if (typeof content !== 'string') {
    throw new Error('Missing required argument: content (string)');
  }

  // ifMatch (C1 optimistic concurrency): write only if the file still hashes to
  // this value. Validate early so a typo'd hash fails loudly instead of always
  // 409-ing, and reject the contradictory combo with ifNew ("must be new" AND
  // "must equal existing content" cannot both hold).
  if (ifMatch !== undefined) {
    if (!isContentSha256(ifMatch)) {
      throw new Error(
        'Invalid ifMatch: expected a 64-char lowercase hex content hash (the contentSha256 field from get_file).',
      );
    }
    if (ifNew) {
      throw new Error(
        'ifNew and ifMatch are mutually exclusive: ifNew requires the file to be absent, ifMatch requires it to already hold specific content.',
      );
    }
  }

  const vault = registry.resolveVault(name);

  let casMode = null;
  if (ifMatch !== undefined) {
    const cas = await writeFileIfMatch(vault, filePath, content, ifMatch);
    casMode = cas.casMode; // 'atomic' | 'fallback'
  } else {
    await writeFile(vault, filePath, content, {
      applyIfContentPreexists: ifNew ? false : undefined,
    });
  }
  const clickToOpenUrl = buildClickToOpenUrl(vault, filePath);
  // Non-blocking OKF-name guard (2026-07-29 decision): new notes are born
  // with ascii-kebab OKF-safe paths; the write succeeds either way.
  const okfSuggestion = okfSafePathSuggestion(filePath);
  // Non-blocking frontmatter guard (2026-09-14). The router wrote a file
  // Obsidian shows as "Invalid properties" and reported nothing but
  // `bytesWritten` — and the natural repair path, patch_file with
  // targetType:frontmatter, is blocked by the very defect it would fix (it
  // has to parse the block to edit it), so only a full rewrite gets out.
  // Warn rather than refuse: with no YAML parser in this repo the check can
  // only be heuristic, and a false positive that blocks a legitimate write
  // costs more than a miss. The write has already happened at this point,
  // by construction — this cannot turn into a gate by accident.
  const fmDefects = detectFrontmatterDefects(content);
  return ({
    vault: vault.name,
    path: filePath,
    bytesWritten: Buffer.byteLength(content, 'utf8'),
    mode: ifMatch !== undefined
      ? `if-match:${casMode}`
      : ifNew
        ? 'create-only'
        : 'create-or-replace',
    // The hash of what we just wrote — the caller replays this as the next
    // ifMatch to chain edits without a re-read.
    contentSha256: contentSha256(content),
    ...(clickToOpenUrl && { clickToOpenUrl }),
    ...(okfSuggestion && {
      okfNameWarning: `Path is not OKF-safe (2026-07-29 policy: notes use ascii-kebab names). Suggested: ${okfSuggestion}`,
    }),
    // v0.59.0 — volet ②: writing INTO a generated projection is legal but
    // futile; say so instead of letting the next refresh silently undo it.
    ...(isProjectionPath(filePath) && {
      projectionWarning: `This path is a GENERATED OKF projection (root/per-directory index.md or wiki/log.md) — hand edits will be overwritten by the next refresh_okf_projections run. Edit the page frontmatter instead; the projections regenerate from it.`,
    }),
    ...(fmDefects.length && {
      frontmatterWarning:
        `The file was written, but its frontmatter block looks malformed and Obsidian will likely show "Invalid properties": `
        + fmDefects.map((d) => `\`${d.line}\` — ${d.reason}`).join('; ')
        + '. Quote the offending value and rewrite the file with write_file (+ ifMatch);'
        + ' patch_file and set_frontmatter cannot repair a block that does not parse.'
        + ' This is a heuristic — if the YAML is valid, ignore it.',
    }),
  });
}
