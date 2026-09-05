# SAG Windows 打包指南

> 你手里这个文件夹是 **3 MB** 的源码包，**不含 node_modules / dist / sag.exe**。
> 目标：在 Windows 上跑出真正的 Windows 原生 `sag.exe`（含 Windows 版 better-sqlite3 / sqlite-vec / onnxruntime）。

## 一次性环境准备（在 Windows 上）

1. **安装 Node.js v22.23.1 LTS**（必须这个版本，`build-windows-exe.mjs` 写死了 SEA 哨兵）
   - 官方下载：<https://nodejs.org/dist/v22.23.1/node-v22.23.1-x64.msi>
   - 装完验证：`node -v` → `v22.23.1`
2. **安装 Python 3.11+**（某些原生模块的 prebuild 偶尔需要）
3. **安装 Visual Studio Build Tools**（仅当 `npm install` 触发原生编译时；一般 prebuild 会跳过）
   - 跳过此步也是可以的（90% 情况不需要）
4. （可选）安装 **7-Zip**（`build-windows-exe.mjs` 优先用 `unzip`/`tar`，全失败才 fallback 到 PowerShell）

## 一步一步跑

把整个文件夹拷到 Windows 上（整目录，不要只拷里面的文件），然后在**该目录**下打开 PowerShell / CMD：

### 第 1 步 — 装依赖（首次 3-5 分钟）

```powershell
npm install
```

> 此步骤会从 npm 拉 Windows 版的 better-sqlite3 预编译二进制（不需要 VS 编译）。
> 如果报 `ERR_DLOPEN_FAILED` 或 `gyp ERR!`，说明需要装 VS Build Tools。

### 第 2 步 — 编译 TypeScript + 前端

```powershell
npm run build
```

等同于依次跑：
- `npm run build:api`  →  `tsc -p tsconfig.build.json` 产出 `dist/src/`
- `npm run build:web`  →  `vite build` 产出 `web/dist/`

### 第 3 步 — 打 SEA bundle（耗时最久，5-10 分钟）

```powershell
npm run build:sea-bundle
```

> 这一步会打包全部源 + 把 better-sqlite3 / sqlite-vec / onnxruntime / bindings 原生文件 base64 进 `dist/sag.native-map.json`，然后生成 `dist/sag.blob`。

### 第 4 步 — 把 blob 注入 Windows node.exe（产出 sag.exe）

```powershell
npm run build:windows-exe
```

或者一把梭：

```powershell
npm run build:windows
```

> 会自动从 npmmirror 镜像下载 `node-v22.23.1-win-x64.zip`，解压后用 `postject` 把 `sag.blob` 注入 `node.exe` 生成 `sag.exe`。

### 第 5 步 — 跑起来

```powershell
.\sag.exe
```

输出应该看到 `SAG backend ready on 4173`，然后浏览器开 `http://localhost:4173`。

## 网络 / 镜像问题

`build-windows-exe.mjs` 自动试三个镜像，按顺序：

```
1. https://npmmirror.com/mirrors/node/v22.23.1/node-v22.23.1-win-x64.zip
2. https://nodejs.org/dist/v22.23.1/node-v22.23.1-win-x64.zip
3. https://registry.npmmirror.com/-/binary/node/v22.23.1/node-v22.23.1-win-x64.zip
```

如果全失败：
- 自己手动下载 → 放到 `C:\sag-windows-node\` 解压 → 设置环境变量 `SAG_WIN_NODE_CACHE=C:\sag-windows-node`
- 脚本会复用已存在的 `node.exe`（约 80 MB）

## 常见坑

| 现象 | 原因 | 解决 |
|------|------|------|
| `downloaded node.exe does not embed the SEA sentinel` | 镜像返回的是精简版 Node | 换镜像，或改用 `nodejs.org/dist` |
| `better-sqlite3` 启动报 `The specified module could not be found` | 没装 Windows 预编译版 | 删 `node_modules` 重跑 `npm install`，加 `--force` |
| `postject failed` | `node_modules/.bin/postject` 缺失 | 脚本会自动 `npm install --no-save postject`，失败就手动跑一遍 |
| 端口 4173 被占用 | 上一次没杀进程 | 任务管理器结束 `sag.exe` 或 PowerShell：`Get-Process sag -ErrorAction SilentlyContinue \| Stop-Process -Force` |
| `sag.blob not found` | 没跑 `build:sea-bundle` | 重新执行第 3 步 |

## 验证 checklist

打包完之后确认下面这些都对：

- [ ] `sag.exe` 大小 ≈ **180 MB**（和 Linux 版一致，因为只是宿主 node.exe 不同）
- [ ] 文件类型识别为 Windows PE：在 PowerShell 跑 `Get-Item sag.exe` 看 `LinkType` / 文件管理器属性显示 "应用程序 (.exe)"
- [ ] 第一次启动会在 `%TEMP%\sag-sea-native-xxxxxxxx\` 抽取原生模块（约 90 MB）
- [ ] 浏览器访问 `http://localhost:4173/` 能看到 SAG UI

## 不打包进项目的内容（运行时按需下载）

- **BGE 中文 embedding 模型**（`models/bge-large-zh-v1.5/`）：可选。本地无模型时 SAG 会 fallback 到云端 API。
  手动下载：在 Linux 上跑过 `bash scripts/download-bge-model.sh` 的话，模型在 `models/` 目录，**整个 `models/` 目录都没打包进本包**——需要单独拷，体积 ~130 MB。
- **PostgreSQL**：生产部署可选，本地默认用 SQLite（`data/sag.db` 自动生成）。

## 文件清单

```
SAG-windows-pack/
├── package.json              ← Node 项目元信息 + 依赖版本
├── package-lock.json         ← 锁版本，**必须带**
├── tsconfig.json             ← TS 主配置
├── tsconfig.build.json       ← tsc 编译配置
├── vite.config.ts            ← 前端构建配置
├── tailwind.config.js        ← 样式
├── postcss.config.js         ← 后处理
├── vitest.config.ts          ← 测试（不需要可以略）
├── eslint.config.js          ← lint（不需要可以略）
├── docker-compose.yml        ← (可选) Postgres 部署
├── LICENSE                   ← MIT
├── .env.example              ← 环境变量范例
├── .gitignore
├── README.md / README-CN.md  ← 项目说明
├── src/                      ← Backend TS 源码
├── web/                      ← Frontend React 源码（不含 web/dist）
│   ├── src/
│   ├── index.html
│   └── tsconfig.json
├── scripts/
│   ├── build-sea-bundle.mjs  ← ★ 打 SEA bundle
│   ├── build-windows-exe.mjs ← ★ Windows 注入脚本
│   ├── backfill-*.ts         ← 数据库回填脚本
│   ├── demo-*.ts             ← 示例
│   └── ...                   ← 其他工具脚本
├── migrations/               ← SQL 迁移（启动时自动跑）
└── docs/                     ← 设计文档
```

## 出错把日志给我看

如果哪一步报错，把**完整 PowerShell 输出**贴回来——尤其是以下几行最有用：

```powershell
node -v
npm -v
npm config get registry
# 报错的那条命令 + 完整 stdout/stderr
```
