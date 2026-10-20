import { readFileSync, writeFileSync } from "node:fs";

const path = "web/src/App.tsx";
let text = readFileSync(path, "utf8");
const before = text.length;

// Multi-line corruption with CRLF: `...":\r\n` should be `...",\r\n`
let count = 0;
text = text.replace(/\u3002":\r\n/g, (m) => {
  count++;
  return '\u3002",\r\n';
});
console.log("Replaced :\\r\\n patterns:", count);

// Also `...": \r\n` -> `...", \r\n`
const count2 = (text.match(/\u3002": \r\n/g) || []).length;
text = text.replace(/\u3002": \r\n/g, '\u3002", \r\n');
console.log("Replaced : \\r\\n patterns:", count2);

// Restore the legitimate ternary at line 6289
const ternaryBroken = 'isCreatingNew ? "\u65b0\u5efa\u77e5\u8bc6\u3002", "\u77e5\u8bc6\u5e93\u8be6\u3002"';
const ternaryFixed = 'isCreatingNew ? "\u65b0\u5efa\u77e5\u8bc6\u3002": "\u77e5\u8bc6\u5e93\u8be6\u3002"';
if (text.includes(ternaryBroken)) {
  text = text.replace(ternaryBroken, ternaryFixed);
  console.log("Restored ternary");
}

writeFileSync(path, text, "utf8");
console.log("before:", before, "after:", text.length);