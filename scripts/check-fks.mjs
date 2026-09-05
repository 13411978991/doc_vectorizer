import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db", { readonly: true });
console.log("PRAGMA foreign_keys:", db.prepare("PRAGMA foreign_keys").get());
console.log("events SQL:", db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='events'").get());
db.close();