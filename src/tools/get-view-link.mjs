/**
 * get_view_link — ask the Dedibox "view-agent" for an ephemeral Cloudflare-tunnel
 * link that opens a vault's LIVE Obsidian GUI in a browser, navigated to a specific
 * note, with HTTP basic-auth baked into the URL so the user types nothing.
 *
 * This is the EXPLICIT, on-demand entry point. The same view-agent transport also
 * powers the DETERMINISTIC auto-injection (`viewLink` on note-write results) — both
 * share `fetchViewLink` in src/helpers/view-link.mjs.
 *
 * Why this exists: the canonical long-term answer for "let me read what the AI just
 * wrote" is the headless web app (per-note markdown view + signed magic-links). This
 * is the INTERIM: it surfaces the existing container GUI (Selkies, streamed) through an
 * on-demand tunnel that the view-agent starts and auto-closes after an idle timeout —
 * ephemeral, never permanently exposed. The agent navigates Obsidian to the note
 * (Local REST API POST /open) before returning, so the link lands ON the note.
 *
 * Read-only with respect to vault CONTENT — it only spins a tunnel and moves the
 * Obsidian UI — so it is NOT in WRITE_TOOL_NAMES (stays exposed under READONLY).
 */
import { fetchViewLink } from '../helpers/view-link.mjs';
import { canonicalVaultPath } from '../helpers/vault-path-guard.mjs';
export async function getViewLinkTool(registry, args = {}) {
  const { vault: name, note } = args;

  if (note != null && typeof note !== 'string') {
    throw new Error(`\`note\` must be a string, got ${typeof note}.`);
  }

  // Resolve/validate the vault through the registry (canonical name + existence,
  // honours the default-vault cascade when `vault` is omitted).
  const vault = registry.resolveVault(name);

  // THE FIFTH TOOL. Round 14 covered get_file / get_frontmatter / list_files,
  // round 15 covered open_in_obsidian, and this one — which does nothing BUT
  // put a caller-supplied note path on a wire — kept sitting in
  // NO_VAULT_CONTENT_MUTATION, true and irrelevant, for three rounds. The wire
  // guard could not see it because it bails on "not configured" when no agent
  // URL is set, so it lived in the guard's unreached list rather than in its
  // results. `../../../active/` went out as /view?vault=v&note=..%2F..%2F..%2F
  // active%2F — and unlike every other escape in this file, the collapse does
  // not happen HERE: the note is a query parameter, so containment is decided
  // by the view-agent, a SEPARATELY VERSIONED service the docs explicitly
  // invite third parties to reimplement against a two-field HTTP contract.
  // Handing an unvalidated path across that boundary is the router deciding
  // that someone else will check it.
  //
  // `note` is optional, so absent stays absent; present gets THE canonical
  // spelling, and that spelling is what goes on the wire AND what is echoed
  // back — the open_in_obsidian lesson: computing a canonical value and then
  // discarding it is the bug with extra steps.
  const safeNote = note == null || note === '' ? null : canonicalVaultPath(note, 'note');

  // Explicit call → surface a clear error if anything fails (throwOnError defaults true).
  const data = await fetchViewLink({ vaultName: vault.name, note: safeNote });

  return ({
    vault: vault.name,
    note: safeNote,
    url: data.url,
    expiresInSeconds: typeof data.idle_timeout_s === 'number' ? data.idle_timeout_s : null,
    hint:
      'Ephemeral view link — opens the live Obsidian GUI in a browser (credentials are ' +
      'in the URL, nothing to type), navigated to the note. Auto-closes after the idle ' +
      'timeout; ask again for a fresh link if it has expired.',
  });
}
