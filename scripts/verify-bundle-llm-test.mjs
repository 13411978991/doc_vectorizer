import { readFileSync } from "node:fs";
const js = readFileSync("web/dist/assets/index-BNMv9wf0.js", "utf8");
console.log("Has llm-test-connection testid:", js.includes("llm-test-connection"));
console.log("Has 测试连接 literal:", js.includes("\u6d4b\u8bd5\u8fde\u63a5"));
console.log("Has test-connection/llm POST:", js.includes("/api/test-connection/llm"));
console.log("Has testLlmConnection fn:", js.includes("testLlmConnection"));