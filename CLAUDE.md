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

Four views, all fed by a **single** Jira fetch of open tickets:

| View | What it shows |
|---|---|
| Live queue | Summary tiles, status/priority/type charts, assignee load, drill-downs |
| Priority list | All open tickets in an 11-tier triage order (section 4) |
| Historical | Week-by-week created/resolved, SLA attainment, CSAT |
| Wallboard | Full-screen KPI view for a TV |

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

**Statuses in use:** New, Requester Responded, In Progress, Pending Response,
Awaiting External Party, Awaiting Internal Team.
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

**Other custom fields:** `customfield_10002` organisation,
`customfield_10854` product, `customfield_10690` CSAT,
`customfield_10700` / `customfield_10690` used in historical,
`customfield_10874` TAC Tier — single-select, `{value: "1.5"|"2.0"|"2.5"}`,
powers the Priority list's tier filter (added 28 Aug 2026, confirmed against
81 live open tickets: only those three values occur, no nulls — though the
filter still treats "all three checked" as unfiltered rather than exact
membership, so an unseen 4th value or a null wouldn't be silently dropped).

**The third-party filter** (`TP_FILTER` in the code) excludes tickets parked
with a third party in a state the TAC team can't act on:

```
("Third Party Status[Dropdown]" not in (Duplicate, "Fix Deployed", "Version Tagged", "Allocated to Dev")
 OR "Third Party Status[Dropdown]" is EMPTY)
```

## 3. Three JQL traps — each fails silently

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

Also note: when querying through an MCP connector, **invalid JQL returns zero
rows instead of an error**. A 0 result is not evidence your syntax is right.
Validate against a query you know returns rows.

## 4. The Priority list spec

The ordering the business asked for. Every open ticket falls into the **first**
tier it matches (a waterfall), then each tier sorts by its own rule.

| # | Tier | Sort within tier |
|---|---|---|
| 1 | P1 and P2, excluding Pending Response | P1 above P2, then oldest created first |
| 2 | **Currently** in breach (see below) | Longest in breach first (earliest *ongoing* breach timestamp) |
| 3 | Going overdue within 1 hour, not paused | Soonest breach first |
| 4 | Status New ("to triage") | Soonest breach first |
| 5 | Status Requester Responded ("to respond") | Soonest breach first |
| 6 | Going overdue today, not paused | Soonest breach first |
| 7 | P3 with no update in 24h+, excluding Pending Response | Soonest breach first |
| 8 | P4 with no update in 72h+, excluding Pending Response | Soonest breach first |
| 9 | P5 with no update in 7d+, excluding Pending Response | Soonest breach first |
| 10 | In Progress | Soonest breach first |
| 11 | Everything else | Soonest breach first |

Implemented in `buildPriorityList()`. It works on a copy of the array and
removes each matched ticket from the pool, which is what makes the waterfall
exclusive. **If you add a tier, keep that take-and-remove pattern** or tickets
will appear twice.

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

## 5. Decisions and rationale

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

## 6. Tested vs untested

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

**Still untested:** everything on the Historical tab. Its two queries use
different field sets (`HIST_CREATED_FIELDS` / `HIST_RESOLVED_FIELDS`) and read
`customfield_10690` (CSAT) and `customfield_10700`, none of which the live-queue
path touches. Nothing has exercised those against the REST proxy.

## 7. Where things are

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
- `buildPriorityList()` — the 11 tiers
- `render()` — live tab; `renderPriorityList()` / `renderPriorityTable()`;
  `renderHistorical()`; `renderWallboard()`
- Personal mode block — identity lookup, `matchesViewer()`, `recomputeViews()`

Chart.js is pinned and hash-verified against the original CDN copy. If you
replace it, verify the integrity hash rather than trusting a download.

## 8. Likely next tasks

- **Change a tier rule** → `buildPriorityList()`, keep the take-and-remove pattern
- **Add a field to the table** → `PRIORITY_THEAD` and `priorityRow()`; add the
  field ID to `LIVE_FIELDS` or it won't be fetched
- **Multiple projects** → `JIRA_PROJECT_KEY` guard in `server.js` is single-project;
  the front-end hardcodes `project = TAC` in its JQL
- **Survive restarts / run replicas** → swap the in-memory session store for
  `connect-redis`
- **Permanent wallboard screen** → sessions expire after 12h; a display mode
  with a long-lived token would be needed
