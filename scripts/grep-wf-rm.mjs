// grep-wf-rm.mjs — find all refreshManifest calls + any place that
// writes manifestLimit or emits pagination:limit-change.
import { readFileSync } from "node:fs";
const text = readFileSync("web/src/pages/WatchedFolders/index.tsx", "utf8");
const lines = text.split("\n");
lines.forEach((l, i) => {
  if (/refreshManifest|setManifestLimit|setManifestOffset|pagination:limit-change|Pagination\s|manifestOffset/.test(l)) {
    console.log(`${i + 1}: ${l.trim().slice(0, 200)}`);
  }
});
