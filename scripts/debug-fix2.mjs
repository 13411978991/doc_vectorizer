import { readFileSync, writeFileSync } from "node:fs";
let text = readFileSync("web/src/App.tsx", "utf8");

// Look for "。);"
const matches = [...text.matchAll(/\u3002\);/g)];
console.log("Matches for 。);:", matches.length);
matches.slice(0, 5).forEach(m => console.log(`  at ${m.index}: ...${text.slice(Math.max(0, m.index - 10), m.index + 10)}...`));

// Also try 。
const matches2 = [...text.matchAll(/\u3002/g)];
console.log("\nAll 。 matches:", matches2.length);

// Check if there are any ");}" 
const matches3 = [...text.matchAll(/\);/g)];
console.log("\nAll ); matches:", matches3.length);
matches3.slice(0, 5).forEach(m => console.log(`  at ${m.index}: ...${text.slice(Math.max(0, m.index - 5), m.index + 5)}...`));