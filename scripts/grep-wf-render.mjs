// grep-wf-render.mjs — find where the manifest list is rendered.
import { readFileSync } from "node:fs";
const text = readFileSync("web/src/pages/WatchedFolders/index.tsx", "utf8");
const lines = text.split("\n");
const re = /\.map\(|renderedManifest|displayedManifest|paginatedManifest|sliceManifest|manifest\.slice|manifest\.filter/;
lines.forEach((l, i) => {
  if (re.test(l) || /\.map\(\(item|map\(\(row|map\(\(entry|map\(\(file|page\.map/) {
    console.log(`${i + 1}: ${l.trim().slice(0, 200)}`);
  }
});
