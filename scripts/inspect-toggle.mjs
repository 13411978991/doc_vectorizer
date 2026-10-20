// scripts/inspect-toggle.mjs — verify my toggle actually renders the radio buttons
// by parsing the bundle's JSX output more carefully
import { readFileSync } from "node:fs";

const bundle = readFileSync("web/dist/assets/index-BZPRoTyj.js", "utf8");

// Find the "LLM 抽取模式" context
const labelIdx = bundle.indexOf("LLM 抽取模式");
console.log(`"LLM 抽取模式" at offset: ${labelIdx}`);
console.log("\nContext after the label (300 chars):");
console.log(bundle.substring(labelIdx, labelIdx + 300));
console.log("\n... and searching for data-testid pattern after the label:");
const afterLabel = bundle.substring(labelIdx, labelIdx + 5000);
const testidMatches = [...afterLabel.matchAll(/"llm-provider-(\w+)"/g)];
console.log(`testid matches found in nearby context: ${testidMatches.map(m => m[0]).join(", ")}`);

// Also search for the button key — typical React minified button looks like:
// i.jsx("button",{key:...,type:"button",className:...,onClick:()=>...,children:...})
const buttonIdx = afterLabel.indexOf("type:\"button\"");
console.log(`\nFirst button after label at offset: ${labelIdx + buttonIdx}`);
if (buttonIdx > 0) {
  console.log(bundle.substring(labelIdx + buttonIdx, labelIdx + buttonIdx + 200));
}

// What does the onClick callback do? Look for an `onClick:` assignment
const onClickIdx = afterLabel.indexOf("onClick");
if (onClickIdx > 0) {
  console.log(`\nonClick at offset: ${labelIdx + onClickIdx}`);
  console.log(bundle.substring(labelIdx + onClickIdx, labelIdx + onClickIdx + 100));
}