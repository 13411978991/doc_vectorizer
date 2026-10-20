import { readFileSync } from "node:fs";
const js = readFileSync("web/dist/assets/index-BlGkx_dQ.js", "utf8");

// testid may be minified too
const testids = [...js.matchAll(/data-testid:[^,]+/g)].slice(0, 10);
testids.forEach(m => console.log("testid pattern:", m[0].slice(0, 80)));

// Look for testids near the LLM provider code
const idx = js.indexOf("hy-mt2-7b");
if (idx > -1) {
  console.log("\nContext around hy-mt2-7b (idx=" + idx + "):");
  console.log(JSON.stringify(js.slice(Math.max(0, idx - 200), idx + 200)));
}

const idx2 = js.indexOf("\u8fdc\u7a0b API");
if (idx2 > -1) {
  console.log("\nContext around 远程 API (idx=" + idx2 + "):");
  console.log(JSON.stringify(js.slice(Math.max(0, idx2 - 200), idx2 + 200)));
}

// Search for testid in minified bundle, possibly written with prop names
const tests = [...js.matchAll(/["']data-testid["']/g)];
console.log("\ndata-testid occurrences:", tests.length);