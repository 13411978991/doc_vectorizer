// Look at entity metadata to see source
import Database from 'better-sqlite3';
const db = new Database('D:/SAG/doc_vectorizer/dist-package/本地知识检索-0.1.0/resources/data/sag.db', {readonly: true});

const SOURCE_ID = '0b3a4db2-b71b-4c67-b2e9-d4def71c5cd2';

// Show entity metadata + count types
const stats = db.prepare(`
  select type, count(*) as c from entities where source_id = ? group by type order by c desc
`).all(SOURCE_ID);
console.log('Audit-2024-Q1 entity types:', JSON.stringify(stats, null, 2));

// Show a few entities with their metadata
const samples = db.prepare(`
  select name, type, metadata from entities where source_id = ? limit 20
`).all(SOURCE_ID);
for (const s of samples) {
  console.log(`  [${s.type.padEnd(10)}] ${s.name} (metadata: ${s.metadata})`);
}

// Now check if document content has any person/location/org in raw text
// so we know whether NER *should* return them
const docsWithNERContent = db.prepare(`
  select id, title, content from documents where source_id = ? and length(content) > 100
  order by length(content) desc limit 5
`).all(SOURCE_ID);

console.log('\n=== Document contents preview ===');
for (const d of docsWithNERContent) {
  // look for entity-like patterns
  const personPattern = /[\u4e00-\u9fa5]{2,4}/g;
  const orgPattern = /[\u4e00-\u9fa5]{2,10}(?:公司|集团|银行|大学|医院|事务所|委员会)/g;
  const locPattern = /[\u4e00-\u9fa5]{2,10}(?:北京|上海|广州|深圳|杭州|香港|澳门|台湾|省|市|区|县|国)/g;
  const personMatches = new Set((d.content.match(personPattern) || []).slice(0, 20));
  const orgMatches = new Set((d.content.match(orgPattern) || []));
  const locMatches = new Set((d.content.match(locPattern) || []));
  console.log(`\n${d.title}:`);
  console.log(`  Orgs: ${[...orgMatches].join(', ')}`);
  console.log(`  Locs: ${[...locMatches].join(', ')}`);
  console.log(`  (sample person-like: ${[...personMatches].slice(0, 10).join(', ')})`);
}