import { readFileSync, writeFileSync } from "node:fs";
let text = readFileSync("web/src/App.tsx", "utf8");
const before = text.length;

// Line 6791: `</code>` corrupted to `。/code>`
// Pattern: `<chinese>。/code>` → `<chinese>？</code>` (insert close tag)
text = text.replace(/\u3002\/code>/g, '\u3002</code>');

// Any other `</tag>` patterns
text = text.replace(/\u3002\/div>/g, '\u3002</div>');
text = text.replace(/\u3002\/span>/g, '\u3002</span>');
text = text.replace(/\u3002\/button>/g, '\u3002</button>');
text = text.replace(/\u3002\/p>/g, '\u3002</p>');
text = text.replace(/\u3002\/pre>/g, '\u3002</pre>');

writeFileSync("web/src/App.tsx", text);
console.log("Before:", before, "After:", text.length);