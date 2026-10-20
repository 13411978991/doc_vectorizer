import { readFileSync, writeFileSync } from "node:fs";
let text = readFileSync("web/src/App.tsx", "utf8");
const before = text.length;
// Direct chars
const fixed = text
  .replace(/\u3002\);}/g, '\u3002")}')
  .replace(/\u3002\);\r/g, '\u3002")\r')
  .replace(/\u3002\);\n/g, '\u3002")\n')
  .replace(/\u3002\); :/g, '\u3002") :');
writeFileSync("web/src/App.tsx", fixed);
console.log("Before:", before, "After:", fixed.length);
console.log("Sample line 4227:", fixed.split("\r\n")[4226]);