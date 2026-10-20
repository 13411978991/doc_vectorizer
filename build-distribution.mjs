// build-distribution.mjs — Assemble the user-facing distribution bundle.
//
// What this does:
//   1. Pick a fresh staging dir at `dist-package/SAG 桌面版-<version>/`
//   2. Copy the win-unpacked Electron shell (top-level files only —
//      no native-cache / web / app; those live under resources/ inside
//      win-unpacked, so copying the directory tree wholesale works).
//   3. Drop dev-only artefacts (.tmp/, logs/, models/.cache/, migrations/).
//   4. Copy in `sag-readers/` with current certs.
//   5. Copy in `tools/sag-reader-validator/` SOURCE (the user can
//      `node src/main.mjs` to validate readers; the SEA-packaged
//      exe will land in resources/ alongside the readers).
//   6. Write a fresh SHA-256 manifest + a top-level README explaining
//      install / uninstall / first-run.
//
// IMPORTANT: this script does NOT rebuild the SEA exe. It just packages
// whatever currently lives in <repo>/release-desktop/win-unpacked.
// If you want to ship new code, run `npm run build:sea-bundle &&
// npm run build:windows-exe` first to refresh that tree.

import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  createReadStream,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { createHash } from "node:crypto";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const SRC = join(ROOT, "release-desktop", "win-unpacked");
const OUT_BASE = join(ROOT, "dist-package", `本地知识检索-${VERSION}`);
// P1 — Windows Search / Defender occasionally ghost-lock the prior
// staging dir, blocking rmSync. Try the canonical OUT first; if rmSync
// throws EPERM, fall back to a fresh sibling so the build still completes.
// The leftover locked dir gets cleaned up by the operator (or by the
// next successful build, once Search has dropped the handle).
let OUT = OUT_BASE;
const attemptRm = (target) => {
  try { rmSync(target, { recursive: true, force: true }); return true; }
  catch { return false; }
};
if (!attemptRm(OUT_BASE)) {
  OUT = join(ROOT, "dist-package", `本地知识检索-${VERSION}.fresh-${process.pid}`);
  attemptRm(OUT);
  console.warn(`[package] ${OUT_BASE} is locked by another process (AV / Windows Search); using ${OUT}`);
}

// CLI flags:
//   --include-models   keep resources/models/ in the bundle (off by default;
//                       the models are 1.8 GB and download lazily in-app)
const includeModels = process.argv.includes("--include-models");

console.log(`[package] version=${VERSION}`);
console.log(`[package] src =${SRC}`);
console.log(`[package] out =${OUT}`);

if (!existsSync(SRC)) {
  console.error(`[package] source not found: ${SRC}. Run scripts/refresh-win-unpacked.mjs first.`);
  process.exit(1);
}

// Wipe the OUT we settled on (could be OUT_BASE or a fresh sibling)
// and recreate. The OUT_BASE lock was already handled in the
// pre-flight block at the top — by the time we reach here, the only
// reason rmSync could still fail is a transient handle on the
// fallback dir itself. Surface clearly and exit.
try {
  rmSync(OUT, { recursive: true, force: true });
} catch (err) {
  throw new Error(
    `staging dir locked: ${OUT}. ${err.message}. ` +
    `Close any AV / Defender / OneDrive scan window, then rerun.`
  );
}
mkdirSync(OUT, { recursive: true });

// ── Step 1: copy the whole win-unpacked tree ──────────────────────────
console.log("[package] copying win-unpacked …");
const skipNames = new Set([
  // dev / runtime cruft that shouldn't ship
  "logs",
  ".tmp",
  // huggingface download cache (models download lazily)
  ".cache"
]);
// Additional sub-directory pruning inside native-cache/. The runtime
// only needs the x64 CPU + x64 CUDA variants — arm64/vulkan are dead
// weight on the audit platform (E5-2676 v3 + RTX 3060, no Vulkan).
// We trim these after the main copy below so the win-unpacked source
// tree stays intact for dev iteration.
if (!includeModels) {
  skipNames.add("models");
  console.log("[package] models excluded (1.8 GB; users download via SAG Settings)");
}
copyDirFiltered(SRC, OUT, skipNames);

// ── Step 2: overlay sag-readers/ with current certs ──────────────────
console.log("[package] overlaying sag-readers/ …");
const readersSrc = join(ROOT, "sag-readers");
const readersDst = join(OUT, "resources", "sag-readers");
copyDirFiltered(readersSrc, readersDst, new Set(["__pycache__"]));

