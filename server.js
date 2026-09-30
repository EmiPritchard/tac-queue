/**
 * Access4 TAC — support queue dashboard, standalone web app.
 *
 * Serves both TAC service desks: the UK queue (project TAC) and the ANZ queue
 * (project TAPC). Which desk is shown is a browser-side choice and every
 * query carries its key; this process only decides which keys are ALLOWED.
 *
 * Why a server exists at all: a browser cannot call the Jira API directly
 * (CORS blocks it), and putting a Jira token in front-end code would hand it
 * to anyone who opens View Source. So this process holds the credentials and
 * proxies a narrow, read-only slice of the Jira API.
 *
 * Auth model: Atlassian OAuth 2.0 (3LO). Each viewer signs in with their OWN
 * Atlassian account and every Jira call runs as them. That means:
 *   - no shared service-account token to leak or rotate,
 *   - Jira's own permission scheme decides what each person can see,
 *   - "Personal mode" reflects a real identity rather than a browser toggle.
 * Viewers need a Jira account. They do not need Claude.
 */
const express = require('express');
const session = require('express-session');
const crypto  = require('crypto');
const path    = require('path');

const {
  ATLASSIAN_CLIENT_ID,
  ATLASSIAN_CLIENT_SECRET,
  APP_BASE_URL,
  SESSION_SECRET,
  JIRA_PROJECT_KEYS,
  JIRA_PROJECT_KEY,          // legacy single-desk name, still honoured below
  PORT = 3000,
  TRUST_PROXY = 'false',
} = process.env;

// Fail loudly at boot rather than serving an unauthenticated dashboard.
const missing = Object.entries({
  ATLASSIAN_CLIENT_ID, ATLASSIAN_CLIENT_SECRET, APP_BASE_URL, SESSION_SECRET,
}).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error('Refusing to start. Missing required environment variables:\n  ' + missing.join('\n  '));
  console.error('\nCopy .env.example to .env and fill it in. See README.md.');
  process.exit(1);
}
if (SESSION_SECRET.length < 32) {
  console.error('SESSION_SECRET must be at least 32 characters. Generate one with:\n  openssl rand -hex 32');
  process.exit(1);
}

// ── The project pin ──────────────────────────────────────────────────────────
// The dashboard switches between service desks (UK = TAC, ANZ = TAPC), so the
// pin is a LIST rather than one key. Everything the browser can ask for is
// checked against it: a modified front-end must not be able to read — or
// count — issues in any other Jira project.
//
// Keys are validated against Jira's own key shape before use, because they
// are interpolated into the RegExps below. A stray '(' or '.' arriving from
// an env var would otherwise either crash at boot or, far worse, widen the
// guard without anyone noticing.
const PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]{0,9}$/;
const PROJECT_KEYS = String(JIRA_PROJECT_KEYS || JIRA_PROJECT_KEY || 'TAC,TAPC')
  .split(',').map(k => k.trim().toUpperCase()).filter(Boolean);
const badProjectKeys = PROJECT_KEYS.filter(k => !PROJECT_KEY_RE.test(k));
if (!PROJECT_KEYS.length || badProjectKeys.length) {
  console.error('Refusing to start. JIRA_PROJECT_KEYS must be a comma-separated list of Jira '
    + 'project keys' + (badProjectKeys.length ? `; rejected: ${badProjectKeys.join(', ')}` : '') + '.');
  process.exit(1);
}
// A .env written before the ANZ desk existed pins JIRA_PROJECT_KEY=TAC, which
// silently blocks the other desk — the switcher would 403 on every query it
// makes. Say so at boot rather than leaving it to look like a Jira permission
// problem in the browser.
if (!JIRA_PROJECT_KEYS && JIRA_PROJECT_KEY) {
  console.warn(`[config] JIRA_PROJECT_KEY is deprecated. Using JIRA_PROJECT_KEYS=${PROJECT_KEYS.join(',')}`);
  console.warn('[config] Only those desks will load. Set JIRA_PROJECT_KEYS=TAC,TAPC for both UK and ANZ.');
}
const PROJECT_KEYS_LABEL = PROJECT_KEYS.join(', ');

