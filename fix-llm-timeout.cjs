const Database = require('./node_modules/better-sqlite3');
const db = new Database('D:\\SAG\\doc_vectorizer\\dist-package\\本地知识检索-0.1.0\\resources\\data\\sag.db');

try {
    const schema = db.prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?').get('table', 'ai_provider_settings');
    console.log('Schema:', schema.sql);
} catch(e) {
    console.log('Schema error:', e.message);
}

try {
    const rows = db.prepare('SELECT * FROM ai_provider_settings LIMIT 5').all();
    console.log('Sample rows:', JSON.stringify(rows, null, 2));
} catch(e) {
    console.log('Rows error:', e.message);
}

// Check if llmTimeoutMs is in metadata JSON
const meta = db.prepare("SELECT metadata FROM ai_provider_settings LIMIT 1").get();
console.log('Sample metadata:', meta ? meta.metadata : 'none');

// Find the llmTimeoutMs row
const allRows = db.prepare('SELECT rowid, * FROM ai_provider_settings').all();
console.log('All rows count:', allRows.length);
if (allRows.length > 0) {
    console.log('First row keys:', Object.keys(allRows[0]));
}

// Try to find settings table
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables.map(t => t.name));

db.close();
