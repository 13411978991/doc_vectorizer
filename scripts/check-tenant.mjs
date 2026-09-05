import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db");
console.log("sources:", db.prepare("SELECT id, tenant_id FROM sources WHERE id=?").all("d65db8c0-a432-43e9-8262-2e52895f5764"));
console.log("default tenant?", db.prepare("SELECT id, tenant_id FROM sources WHERE id=? AND tenant_id=?").all("d65db8c0-a432-43e9-8262-2e52895f5764", "default"));
console.log("watched_folders tenant:", db.prepare("SELECT id, tenant_id FROM watched_folders WHERE id=?").all("c3c6a740-9d61-45df-8292-6bd35e792631"));
db.close();