# TAC Support Queue — handover notes

Context for anyone (human or AI) picking this project up cold. Read this before
changing anything: several Jira behaviours here fail *silently* if you assume
the obvious thing.

`README.md` covers install, config and deployment. This file covers **why the
code is the way it is** and **the facts that were expensive to establish**.

---

## 1. What this is

A read-only dashboard over the Access4 TAC service desk queues. It began as a
Claude Cowork artifact, was ported to the Claude Artifacts platform, and was
then rebuilt as this standalone site so people without Claude accounts could
use it.

**Two desks, one at a time.** The picker in the top-left switches between the
UK queue (Jira project `TAC`) and the ANZ queue (`TAPC`) — added 8 Sep 2026,
see "The desk switcher" in section 8. Everything below applies to whichever
desk is selected; where the two differ, it says so.

Seven views. The Live queue, Priority list and Wallboard all read one shared
fetch of open tickets; **Closed, Historical and Vendor Bugs each run their own
query** (sections 5, 6 and the Historical notes). The Live queue has **one
extra query of its own** — the Reopened tile, whose tickets are by definition
absent from that shared fetch (section 5a). **SLA Breakdown adds no query at
all**: it is the Closed list's data, its cache and its arithmetic, presented
as a per-assignee matrix (section 5b).

| View | What it shows |
|---|---|
| Live queue | Summary tiles (including Reopened, section 5a), status/priority/type charts, assignee load, drill-downs |
| Priority list | All open tickets in an 11-tier triage order (section 4) |
| Closed | Closed/resolved tickets in a chosen date window, newest close first (section 5) |
| Vendor Bugs | Tickets the vendor has taken on, split into Version Tagged and Awaiting Dev (section 6) |
| Historical | Week-by-week created/resolved, SLA attainment, CSAT |
| SLA Breakdown | The Closed tab's SLA summary as a matrix, one row per assignee (section 5b) |
| Wallboard | Full-screen KPI view for a TV |

Clicking any ticket row in any of those lists opens a **history timeline**
for that ticket (section 7) — a modal, not a tab.

**Personal mode was removed on 17 Sep 2026** (section 8). Nothing filters a
view to the signed-in person any more: access is Jira's own permission scheme,
and the Priority list and Closed tab each keep an assignee picker for "just
mine".

The wallboard is the one view with no picker — the header is hidden there — so
a TV is switched by choosing the desk before going full-screen. Its title
names the desk it is showing.

## 2. Verified Jira facts

All confirmed against the live instance on 28 Aug 2026. Don't re-derive these.

**Site & projects**

- Cloud ID `5e94f2c7-6692-40a8-af5e-59a01701861e`, site `access4.atlassian.net`
- Project `TAC` = "Service Desk – UK TAC", id `10250`
- Project `TAPC` = "Service Desk – ANZ TAC", id `10296`
- Both company-managed (classic) Jira **Service Management** projects, both in
  the "Access4 Service Management" category

**The ANZ desk's key is `TAPC`, not `ANZTAC` or `TACANZ`** — established
8 Sep 2026 from `project/search`, and worth writing down because it is not
guessable from the project name. Note it is one letter away from the `TACPC`
near-miss the key guard has always been tested against, and `TAC` is *not* a
prefix of it, so no guard needed loosening to admit it.

**The two desks are shaped identically** (measured 8 Sep 2026 over the first
100 open ANZ tickets after `TP_FILTER`). This is why the switcher is only a
project key and not a per-desk configuration:

| | UK `TAC` | ANZ `TAPC` |
|---|---|---|
| Open after `TP_FILTER` | 42 | **395** |
| Statuses seen | the section's table | same names, no new ones |
| Priorities | same 5 IDs | same 5 IDs |
| TAC Tier values | 1.5 / 2.0 / 2.5 | same three, no nulls |
| All six SLA custom fields | present | present |
| Issue types | as UK | Incident / Question / Task |

Three consequences worth knowing:

- **ANZ is ~10x the UK queue**, so its live pull is several pages where the UK
  desk is usually one. Pagination and the paging trap in section 8 stop being
  theoretical on that desk.
- `Scheduled With Partner` **actually has tickets there** (8 of the first 100),
  where the UK desk has only ever shown it transiently. The parity work in
  section 4 is load-bearing on ANZ.
- **ANZ has a live P1**, so priority tier 1 — the one row that could never be
  exercised against real UK data (section 9) — now renders in practice.
- `Response Target` (`customfield_10906`) is sparse on ANZ: present on 3 of
  the first 100 open tickets. The Closed tab's per-SLA denominators already
  handle "no cycle for this SLA", but expect its tile to read over a much
  smaller base there.

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

**The four vendor fields** (confirmed 9 Sep 2026 from TAC's create-meta for
issue type Incident, and against 27 live tickets). These power the Vendor Bugs
tab in section 6:

| Field | Name | Type |
|---|---|---|
| `customfield_10908` | Third Party Status | single-select, 5 options |
| `customfield_10866` | Third Party Dev Reference | free text (`OMP-5945`) |
| `customfield_10867` | Tagged Version | free text (`v44.5`, `44.1.4`) |
| `customfield_10868` | Third Party Ticket URL | free text, **not** a URL field |

`Third Party Status`'s five options are `Waiting for Third Party` (12023),
`Allocated to Dev` (12024), `Version Tagged` (12025), `Fix Deployed` (12026)
and `Duplicate` (12027) — the last four are exactly what `TP_FILTER` excludes.
Watch out for a **second, unrelated field also called "Third Party Status"**
(`[HUBSPOT MIGRATED] Third Party Status`): the JQL literal
`"Third Party Status[Dropdown]"` is what disambiguates them, which is why
every query in this app spells it that way.

There is **no "Last Update Date" custom field** — that column on the Vendor
Bugs tab is Jira's own `updated`.

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
- **Those same seven used to be in NO view at all** — the live queue's JQL
  says `resolution = Unresolved`, which excludes them, and the Closed list
  excludes them too. The **Reopened tile** (14 Sep 2026, section 5a) is where
  they surface now. It does not put them back into the triage view: they are
  still absent from `RAW_ISSUES`, so no tier, chart or assignee count moves.
  Note the set is not static — it was 7 on 4 Sep 2026 and is **3 on the UK
  desk / 35 on ANZ** as of 14 Sep 2026.
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
- **`everBreached()` is the JQL that answers the same question
  `closedSlaState()` does**, and it is how the app's SLA arithmetic can be
  checked without trusting the app: `cf[10879] = everBreached()` counts
  tickets whose Triage clock was ever missed, completed cycles included.
  (`breached()` is the live-queue question instead — see trap 2.) Over the 43
  tickets closed in the 7 days to 14 Sep 2026 it gives Triage 7, First
  Response 6, Response Target 8, Resolution 4, which is exactly what the
  dashboard reports as 84% / 86% / 81% / 91% met. Use it as the second source
  whenever an SLA percentage is in doubt — remember trap 1 and reference the
  SLA fields as `cf[NNNNN]`, never by name.

**The third-party filter** (`TP_FILTER` in the code) excludes tickets parked
with a third party in a state the TAC team can't act on:

