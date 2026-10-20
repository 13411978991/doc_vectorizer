// scripts/verify-frontend-body.mjs — What payload does the BUNDLE actually send?
//
// Strategy: find the save handler's e.onSave callback in the bundle,
// trace what it passes. But that's a long rabbit hole. Instead, we
// do the brutal approach: spin up the same module graph as the bundle,
// but stripped of React rendering, just enough to extract the save
// callback's body — what fields it spreads into onSave.
//
// Simpler: capture every PUT body the server actually receives and
// confirm what's missing. Easiest is to read ai-settings-service.ts
// updateSettings() to see which DB columns it writes, and confirm
// llmProvider is in the upsert call.

import { readFileSync } from "node:fs";

const src = readFileSync(
  "src/services/ai-settings-service.ts",
  "utf8"
);

// Find the updateSettings function body
const start = src.indexOf("async updateSettings(input: UpdateAiSettingsInput)");
console.log("updateSettings body excerpt:");
console.log(src.substring(start, start + 2500));