# SAG Windows 打包 · AI 执行指南

> **目标受众**：在 Windows 机器上运行的 AI Agent / LLM coding tool（Claude Code / Cursor / Copilot 等）。
> **任务**：把当前 SAG 源码目录打包成一个 Windows 原生 `sag.exe`，直接可分发。
> **预期耗时**：10-20 分钟。

---

## 0. 你要做的事，一句话

在 Windows 上执行 `npm install && npm run build:windows`，产出根目录的 `sag.exe`（约 180MB，单文件可执行），与当前 Linux 版本 `/home/admin/.openclaw/workspace/SAG/sag.exe` 功能完全一致。

---

## 1. 环境自检（执行任何命令之前必须跑）

逐条执行并校验，**任何一条不通过先解决，不要继续**：

```powershell
# Node 必须 v22.23.1，SEA 哨兵写死这一版
node -v
# 期望输出: v22.23.1
# 不通过: 去 https://nodejs.org/dist/v22.23.1/node-v22.23.1-x64.msi 装

npm -v
# 期望输出 >= 10

# 包管理器镜像（国内重要）
npm config get registry
# 期望: https://registry.npmmirror.com 或 https://registry.npmjs.org
# 慢就改成: npm config set registry https://registry.npmmirror.com

# PowerShell 版本
$PSVersionTable.PSVersion.Major
# 期望 >= 5

# 解压工具（build 脚本会自动选，缺一个就用 PowerShell 兜底）
# unzip / tar / 7z 至少有 PowerShell Expand-Archive，不需要额外装
```

如果当前目录不是 SAG-windows-pack，先 `cd` 进去再开始。

---

## 2. 打包主流程

按顺序跑，**每一步失败先看第 3 节错误码再继续**。

### Step 1 — 装依赖

```powershell
npm install
```

期望: 0 error 退出；better-sqlite3 会下载 Windows prebuilt binary（约 5MB），不触发 gyp 编译。

### Step 2 — 编译源码

```powershell
npm run build
```

期望: 0 error；`dist/src/` 和 `web/dist/` 各有产物。

### Step 3 — 打 SEA bundle（最耗时）

```powershell
npm run build:sea-bundle
```

期望: 看到 `[sea-build] DONE — run npm run build:windows-exe to finish.`；`dist/sag.blob` 约 90MB。

### Step 4 — 注入 Windows node.exe

```powershell
npm run build:windows-exe
```

期望: 看到 `[win-exe] ✓ sag.exe ready: <path> (~180 MB)`；根目录产生 `sag.exe` 约 180MB。

### 一把梭

上面任一条挂了，把错误信息（节选第 3 节相关编号）扔回去修：

```powershell
npm run build:windows
```

这条等价于先后跑 build + build:sea-bundle + build:windows-exe。

---

## 3. 错误诊断（按现象 → 原因 → 修复）

### 3.1 `better-sqlite3` 报 `gyp ERR!` 或 `find Python`

- **原因**: Python 找不到（prebuild 没拿到，触发本地编译）
- **修复**:
  1. 装 Python 3.11+（勾选 "Add to PATH"）
  2. 装 VS Build Tools 2022（勾选 "Desktop development with C++"）
  3. `npm rebuild better-sqlite3 --build-from-source`
  4. 或者强删重装: `Remove-Item -Recurse -Force node_modules\better-sqlite3; npm install --force`

### 3.2 `downloaded node.exe does not embed the SEA sentinel`

