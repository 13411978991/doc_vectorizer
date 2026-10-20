import Database from 'better-sqlite3';
const db = new Database('D:\\SAG\\doc_vectorizer\\dist-package\\本地知识检索-0.1.0\\resources\\data\\sag.db');
const rows = db.prepare(`
  SELECT m.rel_path, m.document_id, m.status, d.title
  FROM watched_folder_manifests m
  LEFT JOIN documents d ON d.id = m.document_id
  WHERE m.folder_id = 'd07cb0fa-04e8-4bc5-adba-65455a9b0e2f'
  ORDER BY m.rel_path
  LIMIT 10
`).all();
console.log('Manifest entries (first 10):', JSON.stringify(rows, null, 2));
db.close();
