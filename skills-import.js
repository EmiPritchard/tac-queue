#!/usr/bin/env node
/**
 * One-off load of the "UK Product Skills Matrix" spreadsheet into the skills
 * store. Takes a JSON file (not the .xlsx — reading Excel would need a
 * dependency this app otherwise has no use for):
 *
 *   {
 *     "people":   ["Emi Pritchard", ...],            // matrix row order
 *     "products": ["SASBOSS", ...],                   // matrix column order
 *     "ratings":  { "Emi Pritchard": { "SASBOSS": 4, ... }, ... },   // Sheet1
 *     "baseline": { ...same shape... },                               // Baseline
 *     "changes":  [ { "person", "product", "from", "to", "confirmed", "date": "YYYY-MM-DD" } ]
 *   }
 *
 *   node skills-import.js path/to/skills-seed.json
 *
 * Writes to SKILLS_DB_PATH (default ./data/skills.sqlite) and refuses to run
 * into a store that already has people in it, so it cannot clobber edits made
 * in the dashboard. Stop the server first: SQLite allows one writer.
 */
const fs = require('fs');
const path = require('path');
const { openSkillsStore } = require('./skills-store');

const file = process.argv[2];
if (!file) { console.error('Usage: node skills-import.js <seed.json>'); process.exit(2); }
const dbPath = process.env.SKILLS_DB_PATH || path.join(__dirname, 'data', 'skills.sqlite');
const store = openSkillsStore(dbPath);
try {
  const s = store.importSeed(JSON.parse(fs.readFileSync(file, 'utf8')));
  const hist = store.history(5000).changes.length;
  console.log(`Imported ${s.people.length} people, ${s.products.length} products and ${hist} history rows into ${path.resolve(dbPath)}`);
} catch (e) {
  console.error('Import failed:', e.message);
  process.exitCode = 1;
} finally {
  store.close();
}