```
("Third Party Status[Dropdown]" not in (Duplicate, "Fix Deployed", "Version Tagged", "Allocated to Dev")
 OR "Third Party Status[Dropdown]" is EMPTY)
```

## 3. Seven traps — each fails silently

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

**6. Never `await` straight into a global that a later render reads.** Written
the obvious way —

```js
RAW_ISSUES = await jiraSearch(jql, LIVE_FIELDS);
if (projectStale(epoch)) return;      // too late: the write already happened
```

— the assignment lands the moment the fetch resolves, *before* any staleness
check can run. Switch desk 200ms into a slow fetch and the old desk's tickets
sit in `RAW_ISSUES` under the new desk's header; the screen still looks right
because `ALL_ISSUES` was rebuilt by the newer load, and the wrong data only
surfaces at the *next* `recomputeViews()` — in practice the 5-minute
auto-refresh (the Personal mode toggle used to be the fast way to see it). Found in a browser on 8 Sep 2026 by doing exactly that.
Every loader now awaits into a local, checks, and only then assigns. Any new
fetch must do the same.

**7. A RegExp built inside a template literal needs `\\s`, not `\s`.** In a
template literal `\s` is just `s`, so

```js
new RegExp(`project\s*=\s*${KEY}\b`, 'i')   // compiles to /projects*=s*TACb/
```

matches nothing, ever. That was the live state of `/api/count`'s project pin:
the route 403'd every call, which the Closed list reports only as a missing
"of N" label on the pager, so it read as "Jira has no total for this" rather
than a bug. Found 8 Sep 2026 while making the pin multi-project; the guard is
now one shared `jqlProjectAllowed()` so there is no second copy to get wrong.
This is also the answer to the "untested: check `POST /api/count` first" note
that stood in section 9 for days — it was broken all along.

**A 403 saying "your Jira account does not have permission" may be this app's
own project pin.** `mcpErrorMessage()` used to map every 403 to that sentence,
so a query for a project the *running server* was never told to allow read as
a Jira permissions problem — which is precisely what happened on 8 Sep 2026,
minutes after the desk switcher shipped: the server process had been up since
7 Sep, so it still carried the single-key pin and refused every `project =
TAPC` query while the browser (which re-reads the page from disk) happily
asked for them. Same lesson as trap 4, different status code. `httpError()`
now reads the body's `error` field and reports `project_not_allowed` /
`issue_not_allowed` as configuration faults naming `JIRA_PROJECT_KEYS` and
telling you to restart the server; a genuine Jira 403 still reads as a
permissions problem.

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
"SLA" multi-select lists the clocks in `CLOSED_SLA_OPTIONS`; the ones ticked on
load are `CLOSED_SLA_DEFAULT`. On the 47 tickets closed in the 14 days to
4 Sep 2026: all six → **26** breached, the three headline SLAs (First Response
/ Restoration / Resolution) → **19**. So a wide selection paints over half the
list red, and the Historical tab's "SLA met %" — which only ever counts those
three — will legitimately disagree with it. That is the chosen behaviour, not a
bug. Deselecting SLAs scopes the breach test only; it never drops rows, because
a ticket that missed nothing you selected still belongs in a list of what
closed.

**Two of the six are narrowed on this tab only** (8 Sep 2026, at the
business's direction). `SLA_ALL` still holds all six for the live queue's
`resolveSla()` and the ticket timeline — dropping a clock there would hide real
breaches — so both narrowings live in the two Closed-tab lists instead:

- **`Time with Agent` (`customfield_10970`) is not offered at all.** It is also
  dropped from `CLOSED_FIELDS`, since nothing on the tab can read a clock that
  cannot be picked; that request is now **12** fields, not 13.
- **`Restoration` (`customfield_10968`) is offered but starts unticked.** It
  stays in `CLOSED_FIELDS` — ticking it has to work without a re-query.

So a fresh load counts four clocks, and the button reads "SLA: 4 of 5". Neither
default is persisted, matching the tab's other toggles. Both counts in the
label come from `CLOSED_SLA_OPTIONS.length` rather than being written out, so
adding or removing an option can't leave the label claiming the wrong number.

**Paging is forward-only and cumulative.** A Jira `nextPageToken` cannot be
walked backwards or jumped, so there are no numbered pages — "Load more" plus
"Load all remaining". `fetchClosedPage()` walks tokens until it has **at least**
`CLOSED_PAGE_SIZE` (100) rows, because a single Jira call returns far fewer when
a dozen fields are requested. "At least": the total is tested *after* each append and
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
visit would be worse than a slow fresh one. The header's **Refresh** (section
8) drops the current range's entry and re-queries — it used to be a button in
this tab's own controls row, and moved to the header on 17 Sep 2026.

**The KPI summary strip (added 4 Sep 2026).** A "Show summary" tickbox in the
Closed tab's controls reveals six read-only tiles above the table: **Total
closed**, **SLA Total**, then attainment for `SLA Triage`,
`SLA First Response`, `SLA Response` and `SLA Resolution`
(`CLOSED_KPI_SLAS`). Off by default and not persisted, matching the tab's
other toggles.

Every tile summarises **exactly the rows the filters are showing** — the same
`shown` array the table renders — so the assignee picker and the TAC Tier
filter both feed into them.

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
all six selected, against components of 72–85% — note that a fresh load no
longer selects all six (see the two narrowings above), so the default figure is
higher than that 45%. Dropping SLAs from the picker
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

## 5a. The Reopened tile

Added 14 Sep 2026. A sixth tile on the **Live queue**'s top row: tickets that
were resolved and then pushed back into a live status. Clicking it drills into
the list, like every other tile.

**It is the Live queue's only second query, and it has to be.** The rule —
status is not a finished one, yet a resolution is set — is the exact
complement of `loadLive()`'s `resolution = Unresolved`, so not one of these
tickets can ever be in `RAW_ISSUES`. Same blind spot the Closed list leaves
from the other side (section 2); this tile is what closes it.

```
project = <desk> AND statusCategory != Done AND resolution is not EMPTY
  AND <TP_FILTER> ORDER BY updated DESC
```

**`statusCategory != Done`, not `status not in (Closed, Resolved)`.** The
business stated the rule in those two names, and today the two forms are the
same query — both return 3 on UK and 35 on ANZ (checked against the live
instance 14 Sep 2026, with and without `TP_FILTER`, which excludes none of
them). `statusCategory` is Jira's own project-independent answer to "is this
finished", so a renamed or newly added done status cannot silently start
counting as reopened — the same reasoning as `isLinkDone()` in section 4. If
the business ever wants literally those two names, that one clause is the
edit.

**`TP_FILTER` is applied**, for consistency with every other live-queue query.
It excludes none of these tickets on either desk today, and a ticket the
vendor has taken on has its own tab.

**The tile does not change anything else on the tab.** These tickets are added
to no chart, no assignee count and no tier: the fetch lands in its own array
(`rawReopened` / `reopenedIssues`), never in `RAW_ISSUES`. Moving them into
the triage view is a business question nobody has answered — see the
`loadLive()` note in section 2 — and this tile deliberately does not answer it.