// Built once, from validated keys. The trailing \b is what stops a prefix
// match: with keys TAC and TAPC, `project = TACPC` matches neither, because
// the character after the key has to be a non-word one.
const JQL_PROJECT_RE = new RegExp(`project\\s*=\\s*(?:${PROJECT_KEYS.join('|')})\\b`, 'i');

// ONE implementation, shared by /api/search and /api/count. This used to be a
// copy-pasted RegExp per route, and the /api/count copy was written inside a
// template literal WITHOUT escaping its backslashes — `\s` in a template
// literal is just `s`, so that guard compiled to /projects*=s*TACb/ and could
// never match anything. Every /api/count call 403'd, which the Closed list's
// pager surfaces only as a missing "of N" label. Do not reintroduce a copy.
function jqlProjectAllowed(jql) { return JQL_PROJECT_RE.test(jql); }
function sendProjectPinError(res) {
  return res.status(403).json({
    error: 'project_not_allowed',
    message: `Queries must target one of: ${PROJECT_KEYS_LABEL}.`,
  });
}

const REDIRECT_URI = new URL('/oauth/callback', APP_BASE_URL).toString();
const SCOPES = 'read:jira-work read:jira-user offline_access';

const app = express();
if (TRUST_PROXY === 'true') app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));
app.use(session({
  name: 'tac.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: APP_BASE_URL.startsWith('https://'),
    maxAge: 12 * 60 * 60 * 1000, // 12h
  },
}));

// Flatten an Error and its .cause chain into one line. Node's fetch() surfaces
// DNS failures, refused connections and TLS-trust problems all as the single
// word "fetch failed", with the actual code (ENOTFOUND, ECONNREFUSED,
// UNABLE_TO_VERIFY_LEAF_SIGNATURE, ...) buried in .cause.
function causeChain(err) {
  const parts = [];
  for (let e = err, i = 0; e && i < 5; e = e.cause, i++) {
    parts.push([e.code, e.message].filter(Boolean).join(' '));
  }
  return parts.join(' <- ');
}

// ── Timing ───────────────────────────────────────────────────────────────────
// The question this exists to answer: when the dashboard feels slow, is JIRA
// slow, is THIS PROCESS slow, or is the BROWSER slow? Nothing in the app could
// tell them apart before, because the browser only ever sees one number — how
// long /api/search took — and that is Jira's time plus ours plus the network
// in between plus JSON parsing at both ends.
//
// So every upstream call is timed here, and the figure goes back on the
// response two ways:
//   Server-Timing: jira;dur=N   a real header browsers understand — it shows
//                               up in devtools' Network > Timing tab unaided
//   X-Upstream-Ms: N            the same number, for the front end's own log
//
// The browser subtracts it from its own measurement; what is left is this
// process plus the network. See perfReport() in views/index.html.
//
// `bytes` and `issues` are logged too because they are the other half of the
// story: /rest/api/3/search/jql SHRINKS pages when many fields are requested
// (LIVE_FIELDS asks for 14), so a "100 per page" query can come back with 25 —
// which turns one round trip into four. That is invisible without this log.
const PERF_LOG_MAX = 500;
const perfLog = [];

function fmtBytes(n) {
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB';
  return (n / 1024 / 1024).toFixed(2) + 'MB';
}

function recordPerf(entry) {
  perfLog.push(entry);
  if (perfLog.length > PERF_LOG_MAX) perfLog.shift();
  console.log(
    `[perf] ${entry.label.padEnd(9)} ${String(entry.ms).padStart(6)}ms  ${entry.status}  `
    + `${fmtBytes(entry.bytes).padStart(8)}`
    + (entry.issues != null ? `  ${entry.issues} issues` : '')
    + (entry.detail ? `  ${entry.detail}` : '')
  );
}

// Every upstream Jira call goes through here. Returns the response, its body
// as text (read once — a Response body cannot be consumed twice) and the
// round-trip time in whole milliseconds.
async function timedFetch(label, url, init, detail) {
  const t0 = process.hrtime.bigint();
  const r = await fetch(url, init);
  const text = await r.text();
  const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  // Issue count is the cheapest useful signal about page shrinking. Parsing
  // the body again costs a millisecond or two against a network call of
  // hundreds, and a malformed body must not break the request it belongs to.
  let issues = null;
  try {
    const j = JSON.parse(text);
    if (Array.isArray(j.issues)) issues = j.issues.length;
    else if (Array.isArray(j.values)) issues = j.values.length;
  } catch (e) {}
  recordPerf({
    at: new Date().toISOString(), label, ms, status: r.status,
    bytes: Buffer.byteLength(text), issues, detail: detail || '',
  });
  return { r, text, ms };
}

