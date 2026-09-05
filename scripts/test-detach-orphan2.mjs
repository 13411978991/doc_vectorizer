// Specifically test the new fallback: detach a folder with former=null + currentSource===projectId
// This sets up: detach → re-attach (records former) → detach (former is now set, normal path)
// To force former=null: need to manually scrub metadata
import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db");

// Force folder-b metadata to drop formerSourceId so we hit the new fallback branch
db.prepare("UPDATE watched_folders SET metadata = '{}' WHERE id = ?").run("29004b7f-cf4f-4308-9109-a725f2237130");
console.log("=== forced folder-b metadata = '{}' ===");

const BASE = "http://127.0.0.1:4173";
const HUIJI1 = "d65db8c0-a432-43e9-8262-2e52895f5764";
const FOLDER_B = "29004b7f-cf4f-4308-9109-a725f2237130";

async function getWf() {
  const r = await fetch(`${BASE}/api/watched-folders?tenantId=default`);
  const d = await r.json();
  return d.folders ?? d;
}

async function detach(projectId, folderId) {
  const r = await fetch(`${BASE}/api/projects/${projectId}/folders`, {
    method: "DELETE", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folderIds: [folderId] })
  });
  return r.json();
}

async function attach(projectId, folderId) {
  const r = await fetch(`${BASE}/api/projects/${projectId}/folders`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folderIds: [folderId] })
  });
  return r.json();
}

async function main() {
  console.log("\n=== BEFORE: watched_folders ===");
  for (const f of await getWf()) {
    console.log(`  ${f.displayName.padEnd(10)} src=${f.sourceId ?? "NULL"} former=${f.metadata?.formerSourceId ?? "null"}`);
  }

  console.log("\n=== Detach folder-b from 汇集1 (former=null, currentSource===projectId, should orphan) ===");
  const r = await detach(HUIJI1, FOLDER_B);
  console.log("  result:", JSON.stringify(r));

  console.log("\n=== AFTER: watched_folders ===");
  for (const f of await getWf()) {
    console.log(`  ${f.displayName.padEnd(10)} src=${f.sourceId ?? "NULL"} former=${f.metadata?.formerSourceId ?? "null"}`);
  }

  // restore
  console.log("\n=== Restore: re-attach to汇集1 ===");
  const restore = await attach(HUIJI1, FOLDER_B);
  console.log("  result:", JSON.stringify(restore));
}

main().catch(e => { console.error(e); db.close(); process.exit(1); });
db.close();