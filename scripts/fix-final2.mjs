import { readFileSync, writeFileSync } from "node:fs";
let text = readFileSync("web/src/App.tsx", "utf8");
const before = text.length;

// Line 5479: `<span className="text-muted-foreground">。/span>` → should be `<span className="...">。</span>` (with content)
// Actually original was `<span className="...">...。</span>` (some Chinese text)
// But our corruption made the Chinese content disappear. Best-effort:
text = text.replace(/\u3002\/span>/g, '\u3002</span>');

// Line 6289: `("新建知识。 : "知识库详。")` → `("新建知识。", "知识库详。")`
// The comma before " was lost
text = text.replace(/(\u3002)\s+(:\s+")/g, '$1, $2');

writeFileSync("web/src/App.tsx", text);
console.log("Before:", before, "After:", text.length);