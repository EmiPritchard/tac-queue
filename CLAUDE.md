# TAC Support Queue — handover notes

Context for anyone (human or AI) picking this project up cold. Read this before
changing anything: several Jira behaviours here fail *silently* if you assume
the obvious thing.

`README.md` covers install, config and deployment. This file covers **why the
code is the way it is** and **the facts that were expensive to establish**.

---

## 1. What this is

A read-only dashboard over the Access4 UK TAC service desk queue. It began as a
Claude Cowork artifact, was ported to the Claude Artifacts platform, and was
then rebuilt as this standalone site so people without Claude accounts could
use it.

Five views. Four are fed by a **single** Jira fetch of open tickets; the
Closed list is the exception and runs its own query (section 5).

| View | What it shows |
|---|---|
| Live queue | Summary tiles, status/priority/type charts, assignee load, drill-downs |
| Priority list | All open tickets in an 11-tier triage order (section 4) |
| Closed | Closed/resolved tickets in a chosen date window, newest close first (section 5) |
| Historical | Week-by-week created/resolved, SLA attainment, CSAT |
| Wallboard | Full-screen KPI view for a TV |

Clicking any ticket row in any of those lists opens a **history timeline**
for that ticket (section 6) — a modal, not a tab.

Plus **Personal mode**, which filters every view to the signed-in user.

## 2. Verified Jira facts

All confirmed against the live instance on 28 Aug 2026. Don't re-derive these.

**Site & project**

- Cloud ID `5e94f2c7-6692-40a8-af5e-59a01701861e`, site `access4.atlassian.net`
- Project `TAC` = "Service Desk – UK TAC", id `10250`
- Company-managed (classic) Jira **Service Management** project

**Priorities** — reference by ID, names contain a pipe and are easy to mistype:

| ID | Name |
|---|---|
| 10000 | P1 \| Critical |
| 10001 | P2 \| Major |
| 10002 | P3 \| Moderate |
| 10003 | P4 \| Minor |
| 10004 | P5 \| Low |

**Statuses — the list is NOT closed, and two of them were missed for months.**
Measured 4 Sep 2026 against the whole open queue (52 tickets after `TP_FILTER`;
one page, `hasNextPage: false`, so this is all of it):

| Status | Open tickets | Styled? | Parked? |
|---|---|---|---|
| Pending Response | 23 | yes | yes |
| Awaiting External Party | 12 | **no** — see below | no |
| Awaiting Internal Team | 9 | no | no (hidden by default instead) |
| **Restored** | **3** | **no** | **undecided** |
| Requester Responded | 2 | yes | no |
| In Progress | 2 | yes | no |
| New | 1 | yes | no |
| **Scheduled With Partner** | 0 (transient) | yes, since 4 Sep 2026 | yes, since 4 Sep 2026 |

`Scheduled With Partner` (id 10513) was found in TAC-6225's changelog. Nothing
sits in it right now — confirmed by JQL, where `status in (10513, 10484)`
returns 24 and `status = 10513` returns 0, so the id is recognised and the
status is simply passed through. It is now treated exactly like Pending
Response (section 4 and `PARKED_STATUSES`).

`Restored` has **3 live tickets** and no treatment at all: no colour, so it
renders grey, and it is not in `PARKED_STATUSES`, so it can be pulled into the
P1/P2 tier and flagged as stale. Whether that is right is a business question
nobody has answered — "restored" plausibly means the service is back and the
ticket is waiting on the requester to confirm (parked, like Pending Response),
or that it is waiting on an agent to close it (not parked). **Left alone
deliberately**; do not guess.

Note also `STATUS_BG`/`STATUS_FG`/`STATUS_COL` contain the key
`'Awaiting external party'` in lower case, while the actual status name is
`Awaiting External Party`. The lookup therefore misses and falls through to the
grey default — which happens to be the same grey that was intended, so nothing
looks wrong, but the entry is dead code and `Awaiting Internal Team` is
indistinguishable from it in the charts. Anything matching a status by string
should assume neither the spelling nor the set is settled: ticket changelogs
also carry `Awaiting partner action` and a lower-case `Awaiting external
party`.
There is **no** "To Triage" or "To Respond" status — those terms in the tier
spec map to New and Requester Responded respectively.

**SLA custom fields** (all six are read for SLA state):

| Field | Name |
|---|---|
| `customfield_10967` | First Response Time |
| `customfield_10968` | Restoration |
| `customfield_10969` | Resolution |
| `customfield_10970` | Time with Agent |
| `customfield_10879` | Triage target |
| `customfield_10906` | Response Target |

**The three TAC Owner fields** (confirmed 4 Sep 2026) — `customfield_10859`
"1.5 TAC Owner", `customfield_10860` "2.0 TAC Owner", `customfield_10861`
"2.5 TAC Owner". These are **not** `assignee`: they are what the TAC
escalation path actually moves between people, and a hand-off usually shows
up as a change to one of them rather than to `assignee`. Only the timeline
reads them; the list queries do not fetch them.

**Other custom fields:** `customfield_10002` organisation,
`customfield_10854` product, `customfield_10690` CSAT,
`customfield_10700` / `customfield_10690` used in historical,
`customfield_10874` TAC Tier — single-select, `{value: "1.5"|"2.0"|"2.5"}`,
powers the Priority list's tier filter (added 28 Aug 2026, confirmed against
81 live open tickets: only those three values occur, no nulls — though the
filter still treats "all three checked" as unfiltered rather than exact
membership, so an unseen 4th value or a null wouldn't be silently dropped).

**Closed-side facts** (established 4 Sep 2026, for the Closed list):

- Closed statuses actually in use are **Closed** and **Resolved**. Neither is
  in `STATUS_BG`/`STATUS_FG`, so both fall through to the grey default — fine,
  since on that tab the column is near-constant.
- **"Closed" is `statusCategory = Done`, not `resolved IS NOT EMPTY`.** Seven
  TAC tickets carry a resolution date but were later reopened into a live
  status: TAC-6188, TAC-6214, TAC-6152, TAC-6031, TAC-5990, TAC-5440,
  TAC-5400. Keying the Closed list off the resolution date would list those as
  closed while they are actively being worked.
- **Those same seven are in NO view at all today.** The live queue's JQL says
  `resolution = Unresolved`, which excludes them, and the Closed list excludes
  them too. Pre-existing live-queue gap, not one the Closed list introduced.
  The fix would be `statusCategory != Done` in `loadLive()`; deliberately not
  done in the same change, since it moves tickets into the triage view.
