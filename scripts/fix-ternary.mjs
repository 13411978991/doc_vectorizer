import { readFileSync, writeFileSync } from "node:fs";
let text = readFileSync("web/src/App.tsx", "utf8");
const before = text.length;

// Line 6289 has `isCreatingNew ? "新建知识。", "知识库详。"` — comma instead of colon
// Line 6289: ternary had `,"` (comma + close quote) but should be `:"` (colon + close quote)
// Only apply within ternary pattern: `<chinese>。",` followed by `"<chinese>` indicates ternary arm separator
text = text.replace(/\u3002",(\s*)"/g, '\u3002":$1"');
// Also handle `。", : "<chinese>` (rare but possible)

writeFileSync("web/src/App.tsx", text);
console.log("Before:", before, "After:", text.length);