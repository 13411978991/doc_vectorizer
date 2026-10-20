// check-shibie.mjs — hunt 识别 in all its possible bundle encodings.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const assetsDir = "release-desktop/win-unpacked/resources/web/dist/assets";
const jsFile = readdirSync(assetsDir).find((f) => f.endsWith(".js"));
const text = readFileSync(join(assetsDir, jsFile), "utf8");

const needles = ["识别", "\\u8bc6\\u522b", "\\u8bc6", "query entity/entities identified", "No query entities identified", "Identify key entities"];
for (const n of needles) {
  const idx = text.indexOf(n);
  console.log(`${JSON.stringify(n)}: ${idx >= 0 ? "at " + idx : "not found"}`);
  if (idx >= 0) {
    console.log("  ctx:", text.slice(Math.max(0, idx - 60), idx + 90));
  }
}
