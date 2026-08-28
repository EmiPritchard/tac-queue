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
`customfield_10700` / `customfield_10690` used in historical.

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
  have gone — hid live breaches on **15 of 56** open tickets. Measured against
  the live queue: 26 tickets have a live breach, the old rule surfaced 11.

  A **paused** cycle that is past target counts as breached: pausing stops the
  clock without un-missing the target. That is 7 tickets today, all Pending
  Response or Awaiting External Party. To treat them as not-actionable instead,
  add `&& !s.ongoingCycle.paused` to `isBreachingNow()` — tier 2 goes 26 → 19.
- "Soonest breach" uses `resolveSla()`, which picks the **minimum remaining
  time across all six SLA fields**, counting only cycles that are ongoing and
  not paused. Tickets with no ticking SLA sort to the bottom of their tier
  rather than the top.
- "Going overdue today" is evaluated against the **Europe/London** calendar
  date, matching the timezone convention used throughout the file.

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
56 out, no duplicates); tier 2 contains exactly the currently-breached set (26)
with none outside it; and the 10 tickets whose only breaches are historic are
correctly excluded.

**Still not verified end to end:** `JIRA_BASE` resolving from `/api/me`'s
`siteUrl`. The code path and fallback were checked, and live Jira confirms the
right base is `https://access4.atlassian.net/browse/`, but the resolved value
has not been eyeballed in a running session.

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