- **Volumes are wildly uneven because of the HubSpot→Jira migration.** 5,451
  tickets are Done in total, and **5,225 of them closed in Apr–Jun 2026**
  (5,038 in May alone) as a bulk-close carrying resolutions named "Historical
  TAC ticket resolved during migration". Everything since is ordinary volume:
  382 in the last 90 days, 226 in Jul–Sep, 25 in the last 7 days, 4 today.
  This asymmetry is the entire reason the Closed list is paged rather than
  fetched whole — don't "simplify" that away.
- **`TP_FILTER` excludes nothing from the closed set** — 387 of 387 over 90
  days. It is kept for consistency with the other views, and would start
  mattering silently if the Third Party Status values changed.
- Every issue that is `statusCategory = Done` has a resolution date (0
  exceptions), so `ORDER BY resolved DESC` never drops or mis-sorts one.

**The third-party filter** (`TP_FILTER` in the code) excludes tickets parked
with a third party in a state the TAC team can't act on:

```
("Third Party Status[Dropdown]" not in (Duplicate, "Fix Deployed", "Version Tagged", "Allocated to Dev")
 OR "Third Party Status[Dropdown]" is EMPTY)
```

## 3. Five traps — each fails silently

**1. Never write `"Resolution"` for the SLA field.** It collides with Jira's
built-in `resolution` field and the clause matches nothing. `"Resolution" =
running()` returned 0 while the SLA actually had 21 running cycles. Use
`cf[10969]`. The other five SLA names are safe as literals.

**2. `running()` includes already-breached SLAs.** A breached cycle is still
"running" and its remaining time is negative, so `< remaining("1h")` sweeps in
everything overdue. For "ticking but not yet overdue" you must add
`> remaining("0m")`. Omitting it returned 19 tickets where the correct answer
was 2.

**3. Priority sorts backwards from the Jira default.** This scheme puts P5 at
the low end, so `ORDER BY priority ASC` lists P5 first. Use `priority DESC` to
get P1 on top.

**4. A bare "HTTP 404" in the UI means the server is stale, not that Jira
said no.** `views/index.html` is re-read from disk on every request, so a
front-end change is live the instant you reload the page — but the routes it
calls only exist after the **server process** restarts. Add a route and try
it without restarting and Express answers with its own HTML 404, which
carries no JSON body for `apiFetch` to pull a message out of, so the error
box just reads "HTTP 404". This cost real time on 4 Sep 2026 when the ticket
timeline shipped. `httpError()` now maps a **404 with an empty body** to
`route_missing` and says "restart the server process"; a genuine Jira 404
(issue deleted or invisible to that account) arrives as JSON and still shows
Jira's own message. If you add a route, restart the server.

**5. Closing a dropdown must not re-render the controls block — it swallows
the click that closed it.** Both multi-select panels (Priority list TAC Tier,
Closed tab TAC Tier and SLA) close via a document-level click listener. Those
listeners used to call the full renderer, which replaces `innerHTML` for the
whole controls row — so when the click that closed the panel landed on
another control in that row, that control was destroyed and replaced while
the click was still being delivered to it, and the click was lost. A checkbox
shows it most clearly: its checkedness flips before dispatch, but `change`
fires in the activation behaviour that runs *after* the click finishes
propagating, by which point the element is detached and the handler never
reaches the app. The user sees the panel shut, the tickbox do nothing, and it
work on the second click. Found 4 Sep 2026 while testing the KPI tickbox,
which sits beside the SLA panel button and so is the likeliest control to be
clicked with a panel open. Both handlers now call
`collapseMultiSelectPanels(root)`, which removes the panel and un-presses its
button and touches nothing else. **If you add a control to either controls
row, do not reintroduce a full re-render on panel close.**

Also note: when querying through an MCP connector, **invalid JQL returns zero
rows instead of an error**. A 0 result is not evidence your syntax is right.
Validate against a query you know returns rows.

## 4. The Priority list spec

The ordering the business asked for. Every open ticket falls into the **first**
tier it matches (a waterfall), then each tier sorts by its own rule.

| # | Tier | Sort within tier |
|---|---|---|
| 1 | P1 and P2, excluding parked statuses | P1 above P2, then oldest created first |
| 2 | **Currently** in breach (see below) | Longest in breach first (earliest *ongoing* breach timestamp) |
| 3 | Going overdue within 1 hour, not paused | Soonest breach first |
| 4 | Status New ("to triage") | Soonest breach first |
| 5 | Status Requester Responded ("to respond") | Soonest breach first |
| 6 | Going overdue today, not paused | Soonest breach first |
| 7 | P3 with no update in 24h+, excluding parked statuses | Soonest breach first |
| 8 | P4 with no update in 72h+, excluding parked statuses | Soonest breach first |
| 9 | P5 with no update in 7d+, excluding parked statuses | Soonest breach first |
| 10 | In Progress | Soonest breach first |
| 11 | Everything else | Soonest breach first |

Implemented in `buildPriorityList()`. It works on a copy of the array and
removes each matched ticket from the pool, which is what makes the waterfall
exclusive. **If you add a tier, keep that take-and-remove pattern** or tickets
will appear twice.

**"Parked" is `PARKED_STATUSES`** — `Pending Response` and, since 4 Sep
2026, `Scheduled With Partner`. Both mean the next action belongs to someone
outside the TAC team, so the ticket must not be surfaced as an urgent P1/P2
or flagged as having gone stale. A parked ticket is not dropped from the
list; it falls through to a later tier (in practice tier 11). This is a
different mechanism from the Awaiting Internal/External Party statuses,
which are handled by the hide-toggle and by tier order instead.

Three definitions worth knowing:

