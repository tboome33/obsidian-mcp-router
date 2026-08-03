# The export gate (C9)

Three things built in this repository go somewhere else:

| Exit | Artifact | Goes to |
|---|---|---|
| `mcpb` | `obsidian-mcp-router-v<version>.mcpb` | MCPHub |
| `okf` | an OKF v0.1 knowledge bundle | whoever you share it with |
| `release` | a git tag + published release notes | GitHub, and every feed that mirrors it |

Each is an opportunity to leak, and until v0.68.0 nothing tied a published
artifact to the commit it claimed to be. All three now pass through one
module: [`src/helpers/export-gate.mjs`](../src/helpers/export-gate.mjs).

```bash
npm run gate                                  # scan the mcpb surface
node scripts/export-gate.mjs scan release     # scan the release surface
node scripts/export-gate.mjs audit x.mcpb     # verify an artifact, no extraction
npm run build:mcpb                            # build through the gate
```

---

## Why a whitelist, in one concrete example

`scripts/build-mcpb.ps1` used to select files with robocopy's `/XD` + `/XF`
deny list. A deny list is only as complete as the last time somebody
remembered to update it, and it was not:

```
server/.codex/config.toml        ← a live Authorization bearer token
server/.superpowers/…            ← 25 internal review documents
server/.githooks/…, .gitignore   ← development-only
```

All of it was inside `obsidian-mcp-router-v0.67.1.mcpb`, the file uploaded to
MCPHub. `.codex/` is *gitignored precisely because it holds a credential* —
git knew to protect it, the bundle did not, because the directory was created
after the exclusion list was written.

The same deny list also failed in the opposite direction. `/XD .claude`
matched a directory of that name **at any depth**, so it silently dropped
`templates/reference-vault-skeleton/.claude/settings.json` — a git-tracked file
that is part of the vault skeleton the bundle exists to ship.

Under `contracts/export-allowlist.json`, a file ships because a pattern names
it. The measured effect of the switch:

| | before | after |
|---|---|---|
| entries | 9695 | 9584 |
| real files removed | — | 33 (incl. the token) |
| real files added back | — | 1 (the skeleton settings) |
| directory-only entries removed | — | 63 |
| files silently lost | — | **0** |

The allowlist syntax supports `**`, `*` and a trailing-slash shorthand. It has
**no negation**, deliberately: a whitelist with negations is a deny list in
disguise. Where something generated must not ship, it is declared in
`vendoredPrune` with a written reason, not hidden as an exclusion.

---

## What the scan looks for

Five categories, each with a dedicated fixture *and its clean twin* in
`tests/export-gate.test.mjs` — the twin is what proves a rule discriminates
rather than matching everything.

| Category | Catches |
|---|---|
| `secret` | private-key blocks, AWS/GitHub/Slack/Anthropic/OpenAI/Google/npm key formats, JWTs, `Authorization:` headers, and generic `key = <high-entropy blob>` assignments |
| `personal-email` | any address outside the reserved domains (`example.com`, `.test`, `.invalid`, GitHub noreply) and the contract's `emailAllowlist` |
| `private-path` | Windows user profiles, `/home/…`, `/Users/…`, UNC shares, plus the machine's real roots |
| `symlink` | any symbolic link in the shipping set |
| `path-traversal` | `..` segments, absolute paths, drive letters, NUL bytes, Windows reserved device names |

### Two zones, and the limit that is stated rather than implied

`authored` files (written here) get all five categories. `vendored` files
(`node_modules/`, produced by `npm ci` from the committed lockfile) get the
path-safety rules and the **shaped** secret rules, but not the generic
`key = <blob>` rule.

That rule asks whether an author *meant* a value to be a credential. That
judgement is exercisable over ~310 authored files and is not over ~9,300
vendored ones, where documentation examples trip it constantly — hono and
undici each ship one, and `css-select` assigns a CSS selector to a key
literally named `password`. Running it there would produce a permanent list of
muted findings, which is how a scanner stops being read. A dependency's own
e-mail addresses and home directories are likewise upstream facts, not our
leak.

So: **a credential in a dependency is caught only if it has a recognisable
format.** That is a real limit, and it is here rather than in a footnote.

