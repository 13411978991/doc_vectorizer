// Re-write regen-fixtures.ps1 with UTF-8 BOM so PowerShell 5.1 on Chinese
// Windows decodes CJK strings in $themes correctly.
import { readFile, writeFile } from "node:fs/promises";

const target = "D:/IT审计/SAG-windows-pack/doc_vectorizer/scripts/regen-fixtures.ps1";
const src = await readFile(target);
const hasBom = src[0] === 0xef && src[1] === 0xbb && src[2] === 0xbf;
if (!hasBom) {
  const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), src]);
  await writeFile(target, buf);
  console.log("added UTF-8 BOM");
} else {
  console.log("already has BOM");
}