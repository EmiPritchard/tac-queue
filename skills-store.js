/**
 * Product Skills Matrix storage. SQLite through Node's built-in `node:sqlite`,
 * one file at SKILLS_DB_PATH — the same approach as the Ticket QA store, kept
 * in a file of its own so neither feature can damage the other's data.
 *
 * It replaces the "UK Product Skills Matrix" spreadsheet, whose three sheets
 * map onto this store directly:
 *
 *   Sheet1   → skills_ratings   the matrix as it stands now
 *   Changes  → skills_changes   every change to the matrix, with where it was
 *                                confirmed (e.g. "Teams Message") and its date
 *   Baseline → skills_baseline  where each rating was first set
 *
 * PEOPLE ARE THE MATRIX'S OWN LIST, NOT JIRA'S. Deliberately — the business's
 * rule on 25 Sep 2026. A person is just a name here; nothing links them to a
 * Jira account.
 *
 * TWO DIFFERENT EDIT RULES, both the business's:
 *   - A matrix change must say where it was confirmed, and is recorded in
 *     skills_changes. `from` must match the stored value, so two people editing
 *     the same cell at once get a 409 rather than one silently overwriting the
 *     other (and the history reading a transition that never happened).
 *   - A baseline edit is NOT recorded. The baseline is a reference point that
 *     is being corrected, not a skill that changed.
 *
 * ARCHIVE, NEVER DELETE. People and products can be archived (hidden from the
 * matrix) and restored; their ratings and history are kept either way, so a
 * restore brings back exactly what was there and History never loses rows.
 *
 * UK ONLY. The matrix is one team's, and the business chose on 25 Sep 2026
 * that the tab shows it on either desk rather than keeping one per desk — so
 * nothing here is keyed by project.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

class SkillsError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const bad = (code, message) => new SkillsError(400, code, message);

// The rating scale, from the spreadsheet's own key. The only copy — the page
// renders its legend and cell tooltips from GET /api/skills.
const SKILL_LEVELS = [
  { level: 0, text: "I don't know what this product does. I have heard it's name and not much else. At most I can pinpoint what pillar it belongs to." },
  { level: 1, text: "I have a basic understanding of the product and it's role in our portfolio, but I would not know where to start provisioing or troubleshooting." },
  { level: 2, text: "I can provision a basic setup of this product, I understand most of the main features, I can't troubleshoot the product very well." },
  { level: 3, text: 'I am quite comfortable provisioning the product and I understand a lot of the features. I can troubleshoot basic faults and understand all the tools available for troubleshooting.' },
  { level: 4, text: 'I can provision almost any system asked of me, I can troubleshooting intermediate faults, I am very comfortable with most questions about the product.' },
  { level: 5, text: "I am an expert on the product. I understand everything it is capable of and can troubleshoot any fault. I can answer complex questions about the product and am confident in it's capabilities and limitations." },
];
const MIN_LEVEL = 0, MAX_LEVEL = 5;
const NAME_MAX = 80;
const CONFIRMED_MAX = 200;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS skills_people (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  position    INTEGER NOT NULL,
  archived_at TEXT,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS skills_products (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  position    INTEGER NOT NULL,
  archived_at TEXT,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS skills_ratings (
  person_id   INTEGER NOT NULL REFERENCES skills_people(id),
  product_id  INTEGER NOT NULL REFERENCES skills_products(id),
  rating      INTEGER NOT NULL CHECK (rating BETWEEN 0 AND 5),
  PRIMARY KEY (person_id, product_id)
);
CREATE TABLE IF NOT EXISTS skills_baseline (
  person_id   INTEGER NOT NULL REFERENCES skills_people(id),
  product_id  INTEGER NOT NULL REFERENCES skills_products(id),
  rating      INTEGER NOT NULL CHECK (rating BETWEEN 0 AND 5),
  PRIMARY KEY (person_id, product_id)
);
-- Names are copied onto each change as well as the ids, so the history reads
-- the way it did when it was written whatever later happens to the person or
-- product row.
CREATE TABLE IF NOT EXISTS skills_changes (
  id           INTEGER PRIMARY KEY,
  person_id    INTEGER NOT NULL REFERENCES skills_people(id),
  product_id   INTEGER NOT NULL REFERENCES skills_products(id),
  person_name  TEXT NOT NULL,
  product_name TEXT NOT NULL,
  old_rating   INTEGER NOT NULL CHECK (old_rating BETWEEN 0 AND 5),
  new_rating   INTEGER NOT NULL CHECK (new_rating BETWEEN 0 AND 5),
  confirmed    TEXT NOT NULL,
  changed_on   TEXT NOT NULL,          -- YYYY-MM-DD, the date the change was confirmed
  recorded_at  TEXT NOT NULL           -- when it was entered here
);
CREATE INDEX IF NOT EXISTS skills_changes_order ON skills_changes(changed_on, id);
`;

function openSkillsStore(dbPath) {
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
  function isUniqueViolation(e) { return /UNIQUE constraint failed/i.test(String(e && e.message)); }

  const q = {
    people:        db.prepare('SELECT id, name, position, archived_at FROM skills_people ORDER BY position, id'),
    products:      db.prepare('SELECT id, name, position, archived_at FROM skills_products ORDER BY position, id'),
    ratings:       db.prepare('SELECT person_id, product_id, rating FROM skills_ratings'),
    baseline:      db.prepare('SELECT person_id, product_id, rating FROM skills_baseline'),
    person:        db.prepare('SELECT id, name, archived_at FROM skills_people WHERE id = ?'),
    product:       db.prepare('SELECT id, name, archived_at FROM skills_products WHERE id = ?'),
    rating:        db.prepare('SELECT rating FROM skills_ratings WHERE person_id = ? AND product_id = ?'),
    setRating:     db.prepare(`INSERT INTO skills_ratings (person_id, product_id, rating) VALUES (?, ?, ?)
                               ON CONFLICT (person_id, product_id) DO UPDATE SET rating = excluded.rating`),
    setBaseline:   db.prepare(`INSERT INTO skills_baseline (person_id, product_id, rating) VALUES (?, ?, ?)
                               ON CONFLICT (person_id, product_id) DO UPDATE SET rating = excluded.rating`),
    insertPerson:  db.prepare('INSERT INTO skills_people (name, position, created_at) VALUES (?, ?, ?)'),
    insertProduct: db.prepare('INSERT INTO skills_products (name, position, created_at) VALUES (?, ?, ?)'),
    maxPersonPos:  db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM skills_people'),
    maxProductPos: db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM skills_products'),
    archivePerson: db.prepare('UPDATE skills_people SET archived_at = ? WHERE id = ?'),
    archiveProduct:db.prepare('UPDATE skills_products SET archived_at = ? WHERE id = ?'),
    insertChange:  db.prepare(`INSERT INTO skills_changes
                                 (person_id, product_id, person_name, product_name, old_rating, new_rating, confirmed, changed_on, recorded_at)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    changes:       db.prepare(`SELECT id, person_id, product_id, person_name, product_name, old_rating, new_rating,
                                      confirmed, changed_on, recorded_at
                               FROM skills_changes ORDER BY changed_on DESC, id DESC LIMIT ?`),
    confirmedUsed: db.prepare(`SELECT confirmed, COUNT(*) AS n FROM skills_changes GROUP BY confirmed COLLATE NOCASE
                               ORDER BY n DESC, MAX(id) DESC LIMIT 20`),
    countPeople:   db.prepare('SELECT COUNT(*) AS n FROM skills_people'),
    personByName:  db.prepare('SELECT name, archived_at FROM skills_people WHERE name = ?'),
    productByName: db.prepare('SELECT name, archived_at FROM skills_products WHERE name = ?'),
  };

  // ── Validation ─────────────────────────────────────────────────────────────
  function vId(v, what) {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw bad('bad_id', `${what} is missing or malformed.`);
    return n;
  }
  function vLevel(v, what) {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (!Number.isInteger(n) || n < MIN_LEVEL || n > MAX_LEVEL) throw bad('bad_rating', `${what} must be a whole number from ${MIN_LEVEL} to ${MAX_LEVEL}.`);
    return n;
  }
  function vName(v, what) {
    const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
    if (!s) throw bad('bad_name', `${what} is required.`);
    if (s.length > NAME_MAX) throw bad('bad_name', `${what} must be ${NAME_MAX} characters or fewer.`);
    return s;
  }
  function vConfirmed(v) {
    const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
    if (!s) throw bad('confirmed_required', 'Say where the change was confirmed (e.g. "Teams Message").');
    if (s.length > CONFIRMED_MAX) throw bad('bad_confirmed', `"Confirmed" must be ${CONFIRMED_MAX} characters or fewer.`);
    return s;
  }
  function vDate(v) {
    const s = String(v == null ? '' : v).trim();
    if (!DATE_RE.test(s)) throw bad('bad_date', 'The date must be YYYY-MM-DD.');
    const d = new Date(s + 'T00:00:00Z');
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw bad('bad_date', `${s} is not a real date.`);
    return s;
  }
  function personOrThrow(id) {
    const p = q.person.get(vId(id, 'Person'));
    if (!p) throw new SkillsError(404, 'no_person', 'That person is not in the matrix.');
    return p;
  }
  function productOrThrow(id) {
    const p = q.product.get(vId(id, 'Product'));
    if (!p) throw new SkillsError(404, 'no_product', 'That product is not in the matrix.');
    return p;
  }

  // ── Reads ──────────────────────────────────────────────────────────────────
  // The whole matrix is small (tens of people, tens of products), so every
  // read — and every write's response — is the full state. The page never has
  // to merge a partial update into what it holds.
  function grid(rows) {
    const out = {};
    for (const r of rows) (out[r.person_id] ||= {})[r.product_id] = r.rating;
    return out;
  }
  const entity = r => ({ id: r.id, name: r.name, archived: !!r.archived_at });
  function state() {
    return {
      levels: SKILL_LEVELS,
      people: q.people.all().map(entity),
      products: q.products.all().map(entity),
      ratings: grid(q.ratings.all()),
      baseline: grid(q.baseline.all()),
      confirmedSuggestions: q.confirmedUsed.all().map(r => r.confirmed),
    };
  }
  const changeRow = r => ({
    id: r.id, personId: r.person_id, productId: r.product_id,
    personName: r.person_name, productName: r.product_name,
    from: r.old_rating, to: r.new_rating,
    confirmed: r.confirmed, date: r.changed_on, recordedAt: r.recorded_at,
  });

  // Names are unique ignoring case. Say where the existing one is, because an
  // archived duplicate is invisible on the matrix and would otherwise read as
  // the store refusing a name that is not there.
  function duplicate(stmt, name) {
    const hit = stmt.get(name);
    return new SkillsError(409, 'duplicate', hit && hit.archived_at
      ? `${hit.name} is already in the matrix but archived. Restore them from the Archived list instead.`
      : `${hit ? hit.name : name} is already in the matrix.`);
  }

  // A new person gets 0 for every product, in both the matrix and the
  // baseline, and a new product gets 0 for every person — including archived
  // ones, so a later restore has a complete row rather than holes. 0 is the
  // scale's "don't know what this product does", which is the honest starting
  // point; the real values are then set on the matrix and the baseline.
  function fillPerson(personId) {
    for (const p of q.products.all()) { q.setRating.run(personId, p.id, 0); q.setBaseline.run(personId, p.id, 0); }
  }
  function fillProduct(productId) {
    for (const p of q.people.all()) { q.setRating.run(p.id, productId, 0); q.setBaseline.run(p.id, productId, 0); }
  }

  return {
    state,

    history(limit) {
      const n = Math.min(Math.max(Number(limit) || 1000, 1), 5000);
      return { changes: q.changes.all(n).map(changeRow) };
    },

    // A change to the live matrix. `from` is the value the editor saw; if the
    // store no longer holds it, somebody else got there first and the change is
    // refused, so the history can never record a transition that did not happen.
    changeRating(input) {
      const person = personOrThrow(input.personId);
      const product = productOrThrow(input.productId);
      if (person.archived_at) throw new SkillsError(409, 'archived', `${person.name} is archived. Restore them first.`);
      if (product.archived_at) throw new SkillsError(409, 'archived', `${product.name} is archived. Restore it first.`);
      const from = vLevel(input.from, 'The old rating');
      const to = vLevel(input.to, 'The new rating');
      if (from === to) throw bad('no_change', 'The new rating is the same as the old one.');
      const confirmed = vConfirmed(input.confirmed);
      const date = vDate(input.date);
      return tx(() => {
        const cur = q.rating.get(person.id, product.id);
        const stored = cur ? cur.rating : 0;
        if (stored !== from) {
          throw new SkillsError(409, 'stale_rating',
            `${person.name}'s ${product.name} rating is now ${stored}, not ${from} — someone else changed it. The matrix has been reloaded.`);
        }
        q.setRating.run(person.id, product.id, to);
        q.insertChange.run(person.id, product.id, person.name, product.name, from, to, confirmed, date, now());
        return state();
      });
    },

    // A correction to the baseline. Not recorded in the change history — the
    // business's call on 25 Sep 2026.
    setBaseline(input) {
      const person = personOrThrow(input.personId);
      const product = productOrThrow(input.productId);
      const rating = vLevel(input.rating, 'The baseline rating');
      q.setBaseline.run(person.id, product.id, rating);
      return state();
    },

    addPerson(input) {
      const name = vName(input.name, 'A name');
      try {
        return tx(() => {
          const id = Number(q.insertPerson.run(name, q.maxPersonPos.get().p + 1, now()).lastInsertRowid);
          fillPerson(id);
          return state();
        });
      } catch (e) {
        if (isUniqueViolation(e)) throw duplicate(q.personByName, name);
        throw e;
      }
    },

    addProduct(input) {
      const name = vName(input.name, 'A product name');
      try {
        return tx(() => {
          const id = Number(q.insertProduct.run(name, q.maxProductPos.get().p + 1, now()).lastInsertRowid);
          fillProduct(id);
          return state();
        });
      } catch (e) {
        if (isUniqueViolation(e)) throw duplicate(q.productByName, name);
        throw e;
      }
    },

    setPersonArchived(id, archived) {
      const p = personOrThrow(id);
      q.archivePerson.run(archived ? (p.archived_at || now()) : null, p.id);
      return state();
    },
    setProductArchived(id, archived) {
      const p = productOrThrow(id);
      q.archiveProduct.run(archived ? (p.archived_at || now()) : null, p.id);
      return state();
    },

    // One-off load of the spreadsheet's contents (skills-import.js). Refuses
    // to run over a store that already has people in it, so re-running the
    // import can never duplicate or overwrite what has been edited since.
    importSeed(seed) {
      if (q.countPeople.get().n > 0) throw new SkillsError(409, 'not_empty', 'The skills store already has data; import only runs into an empty store.');
      const people = (seed.people || []).map(n => vName(n, 'A name'));
      const products = (seed.products || []).map(n => vName(n, 'A product name'));
      return tx(() => {
        const pid = {}, prid = {};
        people.forEach((n, i) => { pid[n] = Number(q.insertPerson.run(n, i + 1, now()).lastInsertRowid); });
        products.forEach((n, i) => { prid[n] = Number(q.insertProduct.run(n, i + 1, now()).lastInsertRowid); });
        const cell = (grid, person, product) => {
          const v = grid && grid[person] ? grid[person][product] : undefined;
          return v === undefined || v === null ? 0 : vLevel(v, `${person} / ${product}`);
        };
        for (const person of people) for (const product of products) {
          q.setRating.run(pid[person], prid[product], cell(seed.ratings, person, product));
          q.setBaseline.run(pid[person], prid[product], cell(seed.baseline, person, product));
        }
        for (const c of seed.changes || []) {
          const person = vName(c.person, 'A history name'), product = vName(c.product, 'A history product');
          if (!pid[person]) throw bad('bad_seed', `History names ${person}, who is not in the matrix.`);
          if (!prid[product]) throw bad('bad_seed', `History names ${product}, which is not in the matrix.`);
          q.insertChange.run(pid[person], prid[product], person, product,
            vLevel(c.from, 'History old rating'), vLevel(c.to, 'History new rating'),
            vConfirmed(c.confirmed), vDate(c.date), now());
        }
        return state();
      });
    },

    close() { db.close(); },
  };
}

module.exports = { openSkillsStore, SkillsError, SKILL_LEVELS };
