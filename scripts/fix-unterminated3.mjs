// scripts/fix-unterminated3.mjs — revert my last bad fixes and do them right
import { readFileSync, writeFileSync } from "node:fs";

let text = readFileSync("web/src/App.tsx", "utf8");
const before = text.length;

// Line 4227: was `{t("检查中。", "Probing。)` — corruption missing `"` before `)`
// Original: `{t("检查中。", "Probing。")}` — the `"` before `)` is what was lost
// Currently I have `t("检查中。", "Probing。");}` — extra `;` makes TS think `)` then `}` is mismatched
// Fix: remove my extra `;` and add proper `"` before `)`
text = text.replace(/(\u3002)\);\}/g, '$1")}');

// Line 4263: was `t("预热中。", "Warming up。)` — corruption
// Currently: `t("预热中。", "Warming up。");` — extra `;` before `\n`
// Fix: remove `;` before `\n`
text = text.replace(/(\u3002)\);(\r?\n)/g, '$1"$2');

// Line 4673: similar — `t("运行中。", "Running。"); : t("试运。", "Test")}`
// Should be `t("运行中。", "Running。") : ...`
text = text.replace(/(\u3002)\);(\s+):/g, '$1") $2:');

writeFileSync("web/src/App.tsx", text);
console.log("Before:", before, "After:", text.length);