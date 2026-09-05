// Attach folder-a + folder-b to 汇集功能 (sources model + KB model), then search
const BASE = "http://127.0.0.1:4173";
const HUIJIGN_SRC = "59bfcc4d-2da3-43b1-a539-9fe605ad0d36";  // sources-model
const HUIJIGN_KB = "702dc4df-0958-4a86-ab23-7ed85d1e51b4";   // kb-model
const HUIJI1_SRC = "d65db8c0-a432-43e9-8262-2e52895f5764";
const FOLDER_A = "c3c6a740-9d61-45df-8292-6bd35e792631";
const FOLDER_B = "29004b7f-cf4f-4308-9109-a725f2237130";

async function attachSrc(projectId, folderId) {
  const r = await fetch(`${BASE}/api/projects/${projectId}/folders`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folderIds: [folderId] })
  });
  return await r.json();
}
async function detachSrc(projectId, folderId) {
  const r = await fetch(`${BASE}/api/projects/${projectId}/folders`, {
    method: "DELETE", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folderIds: [folderId] })
  });
  return await r.json();
}
async function addKbSource(kbId, folderId, name) {
  const r = await fetch(`${BASE}/api/kb-projects/${kbId}/sources`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source_type: "folder", name, watched_folder_id: folderId })
  });
  return { status: r.status, body: await r.json() };
}
async function getKbDetail(kbId) {
  return await (await fetch(`${BASE}/api/kb-projects/${kbId}`)).json();
}
async function search(kbId, query) {
  const r = await fetch(`${BASE}/api/kb-projects/${kbId}/search`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, limit: 10 })
  });
  return { status: r.status, body: await r.json() };
}

async function main() {
  console.log("=== Step 1: attach folder-a + folder-b to 汇集功能 (both models) ===");
  // detach first from 汇集1 to avoid double-attachment
  console.log("detach folder-a from 汇集1:", JSON.stringify(await detachSrc(HUIJI1_SRC, FOLDER_A)));
  console.log("detach folder-b from 汇集1:", JSON.stringify(await detachSrc(HUIJI1_SRC, FOLDER_B)));

  console.log("attach folder-a → 汇集功能 (sources):", JSON.stringify(await attachSrc(HUIJIGN_SRC, FOLDER_A)));
  console.log("attach folder-b → 汇集功能 (sources):", JSON.stringify(await attachSrc(HUIJIGN_SRC, FOLDER_B)));
  console.log("attach folder-a → 汇集功能 (KB):", JSON.stringify(await addKbSource(HUIJIGN_KB, FOLDER_A, "folder-a")));
  console.log("attach folder-b → 汇集功能 (KB):", JSON.stringify(await addKbSource(HUIJIGN_KB, FOLDER_B, "folder-b")));

  // wait a bit for stats refresh
  await new Promise(r => setTimeout(r, 1500));

  console.log("\n=== Step 2: KB detail ===");
  const d = await getKbDetail(HUIJIGN_KB);
  console.log(`  cached: docs=${d.project.cachedDocumentsCount}, chunks=${d.project.cachedChunksCount}, entities=${d.project.cachedEntitiesCount}`);
  for (const s of d.sources) {
    console.log(`  source ${s.name} type=${s.sourceType} wfId=${s.watchedFolderId} folderPath=${s.folderPath ?? "null"}`);
  }

  console.log("\n=== Step 3: search 'folder-a' ===");
  const r1 = await search(HUIJIGN_KB, "folder-a");
  console.log(`  status=${r1.status} body=${JSON.stringify(r1.body).slice(0, 500)}`);

  console.log("\n=== Step 4: search 'folder-b' ===");
  const r2 = await search(HUIJIGN_KB, "folder-b");
  console.log(`  status=${r2.status} body=${JSON.stringify(r2.body).slice(0, 500)}`);

  console.log("\n=== Step 5: search 'report' (folder-a content) ===");
  const r3 = await search(HUIJIGN_KB, "report");
  console.log(`  status=${r3.status} body=${JSON.stringify(r3.body).slice(0, 500)}`);
}

main().catch(e => console.error(e));