- **"In breach" means in breach *right now*.** A ticket qualifies for tier 2
  when at least one SLA cycle is still **open** and already past its target. A
  cycle that breached and has since **completed** is history — somebody
  responded, the clock stopped — and must not keep the ticket flagged. This is
  checked *before* "ticking" in `resolveSla()`, and the order matters: a ticket
  routinely has one clock blown and another healthy, and the blown one is the
  fact that counts.

  Corrected on 28 Aug 2026. The previous version reported `breached` only when
  *no* clock was still running, so a single healthy SLA — usually **Time with
  Agent**, whose 100h goal stays green long after First Response or Resolution
  have gone — hid live breaches on **15 of 56** open tickets.

  A **paused** cycle never counts as breaching, even one already past target:
  paused means the requirement is not currently outstanding — the clock is
  stopped pending the other party, so there is nothing to chase right now.
  Corrected again same day: an intermediate version *did* count
  paused-and-past-target as breached, on the reasoning that pausing doesn't
  un-miss a target. The business call was the opposite — chased-and-waiting is
  not the same as chased-and-ignored — so that intermediate version is wrong,
  not just superseded. A ticket whose only past-target clock is paused instead
  falls through to whatever *other* SLA is still genuinely ticking, or to
  `paused` if none is. Measured against the live queue: 26 tickets had a
  breached-or-paused clock; **19** have a genuinely live breach.

  **That 19 is not what tier 2 shows on screen by default.** Checked
  4 Sep 2026, after the Hide-Awaiting-Internal-Team feature below existed:
  **13 of those 19** currently-breached tickets carry status Awaiting Internal
  Team, which is hidden from the Priority list by default. So the tier 2 count
  a fresh page load actually shows is **6**, not 19 — the 19 only appears with
  "Show Awaiting Internal Team" ticked. Filtering happens before tiering (see
  the Hide-Awaiting-Internal-Team entry below), so this isn't a bug, but it is
  exactly the kind of number that looks wrong to whoever reads this file next
  if they only find the 19. If you change either feature, recheck this
  intersection — it isn't obvious that most of the queue's live breaches are
  sitting in the status this dashboard hides by default.
- "Soonest breach" uses `resolveSla()`, which picks the **minimum remaining
  time across all six SLA fields**, counting only cycles that are ongoing and
  not paused. Tickets with no ticking SLA sort to the bottom of their tier
  rather than the top.
- "Going overdue today" is evaluated against the **Europe/London** calendar
  date, matching the timezone convention used throughout the file.

