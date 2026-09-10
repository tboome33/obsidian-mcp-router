## Prompt lifecycle — `status` frontmatter on `type: prompt` pages (mandatory, since 2026-09-10)

A **prompt page** in this vault is a *work order*: a self-contained brief written to be pasted into a fresh agent session and executed. It is not a proposal to be accepted or rejected — that is what a `decision` page is for, and it has its own separate vocabulary (`proposed` / `accepted` / `superseded` / `rejected`).

Because a prompt is a work order, its `status` describes **the run, not the writing of the document**. Every `type: prompt` page MUST carry one of these five values:

| Value | Meaning | What a reader should do |
|---|---|---|
| `draft` | The brief is still being written. It is not pasteable yet. | Don't run it. Finish it, or ask its author what is missing. |
| `ready` | The brief is finished and can be pasted into a session as-is. | This is the only state that invites execution. |
| `in-progress` | A session is executing it right now. | Don't start a second one — that is a duplicate run. |
| `executed` | It was run and delivered. **The page is now an ARCHIVE, not a task.** | Read it for history. Do **not** re-run it. |
| `abandoned` | It will not be run — superseded by another approach, or the need went away. | Read it for the reasoning. The page is kept precisely so the reason survives. |

### Why the distinction between `ready` and `in-progress` is load-bearing

These two are the pair that costs something when confused. A brief left at `ready` while a session is executing it invites a **second session to run the same work order** — the most expensive mistake this vocabulary exists to prevent. Move it to `in-progress` when you start, and to `executed` when you deliver.

Conversely, a finished brief left at `ready` reads as an open invitation forever. Closing it is not bookkeeping; it is what stops the next agent from redoing delivered work.

### Why an executed prompt is kept rather than deleted

An `executed` or `abandoned` page keeps the reasoning that produced it, and other pages link to it. Deleting it would break those links and lose the history. State the outcome in the page — a short callout at the top saying when it ran and what came of it — and leave the page in place.

### What this convention does NOT do

It does not hide anything. A closed prompt stays visible in searches and in the frontier ranking, annotated with its status — per the accepted decision *"pages closes — annoter par défaut, cacher sur demande"*. Hiding a page because of its status is a per-vault calibration a caller asks for explicitly, never a default derived from this table.

### Related

The `wiki-lint` skill checks this convention (Check P): a `type: prompt` page with no `status`, or with a value outside the five above, is reported as a WARNING — with a suggested replacement when the value is a known older spelling (`done` and `shipped` both meant `executed`).
