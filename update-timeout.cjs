const Database = require('./node_modules/better-sqlite3');
const db = new Database('D:\\SAG\\doc_vectorizer\\dist-package\\本地知识检索-0.1.0\\resources\\data\\sag.db');

// Update llm_timeout_ms column
const r1 = db.prepare('UPDATE ai_provider_settings SET llm_timeout_ms = ? WHERE id = ?').run(180000, 'global');
console.log('llm_timeout_ms updated:', r1.changes, 'rows');

// Parse and update metadata JSON
const row = db.prepare('SELECT metadata FROM ai_provider_settings WHERE id = ?').get('global');
if (row) {
    const meta = JSON.parse(row.metadata);
    console.log('Old performance.llmTimeoutMs:', meta.performance?.llmTimeoutMs);
    if (meta.performance) {
        meta.performance.llmTimeoutMs = 180000;
    }
    const newMeta = JSON.stringify(meta);
    const r2 = db.prepare('UPDATE ai_provider_settings SET metadata = ? WHERE id = ?').run(newMeta, 'global');
    console.log('metadata updated:', r2.changes, 'rows');

    // Verify
    const row2 = db.prepare('SELECT llm_timeout_ms, metadata FROM ai_provider_settings WHERE id = ?').get('global');
    console.log('New llm_timeout_ms:', row2.llm_timeout_ms);
    const meta2 = JSON.parse(row2.metadata);
    console.log('New performance.llmTimeoutMs:', meta2.performance?.llmTimeoutMs);
}

db.close();
console.log('Done!');
