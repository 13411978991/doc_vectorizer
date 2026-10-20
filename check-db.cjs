const Database = require('./node_modules/better-sqlite3');
const db = new Database('D:\\SAG\\doc_vectorizer\\dist-package\\本地知识检索-0.1.0\\resources\\data\\sag.db');

try {
    // List all tables
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    console.log("Tables:", tables.map(t => t.name).join(", "));
    
    // Event categories
    const cats = db.prepare("SELECT category, COUNT(*) as cnt FROM events GROUP BY category ORDER BY cnt DESC LIMIT 10").all();
    console.log("Event categories:", JSON.stringify(cats));
    
    // Entity types count
    const etCount = db.prepare("SELECT COUNT(*) as cnt FROM entity_types").get();
    console.log("entity_types count:", etCount.cnt);
    
    // Vec0 vs chunks
    const vec0 = db.prepare("SELECT COUNT(*) as cnt FROM chunk_vec0_chunks").get();
    const chunks = db.prepare("SELECT COUNT(*) as cnt FROM chunks").get();
    console.log("vec0_chunks:", vec0.cnt, "total_chunks:", chunks.cnt);
    
    // Recent events (last 5)
    const recent = db.prepare("SELECT id, title, category, created_at FROM events ORDER BY created_at DESC LIMIT 5").all();
    console.log("Recent events:", JSON.stringify(recent, null, 2));
    
    // Watcher runs
    const runs = db.prepare("SELECT id, status, started_at FROM watched_folder_runs WHERE status='running'").all();
    console.log("Running watcher runs:", JSON.stringify(runs));
    
    // Manifests with errors
    const bad = db.prepare("SELECT rel_path, last_event, last_error FROM watched_folder_manifests WHERE last_event='failed' LIMIT 5").all();
    console.log("Failed manifests:", JSON.stringify(bad));
} catch(e) {
    console.log("Error:", e.message);
}

db.close();
