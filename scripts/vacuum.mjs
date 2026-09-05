import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db");
db.exec("VACUUM");
db.close();
console.log("vacuumed");