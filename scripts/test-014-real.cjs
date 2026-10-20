"use strict";
// Test migration 014 against the ACTUAL desktop DB state (001-013 applied)
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");
const os = require("os");

const SRC_DB = "E:/sag/完整后端版本/源码/doc_vectorizer/release-desktop/win-unpacked/resources/data/sag.db";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sag-mig-test-"));
const dbPath = path.join(tmp, "sag.db");
fs.copyFileSync(SRC_DB, dbPath);
// Also copy WAL/SHM so the applied migrations are visible
for (const ext of ["-wal", "-shm"]) {
  if (fs.existsSync(SRC_DB + ext)) fs.copyFileSync(SRC_DB + ext, dbPath + ext);
}

const db = new Database(dbPath);
try { require("sqlite-vec").load(db); } catch (e) { console.log("vec load:", e.message); }

// Which migrations are applied?
const applied = db.prepare("select name from schema_migrations order by name").all().map(r => r.name);
console.log("Applied:", applied.join(", "));

const MIG = "E:/sag/完整后端版本/源码/doc_vectorizer/release-desktop/win-unpacked/resources/migrations";
function findTrailingVacuumIndex(sql) {
  const re = /(?:^|[;\n])[ \t]*VACUUM[ \t]*;?[ \t]*$/gim;
  let lastIdx = -1, lastMatchLen = 0, match;
  while ((match = re.exec(sql)) !== null) { lastIdx = match.index; lastMatchLen = match[0].length; }
  if (lastIdx < 0) return -1;
  const afterMatch = sql.slice(lastIdx + lastMatchLen);
  if (afterMatch.trim().length > 0) return -1;
  if (lastMatchLen > 0) {
    const sep = sql[lastIdx];
    if (sep === ";" || sep === "\n") return lastIdx;
  }
  return lastIdx;
}

for (const file of ["014_restore_events_fk.sql", "015_clear_default_ai_endpoints.sql", "016_llm_provider.sql", "017_backfill_events_document_id.sql", "018_ner_model.sql", "019_add_events_extraction_source.sql", "020_remove_local_embedding_provider.sql"]) {
  if (applied.includes(file)) { console.log(`--- ${file}: already applied, skip`); continue; }
  const sql = fs.readFileSync(path.join(MIG, file), "utf8");
  const idx = findTrailingVacuumIndex(sql);
  const preVacuumSql = idx > 0 ? sql.slice(0, idx) : "";
  const hasTrailingVacuum = idx >= 0;
  console.log(`--- ${file}: vacuumIdx=${idx} hasVacuum=${hasTrailingVacuum}`);
  const tx = db.transaction((s, name) => {
    db.exec(s);
    db.prepare("insert into schema_migrations (name) values (?)").run(name);
  });
  try {
    tx(preVacuumSql, file);
    if (hasTrailingVacuum) { try { db.exec("VACUUM"); } catch (e) { console.log("    VACUUM warn:", e.message); } }
    console.log("    OK");
  } catch (err) {
    console.log(`    FAILED: ${err.message} (code=${err.code})`);
    break;
  }
}
db.close();
fs.rmSync(tmp, { recursive: true, force: true });
