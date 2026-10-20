// find-dot-issues.mjs — List every line in web/src containing U+3002 (。)
// with a heuristic verdict: LEGIT (sentence-final) vs SUSPECT (mid-word /
// before template interpolation / leading). UTF-8 safe (node, not pwsh).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = "web/src";
const files = [];
(function walk(dir) {
  for (const ent of readdirSync(dir)) {
    const p = join(dir, ent);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx|ts|jsx|js)$/.test(ent)) files.push(p);
  }
})(ROOT);

const report = [];
for (const f of files) {
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((line, idx) => {
    if (!line.includes("。")) return;
    const trimmed = line.trim();
    // Skip comments
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
    // Heuristic: 。 followed by ${ / backtick-end / more text without space
    // is suspect. 。 at very end of a string literal is legit punctuation.
    const suspects = [];
    for (const m of line.matchAll(/。/g)) {
      const pos = m.index;
      const before = line.slice(Math.max(0, pos - 12), pos);
      const after = line.slice(pos + 1, pos + 12);
      // before ${ interpolation → was a Chinese char
      const isBeforeInterp = after.startsWith("${");
      // right after opening quote/backtick → leading 。
      const isLeading = /[`"']$/.test(before);
      // between CJK char and CJK char/ASCII-word → mid-word
      const isMidWord = /[\u4e00-\u9fff]$/.test(before) && /^[\u4e00-\u9fffA-Za-z0-9]/.test(after);
      if (isBeforeInterp || isLeading || isMidWord) {
        suspects.push({ pos, before, after, isBeforeInterp, isLeading, isMidWord });
      }
    }
    if (suspects.length > 0) {
      report.push({ file: f, line: idx + 1, text: trimmed, suspects });
    }
  });
}

for (const r of report) {
  console.log(`${r.file}:${r.line}`);
  console.log(`  ${r.text.slice(0, 160)}`);
}
console.log(`\nTOTAL suspect lines: ${report.length}`);
