import { readFileSync, writeFileSync } from "node:fs";

const path = "web/src/App.tsx";
let text = readFileSync(path, "utf8");
const before = text.length;

// Convert all 。": " to 。", " (corruption cleanup)
let count = 0;
text = text.replace(/\u3002": "/g, (m) => {
  count++;
  return '\u3002", "';
});

console.log("Replaced:", count, "patterns");

// Restore the ONE legitimate ternary at line 6289
// Pattern: isCreatingNew ? "...": "...") where the first part is "新建知识。"
// We'll do a targeted restoration: replace `isCreatingNew ? "新建知识。", "` with `isCreatingNew ? "新建知识。": "`
const ternaryMarker = 'isCreatingNew ? "\u65b0\u5efa\u77e5\u8bc6\u3002", "\u77e5\u8bc6\u5e93\u8be6\u3002"';
const ternaryFixed = 'isCreatingNew ? "\u65b0\u5efa\u77e5\u8bc6\u3002": "\u77e5\u8bc6\u5e93\u8be6\u3002"';
const beforeMark = text.includes(ternaryMarker);
const beforeTernary = text.includes(ternaryFixed);
console.log("Found broken ternary:", beforeMark);
console.log("Found fixed ternary (already?):", beforeTernary);
if (beforeMark) {
  text = text.replace(ternaryMarker, ternaryFixed);
  console.log("Restored ternary to colon");
}

writeFileSync(path, text, "utf8");
console.log("before:", before, "after:", text.length);