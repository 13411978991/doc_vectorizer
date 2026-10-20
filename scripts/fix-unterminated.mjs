// scripts/fix-unterminated.mjs
// Fix the 8 remaining unterminated strings by adding missing close quotes.
// Run after the previous fix.
import { readFileSync, writeFileSync } from "node:fs";

let text = readFileSync("web/src/App.tsx", "utf8");
const before = text.length;

// Lines like: `...。,<newline>` should be `..."<newline>` or `...",<newline>`
// We've already converted `。, "` to `。", "`. Now fix the cases
// where the corruption stripped the close quote entirely.

// Pattern: `。,$` at end of source line (closing quote + comma missing)
// Insert `"` between `。` and `,`

// Specific lines from tsc errors:
//   1010: `"MCP 工具已发。sag_search，正在实时接。SAG 内部检索阶段。,<nl>`
//   1189: `"清空当前对话记录？\\n\\n...保留会话本身。,<nl>`
//   2696: `"已提取实体...进行中）。,<nl>`
//   3406: `useState("审计发现：...文件。);` — missing closing `"` before `)`
//   3453: same pattern

// For lines ending in 。, the close quote was lost.
// Insert " before ,
text = text.replace(/\u3002,(\r\n)/g, '\u3002",$1');
text = text.replace(/\u3002,(\n)/g, '\u3002",$1');

// Line 3406: useState("审计发现：...。);
// Insert closing `"` before `)`
text = text.replace(/(\u3002)\);/g, '$1");');
text = text.replace(/(\u3002)\)\n/g, '$1")\n');
text = text.replace(/(\u3002);/g, '$1";'); // for ; without )

writeFileSync("web/src/App.tsx", text);
console.log("Before:", before, "After:", text.length);