// Server-Timing is standard and needs no tooling to read; X-Upstream-Ms is the
// same figure in a form the front end can pull off the response without
// parsing the header grammar. Both are same-origin here, so no CORS expose
// header is needed.
function sendUpstreamTiming(res, ms, label) {
  res.set('Server-Timing', `jira;dur=${ms};desc="${label}"`);
  res.set('X-Upstream-Ms', String(ms));
}

// ── Token handling ───────────────────────────────────────────────────────────
function tokenExpired(s) { return !s.tokens || Date.now() > (s.tokens.expiresAt - 60_000); }

async function refreshTokens(req) {
  const rt = req.session.tokens?.refreshToken;
  if (!rt) return false;
  const r = await fetch('https://auth.atlassian.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: ATLASSIAN_CLIENT_ID,
      client_secret: ATLASSIAN_CLIENT_SECRET,
      refresh_token: rt,
    }),
  });
  if (!r.ok) return false;
  const t = await r.json();
  req.session.tokens = {
    accessToken: t.access_token,
    refreshToken: t.refresh_token || rt,
    expiresAt: Date.now() + (t.expires_in * 1000),
  };
  return true;
}

async function requireAuth(req, res, next) {
  if (!req.session.tokens) return res.status(401).json({ error: 'not_authenticated' });
  if (tokenExpired(req.session)) {
    const ok = await refreshTokens(req).catch(() => false);
    if (!ok) { req.session.destroy(() => {}); return res.status(401).json({ error: 'session_expired' }); }
  }
  next();
}

// ── OAuth flow ───────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  const u = new URL('https://auth.atlassian.com/authorize');
  u.searchParams.set('audience', 'api.atlassian.com');
  u.searchParams.set('client_id', ATLASSIAN_CLIENT_ID);
  u.searchParams.set('scope', SCOPES);
  u.searchParams.set('redirect_uri', REDIRECT_URI);
  u.searchParams.set('state', state);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('prompt', 'consent');
  res.redirect(u.toString());
});

app.get('/oauth/callback', async (req, res) => {
  const { code, state } = req.query;
  // Reject a mismatched state: this is the CSRF guard on the callback.
  if (!code || !state || state !== req.session.oauthState) {
    return res.status(400).send('Sign-in failed: invalid state. <a href="/login">Try again</a>.');
  }
  delete req.session.oauthState;
  try {
    const tr = await fetch('https://auth.atlassian.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: ATLASSIAN_CLIENT_ID,
        client_secret: ATLASSIAN_CLIENT_SECRET,
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });
    if (!tr.ok) throw new Error('token exchange failed: ' + tr.status);
    const t = await tr.json();
    req.session.tokens = {
      accessToken: t.access_token,
      refreshToken: t.refresh_token,
      expiresAt: Date.now() + (t.expires_in * 1000),
    };

    // Resolve which Jira site this token can reach.
    const rr = await fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
      headers: { Authorization: `Bearer ${t.access_token}`, Accept: 'application/json' },
    });
    const sites = await rr.json();
    if (!Array.isArray(sites) || !sites.length) throw new Error('no accessible Atlassian sites');
    const preferred = process.env.ATLASSIAN_SITE_URL;
    const site = (preferred && sites.find(s => s.url === preferred)) || sites[0];
    req.session.cloudId = site.id;
    req.session.siteUrl = site.url;

    res.redirect('/');
  } catch (err) {
    // fetch() reports every network/TLS problem as the useless "fetch failed"
    // and hides the real reason in err.cause. Walk the chain, or you cannot
    // tell a DNS miss from a corporate TLS proxy from a refused connection.
    console.error('[oauth]', causeChain(err));
    res.status(500).send('Sign-in failed. <a href="/login">Try again</a>. (Details in the server log.)');
  }
});

app.get('/logout', (req, res) => { req.session.destroy(() => res.redirect('/')); });

