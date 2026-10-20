// Sweep 4 — fix the remaining `。` patterns that are clearly corruption.
import { readFileSync, writeFileSync } from "node:fs";

const path = "web/src/App.tsx";
let text = readFileSync(path, "utf8");

const fixes = [
  { find: "\u3002{name}\u300d", replace: "\u300c{name}\u300d", desc: "。name}」 → 「name}」" },
  { find: "\u3002{project.name}\u300d", replace: "\u300c{project.name}\u300d", desc: "。project.name}」 → 「project.name}」" },
  { find: "\u3002{displayName}\u300d", replace: "\u300c{displayName}\u300d", desc: "。displayName}」 → 「displayName}」" },
  { find: "\u8fd8\u6ca1\u6709\u68c0\u7d22\u7ed3\u3002", replace: "\u8fd8\u6ca1\u6709\u68c0\u7d22\u7ed3\u679c", desc: "结。 → 结果" },
  { find: "\u542f\u52a8\u65f6\u8bfb\u3002", replace: "\u542f\u52a8\u65f6\u8bfb\u53d6", desc: "读。 → 读取" },
];

let count = 0;
for (const f of fixes) {
  if (text.includes(f.find)) {
    text = text.split(f.find).join(f.replace);
    count++;
    console.log("Fixed:", f.desc);
  }
}
console.log("Total:", count);
writeFileSync(path, text, "utf8");