### Nothing is skipped silently

A NUL byte used to exempt a file from *every* content rule. That is not a
theoretical hole: a UTF-16 file — what "Save as Unicode" and PowerShell 5.1's
`>` produce, and plainly readable ASCII to anyone who opens it — is full of
NULs, and one under `src/` or `templates/` shipped completely unscanned while
the gate reported "no leak found".

The first fix keyed on NUL *parity*, which quietly assumed the text was
ASCII — so a UTF-16 note in Japanese or Russian, having NULs in neither
position, was still scanned as the empty string. Detection is now by decode
quality: both endiannesses are tried, and when either reads as text (mostly
printable, with a plausible share of ASCII) it is scanned; when both do, **both
are scanned**, because a leak scanner should never have to guess. A NUL-padded
fallback catches UTF-32 and anything else of that shape. For genuinely binary
content the printable ASCII runs are extracted and scanned. A PNG still
produces nothing; a bearer token inside one does not slip through because of
the bytes around it.

And the tally is **printed**, not merely computed:

```
  read as: text 309
```

Two earlier attempts at this counter each ended up with no consumer at all —
the value existed and nobody could see it. "No leak found" over a tree that was
largely unreadable is a different statement from the same words over one that
was fully read, and the operator now gets to tell them apart.

### Bytes that belong to no entry

An archive has places to put data that no file occupies: the EOCD comment, and
each entry's local extra field. Nothing read them, so a bearer token parked in
either audited perfectly clean. Both are now scanned, as are `SHA256SUMS` and
`export-manifest.json` themselves — those two are exempt from the *checksum*
comparison, never from the *leak* scan.

### Exceptions require a written reason, a path, and a category

There is no `--skip-scan`. An unwanted finding is silenced by an entry in
`scanExceptions`, and every one of these is required:

- a `reason` of at least 20 characters;
- a `path` pattern that is not `**`;
- a `category`, which may not be `path-traversal` or `symlink`.

An entry missing any of them is itself reported as a finding **and suppresses
nothing**. That strictness is not theoretical: while all three fields were
optional, a single entry containing only `{ "reason": "..." }` silenced every
category on every file — the whole scanner switched off by one well-meaning
line. Traversal and symlinks are unsuppressable because they are not
judgements about intent; they are structural properties that break the
consumer's extraction, and no written reason makes them safe.

Exceptions are scoped by package, never by a hashed build filename that
changes on the next upgrade.

### The self-reference trap

A file that spells out the patterns the scanner hunts for makes the scanner
fire on itself. The gate's own source, contract and tests therefore *describe*
credential formats and assemble them at runtime instead of writing them
literally. Excepting those files instead would have blinded the scanner to a
real secret committed into the gate's own source.

This bites documentation too, and it is easy to walk into: the CHANGELOG entry
announcing this feature originally illustrated the placeholder rule with a
realistic-looking account name as its *counter*-example, and the gate refused
the release surface over it. Describe the rule; do not demonstrate it with a
string that satisfies it.

---

## Reproducibility: what is guaranteed, and what is not

### Measured

Two full clean builds of the same commit — each with its own `npm ci`, staging
wiped in between — produce a **byte-identical** archive:

```
build 1: 744c56b3a24ff7936c84ceab56cfba7bbe3b91f7aab329c9fbea541116bea66f
build 2: 744c56b3a24ff7936c84ceab56cfba7bbe3b91f7aab329c9fbea541116bea66f
```

CI re-runs this on every push (Windows leg), and fails the build if the two
hashes differ.

### Normalised by the writer

| | |
|---|---|
| entry order | sorted by UTF-8 byte order, not filesystem order |
| mtime | frozen at the DOS epoch, 1980-01-01T00:00:00 |
| separators | always `/`; no leading `/`, no drive letter |
| version made by | host 0 (MS-DOS) — never the real OS |
| external attributes | 0 — no unix mode, no FAT bits, no umask leak |
| extra fields | empty — no `UT`/`Unix`/`NTFS` timestamp blocks |
| directory entries | not written; consumers create parents |
| compression | deflate level 9, or STORE when deflate does not shrink |
| manifest | carries **no timestamp** — a commit, not a clock |

