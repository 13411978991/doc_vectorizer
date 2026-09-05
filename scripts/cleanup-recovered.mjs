import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db");

// Delete "(recovered) ..." source rows that my detach recovery insert created.
const r = db.prepare("DELETE FROM sources WHERE name LIKE '(recovered)%'").run();
console.log("deleted:", r.changes);

// Reindex for safety.
db.pragma("REINDEX");
db.close();