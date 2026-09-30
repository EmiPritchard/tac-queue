/**
 * Ticket QA storage. SQLite through Node's built-in `node:sqlite`, so there is
 * no dependency to install and the whole store is one file (QA_DB_PATH).
 *
 * WHAT IS STORED, AND WHAT IS NOT. The business rule is "no customer data
 * locally, only the QA information and the ticket ID". So this file holds:
 *
 *   - ticket keys (TAC-1234) and which desk they belong to,
 *   - the agent under review (Jira account id + display name — staff, not
 *     customers) and which TAC Owner field put them there,
 *   - the 12 scores, the critical-fail answer, the reviewer's notes,
 *   - session bookkeeping (period, per-agent count, which keys were drawn).
 *
 * It never sees a summary, description, comment, organisation or requester.
 * Those are fetched live from Jira for the review screen and dropped with the
 * page. Nothing here accepts a field that could carry them, and the free-text
 * fields are the reviewer's own words (the form says not to paste customer
 * details into them).
 *
 * WHY A TICKET IS NEVER DRAWN TWICE. `qa_reviews.issue_key` and
 * `qa_skips.issue_key` are UNIQUE, so the database itself refuses a second QA
 * of the same ticket — the browser's exclusion list is a convenience on top of
 * that, not the guard. Tickets planned into an open baseline are reserved too
 * (see excludedKeys), so a single-agent draw cannot steal one mid-baseline.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { RUBRIC_VERSION, CRITERIA, CRITICAL_FAILS, computeScore } = require('./qa-rubric');

class QaError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const bad = (code, message) => new QaError(400, code, message);

const ACCOUNT_ID_RE = /^[A-Za-z0-9:._-]{1,128}$/;
const ROLE_VALUES = new Set(['1.5', '2.0', '2.5']);
const TEXT_MAX = 2000;
const NAME_MAX = 200;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS qa_sessions (
  id               INTEGER PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('single','baseline')),
  project_key      TEXT NOT NULL,
  range_key        TEXT NOT NULL,
  range_label      TEXT NOT NULL,
  agent_account_id TEXT,              -- single sessions only
  agent_name       TEXT,
  per_agent        INTEGER,           -- baseline sessions only
  shortfall_mode   TEXT,              -- 'cap' | 'exclude' | 'none'
  excluded_agents  TEXT,              -- JSON [{accountId,name,available}] left out of a baseline
  created_at       TEXT NOT NULL,
  ended_at         TEXT
);
CREATE TABLE IF NOT EXISTS qa_session_items (
  session_id       INTEGER NOT NULL REFERENCES qa_sessions(id),
  position         INTEGER NOT NULL,
  issue_key        TEXT NOT NULL,
  agent_account_id TEXT NOT NULL,
  agent_name       TEXT NOT NULL,
  owner_role       TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','reviewed','skipped')),
  PRIMARY KEY (session_id, issue_key)
);
CREATE TABLE IF NOT EXISTS qa_reviews (
  id               INTEGER PRIMARY KEY,
  session_id       INTEGER REFERENCES qa_sessions(id),
  issue_key        TEXT NOT NULL UNIQUE,
  project_key      TEXT NOT NULL,
  agent_account_id TEXT NOT NULL,
  agent_name       TEXT NOT NULL,
  owner_role       TEXT NOT NULL,
  score_pct        REAL,              -- NULL when every criterion was N/A (rubric rule 6)
  applicable       INTEGER NOT NULL,
  critical_fail    INTEGER NOT NULL CHECK (critical_fail IN (0,1)),
  critical_types   TEXT,              -- comma list of CRITICAL_FAILS indexes, 1-based
  critical_reason  TEXT,
  improvement      TEXT NOT NULL,
  rubric_version   TEXT NOT NULL,
  reviewed_at      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS qa_scores (
  review_id        INTEGER NOT NULL REFERENCES qa_reviews(id),
  criterion        INTEGER NOT NULL,
  score            INTEGER CHECK (score IS NULL OR score IN (0,1,2)),  -- NULL = N/A
  PRIMARY KEY (review_id, criterion)
);
CREATE TABLE IF NOT EXISTS qa_skips (
  id               INTEGER PRIMARY KEY,
  session_id       INTEGER REFERENCES qa_sessions(id),
  issue_key        TEXT NOT NULL UNIQUE,
  project_key      TEXT NOT NULL,
  agent_account_id TEXT,
  agent_name       TEXT,
  reason           TEXT NOT NULL,
  skipped_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS qa_reviews_project ON qa_reviews(project_key, reviewed_at);
CREATE INDEX IF NOT EXISTS qa_skips_project   ON qa_skips(project_key);
`;

function openQaStore(dbPath, { issueKeyRe, projectKeys }) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  const now = () => new Date().toISOString();
  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const out = fn(); db.exec('COMMIT'); return out; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  // SQLite reports a UNIQUE violation as a generic error; this is the one we
  // expect (a second QA of the same ticket) and it deserves a clear 409.
  function isUniqueViolation(e) { return /UNIQUE constraint failed/i.test(String(e && e.message)); }

  // ── Validation ─────────────────────────────────────────────────────────────
  function vProject(v) {
    const k = String(v || '').toUpperCase();
    if (!projectKeys.includes(k)) throw bad('bad_project', `Desk must be one of: ${projectKeys.join(', ')}.`);
    return k;
  }
  function vKey(v, project) {
    const k = String(v || '').toUpperCase();
    if (!issueKeyRe.test(k)) throw bad('bad_issue_key', `Not a ticket key this server allows: ${String(v).slice(0, 40)}`);
    if (project && !k.startsWith(project + '-')) throw bad('bad_issue_key', `${k} is not on the ${project} desk.`);
    return k;
  }
  function vAccount(v) {
    const s = String(v || '');
    if (!ACCOUNT_ID_RE.test(s)) throw bad('bad_agent', 'Agent account id is missing or malformed.');
    return s;
  }
  function vName(v, what) {
    const s = String(v || '').trim();
    if (!s || s.length > NAME_MAX) throw bad('bad_name', `${what} is missing or too long.`);
    return s;
  }
  function vRole(v) {
    const parts = String(v || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!parts.length || parts.some(p => !ROLE_VALUES.has(p))) throw bad('bad_role', 'Owner role must be 1.5, 2.0 and/or 2.5.');
    return [...new Set(parts)].sort().join(',');
  }
  function vText(v, what, required) {
    const s = String(v == null ? '' : v).trim();
    if (required && !s) throw bad('text_required', `${what} is required.`);
    if (s.length > TEXT_MAX) throw bad('text_too_long', `${what} is longer than ${TEXT_MAX} characters.`);
    return s;
  }
  function vRangeKey(v) {
    const s = String(v || '');
    if (!/^[A-Za-z0-9]{1,32}$/.test(s)) throw bad('bad_range', 'Unknown period.');
    return s;
  }

  // Rubric rules 1, 3 and 4: every criterion answered, each 0/1/2, N/A only
  // where that criterion's own rule allows it. An incomplete review is refused
  // outright — the rubric says it "produces no score", and a half-filled row
  // sitting in the table would be averaged into a baseline by somebody later.
  function vScores(raw) {
    if (!raw || typeof raw !== 'object') throw bad('scores_required', 'Scores are required.');
    const out = {};
    const missing = [];
    for (const c of CRITERIA) {
      const has = Object.prototype.hasOwnProperty.call(raw, c.id) || Object.prototype.hasOwnProperty.call(raw, String(c.id));
      if (!has) { missing.push(c.id); continue; }
      const v = raw[c.id] ?? raw[String(c.id)];
      if (v === null || v === 'na') {
        if (!c.na) throw bad('na_not_allowed', `Criterion ${c.id} (${c.name}) cannot be marked N/A.`);
        out[c.id] = null;
      } else if (v === 0 || v === 1 || v === 2) {
        out[c.id] = v;
      } else {
        throw bad('bad_score', `Criterion ${c.id} must be 0, 1, 2${c.na ? ' or N/A' : ''}.`);
      }
    }
    if (missing.length) throw bad('review_incomplete', `Criteria not scored: ${missing.join(', ')}.`);
    const extra = Object.keys(raw).filter(k => !CRITERIA.some(c => String(c.id) === String(k)));
    if (extra.length) throw bad('bad_score', `Unknown criteria: ${extra.join(', ')}.`);
    return out;
  }

  function vPlannedItem(it, project) {
    return {
      issueKey: vKey(it && it.issueKey, project),
      agentAccountId: vAccount(it && it.agentAccountId),
      agentName: vName(it && it.agentName, 'Agent name'),
      ownerRole: vRole(it && it.ownerRole),
    };
  }

  // ── Queries ────────────────────────────────────────────────────────────────
  const q = {
    reviewedKeys: db.prepare('SELECT issue_key FROM qa_reviews WHERE project_key = ?'),
    skippedKeys:  db.prepare('SELECT issue_key FROM qa_skips WHERE project_key = ?'),
    reservedKeys: db.prepare(`SELECT i.issue_key FROM qa_session_items i
                              JOIN qa_sessions s ON s.id = i.session_id
                              WHERE s.project_key = ? AND s.ended_at IS NULL AND i.state = 'pending'`),
    sessionById:  db.prepare('SELECT * FROM qa_sessions WHERE id = ?'),
    itemsBySession: db.prepare('SELECT * FROM qa_session_items WHERE session_id = ? ORDER BY position'),
    reviewsBySession: db.prepare('SELECT * FROM qa_reviews WHERE session_id = ? ORDER BY reviewed_at'),
    skipsBySession: db.prepare('SELECT * FROM qa_skips WHERE session_id = ? ORDER BY skipped_at'),
    scoresByReview: db.prepare('SELECT criterion, score FROM qa_scores WHERE review_id = ? ORDER BY criterion'),
    insertSession: db.prepare(`INSERT INTO qa_sessions
      (kind, project_key, range_key, range_label, agent_account_id, agent_name, per_agent, shortfall_mode, excluded_agents, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    insertItem: db.prepare(`INSERT INTO qa_session_items
      (session_id, position, issue_key, agent_account_id, agent_name, owner_role) VALUES (?, ?, ?, ?, ?, ?)`),
    maxPosition: db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM qa_session_items WHERE session_id = ?'),
    itemByKey: db.prepare('SELECT * FROM qa_session_items WHERE session_id = ? AND issue_key = ?'),
    setItemState: db.prepare('UPDATE qa_session_items SET state = ? WHERE session_id = ? AND issue_key = ?'),
    insertReview: db.prepare(`INSERT INTO qa_reviews
      (session_id, issue_key, project_key, agent_account_id, agent_name, owner_role, score_pct, applicable,
       critical_fail, critical_types, critical_reason, improvement, rubric_version, reviewed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    insertScore: db.prepare('INSERT INTO qa_scores (review_id, criterion, score) VALUES (?, ?, ?)'),
    insertSkip: db.prepare(`INSERT INTO qa_skips
      (session_id, issue_key, project_key, agent_account_id, agent_name, reason, skipped_at) VALUES (?, ?, ?, ?, ?, ?, ?)`),
    endSession: db.prepare('UPDATE qa_sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL'),
    listSessions: db.prepare(`SELECT s.*,
        (SELECT COUNT(*) FROM qa_session_items i WHERE i.session_id = s.id) AS planned,
        (SELECT COUNT(*) FROM qa_reviews r WHERE r.session_id = s.id) AS reviewed,
        (SELECT COUNT(*) FROM qa_skips k WHERE k.session_id = s.id) AS skipped
      FROM qa_sessions s WHERE s.project_key = ? ORDER BY s.created_at DESC LIMIT ?`),
    reviewById: db.prepare(`SELECT r.*, s.kind AS session_kind, s.range_label
      FROM qa_reviews r LEFT JOIN qa_sessions s ON s.id = r.session_id WHERE r.id = ?`),
    listReviews: db.prepare(`SELECT r.*, s.kind AS session_kind, s.range_label
      FROM qa_reviews r LEFT JOIN qa_sessions s ON s.id = r.session_id
      WHERE r.project_key = ? ORDER BY r.reviewed_at DESC LIMIT ?`),
    listSkips: db.prepare(`SELECT k.*, s.kind AS session_kind, s.range_label
      FROM qa_skips k LEFT JOIN qa_sessions s ON s.id = k.session_id
      WHERE k.project_key = ? ORDER BY k.skipped_at DESC LIMIT ?`),
  };

  function sessionOrThrow(id) {
    const s = q.sessionById.get(Number(id));
    if (!s) throw new QaError(404, 'session_not_found', 'That QA session does not exist.');
    return s;
  }

  function reviewRow(r) {
    const scores = {};
    for (const s of q.scoresByReview.all(r.id)) scores[s.criterion] = s.score;
    return {
      id: r.id, sessionId: r.session_id, issueKey: r.issue_key, projectKey: r.project_key,
      agentAccountId: r.agent_account_id, agentName: r.agent_name, ownerRole: r.owner_role,
      scorePct: r.score_pct, applicable: r.applicable,
      criticalFail: !!r.critical_fail,
      criticalTypes: r.critical_types ? r.critical_types.split(',').map(Number) : [],
      criticalReason: r.critical_reason || '', improvement: r.improvement,
      rubricVersion: r.rubric_version, reviewedAt: r.reviewed_at,
      sessionKind: r.session_kind || null, rangeLabel: r.range_label || null,
      scores,
    };
  }
  function skipRow(k) {
    return {
      id: k.id, sessionId: k.session_id, issueKey: k.issue_key, projectKey: k.project_key,
      agentAccountId: k.agent_account_id, agentName: k.agent_name, reason: k.reason,
      skippedAt: k.skipped_at, sessionKind: k.session_kind || null, rangeLabel: k.range_label || null,
    };
  }
  function sessionRow(s) {
    return {
      id: s.id, kind: s.kind, projectKey: s.project_key, rangeKey: s.range_key, rangeLabel: s.range_label,
      agentAccountId: s.agent_account_id, agentName: s.agent_name,
      perAgent: s.per_agent, shortfallMode: s.shortfall_mode,
      excludedAgents: s.excluded_agents ? JSON.parse(s.excluded_agents) : [],
      createdAt: s.created_at, endedAt: s.ended_at,
      planned: s.planned, reviewed: s.reviewed, skipped: s.skipped,
    };
  }

  // ── Baseline arithmetic ────────────────────────────────────────────────────
  // Rubric rule 8: the critical-fail rate is reported SEPARATELY and never
  // folded into the average. So `avgPct` is the plain mean of every scored
  // review — a critical-fail review keeps its percentage in it, as rule 7 says
  // ("the percentage is still calculated and kept") — and `criticalFailRate`
  // sits beside it. A review with no score (all N/A) is counted in `reviews`
  // but not in the average's denominator, and `unscored` says how many.
  //
  // Per-criterion averages are on the rubric's own 0–2 scale, over the reviews
  // where that criterion applied. They are what an individual is judged
  // against: "department averages 1.4 on Expectation setting".
  function summarise(reviews) {
    const scored = reviews.filter(r => r.scorePct != null);
    const avgPct = scored.length ? Math.round(scored.reduce((s, r) => s + r.scorePct, 0) / scored.length * 10) / 10 : null;
    const crit = reviews.filter(r => r.criticalFail).length;
    const perCriterion = CRITERIA.map(c => {
      const vals = reviews.map(r => r.scores[c.id]).filter(v => v !== null && v !== undefined);
      return {
        id: c.id, name: c.name, applicable: vals.length,
        na: reviews.length - vals.length,
        avg: vals.length ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length * 100) / 100 : null,
      };
    });
    const byAgent = new Map();
    for (const r of reviews) {
      const e = byAgent.get(r.agentAccountId) || { agentAccountId: r.agentAccountId, agentName: r.agentName, reviews: [] };
      e.reviews.push(r); byAgent.set(r.agentAccountId, e);
    }
    const agents = [...byAgent.values()].map(e => {
      const sc = e.reviews.filter(r => r.scorePct != null);
      return {
        agentAccountId: e.agentAccountId, agentName: e.agentName, reviews: e.reviews.length,
        avgPct: sc.length ? Math.round(sc.reduce((s, r) => s + r.scorePct, 0) / sc.length * 10) / 10 : null,
        criticalFails: e.reviews.filter(r => r.criticalFail).length,
      };
    }).sort((a, b) => a.agentName.localeCompare(b.agentName));
    return {
      reviews: reviews.length, scored: scored.length, unscored: reviews.length - scored.length,
      avgPct, criticalFails: crit,
      criticalFailRate: reviews.length ? Math.round(crit / reviews.length * 1000) / 10 : null,
      perCriterion, agents,
    };
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  return {
    db,

    rubric() {
      return { version: RUBRIC_VERSION, criteria: CRITERIA, criticalFails: CRITICAL_FAILS };
    },

    // Every key that must never be drawn again on this desk, and why.
    excludedKeys(projectKey) {
      const p = vProject(projectKey);
      return {
        reviewed: q.reviewedKeys.all(p).map(r => r.issue_key),
        skipped:  q.skippedKeys.all(p).map(r => r.issue_key),
        reserved: q.reservedKeys.all(p).map(r => r.issue_key),
      };
    },

    createSession(input) {
      const kind = input && input.kind;
      if (kind !== 'single' && kind !== 'baseline') throw bad('bad_kind', 'Session kind must be single or baseline.');
      const project = vProject(input.projectKey);
      const rangeKey = vRangeKey(input.rangeKey);
      const rangeLabel = vName(input.rangeLabel, 'Period label');
      let agentId = null, agentName = null, perAgent = null, shortfall = null, excluded = null;
      let planned = [];
      if (kind === 'single') {
        agentId = vAccount(input.agentAccountId);
        agentName = vName(input.agentName, 'Agent name');
      } else {
        perAgent = Number(input.perAgent);
        if (!Number.isInteger(perAgent) || perAgent < 1 || perAgent > 50) throw bad('bad_per_agent', 'Tickets per agent must be 1–50.');
        shortfall = ['cap', 'exclude', 'none'].includes(input.shortfallMode) ? input.shortfallMode : null;
        if (!shortfall) throw bad('bad_shortfall', 'Shortfall mode must be cap, exclude or none.');
        if (!Array.isArray(input.planned) || !input.planned.length) throw bad('planned_required', 'A baseline needs at least one ticket.');
        if (input.planned.length > 1000) throw bad('planned_too_long', 'A baseline is capped at 1000 tickets.');
        planned = input.planned.map(it => vPlannedItem(it, project));
        const seen = new Set();
        for (const it of planned) {
          if (seen.has(it.issueKey)) throw bad('duplicate_ticket', `${it.issueKey} is planned twice.`);
          seen.add(it.issueKey);
        }
        excluded = JSON.stringify((Array.isArray(input.excludedAgents) ? input.excludedAgents : []).slice(0, 200).map(a => ({
          accountId: vAccount(a && a.accountId), name: vName(a && a.name, 'Agent name'),
          available: Math.max(0, Number(a && a.available) | 0),
        })));
      }
      return tx(() => {
        const ex = this.excludedKeys(project);
        const taken = new Set([...ex.reviewed, ...ex.skipped, ...ex.reserved]);
        const clash = planned.find(it => taken.has(it.issueKey));
        if (clash) throw new QaError(409, 'already_taken', `${clash.issueKey} has already been QA'd, skipped or reserved.`);
        const r = q.insertSession.run(kind, project, rangeKey, rangeLabel, agentId, agentName, perAgent, shortfall, excluded, now());
        const id = Number(r.lastInsertRowid);
        planned.forEach((it, i) => q.insertItem.run(id, i, it.issueKey, it.agentAccountId, it.agentName, it.ownerRole));
        return this.getSession(id);
      });
    },

    getSession(id) {
      const s = sessionOrThrow(id);
      const reviews = q.reviewsBySession.all(s.id).map(reviewRow);
      const skips = q.skipsBySession.all(s.id).map(skipRow);
      const items = q.itemsBySession.all(s.id).map(i => ({
        position: i.position, issueKey: i.issue_key, agentAccountId: i.agent_account_id,
        agentName: i.agent_name, ownerRole: i.owner_role, state: i.state,
      }));
      return {
        session: sessionRow({ ...s, planned: items.length, reviewed: reviews.length, skipped: skips.length }),
        items, reviews, skips, summary: summarise(reviews),
      };
    },

    listSessions(projectKey, limit) {
      const p = vProject(projectKey);
      return q.listSessions.all(p, Math.min(Math.max(Number(limit) || 50, 1), 500)).map(sessionRow);
    },

    endSession(id) {
      sessionOrThrow(id);
      q.endSession.run(now(), Number(id));
      return this.getSession(id);
    },

    saveReview(input) {
      const s = sessionOrThrow(input && input.sessionId);
      if (s.ended_at) throw new QaError(409, 'session_ended', 'That QA session has been ended.');
      const project = vProject(input.projectKey);
      if (project !== s.project_key) throw bad('bad_project', 'The review and its session are on different desks.');
      const issueKey = vKey(input.issueKey, project);
      const scores = vScores(input.scores);
      const critical = input.criticalFail === true;
      if (input.criticalFail !== true && input.criticalFail !== false) {
        throw bad('critical_required', 'Say whether a critical fail occurred (yes or no).');
      }
      let critTypes = '', critReason = '';
      if (critical) {
        const types = [...new Set((Array.isArray(input.criticalTypes) ? input.criticalTypes : []).map(Number))];
        if (!types.length || types.some(t => !Number.isInteger(t) || t < 1 || t > CRITICAL_FAILS.length)) {
          throw bad('critical_type_required', 'Pick which critical fail occurred.');
        }
        critTypes = types.sort((a, b) => a - b).join(',');
        critReason = vText(input.criticalReason, 'The critical-fail reason', true);
      }
      const improvement = vText(input.improvement, '"One thing to improve"', true);
      const { pct, applicable } = computeScore(scores);

      // A baseline review must be one of the tickets the baseline drew, and it
      // is scored for the agent the draw assigned it to. The browser sends
      // that agent too, but the plan is the authority: otherwise a baseline
      // could quietly end up with seven tickets for one person and three for
      // another, which defeats the point of it.
      let agentId, agentName, role;
      if (s.kind === 'baseline') {
        const item = q.itemByKey.get(s.id, issueKey);
        if (!item) throw bad('not_in_session', `${issueKey} is not one of this baseline's tickets.`);
        if (item.state !== 'pending') throw new QaError(409, 'already_done', `${issueKey} has already been ${item.state} in this baseline.`);
        agentId = item.agent_account_id; agentName = item.agent_name; role = item.owner_role;
      } else {
        agentId = vAccount(input.agentAccountId);
        if (agentId !== s.agent_account_id) throw bad('bad_agent', 'This session is for a different agent.');
        agentName = s.agent_name;
        role = vRole(input.ownerRole);
      }

      try {
        return tx(() => {
          const r = q.insertReview.run(s.id, issueKey, project, agentId, agentName, role, pct, applicable,
            critical ? 1 : 0, critTypes || null, critReason || null, improvement, RUBRIC_VERSION, now());
          const reviewId = Number(r.lastInsertRowid);
          for (const c of CRITERIA) q.insertScore.run(reviewId, c.id, scores[c.id]);
          if (s.kind === 'baseline') q.setItemState.run('reviewed', s.id, issueKey);
          return reviewRow(q.reviewById.get(reviewId));
        });
      } catch (e) {
        if (isUniqueViolation(e)) throw new QaError(409, 'already_reviewed', `${issueKey} has already had a QA.`);
        throw e;
      }
    },

    // A ticket that cannot be reviewed (junk, a duplicate, nothing the agent
    // did) is SKIPPED rather than silently re-drawn, with a reason. The rubric
    // says reviewers do not choose their tickets; a recorded skip keeps that
    // honest, and it keeps the ticket out of every future draw. In a baseline
    // the browser then asks for a replacement for the same agent via addItem.
    skipTicket(input) {
      const s = sessionOrThrow(input && input.sessionId);
      if (s.ended_at) throw new QaError(409, 'session_ended', 'That QA session has been ended.');
      const project = vProject(input.projectKey);
      if (project !== s.project_key) throw bad('bad_project', 'The skip and its session are on different desks.');
      const issueKey = vKey(input.issueKey, project);
      const reason = vText(input.reason, 'A skip reason', true);
      let agentId = null, agentName = null;
      if (s.kind === 'baseline') {
        const item = q.itemByKey.get(s.id, issueKey);
        if (!item) throw bad('not_in_session', `${issueKey} is not one of this baseline's tickets.`);
        if (item.state !== 'pending') throw new QaError(409, 'already_done', `${issueKey} has already been ${item.state}.`);
        agentId = item.agent_account_id; agentName = item.agent_name;
      } else {
        agentId = s.agent_account_id; agentName = s.agent_name;
      }
      try {
        return tx(() => {
          q.insertSkip.run(s.id, issueKey, project, agentId, agentName, reason, now());
          if (s.kind === 'baseline') q.setItemState.run('skipped', s.id, issueKey);
          return this.getSession(s.id);
        });
      } catch (e) {
        if (isUniqueViolation(e)) throw new QaError(409, 'already_skipped', `${issueKey} has already been skipped.`);
        throw e;
      }
    },

    // A replacement ticket for a baseline, after a skip. Only for an agent the
    // baseline already covers, and only while that agent is below the
    // per-agent count — so a skip can restore the balance but never tip it.
    // `per_agent` is the count actually drawn (after any cap), not the number
    // first asked for, so this is the right ceiling in both shortfall modes.
    addItem(sessionId, input) {
      const s = sessionOrThrow(sessionId);
      if (s.kind !== 'baseline') throw bad('not_baseline', 'Only a baseline has a ticket list to add to.');
      if (s.ended_at) throw new QaError(409, 'session_ended', 'That QA session has been ended.');
      const it = vPlannedItem(input, s.project_key);
      const items = q.itemsBySession.all(s.id).filter(i => i.agent_account_id === it.agentAccountId);
      if (!items.length) throw bad('agent_not_in_baseline', 'That agent is not part of this baseline.');
      const live = items.filter(i => i.state !== 'skipped').length;
      if (live >= s.per_agent) throw bad('agent_full', `${it.agentName} already has their share of this baseline.`);
      return tx(() => {
        const ex = this.excludedKeys(s.project_key);
        if ([...ex.reviewed, ...ex.skipped, ...ex.reserved].includes(it.issueKey)) {
          throw new QaError(409, 'already_taken', `${it.issueKey} has already been QA'd, skipped or reserved.`);
        }
        const pos = q.maxPosition.get(s.id).p + 1;
        q.insertItem.run(s.id, pos, it.issueKey, it.agentAccountId, it.agentName, it.ownerRole);
        return this.getSession(s.id);
      });
    },

    listHistory(projectKey, limit) {
      const p = vProject(projectKey);
      const n = Math.min(Math.max(Number(limit) || 200, 1), 2000);
      return {
        reviews: q.listReviews.all(p, n).map(reviewRow),
        skips: q.listSkips.all(p, n).map(skipRow),
        sessions: this.listSessions(p, n),
      };
    },

    summarise,
    close() { db.close(); },
  };
}

module.exports = { openQaStore, QaError };
