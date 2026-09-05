const ids = JSON.stringify(["c3c6a740-9d61-45df-8292-6bd35e792631", "29004b7f-cf4f-4308-9109-a725f2237130"]);
const r1 = await fetch("http://127.0.0.1:4173/api/kb-projects");
const kbs = await r1.json();
const kb1 = kbs.projects.find(p => p.name === '汇集1');
console.log("kb1:", JSON.stringify(kb1));
const r2 = await fetch(`http://127.0.0.1:4173/api/kb-projects/${kb1.id}/sources`, {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({folderIds: ids})
});
console.log("attach:", r2.status, await r2.text());