**It is fetched before the first paint, and a failure is non-fatal.** The
query runs after the open pull and before `render()`, so the tile is right the
first time rather than appearing a beat later; but it is wrapped in its own
`try`, so a failure leaves the whole rest of the tab working and the tile
reading "— Count unavailable". In that state it is **not clickable** — an
empty drill would read as "none", which is a different claim from "not known".
Both awaits are guarded by `projectEpoch` (trap 6): a desk switch during the
open pull returns before this query is even sent.

The drill is the only entry in `DRILLS` with a `source`, because it is the
only one not reading `ALL_ISSUES`.

## 5b. The SLA Breakdown tab

Added 14 Sep 2026. The Closed tab's KPI summary strip, broken down by
assignee: one row per person, one column per SLA, over the same 13 date
ranges. The tab sits between Historical and Wallboard.

**It adds no new Jira query, no new cache and no new arithmetic.** It calls
`closedJql()` over `CLOSED_FIELDS`, stores into the same `closedCache`, and
computes every figure with `closedSlaAttainment()` (the four named SLAs) and
`closedSlaTotal()` (the aggregate) — the same two functions behind the Closed
tab's tiles. That is the point rather than an economy: a matrix that
disagreed with the strip it breaks down would be worse than no matrix, and
calling the same code is the only way to guarantee it cannot. Opening this tab
on a range the Closed tab has already loaded costs nothing at all, and paging
on either tab lengthens the list on both.

**What is not shared is the range on screen, `slaBusy`/`slaError` and the
"ever loaded" latch**, because the two tabs are read independently — hence
`loadSla()` / `loadMoreSla()` mirroring their Closed-tab counterparts rather
than calling them. `loadClosed()`'s staleness guard tests `closedRange`, so
reusing it would silently drop every result fetched for a different range.

**The TAC Tier filter and the SLA multi-select ARE shared state**
(`closedTacTiers` / `selectedClosedSlas`). Both decide what a number labelled
"SLA Total" means, and two tabs quietly answering that differently is exactly
the silent disagreement this file keeps warning about. As on the Closed tab,
**the SLA picker scopes only the SLA Total column** — the four named columns
report specific clocks, so letting the picker blank one out would make a named
column lie. There is no assignee picker: the matrix *is* the breakdown.

**Columns:** Assignee, Closed, SLA Total, then `CLOSED_KPI_SLAS` — Triage,
First Response, Response, Resolution. Every cell carries its denominator
underneath ("12 of 16 met"), because the per-SLA denominators are uneven by
nature (section 5) and a bare percentage hides that. A cell with no cycle for
that SLA reads as an em dash, never 0%.

**Rows are ordered busiest-first**, ties alphabetical, `Unassigned` always
last. Deliberately not ordered by attainment: volume ordering is stable
between loads and does not turn the table into a ranking of people. The
bottom row is `All assignees` — the same two calls over the whole shown set,
so the footer cannot drift from the rows above it, and it is what you compare
against the Closed tab's strip.

**A partial load is disclosed twice** — in the summary line and again in the
pager note ("Every percentage below is over what is loaded, not the whole
range"), because a column of percentages computed from the most recent 100
rows is more misleading than a short list is. The pager itself is shared:
`closedPagerHtml()` takes the tab's own loader name and busy flag.

**Every figure in the matrix opens the tickets behind it** (added 17 Sep
2026). Click any cell — the Closed count, SLA Total, or a named SLA — and a
panel drops in under the table listing exactly the tickets that figure counted,
with the ones that **missed the SLA tinted red** (`.row-breach`, the same tint
the Closed tab uses). Clicking the open cell again closes it; the open cell
keeps a tint and a left bar so it is obvious which number the panel belongs to.

**The drill lists the cell's own denominator, not "everything".** That is what
makes it checkable: a named SLA cell reading "4 of 7 met" opens exactly 7 rows
with 3 red. Tickets carrying no cycle for that clock are excluded — as they are
from the percentage — and the panel's note says how many, so the drill cannot
quietly under-report the row. `SLA Total` and `Closed` open the whole row and
both use the same red test (missed **any** selected SLA), so the two can never
disagree about which rows are red.

**Which means the SLA picker moves the SLA Total drill and not a named one** —
the same split the tiles have, now visible in the ticket list rather than only
in a percentage. Measured on the 30 tickets closed in the week to 8 Sep 2026:
14 red with four clocks selected, 7 with one.

Rows are **breached first, then newest close first**. The drill exists to
interrogate a percentage, and the misses are what anyone is looking for; the
Closed tab's own order applies within each group. Rows carry `data-ticket`, so
a click still opens the ticket timeline.

**The cell hover and the open-cell tint must out-rank the table's row hover**,
and repeat themselves under it — the same trap `.row-breach` carries in
section 5, and this feature shipped with it. `.sla-cell:hover` (0,2,0) loses to
`.tbl tbody tr:hover td` (0,2,3) and to `.tbl tbody tr.sla-row-all:hover td`
(0,4,3), so pointing at a figure painted exactly the grey the row was already
painting: reported the same day as "the hover colour is the same as the
background colour". Both states are now written four ways — bare, under a
hovered row, on the totals row, and on a hovered totals row — and the tints are
brand blues (`--primary-30` hover, `--primary-40` open) rather than another
grey, so a cell reads apart from the white rows, from the row hover's
`--grey-50`, and from each other. The test suite pins all eight selectors and
refuses a bare `.sla-cell:hover`.

`slaDrill` is `{row, col}` — the row an assignee name or `SLA_ALL_ROW`, the col
`'closed'`, `'total'` or an SLA field id — and it is **re-resolved from current
data on every render**, never remembered. A Load more, a tier change or a
refresh recomputes it; if the row has gone (a tier filter can remove a person)
the panel closes itself rather than showing a list belonging to nothing on
screen. Changing the date range clears it outright: a different window is a
different set of tickets.

**`jsAttr()` exists because of this feature.** The row key in each cell's
`onclick` is an assignee's display name, and `onclick="toggleSlaDrill('O'Brien')"`
is a syntax error — one apostrophe would break a row silently. It
`JSON.stringify`s for JavaScript then `esc()`s for the attribute; the browser
undoes the second before the first. Use it for any handler argument that
carries data rather than a constant.

Live figures for the 7 days to 14 Sep 2026 (43 tickets, 6 assignees), which
double as the numbers to expect when checking the tab still works:

| | Closed | SLA Total | Triage | First Resp | Response | Resolution |
|---|---|---|---|---|---|---|
| All assignees | 43 | 65% | 84% | 86% | 81% | 91% |

Per-person the spread is wide — 100% across the board on 13 tickets at one
end, 0% SLA Total on 1 ticket at the other — which is the whole reason the
breakdown was asked for.

## 6. Vendor Bugs

Added 9 Sep 2026. Tickets the upstream vendor has actually taken on: **Third
Party Status set to anything other than "Waiting for Third Party"**. Two
sections, `Version Tagged` on top and `Awaiting Dev` below, both oldest-touched
first — the list answers "what has been waiting longest".

