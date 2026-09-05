const HUIJI1 = "c4234006-5804-43d5-839f-ef272b1c3f9d";
const FOLDER_A = "29808fa0-6acb-42b3-a7d2-744c6dddfcf2";
const FOLDER_B = "b2d4a0a3-f963-4945-954f-e38024e7d094";
const BASE = "http://127.0.0.1:4173";

import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db", { readonly: true });
function dumpState() {
  const wf = db.prepare("SELECT display_name, source_id, json_extract(metadata, '$.formerSourceId') as former FROM watched_folders").all();
  const docs = db.prepare(`
    SELECT wf.display_name as folder, d.id, d.source_id as doc_src, d.archived_at
    FROM documents d
    JOIN watched_folder_manifests wfm ON wfm.document_id = d.id
    JOIN watched_folders wf ON wf.id = wfm.folder_id
    ORDER BY wf.display_name, d.id
  `).all();
  console.log("  folders:");
  for (const f of wf) console.log(`    ${f.display_name.padEnd(10)} src=${(f.source_id || "NULL").slice(0,8)} former=${(f.former || "null").slice(0,8)}`);
  console.log("  docs:");
  for (const d of docs) console.log(`    ${d.folder.padEnd(10)} doc=${d.id.slice(0,8)} src=${d.doc_src.slice(0,8)} archived=${d.archived_at ? "Y" : "n"}`);
}
async function getStats(id) {
  return JSON.parse((await (await fetch(`${BASE}/api/projects/${id}/stats`)).text())).stats;
}
async function attach(p, f) { return (await (await fetch(`${BASE}/api/projects/${p}/folders`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folderIds: [f] }) })).json()); }
async function detach(p, f) { return (await (await fetch(`${BASE}/api/projects/${p}/folders`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folderIds: [f] }) })).json()); }

(async () => {
  console.log("=== initial ==="); dumpState();
  console.log("  汇集1 stats:", JSON.stringify(await getStats(HUIJI1)));

  console.log("\n=== detach folder-a from 汇集1 ===");
  console.log("  result:", JSON.stringify(await detach(HUIJI1, FOLDER_A)));
  dumpState();
  console.log("  汇集1 stats:", JSON.stringify(await getStats(HUIJI1)));

  console.log("\n=== re-attach folder-a to 汇集1 ===");
  console.log("  result:", JSON.stringify(await attach(HUIJI1, FOLDER_A)));
  dumpState();
  console.log("  汇集1 stats:", JSON.stringify(await getStats(HUIJI1)));

  db.close();
})().catch(e => { console.error(e); db.close(); });