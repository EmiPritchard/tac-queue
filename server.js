/**
 * Access4 UK TAC — support queue dashboard, standalone web app.
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
  JIRA_PROJECT_KEY = 'TAC',
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
app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const r = await fetch('https://api.atlassian.com/me', {
      headers: { Authorization: `Bearer ${req.session.tokens.accessToken}`, Accept: 'application/json' },
    });
    if (!r.ok) return res.status(r.status).json({ error: 'me_failed' });
    const me = await r.json();
    // Only what the dashboard needs; no need to ship the whole profile.
    res.json({
      account_id: me.account_id,
      email: me.email,
      name: me.name,
      siteUrl: req.session.siteUrl,
      projectKey: JIRA_PROJECT_KEY,
    });
  } catch (e) {
    console.error('[me]', e.message);
    res.status(502).json({ error: 'upstream' });
  }
});

/**
 * Narrow read-only JQL proxy. The project is pinned server-side so a modified
 * front-end cannot widen the query to other Jira projects.
 */
app.post('/api/search', requireAuth, async (req, res) => {
  const { jql, fields, maxResults, nextPageToken } = req.body || {};
  if (typeof jql !== 'string' || !jql.trim()) return res.status(400).json({ error: 'jql_required' });
  if (!new RegExp(`project\\s*=\\s*${JIRA_PROJECT_KEY}\\b`, 'i').test(jql)) {
    return res.status(403).json({ error: 'project_not_allowed', message: `Queries must target project ${JIRA_PROJECT_KEY}.` });
  }
  const body = {
    jql,
    maxResults: Math.min(Number(maxResults) || 100, 100),
    fields: Array.isArray(fields) && fields.length ? fields : ['summary', 'status', 'priority', 'assignee'],
  };
  if (nextPageToken) body.nextPageToken = nextPageToken;

  try {
    const r = await fetch(`https://api.atlassian.com/ex/jira/${req.session.cloudId}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${req.session.tokens.accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await r.text();
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
