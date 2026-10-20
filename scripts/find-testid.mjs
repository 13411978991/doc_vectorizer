// scripts/find-testid.mjs
import { readFileSync } from "node:fs";
const bundle = readFileSync("web/dist/assets/index-BZPRoTyj.js", "utf8");

// Find llm-provider-api
let idx = bundle.indexOf("llm-provider-api");
if (idx === -1) {
  console.log("llm-provider-api NOT FOUND");
  process.exit(1);
}

console.log(`Found llm-provider-api at ${idx}`);
console.log("\nContext (300 chars before, 200 after):");
console.log(bundle.substring(Math.max(0, idx - 300), idx + 200));