- **原因**: 镜像返回的是精简 Node（去掉了 SEA fuse）
- **修复**:
  1. 手动下载: <https://nodejs.org/dist/v22.23.1/node-v22.23.1-win-x64.zip>
  2. 解压到 `C:\sag-windows-node\node-v22.23.1-win-x64\`
  3. `setx SAG_WIN_NODE_CACHE "C:\sag-windows-node"`
  4. 重新跑 `npm run build:windows-exe`

### 3.3 `postject failed` 或 `Cannot find module 'postject'`

- **原因**: 镜像缺失（@yao-pkg/pkg 应提供）
- **修复**:
  ```powershell
  npm install --no-save --no-audit --no-fund postject
  npm run build:windows-exe
  ```

### 3.4 `sag.blob not found` 跑 Step 4 时

- **原因**: 跳过了 Step 3
- **修复**: `npm run build:sea-bundle` 然后重跑 Step 4

### 3.5 端口 4173/4174 启动失败

- **现象**: `EADDRINUSE`
- **原因**: 旧 sag.exe 没退
- **修复**:
  ```powershell
  Get-Process sag -ErrorAction SilentlyContinue | Stop-Process -Force
  # 或者: taskkill /F /IM sag.exe
  ```

### 3.6 `spawn EINVAL` 或类似权限错误

- **修复**: 用**管理员模式** PowerShell 重跑；关闭 Defender 实时保护临时放行

### 3.7 下载 zip 三个镜像全失败

- **修复**: 用浏览器手动下载到 `C:\sag-windows-node\node-v22.23.1-win-x64.zip`，再设 `SAG_WIN_NODE_CACHE=C:\sag-windows-node`，脚本自动复用

---

## 4. 完成验收（必须跑，跑过才算完）

```powershell
# 4.1 文件存在性
Test-Path .\sag.exe
# 期望: True

# 4.2 文件类型识别
Get-Item .\sag.exe | Select-Object Name, Length, LastWriteTime
# 期望: Length 在 170MB ~ 200MB 之间

# 4.3 文件签名（PE32+ Windows）
[System.IO.File]::ReadAllBytes(".\sag.exe")[0x8000..0x8100] -join "" | Select-String -Pattern "PE32|Microsoft"
# 或者直接看: 文件管理器右键 → 属性 → 看 "类型" 是不是 "应用程序 (.exe)"

# 4.4 启动测试（后台跑 5 秒看能起来即可）
$proc = Start-Process .\sag.exe -PassThru -RedirectStandardOutput .\sag.stdout.log -RedirectStandardError .\sag.stderr.log
Start-Sleep -Seconds 5
if (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue) {
    Write-Host "✓ sag.exe 启动成功（pid $($proc.Id)）"
    Stop-Process -Id $proc.Id -Force
} else {
    Write-Host "✗ sag.exe 启动失败，看 stderr:"
    Get-Content .\sag.stderr.log
}

# 4.5 看启动日志关键信号
Get-Content .\sag.stdout.log
# 期望包含: "SAG backend ready" 或 "listening on 4173"
```

四项全过 → 把 `sag.exe` 拷出去就是可分发的产物。

---

## 5. 交付物

最终要交给用户的东西：

1. `sag.exe`（约 180 MB，可双击运行，后端开 4173 端口）
2. （可选）`.env` 文件副本（如果用户给了生产配置）
3. （可选）`models/bge-large-zh-v1.5/` 目录（约 130MB，如果用户要本地中文 embedding）

如果用户没说要不要 BGE 模型，**默认就只给 `sag.exe`**，告诉用户没模型时会自动 fallback 到云端 API。

---

## 6. 完成报告模板

打包完成后，按下面格式汇报（**不要省略任何字段**）：

```markdown
## SAG Windows 打包完成

- 耗时: X 分 X 秒
- sag.exe 路径: <abs_path>
- sag.exe 大小: XXX MB
- SHA256: <hash>
- Node 版本: v22.23.1
- 是否包含 BGE 模型: 是/否
- 测试结果: 启动成功 / 失败（原因）
- 备注: ...
```

---

## 7. 不要做的事

- ❌ 不要改 `package.json` 版本号
- ❌ 不要删 `dist/` 后跑 dev 模式（那是开发流程，不是打包）
- ❌ 不要换 Node 版本（v22.23.1 是 SEA fuse 强约束）
- ❌ 不要 `npm audit fix --force`（可能升 better-sqlite3，导致 .node ABI 不兼容）
- ❌ 不要假定有 git / GitHub / SSH（环境可能断网）
- ❌ 不要试图在 Windows 上用 pkg/nexe 替代 SEA（脚本已经选好 SEA 了）