**Every ticket on this tab is invisible everywhere else in the dashboard.**
`TP_FILTER`, which every other list applies, excludes precisely the four Third
Party Status values this tab selects for, so none of these tickets are in
`RAW_ISSUES`. That is the reason the tab exists and the reason it runs its own
query — the same situation as the Closed list arriving at from the opposite
direction. (The other known blind spot is the seven reopened tickets in
section 2, which are still in no view at all.)

**The filter is written as "set, and not the parked value"**, not as
`in (Allocated to Dev, Version Tagged, Fix Deployed, Duplicate)`. The two are
identical against today's five options, but a sixth option added in Jira later
would silently never reach this tab under the `in` form. Same instinct as the
TAC Tier filter treating an unknown value as visible rather than dropped, and
`vendorStatusBadge()` matches: an unrecognised value renders in the grey
fallback rather than vanishing.

```
project = <desk> AND "Third Party Status[Dropdown]" is not EMPTY
  AND "Third Party Status[Dropdown]" != "Waiting for Third Party"
  ORDER BY updated ASC
```

**No resolution or statusCategory clause**, because the rule as specified is
"any ticket". On 9 Sep 2026 all 27 UK matches were open (the query returns the
same 27 with and without `statusCategory != Done`), so it costs nothing today —
but if closed vendor bugs ever accumulate here, `AND statusCategory != Done`
in `vendorJql()` is the one line to add.

**The ANZ desk has none — and not because the filter is wrong.** `TAPC` has
**zero** tickets with a Third Party Status of *any* value, so the tab is
legitimately empty there. The empty state says which desk it is talking about
and what the list needs, precisely so it does not read as a broken query.

**The section split is on the Tagged Version FIELD, not on the Third Party
Status of the same name**, and the two disagree on real tickets: two UK tickets
carry status `Version Tagged` with the version field empty, so they sit under
"Awaiting Dev". That is what was asked for; the Vendor Status column is right
there for anyone who wants to spot the mismatch.

**Tagged Version is free text and is not written consistently.** The live set
is `44.1.4`, `v44.5`, `v45`, `v45.1`. A plain string sort splits that into two
groups, because a digit sorts before a letter — `44.1.4` would land nowhere
near `v44.5` despite being the earlier release. `compareVendorVersion()`
therefore drops a leading `v` and compares segment by segment, numerically
where both segments are numeric (so `v9` precedes `v10`, which a lexical sort
gets backwards). Ascending: oldest tagged release first, matching the
oldest-first intent of everything else on the tab. Ties fall through to
`updated` ascending.

**A ticket with no `updated` sorts last**, not first — in an oldest-first list
a missing date would otherwise jump to the top of the queue.

**The Dev Ticket URL column is an icon, never the address.** They are long
vendor help-desk URLs (`help.netsapiens.com/hc/en-us/requests/…`) that would
dominate the row. The icon carries "Dev Ticket URL" as both `title` and
`aria-label`.

**That field is free text, so only `http(s)` is ever linked.** `vendorUrlCell()`
tests the value against `/^https?:\/\//i` and renders anything else as muted
text. Nothing stops someone typing `javascript:…` into a Jira text field, and
this is the one place in the app that turns a user-supplied string into an
`href`. The ticket key is escaped into its `href` too — Jira only issues
`TAC-1234`-shaped keys, so that one is belt-and-braces.

**Cache:** one array with a 2-minute TTL (`VENDOR_TTL`), the same figure the
Closed list uses for ranges that include today, plus the header's **Refresh**
(section 8), which forces a re-query. That button lived in this tab's controls
row until 17 Sep 2026. No keyed cache and no pager: it is a single query with
nothing to vary it, and 27 rows arrive in one page. Nothing is persisted, and a
desk switch clears it like every other cache.

**There is deliberately no assignee picker**: it was not asked for, and at
this size the whole list fits on one screen. (Until 17 Sep 2026 Personal mode
could scope this tab to the viewer; that is gone with it.)

**Rows open the ticket timeline** through the same delegated listener as
everywhere else (`data-ticket`), and clicks on the two links inside a row — the
Jira key and the Dev Ticket URL icon — are ignored by it, as intended.

## 7. The ticket timeline

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

## 8. Decisions and rationale

**OAuth per viewer, not a service account.** Each user signs in with their own
Atlassian account and queries run as them, so Jira's permission scheme is the
access control and there's no shared token to leak.

### Personal mode, removed 17 Sep 2026

It filtered every view to the tickets **assigned to** the signed-in person, via
a header toggle. Gone at the business's direction, on the reasoning that per-
viewer OAuth already governs access.

**Worth being precise about, because the two are easy to conflate:** OAuth
decides what a viewer *may read*, and Personal mode decided what they *were
shown of it* — assignment, not permission. So the capability that actually
went away is "show me only my tickets", not any part of the access model. The
Priority list and the Closed tab both keep an assignee picker, and the SLA
Breakdown is per-assignee by construction, so the gap is the Vendor Bugs tab
and the Wallboard, neither of which can now be narrowed to one person.

What went with it: the header toggle, the per-view banner and "Your tickets
only" chips, the wallboard badge, `matchesViewer()` / `personalFilter()`, and
the app's **only** `localStorage` key (`a4tac_personal`). A browser that still
holds that key is harmless — nothing reads it.

