// grep-wf-render2.mjs — find where the manifest is rendered.
import { readFileSync } from "node:fs";
const text = readFileSync("web/src/pages/WatchedFolders/index.tsx", "utf8");
const lines = text.split("\n");
lines.forEach((l, i) => {
  if (/\.map\(/.test(l) || /rows\.length/ .test(l) || /<tr / .test(l) || /tbody/.test(l)) {
    console.log(`${i + 1}: ${l.trim().slice(0, 200)}`);
  }
});
