import { readFileSync } from "node:fs";
const bundle = readFileSync("web/dist/assets/index-BZPRoTyj.js", "utf8");

// Search for "data-testid:" in any form
const matches = [...bundle.matchAll(/data-testid:[^,}\s]{1,40}/g)];
console.log(`Total data-testid: matches: ${matches.length}`);
console.log(`First 20: ${matches.slice(0, 20).map(m => m[0]).join(", ")}`);

// Check for "llm-provider" (no quotes)
const llmMatches = [...bundle.matchAll(/[^a-zA-Z]llm-provider[^a-zA-Z]/g)];
console.log(`\n"llm-provider" matches: ${llmMatches.length}`);

// Search for "llm" as a substring
const llmMatches2 = [...bundle.matchAll(/"llm\w+"/g)];
console.log(`\n"llm*" string matches: ${llmMatches2.map(m => m[0]).slice(0, 10).join(", ")}`);