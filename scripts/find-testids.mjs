import { readFileSync } from "node:fs";
const bundle = readFileSync("web/dist/assets/index-BZPRoTyj.js", "utf8");

// Find "llm-provider" (no quotes in source, but JSX attribute string adds quotes)
const matches = [...bundle.matchAll(/data-testid:"llm-provider-\w+"/g)];
console.log(`Found ${matches.length} data-testid markers for llm-provider-*: ${matches.map(m => m[0]).join(", ")}`);

// Look 100 chars around each
for (const m of matches) {
  const idx = m.index;
  console.log(`\nAt ${idx}:`);
  console.log(bundle.substring(Math.max(0, idx - 50), idx + 100));
}