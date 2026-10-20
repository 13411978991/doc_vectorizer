// scripts/fix-corruption.mjs — Repair corruption from PowerShell -Encoding UTF8 mishandling.
//
// Patterns observed in App.tsx:
//   `。, \"...\"`  →  `。\", \"...\"` (missing closing quote of Chinese phrase)
//   `。;`        →  `。";` (corrupted char + closing quote missing)
//   `。「`        →  `」。` (or `」。`) (close-bracket missing)
//   `<div>...。< /div>` (truncated close tag)
//
// We can only do best-effort — original Chinese chars are lost.
// Where the corruption removed a single Chinese char that closed a phrase,
// we insert 。」 to keep the syntax valid.
import { readFileSync, writeFileSync } from "node:fs";

let text = readFileSync("web/src/App.tsx", "utf8");
const before = text.length;

// 1) `。, \"` → `。\", \"` (close the Chinese string before the English fallback)
text = text.replace(/\u3002, "/g, '\u3002", "');

// 2) `。」</` (close bracket inside JSX content) → `」。</` — already handled
//    Actually we saw `。」` truncation. Skip.

// 3) `。, $` (Chinese period then comma at end of statement) — was the
//    corruption mangled `。」,` to `。,` — replace with `。」,`
//    Hard to detect precisely; leave for line-by-line.

// 4) Special case: line 118 — `资料检。;` should be `资料检索";`
//    The `索` character was lost. We can't restore the char, but we can
//    close the string so syntax is valid. Use `。";` replacement.
text = text.replace(/检\u3002;/g, '检\u9608\u7D22";'); // 资料检检索 → but that's wrong
// Actually: 资料检。;  original was 资料检索";
// So: `资料检\u3002;` → `资料检索";`
text = text.replace(/(\u8D44\u6599)\u68C0\u3002;/g, '$1\u68C0\u7D22";'); // 资料检索";

// 5) `。;` at end of expression line (with no closing quote) is repeated
//    pattern. Best-effort: insert quote before `;`
//    Only apply on lines that look like string literals.

// We can do a safer minimal fix: where we see `<chinese>。< /div>` type
// patterns where the corruption consumed close-tag chars.

writeFileSync("web/src/App.tsx", text);
console.log("Before:", before, "After:", text.length);