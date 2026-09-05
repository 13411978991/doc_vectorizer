// Search test against "汇集功能" KB
const BASE = "http://127.0.0.1:4173";

async function listKbProjects() {
  const r = await fetch(`${BASE}/api/kb-projects`);
  return (await r.json()).projects;
}

async function getKbDetail(kbId) {
  const r = await fetch(`${BASE}/api/kb-projects/${kbId}`);
  return await r.json();
}

async function search(kbId, query) {
  const r = await fetch(`${BASE}/api/kb-projects/${kbId}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, limit: 10 })
  });
  return await r.json();
}

async function main() {
  const projs = await listKbProjects();
  console.log("=== KB Projects ===");
  for (const p of projs) console.log(`  ${p.name.padEnd(20)} id=${p.id} cachedDocs=${p.cachedDocumentsCount}`);

  const huijiGn = projs.find(p => p.name === "汇集功能");
  if (!huijiGn) {
    console.log("No '汇集功能' KB found");
    return;
  }
  console.log(`\n=== Detail of 汇集功能 (id=${huijiGn.id}) ===`);
  const detail = await getKbDetail(huijiGn.id);
  console.log(`  name=${detail.project.name}`);
  console.log(`  cached: docs=${detail.project.cachedDocumentsCount}, chunks=${detail.project.cachedChunksCount}, entities=${detail.project.cachedEntitiesCount}`);
  console.log(`  sources:`);
  for (const s of detail.sources) {
    console.log(`    ${s.name} type=${s.sourceType} wfId=${s.watchedFolderId} folderPath=${s.folderPath ?? "null"}`);
  }

  console.log("\n=== Search 'folder-a' ===");
  const r1 = await search(huijiGn.id, "folder-a");
  console.log(`  total=${r1.total ?? r1.results?.length}, results=${r1.results?.length ?? 0}`);
  for (const x of (r1.results ?? []).slice(0, 5)) console.log(`    - ${x.title ?? x.id?.slice(0,8)}`);

  console.log("\n=== Search 'folder-b' ===");
  const r2 = await search(huijiGn.id, "folder-b");
  console.log(`  total=${r2.total ?? r2.results?.length}, results=${r2.results?.length ?? 0}`);
  for (const x of (r2.results ?? []).slice(0, 5)) console.log(`    - ${x.title ?? x.id?.slice(0,8)}`);

  console.log("\n=== Search 'report' (sample content in folder-a) ===");
  const r3 = await search(huijiGn.id, "report");
  console.log(`  total=${r3.total ?? r3.results?.length}, results=${r3.results?.length ?? 0}`);
  for (const x of (r3.results ?? []).slice(0, 5)) console.log(`    - ${x.title ?? x.id?.slice(0,8)}`);

  console.log("\n=== Search '测试' ===");
  const r4 = await search(huijiGn.id, "测试");
  console.log(`  total=${r4.total ?? r4.results?.length}, results=${r4.results?.length ?? 0}`);
  for (const x of (r4.results ?? []).slice(0, 5)) console.log(`    - ${x.title ?? x.id?.slice(0,8)}`);
}

main().catch(e => console.error(e));