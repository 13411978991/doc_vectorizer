import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db");
// Force folder-a's metadata to '{}' (no formerSourceId) AND source = 汇集1
// folder-a is currently source_id=d65db8c0 (汇集1) with former=null
console.log("=== Pre-state ===");
const pre = db.prepare("SELECT id, display_name, source_id, metadata FROM watched_folders WHERE id = ?").get("c3c6a740-9d61-45df-8292-6bd35e792631");
console.log(JSON.stringify(pre));

const BASE = "http://127.0.0.1:4173";
const HUIJI1 = "d65db8c0-a432-43e9-8262-2e52895f5764";
const FOLDER_A = "c3c6a740-9d61-45df-8292-6bd35e792631";

async function detach() {
  const r = await fetch(`${BASE}/api/projects/${HUIJI1}/folders`, {
    method: "DELETE", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folderIds: [FOLDER_A] })
  });
  return r.json();
}

async function attach() {
  const r = await fetch(`${BASE}/api/projects/${HUIJI1}/folders`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folderIds: [FOLDER_A] })
  });
  return r.json();
}

async function main() {
  console.log("\n=== Detach folder-a from 汇集1 (former=null, currentSource===projectId) ===");
  const r = await detach();
  console.log("  result:", JSON.stringify(r));

  console.log("\n=== Post-state ===");
  const post = db.prepare("SELECT id, display_name, source_id, metadata FROM watched_folders WHERE id = ?").get(FOLDER_A);
  console.log(JSON.stringify(post));

  // Restore
  console.log("\n=== Restore ===");
  const a = await attach();
  console.log("  result:", JSON.stringify(a));
  const restored = db.prepare("SELECT id, source_id, metadata FROM watched_folders WHERE id = ?").get(FOLDER_A);
  console.log(JSON.stringify(restored));
}

main().catch(e => { console.error(e); db.close(); process.exit(1); });
db.close();