// ── API ──────────────────────────────────────────────────────────────────────
/**
 * Which Atlassian site this session reaches, and which desks this process
 * allows. Both are already known here; nothing upstream is asked.
 *
 * This used to call https://api.atlassian.com/me first and forward the
 * viewer's account_id / email / name. That call was doing harm and no work:
 *
 *   - Nothing reads those three fields. Personal mode was removed on
 *     17 Sep 2026 and took the only consumer with it; loadIdentity() has read
 *     `siteUrl` and nothing else ever since.
 *   - /me requires the `read:me` scope, which SCOPES has never requested, so
 *     it could only ever 403.
 *   - The route returned early on a bad upstream response, so that 403 threw
 *     away `siteUrl` TOO — and `siteUrl` never came from /me in the first
 *     place. Every ticket's browse link silently fell back to the front end's
 *     hardcoded site.
 *
 * Found 18 Sep 2026 in the timing log (section 9a), where it showed as a
 * 21-byte 403 costing 144ms on every page load. The failure was invisible
 * because boot does `loadIdentity().catch(() => {})` — by design, since a
 * wrong browse link is not worth blocking the dashboard over.
 *
 * `siteUrl` is resolved once at /oauth/callback from accessible-resources and
 * kept on the session. If a viewer's identity is ever needed again, add
 * `read:me` to SCOPES — but note that changes the consent screen, so every
 * existing session has to re-authorise.
 *
 * Still behind requireAuth, so it still works as the session probe the front
 * end uses it for. Better than before, in fact: a dead session no longer reads
 * the same as a missing scope.
 */
app.get('/api/me', requireAuth, (req, res) => {
  res.json({ siteUrl: req.session.siteUrl, projectKeys: PROJECT_KEYS });
});

/**
 * Narrow read-only JQL proxy. The projects are pinned server-side so a
 * modified front-end cannot widen the query to other Jira projects.
 */
app.post('/api/search', requireAuth, async (req, res) => {
  const { jql, fields, maxResults, nextPageToken } = req.body || {};
  if (typeof jql !== 'string' || !jql.trim()) return res.status(400).json({ error: 'jql_required' });
  if (!jqlProjectAllowed(jql)) return sendProjectPinError(res);
  const body = {
    jql,
    maxResults: Math.min(Number(maxResults) || 100, 100),
    fields: Array.isArray(fields) && fields.length ? fields : ['summary', 'status', 'priority', 'assignee'],
  };
  if (nextPageToken) body.nextPageToken = nextPageToken;

  try {
    const { r, text, ms } = await timedFetch(
      'search',
      `https://api.atlassian.com/ex/jira/${req.session.cloudId}/rest/api/3/search/jql`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${req.session.tokens.accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      },
      // The two things that decide how many round trips a "single" query
      // costs: how many fields were asked for (Jira shrinks pages as this
      // grows) and whether this is a continuation.
      `${body.fields.length}f ${nextPageToken ? 'page2+' : 'page1'} ${jql.slice(0, 60)}`
    );
    sendUpstreamTiming(res, ms, 'search');
    if (!r.ok) {
      console.error('[search]', r.status, text.slice(0, 300));
      return res.status(r.status).json({ error: 'jira_error', status: r.status, message: text.slice(0, 300) });
    }
    res.type('application/json').send(text);
  } catch (e) {
    console.error('[search]', e.message);
    res.status(502).json({ error: 'upstream', message: e.message });
  }
});


/**
 * Approximate issue count for a JQL query. /rest/api/3/search/jql (what
 * /api/search proxies) deliberately returns NO total — only a nextPageToken —
 * so there is no way to say "showing 100 of 5227" from a page of results
 * alone. This is the endpoint Jira provides for that number.
 *
 * "Approximate" is Jira's own word: the count comes from the search index and
 * can lag a moment behind a just-resolved ticket. That is fine for a pager
 * label and it is the only cheap answer — the alternative is walking every
 * page, which is exactly what the Closed list's pager exists to avoid (the
 * Apr–Jun 2026 migration bulk-close puts 5,227 tickets in one quarter).
 *
 * Callers must treat a failure here as non-fatal: the Closed list falls back
 * to "N loaded, more available" and stays usable.
 */
