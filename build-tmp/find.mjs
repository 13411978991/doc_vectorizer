import { readFileSync } from "node:fs";
const content = readFileSync("./index-BZPRoTyj.js", "utf8");
const idx = content.indexOf("nerModel");
if (idx < 0) {
  console.log("nerModel not in bundle");
} else {
  console.log("CONTEXT around nerModel:");
  console.log(content.substring(Math.max(0, idx - 600), Math.min(1500, content.length - idx + 600)));
}