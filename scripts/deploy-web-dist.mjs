// deploy-web-dist.mjs — Copy web/dist to release-desktop resources with
// stale-chunk pruning + the same watermark injection build-windows-exe.mjs
// uses. Safe to run while the backend is live: static files are served
// per-request, so a window reload picks the new bundle up.
import { readFileSync, writeFileSync, copyFileSync, readdirSync, mkdirSync, statSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

const SRC = "web/dist";
const DST = "release-desktop/win-unpacked/resources/web/dist";

const html = readFileSync(join(SRC, "index.html"), "utf8");
const keep = new Set();
for (const m of html.matchAll(/assets\/([A-Za-z0-9_-]+\.[a-z]+)/g)) keep.add(m[1]);

const assetsDst = join(DST, "assets");
if (existsSync(assetsDst)) {
  for (const ent of readdirSync(assetsDst)) {
    if (!keep.has(ent)) {
      try { unlinkSync(join(assetsDst, ent)); console.log("pruned", ent); } catch {}
    }
  }
}

const watermarkStyle =
  '<style id="sag-watermark" data-injected-by="server">body::after{content:"";position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:99999;background-image:url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'280\' height=\'140\'%3E%3Ctext x=\'0\' y=\'70\' fill=\'rgba(0,0,0,0.05)\' font-size=\'16\' font-family=\'sans-serif\' transform=\'rotate(-30,140,70)\'%3Esag%3C/text%3E%3C/svg%3E");background-repeat:repeat;}</style>';

function walk(s, d) {
  mkdirSync(d, { recursive: true });
  let n = 0;
  for (const f of readdirSync(s)) {
    const sp = join(s, f);
    const dp = join(d, f);
    if (statSync(sp).isDirectory()) {
      n += walk(sp, dp);
      continue;
    }
    if (f === "index.html") {
      let h = readFileSync(sp, "utf8");
      if (!h.includes("sag-watermark")) {
        h = h.replace("</head>", watermarkStyle + "</head>");
      }
      writeFileSync(dp, h, "utf8");
    } else {
      copyFileSync(sp, dp);
    }
    n++;
  }
  return n;
}
console.log("copied", walk(SRC, DST), "files");
