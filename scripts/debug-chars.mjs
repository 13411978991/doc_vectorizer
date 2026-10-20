import { readFileSync } from "node:fs";
const text = readFileSync("web/src/App.tsx", "utf8");
const idx = text.indexOf(" : ");
console.log("idx:", idx);
for (let i = idx - 3; i < idx + 5; i++) {
  console.log("[" + i + "]: " + JSON.stringify(text[i]) + " (0x" + text.charCodeAt(i).toString(16) + ")");
}