// scripts/fix-unterminated2.mjs — Final cleanup of remaining unterminated strings
import { readFileSync, writeFileSync } from "node:fs";

let text = readFileSync("web/src/App.tsx", "utf8");
const before = text.length;

// Line 1879: `本地文档检。/div>` → should be `本地文档检索</div>`
// Original was: 本地文档检索</div>  (with closing tag)
// Corruption: `索` removed + `</div>` lost (became `/div>`)
// We CAN'T recover `索` but we can fix the structure
text = text.replace(/\u3002\/div>/g, '\u7D22</div>');

// Line 4227: `t("检查中。", "Probing。)` → `t("检查中。", "Probing。");`
// Need closing `"` before `)`
text = text.replace(/(\u3002)\)/g, '$1");');

// Line 4263: `t("预热中。", "Warming up。)` — closing `"` missing
text = text.replace(/(\u3002)\)\n/g, '$1")\n');
text = text.replace(/(\u3002)\)/g, '$1");');

// Line 4673: `t("运行中。", "Running。) : t("试运。", "Test")}` 
// `。」` followed by `)` instead of `")`
text = text.replace(/(\u3002)\)\s*:/g, '$1"); :');
text = text.replace(/(\u3002)\)/g, '$1");');

writeFileSync("web/src/App.tsx", text);
console.log("Before:", before, "After:", text.length);