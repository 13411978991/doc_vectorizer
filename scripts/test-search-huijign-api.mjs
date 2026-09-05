// Search via the same shape the MCP stdio server uses — POST /api/search with sourceIds.
const BASE = "http://127.0.0.1:4173";
const HUIJIGN_SRC = "59bfcc4d-2da3-43b1-a539-9fe605ad0d36";

async function search(query, sourceIds) {
  const r = await fetch(`${BASE}/api/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, sourceIds, topK: 5 })
  });
  return { status: r.status, body: await r.json() };
}

async function main() {
  console.log("=== Search 'folder-a' in 汇集功能 ===");
  console.log(JSON.stringify(await search("folder-a", [HUIJIGN_SRC]), null, 2));

  console.log("\n=== Search 'folder-b' in 汇集功能 ===");
  console.log(JSON.stringify(await search("folder-b", [HUIJIGN_SRC]), null, 2));

  console.log("\n=== Search 'report' (folder-a content) ===");
  console.log(JSON.stringify(await search("report", [HUIJIGN_SRC]), null, 2));
}

main().catch(e => console.error(e));