app.post('/api/count', requireAuth, async (req, res) => {
  const { jql } = req.body || {};
  if (typeof jql !== 'string' || !jql.trim()) return res.status(400).json({ error: 'jql_required' });
  // Same project pin as /api/search — a modified front-end must not be able to
  // probe how many issues exist in other projects either.
  if (!jqlProjectAllowed(jql)) return sendProjectPinError(res);
  try {
    const { r, text, ms } = await timedFetch(
      'count',
      `https://api.atlassian.com/ex/jira/${req.session.cloudId}/rest/api/3/search/approximate-count`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${req.session.tokens.accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ jql }),
      },
      jql.slice(0, 60)
    );
    sendUpstreamTiming(res, ms, 'count');
    if (!r.ok) {
      console.error('[count]', r.status, text.slice(0, 300));
      return res.status(r.status).json({ error: 'jira_error', status: r.status, message: text.slice(0, 300) });
    }
    res.type('application/json').send(text);
  } catch (e) {
    console.error('[count]', e.message);
    res.status(502).json({ error: 'upstream', message: e.message });
  }
});

/**
 * What the upstream Jira calls actually cost. Read-only, per-process and
 * in-memory (last PERF_LOG_MAX calls) — it is a diagnostic, not a metric
 * store, and it is deliberately behind requireAuth because the JQL fragments
 * in it describe the queue.
 *
 * `?label=search` narrows to one kind of call. The summary block is the part
 * worth reading: p50/p95 per label, and total bytes, which is what tells you
 * whether a slow load is one slow call or thirty quick ones.
 */
app.get('/api/perf', requireAuth, (req, res) => {
  const want = req.query.label ? String(req.query.label) : null;
  const calls = want ? perfLog.filter(e => e.label === want) : perfLog.slice();
  const byLabel = {};
  for (const e of calls) (byLabel[e.label] ||= []).push(e);
  const pct = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : null;
  const summary = Object.entries(byLabel).map(([label, es]) => {
    const ms = es.map(e => e.ms).sort((a, b) => a - b);
    return {
      label,
      calls: es.length,
      totalMs: ms.reduce((a, b) => a + b, 0),
      minMs: ms[0], p50Ms: pct(ms, 0.5), p95Ms: pct(ms, 0.95), maxMs: ms[ms.length - 1],
      totalBytes: es.reduce((a, e) => a + e.bytes, 0),
      totalIssues: es.reduce((a, e) => a + (e.issues || 0), 0),
      errors: es.filter(e => e.status >= 400).length,
    };
  }).sort((a, b) => b.totalMs - a.totalMs);
  res.json({ since: calls[0]?.at || null, retained: perfLog.length, summary, calls });
});

// Single-issue read, for the ticket detail timeline. Two routes rather than
// one because Jira splits the data that way:
//
//   /api/issue/:key            the issue plus the first page of its changelog
//   /api/issue/:key/changelog  the rest of it, when there is more
//
// `expand=changelog` inlines at most 100 history entries and reports the real
// figure in `changelog.total`, so anything longer has to be walked through the
// dedicated endpoint. The split mirrors /api/search + jiraSearch(): the server
// stays a thin proxy and the browser does the paging.
//
// The project pin here is a key-shape check rather than a JQL check, over
// the same PROJECT_KEYS list. Note it blocks the OTHER projects that show up
// as linked issues (ESD, DEVX, ...): the timeline is for TAC tickets, and
// those keys already link out to Jira.
const ISSUE_KEY_RE = new RegExp(`^(?:${PROJECT_KEYS.join('|')})-\\d{1,10}$`, 'i');

// Everything the timeline reads. Wider than the list queries because it is one
// issue, not a page of them — so page-shrinking does not apply. The three
// "N.N TAC Owner" fields are the ones that make "when owners changed hands"
// answerable: they are separate from `assignee` and are what the TAC workflow
// actually moves between people.
//
// `description` is here for the Ticket QA tab, whose review screen needs the
// customer's original request next to the comments. It is displayed only —
// nothing server-side keeps it (see qa-store.js on what is stored).
const DETAIL_FIELDS = [
  'summary', 'description', 'status', 'priority', 'issuetype', 'assignee', 'reporter',
  'created', 'updated', 'resolutiondate', 'resolution', 'issuelinks',
  'customfield_10874',                                        // TAC Tier
  'customfield_10859', 'customfield_10860', 'customfield_10861', // 1.5/2.0/2.5 TAC Owner
  'customfield_10002', 'customfield_10854',                   // organisation, product
  'customfield_10967', 'customfield_10968', 'customfield_10969',
  'customfield_10970', 'customfield_10879', 'customfield_10906', // the six SLAs
].join(',');

