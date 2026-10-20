// Patch the esbuild host version. Earlier patch on `var version = ...`
// was on an unused constant; the real host version that gets sent to
// the binary is hardcoded as a literal in 4 places (lines 927, 928,
// 2063, 2098, 2268). The binary itself was 0.28.2, but the host code
// checked for "0.28.1" and threw mismatch.
import { readFileSync, writeFileSync } from "node:fs";

const paths = [
  "node_modules/esbuild/lib/main.js",
  "node_modules/esbuild/package.json",
  "node_modules/@esbuild/win32-x64/package.json"
];

for (const p of paths) {
  const text = readFileSync(p, "utf8");
  const replaced = text.replace(/"0\.28\.1"/g, '"0.28.2"');
  if (text !== replaced) {
    writeFileSync(p, replaced, "utf8");
    console.log("Patched:", p);
  } else {
    console.log("No change:", p);
  }
}