**Linked-tickets drill (added 28 Aug 2026).** A ticket with status
**Awaiting Internal Team** gets a small link-icon button next to its status
badge in the Priority list, showing a count and expanding to the tickets it's
linked to — key, relationship ("causes" / "is caused by" / whatever the link
type's inward/outward label is), summary, status, priority. Linked issues can
be in other projects (ESD, DEVX, ...); the browse link still works because
`JIRA_BASE` isn't project-scoped.

No extra Jira call: Jira's `issuelinks` field always returns a fixed stub
(summary, status, priority, issuetype) for each linked issue regardless of
what's requested elsewhere, so adding `'issuelinks'` to `LIVE_FIELDS` was
enough — it rides along on the one existing live-queue fetch. The button
appears for every Awaiting Internal Team ticket, including ones with zero
links (shows "No linked tickets" rather than hiding the control), since a
ticket parked on a dependency that isn't actually linked is itself worth
surfacing. Implemented in `priorityRow()` / `linkDrillRow()` / `toggleLinkDrill()`;
expansion state is a plain `Set` re-read on each `renderPriorityTable()` call,
the same pattern `activeSubDrill` already uses elsewhere.

**"Ready to close" flag (added 28 Aug 2026).** When every linked ticket on an
Awaiting Internal Team ticket is closed/resolved, a green chip appears next to
the status badge — the signal that whatever this ticket was blocked on has
landed, so it's worth a human re-checking whether the TAC ticket itself can now
be resolved. The matching linked row in the drill gets the same green
treatment, so the two views agree.

"Closed or resolved" is checked via `fields.status.statusCategory.key ===
'done'`, not the status name. Linked issues can be in any project (ESD, DEVX,
TAC, ...) with its own workflow and its own words for "finished" — Closed,
Resolved, Done, Won't Fix — and `statusCategory` is Jira's own project-independent
answer to "is this issue finished", present on every issue stub. Matching on
status name instead would silently miss every non-TAC project's spelling of
done. A ticket with zero links is never "ready" — there's nothing to confirm
against. Implemented in `isLinkDone()` / `allLinksResolved()`.

**Hide Awaiting Internal Team by default (added 28 Aug 2026).** A "Show
Awaiting Internal Team" tickbox sits in the Priority list controls, unchecked
on every fresh load — those tickets are blocked on someone else's work rather
than the TAC team's next action, so by default they're filtered out of the
triage view entirely rather than just sorted low. The summary line and the
empty state both say how many are hidden, so an empty or short list still
explains itself rather than looking broken. State lives in `showAwaitingInternal`,
a plain module-level flag deliberately **not** persisted to `localStorage` —
persisting it would contradict "unticked by default" on the next visit.
Filtering happens in `renderPriorityTable()`, after the assignee filter and
before `buildPriorityList()`, so hidden tickets never enter tiering at all.

**TAC Tier multi-select (added 28 Aug 2026).** A dropdown next to the
assignee picker filters the Priority list by `customfield_10874` ("TAC Tier"),
options 1.5 / 2.0 / 2.5, all three checked by default. It's a genuine
multi-select — any combination, including all three or none — built as a
custom button-plus-checkbox-panel rather than a native `<select multiple>`,
since a multi-select native control needs ctrl/cmd-click to use and gives no
visible summary of what's picked. State is `selectedTacTiers`, a `Set` of the
values to *include*; "all three selected" is treated as unfiltered rather than
exact membership, so a ticket with a tier value this build doesn't know about
(there are none today, but nothing guarantees that stays true) shows by
default instead of silently vanishing. Deselecting anything switches to exact
membership, so unchecking all three correctly shows zero tickets rather than
falling back to "show everything" — the empty state says so explicitly instead
of looking broken.

Checking or unchecking an option calls `renderPriorityList()`, not just
`renderPriorityTable()`, because the toggle button's own label text has to
update too. A single `document` click listener (`closeTacTierPanelOnOutsideClick`,
registered once at boot) closes the panel on any click outside it; clicks
inside the panel call `stopPropagation()` so checking a box doesn't
immediately trigger that same listener and close itself.

**Assignee/TAC Tier dropdown styling unified (added 4 Sep 2026).** The two
controls shared every CSS rule (border, radius, padding, hover colour) yet
still looked like different kinds of control, because the Assignee `<select>`
rendered the browser's own native arrow while the TAC Tier button uses our
`chevron-down` SVG — a native `<select>`'s arrow can't be restyled by CSS
alone. Fixed by wrapping the select in `.pc-select-wrap`, setting
`appearance:none` to suppress the native arrow, and overlaying the same
`chevron-down` icon (`pointer-events:none`, positioned absolute) that the
TAC Tier button already uses; `.pc-select-wrap:hover .ico` recolours it on
hover the same way the button's icon inherits `currentColor` from its own
hover state. Verified visually (default + hover, side by side) using a
standalone harness built from the page's own extracted CSS and icon code,
screenshotted in a browser — **not** inside a live signed-in session, since no
Jira session was available this run. Low risk (pure CSS/markup, no logic
touched) but worth one glance in the real app before treating it as settled.

## 5. The Closed list

Added 4 Sep 2026. Every closed/resolved ticket in a chosen window, ordered by
close date, newest first. The **only** view with its own Jira query, its own
cache and its own pager — because closed tickets are by definition absent from
`RAW_ISSUES` (which is scoped to `resolution = Unresolved`).

**Date ranges use Jira's own date functions, never hand-built literals.** A JQL
date literal is interpreted in the *viewer's Jira profile timezone*, so
computing "1 July" in the browser drifts by the offset between the two.
`startOfDay()` / `startOfWeek()` / `startOfMonth()` sidestep that, and match
the convention `getJqlWeekFilter()` already set.

Jira has **no `startOfQuarter()`**. Quarters are therefore built from
`startOfMonth()` offsets: a quarter always starts on a month boundary, so the
current one is `startOfMonth(-(month % 3))`. In Sep 2026 that is
`startOfMonth(-2)` (→ 1 Jul) and last quarter is `startOfMonth(-5)` to
`startOfMonth(-2)` (→ Apr–Jun). Verified against the live instance.

Note that **Australian-FY quarters and calendar quarters coincide here** — both
break on Jan/Apr/Jul/Oct — so the ranges are identical either way and only the
naming would differ. That's why no fiscal-year question needed answering.

All the "Last N days" options **include today**: N days total is today plus the
N-1 before, i.e. `startOfDay(-(N-1))`. `Last 7 days` is `startOfDay(-6)`.

**Breach means *ever* breached here, and that is a different rule from the
Priority list.** `resolveSla()` answers "is this breaching right now", which
every closed ticket answers `completed` to — its clocks have stopped. So
`closedSlaState()` reads `completedCycles` as well, like the Historical tab's
`getSlaHistStatus()`. Breached rows get a red tint (`.row-breach`, which must
repeat itself on `:hover` or `.tbl tbody tr:hover td` wins and flips the row
grey under the pointer).

**Which SLAs count is a user choice, and it changes the answer a lot.** An
"SLA" multi-select lists all six clocks, all checked by default. On the 47
tickets closed in the 14 days to 4 Sep 2026: all six → **26** breached, the
three headline SLAs (First Response / Restoration / Resolution) → **19**. So
the default view paints over half the list red, and the Historical tab's
"SLA met %" — which only ever counts those three — will legitimately disagree
with it. That is the chosen behaviour, not a bug. Deselecting SLAs scopes the
breach test only; it never drops rows, because a ticket that missed nothing you
selected still belongs in a list of what closed.

**Paging is forward-only and cumulative.** A Jira `nextPageToken` cannot be
walked backwards or jumped, so there are no numbered pages — "Load more" plus
"Load all remaining". `fetchClosedPage()` walks tokens until it has **at least**
`CLOSED_PAGE_SIZE` (100) rows, because a single Jira call returns far fewer when
13 fields are requested. "At least": the total is tested *after* each append and
a Jira page can't be resumed halfway, so a pager page overshoots by up to one
Jira page. That is why the button says "Load more" rather than naming a number.

**The filters see only what is loaded.** The assignee list, its counts, and the
TAC Tier filter all work over the loaded rows, matching the dashboard's
"one fetch, filter in the browser" model rather than inventing a second,
server-side filtering path. The pager line says so explicitly. In normal use
this is moot — every range except the migration quarter is a single page.

**Caching is per range, with two deliberate ceilings.** Ranges that include
today get a 2-minute TTL (`CLOSED_TTL_LIVE`); ranges wholly in the past get 30
minutes (`CLOSED_TTL_PAST`), since only a resolution-date edit could change
them. At most `CLOSED_CACHE_MAX` (4) ranges are retained, LRU-evicted — Last
Quarter alone can hold thousands of issues with their SLA payloads. Nothing is
persisted to `localStorage`: a stale closed list read off disk on the next
visit would be worse than a slow fresh one. `Refresh` drops the current range's
entry and re-queries.

**The KPI summary strip (added 4 Sep 2026).** A "Show summary" tickbox in the
Closed tab's controls reveals six read-only tiles above the table: **Total
closed**, **SLA Total**, then attainment for `SLA Triage`,
`SLA First Response`, `SLA Response` and `SLA Resolution`
(`CLOSED_KPI_SLAS`). Off by default and not persisted, matching the tab's
other toggles.

Every tile summarises **exactly the rows the filters are showing** — the same
`shown` array the table renders — so personal mode, the assignee picker and
the TAC Tier filter all feed into them.

**Only `SLA Total` follows the SLA multi-select; the four named tiles do
not.** That split is deliberate and is the thing most likely to be mistaken for
a bug. The four report specific SLAs by name, so letting the picker blank one
out would make a named tile lie. `SLA Total` reports the proportion of tickets that
came out clean across whatever is selected, which is what makes it useful next
to them — and its sub-line names the SLA count ("3 of 10 met all · 6 SLAs")
precisely so it is visible that this one moves with the picker.

**`SLA Total` is counted per TICKET, not per measurement.** A ticket that
misses **any** selected SLA is a breached ticket, however many of its other
clocks were met. Ten tickets with one bad ticket is 90%. The breach test is
`closedSlaState()` — the same call that decides whether a row is tinted red —
so the figure is exactly 100% minus the proportion of red rows, and a headline
number can never disagree with the rows under it.

The denominator is **every ticket shown**, not just those carrying SLA data: a
ticket with no SLA at all breaches nothing and so counts as clean. No such
ticket exists in TAC today (all 47 closed in the fortnight to 4 Sep 2026 carry
all six clocks), but the sub-line reports the count if any appear, because
silently counting them as successes would flatter the number.

Expect it to be **lower than every component tile** — requiring a ticket to
meet all selected SLAs is strictly harder than meeting any one of them, so it
sits at or below the lowest of them. On that sample: 21 of 47 = **45%** with
all six selected, against components of 72–85%. Dropping SLAs from the picker
can only raise it (fewer ways to fail): the four named tiles alone give 47%,
and a single selected SLA makes it equal that SLA's own tile. Nothing selected
shows an em dash, never a bogus 100% — `closedSlaState()` finds no breaches
against an empty selection, hence the explicit guard before it is called.

**Superseded, and wrong — do not reinstate it.** This first shipped
aggregating ticket-SLA *pairs*: the per-SLA numerators and denominators summed,
giving 224 of 282 = 79% on the same data, which sat neatly between the
component tiles. That answers "what proportion of all SLA measurements were
met", which is a different question, and the business's rule is the
per-ticket one above. The 79% version was rejected on 4 Sep 2026, not merely
replaced.

Three things about the numbers:

- **The denominator is per-SLA**, not the ticket count. A ticket carrying no
  cycle for an SLA has neither met nor missed it, so it is excluded and the
  tile prints "N of M met" plus a "· K no data" note. All four happened to be
  present on all 47 tickets closed in the fortnight to 4 Sep 2026, but
  Restoration was absent on 8 of 13 in an earlier sample, so uneven
  denominators are real.
- **"Met" is ticket-level**: any breached cycle counts the whole ticket as
  missed, which is how the Historical tab's SLA figure already works. It only
  matters for Response Target, the one SLA that runs repeatedly (15 of 47
  tickets had more than one cycle) — and measured per-cycle that sample gave
  72% as well, the same answer.
- **When the pager has rows left to fetch, every tile describes the loaded
  slice**, not the whole range. The Total closed tile says so
  ("current day · 100 of 5,225 loaded") rather than leaving it to the pager
  line further down.

`slaPctColour()` (>=90 green, >=70 amber, else red) is shared with the
Historical tab's "SLA met" tile so the thresholds cannot drift apart. Live
figures sit in the amber band: Triage 79%, First Response 77%, Response 72%,
Resolution 81%.

**"% Solved by First Agent" was asked for and then withdrawn**, and is
deliberately absent. Worth recording why, since it will come up again: every
answer available from list data is a proxy, and they disagree. `1.5 TAC Owner`
differs from `assignee` on **25 of 47** closed tickets, so the assignee field
cannot answer it. "Never escalated past 1.5" (only the 1.5 owner set, 2.0 and
2.5 empty) gives 74%; "TAC Tier field is 1.5" gives 70%, and the two disagree
on 2 tickets where the tier says 2.5 but only the 1.5 owner was ever filled in.
A genuine "one person touched it" measure lives only in the changelog, i.e. one
request per ticket — 100+ requests to fill the strip for a single page.

**The Closed list is not wired into the 5-minute auto-refresh**, which still
only calls `loadLive()`. Its TTL covers staleness instead.

**Linked work items** reuse `linkDrillRow()`, which now takes a column count so
the two tables can't silently disagree on colspan. Unlike the Priority list the
button is shown only when `issuelinks` is non-empty: there, an Awaiting
Internal Team ticket with zero links is itself the signal, so it shows a "0";
here a closed ticket with no linked work is unremarkable and a column of "0"
buttons would be noise. There is no "Ready to close" chip — meaningless on a
ticket that is already closed.

**`/api/count`** (new server route) exists only for the pager label:
`/rest/api/3/search/jql` returns no total, only a token. It proxies Jira's
`search/approximate-count` and is treated as non-fatal — on failure the pager
says "the rest" instead of a number and everything else still works.

## 6. The ticket timeline

Added 4 Sep 2026. Clicking a ticket row anywhere opens a modal with that
ticket's history: the current facts, time spent in each status, every SLA cycle,
and a dated event list of what changed, who changed it and when.

**It needs the Jira changelog, which no list query can give you.** Not as a
field, not via any expand on `/search/jql`. Hence `/api/issue/:key`
(`expand=changelog`) plus `/api/issue/:key/changelog?startAt=N` for the
overflow: the inline expand caps at 100 entries but reports the true figure in
`changelog.total`, so `fetchIssueDetail()` walks the rest. Nothing seen so far
comes close to 100 (TAC-5400, the busiest, has 39) — but a silent truncation
would look exactly like "nothing else happened", which is the failure mode this
file keeps warning about.

**Rows are clickable via one delegated listener**, not an `onclick` per row.
Every ticket table gets the behaviour from a `data-ticket` attribute alone, and
`onTicketRowClick()` ignores clicks landing on an `a`, `button`, `input`,
`label` or `select` — which is what keeps the key's Jira link and the
linked-tickets toggle working. Nine renderers carry the attribute; the
**wallboard deliberately does not**, being a TV display with its own
full-screen overlay that a second one would fight with.

**"Owner" means the three TAC Owner fields, not `assignee`** — see section 2.
Both are treated as ownership changes and coloured apart from ordinary edits.
On TAC-5400 the hand-offs found were `2.5 TAC Owner`, `1.5 TAC Owner` and
`assignee`, in that order.

**Most history is written by robots.** On TAC-5400, 23 of 39 entries came from
"Automation for Jira" or "Atlassian Assist". Jira reports that as
`author.accountType === 'app'`, so those entries get an "auto" marker rather
than reading as a person's action.

**The default view is curated; the tickbox reveals the rest.** `status`,
`assignee`, `priority`, `resolution`, TAC Tier and the three owner fields are
shown; Sentiment, Impact, Severity, Classification, Request participants,
attachments, Scheduled Date and the form fields are not. The tickbox counts
hidden **changes**, not hidden events — toggling both adds whole events and
adds lines to events already on screen, and counting events alone undercounts
it badly (TAC-6225 reads "+6 more"; counting events said "+1").

**SLA starts and stops are not timeline events.** Every clock starts within a
second of the ticket being created, so six near-identical "started" entries
would bury everything worth reading. The full cycle detail goes in its own
table (`slaCycleRows`), which answers "which clocks ran and when" better
anyway. **Breaches do** appear in the timeline — seeing a miss land between two
status changes is the point. An ongoing cycle's `breachTime` is a *deadline*,
not history, so a future one is never rendered as an event.

**Time in status is derived, and its window ends at the last activity.** Jira
does not record the opening status as a change, so the first status is only
recoverable from the earliest transition's `fromString`. The window runs
creation → last changelog entry for a finished ticket, and creation → now for a
live one. The consequence worth knowing before calling it a bug: **a resolved
ticket's closing status contributes no time and so does not appear in the bar**
— the window closes at the very transition into it. That is intended; the
section measures working life, not shelf life, and the header badge and facts
grid are what report the current status. Ending the window at `resolutiondate`
instead would silently drop everything that happened afterwards, which is
exactly the case for the seven reopened tickets in section 2. Repeat visits to
a status collapse into one row with a count (TAC-5400: Requester Responded ×15).

**Cache:** per ticket, 3-minute TTL, 10 tickets max, LRU — a timeline gets
reopened constantly while working a queue, and it is two round trips for a busy
ticket. Same reasoning as the Closed list's cache, and likewise not persisted.

**No comments.** Asked and declined for this pass: they are a separate fetch and
their bodies are ADF rich text that would have to be flattened to plain text.
The ticket key links to Jira, where they live.

## 7. Decisions and rationale

**OAuth per viewer, not a service account.** Each user signs in with their own
Atlassian account and queries run as them, so Jira's permission scheme is the
access control and there's no shared token to leak. This also makes Personal
mode a real boundary rather than a cosmetic filter.

**Personal mode matches on `account_id`, not email.** Account IDs survive
display-name changes and aren't affected by the Atlassian privacy setting that
hides `emailAddress` from the API — email matching fails silently for users who
have it enabled. Email and display name remain as fallbacks. Verified: 11 of 56
open tickets matched, all on the accountId path.

**Personal mode re-runs the tiering on the filtered set**, so a person's list is
their own queue numbered from 1, rather than global ranks with gaps.

**One fetch, filter in the browser.** All views derive from a single paginated
pull of open tickets (`RAW_ISSUES`). Personal mode and the assignee picker are
array filters over it — no extra Jira calls. `RAW_ISSUES` is the raw fetch and
`ALL_ISSUES` is the filtered view; `recomputeViews()` derives the second from
the first. Keep that split: renderers read the view arrays.

**Pagination is mandatory.** An earlier version fetched `maxResults: 100` with
no pagination, silently losing tickets past the 100th. `jiraSearch()` follows
`nextPageToken`.

**Page on the token, not on `isLast`.** Fixed 28 Aug 2026. `jiraNextCursor()`
used to require `isLast === false && nextPageToken`, but in the published
schema for `/rest/api/3/search/jql` (`SearchAndReconcileResults`) **no field is
required** — `isLast` can simply be absent, and the documented end-of-results
signal is `nextPageToken` coming back null. When Jira omitted the flag, paging
stopped after page one and the queue was silently truncated. Only ever treat
`isLast === true` as an explicit stop. Also note pages routinely come back far
short of `maxResults`: Jira shrinks them when many fields are requested, and
`LIVE_FIELDS` asks for 13 — so "I got fewer than I asked for" is *not* evidence
that you have reached the end.

**The wallboard shows a badge when Personal mode is on**, because a shared TV
quietly displaying one person's numbers as the team's would be actively
misleading.

## 8. Tested vs untested

Verified: server boots; refuses to start on missing/short config; both API
routes return 401 when signed out; mismatched OAuth `state` is rejected; the
dashboard shell is never served to anonymous visitors; the project guard allows
real queries and blocks other projects including the near-miss `TACPC`; the
tier logic partitions live data with no overlaps or gaps (56 in, 56 out); the
Personal-mode match returns the right 11 tickets.

**The OAuth round-trip now works** (28 Aug 2026), but only with
`--use-system-ca`. The Access4 network re-signs TLS, and Node ignores the
Windows certificate store, so the server's back-channel token exchange failed
with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` while the browser leg worked perfectly.
Both `npm` scripts pass the flag; see **TLS on the corporate network** in
`README.md`, including why containers need more than the flag. The failure
surfaced as a bare `fetch failed` until `causeChain()` was added in
`server.js` — `fetch()` hides every network and TLS fault in `err.cause`.

Also verified 28 Aug 2026 against the live queue (56 open tickets): pagination
pages on `nextPageToken`; the tier waterfall still partitions cleanly (56 in,
56 out, no duplicates); and the 10 tickets whose only breaches are historic are
correctly excluded. (Tier 2's count was checked twice that day, before and
after the paused-cycle correction in section 4 — see there for the current
number; don't treat 26 as current if you see it quoted elsewhere in old notes.)

Confirmed in a running signed-in session on the same date: the dashboard
reports all **56** open tickets (a truncating pager would stop at 50, since
Jira's default page is 50 and shrinks further with 13 fields requested), and
ticket keys link to `access4.atlassian.net/browse/…` — i.e. `JIRA_BASE` really
does resolve from `/api/me`'s `siteUrl` rather than falling back. That session
ran before the paused-cycle correction, so the breach tier it showed was the
pre-correction 26, not the current 19 — worth another glance in the running
app, though the tier-2 filter logic itself was re-verified against the same
snapshot afterward (see section 4).

**Session of 4 Sep 2026 — five features added, none yet seen in a live signed-in
session.** No Jira OAuth session was available this run, so every fact below
was established one of two ways: (a) pulling real data straight from Jira via
the Atlassian MCP connector and feeding it through the actual functions
extracted from `views/index.html` into a throwaway Node harness, or (b) for
the one pure-CSS change, a standalone static harness built from the page's own
extracted styles and icon code, screenshotted in a browser. Neither is a
substitute for opening the real dashboard signed in. What shipped:

- The paused-cycle SLA correction above (26 → 19 currently-breached), plus the
  **6 vs 19** interaction with the hide-toggle documented there — this is the
  single highest-value thing to eyeball first, since it changes what the
  Priority list's headline breach count looks like by default.
- The linked-tickets drill and "Ready to close" flag on Awaiting Internal Team
  tickets (section 4) — verified against real tickets with 0, 1, and 5 links,
  mixed and all-done link states, and one cross-project link (`ESD-409`). Never
  clicked in an actual browser.
- The Hide-Awaiting-Internal-Team tickbox — verified 43/56 and 6/13 splits
  against real snapshots. Never toggled in an actual browser.
- The TAC Tier multi-select — verified exact filter counts (46, 35, 0) against
  81 real open tickets, all three current values confirmed, no nulls found.
  Never opened in an actual browser.
- The Assignee/TAC Tier dropdown visual-parity fix, immediately above.

None of the five interact with each other in ways not already called out
individually, **except** the tier-2/hide-toggle interaction, which does. First
thing to do with real credentials: load the Priority list, confirm the default
view, then tick "Show Awaiting Internal Team" and confirm the breach count
jumps from 6 to 19 — that single check exercises most of what changed today.

**Session of 4 Sep 2026 (second change) — the Closed list.** Again no Jira
OAuth session, so the same two techniques as the rest of that day: real data
pulled through the Atlassian MCP connector and fed into the actual functions
extracted from `views/index.html`, plus a static browser harness built from the
real page.

Verified:

- **All 13 date ranges were run as JQL against the live instance** and return
  plausible, mutually consistent counts. This mattered more than usual: through
  a connector, invalid JQL returns zero rows rather than an error, so
  `startOfMonth(-2)` being wrong would have looked like "no tickets closed".
  Counts: today 4, yesterday 4, last 7d 25, last 90d 382, current quarter 226,
  last quarter 5,225. `last90 ⊇ currentQuarter` and `last7 ⊇ currentDay` both
  hold.
- **The Done-vs-resolution-date choice is arithmetically confirmed.** The
  resolution-date query returns 387 over 90 days against 382 for
  `statusCategory = Done` — exactly the 5 reopened tickets from section 2 that
  fall inside 90 days — and 5,227 vs 5,225 for Apr–Jun, exactly the other 2.
- **80 assertions across two Node suites** over 47 real closed tickets: row
  rendering, the red tint agreeing with the SLA cell, ordering, the link drill
  (including cross-project `ESD-411` / `DEVX-2288` browse links), the tier and
  assignee filters against live counts, cache TTL split and LRU eviction, and
  the pager — including a fake Jira that returns 10-row pages, one that omits
  `isLast` entirely, and a failing `/api/count`.
- **Driven in a real browser** via the static harness: the SLA picker's panel
  stays open across toggles, its button label tracks (All 6 → 3 of 6 → None),
  and the red row count moves with it (7 → 6 → 3 → 0) in step with the summary
  line. Both "None" empty states and the no-pager state render as intended, and
  a failed fetch shows one error box with the controls still usable.

**Untested, and the thing to check first with real credentials:
`POST /api/count`.** It proxies `/rest/api/3/search/approximate-count`, which
this session had no way to reach — the MCP connector exposes no generic HTTP
call, and `/api/search` runs under a session that did not exist. The route is
written to fail soft (the pager degrades to "the rest" and the list still
works), so a wrong endpoint costs the "of 5,225" label and nothing else. If the
label is missing, that call is why.

Also unverified in the real app: whether the 13-field `CLOSED_FIELDS` request
makes Jira shrink pages far enough to make "Load more" feel slow on the
migration quarter. The pager logic handles short pages, but the wall-clock cost
per click is a guess.

**Session of 4 Sep 2026 (third change) — the ticket timeline.** Still no Jira
OAuth session, so again: real data through the Atlassian MCP connector fed into
the shipped functions, plus a static browser harness built from the real page.

Verified:

- **The new server routes were booted and probed for real.** `server.js` was
  started on a spare port and every `/api/issue` path hit while signed out:
  `TAC-6225`, its `/changelog`, `?startAt=100`, plus `ESD-411`, `DEVX-2288` and
  `TACPC-1` — all 401, i.e. the routes fail closed, and the key guard sits
  behind `requireAuth` rather than in front of it. Path traversal
  (`/api/issue/../../etc/passwd`) 404s in Express before reaching the handler.
- **The key guard regex was lifted out of `server.js` and tested directly** —
  16 cases, including the `TACPC` near-miss, `TAC-6225x`, an 11-digit key, a
  newline-injected key and `TAC-6225 OR 1=1`. All correct. (Tested by
  extracting the real line, not retyping it: a retyped copy through a shell
  produced a false failure first time round.)
- **64 assertions** over the real changelogs of TAC-6225 (10 entries, resolved,
  all six clocks, five breached) and TAC-5400 (39 entries, 27 status changes,
  reopened after resolution, 23 automation entries): event filtering both ways,
  ownership detection across `assignee` and all three owner fields, bot
  attribution, ordering, breach events (including that a *future* `breachTime`
  is not one), the SLA cycle table, time-in-status arithmetic, escaping,
  cache TTL and LRU, and the row-click guard.
- **Changelog paging was tested against a fake Jira** returning 250 entries:
  it walks past the inlined 100 with exactly two overflow calls, makes only one
  call for a 10-entry history, and gives up rather than spinning when Jira
  returns an empty overflow page.
- **Driven in a real browser** via the harness: a genuine click on a row opens
  the timeline and locks body scroll; Escape, the close button, and a scrim
  click all close it and restore scroll, while a click starting inside the
  modal does not; the "Show all changes" tickbox took the view from 15 events /
  10 changes to 16 / 16 and back, matching its own "+6 more" label exactly.
  Rendering was eyeballed at 1000×1250 with no console errors.

**Untested, and still the first thing to check with real credentials:
`POST /api/count`** (see the previous entry) and now also **whether
`/api/issue/:key` returns what the timeline expects from the REST proxy**. The
shape it parses was confirmed against the MCP connector's `getJiraIssue`, which
returns the same Jira REST payload — but the app's own proxy path has never run
it. If the timeline comes up empty with the facts grid populated, suspect
`changelog` not being expanded through the proxy.

Also unverified: a ticket with more than 100 changelog entries. None exists in
TAC today (the busiest has 39), so the overflow walk has only ever run against
the fake Jira above.

**"Scheduled With Partner" brought to parity with "Pending Response"**
(4 Sep 2026, at the business's direction). Colour maps, `STATUS_ORDER` and
`PARKED_STATUSES` all updated. 22 assertions against the **whole live open
queue** (52 tickets): the parked set holds exactly those two statuses; the
new colour is distinct from both Pending Response's navy and the grey
fallback; and re-labelling a real ticket to `Scheduled With Partner` moves
it out of tiers 7, 8 and 9 into exactly the tier a `Pending Response`
relabel of the same ticket lands in. The waterfall still partitions cleanly
(52 in, 52 out, no duplicates) both before and after relabelling five
tickets. Confirmed visually that the new slate reads apart from Pending
Response's navy where the two sit adjacent in a time-in-status bar.

**Two caveats on that.** Tier 1 could not be exercised against real data —
there is currently no open P1 or P2 ticket at all (the open queue is 9 × P3,
6 × P4, 37 × P5), so that row of the test skipped. The predicate is shared
across all four excluded tiers and three of them are verified. And since no
ticket is ever *sitting* in Scheduled With Partner for long, everything
above rests on relabelled real tickets rather than a genuine one.

**The Closed tab's KPI strip** (4 Sep 2026). 41 assertions over the same 47
real closed tickets, plus a **second, independent Jira fetch** of the four
KPI SLA fields alone — both agree on Triage 79%, First Response 77%,
Response 72%, Resolution 81%, so the arithmetic is not keyed to one payload.
Also covered: per-SLA denominators, empty and no-SLA-data inputs (null
percentage renders as an em dash, never 0% or NaN), a null total from a
failed `/api/count`, every threshold boundary of `slaPctColour`, and that
narrowing by tier or assignee **recomputes** the percentages rather than
reusing the unfiltered ones (tier 1.5 gives 77% of 35 where the full set
gives 79% of 47).

`SLA Total` adds 23 of those assertions, and the headline rule is pinned by
construction rather than inferred from live data: **ten synthetic tickets, one
of them breaching one of its six SLAs while meeting the other five, must read
90%** — plus the variants that it does not matter which SLA was missed, that a
ticket breaching all six still counts once, and the 100%/0% extremes. Against
the real 47 it gives 45% (21 met all, 26 breached) and is asserted to equal
100% minus the proportion of red rows, to sit **at or below** its lowest
component, to rise when SLAs are dropped from the picker, to equal a single
SLA's own tile when only that one is selected, to return null rather than a
bogus 100% with nothing selected, and to disclose tickets carrying no SLA data
at all (which count as clean). Also that it follows the row filters as well as
the picker, and that the four named tiles stay put when the picker moves.

The first version of this tile aggregated ticket-SLA pairs (79%) and its tests
asserted that behaviour, including that it landed *between* the component
tiles. Those assertions were inverted rather than deleted when the business
corrected the definition, so the file now pins the per-ticket rule from both
directions.

Driven in a browser: the tickbox shows and hides the strip; the tiles follow
a real assignee `<select>` change (10 tickets → 3, and 70/80/70/70 →
100/100/0/100) and a real tier tickbox on top of it; and the empty result
still shows "Total closed 0" with em-dashes rather than a blank strip.
Unticking the six SLAs one at a time through the real panel walked `SLA Total`
through 6 → 5 → 4 → 3 SLAs to "no SLAs selected" and back, while the four
named tiles held at 70/80/70/70 throughout. After the per-ticket correction it
was re-checked in the browser against the rows themselves: 7 of 10 seeded rows
tinted red, tile reads **30%** with "3 of 10 met all · 6 SLAs", matching both
the red-row count and the summary line's "7 breached an SLA".

**The swallowed-click bug in trap 5 was found this way and is fixed and
verified in a browser on both tabs**: clicking the Closed tab's "Show
summary" tickbox with the SLA panel open now both toggles the strip and
closes the panel, and the same holds for the Priority list's "Show Awaiting
Internal Team" tickbox with its tier panel open (rows 20 → 23). The three
behaviours the listener exists for were re-checked: an outside click still
closes the panel and un-presses the button, ticking a box inside the panel
still filters (10 rows → 7) and leaves it open with its label updated, and
opening a second panel still replaces the first rather than stacking.

**Still untested:** everything on the Historical tab. Its two queries use
different field sets (`HIST_CREATED_FIELDS` / `HIST_RESOLVED_FIELDS`) and read
`customfield_10690` (CSAT) and `customfield_10700`, none of which the live-queue
path touches. Nothing has exercised those against the REST proxy.

## 9. Where things are

```
server.js           OAuth, /api/me, /api/search proxy, static serving
views/index.html    The whole dashboard, self-contained, no build step
public/login.html   Sign-in page
```

`views/index.html` is ~350 KB but most of that is **inlined vendor code**:
Chart.js 4.5.0 (~208 KB) and base64 Poppins woff2 fonts. The application logic
is the final `<script>` block, roughly 70 KB. **Read that block, not the whole
file** — and don't reformat the vendor sections.

Landmarks inside that script:

- Constants (`CLOUD`, `TP_FILTER`, SLA field lists, colours) — top of the block
- `callSearchTool` / `callMcpTool` — the only functions that talk to the server
- `resolveSla()` — turns six SLA fields into one state: ticking / paused / completed / breached
- `closedSlaState()` — the Closed list's *different* rule: ever-breached, over
  the user-selected subset of the six clocks (section 5)
- `buildTicketTimeline()` / `timeInStatus()` — the ticket history modal's two
  derived views (section 6)
- `fetchIssueDetail()` — the only per-issue read; walks the changelog
- `onTicketRowClick()` — the one delegated listener behind every clickable row
- `buildPriorityList()` — the 11 tiers
- `CLOSED_RANGES` / `closedJql()` — the 13 date windows and their JQL
- `fetchClosedPage()` / `loadMoreClosed()` / `closedCache` — the Closed list's
  pager and per-range cache
- `render()` — live tab; `renderPriorityList()` / `renderPriorityTable()`;
  `renderClosed()` / `renderClosedTable()`; `renderTicketDetail()`;
  `renderHistorical()`; `renderWallboard()`
- Personal mode block — identity lookup, `matchesViewer()`, `recomputeViews()`

Chart.js is pinned and hash-verified against the original CDN copy. If you
replace it, verify the integrity hash rather than trusting a download.

## 10. Likely next tasks

- **Change a tier rule** → `buildPriorityList()`, keep the take-and-remove pattern
- **Add a field to the table** → `PRIORITY_THEAD` and `priorityRow()`; add the
  field ID to `LIVE_FIELDS` or it won't be fetched
- **Add a KPI to the Closed summary** → `CLOSED_KPI_SLAS` for another named
  SLA; `closedSlaTotal()` for the aggregate; anything else needs a tile pushed
  in `closedKpiHtml()`
- **Revisit "% Solved by First Agent"** → see section 5 for why the available
  proxies were rejected and what each one measures
- **Add a field to the ticket timeline** → `SIGNIFICANT_FIELD_IDS` decides
  what shows by default; add the field id to `DETAIL_FIELDS` in `server.js`
  only if the *current* value is needed, not just its history
- **Add comments to the timeline** → a third `/api/issue/:key/comment` proxy;
  bodies are ADF and need flattening (section 6 says why they were left out)
- **Make the timeline work for linked ESD/DEVX tickets** → the `ISSUE_KEY_RE`
  guard in `server.js` pins the project by key shape
- **Add a date range to the Closed list** → one entry in `CLOSED_RANGES`; set
  `live` to whether the window includes today, since that picks the cache TTL
- **Change what counts as an SLA breach on closed tickets** →
  `closedSlaState()`, not `resolveSla()` — see section 5 on why they differ
- **Show the 7 reopened tickets somewhere** → `loadLive()`'s
  `resolution = Unresolved` is what hides them (section 2)
- **Multiple projects** → `JIRA_PROJECT_KEY` guard in `server.js` is single-project;
  the front-end hardcodes `project = TAC` in its JQL
- **Survive restarts / run replicas** → swap the in-memory session store for
  `connect-redis`
- **Permanent wallboard screen** → sessions expire after 12h; a display mode
  with a long-lived token would be needed
