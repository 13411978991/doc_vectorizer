// scripts/find-toggle.mjs — Find all setLlmProvider occurrences in the bundle
import { readFileSync, writeFileSync } from "node:fs";
const bundle = readFileSync("web/dist/assets/index-BZPRoTyj.js", "utf8");

const log = [];
let idx = 0;
let count = 0;
while ((idx = bundle.indexOf("setLlmProvider", idx)) !== -1) {
  count++;
  const start = Math.max(0, idx - 100);
  const end = Math.min(bundle.length, idx + 150);
  log.push(`#${count} at ${idx}:\n${bundle.substring(start, end)}\n---`);
  idx += 1;
}

log.push(`\nTotal setLlmProvider occurrences: ${count}`);

// Also find useEffect with llmProvider
const useEffectMatch = bundle.match(/useEffect.{0,200}llmProvider/);
log.push(`\nuseEffect mentioning llmProvider: ${useEffectMatch ? useEffectMatch[0].slice(0, 200) : "NOT FOUND"}`);

writeFileSync("build-tmp/find-toggle.log", log.join("\n"));
console.log(log.join("\n"));