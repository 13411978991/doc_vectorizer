import { readFileSync } from "node:fs";
let text = readFileSync("web/src/App.tsx", "utf8");

// Look for `。" });` (with space)
const m1 = [...text.matchAll(/\u3002"\s*\};/g)];
console.log('Matches for 。" }:', m1.length);
m1.slice(0, 3).forEach(m => console.log(`  at ${m.index}: ...${text.slice(m.index - 15, m.index + 15)}...`));

// Look for `。" );`
const m2 = [...text.matchAll(/\u3002"\s*\);/g)];
console.log('\nMatches for 。" );:', m2.length);
m2.slice(0, 3).forEach(m => console.log(`  at ${m.index}: ...${text.slice(m.index - 15, m.index + 15)}...`));

// Look for `。"\\n}` (newline before })
const m3 = [...text.matchAll(/\u3002"\s*\}/g)];
console.log('\nMatches for 。" }:', m3.length);
m3.slice(0, 5).forEach(m => console.log(`  at ${m.index}: ...${JSON.stringify(text.slice(m.index - 5, m.index + 10))}...`));