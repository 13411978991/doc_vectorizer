// Comprehensive test: attach, detach, archive, un-archive flow
const HUIJI1 = "d65db8c0-a432-43e9-8262-2e52895f5764";
const FOLDER_A = "c3c6a740-9d61-45df-8292-6bd35e792631";
const FOLDER_B = "29004b7f-cf4f-4308-9109-a725f2237130";
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
    WHERE wfm.folder_id IN (?, ?)
    ORDER BY wf.display_name, d.id
  `).all(FOLDER_A, FOLDER_B);
  return { folders, docs };
}
function showFolders(fs) {
  return fs.map(f => `  ${f.display_name.padEnd(10)} src=${(f.source_id || "NULL").slice(0,8)} former=${(f.former || "null").slice(0,8)}`).join("\n");
}
function showDocs(ds) {
  if (ds.length === 0) return "  (no docs)";
  return ds.map(d => `  ${(d.folder_name || "?").padEnd(10)} doc=${d.id.slice(0,8)} src=${d.src.slice(0,8)} archived=${d.archived_at ? "YES" : "no"}`).join("\n");
}
async function getStats() {
  const r = await fetch(`${BASE}/api/projects/${HUIJI1}/stats`);
  const d = await r.json();
  return d.stats;
}
async function attach(p, f) {
  const r = await fetch(`${BASE}/api/projects/${p}/folders`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folderIds: [f] }) });
  return r.json();
}
async function detach(p, f) {
  const r = await fetch(`${BASE}/api/projects/${p}/folders`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folderIds: [f] }) });
  return r.json();
}

async function main() {
  console.log("=== Step 0: ensure folder-a + folder-b are both attached to 汇集1 ===");
  // folder-a already attached. folder-b is orphan, attach it.
  let s = state();
  console.log("Folders:"); console.log(showFolders(s.folders));
  console.log("Docs:"); console.log(showDocs(s.docs));
  console.log("Stats 汇集1:", JSON.stringify(await getStats()));

  // attach folder-b
  const a1 = await attach(HUIJI1, FOLDER_B);
  console.log("\nattach folder-b:", JSON.stringify(a1));
  s = state();
  console.log("Folders:"); console.log(showFolders(s.folders));
  console.log("Docs:"); console.log(showDocs(s.docs));
  console.log("Stats 汇集1:", JSON.stringify(await getStats()));

  console.log("\n=== Step 1: detach folder-a from 汇集1 (should archive folder-a's docs) ===");
  const d1 = await detach(HUIJI1, FOLDER_A);
  console.log("detach:", JSON.stringify(d1));
  s = state();
  console.log("Folders:"); console.log(showFolders(s.folders));
  console.log("Docs:"); console.log(showDocs(s.docs));
  console.log("Stats 汇集1:", JSON.stringify(await getStats()));

  console.log("\n=== Step 2: re-attach folder-a to 汇集1 (should un-archive folder-a's docs) ===");
  const a2 = await attach(HUIJI1, FOLDER_A);
  console.log("attach:", JSON.stringify(a2));
  s = state();
  console.log("Folders:"); console.log(showFolders(s.folders));
  console.log("Docs:"); console.log(showDocs(s.docs));
  console.log("Stats 汇集1:", JSON.stringify(await getStats()));
}

main().then(() => db.close()).catch(e => { console.error(e); db.close(); process.exit(1); });