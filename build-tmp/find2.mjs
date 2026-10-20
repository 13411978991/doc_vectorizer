import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const p = resolve("web/dist/assets/index-BZPRoTyj.js");
const content = readFileSync(p, "utf8");
const idx = content.indexOf("llmProvider");
if (idx < 0) {
  console.log("llmProvider NOT in bundle");
} else {
  console.log("llmProvider at offset", idx);
  console.log(content.substring(Math.max(0, idx - 200), Math.min(1500, content.length - idx + 200)));
}