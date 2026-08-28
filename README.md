# Access4 UK TAC — Support Queue Dashboard

The TAC support queue dashboard as a standalone website. Viewers sign in with
their **Atlassian account** — no Claude account required.

Same dashboard as before: Live queue, Priority list (the 11-tier triage
ordering), Historical, Wallboard, and Personal mode.

> **Picking this up cold?** Read `CLAUDE.md` first. It documents the Jira
> field IDs, three JQL behaviours that fail silently, the full priority-tier
> spec, and what has and hasn't been tested.

---

## How access works

Each viewer signs in with their own Atlassian account via OAuth 2.0 (3LO), and
every Jira call runs **as that person**. Consequences worth understanding:

- There is no shared service-account token to leak or rotate.
- Jira's own permission scheme decides what each viewer can see. Someone with
  no access to the TAC project sees an empty dashboard, not a filtered one.
- **Personal mode is real here.** It matches on the signed-in Atlassian
  `account_id`, and the underlying data is already limited to what that person
  may read — unlike the Claude artifact version, where it was only a
  client-side convenience filter.

Viewers need permission to browse **Service Desk – UK TAC**. If your Jira admin
hasn't granted their account that, this app cannot grant it either.

## Requirements

- Node.js 22.9+ (Docker image uses Node 22). `npm start` reads `.env` via
  Node's built-in `--env-file-if-exists`, which is why the floor is 22.9 —
  there is no `dotenv` dependency. Use `npm run start:noenv` where the
  platform injects the environment itself (Docker, ECS, Cloud Run, App Service).
  Both scripts also pass `--use-system-ca`; if your Node rejects that flag it
  is too old for it, so upgrade Node (see **TLS on the corporate network**).
- An Atlassian Cloud site (`access4.atlassian.net`)
- Somewhere to host it that Atlassian can redirect back to

## Setup

**1. Register the OAuth app**

Go to https://developer.atlassian.com/console/myapps/ → **Create** →
**OAuth 2.0 integration**.

- **Permissions** → *Jira API* → Add → enable scopes `read:jira-work` and
  `read:jira-user`.
- **Authorization** → *OAuth 2.0 (3LO)* → set the callback URL to your app's
  base URL plus `/oauth/callback`, for example
  `https://tac.access4.internal/oauth/callback`. It must match **exactly** —
  a trailing slash difference will fail the sign-in.
- **Settings** → copy the Client ID and Secret.

**2. Configure**

```bash
cp .env.example .env
# fill in ATLASSIAN_CLIENT_ID, ATLASSIAN_CLIENT_SECRET, APP_BASE_URL
openssl rand -hex 32   # paste into SESSION_SECRET
```

**3. Run**

```bash
npm ci
npm start
```

Or with Docker:

```bash
docker build -t tac-dashboard .
docker run -p 3000:3000 --env-file .env tac-dashboard
```

Open `APP_BASE_URL`, sign in, done.

## TLS on the corporate network

**Symptom:** the browser reaches the Atlassian login page fine, you approve the
app, and then the callback dies with `Sign-in failed`. The server log shows:

```
[oauth] fetch failed <- UNABLE_TO_VERIFY_LEAF_SIGNATURE unable to verify the first certificate
```

**Cause:** the Access4 network terminates and re-signs TLS. Windows, your
browser and `curl` all trust the corporate root CA because it is in the OS
certificate store. **Node does not read that store** — it ships its own bundled
CA list — so the server's back-channel call to `auth.atlassian.com` is the one
leg of the sign-in that fails. Nothing about the browser working tells you the
server can connect.

**Fix:** `--use-system-ca`, which both `npm` scripts now pass. It makes Node
trust the same store Windows does.

This bites containers too, and the flag alone will not save you there: a stock
`node:22-alpine` image has no corporate root in its store. If you deploy inside
the Access4 network, copy the root CA into the image and run
`update-ca-certificates` in the build, or the container will fail exactly the
same way while working perfectly on your laptop.

Confirmed on 28 Aug 2026 — this was the first successful OAuth round-trip
against `auth.atlassian.com`, which CLAUDE.md had flagged as untested.

## Deploying

Any host that runs a Node process works — an internal VM, ECS/Cloud Run, Azure
App Service, Fly.io, Render.

Two things to get right in production:

- **Serve over HTTPS.** Session cookies are marked `secure` automatically when
  `APP_BASE_URL` starts with `https://`.
- **Set `TRUST_PROXY=true`** when running behind a load balancer or reverse
  proxy that terminates TLS, otherwise secure cookies won't be set.

Sessions are held in memory, so restarting signs everyone out and running more
than one replica requires a shared session store (`connect-redis` is a drop-in
for `express-session`). Fine as-is for a single instance.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `ATLASSIAN_CLIENT_ID` | yes | From the developer console |
| `ATLASSIAN_CLIENT_SECRET` | yes | From the developer console |
| `APP_BASE_URL` | yes | Public URL, no trailing slash. The OAuth callback is derived from it |
| `SESSION_SECRET` | yes | 32+ random chars. Changing it signs everyone out |
| `ATLASSIAN_SITE_URL` | no | Pin the site when an account can reach several |
| `JIRA_PROJECT_KEY` | no | Project the proxy may query (default `TAC`) |
| `PORT` | no | Default 3000 |
| `TRUST_PROXY` | no | `true` behind a TLS-terminating proxy |

The app refuses to start if a required variable is missing or if
`SESSION_SECRET` is too short — it will not fall back to serving unauthenticated.

## Layout

```
server.js           OAuth flow, /api/me, /api/search proxy, static serving
views/index.html    The dashboard (served only to signed-in users)
public/login.html   Sign-in page (the only anonymous page)
```

`views/` is deliberately outside the static directory so the app shell is never
served to anonymous visitors.

## Server API

| Route | Auth | Purpose |
|---|---|---|
| `GET /login` | no | Starts the Atlassian OAuth flow |
| `GET /oauth/callback` | no | Completes it; validates `state` as a CSRF guard |
| `GET /logout` | no | Destroys the session |
| `GET /api/me` | yes | Signed-in user's `account_id`, `email`, `name` |
| `POST /api/search` | yes | JQL proxy — `{jql, fields, maxResults, nextPageToken}` |
| `GET /healthz` | no | Liveness probe |

`/api/search` refuses any JQL that doesn't target `JIRA_PROJECT_KEY`. Treat that
as tidiness rather than a security boundary — the real limit is the viewer's own
Jira permissions, since queries run under their token.

## Changing the dashboard

`views/index.html` is self-contained: Chart.js, fonts and all logic are inlined,
with no build step. Edit it and reload.

The triage tiers live in `buildPriorityList()`; SLA field IDs and the third-party
status filter are in the constants block near the top of the `<script>`.

## Known limits

- **Sorting.** "Closest to going overdue" is computed in the browser across all
  six SLA fields, because Jira can't sort by the soonest of several SLAs.
- **Wallboard on a TV.** Point a browser at the app and pick the Wallboard tab.
  The session expires after 12 hours, so a permanently-mounted screen needs
  signing in again roughly daily.
