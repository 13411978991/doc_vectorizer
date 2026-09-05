import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db");
console.log("integrity_check:", db.pragma("integrity_check"));
console.log("table_info watched_folders:", db.prepare("PRAGMA table_info(watched_folders)").all());
db.close();