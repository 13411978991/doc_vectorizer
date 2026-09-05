// Full mount/unmount test (API + KB source dual-model)
// Sources-model IDs (project-routes): what watched_folders.source_id references
const HUIJI1 = "d65db8c0-a432-43e9-8262-2e52895f5764";
const HUIJI2 = "5038ddb0-8cc0-47b1-9dd5-4cd45b8dc347";
// KB-model IDs (kb_projects table)
const HUIJI1_KB = "2a0b8621-0d8a-494e-9aa7-eac518544fbf";
const HUIJI2_KB = "a75042b4-26be-4dde-83f6-b41492cf2544";
const FOLDER_A = "c3c6a740-9d61-45df-8292-6bd35e792631";
const FOLDER_B = "29004b7f-cf4f-4308-9109-a725f2237130";
const BASE = "http://127.0.0.1:4173";

async function getWatchedFolders() {
  const r = await fetch(`${BASE}/api/watched-folders?tenantId=default`);
  const data = await r.json();
  return data.folders ?? data;
}

async function getKbDetail(kbProjectId) {
  const r = await fetch(`${BASE}/api/kb-projects/${kbProjectId}`);
  const data = await r.json();
  return data;
}

async function attach(projectId, folderId) {
  const r = await fetch(`${BASE}/api/projects/${projectId}/folders`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folderIds: [folderId] })
  });
  return r.json();
}

async function addKbSource(kbProjectId, folderId, name) {
  const r = await fetch(`${BASE}/api/kb-projects/${kbProjectId}/sources`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source_type: "folder", name, watched_folder_id: folderId })
  });
  return { status: r.status, body: await r.json() };
}

async function detach(projectId, folderId) {
  const r = await fetch(`${BASE}/api/projects/${projectId}/folders`, {
    method: "DELETE", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folderIds: [folderId] })
  });
  return r.json();
}

async function removeKbSource(kbProjectId, sourceId) {
  const r = await fetch(`${BASE}/api/kb-projects/${kbProjectId}/sources/${sourceId}`, { method: "DELETE" });
  return { status: r.status, body: await r.json() };
}

function printFolders(rows, label) {
  console.log(`\n=== ${label} ===`);
  for (const r of rows) {
    const src = r.sourceId === HUIJI1 ? "汇集1" : r.sourceId === HUIJI2 ? "汇集2" : r.sourceId;
    const frm = r.metadata?.formerSourceId
      ? (r.metadata.formerSourceId === HUIJI1 ? "汇集1"
        : r.metadata.formerSourceId === HUIJI2 ? "汇集2"
        : r.metadata.formerSourceId.slice(0,8))
      : "null";
    console.log(`  ${r.displayName.padEnd(10)} src=${src} former=${frm}`);
  }
}

async function printKbSources(kbProjectId, label) {
  const detail = await getKbDetail(kbProjectId);
  const sources = detail.sources ?? [];
  console.log(`  KB sources for ${label}: ${sources.length}`);
  for (const s of sources) {
    console.log(`    ${s.name ?? s.id} type=${s.sourceType ?? "?"} wfId=${s.watchedFolderId ?? "null"} kbSrcId=${s.id}`);
  }
  return sources;
}

async function main() {
  console.log("========== STEP 1: Initial state ==========");
  const wf1 = await getWatchedFolders();
  printFolders(wf1, "watched_folders");
  await printKbSources(HUIJI1_KB, "汇集1 (KB)");
  await printKbSources(HUIJI2_KB, "汇集2 (KB)");

  console.log("\n========== STEP 2: Attach folder-a → 汇集2 (sources model) + add KB source ==========");
  const attachResult = await attach(HUIJI2, FOLDER_A);
  console.log("  attach result:", JSON.stringify(attachResult));
  const kbResult = await addKbSource(HUIJI2_KB, FOLDER_A, "folder-a");
  console.log("  kb add result:", JSON.stringify(kbResult));

  const wf2 = await getWatchedFolders();
  printFolders(wf2, "watched_folders after attach");
  await printKbSources(HUIJI1_KB, "汇集1 (KB)");
  await printKbSources(HUIJI2_KB, "汇集2 (KB)");

  console.log("\n========== STEP 3: Detach folder-a from 汇集2 (sources + KB) ==========");
  const detachResult = await detach(HUIJI2, FOLDER_A);
  console.log("  detach result:", JSON.stringify(detachResult));
  const kbSources2 = (await getKbDetail(HUIJI2_KB)).sources ?? [];
  const folderASource = kbSources2.find(s => s.watchedFolderId === FOLDER_A);
  if (folderASource) {
    const removeResult = await removeKbSource(HUIJI2_KB, folderASource.id);
    console.log("  kb remove result:", JSON.stringify(removeResult));
  } else {
    console.log("  no kb source for folder-a");
  }

  const wf3 = await getWatchedFolders();
  printFolders(wf3, "watched_folders after detach");
  await printKbSources(HUIJI1_KB, "汇集1 (KB)");
  await printKbSources(HUIJI2_KB, "汇集2 (KB)");

  console.log("\n========== STEP 4: Detach folder-b from 汇集1 (no-op, folder already here) ==========");
  const detachB = await detach(HUIJI1, FOLDER_B);
  console.log("  detach folder-b from 汇集1:", JSON.stringify(detachB));

  const wf4 = await getWatchedFolders();
  printFolders(wf4, "watched_folders final");

  console.log("\n========== DONE ==========");
}

main().catch(e => { console.error(e); process.exit(1); });