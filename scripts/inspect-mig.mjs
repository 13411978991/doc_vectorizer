import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db");
console.log("schema_migrations cols:");
for (const c of db.prepare("PRAGMA table_info(schema_migrations)").all()) console.log("  ", c.name, c.type);
const rows = db.prepare("SELECT * FROM schema_migrations LIMIT 3").all();
console.log("rows sample:", rows);
db.close();