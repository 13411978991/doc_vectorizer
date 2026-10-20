// inspect-hang.cjs — Read-only dump of ingest state for the stuck xlsx.
"use strict";
const Database = require("better-sqlite3");
const db = new Database(
  "E:/sag/完整后端版本/源码/doc_vectorizer/release-desktop/win-unpacked/resources/data/sag.db",
  { readonly: true, fileMustExist: true }
);

const tables = db.prepare("select name from sqlite_master where type='table' order by name").all();
const names = tables.map((x) => x.name);
console.log("tables:", names.join(", "));

const manifestTable = names.find((n) => /manifest/i.test(n));
console.log("manifestTable =", manifestTable);
if (manifestTable) {
  const cols = db.prepare(`pragma table_info(${manifestTable})`).all().map((c) => c.name);
  console.log("cols:", cols.join(", "));
  console.log("\n=== last_event counts ===");
  for (const c of db.prepare(`select last_event, count(*) as n from ${manifestTable} group by last_event`).all())
    console.log(`${c.last_event}: ${c.n}`);
  console.log("\n=== rows where embedded_at is null (not finished) ===");
  const rows = db.prepare(`select rel_path, last_event, last_error, chunked_at, embedded_at, chunk_count_pending as p, chunk_count_embedded as e, chunk_count_failed as f, last_sync_started_at as started, last_sync_duration_ms as dur from ${manifestTable} where embedded_at is null order by rowid desc limit 15`).all();
  for (const r of rows) console.log(JSON.stringify(r));
  console.log("\n=== EKP row ===");
  const ekp = db.prepare(`select * from ${manifestTable} where rel_path like '%EKP%'`).all();
  for (const r of ekp) console.log(JSON.stringify(r, null, 1));

  console.log("\n=== latest 5 by last_sync_started_at ===");
  const latest = db.prepare(`select rel_path, last_event, last_sync_started_at, last_sync_duration_ms from ${manifestTable} order by last_sync_started_at desc limit 5`).all();
  for (const r of latest) console.log(`${r.last_sync_started_at}  ${(r.last_sync_duration_ms / 1000).toFixed(0)}s  [${r.last_event}]  ${r.rel_path}`);
}

const chunksTable = names.find((n) => n === "chunks");
if (chunksTable) {
  const cols = db.prepare(`pragma table_info(${chunksTable})`).all().map((c) => c.name);
  console.log("\nchunks cols:", cols.join(", "));
  const stateCol = cols.find((c) => /state|status/i.test(c));
  if (stateCol) {
    console.log(`\n=== chunks.${stateCol} counts ===`);
    for (const c of db.prepare(`select ${stateCol} as s, count(*) as n from chunks group by ${stateCol}`).all())
      console.log(`${c.s}: ${c.n}`);
  }
  if (cols.includes("locked_by")) {
    console.log("\n=== locked chunks ===");
    for (const l of db.prepare(`select locked_by, locked_at, count(*) as n from chunks where locked_by is not null group by locked_by, locked_at`).all())
      console.log(JSON.stringify(l));
  }
}
db.close();
