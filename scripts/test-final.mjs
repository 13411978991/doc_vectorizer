// Full mount/unmount test (API + KB source dual-model)
// Tests: detach when former=null now orphan-izes the folder
const HUIJI1 = "d65db8c0-a432-43e9-8262-2e52895f5764";
const HUIJI1_KB = "2a0b8621-0d8a-494e-9aa7-eac518544fbf";
const HUIJI2 = "5038ddb0-8cc0-47b1-9dd5-4cd45b8dc347";
const FOLDER_A = "c3c6a740-9d61-45df-8292-6bd35e792631";
const FOLDER_B = "29004b7f-cf4f-4308-9109-a725f2237130";
const BASE = "http://127.0.0.1:4173";

import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db", { readonly: true });
function state() {
  return db.prepare("SELECT id, display_name, source_id, json_extract(metadata, '$.formerSourceId') as former FROM watched_folders").all();
}

async function attach(projectId, folderId) {
  const r = await fetch(`${BASE}/api/projects/${projectId}/folders`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folderIds: [folderId] })
  });
  return r.json();
}

async function detach(projectId, folderId) {
  const r = await fetch(`${BASE}/api/projects/${projectId}/folders`, {
    method: "DELETE", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folderIds: [folderId] })
  });
  return r.json();
}

async function main() {
  console.log("=== Step 0: initial state ===");
  console.log(state().map(f => `  ${f.display_name.padEnd(10)} src=${(f.source_id || "NULL").slice(0,8)} former=${(f.former || "null").slice(0,8)}`).join("\n"));

  // First restore folder-a: re-attach to汇集1 so it's no longer orphan
  console.log("\n=== Step 1: re-attach folder-a to 汇集1 (restore) ===");
  const r1 = await attach(HUIJI1, FOLDER_A);
  console.log("  result:", JSON.stringify(r1));

  console.log("\n=== Step 2: attach folder-a → 汇集2 ===");
  const r2 = await attach(HUIJI2, FOLDER_A);
  console.log("  result:", JSON.stringify(r2));
  console.log(state().map(f => `  ${f.display_name.padEnd(10)} src=${(f.source_id || "NULL").slice(0,8)} former=${(f.former || "null").slice(0,8)}`).join("\n"));

  console.log("\n=== Step 3: detach folder-a from 汇集2 (former is now 汇集1, should restore) ===");
  const r3 = await detach(HUIJI2, FOLDER_A);
  console.log("  result:", JSON.stringify(r3));
  console.log(state().map(f => `  ${f.display_name.padEnd(10)} src=${(f.source_id || "NULL").slice(0,8)} former=${(f.former || "null").slice(0,8)}`).join("\n"));

  console.log("\n=== Step 4: detach folder-a from 汇集1 (former is null now, should orphan) ===");
  const r4 = await detach(HUIJI1, FOLDER_A);
  console.log("  result:", JSON.stringify(r4));
  console.log(state().map(f => `  ${f.display_name.padEnd(10)} src=${(f.source_id || "NULL").slice(0,8)} former=${(f.former || "null").slice(0,8)}`).join("\n"));

  console.log("\n=== Step 5: re-attach folder-a → 汇集1 ===");
  const r5 = await attach(HUIJI1, FOLDER_A);
  console.log("  result:", JSON.stringify(r5));
}

main().then(() => db.close()).catch(e => { console.error(e); db.close(); process.exit(1); });