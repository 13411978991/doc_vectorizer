import Database from "better-sqlite3";

const ids = JSON.stringify(["c3c6a740-9d61-45df-8292-6bd35e792631", "29004b7f-cf4f-4308-9109-a725f2237130"]);
const tenant = "default";
const projectId = "d65db8c0-a432-43e9-8262-2e52895f5764";

console.log("=== Test A: simple update with json_each in subquery ===");
{
  const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db");
  try {
    const r = db.prepare(`select id, source_id, metadata from watched_folders where id in (select value from json_each(?))`).all(ids);
    console.log("ok:", JSON.stringify(r, null, 2));
  } catch (e) { console.log("err:", e.message); }
  db.close();
}

console.log("\n=== Test B: combined with tenant filter ===");
{
  const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db");
  try {
    const r = db.prepare(`select id, source_id, metadata from watched_folders where id in (select value from json_each(?)) and tenant_id = ?`).all(ids, tenant);
    console.log("ok:", JSON.stringify(r, null, 2));
  } catch (e) { console.log("err:", e.message); }
  db.close();
}

console.log("\n=== Test C: combined with tenant and source_id ===");
{
  const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db");
  try {
    const r = db.prepare(`select id, json_extract(metadata, '$.formerSourceId') as former from watched_folders where id in (select value from json_each(?)) and tenant_id = ? and source_id = ?`).all(ids, tenant, projectId);
    console.log("ok:", JSON.stringify(r, null, 2));
  } catch (e) { console.log("err:", e.message); }
  db.close();
}