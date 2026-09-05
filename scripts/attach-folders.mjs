const res = await fetch("http://127.0.0.1:4173/api/projects/d65db8c0-a432-43e9-8262-2e52895f5764/folders", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    folderIds: [
      "29004b7f-cf4f-4308-9109-a725f2237130", // folder-b
      "c3c6a740-9d61-45df-8292-6bd35e792631"  // folder-a
    ]
  })
});
console.log(res.status, await res.text());