import { convertFile } from "../src/watcher/file-converter.js";
const target = "E:/sag/完整后端版本/源码/doc_vectorizer/build-tmp/test-docx.docx";
console.log("Calling convertFile for", target);
try {
  const md = await convertFile(target);
  console.log("Converted length:", md.length);
  console.log("First 200:", JSON.stringify(md.slice(0, 200)));
} catch (err) {
  console.error("FAILED:");
  console.error("  message:", err.message);
  console.error("  stack:", err.stack);
}
process.exit(0);