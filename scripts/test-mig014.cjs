"use strict";
// Test migration 014 against fresh in-memory DB using desktop migrations
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const MIG_DIR = "E:/sag/完整后端版本/源码/doc_vectorizer/release-desktop/win-unpacked/resources/migrations";
const files = fs.readdirSync(MIG_DIR).filter(f => f.endsWith(".sql")).sort();

// Same findTrailingVacuumIndex algorithm as src/db/migrate.ts (regex version)
function findTrailingVacuumIndex(sql) {
  const re = /(?:^|[;\n])[ \t]*VACUUM[ \t]*;?[ \t]*$/gim;
  let lastIdx = -1;
  let lastMatchLen = 0;
  let match;
  while ((match = re.exec(sql)) !== null) {
    lastIdx = match.index;
    lastMatchLen = match[0].length;
  }
  if (lastIdx < 0) return -1;
  const afterMatch = sql.slice(lastIdx + lastMatchLen);
  if (afterMatch.trim().length > 0) return -1;
  if (lastMatchLen > 0) {
    const sep = sql[lastIdx];
    if (sep === ";" || sep === "\n") {
      return lastIdx;
    }
  }
  return lastIdx;
}

const db = new Database(":memory:");
db.pragma("journal_mode = WAL");
// Load sqlite-vec like the runtime does
try {
  const vec = require("sqlite-vec");
  vec.load(db);
  console.log("sqlite-vec loaded");
} catch (e) {
  console.log("sqlite-vec load failed:", e.message);
}
db.exec("CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))");

for (const file of files) {
  const sql = fs.readFileSync(path.join(MIG_DIR, file), "utf8");
  const idx = findTrailingVacuumIndex(sql);
  const preVacuumSql = idx > 0 ? sql.slice(0, idx) : (idx === 0 ? "" : sql);
  const hasTrailingVacuum = idx >= 0;
  const preVacuumSqlFixed = idx > 0 ? sql.slice(0, idx) : (idx === 0 ? "" : sql);
  console.log(`--- ${file}: vacuumIdx=${idx} hasTrailingVacuum=${hasTrailingVacuum}`);
  try {
    const tx = db.transaction((s) => { db.exec(s); });
    tx(preVacuumSqlFixed);
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run(file);
    if (hasTrailingVacuum) { db.exec("VACUUM"); }
    console.log(`    OK`);
  } catch (err) {
    console.log(`    FAILED: ${err.message} (code=${err.code})`);
    break;
  }
}
