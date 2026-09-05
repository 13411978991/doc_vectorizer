import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db", { readonly: true });
const ids = [
  "12ac2a2a-e6e6-4fa2-b002-68a705ada04b",
  "3b045232-5113-459e-b691-a9271cdf94f5",
  "3e2c108f-0ace-4251-aa07-6af291268015",
  "59bfcc4d-2da3-43b1-a539-9fe605ad0d36"
];
const placeholders = ids.map(() => "?").join(",");
const r = db.prepare(`SELECT id, name, archived_at, created_at FROM sources WHERE id IN (${placeholders})`).all(...ids);
console.log("present:", r.length, JSON.stringify(r, null, 2));
db.close();