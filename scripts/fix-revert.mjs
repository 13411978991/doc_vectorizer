import { readFileSync, writeFileSync } from "node:fs";
let text = readFileSync("web/src/App.tsx", "utf8");
const before = text.length;

// My bad fix turned `。",` (comma + close) into `":` (colon + close) in lines like 765.
// The actual pattern: `。",` was CORRECT for line 765 (t() function call with two args).
// Only line 6289 had the wrong comma that should be colon (ternary arm separator).

// Revert my bad fix EXCEPT for line 6289
// Use literal line search
const line765 = 'setStatus(t("已取消永久删除项目。": "Permanent project deletion canceled."));';
const line765fixed = 'setStatus(t("已取消永久删除项目。", "Permanent project deletion canceled."));';
if (text.includes(line765)) {
  text = text.replace(line765, line765fixed);
  console.log("Reverted line 765");
}

// Check line 6289 - is it now `。": "<chinese>。"`?
const idx = text.indexOf('isCreatingNew ?');
if (idx >= 0) {
  console.log("6289 context:", JSON.stringify(text.slice(idx, idx + 80)));
}

writeFileSync("web/src/App.tsx", text);
console.log("Before:", before, "After:", text.length);