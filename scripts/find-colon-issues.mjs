import { readFileSync } from "node:fs";
const text = readFileSync("web/src/App.tsx", "utf8");
const lines = text.split("\n");
console.log("Total lines:", lines.length);
let count = 0;
for (let i = 0; i < lines.length; i++) {
  // Find 。 followed by " followed by something other than , or \n
  let col = -1;
  for (let j = 0; j < lines[i].length - 1; j++) {
    if (lines[i][j] === "\u3002" && lines[i][j + 1] === "\"") {
      const next = lines[i][j + 2];
      if (next !== "," && next !== ":" && next !== undefined && next !== " " && next !== "\n") {
        col = j;
        break;
      }
    }
  }
  if (col >= 0) {
    count++;
    if (count <= 40) {
      console.log("line", i + 1, "col", col, ":", JSON.stringify(lines[i].slice(Math.max(0, col - 15), col + 30)));
    }
  }
}
console.log("Total suspicious lines:", count);