// ── Step 3: overlay validator source under resources/validator ────
console.log("[package] overlaying tools/sag-reader-validator/ …");
const validatorSrc = join(ROOT, "tools", "sag-reader-validator");
const validatorDst = join(OUT, "resources", "validator");
mkdirSync(validatorDst, { recursive: true });
for (const f of ["src", "package.json", "POLICY.md", "README.md", "SHA256.txt"]) {
  const s = join(validatorSrc, f);
  const d = join(validatorDst, f);
  if (statSync(s).isDirectory()) {
    copyDirFiltered(s, d, new Set());
  } else {
    copyFileSync(s, d);
  }
}

// ── Step 3a: native-cache ships as-is. ──────────────────────────
// Earlier versions of this script trimmed @node-llama-cpp/* and
// onnxruntime-node/* subdirectories, but the SEA native-map
// manifest encodes every per-platform file path (it's keyed by
// content hash for cache-busting). Deleting any of those files
// from the source cache makes unpackOnce() fail at boot with
// ENOENT — the runtime assumes every manifest entry exists in
// the source. So we don't trim here; the only size win left is
// the Electron `locales/` block below (~40 MB). Operators who
// want a leaner install should rebuild with a per-arch manifest
// (out of scope here).

// onnxruntime-node: we ship EVERY platform's binaries here. The
// onnxruntime-node: we ship EVERY platform's binaries here. The
// SEA native-map manifest is emitted BEFORE this trim runs, so the
// runtime still tries to copy `darwin/arm64/libonnxruntime.dylib`
// from the source cache into the per-process hash dir and fails
// when the file is missing. The dependency on the per-platform
// binaries is intrinsic (manifest hashes per file), so trimming
// them out of the source cache breaks the unpack. The 62 MB
// darwin / linux overhead is acceptable for the desktop install.

// Electron ships ~40 MB of i18n / inspector / swiftshader bits we
// don't need for an offline audit install. Keeping zh-CN is enough
// for the audit host; the rest add zip weight without runtime value.
const localesDir = join(OUT, "locales");
if (existsSync(localesDir)) {
  for (const f of readdirSync(localesDir)) {
    if (f === "zh-CN.pak") continue;
    rmSync(join(localesDir, f), { recursive: true, force: true });
  }
}

// ── Step 3b: drop the model download helper at the package root so
//     users can pre-download models from the CLI ────────────────────
const downloadHelperSrc = join(ROOT, "download-models.mjs");
if (existsSync(downloadHelperSrc)) {
  copyFileSync(downloadHelperSrc, join(OUT, "download-models.mjs"));
  writeFileSync(
    join(OUT, "download-models.bat"),
    `@echo off
REM Download the AI models SAG needs (bge-m3, etc).
REM Usage: download-models           (just bge-m3)
REM        download-models --all     (bge-m3 + bge-large + SmolLM2)
node "%~dp0download-models.mjs" %*
`
  );
}

// ── Step 4: drop a launcher .bat for users who want to invoke the
//     validator without typing the node command ────────────────────
writeFileSync(
  join(validatorDst, "validate-reader.bat"),
  `@echo off
REM Standalone validator launcher — calls the Node script directly.
REM Requires Node 20+ on PATH. If not present, install from https://nodejs.org
node "%~dp0src\\main.mjs" %*
`,
  "utf8"
);

// ── Step 5: SHA-256 manifest for every file we ship ─────────────────
console.log("[package] computing SHA-256 manifest …");
const manifest = [];
for (const abs of walk(OUT)) {
  const rel = abs.substring(OUT.length + 1).replace(/\\/g, "/");
  const sha = createHash("sha256").update(readFileSync(abs)).digest("hex");
  const size = statSync(abs).size;
  manifest.push({ path: rel, sha256: sha, bytes: size });
}
writeFileSync(join(OUT, "SHA256.txt"), formatManifest(manifest));
console.log(`[package] ${manifest.length} files hashed`);

// ── Step 6: top-level README ──────────────────────────────────────
writeFileSync(
  join(OUT, "README.txt"),
  SAG_README(VERSION, manifest.length)
);
writeFileSync(
  join(OUT, "INSTALL.txt"),
  SAG_INSTALL()
);

// ── Step 7: report ──────────────────────────────────────────────
const totalBytes = manifest.reduce((s, e) => s + e.bytes, 0);
console.log(`[package] done: ${OUT} (${(totalBytes / 1024 / 1024).toFixed(2)} MB, ${manifest.length} files)`);

function copyDirFiltered(srcDir, dstDir, skipNames) {
  if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true });
  for (const ent of readdirSync(srcDir, { withFileTypes: true })) {
    if (skipNames.has(ent.name)) continue;
    const ss = join(srcDir, ent.name);
    const dd = join(dstDir, ent.name);
    if (ent.isDirectory()) copyDirFiltered(ss, dd, skipNames);
    else if (ent.isFile()) copyFileSync(ss, dd);
  }
}

