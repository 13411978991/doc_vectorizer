import { readFileSync } from "node:fs";
const text = readFileSync("web/src/App.tsx", "utf8");
const lines = text.split("\r\n");

// Find lines with unterminated strings
const issues = [];
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  // Count unescaped quotes in line
  let inStr = false;
  let count = 0;
  for (let j = 0; j < line.length; j++) {
    if (line[j] === "\\" && j + 1 < line.length) { j++; continue; }
    if (line[j] === '"') count++;
  }
  // Even count means balanced; odd means odd-quote
  if (count % 2 !== 0 && line.includes('"')) {
    issues.push({ line: i + 1, text: line });
  }
}
console.log("Unbalanced quote lines:", issues.length);
issues.slice(0, 10).forEach(({line, text}) => {
  console.log(`Line ${line}:`, JSON.stringify(text));
});

// Also find JSX mismatches: <div> without </div>
// Just look for known patterns
console.log("\nLooking for `<div>` without matching close:");
for (let i = 0; i < lines.length; i++) {
  if (lines[i].match(/<div\b[^>]*>[^<]*<\/div>/)) {
    // Self-contained — skip
  } else if (lines[i].match(/<div\b[^>]*>$/)) {
    console.log(`Possible open div at line ${i+1}:`, JSON.stringify(lines[i]));
  }
}