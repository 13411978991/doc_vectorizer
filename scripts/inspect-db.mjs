import Database from "better-sqlite3";
const db = new Database("E:\\sag\\export\\data\\sag.db");

try {
  const r = db.prepare("PRAGMA integrity_check").all();
  console.log("dev db integrity:", JSON.stringify(r));
} catch (e) { console.log("integrity ERR:", e.message); }

try {
  const r = db.prepare("SELECT COUNT(*) as cnt FROM sources").get();
  console.log("sources count:", r.cnt);
} catch (e) { console.log("sources ERR:", e.message); }

try {
  const r = db.prepare("SELECT COUNT(*) as cnt FROM chunks").get();
  console.log("chunks count:", r.cnt);
} catch (e) { console.log("chunks ERR:", e.message); }

try {
  const r = db.prepare("SELECT COUNT(*) as cnt FROM chunk_vec0").get();
  console.log("chunk_vec0 count:", r.cnt);
} catch (e) { console.log("chunk_vec0 ERR:", e.message); }

db.close();