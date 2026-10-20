// scripts/compare-bundles.mjs — compare two bundles to see if my source edit is included
import { readFileSync } from "node:fs";

const oldBundle = readFileSync(
  "E:/sag/完整后端版本/源码/doc_vectorizer/release/web/dist/assets/index-BzO-No6n.js",
  "utf8"
);
const newBundle = readFileSync(
  "web/dist/assets/index-BZPRoTyj.js",
  "utf8"
);

console.log("release bundle size:", oldBundle.length);
console.log("local bundle size:", newBundle.length);

const oldHasLlmToggle = oldBundle.includes("setLlmProvider");
const newHasLlmToggle = newBundle.includes("setLlmProvider");

console.log("old bundle has setLlmProvider:", oldHasLlmToggle);
console.log("new bundle has setLlmProvider:", newHasLlmToggle);

const oldHasLabel = oldBundle.includes("LLM 抽取模式") || oldBundle.includes("LLM extraction mode");
const newHasLabel = newBundle.includes("LLM 抽取模式") || newBundle.includes("LLM extraction mode");

console.log("old bundle has LLM 抽取模式 / extraction mode label:", oldHasLabel);
console.log("new bundle has LLM 抽取模式 / extraction mode label:", newHasLabel);

const oldHasApi = oldBundle.includes("远程 API") || oldBundle.includes("Remote API");
const newHasApi = newBundle.includes("远程 API") || newBundle.includes("Remote API");

console.log("old bundle has 远程 API / Remote API:", oldHasApi);
console.log("new bundle has 远程 API / Remote API:", newHasApi);