What stayed: `loadIdentity()` and `/api/me`, because `JIRA_BASE` (every
ticket's browse link) comes out of that call and it doubles as the session
probe. It no longer keeps the viewer's name or account id.

**`RAW_ISSUES` / `ALL_ISSUES` and `recomputeViews()` stayed too**, now a
straight hand-off rather than a filter. Collapsing the two names would touch
every renderer for no behaviour change, and `recomputeViews()` is still the one
place a loader publishes what the renderers read. If a filter ever returns,
that is where it goes.

**One fetch, filter in the browser.** All views derive from a single paginated
pull of open tickets (`RAW_ISSUES`). The assignee pickers are array filters
over it — no extra Jira calls.

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

### One Refresh, in the header (moved there 17 Sep 2026)

**Refresh sits next to Auto-refresh and re-queries whatever tab is on
screen.** It replaces the three per-tab buttons that used to live in the
Closed, SLA Breakdown and Vendor Bugs controls rows; the Live queue, Priority
list and Historical never had one at all, so those three views could only be
refreshed by reloading the page. A control that is always visible is only
coherent if it always means something, hence the dispatch.

`REFRESH_BY_TAB` maps each tab key to `{ what, run }`. Two things about it:

- **Every key in `TAB_LABELS` must have an entry.** A missing one falls back
  to the live queue, which would look like the button silently doing nothing
  on the tab you are actually watching. There is an assertion for exactly this,
  so adding a tab without a refresh job fails the suite rather than shipping.
- **The three cached tabs pass `force = true`.** Without it, Closed / SLA /
  Vendor would hit their own TTL and the button would no-op for two minutes —
  the one situation where a user presses Refresh hardest.

**It refreshes one view, not all of them**, and `what` names that view in the
tooltip ("Re-query Jira for the Closed list"). Re-querying five views because
somebody wanted today's closed list again would be several seconds of Jira for
data nobody is looking at. The consequence to know: refreshing on the Closed
tab does **not** freshen the live queue, so the "Updated …" timestamp in the
header — which only `loadLive()` writes — legitimately stays put.

**Being in the header puts it out of reach of trap 5.** The tab renderers
replace their own controls row and nothing else, so this button can never be
destroyed mid-click. A click with a multi-select panel open both closes the
panel (the document listener) and fires the refresh — which is what the old
in-row button had to be explicitly tested for, and is now structural.

Busy state is the disabled attribute plus a "Refreshing…" label, restored in a
`finally` so a failed query cannot leave the button stuck. It deliberately does
**not** borrow auto-refresh's `.is-on` teal: the two buttons sit side by side,
and that colour means "armed", not "working".

### The desk switcher (added 8 Sep 2026)

The brand name in the header is a `<select>` over `PROJECTS`, and its key goes
straight into every JQL the page builds (`loadLive`, `loadHistorical`, the
wallboard's today queries, `closedJql()`). Adding a third desk is one entry in
`PROJECTS` plus its key in the server's `JIRA_PROJECT_KEYS` — no markup, no
per-view change.

**A native `<select>`, not the custom panel pattern.** Two desks are mutually
exclusive, so there is nothing to multi-select, and a native control gets
keyboard and screen-reader behaviour for free — plus it cannot fall into
trap 5, since there is no document-level click listener and nothing gets
re-rendered on close. It is styled to *look* like the brand name rather than a
form field (`appearance:none` plus our own overlaid `chevron-down`, the same
trick documented for the Assignee picker in section 4).

**One desk at a time; no combined view.** Asked and declined 8 Sep 2026: a
mixed queue would interleave two teams' triage order in the Priority list and
present two teams' assignee load as one, which is misleading rather than
informative. If it is ever wanted, the JQL is `project in (TAC, TAPC)` — but
note the server pin matches `project = <key>` and would need widening too.

**The choice is NOT persisted.** Every fresh load opens the UK desk. Asked and
chosen 8 Sep 2026: a wallboard TV and a shared link then always start from the
same place, and nobody inherits yesterday's desk without noticing. The switch
lasts the session. Since Personal mode went, this app writes nothing to
`localStorage` at all.

**A switch throws away every cache.** The live array, the wallboard's today
counts, the historical weeks, the Closed list's per-range cache and the
ticket-timeline cache are all scoped to one project, so `switchProject()`
clears all of them rather than keying five caches by desk. Nobody flips desk
in a loop, and a row left over from the other desk opens a timeline the
server's key guard is entitled to refuse. The open timeline modal is closed
for the same reason. Kept across a switch: auto-refresh, which tab you are on,
and the tier/SLA pickers (both desks use the same tiers and the same six
clocks). Reset: the two assignee pickers, since the desks are
staffed by different people and a name from one filters the other to nothing.

**In-flight fetches are dropped by `projectEpoch`**, bumped on every switch;
each loader captures it and re-checks after every await. This is not
belt-and-braces: the ANZ queue is 395 open tickets, i.e. several pages, so
switching mid-fetch is the normal case. The Closed list's guard needs the
epoch *as well as* its range key, because both desks use the same 13 range
keys — "still the range on screen" no longer implies "still the desk on
screen". See trap 6 for the bug this caught.

**The server pin is a list, not a key.** `JIRA_PROJECT_KEYS` (default
`TAC,TAPC`) feeds one `JQL_PROJECT_RE` and one `ISSUE_KEY_RE`, and the keys
are validated against `/^[A-Z][A-Z0-9_]{0,9}$/` before being interpolated into
those RegExps — an env var reaching a RegExp is how a guard gets silently
widened. The legacy singular `JIRA_PROJECT_KEY` is still honoured when the
plural is unset, but it *hides the other desk*, so the server warns about that
at boot rather than leaving a 403 to look like a Jira permission problem.
**A `.env` from before this change pins `JIRA_PROJECT_KEY=TAC` and must be
updated** — `.env.example` now carries the plural form.

## 9. Tested vs untested

Verified: server boots; refuses to start on missing/short config; both API
routes return 401 when signed out; mismatched OAuth `state` is rejected; the
dashboard shell is never served to anonymous visitors; the project guard allows
real queries and blocks other projects including the near-miss `TACPC`; the
tier logic partitions live data with no overlaps or gaps (56 in, 56 out).
(An earlier line here recorded Personal mode matching the right 11 tickets;
that feature was removed on 17 Sep 2026.)

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
  stays open across toggles, its button label tracks (All 6 → 3 of 6 → None —
  the picker offered six clocks at the time; it now offers five),
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

Also unverified in the real app: whether the (then 13-field, now 12-field)
`CLOSED_FIELDS` request
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

**Session of 8 Sep 2026 — the desk switcher, and the Closed tab's SLA picker
narrowed to five clocks.** The first session to drive the *real page* end to
end: `views/index.html` was served unmodified by a stub of the three API
routes, fed real Jira payloads for both desks pulled through the Atlassian MCP
connector (42 UK open / 30 UK closed, 100 ANZ open / 50 ANZ closed), and
driven in a browser. Still no Jira OAuth session, so the app's own proxy path
to Jira remains unexercised.

Verified in that browser:

- The header picker lists both desks, wears the brand typography with our own
  chevron (one, not two), and recolours on hover.
- Switching desk repaints everything: UK 42 open → ANZ 100 open, the status
  chart gains `Scheduled With Partner`, the priority ring gains P1, the
  assignee list changes people, and the page/tab title tracks the desk.
- **Priority tier 1 renders for the first time** — ANZ's live P1 (`TAPC-17104`)
  sits above the breach tier. Section 8's long-standing "tier 1 could not be
  exercised against real data" caveat is now closed on the ANZ desk.
- Switching *while on* the Closed tab re-queries in place (ANZ 50 rows and its
  assignee list → UK 30 rows and its own), and the SLA panel left open across
  the switch re-renders with its selection intact.
- An open ticket-timeline modal closes on a switch and body scroll is
  restored; `detailCache`, `closedCache`, the assignee pickers and the drill
  state all reset, while `activeTab` and the tier/SLA pickers do not.
- Historical and Wallboard both follow the desk, and the wallboard title names
  it.
- **The race in trap 6 was found and then fixed here**: with the UK desk's
  fetch deliberately slowed 2.5s and a switch to ANZ 200ms in, `RAW_ISSUES`
  ended up holding 42 UK tickets under an ANZ header showing 100. After the
  fix the same run leaves every array on TAPC.
- The five-option SLA picker (Restoration unticked, no `Time with Agent`) and
  its "SLA: 4 of 5" label, in the real control rather than a harness.

Verified outside the browser:

- **43 real JQL queries captured from that browser run** (20 UK, 23 ANZ, six
  distinct shapes) were fed through the *real* server-side pin extracted from
  `server.js` — all accepted. The pin's own suite adds the near-misses
  (`TACPC`, `TAC2`, `TAPCX`, `project in (...)`, a missing project clause),
  the issue-key shapes for both desks (`TAPC-17135` yes, `TACPC-1` no,
  `TAC-6225 OR 1=1` no, a newline-injected key no), the legacy single-key
  fallback still excluding ANZ, the plural winning over the legacy name, and
  seven malformed key lists — including a RegExp-injection attempt
  (`TAC,(TAP|.*)`) — refusing to boot.
- **`server.js` was booted for real** on spare ports: both API routes and both
  `/api/issue` routes answer 401 signed out, an anonymous `/` still serves
  only the sign-in page (no dashboard markup), a bad key list exits 1 with a
  named rejection, and the legacy-variable warning prints.

**Untested here:** `/api/count` against the real Jira endpoint. Trap 7 explains
why its guard could never have worked before today, so the pager's "of N"
label has never once been seen working — it is the first thing to check with
real credentials, along with `/api/issue/:key` through the real proxy.

**Session of 9 Sep 2026 — the Vendor Bugs tab.** Same technique as the desk
switcher: the real `views/index.html` served by a stub of the API routes, fed
the real 27 UK vendor tickets and the real (empty) ANZ result pulled through
the Atlassian connector, then driven in a browser. **No screenshots this run** —
the app window was minimized, so the visual check was done through the live
DOM rather than by eye. Still no Jira OAuth session.

- **Fields were read from Jira's own create-meta**, not guessed: the four ids
  in section 2, including the trap that a second field shares the name "Third
  Party Status" and that no "Last Update Date" field exists.
- **Counts confirmed by JQL before any code was written**: UK 27 matches (27
  of them open, so the open/closed question is moot today), ANZ 0 — and ANZ has
  0 tickets with *any* Third Party Status value, which is why its empty state
  had to explain itself.
- **~70 assertions** over those 27 real tickets against the shipped functions:
  the JQL for both desks (and that it does not use the `in (...)` form), the
  9/18 section split with no ticket lost or duplicated, version order
  (`44.1.4` → `v44.5` → `v45` → `v45.1`) with ties broken by oldest update,
  `v9` before `v10`, the two live status-says-tagged-but-field-empty tickets
  landing under Awaiting Dev, an undated ticket sorting last, all eight
  headers, and hostile input in every column (no tag or `on*` attribute
  survives; the key is escaped into its href).
- **Eight non-http values were rejected as links** (`javascript:`, `data:`,
  `file:`, `vbscript:`, a bare host, `TBC`, `#`) while `http://` and
  `https://` still link.
- **In the browser**: the tab loads 27 rows under the two headings with the
  live summary line, versions render in the asserted order, 25 icon links carry
  `title`/`aria-label` "Dev Ticket URL" with the address never shown, a click
  on a row opens the timeline while clicks on the key link and the URL icon do
  not, personal mode empties the list with the "assigned to you" wording (that
  behaviour is gone — Personal mode was removed 17 Sep 2026),
  switching to ANZ mid-tab re-queries and shows the desk-named empty state,
  the tab's own Refresh button re-queried (that button has since moved to the
  header — see section 8), and switching back restores 9/18.
- The **vendor JQL the real page sent was captured and fed through the real
  server-side project pin** (extracted from `server.js`) — accepted for both
  desks.

**Untested:** a vendor bug that is closed (none exist), a Third Party Status
value outside the five current options (covered by synthetic input only), and
whether ANZ ever starts using the field.

**Session of 14 Sep 2026 — the Reopened tile.** Same technique as the last
two sessions: the real `views/index.html` served by a stub of the API routes
and driven in a browser, plus the shipped functions run in a Node harness.
Still no Jira OAuth session, so the app's own proxy path remains unexercised.

- **The rule was settled against live Jira before any code was written.** Both
  forms of "not finished" (`statusCategory != Done` and
  `status not in (Closed, Resolved)`) return the same rows on both desks — UK
  3, ANZ 35 — and `TP_FILTER` excludes none of them. The three UK tickets are
  TAC-6152, TAC-5440 and TAC-5400, i.e. three of the seven from section 2; the
  other four have since been closed properly, which is why that list is dated.
- **33 assertions** in two Node suites over the shipped functions: the JQL for
  both desks (and that it does *not* match statuses by name), that the real
  server-side project pin accepts it, all three tile states (loading, failed,
  loaded — and that 0 renders as `0` and stays drillable while "unknown"
  renders as an em dash and does not), that the drill reads its own array and
  the other five still read `ALL_ISSUES`, that personal mode filtered it and
  left a null array null (that filter is gone — removed 17 Sep 2026), that a
  desk switch clears it, and three `loadLive()`
  paths: the happy one (reopened fetched *before* the first render), the
  reopened query throwing (live queue still loads and paints, tile reads
  "Count unavailable"), and a `projectEpoch` bump mid-flight (nothing assigned,
  and the second query never even sent).
- **In the browser**: six tiles in one row at 1440px and wrapping cleanly at
  ~400px, the tile reading 3 with the drill listing exactly TAC-6152 / TAC-5440
  / TAC-5400 under the tile row, personal mode taking it to 1 (feature since
  removed), a desk switch
  re-querying and repainting it, and — against a stub returning 503 for that
  one query — the whole tab still rendering 42 open tickets with the tile at
  "— Count unavailable" and no JS errors. The JQL the real page sent was read
  out of the stub's log and matches what was validated against Jira.

**Untested:** a desk where the two "not finished" forms disagree (none today),
and the tile against the app's own REST proxy.

**Session of 14 Sep 2026 (second change) — the SLA Breakdown tab.** Same
technique again, with one upgrade: the real Jira payload was pulled through
the connector **to a file** (the connector spills an oversized result to disk)
rather than being retyped or sampled, so both the Node suite and the browser
run were driven by the **actual 43 TAC tickets closed in the 7 days to
14 Sep 2026**, SLA cycle payloads and all. Still no Jira OAuth session.

- **The arithmetic was checked against Jira itself, not just against the
  app.** Five independent JQL counts using `everBreached()` (section 2) give
  43 closed, 7 / 6 / 8 / 4 breached on Triage / First Response / Response /
  Resolution. The tab reports 84% / 86% / 81% / 91%, i.e. 36 / 37 / 35 / 39 of
  43 — exact agreement between the app parsing SLA cycle payloads and Jira
  evaluating its own SLA functions.
- **The matrix and the Closed tab's strip were compared directly, in the
  browser, on the same range**: strip 65% / 84% / 86% / 81% / 91% with "28 of
  43 met all", All-assignees row identical, and the Closed tab's own summary
  line agreeing at "15 breached" (43 − 28).
- **25 assertions** over those real tickets: rows partition the set (six
  assignees summing to 43), busiest-first ordering with Unassigned forced
  last, every row equal to the same two functions over that person's tickets,
  SLA Total at or below every named column on every row, the SLA picker
  moving SLA Total **and nothing else**, one SLA selected making SLA Total
  equal that column, nothing selected reading as an em dash, the tier filter
  and personal mode recomputing rather than reusing (that filter is gone), the
  13 range keys
  matching `CLOSED_RANGES`, and the empty/partial states.
- **In the browser**: the tab loads on Current Day and re-queries on range
  change; Last 7 days reproduces the asserted matrix exactly; personal mode
  reduced it to one row (Emi Pritchard, 5 tickets, 60/80/80/80/100) with the
  banner — that path no longer exists; a desk switch re-queries in place and
  keeps the range; the tier and
  SLA panels open, replace each other rather than stacking, filter from inside
  (43 → 37) and close on an outside click; **clicking Refresh with a panel
  open both closes the panel and fires the refresh** (trap 5 clear — confirmed
  by two queries in the stub's log; re-confirmed 17 Sep 2026 against the
  header button, where it is structural rather than luck); the migration-quarter pager reads "100
  loaded of 5,225 · Load all remaining (5,125)" and "Load more" grows it, with
  the Closed tab then showing the same enlarged set **without re-querying**;
  and a 503 on that query shows one error box with every control still usable
  while the rest of the dashboard is untouched.

**Untested:** this tab against the app's own REST proxy, and a range where
the two tabs are looked at with different ranges *while a load is in flight*
(the guards are written for it, and `slaStillCurrent()` was read rather than
exercised).

**A pre-existing gap this work surfaced, deliberately not fixed here:**
`fetchClosedPage()` walks `nextPageToken` until it has 100 rows and will
**spin forever** if Jira ever returns a non-null token with empty pages. The
ticket timeline's changelog walk explicitly guards against exactly that
(section 9's changelog-paging note); this one does not. It has never happened
against real Jira — it happened against a badly written stub during this
session, which is how it was noticed.

**Session of 17 Sep 2026 — the Refresh button moved to the header.** Same
technique: the real page served by a stub of the API routes over real Jira
payloads, driven in a browser, plus the shipped dispatch run in a Node
harness. Screenshots worked this time, so the header and all three stripped
controls rows were also checked by eye.

- **22 assertions** over the real `REFRESH_BY_TAB` extracted from the page:
  every tab in `TAB_LABELS` has a job, each dispatches to the right loader
  (live/priority → `loadLive`, closed → `loadClosed(true)`, vendor →
  `loadVendor(true)`, sla → `loadSla(true)`, hist → `loadHistorical`), the
  three cached tabs pass `force`, an unknown tab falls back to the live queue
  rather than throwing, a second click while in flight fires nothing, a
  rejected load still restores the button, `paintRefreshBtn()` survives a
  missing DOM, the tooltip names each view, and the markup carries exactly one
  Refresh control — in the header, before `#ar-btn`, with no `.cl-btn` Refresh
  left in any controls row.
- **In the browser, one tab at a time**: a real click on the header button
  fired exactly the right query on each of the six reachable tabs (read out of
  the stub's log — open+reopened+today for live and priority, closed+count for
  Closed and for SLA Breakdown, the vendor query for Vendor Bugs, both week
  queries for Historical), with the button reading "Refreshing…" and disabled
  mid-flight and back to "Refresh" after, and the tooltip tracking the tab.
- **Trap 5, re-checked**: with the Closed tab's SLA panel open, a real click at
  the header button's coordinates closed the panel, un-pressed its button and
  still fired the closed query.
- Eyeballed: the header reads Personal mode · Refresh · Auto-refresh · Updated
  · Sign out (Personal mode has since been removed), and the Closed, SLA Breakdown and Vendor Bugs controls rows sit
  correctly without their old buttons.

**Untested:** the wallboard's entry in `REFRESH_BY_TAB` (the header is hidden
there, so nothing can click it) and what the button does mid-desk-switch — the
`projectEpoch` guards inside each loader are what cover that, and they were
not re-exercised here.

**Session of 17 Sep 2026 (second change) — Personal mode removed.** A deletion
rather than a feature, so the work was proving nothing else moved. Same stub
harness over real Jira payloads, driven in a browser.

- **The four existing Node suites still pass unchanged** (header refresh,
  Vendor Bugs over the real 27 tickets, the error mapping, the server project
  pin), which is the evidence that the removal did not reach into the logic
  they cover.
- **Every reference was removed, not just the visible ones**: the toggle, the
  CSS block (`.pm-toggle` / `.pm-chip` / `.pm-note` / `.wb-personal`),
  `matchesViewer()`, `personalFilter()`, `applyPersonalView()`,
  `paintPersonalBtn()`, `personalBanner()`, `togglePersonalMode()`, the
  localStorage pref, six banner call sites, three "Your tickets only" chips,
  two empty-state branches, the wallboard badge and its dead "filtered
  everything out" branch. A scripted assertion refuses to write the file while
  any of those names survive, and the three stale *comments* that mentioned it
  were rewritten rather than left to mislead.
- **In the browser**: the header is now Refresh · Auto-refresh · Updated ·
  Sign out with no toggle, `personalMode` is not even defined, and all seven
  tabs render — Priority list 41 rows with its assignee picker (`All assignees
  (42)`) always present, Closed 30 rows with its own picker, Vendor Bugs 27,
  SLA Breakdown 6 rows, Historical and the Wallboard (no badge, title intact).
  No console errors.

**Untested:** nothing new — this session only removed code. The one thing to
glance at with real credentials is that the Priority list and Closed assignee
pickers still read sensibly now that they are the only way to narrow to one
person.

**Session of 17 Sep 2026 (third change) — drilling into the SLA matrix.**
Same technique: the shipped functions in a Node harness over real Jira data,
then the real page driven in a browser against the stub.

- **39 assertions** over the 30 real TAC tickets closed in the week to 8 Sep
  2026 (5 assignees, 14 breached). The load-bearing ones tie the drill to the
  figure it came from: a named SLA's drill has exactly `withData` rows and
  exactly `withData - met` red ones; `SLA Total`'s red count equals
  `closedSlaTotal().breached`, i.e. 100% minus the tile; and `Closed` and
  `SLA Total` mark the identical set of tickets red. Also: every red row is red
  for the right reason (per-clock vs across-the-selection), ordering is
  breached-first then newest-close-first, a vanished row or unknown column
  resolves to null and the panel clears the state rather than throwing, the
  assignee column appears only on the totals drill, cells with no data for a
  clock are not clickable, exactly one cell is marked open, and toggling the
  same cell twice closes it.
- **`jsAttr()` is pinned by four cases** plus a hostile display name
  (`X" onmouseover="alert(1)`): every `onclick` value it produces must still
  decode to a complete `toggleSlaDrill(...)` call **and parse as JavaScript**,
  which is the real question rather than whether the string appears anywhere.
- **In the browser**: 36 clickable cells over 6 rows; Alisha Murray's SLA Total
  (29%, "2 of 7 met all") opens 7 rows with 5 red and the note to match; her
  SLA Triage (57%) opens 7 with 3; the totals row's Closed cell opens all 30
  with 14 red and an Assignee column; clicking the same cell again closes it
  and un-marks it; a drill row opens the ticket timeline (TAC-6105). Narrowing
  the SLA picker through the tab's own `onSlaSlaCheck` took the open SLA Total
  drill from 14 red to 7 and back, while a named column's drill held at 6 red
  throughout.

**A note for whoever tests this next:** `onClosedSlaCheck` and `onSlaSlaCheck`
are different functions — the first re-renders the Closed tab, the second the
SLA Breakdown. Calling the wrong one from the console changes the shared
`selectedClosedSlas` set but repaints the tab you are not looking at, which
looks exactly like the picker being ignored. It cost a wrong conclusion here
for a few minutes.

**The hover shipped broken and was fixed the same day.** See section 5b: the
cell hover lost on specificity to the table's row hover, so it painted the same
grey and read as nothing happening. Re-verified by resolving the cascade in the
page — every `:hover` rule cloned with the pseudo-class swapped for a real
class, which carries identical specificity — giving hovered cell
`rgb(232,245,248)` against a row-hover sibling at `rgb(249,250,251)`, and the
open cell holding `rgb(214,237,241)` plus its teal inset bar even while its row
is hovered. Eight selectors and both tints are now asserted, and the assertions
were checked against a deliberately reverted copy of the file to confirm they
fail on the old rule rather than passing vacuously.

**A measurement trap worth knowing before trusting a styling check:** when the
app window is behind another window the Browser pane stops painting, and CSS
**transitions never advance** — so `getComputedStyle()` keeps returning the
*starting* colour and every hover probe reads as "no change", whether or not
the CSS is right. That cost a wrong diagnosis here until `*{transition:none
!important}` was injected before probing. Any future colour check should do the
same, or read a freshly rendered element that has no transition to run.

**Untested:** the drill against a range big enough to page (every check ran on
a single-page range), and what a 5,000-row drill does to the browser — the
panel renders every row it lists, with no cap.

**Still untested:** everything on the Historical tab. Its two queries use
different field sets (`HIST_CREATED_FIELDS` / `HIST_RESOLVED_FIELDS`) and read
`customfield_10690` (CSAT) and `customfield_10700`, none of which the live-queue
path touches. Nothing has exercised those against the REST proxy — the tab has
now been *rendered* on both desks against real issues, but through the stub,
so the proxy path is still the untested part. Nor is it known whether those
two custom fields are populated at all on the ANZ desk.

## 10. Where things are

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
- `PROJECTS` / `projectKey` / `currentProject()` — the two desks; the key goes
  into every JQL below
- `switchProject()` / `projectEpoch` / `projectStale()` — the switch, the
  cache reset, and the in-flight-fetch guard (section 8, trap 6)
- `REFRESH_BY_TAB` / `refreshActiveTab()` — the header's one Refresh button and
  which loader each tab gets (section 8)
- `callSearchTool` / `callMcpTool` — the only functions that talk to the server
- `resolveSla()` — turns six SLA fields into one state: ticking / paused / completed / breached
- `closedSlaState()` — the Closed list's *different* rule: ever-breached, over
  the user-selected subset of the six clocks (section 5)
- `buildTicketTimeline()` / `timeInStatus()` — the ticket history modal's two
  derived views (section 7)
- `fetchIssueDetail()` — the only per-issue read; walks the changelog
- `onTicketRowClick()` — the one delegated listener behind every clickable row
- `reopenedJql()` / `reopenedTile()` — the Live queue's own second query and
  its tile (section 5a); `rawReopened` / `reopenedIssues` are its arrays
- `buildPriorityList()` — the 11 tiers
- `CLOSED_RANGES` / `closedJql()` — the 13 date windows and their JQL
- `vendorJql()` / `vendorSections()` / `compareVendorVersion()` — the Vendor
  Bugs filter, its two sections and the free-text version sort (section 6)
- `vendorUrlCell()` — the only place a user-supplied string becomes an href
- `fetchClosedPage()` / `loadMoreClosed()` / `closedCache` — the Closed list's
  pager and per-range cache, shared with the SLA Breakdown tab
- `loadSla()` / `renderSlaTable()` / `slaMatrixRow()` — the SLA Breakdown
  matrix (section 5b); it owns `slaRange` and nothing else
- `slaDrill` / `slaDrillSet()` / `slaDrillPanel()` — the tickets behind any
  figure in that matrix, red where the SLA was missed (section 5b)
- `jsAttr()` — the only safe way to put a data value into an `onclick=""`
- `render()` — live tab; `renderPriorityList()` / `renderPriorityTable()`;
  `renderClosed()` / `renderClosedTable()`; `renderSla()` / `renderSlaTable()`;
  `renderVendor()` /
  `renderVendorTable()`; `renderTicketDetail()`;
  `renderHistorical()`; `renderWallboard()`
- `loadIdentity()` / `recomputeViews()` — the `/api/me` call behind `JIRA_BASE`,
  and the one place loaders publish what renderers read (section 8; this is
  what is left of the Personal mode block)

Chart.js is pinned and hash-verified against the original CDN copy. If you
replace it, verify the integrity hash rather than trusting a download.

## 11. Likely next tasks

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
  bodies are ADF and need flattening (section 7 says why they were left out)
- **Make the timeline work for linked ESD/DEVX tickets** → the `ISSUE_KEY_RE`
  guard in `server.js` pins the project by key shape
- **Add a date range to the Closed list** → one entry in `CLOSED_RANGES`; set
  `live` to whether the window includes today, since that picks the cache TTL
- **Change which tickets count as vendor bugs** → `vendorJql()`; keep it
  expressed as "set, and not the parked value" so a new Third Party Status
  option is not silently dropped (section 6)
- **Add a column to Vendor Bugs** → `VENDOR_THEAD`, `vendorRow()` and
  `VENDOR_COLS` together, plus the field id in `VENDOR_FIELDS`
- **Change what counts as an SLA breach on closed tickets** →
  `closedSlaState()`, not `resolveSla()` — see section 5 on why they differ
- **Change what counts as reopened** → `reopenedJql()` (section 5a), not
  `loadLive()`
- **Add a column to the SLA Breakdown** → `CLOSED_KPI_SLAS`, which the Closed
  tab's tiles and this matrix's columns both read; nothing else needs editing
  (section 5b)
- **Change what a matrix cell opens** → `slaDrillSet()`, which resolves a cell
  to {tickets, red test, note}; keep the drill listing the cell's own
  denominator or the panel stops matching the figure (section 5b)
- **Break the SLA matrix down by something other than assignee** →
  `renderSlaTable()`'s grouping; keep `slaMatrixRow()` for both the rows and
  the totals row so the two cannot drift
- **Put reopened tickets back into the triage view** → `loadLive()`'s
  `resolution = Unresolved` is what keeps them out of `RAW_ISSUES`; the
  Reopened tile surfaces them without doing that (sections 2 and 5a)
- **Add a tab** → besides the markup and `TAB_LABELS`, give it an entry in
  `REFRESH_BY_TAB` or the header's Refresh will quietly re-query the live
  queue instead (section 8)
- **Add a third desk** → one entry in `PROJECTS` (`views/index.html`) plus its
  key in `JIRA_PROJECT_KEYS`; nothing else, provided the project carries the
  same statuses, priorities, tier values and SLA fields (section 2 says how
  that was checked for ANZ)
- **Show two desks at once** → declined 8 Sep 2026 (section 8); would need
  `project in (...)` JQL *and* a widened server pin, which today matches only
  `project = <key>`
- **Survive restarts / run replicas** → swap the in-memory session store for
  `connect-redis`
- **Permanent wallboard screen** → sessions expire after 12h; a display mode
  with a long-lived token would be needed
