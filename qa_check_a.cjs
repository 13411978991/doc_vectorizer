// qa_check_a.cjs — verify events.extraction_source column
const db = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.resolve('data/sag.db');
if (!fs.existsSync(dbPath)) {
  console.error('DB not found at', dbPath);
  process.exit(2);
}

const d = new db(dbPath, { readonly: true });
const cols = d.prepare("PRAGMA table_info('events')").all();
const extractionSource = cols.filter((c) => c.name === 'extraction_source');
console.log('extraction_source columns:', JSON.stringify(extractionSource, null, 2));

const meta = cols.filter((c) => c.name === 'metadata');
console.log('metadata columns:', JSON.stringify(meta, null, 2));

const allMigrations = d.prepare('SELECT name, applied_at FROM schema_migrations ORDER BY name').all();
console.log('schema_migrations rows (' + allMigrations.length + '):');
for (const row of allMigrations) {
  console.log('  ' + row.applied_at + '  ' + row.name);
}

// Also peek at event rows count and how many have extraction_source populated
const cnt = d.prepare('SELECT COUNT(*) AS c FROM events').get();
const withSrc = d.prepare("SELECT COUNT(*) AS c FROM events WHERE extraction_source IS NOT NULL").get();
const bySrc = d.prepare("SELECT COALESCE(extraction_source, '<NULL>') AS src, COUNT(*) AS c FROM events GROUP BY extraction_source").all();
console.log('event counts:', JSON.stringify(cnt), 'with_src:', JSON.stringify(withSrc));
console.log('by source:', JSON.stringify(bySrc));

d.close();