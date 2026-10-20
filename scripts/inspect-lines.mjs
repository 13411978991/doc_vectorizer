import { readFileSync } from "node:fs";
const text = readFileSync("web/src/App.tsx", "utf8");
const lines = text.split("\r\n");
const ids = [6289, 6791, 7191];
for (const i of ids) {
  console.log("Line " + i + ": " + JSON.stringify(lines[i - 1]));
}