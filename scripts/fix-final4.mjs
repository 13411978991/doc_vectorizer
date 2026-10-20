import { readFileSync, writeFileSync } from "node:fs";
let text = readFileSync("web/src/App.tsx", "utf8");
const before = text.length;

// Line 6289: `? "新建知识。 : "知识库详。")` → `? "新建知识。", "知识库详。")`
// The ` : ` between strings (ternary separator) should be `", ` (comma)
// Pattern: `"<chinese>。 : "<chinese>。` → `"<chinese>。", "<chinese>。`
text = text.replace(/\u3002\s+:\s+"\u65b0/g, '\u3002", "\u65b0'); // 新
text = text.replace(/\u3002\s+:\s+"\u77e5/g, '\u3002", "\u77e5'); // 知
text = text.replace(/\u3002\s+:\s+"/g, '\u3002", "');

// Line 6772: `icon: "\uD83D\uDF78。` — the closing `"` is missing after emoji + period
text = text.replace(/\uD83C\uDF78\u3002\s*,/g, '\uD83C\uDF78\u3002",');

// Just in case, look for any remaining patterns
const beforeLines = text.split("\r\n").length;
console.log("Lines:", beforeLines);

writeFileSync("web/src/App.tsx", text);
console.log("Before:", before, "After:", text.length);