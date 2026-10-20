import { readFileSync, writeFileSync } from "node:fs";
let text = readFileSync("web/src/App.tsx", "utf8");
const before = text.length;

// Line 6289: `<chinese>。, : "<chinese>。"` (corruption: lost quote between)
// Re-fix: revert my last "fix" — the comma was wrong, restore `:` (ternary)
text = text.replace(/(\u3002),(\s+:)/g, '$1$2');

// Line 6559: `<option value="">。{t("选择", "Select")} 。/option>`
// Should be `<option value="">。{t("选择", "Select")} 。</option>`
text = text.replace(/\u3002\/option>/g, '\u3002</option>');

writeFileSync("web/src/App.tsx", text);
console.log("Before:", before, "After:", text.length);