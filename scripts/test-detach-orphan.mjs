// Test detach-without-former: detach a folder that's currently attached but has no formerSourceId
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

async function main() {
  console.log("=== BEFORE: watched_folders ===");
  const before = await getWf();
  for (const f of before) {
    const frm = f.metadata?.formerSourceId ?? "null";
    console.log(`  ${f.displayName.padEnd(10)} src=${f.sourceId ?? "NULL"} former=${frm}`);
  }

  console.log("\n=== Detach folder-b from 汇集1 (folder-b has former=null) ===");
  const result = await detach(HUIJI1, FOLDER_B);
  console.log("  result:", JSON.stringify(result));

  console.log("\n=== AFTER: watched_folders ===");
  const after = await getWf();
  for (const f of after) {
    const frm = f.metadata?.formerSourceId ?? "null";
    console.log(`  ${f.displayName.padEnd(10)} src=${f.sourceId ?? "NULL"} former=${frm}`);
  }

  // Restore for next tests: re-attach to汇集1 (will set source back)
  console.log("\n=== Re-attach folder-b to 汇集1 to restore ===");
  const restore = await fetch(`${BASE}/api/projects/${HUIJI1}/folders`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folderIds: [FOLDER_B] })
  });
  console.log("  result:", await restore.text());
}

main().catch(e => { console.error(e); process.exit(1); });