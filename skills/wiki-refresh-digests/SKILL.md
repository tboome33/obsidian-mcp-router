---
name: wiki-refresh-digests
description: Regenerate stale digest sidecars in `wiki-meta/digests/` — useful after manual edits to wiki pages that haven't passed through `wiki-ingest`, or to backfill digests for pages that pre-date the v0.15.0 digest-sidecar convention. Companion to `wiki-lint --deep` (which detects which digests are stale). Use when the user says "refresh digests", "rebuild digests", "/wiki-refresh-digests", or after `wiki-lint --deep` flags stale digests.
---

# wiki-refresh-digests

Regenerate digest sidecars (`wiki-meta/digests/<page-slug>.md`) for pages whose digest is stale (page edited since last digest generation) or missing (page exists but no digest).

This is the **complementary writer** to `wiki-lint --deep`'s **read-only detector** : lint tells you which digests need refreshing ; this skill does the work.

## Pre-conditions

1. Target vault has `wiki/` and `wiki-meta/` scaffolding.
2. Vault is online.

## Modes

- **Default** : refresh ONLY stale digests (page hash mismatches stored `page_hash`) + create missing digests for pages that don't have one. Skip up-to-date digests.
- **`--all`** : force-regenerate every digest, even up-to-date ones. Use when the digest format or generation logic has changed (e.g. after a router upgrade).
- **`--for <page-path>`** : refresh ONLY the digest for one specific page. Use when you've just edited a single page in Obsidian and want its digest in sync without scanning the whole vault.

## Steps

### 1. Inventory pages + digests

```javascript
import { computePageHash, parseDigest } from 'src/helpers/digest-generator.mjs';

// List wiki pages — recurse since wiki has nested folders.
// (The same recursive helper described in step 2 also works here ;
// inline `listAllMd('wiki')` if not factored out.)
const pages = await listAllMd(vault, 'wiki');
// List existing digests — MUST be recursive enumeration since
// digestPathForPage uses NESTED mapping (review+ pass 4).
const existingDigests = await listDigestsRecursive(vault);
```

Filter pages to skip the same exclusions as the `wiki-ingest` digest-generation step (sources, wiki-meta scaffolds).

### 2. Classify each page

For each wiki page (not excluded) :

```javascript
import {
  computePageHash,
  parseDigest,
  digestPathForPage,
} from 'src/helpers/digest-generator.mjs';

const pageContent = await get_file({ vault, path: pageRelPath });
const pageHash = computePageHash(pageContent);
// CANONICAL helper — DO NOT improvise a path here. Must match what
// wiki-ingest step 5.5 used to write the digest, otherwise the read
// and write sides diverge and digests are effectively unfindable.
const digestPath = digestPathForPage(pageRelPath);
const digestExists = existingDigests.includes(digestPath);
```

**IMPORTANT — enumerate digests recursively** (review+ pass 4 fix). The NESTED `digestPathForPage` mapping (v0.15.0+) writes digests into a folder tree mirroring `wiki/` under `wiki-meta/digests/`. The Local REST API's `list_files` returns immediate children only — a single flat call returns `["wiki/"]` instead of the digest files themselves. To get all digest paths, recurse :

```javascript
async function listDigestsRecursive(vault) {
  const out = [];
  async function walk(dir) {
    const files = await list_files({ vault, directory: dir });
    for (const entry of files) {
      const full = `${dir}/${entry}`;
      if (entry.endsWith('/')) {
        await walk(full.slice(0, -1)); // strip trailing slash for next call
      } else if (entry.endsWith('.md')) {
        out.push(full);
      }
    }
  }
  await walk('wiki-meta/digests');
  return out;
}
const existingDigests = await listDigestsRecursive(vault);

let status;
if (!digestExists) {
  status = 'missing';
} else {
  const digestMd = await get_file({ vault, path: digestPath });
  const digest = parseDigest(digestMd);
  if (digest.pageHash === pageHash) status = 'fresh';
  else status = 'stale';
}
```

Bucket into three lists : `missing[]`, `stale[]`, `fresh[]`.

### 3. Plan the work

Surface to the user :

```
Vault `<name>` digest health :
- Missing digests : N pages
- Stale digests   : M pages
- Up-to-date      : K pages
```

If running in `--all` mode, all N+M+K pages get regenerated. Otherwise just N+M.

Ask once before proceeding when the total work is >20 pages (rate-limit caution). If ≤20, proceed without asking.

### 4. Regenerate

For each page in the to-regenerate set, do the SAME work as `wiki-ingest` step 5.5 :

1. Read the current page content.
2. Call `generateDigestSkeleton({pageContent, forPath})`.
3. Parse the skeleton, populate concepts/claims/keywords/summary/notable from the page's content.
4. Serialise with `serialiseDigest(populated)` and write to `digestPathForPage(pageRelPath)` (canonical helper — overwrites the stale digest at that location if present).

**Parallelisation** : use `Promise.allSettled` style or the `wiki-ingest` sub-agent pattern to batch the LLM calls if the to-regenerate set is large (>10 pages). Each digest generation is independent.

### 5. Report

Summary at the end :

```
Refreshed N digests :
- <page-slug-1> (stale → fresh)
- <page-slug-2> (missing → created)
- ...

Errors : M
- <page-slug-X> : <reason>
```

### 6. Append to log.md

```
- YYYY-MM-DD HH:MM — wiki-refresh-digests — <vault> · N refreshed · M errors
```

## Anti-patterns

- **Don't refresh fresh digests** (default mode) — wastes LLM calls. Only `--all` should re-generate up-to-date digests.
- **Don't blindly overwrite a stale digest** if its `notable` field has user-added content — `notable` is one of the few fields a human might edit manually. When refreshing a stale digest with existing `notable` content, preserve it (re-read the old digest, keep `notable`, regenerate the rest).
- **Don't fail loudly on one bad page** — if generating a digest for page X fails (write error, content too large, etc.), log it and continue with the rest. Best-effort batch refresh.
- **Don't skip the page hash recompute** — that's the whole point of "stale" detection. Always compute the fresh hash before deciding whether to regenerate.

## Quirks

- The digest generation step is the only LLM-heavy part of this skill. The rest (hash compute, parse, write) is cheap.
- Large vaults (>200 pages with no existing digests) on a `--all` refresh can take several minutes and N LLM calls. Consider doing it in batches by folder if needed.
- The `--for <path>` mode is the fast path for "I just edited a page and want its digest fixed now" — single LLM call, no scan.

## Reference

- Helper : `src/helpers/digest-generator.mjs`
- Tests : `tests/digest-generator.test.mjs`
- Companion lint mode : `skills/wiki-lint/SKILL.md` Check I (digest-stale)
- Roadmap source : item #7' in `wiki/Divers/LLM-WIKI-COMPILER/llm-wiki-compiler-roadmap.md` (vault `opsidian-mcp-router et bridge`)