async function jiraGet(req, res, path, label) {
  try {
    const { r, text, ms } = await timedFetch(
      label,
      `https://api.atlassian.com/ex/jira/${req.session.cloudId}/rest/api/3/${path}`,
      {
        headers: {
          Authorization: `Bearer ${req.session.tokens.accessToken}`,
          Accept: 'application/json',
        },
      },
      path.split('?')[0]
    );
    sendUpstreamTiming(res, ms, label);
    if (!r.ok) {
      console.error(`[${label}]`, r.status, text.slice(0, 300));
      return res.status(r.status).json({ error: 'jira_error', status: r.status, message: text.slice(0, 300) });
    }
    res.type('application/json').send(text);
  } catch (e) {
    console.error(`[${label}]`, e.message);
    res.status(502).json({ error: 'upstream', message: e.message });
  }
}

app.get('/api/issue/:key', requireAuth, async (req, res) => {
  const key = String(req.params.key || '');
  if (!ISSUE_KEY_RE.test(key)) {
    return res.status(403).json({ error: 'issue_not_allowed', message: `Only ${PROJECT_KEYS_LABEL} issues can be read.` });
  }
  await jiraGet(req, res,
    `issue/${encodeURIComponent(key)}?expand=changelog&fields=${DETAIL_FIELDS}`, 'issue');
});

app.get('/api/issue/:key/changelog', requireAuth, async (req, res) => {
  const key = String(req.params.key || '');
  if (!ISSUE_KEY_RE.test(key)) {
    return res.status(403).json({ error: 'issue_not_allowed', message: `Only ${PROJECT_KEYS_LABEL} issues can be read.` });
  }
  const startAt = Math.max(0, Number(req.query.startAt) || 0);
  await jiraGet(req, res,
    `issue/${encodeURIComponent(key)}/changelog?startAt=${startAt}&maxResults=100`, 'changelog');
});

// Comments, for the Ticket QA review screen: most of the rubric (notes,
// clarity, expectation setting, tone, confidence, closure) can only be judged
// by reading them. Paged like the changelog, and for the same reason — the
// browser walks `startAt` until it has `total`.
//
// On a Service Management issue each comment carries `jsdPublic`: true for a
// reply the customer saw, false for an internal note. The QA screen splits on
// it, since "customer communication" and "internal documentation" are scored
// separately. Passed straight through; this route stores nothing.
app.get('/api/issue/:key/comment', requireAuth, async (req, res) => {
  const key = String(req.params.key || '');
  if (!ISSUE_KEY_RE.test(key)) {
    return res.status(403).json({ error: 'issue_not_allowed', message: `Only ${PROJECT_KEYS_LABEL} issues can be read.` });
  }
  const startAt = Math.max(0, Number(req.query.startAt) || 0);
  await jiraGet(req, res,
    `issue/${encodeURIComponent(key)}/comment?startAt=${startAt}&maxResults=100&orderBy=created`, 'comment');
});

// ── Ticket QA ────────────────────────────────────────────────────────────────
// The one place this app WRITES anything, and it writes to its own SQLite
// file, never to Jira. See qa-store.js for what is kept (ticket keys and QA
// answers) and, more to the point, what is not (any customer data).
//
// Every route is behind requireAuth like the rest of the API. There is no
// per-reviewer identity — SCOPES has no `read:me`, by the business's choice on
// 24 Sep 2026 — so any signed-in viewer can run and read QA sessions.
const { openQaStore, QaError } = require('./qa-store');
const QA_DB_PATH = process.env.QA_DB_PATH || path.join(__dirname, 'data', 'qa.sqlite');
const qaStore = openQaStore(QA_DB_PATH, { issueKeyRe: ISSUE_KEY_RE, projectKeys: PROJECT_KEYS });
console.log(`[qa] store at ${QA_DB_PATH === ':memory:' ? ':memory:' : path.resolve(QA_DB_PATH)}`);

