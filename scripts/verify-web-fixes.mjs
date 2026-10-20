// verify-web-fixes.mjs — final check on the deployed web bundle.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const assetsDir = "release-desktop/win-unpacked/resources/web/dist/assets";
const jsFile = readdirSync(assetsDir).find((f) => f.endsWith(".js"));
const text = readFileSync(join(assetsDir, jsFile), "utf8");
console.log("bundle:", jsFile, (text.length / 1024).toFixed(0) + "KB");

const shouldBeGone = ["{props.label}", "已提。", "识别。", "已生。", "缓。", "失。", "。{", "未配。"];
const shouldExist = ["已提交", "识别出", "输入检索问题", "已生成", "缓存", "失败", "标题", "发送", "处理状态", "没有识别到查询实体"];

for (const s of shouldBeGone) {
  console.log(`corrupt ${JSON.stringify(s)}: ${text.includes(s) ? "STILL PRESENT ✗" : "gone ✓"}`);
}
for (const s of shouldExist) {
  console.log(`fixed   ${JSON.stringify(s)}: ${text.includes(s) ? "present ✓" : "MISSING ✗"}`);
}
