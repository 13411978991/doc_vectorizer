import { readFileSync, writeFileSync } from "node:fs";
let text = readFileSync("web/src/App.tsx", "utf8");
const before = text.length;

// Line 6772: `icon: "🕸。 },` → `icon: "🕸"},`
text = text.replace(/\u3002\s+},/g, '\u3002"},');

// Any other similar pattern: `<chinese>。 }` followed by something
text = text.replace(/\u3002\s+(\}|\]|\))/g, '\u3002"$1');

writeFileSync("web/src/App.tsx", text);
console.log("Before:", before, "After:", text.length);