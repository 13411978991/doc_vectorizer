import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db", { readonly: true });
sqliteVec.load(db);

const c = db.prepare("SELECT COUNT(*) as cnt FROM chunk_vec0").get();
const e = db.prepare("SELECT COUNT(*) as cnt FROM entity_vec0").get();
const t = db.prepare("SELECT COUNT(*) as cnt FROM event_title_vec0").get();
const ec = db.prepare("SELECT COUNT(*) as cnt FROM event_content_vec0").get();

console.log(`chunk_vec0:         ${c.cnt}`);
console.log(`entity_vec0:        ${e.cnt}`);
console.log(`event_title_vec0:   ${t.cnt}`);
console.log(`event_content_vec0: ${ec.cnt}`);
db.close();