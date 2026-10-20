// grep-wf-component.mjs — find what defines `props.manifest` on the
// manifest table component. Look for the manifest array prop wiring
// and which JSX is the table child of WatchedFolderDetails.
import { readFileSync } from "node:fs";
const text = readFileSync("web/src/pages/WatchedFolders/index.tsx", "utf8");
const lines = text.split("\n");

// find function declarations and JSX prop assignments near manifest
const targets = ["function FileManifest", "function WatchedFolderDetails", "manifest=", "<FileManifest", "manifest ?"];
lines.forEach((l, i) => {
  if (targets.some((t) => l.includes(t))) {
    console.log(`${i + 1}: ${l.trim().slice(0, 220)}`);
  }
});
