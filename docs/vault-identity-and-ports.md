# Vault identity, ownership, and where ports come from

> Shipped in v0.94.0. This page is the reference for the four things that changed together: a vault
> now has an identity that survives being renamed, an installation has one too, ports for new vaults
> are drawn from a band and checked against the machine, and only a vault's owner may rewrite them.

---

## 1. An installation draws its allocation base once

The first time this router provisions a vault on a machine, it records two things in
`~/.claude/obsidian-mcp-router/config.json`:

```json
{
  "installId": "…-a UUID-…",
  "installHostname": "ROLAND-PC",
  "portStart": 23742
}
```

`installId` is drawn from a cryptographic source. `installHostname` is a **label**, recorded at the
moment the identity was created, and it decides nothing — see §5.

**An existing `portStart` is never recomputed.** If your configuration already carries one, it stays,
whatever the band below would have chosen. Roland's installation has `portStart: 27181`, which sits
inside the excluded range, and it survives every start-up untouched.

**A damaged value is reported, not replaced.** A `installId` that is not a UUID, or a `portStart`
that is not a port, produces a diagnostic and is left alone. Overwriting a broken identifier would
silently orphan every vault out there that names this installation as its owner — and the orphaning
would look exactly like a clean start-up.

### Changing the base deliberately

```bash
node scripts/setup-vault.mjs --force-new-port-start --dry-run
```

Prints the plan — previous base, new base, band, registered vault count, `installId: preserved`, and
**`EXISTING ports changed: 0`** — plus an `approvedPlanSha256`. Then:

```bash
node scripts/setup-vault.mjs --force-new-port-start --port-start <the base shown> --approved-plan-sha256 <the seal>
```

`--port-start` is required on apply: the base written is the base you read, never redrawn. The seal
refuses if a vault was registered, unregistered or renumbered in between. Also available as
`/obsidian-router:force-new-port-start`.

---

## 2. The band, and what it does not promise

New pairs are drawn from **20000–32000 inclusive, minus 27000–27999 inclusive**. Both members of a
pair must land in the allowed portion, so a base near an edge whose partner would fall outside is
rejected. There is no overflow: an exhausted band is an explicit, finite error, never a quiet step
outside it.

The ceiling keeps both ports below 32768, where Linux begins handing out ephemeral ports (Windows
starts at 49152). The excluded thousand is where the historic fleet lives — 54 configured ports
between 27124 and 27192 — and where Local REST API's factory settings sit (27124/27123).

**A random base is not a reserved range.** Two installations drawing independently can still
collide; the draw only makes it unlikely that two machines creating vaults in the same order land on
the same numbers. This is why the two other checks stay mandatory:

- every port already known to this installation is excluded, across **both** protocols and from both
  the registry and the vaults' own `data.json`;
- every candidate is **bind-tested on loopback** before it is promised, because the registry only
  knows vaults the router registered. An unregistered vault, a dev server or a tunnel is invisible to
  it and perfectly able to hold the port — and Local REST API has no `EADDRINUSE` handler anywhere in
  its `main.js`, so the loser of that race never binds and its vault looks *absent* rather than
  misconfigured.

**A probe is not a reservation.** Nothing holds the port between the check and the moment Obsidian
binds it. An error or a timeout from the probe counts as *taken*, never as free.

---

## 3. Historic pairs are never normalised

The `+10` gap is a convention applied when **creating** a pair. It is not a law the fleet obeys and
it is never a repair rule: 18 of the 27 production pairs do not respect it and six run *backwards*
(`tribu` is 27172/27145). Every plaintext port is written into `http://127.0.0.1:<port>/open/…` links
in the user's notes, so moving one breaks links that were correct for months.

A vault that already has ports keeps them — when it is adopted, when it is claimed, when the base
changes, when the registry is migrated. The band governs creation only.

---

## 4. A vault's identity

`.obsidian/obsidian-mcp-router/identity.json`:

