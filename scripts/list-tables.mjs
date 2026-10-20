import Database from "better-sqlite3";
const db = new Database("D:/IT审计/SAG-windows-pack/doc_vectorizer/dist-package/本地知识检索-0.1.0/resources/合并数据/data/sag.db");
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
for (const r of tables) console.log(r.name);
db.close();
