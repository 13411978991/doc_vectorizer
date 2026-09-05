import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db");
const schemas = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='sources'").all();
console.log(schemas);
db.close();