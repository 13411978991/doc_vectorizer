// find-limits.mjs — find limit values in the bundle.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const assetsDir = "release-desktop/win-unpacked/resources/web/dist/assets";
const jsFile = readdirSync(assetsDir).find((f) => f.endsWith(".js"));
const t = readFileSync(join(assetsDir, jsFile), "utf8");
const re = /limit:2[05]0|limit:\d+|"limit":\d+/g;
let m;
while ((m = re.exec(t))) console.log(m[0]);
console.log("--- ?limit= occurrences ---");
const re2 = /\?limit=\d+/g;
while ((m = re2.exec(t))) console.log(m[0]);