function walk(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function formatManifest(entries) {
  const lines = [
    `# SAG 桌面版 distribution SHA-256 manifest`,
    `# generated: ${new Date().toISOString()}`,
    `# total files: ${entries.length}`,
    ``,
  ];
  for (const e of entries) lines.push(`${e.sha256}  ${e.path}  (${e.bytes} B)`);
  return lines.join("\n") + "\n";
}

function SAG_README(version, fileCount) {
  return `本地知识检索 v${version} — 用户分发包
================================

这是给终端用户的本地知识检索（Local Knowledge Retriever）分发包。包含完整的运行时：
  - 本地知识检索.exe (Electron 桌面壳)
  - 本地知识检索-后端.exe + native-cache (后端 Node.js SEA bundle)
  - web/dist (前端 bundle)
  - sag-readers/ (文件读取脚本)
  - validator/ (reader 校验器)

安装
----
1. 解压此目录到一个**无空格、无中文**的路径（建议 D:\\SAG\\）
   强烈建议: D:\\SAG\\doc_vectorizer\\release-desktop\\win-unpacked\\
2. 双击 "本地知识检索.exe" 启动
3. 首次启动会自动初始化 SQLite 数据库（位置：%APPDATA%\\sag\\）
4. 浏览器会自动打开 http://127.0.0.1:4173/
5. （可选）设置 → 嵌入模型 → 下载 bge-m3 / BGE-large

卸载
----
直接删除整个目录即可。所有用户数据在 %APPDATA%\\sag\\，
需要彻底清理时一并删除。

文件读取脚本（sag-readers/）
---------------------------
本地知识检索-后端.exe 调用 sag-readers/ 下的脚本读取 .docx/.xlsx/.pptx/.pdf 等文件。
每个 reader 必须有对应的 .sag-validator-cert.json 证书才会被使用。

新电脑 / 新环境的 agent 在写新 reader 时：
  1. 参考 sag-readers/README.md 的环境探测指南
  2. 实现 reader 脚本（Python 或 PowerShell）
  3. 跑 resources\\validator\\src\\main.mjs 验证
  4. cert 文件会和 reader 一起被打包

校验器
------
resources\\validator\\src\\main.mjs 是 reader 校验器源码。
需要 Node.js 20+ 运行：
  node resources\\validator\\src\\main.mjs --validate <reader-path> --probe-file <file>

校验标准（12 项）详见 resources\\validator\\POLICY.md。
校验规则的 SHA-256 指纹：resources\\validator\\SHA256.txt。
任何修改 source 后没更新 EXPECTED_VALIDATOR_SHA256（本地知识检索-后端.exe 源码内）
都会导致 cert 被拒绝。

文件清单（${fileCount} 个）
--------
详细 SHA-256 见 ./SHA256.txt。校验：
  Get-FileHash .\\本地知识检索.exe -Algorithm SHA256
对比 GitHub release 页 / 项目维护者发布的 SHA256 即可验证完整性。

技术支持
--------
• 本地知识检索-后端.exe 启动失败 → 检查 %APPDATA%\\sag\\logs\\ 下最新的 sag-*.log
• reader 没被调用 → 检查 resources\\sag-readers\\ 下是否有 .sag-validator-cert.json
• BGE 模型下载慢 → 切到 设置 → 嵌入模型 → 选更小的模型
`;
}

function SAG_INSTALL() {
  return `本地知识检索 快速安装
======================

1. 解压到目标路径
   推荐: D:\\SAG\\doc_vectorizer\\release-desktop\\
   解压后目录里应该有: 本地知识检索.exe + 本地知识检索-后端.exe + resources/

2. 确保路径无空格
   错误: "C:\\Program Files\\本地知识检索\\..." (有空格)
   正确: "D:\\SAG\\..." (无空格)

3. 双击 本地知识检索.exe
   首次启动会:
   - 弹出 Windows SmartScreen (点"更多信息" → "仍要运行")
   - 自动初始化 SQLite (3-5 秒)
   - 打开浏览器到 http://127.0.0.1:4173/

4. 看到登录 / 项目页即成功

5. 关闭方式
   - 关闭浏览器窗口
   - 本地知识检索.exe 自动退出
   - 或在系统托盘右键 → 退出

故障排查
--------
• 端口被占用 → 关闭 4173 端口的其他进程
• 本地知识检索-后端.exe 启动后立刻退出 → 检查是否有旧实例 (任务管理器)
• SQLite 锁定 → 删除 %APPDATA%\\sag\\data\\sag.db-shm / sag.db-wal
`;
}