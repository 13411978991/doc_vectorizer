// grep-wf.mjs — broader search for the manifest fetch in WatchedFolders.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const files = [];
function walk(d) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(e)) files.push(p);
  }
}
walk("web/src");
for (const f of files) {
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((l, i) => {
    if (/manifest/.test(l)) {
      console.log(`${f}:${i + 1}: ${l.trim().slice(0, 180)}`);
    }
  });
}
