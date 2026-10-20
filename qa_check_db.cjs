// qa_check_db.cjs — Inspect ai_provider_settings row
const db = require('better-sqlite3');
const path = require('path');
const d = new db(path.resolve('data/sag.db'), { readonly: true });
const rows = d.prepare('SELECT * FROM ai_provider_settings').all();
for (const row of rows) {
  const summary = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'string' && v.length > 80) {
      summary[k] = v.slice(0, 80) + '...';
    } else {
      summary[k] = v;
    }
  }
  console.log(JSON.stringify(summary, null, 2));
}
d.close();