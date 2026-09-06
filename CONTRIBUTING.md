# Contributing to obsidian-mcp-router

Thanks for considering a contribution. This project is small and opinionated — keep that in mind before opening a large PR.

## Quick orientation

- `src/` — the npm package (MCP server)
- `tests/` — Node `node:test` suite (`npm test`)
- `bin/obsidian-mcp-router.mjs` — CLI entry + `.env` loader
- `commands/` — Claude Code plugin slash commands
- `skills/` — Claude Code plugin skills
- `agents/` — Claude Code parallel sub-agents
- `hooks/` — opt-in hooks for the plugin
- `templates/` — files cloned into bootstrapped vaults (notably `wiki/CLAUDE.md`)
- `scripts/setup-vault.mjs` — vault bootstrap script
- `docs/` — auxiliary docs (auto-enrichment placement, remote vaults, Cloudflare Tunnel, quick-reference PDFs)

## Before you open a PR

1. Run the test suite: `npm test` — the full suite (2253 tests at v0.48.0) must pass with 0 failures. New code should add tests where it makes sense.
2. Update `CHANGELOG.md` under `## [Unreleased]` with a one-line summary of your change.
3. If the change touches the consigne (`templates/wiki/CLAUDE.md`), the slash command catalog (`README.md`), or any user-facing flow, update both EN and FR variants of the docs in lockstep.
4. If the change adds a new MCP tool or env var, document it in:
   - The tool description in `src/index.mjs` `TOOLS` array
   - `bin/obsidian-mcp-router.mjs --help`
   - `README.md` (EN + FR) and the quick-reference pages (`docs/quick-reference-{en,fr}.html`), then **`npm run docs:quick-reference`** to re-render both PDFs and refresh `docs/quick-reference.manifest.json`

   `npm run validate` refuses when a quick-reference page has changed since its PDF was rendered, so "edited the source, forgot the render" fails by name instead of shipping a PDF that contradicts the page. It also pins the artifact counters *in those pages* — they are not free-text: both state the command, tool and skill counts twice, and both sites are guarded — and the **masthead version**, which must equal `package.json`'s.

   `npm run bump` syncs both mastheads for you (only the masthead: the other version each page names is the release that shipped a feature, and stays). Because that edits the pages, their PDFs become stale and `validate` says so — run `npm run docs:quick-reference` before committing the bump. The bump prints this as step 2.

## Release process (for maintainers)

The release rhythm matches the rule pinned in [`docs/release-process.md`](./docs/release-process.md) (link added in a future commit) and applies to **non-doc-only commits**:

1. **Code** — write the change, including tests.
2. **Claude Review** — run a code-review pass via the Claude Code `code-reviewer` sub-agent on the staged diff. Triage findings.
3. **Codex audit** — `codex review --commit <sha> --title "v<x.y.z> ..."` on the same surface. Triage.
4. **Apply Critical + Major findings** before push; defer Minors with explicit follow-up.
5. **Version + tag** — `npm run bump <x.y.z>` syncs the 5 version files, inserts a CHANGELOG stub, and arms the versioned `.githooks/post-commit` hook (it re-ensures `core.hooksPath = .githooks` on every run). Write the real CHANGELOG entry, then commit — the hook auto-tags `v<x.y.z>` on the commit that carries the bump. No manual `git tag` step: forgetting it is what let the repo ship 40 untagged versions between v0.8.2 and v0.47.0.
6. **Publish** — `npm run release` pushes the branch + the tag and creates (or idempotently updates) the GitHub release with notes taken from the version's CHANGELOG entry. It refuses to publish while the CHANGELOG entry still contains the `TODO` stub. `npm run release -- --dry-run` previews without touching anything.

For doc-only commits (README, ROADMAP, comment-only edits, plugin manifest version bumps with no behavior change), the audit cycle is optional but encouraged for catching factual drift.

## Code style

- ESM Node 20.19.0+. No CommonJS, no transpilation step.
- Prefer 2-space indent, single quotes, trailing commas.
- Comments explain *why*, not *what*. The codebase already follows this — please match.
- Async / await over `.then()`. No callbacks.
- No new dependencies without a clear case in the PR description. The current footprint is `@modelcontextprotocol/sdk` + `undici` only.

## Testing

```bash
npm test
```

Tests are pure Node (`node:test` + `node:assert`) — no external services, no fixtures-as-files, no test runner config. They pass on Linux + Windows in CI (see `.github/workflows/test.yml`).

If you add Windows-specific path logic, please add a regression test that exercises both POSIX and Windows codepaths (use `process.platform` to gate, see existing `samePath` tests).

## Issue reports

Use the issue templates in [`.github/ISSUE_TEMPLATE/`](./.github/ISSUE_TEMPLATE/). Include:

- Router version (`obsidian-mcp-router --version`)
- Plugin version (the marketplace entry in `~/.claude/settings.json`)
- Node version
- OS
- Minimal repro
- Stderr output from the router (start it with `obsidian-mcp-router` directly to see logs)

## License

By submitting a contribution, you agree it will be licensed under the [Apache 2.0](./LICENSE) terms covering the rest of the project.
