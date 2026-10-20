"use strict";
const Database = require("better-sqlite3");
const fs = require("fs"), path = require("path"), os = require("os");
const SRC = "E:/sag/完整后端版本/源码/doc_vectorizer/release-desktop/win-unpacked/resources/data/sag.db";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sag-t-"));
const p = path.join(tmp, "s.db");
fs.copyFileSync(SRC, p);
for (const ext of ["-wal", "-shm"]) if (fs.existsSync(SRC + ext)) fs.copyFileSync(SRC + ext, p + ext);
const db = new Database(p);
const tables = db.prepare("select name, sql from sqlite_master where type='table' order by name").all();
for (const t of tables) {
  console.log("TABLE:", t.name);
}
console.log("---events-related---");
for (const t of tables) {
  if (t.name.includes("event")) console.log(t.sql ? t.sql.slice(0, 200) : "(no sql)");
}
db.close();
fs.rmSync(tmp, { recursive: true, force: true });
