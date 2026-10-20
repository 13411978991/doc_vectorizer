// find-tabs.mjs — locate resultView tab labels and check they're clean.
import { readFileSync } from "node:fs";
const lines = readFileSync("web/src/App.tsx", "utf8").split("\n");
const needles = ["概览", "检索", "resultView"];
lines.forEach((l, i) => {
  if (needles.some((n) => l.includes(n)) && /resultView|label|概览|检索/.test(l)) {
    console.log(`${i + 1}: ${l.trim().slice(0, 160)}`);
  }
});
