import { readFileSync, writeFileSync } from "node:fs";
let text = readFileSync("web/src/App.tsx", "utf8");
const before = text.length;

// Found pattern: `。" );` (semicolon space paren)
text = text.replace(/\u3002"\s*\);/g, '\u3002")');

writeFileSync("web/src/App.tsx", text);
console.log("Before:", before, "After:", text.length);