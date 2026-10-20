// scripts/verify-served-bundle.mjs
// Confirm the bundle served by the backend (4173) has the toggle.
import { writeFileSync } from "node:fs";

const res = await fetch("http://127.0.0.1:4173/");
const html = await res.text();

// Extract bundle path
const match = html.match(/assets\/(index-[A-Za-z0-9]+\.js)/);
const bundlePath = match ? `/assets/${match[1]}` : null;

const log = [`HTML references bundle: ${bundlePath}`];

if (!bundlePath) {
  console.log("Could not find bundle reference in HTML");
  process.exit(1);
}

const bundleRes = await fetch(`http://127.0.0.1:4173${bundlePath}`);
const bundle = await bundleRes.text();

log.push(`Bundle size: ${bundle.length}`);
log.push(`Bundle contains "LLM 抽取模式": ${bundle.includes("LLM 抽取模式")}`);
log.push(`Bundle contains "LLM extraction mode": ${bundle.includes("LLM extraction mode")}`);
log.push(`Bundle contains "本地启发式": ${bundle.includes("本地启发式")}`);
log.push(`Bundle contains "远程 API": ${bundle.includes("远程 API")}`);
log.push(`Bundle has template-literal testid pattern: ${/"data-testid":`llm-provider-/.test(bundle)}`);

// Specifically find the toggle button context
const toggleMatch = bundle.match(/"data-testid":`llm-provider-\$\{[^}]+}"[^,}]+onClick:[^,}]+/);
log.push(`\nToggle button found in bundle: ${toggleMatch ? "YES" : "NO"}`);
if (toggleMatch) {
  log.push(`Pattern: ${toggleMatch[0].slice(0, 200)}`);
}

// Find the LLM 抽取模式 field context
const labelIdx = bundle.indexOf("LLM 抽取模式");
if (labelIdx >= 0) {
  log.push(`\nLLM 抽取模式 found at offset ${labelIdx}`);
  log.push(`Context (300 chars):`);
  log.push(bundle.substring(labelIdx, labelIdx + 300));
} else {
  log.push("\n❌ LLM 抽取模式 NOT in served bundle");
}

writeFileSync("build-tmp/verify-served-bundle.log", log.join("\n"));
console.log(log.join("\n"));