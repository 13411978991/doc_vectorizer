// find-truncated-t.mjs — list t("zh","en") calls whose zh looks truncated
// (very short zh vs a normal English phrase), for manual review.
import { readFileSync } from "node:fs";
const text = readFileSync("web/src/App.tsx", "utf8");
// crude but effective: t("...zh...", "...en...") with zh <= 4 CJK chars
const re = /\bt\("([^"]{1,12})",\s*"([^"]{3,})"\)/g;
let m;
const rows = [];
while ((m = re.exec(text))) {
  const [, zh, en] = m;
  const cjk = (zh.match(/[\u4e00-\u9fff]/g) || []).length;
  // candidate truncation: zh has <= 3 CJK chars and the English has 2+ letters
  if (cjk >= 1 && cjk <= 3 && en.length >= 4) {
    const line = text.slice(0, m.index).split("\n").length;
    rows.push({ line, zh, en });
  }
}
for (const r of rows) console.log(`${r.line}: t("${r.zh}", "${r.en.slice(0, 60)}")`);
console.log(`total: ${rows.length}`);
