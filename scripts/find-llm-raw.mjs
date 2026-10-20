import { readFileSync } from "node:fs";
const bundle = readFileSync("web/dist/assets/index-BZPRoTyj.js", "utf8");

const matches = [...bundle.matchAll(/[^a-zA-Z]llm-provider[^a-zA-Z]/g)];
for (const m of matches) {
  const idx = m.index;
  console.log(`At ${idx}: ${bundle.substring(Math.max(0, idx - 50), idx + 80)}`);
}