### NOT guaranteed — say it plainly

1. **Across Node/zlib versions.** Identical input at an identical level gives
   identical bytes for a given zlib build, but zlib may change its encoder
   between versions. A build on Node 20 and one on Node 22 may produce
   different — both valid — archives. The manifest records `node` and
   `zlibVersion` so that when two builds of one commit disagree, it says
   whether the runtime is why.

   Note the consequence, because it is easy to miss: those two strings are
   themselves *inside* the archive. So the reproducibility key is **commit +
   toolchain**, not commit alone, and `--compression store` does **not** make
   two different Node versions agree — it only removes the deflate encoder from
   the equation, not the recorded runtime. CI builds on Node 22; a bundle built
   locally on another Node will not match it byte for byte, by construction.
2. **Across platforms.** Untested, and there is a known obstacle: `npm ci`
   creates `node_modules/.bin` as real files on Windows and as symlinks on
   Linux. That directory is pruned before the gate runs (declared in
   `vendoredPrune`), which removes the obstacle — but *cross-platform byte
   equality has not been measured and is not claimed.* The bundle is built on
   Windows.
3. **The input bytes themselves.** The gate reproduces an archive from a file
   set; it cannot make the file set reproducible. A clone with
   `core.autocrlf=true` has different bytes on disk than one with `input`
   (this repo's setting), and `npm ci` output depends on the npm version. Both
   are upstream of this module.

4. **A dirty worktree.** `source.dirty` is recorded inside the archive, so a
   build from modified sources is *marked* but not refused — and two builds
   from two different dirty states differ. `--untracked-files=no` keeps stray
   scratch files from flipping it. This bit was itself a bug worth recording:
   the build writes two sidecars next to the bundle, they were neither tracked
   nor ignored, and so the first build dirtied the tree the second one hashed —
   making the CI step that exists to prove reproducibility fail on every clean
   runner while blaming the ZIP writer. `git status` is now read once, before
   anything is written, and the sidecars are gitignored.

### ZIP64 is not implemented

The writer throws when an archive would exceed 65535 entries or 4 GiB, rather
than silently emitting a truncated central directory. The reader recognises a
ZIP64 archive and reports it instead of misparsing it.

---

## Audit without extraction

The dangerous half of consuming an archive is unpacking it — zip-slip,
symlink escapes, device names, case collisions. So every check is answerable
from the bytes:

```bash
node scripts/export-gate.mjs audit obsidian-mcp-router-v0.68.0.mcpb
```

- **names** — traversal, symlinks, Windows device names, case collisions that
  silently drop a file on extraction, non-normalised mtimes
- **structure** — the local file header of every entry against its
  central-directory record, the EOCD counts against the records actually
  present, duplicate names, multi-disk claims
- **integrity** — each entry's stored CRC-32 against its actual body
- **contents** — the full leak scan again, over what is really in the archive
- **the chain** — each entry's sha256 against the `SHA256SUMS` carried inside
  the archive, and `SHA256SUMS` against the hash pinned in
  `export-manifest.json`

Three separate ways of hiding an entry had to be closed, one per review round,
and they are worth listing because each looked closed after the previous fix:

1. **Lower the EOCD entry count.** The record stays in the file and falls
   outside the reader's loop. Closed by requiring the parse to land exactly on
   the declared end of the directory.
2. **Append a fresh EOCD** with a lower count *and* a shorter `centralSize`.
   Every invariant from (1) still holds. Closed by requiring the directory to
   end exactly where the EOCD begins.
3. **Add a local record the directory never declares.** Every check above
   iterates the *central directory*, so a complete local record spliced in
   before it — with the EOCD's offset bumped by four bytes — was invisible to
   all of them, while a streaming reader extracted the file. Closed by
   requiring the declared entries to **tile** the file contiguously: no gap, no
   overlap, ending exactly at the central directory.

The structural checks exist because a ZIP stores its metadata **twice** and
consumers disagree about which copy to believe. Listing tools (`unzip -l`,
`7z`, .NET, Python's `zipfile`) read the central directory; streaming readers
(Java's `ZipInputStream`, node's `unzipper`, libarchive from a pipe) read local
headers and never see the central one. An archive whose central record says
`server/abc.mjs` while its local header says `../../evil.mjs` therefore lists
as innocent and escapes the extraction root — a 14-byte patch was enough, and
every other check passed. Likewise, decrementing the EOCD entry count leaves a
fully-formed record physically present and merely invisible to a reader that
trusts the count.

### Consistency is not authenticity — the honest version

The chain proves the archive **agrees with itself**. It does not prove the
archive is the one the publisher built. An attacker who rewrites a file,
`SHA256SUMS` *and* the manifest together produces a perfectly consistent
archive — the suite contains that complete forgery and asserts it audits clean,
precisely so nobody re-reads the chain as a signature.

What refutes it is a hash obtained **elsewhere**: the `.sha256` sidecar
published beside the release, compared via `expectArchiveSha256`. The result
therefore reports two separate booleans — `integrityVerified` (contents were
inflated and hashed) and `authenticityVerified` (an external hash was supplied
and matched) — instead of one `ok` that could be read as more than it is. A
shallow audit records `integrity-not-verified` as a problem in its own right.

An archive with no `SHA256SUMS` is reported as one that never passed the gate,
which is the truth about every bundle built before v0.68.0.

---

## What each exit does with the gate

**`mcpb`** — `scripts/build-mcpb.mjs` stages the whitelist, runs `npm ci`,
prunes the declared generated directories, gates the staged tree, and refuses
to write anything on a finding. It then audits the archive it just produced.
`build-mcpb.ps1` is a forwarder; the deny-list build was removed rather than
kept as a fallback, because a working way around a gate is a way around it.

**`okf`** — `buildOkfBundle` runs the scan on every export. The scan is not
optional; what is conditional is the reward: `SHA256SUMS` and
`export-manifest.json` are appended **only when the bundle is clean**, so a
leaking bundle cannot ship wearing a valid-looking checksum set. The verdict
is on `report.gate.ok`, and the caller decides — only the caller knows whether
an address in a vault note is a leak or the point of the page.

**`release`** — `scripts/create-release.mjs` scans, for **every pending tag**,
the blobs of that tag as read by `git ls-tree` + `git cat-file`, plus the
release notes as their own document — all before the first push.

Three deliberate choices, each of which the first version got wrong:

- **The tag, not the worktree.** A secret committed and then "fixed" on disk
  without committing passed a worktree scan while the tag published the key.
- **Every tracked blob, not the allowlist subset.** GitHub generates a source
  archive containing *every tracked file*; the `release` allowlist governs what
  we assemble, and cannot shrink an archive GitHub makes. `docs/`, `tests/`,
  `.github/` and the deployment files are published regardless, so all 465
  tracked blobs are scanned — not the 309 the allowlist selects. Symlink
  blobs (mode `120000`) are read as links, not as one-line text files.
- **Every pending tag, not just the current one.** This script publishes a
  *backlog*; an older tag carrying a leak would otherwise be released on the
  strength of today's clean tree.

Notes are prose written by hand at the end of a long session, which is exactly
when a real path gets pasted in. A tag is public the moment it is pushed; a
refusal beforehand costs nothing.

---

## Private roots are derived, never committed

The rules that catch a *structural* private path (`C:\Users\…`, `/home/…`)
need no configuration. The rules that catch **this machine's** paths do — and
writing `C:\VAULTS\…` into a tracked file in order to detect it being
published would publish it.

So they are assembled at call time from the repo root, the home directory, and
`OBSIDIAN_ROUTER_EXPORT_PRIVATE_ROOTS` (`;`-separated; `:` also separates
POSIX paths, and a Windows drive colon is not mistaken for a separator). A test
asserts the committed contract contains no machine-specific root.

Structural rules are placeholder-aware: `C:\Users\me` and `${USER}` are
documentation, a real account name is not. (Spelled in prose deliberately —
writing an example of the second kind here would trip the rule, as it did
once.) Without that step the scan reported 40
private-path findings on this repo, most of them its own examples — and a check
that cries on its own examples is a check everyone learns to skip. Of the 20
that survived, every one was fixed at the source rather than excepted, so the
gate starts with **zero authored-zone exceptions**.
