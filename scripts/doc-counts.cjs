// doc-counts.cjs — count documents in the documents table for the
// 审计核心文档 project, and check the project->folder mapping.
const Database = require("better-sqlite3");
const db = new Database(
  "E:/sag/完整后端版本/源码/doc_vectorizer/release-desktop/win-unpacked/resources/data/sag.db",
  { readonly: true }
);
const folder = "7ba960d6-055f-42ac-a7f4-691e29e351fa";
const total = db.prepare("select count(*) as n from documents").get();
const byFolder = db.prepare("select source_id, count(*) as n from documents group by source_id").all();
const docFolderLink = db.prepare("select folder_id, count(*) as n from watched_folder_manifests where last_event is not null group by folder_id").all();
console.log("total documents (all projects):", total);
console.log("docs by source_id:", byFolder);
console.log("manifest rows by folder_id:", docFolderLink);

// Find the project id of 审计核心文档 folder via watched_folders
const folderInfo = db.prepare("select * from watched_folders where id = ?").get(folder);
console.log("folder:", folderInfo);
if (folderInfo) {
  const projectId = folderInfo.project_id ?? folderInfo.tenantId;
  console.log("project id:", projectId);
  const proj = db.prepare("select id, name from sources where id = ?").get(projectId);
  console.log("source:", proj);
}
db.close();
