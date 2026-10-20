// scripts/fix-unterminated4.mjs
import { readFileSync, writeFileSync } from "node:fs";

let text = readFileSync("web/src/App.tsx", "utf8");
const before = text.length;

// Use the char directly not escape
text = text.replace(/。\);}/g, '")}');
text = text.replace(/。\);\r/g, '")\r');
text = text.replace(/。\);\n/g, '")\n');
text = text.replace(/。\); :/g, '") :');

writeFileSync("web/src/App.tsx", text);
console.log("Before:", before, "After:", text.length);