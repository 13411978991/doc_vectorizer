import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db");
db.prepare("INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES ('014_restore_events_fk.sql', current_timestamp)").run();
console.log("recorded migration");
db.close();