## Temporal validity — `valid_from` / `valid_through` frontmatter (optional, any page type, since 2026-09-11)

Some knowledge is only true for a while. A VAT rate, a regulatory threshold, a contract clause, a price list: each one **comes into force** on a date and **stops applying** on another. Without metadata for that, a page describing a rule repealed six months ago reads exactly like a rule in force — and an agent will apply it.

Two optional fields say when a page applies. Both are ISO calendar dates, written as **strings, at the top level of the frontmatter**:

```yaml
valid_from: 2026-01-01      # first day it applies, INCLUDED
valid_through: 2026-12-31   # last day it applies, INCLUDED
```

### The rules, in full

| Rule | What it means |
|---|---|
| **Both optional, independent** | `valid_from` alone means "applies from that day, no known end". `valid_through` alone means "applied since forever, until that day". A one-day window (`valid_from` = `valid_through`) is valid. |
| **Bounds are INCLUDED** | `valid_through: 2026-12-31` still applies on 31 December. That is what *through* means, and what a contract or a statute means by "jusqu'au 31 décembre". |
| **Calendar dates only** | `YYYY-MM-DD`, and the day must exist: `2026-02-30` is unreadable, not valid. No time, no timezone — the granularity is the day. |
| **Top level, and a plain value** | Never nest them under a parent key, and never give one a block of its own. Both mistakes read differently through the two frontmatter parsers in play — one flattens, the other does not — so the same page means two different things, and one of the two readings can be a confident wrong answer rather than an error. Neither is detectable after the fact: write the date on the key's own line. |
| **Empty means that BOUND is absent** | A key with no value, `null`, or `~` is read as *that bound not being declared* — not as an error. That is what YAML says, and it is the only reading both parsers agree on. The page loses its window entirely only when BOTH bounds end up absent; `valid_from: null` next to a real `valid_through` leaves the real one standing. |
| **A typo is visible, never silent** | `01/01/2026`, a number, a list: the window becomes `unreadable` and is surfaced as such. A mis-typed date must never quietly turn a perishable page into a permanent one. |

### What a reader (or an agent) gets from it

At any reference day — today by default, in UTC — a declared window puts the page in exactly one of four states: **not yet in force**, **in force**, **no longer in force**, or **unreadable**. A page with no window has *no state at all*: it makes no temporal claim, and nothing annotates it. That is the normal case for almost every page.

Nothing is ever hidden because of its state. A repealed rule is still knowledge: it explains the past and it explains the rule that replaced it. Tools annotate the state; excluding by state is something a caller asks for explicitly, and even then a window that is unreadable, absent, or that could not be read is **never** excluded — a filter may remove certainties, never doubts.

### What this convention does NOT do

- It does **not** replace `status:`. That field says whether a decision is still the live verdict — an editorial question. A decision can be `accepted` and no longer in force at the same time.
- It does **not** replace `review_after:`. That field means "re-examine this ruling", not "this stopped applying". A page can carry both, and both are shown.
- It does **not** chain versions. "The 2026 rule replaces the 2025 one" is `supersedes:`, and that contract covers decision pages only.
- It is **never required**. No linter asks for a window — nothing can know that a page is regulatory. What is checked is that a *declared* window is readable and coherent.

### When to set one

Set a window whenever the page describes something whose applicability is bounded by dates that the source itself states: a regulation, a rate, a tariff, a contractual period, a policy with an announced start. Do not infer one. If the source does not give a period, the page has no window — exactly like `published:`, an absent value is honest and a fabricated one is not.
