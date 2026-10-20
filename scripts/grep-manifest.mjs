// grep-manifest.mjs — find the watched-folder manifest route.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const files = [];
function walk(d) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.ts$/.test(e)) files.push(p);
  }
}
walk("src/api");
for (const f of files) {
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((l, i) => {
    if (/manifest|limit.*50|MAX_MANIFEST|listManifest|getManifest|hardcode.*50/.test(l)) {
      console.log(`${f}:${i + 1}: ${l.trim().slice(0, 160)}`);
    }
  });
}
