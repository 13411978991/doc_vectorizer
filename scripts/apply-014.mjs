import Database from "better-sqlite3";
import fs from "node:fs";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db");
const sql = fs.readFileSync("E:\\sag\\export\\src\\db\\sqlite\\migrations\\014_restore_events_fk.sql", "utf8");
try {
  db.exec(sql);
  console.log("migration applied");
} catch (e) {
  console.log("ERROR:", e.message);
}
console.log("FK list:");
for (const f of db.prepare("PRAGMA foreign_key_list(events)").all()) console.log("  ", JSON.stringify(f));
const orphanCount = db.prepare("SELECT count(*) as n FROM events WHERE source_id NOT IN (SELECT id FROM sources)").get().n;
console.log("orphan events:", orphanCount);
db.close();