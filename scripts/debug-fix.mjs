import { readFileSync, writeFileSync } from "node:fs";
let text = readFileSync("web/src/App.tsx", "utf8");

// Get the exact characters at line 4227
const lines = text.split("\r\n");
const line = lines[4226];
console.log("Line 4227:", line);

// Check what's between index 40 and 50 (around col 41)
const idx = line.indexOf("检查中");
console.log("Char codes around 检查中:");
for (let i = idx - 2; i < idx + 10; i++) {
  console.log(`  [${i}]: ${JSON.stringify(line[i])} (0x${line.charCodeAt(i).toString(16).padStart(4, '0')})`);
}

// Try a very simple replacement
console.log("\n\nTry replacing 。); pattern:");
const testStr = "abc。);xyz";
const replaced = testStr.replace(/\u3002\);/g, '\u3002")');
console.log(`Before: ${testStr}`);
console.log(`After:  ${replaced}`);