// fix-dot-corruption-final.mjs — Repair the remaining U+3002 corruption
// and truncated Chinese strings in web/src/App.tsx. Each entry is an
// EXACT find → replace pair (UTF-8, context-verified against the
// English fallback in the same t() call). The corruption came from an
// old PowerShell -Encoding UTF8 mishandling that replaced single
// Chinese chars with 。 and truncated some phrase tails.
import { readFileSync, writeFileSync } from "node:fs";

const PATH = "web/src/App.tsx";
let text = readFileSync(PATH, "utf8");

const fixes = [
  // L205 — error page: 可以点"重试"恢复
  [`渲染时遇到未处理的异常。可以点。重试"恢复，或"刷新页面"重置全部状态。`,
   `渲染时遇到未处理的异常。可以点"重试"恢复，或"刷新页面"重置全部状态。`],
  // L874 — 已提交
  ["已提。${files.length} 个文档处理任务", "已提交 ${files.length} 个文档处理任务"],
  // L1099/1115 — 检索完成
  ['t("检索完", "Search complete")', 't("检索完成", "Search complete")'],
  // L1120/1153 — 检索失败
  ['t("检索失", "Search failed")', 't("检索失败", "Search failed")'],
  // L1681 — 选一个
  ["从左侧选一。Project、Watched Folder 查看详情", "从左侧选一个 Project、Watched Folder 查看详情"],
  // L1726 — 所有
  ["删除该知识库？会移除所。source 关联", "删除该知识库？会移除所有 source 关联"],
  // L2105 — 「2025 年报」
  ["命名参考：时间 + 主题 + 范围，如。025 年报 · 华东分公司」。",
   "命名参考：时间 + 主题 + 范围，如「2025 年报 · 华东分公司」。"],
  // L2254 — 新对话
  ['t("新对", "New chat")', 't("新对话", "New chat")'],
  // L2256 — 测试
  ["新建会话后开始测。MCP 工具", "新建会话后开始测试 MCP 工具"],
  // L2274 — 还没有对话
  ['t("还没有对", "No conversation yet")', 't("还没有对话", "No conversation yet")'],
  // L2351 — 发送
  ['t("发", "Send")', 't("发送", "Send")'],
  // L2370 — 等待
  ["正在分析问题，等。MCP 搜索语句...", "正在分析问题，等待 MCP 搜索语句..."],
  // L2857 — 缓存
  ["浏览器缓。${props.logs.length} 条", "浏览器缓存 ${props.logs.length} 条"],
  // L2926 — 失败
  ["失。${failedCount}", "失败 ${failedCount}"],
  // L2969 — 已生成
  ["已生。${job.chunkCount ?? 0} 个切片", "已生成 ${job.chunkCount ?? 0} 个切片"],
  // L2999 — 处理状态
  ['t("处理状", "Processing status")', 't("处理状态", "Processing status")'],
  // L3017 — 前 8 位样本
  ["列表卡片会显示维度和。8 位样本", "列表卡片会显示维度和前 8 位样本"],
  // L3043 — the smoking gun: 。{props.label}标题搜索 → 搜索${props.label}标题
  ["`。{props.label}标题搜索`", "`搜索${props.label}标题`"],
  // L3053 — 共 N 条
  ["。${props.totalCount} 条", "共 ${props.totalCount} 条"],
  // L3073 — 第 x/y 页
  ["。${props.page}/${pageCount} 。· ${from}-${to} / ${props.totalCount} 条",
   "第 ${props.page}/${pageCount} 页 · ${from}-${to} / ${props.totalCount} 条"],
  // L3212 — 检索模式
  ['t("检索模", "Search mode")', 't("检索模式", "Search mode")'],
  // L3239 — 输入检索问题
  ['t("输入检索问", "Enter a search question")', 't("输入检索问题", "Enter a search question")'],
  // L3267/5776/6140 — 检索链路
  ['t("检索链", "Search trace")', 't("检索链路", "Search trace")'],
  ['t("检索链", "trace")', 't("检索链路", "trace")'],
  // L4503/4505 — download complete/failed (zh missing $, en leading 。)
  ["`下载完成「{localModelDownload.label}」`, `。Download complete: ${localModelDownload.label}`",
   "`下载完成「${localModelDownload.label}」`, `Download complete: ${localModelDownload.label}`"],
  ["`下载失败「{localModelDownload.label}」`, `。Download failed: ${localModelDownload.label}`",
   "`下载失败「${localModelDownload.label}」`, `Download failed: ${localModelDownload.label}`"],
  // L4638 — 自定义
  ["自定。BGE 模型放置说明", "自定义 BGE 模型放置说明"],
  // L4675 — 相对 exe
  ["点选会把路径填成相。exe 工作目录下", "点选会把路径填成相对 exe 工作目录下"],
  // L4922 — 强制按 token
  ["强制。token 窗口切片", "强制按 token 窗口切片"],
  // L4959 — 把 Web 界面地址
  ['"。Web 界面地址发给其他设备的浏览器即可远程访问 SAG', '"把 Web 界面地址发给其他设备的浏览器即可远程访问 SAG'],
  // L6029 — 识别出
  ["识别。${value.length} 个查询实体", "识别出 ${value.length} 个查询实体"],
  // L6146/6148 — 未配置
  ["当前未配。LLM_API_KEY", "当前未配置 LLM_API_KEY"],
  ["当前未配。LLM 密钥", "当前未配置 LLM 密钥"],
  // L6155 — 并搜索
  ["并搜。SAG 多路检索。", '并搜索"SAG 多路检索"。'],
  // L6306 — 挂载 folder / 上传文件
  ["暂无源，点击「添加源」挂。folder 或上传文", "暂无源，点击「添加源」挂载 folder 或上传文件"],
  // L6372 — 未关联
  ["未关。KB 项目", "未关联 KB 项目"],
  // L7005 — 由 watcher 自动同步
  ["。watcher 自动同步；新文件计入顶部 Documents 总数", "由 watcher 自动同步；新文件计入顶部 Documents 总数"],
  // L7043 — sync button glyph ↻
  ['"。")}', '"↻")}'],
  // L7122 — 接入 Trae / 此项目
  ["一键接。Trae，让 AI 直接搜索此项", "一键接入 Trae，让 AI 直接搜索此项目"],
  // L7365 — 已保存
  ["续传 · 已保。${(props.llmDownload.resumedFromBytes / 1024 / 1024).toFixed(1)} MB",
   "续传 · 已保存 ${(props.llmDownload.resumedFromBytes / 1024 / 1024).toFixed(1)} MB"],
];

let applied = 0;
const missed = [];
for (const [find, replace] of fixes) {
  if (text.includes(find)) {
    text = text.split(find).join(replace);
    applied++;
    console.log("OK :", find.slice(0, 50).replace(/\n/g, " "));
  } else {
    missed.push(find);
    console.log("MISS:", find.slice(0, 50).replace(/\n/g, " "));
  }
}
writeFileSync(PATH, text, "utf8");
console.log(`\napplied ${applied}/${fixes.length}, missed ${missed.length}`);
