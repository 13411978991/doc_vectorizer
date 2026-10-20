// grep-wf-props.mjs — find props.manifest source.
import { readFileSync } from "node:fs";
const text = readFileSync("web/src/pages/WatchedFolders/index.tsx", "utf8");
const lines = text.split("\n");
lines.forEach((l, i) => {
  if (/\.manifest\b/.test(l)) {
    console.log(`${i + 1}: ${l.trim().slice(0, 200)}`);
  }
});
