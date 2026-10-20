import { readFileSync } from "node:fs";
const text = readFileSync("web/src/App.tsx", "utf8");
const re = /\u3002, /g;
const matches = [...text.matchAll(re)];
console.log("Found:", matches.length);
console.log("Sample contexts:");
matches.slice(0, 5).forEach(m => {
  console.log(JSON.stringify(text.slice(Math.max(0, m.index - 10), m.index + 20)));
});