function qaRoute(fn) {
  return (req, res) => {
    try { res.json(fn(req)); }
    catch (e) {
      if (e instanceof QaError) return res.status(e.status).json({ error: e.code, message: e.message });
      console.error('[qa]', e);
      res.status(500).json({ error: 'qa_failed', message: 'The QA store failed. Details are in the server log.' });
    }
  };
}

app.get('/api/qa/rubric', requireAuth, qaRoute(() => qaStore.rubric()));
app.get('/api/qa/excluded', requireAuth, qaRoute(req => qaStore.excludedKeys(req.query.project)));
app.get('/api/qa/history', requireAuth, qaRoute(req => qaStore.listHistory(req.query.project, req.query.limit)));
app.post('/api/qa/sessions', requireAuth, qaRoute(req => qaStore.createSession(req.body || {})));
app.get('/api/qa/sessions/:id', requireAuth, qaRoute(req => qaStore.getSession(req.params.id)));
app.post('/api/qa/sessions/:id/end', requireAuth, qaRoute(req => qaStore.endSession(req.params.id)));
app.post('/api/qa/sessions/:id/items', requireAuth, qaRoute(req => qaStore.addItem(req.params.id, req.body || {})));
app.post('/api/qa/reviews', requireAuth, qaRoute(req => qaStore.saveReview(req.body || {})));
app.post('/api/qa/skips', requireAuth, qaRoute(req => qaStore.skipTicket(req.body || {})));

// ── Product Skills Matrix ────────────────────────────────────────────────────
// The team's skills matrix, formerly a spreadsheet. Its own SQLite file; no
// Jira call at all. People are the matrix's own list, not Jira users. Same
// access model as Ticket QA: any signed-in viewer can read and edit, and no
// editor identity is recorded (SCOPES has no `read:me`). See skills-store.js.
const { openSkillsStore, SkillsError } = require('./skills-store');
const SKILLS_DB_PATH = process.env.SKILLS_DB_PATH || path.join(__dirname, 'data', 'skills.sqlite');
const skillsStore = openSkillsStore(SKILLS_DB_PATH);
console.log(`[skills] store at ${SKILLS_DB_PATH === ':memory:' ? ':memory:' : path.resolve(SKILLS_DB_PATH)}`);

function skillsRoute(fn) {
  return (req, res) => {
    try { res.json(fn(req)); }
    catch (e) {
      if (e instanceof SkillsError) return res.status(e.status).json({ error: e.code, message: e.message });
      console.error('[skills]', e);
      res.status(500).json({ error: 'skills_failed', message: 'The skills store failed. Details are in the server log.' });
    }
  };
}
const archivedFlag = body => !!(body && body.archived);

app.get('/api/skills', requireAuth, skillsRoute(() => skillsStore.state()));
app.get('/api/skills/history', requireAuth, skillsRoute(req => skillsStore.history(req.query.limit)));
app.post('/api/skills/ratings', requireAuth, skillsRoute(req => skillsStore.changeRating(req.body || {})));
app.post('/api/skills/baseline', requireAuth, skillsRoute(req => skillsStore.setBaseline(req.body || {})));
app.post('/api/skills/people', requireAuth, skillsRoute(req => skillsStore.addPerson(req.body || {})));
app.post('/api/skills/people/:id/archive', requireAuth, skillsRoute(req => skillsStore.setPersonArchived(req.params.id, archivedFlag(req.body))));
app.post('/api/skills/products', requireAuth, skillsRoute(req => skillsStore.addProduct(req.body || {})));
app.post('/api/skills/products/:id/archive', requireAuth, skillsRoute(req => skillsStore.setProductArchived(req.params.id, archivedFlag(req.body))));

// ── Static app ───────────────────────────────────────────────────────────────
// public/ holds only what an anonymous visitor may see (the sign-in page).
// The dashboard shell lives outside it so it is never served statically.
app.use(express.static(path.join(__dirname, 'public'), { index: false, maxAge: '1h' }));

app.get('/', (req, res) => {
  if (!req.session.tokens) return res.sendFile(path.join(__dirname, 'public', 'login.html'));
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`TAC dashboard listening on ${PORT}`);
  console.log(`Base URL: ${APP_BASE_URL}`);
  console.log(`Callback to register in the Atlassian console: ${REDIRECT_URI}`);
});
