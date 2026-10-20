// fix-truncated-t.mjs — repair truncated zh strings in t() calls
// (tail characters eaten by the same corruption event). Full-call
// find/replace pairs so replacements are collision-safe.
import { readFileSync, writeFileSync } from "node:fs";

const PATH = "web/src/App.tsx";
let text = readFileSync(PATH, "utf8");

const fixes = [
  ['t("已停", "Stopped")', 't("已停止", "Stopped")'],
  ['t("数据", "Data sources")', 't("数据源", "Data sources")'],
  ['t("监听", "Watched")', 't("监听文件夹", "Watched")'],
  ['t("已归", "Archived")', 't("已归档", "Archived")'],
  ['t("重命", "Rename")', 't("重命名", "Rename")'],
  ['t("上一", "Previous")', 't("上一页", "Previous")'],
  ['t("下一", "Next")', 't("下一页", "Next")'],
  ['t("自定", "Custom")', 't("自定义", "Custom")'], // ×3 (replaceAll)
  ['t("已下", "Installed")', 't("已下载", "Installed")'],
  ['t("试运", "Test")', 't("试运行", "Test")'],
  ['t("Token 强制", "Token window")', 't("Token 强制窗口", "Token window")'],
  ['t("已复", "Copied")', 't("已复制", "Copied")'],
  ['t("所属文", "Source document")', 't("所属文档", "Source document")'],
  ['t("未生", "Not generated")', 't("未生成", "Not generated")'],
  ['t("个实", "entities")', 't("个实体", "entities")'], // ×2
  ['t("个事", "events")', 't("个事件", "events")'], // ×3
  ['t("个候", "candidates")', 't("个候选", "candidates")'], // ×3
  ['t("源名。*", "Source name *")', 't("源名称 *", "Source name *")'],
  ['t("已入", "ingested")', 't("已入库", "ingested")'],
  ['t("未选项", "No project selected")', 't("未选项目", "No project selected")'],
  ['t("总大", "Total size")', 't("总大小", "Total size")'],
  ['t("上传", "Uploaded")', 't("已上传", "Uploaded")'],
  ['t("最近文", "Recent documents")', 't("最近文档", "Recent documents")'],
  ['t("块", "chunks")', 't("切片", "chunks")'], // ×2
];

let applied = 0;
for (const [find, replace] of fixes) {
  const n = text.split(find).length - 1;
  if (n > 0) {
    text = text.split(find).join(replace);
    applied += n;
    console.log(`OK ×${n}:`, find);
  } else {
    console.log("MISS:", find);
  }
}
writeFileSync(PATH, text, "utf8");
console.log(`\napplied ${applied} replacements over ${fixes.length} rules`);