```json
{
  "schemaVersion": 1,
  "vaultId": "…-a UUID-…",
  "owner": { "installId": "…", "hostname": "ROLAND-PC" },
  "createdAt": "2026-09-09T…"
}
```

It deliberately carries **no API key** (it sits in a folder Drive replicates), **no absolute path**
(it would be wrong the moment the folder moved, which is the event the file exists to survive), **no
port** (those live in the plugin's `data.json`, which is what the plugin actually binds — a copy here
would be a second source of truth drifting under synchronisation), **no authoritative name** (names
are local: you may call a vault one thing and another machine another, and neither is wrong), and
**no hardware identifier**.

### Why not the API key, or Obsidian's own ids

The API key is a secret, it rotates, and — decisively — a vault copied folder-and-all carries its
source's key, so two independent vaults can present the same one. Obsidian's vault ids from
`%APPDATA%/obsidian/obsidian.json` are assigned **per machine**: the same folder open on two PCs has
two different ones, which is useless as an identity across machines that share vaults.

### Where the file lives, and the limits of that

`.obsidian/` was chosen (decision D2) because it can be read and written **while Obsidian is closed**.
A note in the vault's content would have to be written through MCP, MCP needs the vault's REST server,
and that server only runs when Obsidian has the vault open — so migrating 27 vaults would have meant
opening 27 vaults.

The honest limits: Google Drive replicates `.obsidian/`, so on *this* fleet the identity travels. It
will **not** necessarily travel with Obsidian Sync, nor with a Git clone that excludes `.obsidian/`.
Nobody should describe this location as "always synchronised".

---

## 5. Ownership: what it is, and what it is not

Only the installation recorded as a vault's `owner` may rewrite that vault's Local REST API
`data.json`. This covers provisioning, the `--upgrade-insecure-server` repair path, and both plugin
re-clone paths.

**UUIDs are compared. Hostnames never are.** Two machines can carry the same label and one machine can
change its own, so:

| Situation | Verdict |
|---|---|
| Owner's `installId` is this installation | allowed |
| A different `installId`, the **same** hostname | refused |
| The same `installId`, a **different** hostname | allowed |
| `owner: null` — nobody has claimed it | refused |
| The identity file is missing, unreadable or damaged | refused, and never regenerated |

**"Unknown owner" is a valid state.** It is the state all 27 historic vaults migrate into, and it
refuses writes — which is the point: the friction is the signal that an authorisation is missing.

**Reading is never gated.** A foreign vault can be read, listed, and have its local path recorded.
Only writing its own plugin configuration is refused.

**This is a rule the router applies to itself, not a lock.** Drive can overwrite the file, a person
can edit it, and an older router does not know it exists. The identity is re-read immediately before
any mutation, which narrows the window; it does not close it, and no distributed lock exists across
two machines sharing a folder.

### Claiming, transferring, releasing

```bash
node scripts/setup-vault.mjs --vault-owner "<path>" --show
node scripts/setup-vault.mjs --vault-owner "<path>" --claim
node scripts/setup-vault.mjs --vault-owner "<path>" --release --acknowledge-transfer
```

Taking a vault that already has an owner requires `--acknowledge-transfer`, and the current and new
owners are both shown first. The operation writes one field of one file: **no port changes, no key is
minted, no vault is opened.**

Running `setup-vault.mjs <path>` on an **unclaimed** vault claims it — that is an explicit,
per-vault act, unlike the migration, which claims nothing.

---

## 6. Copy, replica, move — three different things

| What happened | How it looks | What is done |
|---|---|---|
| The folder was **renamed or moved** | one UUID, old path gone | the record follows the UUID: same ports, same key, same bindings, same custom name |
| The folder is a **synchronised replica** | one UUID, two paths, both present | **blocked** — changing it here breaks the other machine |
| The folder is an **independent copy** | one UUID, two paths, both present | **blocked** until you say so explicitly |
| Two spellings of **one** directory | one UUID, two paths that normalise to one | folded silently; it is one vault |

