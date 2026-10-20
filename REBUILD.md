# SAG 源码 + 已构建产物导出包

> 抽取时间: 2026-07-27
> 来源: D:\IT审计\SAG-windows-pack (主分支)
> 用途: 在另一台电脑上重新 build sag.exe

---

## 目录结构

```
export/
├── src/                       # TypeScript 源码 (前后端 + MCP + watcher)
├── web/                       # React + Vite 前端
│   ├── src/                   # 源代码
│   ├── dist/                  # 已构建的前端 bundle
│   │   ├── index.html
│   │   └── assets/
│   │       ├── index-CoBSGEwY.js
│   │       └── index-CvS-fAPd.css
│   ├── tsconfig.json
│   └── package.json
├── migrations/                # SQLite schema (apply 顺序已确定)
├── scripts/                   # file-converter.py 等 (Python 工具)
│   └── file-converter.py
├── models/                    # 嵌入式 ML 模型 (bge-large-zh-v1.5)
├── sag.exe                    # 已构建的 SEA single-executable (含最新功能)
├── package.json               # 主项目 npm 脚本
├── package-lock.json
├── tsconfig.json
├── tsconfig.build.json
├── vite.config.ts
├── vitest.config.ts
├── postcss.config.js
├── tailwind.config.js
├── eslint.config.js
├── docker-compose.yml
├── mcp-proxy.py
├── check-db.cjs
├── AI_BUILD_SOP.md            # 构建 SOP
├── BUILD_ON_WINDOWS.md
├── README.md / README-CN.md
├── LICENSE
├── .env.example
└── .gitignore
```

---

## 在另一台电脑上重新 build sag.exe

### 1. 环境要求

- **Node.js** ≥ 20 (推荐 v22 LTS,sea-bundle 用 22+;build:windows-exe 默认拉 v24.14.0)
- **Python 3.10+** (`file-converter.py` 调用 + 亿赛通解密)
- **git** (可选)
- **Windows 10/11** (sag.exe 是 Windows SEA bundle;Linux/Mac 上 build 出 .bundle.cjs 也行,但最终部署目标是 Windows)

### 2. 安装 npm 依赖

```powershell
cd D:\IT审计\sag-source-export
npm install
```

> 这会装: esbuild, fastify, chokidar, zod, @modelcontextprotocol/sdk, @xenova/transformers,
> onnxruntime-node, sqlite-vec, lucide-react, react, tailwindcss, vite, typescript 等等
> (依赖清单在 `package.json` + `package-lock.json`)

### 3. 验证 TypeScript

```powershell
npx tsc -p tsconfig.build.json --noEmit
```

零输出 = OK。

### 4. 构建后端 (生成 dist/src/...js 给 SEA bundle 用)

```powershell
npm run build:api
```

### 5. 构建前端 (生成 web/dist/)

```powershell
npm run build:web
```

### 6. 构建 SEA bundle (打 sag.exe 的核心)

```powershell
npm run build:sea-bundle
```

> 这一步会从 npm 拉 esbuild,把 `dist/src/index.js` 打成 `dist/sag.bundle.cjs` (3.7 MB),
> 同时把 `dist/migrations/*.sql` 和 `dist/scripts/*.py` 抽到 SEA bundle 旁边。

### 7. 构建 sag.exe (Windows 唯一可执行)

```powershell
npm run build:windows-exe
```

> 这一步会:
> 1. 下载 Node v24.14.0 Windows 二进制 (~87 MB) 到 `C:\Users\...\AppData\Local\Temp`
> 2. 把它复制成 `sag.exe` (~254 MB)
> 3. 用 `postject` 把 `dist/sag.blob` 注入到 `sag.exe` 的 SEA slot
>
> 需要网络下载。如果无法下载,把 `build-windows-exe.mjs` 里的
> `NODE_VERSION` 改成本地已有的 Node 版本(或者把 cache 路径改成已有的)。

### 8. 一键全跑

```powershell
npm run build:windows
# 内部跑: build:api → build:web → build:sea-bundle → build:windows-exe
```

### 9. 部署

把以下拷到目标机器的 `D:\IT审计\SAG-windows-pack\` (或任意目录):

- `sag.exe` (新打的)
- `migrations/` (整个目录)
- `scripts/file-converter.py` (SEA bundle 会从 dist/scripts 抽,但 launcher 调时也读 scripts/)
- `web/dist/` (整个目录)
- `models/bge-large-zh-v1.5/` (如果目标机器上没装 embedding API provider 的话)
- `sag-launcher.py` + `sag-launcher.cmd` (从主分支拷,不在本 export 包里 — launcher 是 runtime 的)
- `.env` (从主分支拷 — 改 SAG_MCP_SOURCE_ID 等)

---

## 关键路径

| 文件 | 作用 |
|------|------|
| `src/index.ts` | 后端入口,启动 Fastify + watcher + MCP |
| `src/api/server.ts` | Fastify 服务器组合 |
| `src/api/watched-folders.ts` | **最近修改**: 单文件/批量重试路由 (`/retry-file` + `/retry-failed`) |
| `src/watcher/sync-orchestrator.ts` | **最近修改**: 任务 status 3 态语义 (`completed_with_errors`) |
| `src/watcher/index.ts` | **最近修改**: `retryEntries()` 优化 (不再重算 SHA-1) |
| `src/mcp/server.ts` | **最近修改**: 新增 `retry_failed_file` + `retry_failed_files` 工具 |
| `src/services/watcher-mcp-service.ts` | **最近修改**: `retryFailedFile()` + `retryFailedFiles()` |
| `src/hooks/useRetryStatus.ts` | **新增**: per-row + bulk retry 状态 + toast 队列 |
| `src/components/ui/toast.tsx` | **新增**: 右下角 toast 通知组件 |
| `web/src/pages/WatchedFolders/index.tsx` | **最近修改**: 文件清单重试按钮 + inline confirm modal |
| `web/src/lib/api.ts` | **最近修改**: 双 URL fallback (新路由 + 旧路径) |
| `scripts/file-converter.py` | 亿赛通/深信达 DLP 透明加密处理 (COM 自动化) |

---

## 验证 build 是否正确

```powershell
# 启动 sag
py -3 sag-launcher.py
Start-Sleep -Seconds 5

# 健康检查
curl http://127.0.0.1:4173/health
# 期望: {"ok":true,"service":"sag"}

# 列出监听文件夹
curl http://127.0.0.1:4173/api/watched-folders
# 期望: {"folders":[{...}]}

# 测试新重试 API
$id = (curl http://127.0.0.1:4173/api/watched-folders | ConvertFrom-Json).folders[0].id
curl -X POST http://127.0.0.1:4173/api/watched-folders/$id/retry-failed -ContentType "application/json" -Body "{}"
# 期望: {"folderId":...,"total":N,"enqueued":M,...}
```

浏览器开 `http://127.0.0.1:4173/web/`,强刷(Ctrl+Shift+R),看 web bundle hash
应该是新打的(看 `web/dist/assets/index-*.js` 文件名)。

---

## 已知事项

- 默认监听端口 4173 (web) / 4174 (MCP HTTP)
- `.env` 控制 SAG_MCP_SOURCE_ID / MCP_TRANSPORT=http / AI provider 等
- `data/sag.db` 是 SQLite,首次启动自动 migrate
- watcher 启动需要 `ALLOW_PROD_WATCHER=true` (NODE_ENV=production 时)
- 加密 docx/xlsx 自动通过 COM 解密 (需要本机装 Word/Excel/WPS + pywin32)
