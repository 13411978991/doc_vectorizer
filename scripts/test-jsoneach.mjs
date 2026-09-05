import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db");

// Test 1: raw array
try {
  const r = db.prepare("SELECT id FROM watched_folders WHERE id IN (SELECT value FROM json_each(?))").all(["c3c6a740-9d61-45df-8292-6bd35e792631"]);
  console.log("raw array:", JSON.stringify(r));
} catch (e) {
  console.log("raw array ERROR:", e.message);
}

// Test 2: JSON string
try {
  const r = db.prepare("SELECT id FROM watched_folders WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(["c3c6a740-9d61-45df-8292-6bd35e792631"]));
  console.log("JSON string:", JSON.stringify(r));
} catch (e) {
  console.log("JSON string ERROR:", e.message);
}

db.close();