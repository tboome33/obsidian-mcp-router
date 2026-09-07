/**
 * The `--wiki-mode` catalogue seeds, in a module of their own.
 *
 * They used to be a `const` inside `scripts/setup-vault.mjs`, which is a CLI:
 * importing it RUNS it, so no test could read the object and the only way to
 * check it was to regex the source. An adversarial review showed what that
 * costs — the scan matched single-quoted strings on single lines only, so a
 * `"Sessions"` entry, or a new mode written as a multi-line array, was invisible
 * to a test whose whole job was to see exactly that. A scan with a blind spot
 * is worse than no scan: it reports the class swept.
 *
 * So the data moved here and the test imports it. There is nothing to parse and
 * nothing to keep in sync with a parser.
 *
 * The engine stays 100% deterministic: for the `domain` mode the frontend (LLM)
 * translates the user's one-line domain description into a flat section list
 * passed via `--wiki-sections`, and the engine simply lays those out. When no
 * mode is given, `scaffoldWikiMeta` uses the shipped generic template verbatim
 * (unchanged pre-wizard behaviour).
 *
 * Every list here passes through `partitionSeededAreas`
 * (`./session-folder-collision.mjs`) before it reaches a catalogue, so a name a
 * `wiki-meta/` folder owns cannot be seeded from here either.
 */

export const WIKI_MODE_SECTIONS = Object.freeze({
  personal: Object.freeze(['People', 'Concepts', 'Decisions', 'References', 'Projects']),
  research: Object.freeze(['Papers', 'Concepts', 'Hypotheses', 'Methodology', 'Findings']),
  business: Object.freeze(['Competitors', 'Clients', 'Decisions', 'Stakeholders', 'Meetings']),
  // v0.92.0 — `Sessions` REMOVED from this list. It was the only mode section
  // whose name a `wiki-meta/` folder already owns: the session journals live in
  // `wiki-meta/Sessions/` (v0.12.8 moved them out of `wiki/` for exactly this
  // reason), and seeding a `## Sessions` area here told every agent reading
  // `catalog.md` that a second, competing home existed under `wiki/`. One did:
  // a session recap filed into `wiki/Sessions/` on a real vault, next to two
  // raw journals under `wiki-meta/Sessions/`, with nothing linking them.
  // The mode keeps four areas rather than gaining an invented fifth — and the
  // user-facing description in `WIKI_MODES` (scripts/vault-plan.mjs) never
  // mentioned Sessions in the first place, so this closes that disagreement too.
  code: Object.freeze(['Codebases', 'Architecture Decisions (ADR)', 'Runbooks', 'Concepts']),
});
