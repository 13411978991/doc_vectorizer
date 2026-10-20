"use strict";
// Inspect the ACTUAL desktop DB read-only (no copy) to rule out copy artifacts
const Database = require("better-sqlite3");
const SRC = "E:/sag/完整后端版本/源码/doc_vectorizer/release-desktop/win-unpacked/resources/data/sag.db";
const db = new Database(SRC, { readonly: true, fileMustExist: true });
const tables = db.prepare("select name from sqlite_master where type='table' order by name").all().map(r => r.name);
console.log("Tables in ACTUAL db:", tables.join(", ") || "(none)");
const migs = db.prepare("select name, applied_at from schema_migrations order by name").all();
console.log("Migrations (" + migs.length + "):");
for (const m of migs) console.log("  " + m.name + " @ " + m.applied_at);
db.close();
