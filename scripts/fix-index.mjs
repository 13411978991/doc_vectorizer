import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db");

// Drop and recreate the tenant index
db.exec(`DROP INDEX IF EXISTS watched_folders_tenant_idx`);
db.exec(`CREATE INDEX watched_folders_tenant_idx on watched_folders(tenant_id)`);
db.exec(`REINDEX watched_folders`);

console.log("after fix:", db.pragma("integrity_check"));
db.close();