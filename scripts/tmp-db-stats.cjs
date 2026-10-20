const db = require('better-sqlite3')('E:/临时存储/SAG-桌面版-portable/resources/data/sag.db', { readonly: true, fileMustExist: true });
const docs = db.prepare("select count(*) as n from documents where source_id = '6dbd2772-7f68-4ecd-a2a3-9c3bc32c86f4'").get();
console.log('docs in 审计核心文档 project:', JSON.stringify(docs));
// try archived column
try { const c = db.prepare("select count(*) as n, archived from documents where source_id = '6dbd2772-7f68-4ecd-a2a3-9c3bc32c86f4' group by archived").all(); console.log('with archived:', c); } catch(e) { console.log('no archived'); }
try { const c = db.prepare("select count(*) as n, archived_at from documents where source_id = '6dbd2772-7f68-4ecd-a2a3-9c3bc32c86f4' group by archived_at is not null").all(); console.log('archived_at not null:', c); } catch(e) { console.log('no archived_at'); }
// all docs
const dcols = db.prepare("pragma table_info(documents)").all();
console.log('docs cols:');
for (const c of dcols) console.log('  ', c.name, c.type);
