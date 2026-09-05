import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db");
const json = JSON.stringify(["c3c6a740-9d61-45df-8292-6bd35e792631"]);
console.log("JSON:", json);
const r = db.prepare("SELECT id, display_name, source_id FROM watched_folders WHERE id IN (SELECT value FROM json_each(?))").all(json);
console.log("result:", JSON.stringify(r));
// sanity: same query without json_each
const r2 = db.prepare("SELECT id, display_name, source_id FROM watched_folders WHERE id = ?").all("c3c6a740-9d61-45df-8292-6bd35e792631");
console.log("direct:", JSON.stringify(r2));
db.close();