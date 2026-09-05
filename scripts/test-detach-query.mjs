import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db");

const folderIds = ["c3c6a740-9d61-45df-8292-6bd35e792631"];
const tenantId = "default";

const rows = db.prepare(`
  select id, json_extract(metadata, '$.formerSourceId') as former, source_id as currentSource
  from watched_folders
  where id in (
    select value from json_each(?)
  )
    and tenant_id = ?
`).all(JSON.stringify(folderIds), tenantId);

console.log("rows:", rows);
db.close();