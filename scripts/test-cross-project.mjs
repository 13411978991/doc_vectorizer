// Test cross-project: move folder from huiji1 to huiji2 and back
const HUIJI1 = "d65db8c0-a432-43e9-8262-2e52895f5764";
const HUIJI2 = "5038ddb0-8cc0-47b1-9dd5-4cd45b8dc347";
const FOLDER_A = "c3c6a740-9d61-45df-8292-6bd35e792631";
const BASE = "http://127.0.0.1:4173";

import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db", { readonly: true });
function state() {
  const folders = db.prepare("SELECT id, display_name, source_id, json_extract(metadata, '$.formerSourceId') as former FROM watched_folders").all();
  const docs = db.prepare(`
    SELECT d.id, d.source_id as src, d.archived_at, wf.display_name as folder_name
    FROM documents d
    LEFT JOIN watched_folder_manifests wfm ON wfm.document_id = d.id
    LEFT JOIN watched_folders wf ON wf.id = wfm.folder_id
    WHERE wfm.folder_id = ?
    ORDER BY wf.display_name, d.id
  `).all(FOLDER_A);
  return { folders, docs };
}
function show(s) {
  console.log("Folders:");
  for (const f of s.folders) console.log(`  ${f.display_name.padEnd(10)} src=${(f.source_id || "NULL").slice(0,8)} former=${(f.former || "null").slice(0,8)}`);
  console.log("folder-a Docs:");
  for (const d of s.docs) console.log(`  doc=${d.id.slice(0,8)} src=${d.src.slice(0,8)} archived=${d.archived_at ? "YES" : "no"}`);
}
async function stats(p) {
  const r = await fetch(`${BASE}/api/projects/${p}/stats`);
  return (await r.json()).stats;
}
async function attach(p, f) {
  return (await (await fetch(`${BASE}/api/projects/${p}/folders`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folderIds: [f] }) })).json());
}
async function detach(p, f) {
  return (await (await fetch(`${BASE}/api/projects/${p}/folders`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folderIds: [f] }) })).json());
}

async function main() {
  console.log("=== Step 0: ensure folder-a is on 汇集1 ===");
  const cur = db.prepare("SELECT source_id FROM watched_folders WHERE id = ?").get(FOLDER_A);
  if (cur.source_id !== HUIJI1) {
    await attach(HUIJI1, FOLDER_A);
  }
  show(state());
  console.log("Stats 汇集1:", JSON.stringify(await stats(HUIJI1)));
  console.log("Stats 汇集2:", JSON.stringify(await stats(HUIJI2)));

  console.log("\n=== Step 1: move folder-a → 汇集2 ===");
  await attach(HUIJI2, FOLDER_A);
  show(state());
  console.log("Stats 汇集1:", JSON.stringify(await stats(HUIJI1)));
  console.log("Stats 汇集2:", JSON.stringify(await stats(HUIJI2)));

  console.log("\n=== Step 2: detach folder-a from 汇集2 (should restore to 汇集1) ===");
  await detach(HUIJI2, FOLDER_A);
  show(state());
  console.log("Stats 汇集1:", JSON.stringify(await stats(HUIJI1)));
  console.log("Stats 汇集2:", JSON.stringify(await stats(HUIJI2)));
}

main().then(() => db.close()).catch(e => { console.error(e); db.close(); process.exit(1); });