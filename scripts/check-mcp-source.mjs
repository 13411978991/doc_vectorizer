import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db", { readonly: true });
const r = db.prepare("SELECT id, kind, name, tenant_id FROM sources WHERE id = 'f0f37aee-8f11-4c17-96e1-3568af863076'").all();
for (const x of r) console.log(JSON.stringify(x));
// also list any 汇集功能-named source
const all = db.prepare("SELECT id, kind, name FROM sources WHERE name LIKE '%汇集%'").all();
console.log("\nAll '汇集' sources:");
for (const x of all) console.log(JSON.stringify(x));
// watched folders pointing to that source
const wf = db.prepare("SELECT id, display_name, source_id, json_extract(metadata, '$.formerSourceId') as former FROM watched_folders WHERE source_id = 'f0f37aee-8f11-4c17-96e1-3568af863076'").all();
console.log("\nWatched folders bound to f0f37aee:");
for (const x of wf) console.log(JSON.stringify(x));
db.close();