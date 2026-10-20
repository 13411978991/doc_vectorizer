import { readFileSync } from "node:fs";
const content = readFileSync("web/dist/assets/index-BZPRoTyj.js", "utf8");
// Find all llmProvider occurrences and show context
let idx = 0;
let count = 0;
while ((idx = content.indexOf("llmProvider", idx)) !== -1) {
  count++;
  const start = Math.max(0, idx - 100);
  const end = Math.min(content.length, idx + 150);
  console.log(`\n=== Match #${count} at ${idx} ===`);
  console.log(content.substring(start, end));
  idx += 1;
}
console.log(`\nTotal matches: ${count}`);