A duplicate UUID **never** triggers automatic regeneration. The three situations above are
indistinguishable from the outside and call for opposite actions; guessing "copy" and regenerating
identity, key and ports destroys a replica.

Detaching a copy requires explicit consent that it is to become independent *and* that its changes
will not propagate back through synchronisation. If the copy already serves a plaintext HTTP port,
links may already point at it — detaching is then blocked rather than creating a twin or breaking
links.

**Finding a moved vault has limits.** The router does not search your disks. Give it the new path.

### Shared API keys

Since v0.94.0 the router compares key fingerprints across **every** registered vault, not only
against the reference. A match is **reported and never repaired**: a synchronised replica
legitimately shares its source's key and rotating it would lock the other machine out, and giving the
two vaults distinct UUIDs would make the registry look correct while the identity probe stayed
ambiguous. Only a truncated SHA-256 is ever printed — never the key, never a prefix of it.

---

## 7. Migrating the registry

```bash
node scripts/setup-vault.mjs --migrate-vault-identities --dry-run
node scripts/setup-vault.mjs --migrate-vault-identities --approved-plan-sha256 <seal>
```

An **explicit** operation, never a side effect of starting up. It stamps each registered vault with a
UUID (`owner: null`) and rewrites the router's own configuration to key vaults by that UUID
(`schemaVersion: 2`, `vaultsById`). `portRegistry` is removed: keeping it would leave a second,
independently-editable copy of the same facts. The path index every caller uses is derived from
`vaultsById` on each read.

It changes **no port, no key, no `data.json`**. Custom names, workspace bindings, refusals, the
default vault, `openVaults`, `vaultReach`, the reference vault and any key a newer version added all
survive untouched.

**It blocks rather than guessing** on: a duplicate UUID, a registered directory that is not on this
machine, and an identity file that cannot be read. Nothing is migrated silently while other entries
are dropped.

**Resuming.** No transaction spans 27 Drive-replicated folders and a local file, so the run is
journalled: the journal is written before anything is created, each identity is created conditionally
and recorded, everything is re-read before the configuration is rewritten *last*. An interrupted run
leaves vaults carrying identities and a config that does not point at them — harmless, because
nothing reads an identity until the config references it. A resume reuses the identities already
created and never mints a second UUID for a folder that has one, which may already be on the other
machine. **Nothing is ever rolled back blindly.**

**Going back.** Restore the configuration backup the run leaves beside `config.json`. Do not run an
older, writing router against a migrated configuration: it does not know `vaultsById` and will not
respect it.

**Restoring a config on another machine** duplicates `installId`. That is not detected automatically
— a differing hostname is not evidence of anything (see §5) — so reset the installation deliberately
if you do this.

---

## 8. When a port changed and the vault "went offline"

Reading `data.json` needs no server, so a drift is visible while Obsidian is shut. `list_vaults`
reports it in `portDiagnostics[]`, and each vault carries a `reachability` verdict saying which of
eight situations it is in.

**The router has already followed the new port.** Refreshing its own record is a separate, explicit
act that writes the registry and never a vault:

```bash
node scripts/setup-vault.mjs --sync-port-registry
```

"Open this vault in Obsidian" is suggested only where it can work. It cannot take a port back from
another process, cannot refresh a key a live server is refusing, and is not needed to read a
configuration file.

**No message blames synchronisation for a drift.** Drive is a plausible cause; a plausible cause
stated as a fact is how someone stops looking for the real one.

**After changing plugin settings by hand,** reload the Local REST API plugin (or reopen the vault):
the router reads the file, but the plugin only binds what it read at start-up.

---

## 9. Out of scope, deliberately

Renumbering the plaintext ports of existing vaults, and any rewriting of links that would require.
External links — mail, transcripts, bookmarks — are unreachable by any such rewrite, which is why
decision D1 kept the whole operation out of this release. Also out of scope: a proxy or redirect for
old ports; different ports per machine for one synchronised vault; a central allocation service; any
mathematical guarantee against collisions between independent installations; identification by MAC
address; and an exhaustive search of every disk for a moved vault.
