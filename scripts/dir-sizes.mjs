// dir-sizes.mjs — fast top-down size listing (skips per-machine cache).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = "release-desktop/win-unpacked";

function size(p) {
  try {
    return readdirSync(p, { withFileTypes: true }).reduce((acc, e) => {
      const ep = join(p, e.name);
      if (e.isDirectory()) return acc + size(ep);
      try { return acc + statSync(ep).size; } catch { return acc; }
    }, 0);
  } catch { return 0; }
}

const top = readdirSync(ROOT, { withFileTypes: true });
for (const e of top) {
  const p = join(ROOT, e.name);
  if (e.isDirectory()) {
    const s = size(p);
    console.log(`${e.name.padEnd(30)} ${(s / 1048576).toFixed(0)} MB`);
    if (e.name === "resources") {
      for (const re of readdirSync(p, { withFileTypes: true })) {
        const rp = join(p, re.name);
        if (re.isDirectory()) {
          const rs = size(rp);
          console.log(`  ${re.name.padEnd(28)} ${(rs / 1048576).toFixed(0)} MB`);
          if (re.name === "native-cache") {
            for (const ne of readdirSync(rp, { withFileTypes: true })) {
              const np = join(rp, ne.name);
              const ns = size(np);
              const tag = ne.name.match(/^[0-9a-f]{12}$/) ? "  [SKIP per-machine]" : "";
              console.log(`    ${ne.name.padEnd(26)} ${(ns / 1048576).toFixed(0)} MB${tag}`);
            }
          }
        }
      }
    }
  } else {
    console.log(`${e.name.padEnd(30)} ${(statSync(p).size / 1048576).toFixed(0)} MB`);
  }
}
