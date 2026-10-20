// grep-prj-doc.mjs — find the /projects/:id/documents handler.
import { readFileSync } from "node:fs";
const text = readFileSync("src/api/project-routes.ts", "utf8");
const lines = text.split("\n");
lines.forEach((l, i) => {
  if (/documents/.test(l) && /app\.|app\.get|limit/.test(l)) {
    console.log(`${i + 1}: ${l.trim().slice(0, 200)}`);
  }
});
