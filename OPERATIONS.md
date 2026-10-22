# SAG 桌面版 — 操作手册

> 适用版本：桌面便携版（Electron 外壳 + SEA 后端）
> 适用对象：拿到分发包、需要把知识库跑起来并接入外部 Agent 的使用者
> 阅读时间：约 10 分钟

这份文档讲的是**拿到包之后怎么用**：解压、启动、挂载文件夹、接入 MCP、出问题怎么查。
如果你要自己从源码编译，看 [BUILD_ON_WINDOWS.md](BUILD_ON_WINDOWS.md)；要部署给别人看，看 [DISTRIBUTION.md](DISTRIBUTION.md)。

---

## 目录

1. [五分钟快速开始](#1-五分钟快速开始)
2. [包内结构](#2-包内结构)
3. [启动](#3-启动)
4. [挂载本地文件夹](#4-挂载本地文件夹)
5. [接入 MCP（Trae / Claude / Cursor）](#5-接入-mcptrae--claude--cursor)
6. [日常使用](#6-日常使用)
7. [配置项](#7-配置项)
8. [数据与备份](#8-数据与备份)
9. [故障排查](#9-故障排查)
10. [已知限制](#10-已知限制)

---

## 1. 五分钟快速开始

**第 1 步 — 解压**

把 `SAG-桌面版-portable.zip` 解压到一个**不带空格、不带中文**的目录，例如 `D:\sag\`。

> 不要解压到桌面。OneDrive / 各类同步盘会锁文件，导致 SQLite 写入失败或启动异常。

**第 2 步 — 双击 `SAG-桌面版.exe`**

窗口会自动打开。第一次启动较慢（见下方说明），属于正常。

**第 3 步 — 建项目**

在 Web UI 里新建项目。

**第 4 步 — 挂文件夹**

进入项目 → 数据源 → 添加本地文件夹。系统会自动切片、向量化、抽取事件与实体。

**第 5 步 — 提问**

切到"检索"页，用自然语言提问，右栏可以看到每一跳召回的过程。

> **关于首次启动慢**：首次启动需要解压约 300 MB 的原生依赖到 `resources/native-cache/`，还要跑一次数据库迁移，
> 实测 20–60 秒（取决于磁盘和杀软）。**这段时间窗口是空白的，属于正常**。之后再启动是秒开。
> 首次启动超时上限是 120 秒；如果你在这段时间内看到"backend failed to become ready"，说明确实出问题了，看 [第 9 节](#9-故障排查)。

---

## 2. 包内结构

解压后大致长这样：

```text
SAG-桌面版-portable\
├─ SAG-桌面版.exe              ← 主程序，双击这个（Electron 外壳，180 MB）
├─ resources\
│  ├─ SAG-backend.exe          ← 后端服务（HTTP API + Web UI）
│  ├─ SAG-mcp.exe              ← MCP stdio 入口，给 Trae / Claude / Cursor
│  ├─ SAG-ingest-worker.exe    ← 文档摄入 worker
│  ├─ native-cache\            ← 首次启动时在此解压原生依赖
│  ├─ sag-readers\             ← 文档读取脚本（含证书）
│  └─ data\                    ← 数据库在这里（首次启动后生成）
├─ locales\                    ← Electron 语言包
├─ *.dll / *.pak / *.bin        ← Electron 运行时，别删
└─ LICENSE / LICENSES.chromium.html
```

**必须整个目录一起复制。** 单独拷 `SAG-桌面版.exe` 是跑不起来的。

### 四个 exe 分别是什么

| 文件 | 作用 | 谁来启动 |
|---|---|---|
| `SAG-桌面版.exe` | 桌面窗口外壳。启动后端并开一个内嵌浏览器窗口指向它 | 你手动双击 |
| `SAG-backend.exe` | 真正干活的 Fastify 服务，监听 4173 | 被 `SAG-桌面版.exe` 自动拉起 |
| `SAG-mcp.exe` | stdio MCP 服务，供外部 Agent 调用 | 被 Trae / Claude 自动拉起 |
| `SAG-ingest-worker.exe` | 文档转换 / 摄入的子进程 | 被后端按需拉起 |

> 名字里的 `桌面版` 是中文，注意**不要改名**。Electron 33 对纯 ASCII 的 exe 名会走
> `default_app.asar` 回退逻辑，导致启动失败。

---

## 3. 启动

### 3.1 桌面模式（推荐给日常使用）

双击 `SAG-桌面版.exe` 即可。窗口打开后，界面就是 Web UI。

关掉窗口 = 结束整个服务（后端子进程会一起被回收）。

> **重复双击不会开第二个窗口。** 桌面版有单实例锁：已经在跑的时候再双击，
> 只会把已有窗口**唤醒并聚焦**到前台。
>
> 这个锁是**全局的**（按 Windows 用户，不按安装目录）。所以同一台电脑上
> **不能同时跑两个不同目录下的 SAG 桌面版** —— 后启动的那个会立刻退出，
> 什么也不显示。调试多份副本时，给其中一个加 `--user-data-dir=<独立目录>`
> 参数来隔离：
>
> ```powershell
> .\SAG-桌面版.exe --user-data-dir=D:\sag-test-profile
> ```

### 3.2 想用浏览器访问 / 让别人访问

后台端服务是标准 HTTP 服务，也可以单独跑：

```powershell
cd D:\sag
.\resources\SAG-backend.exe
```

看到类似输出即表示起来了：

```
server: listening on http://0.0.0.0:4173
```

然后浏览器打开 <http://localhost:4173>。

> **端口被占用会自动顺延**：4173 被占时依次尝试 4174 → 4175 → … → 4183。
> 桌面版会自动跟随（后端会打印 `SAG_BOUND_PORT=<N>`，外壳据此切换窗口地址），
> 但如果你手动跑 `SAG-backend.exe`，记得看它实际绑到了哪个端口。

### 3.3 首次启动的 SmartScreen 提示

双击可能弹出"Windows 已保护你的电脑"。点 **更多信息 → 仍要运行**。因为 exe 没做代码签名，不影响功能。

---

## 4. 挂载本地文件夹

这是 SAG 的核心用法：把一个本地目录变成可检索的知识库。

1. 打开 SAG 桌面版
2. 进入目标项目 → **数据源**
3. 添加一个本地文件夹路径，例如 `D:\我的文档`
4. 选择是否递归子目录、文件白名单 / 黑名单、最大文件大小
5. 启动 watcher

之后这个文件夹里的**新增、修改、删除**都会自动同步进知识库，不需要手动上传。

支持的格式：

- `.txt` `.md` — 直接读取
- `.pdf` `.docx` `.xlsx` `.xls` `.csv` `.png` `.jpg` `.jpeg` — 经转换器处理
- 其他扩展名 — 跳过（会在 manifest 里标记为 skipped）

> 详细的场景配置（Obsidian 库、团队共享盘、项目归档等）、过滤规则优先级、
> 以及 watcher 的完整行为，见 [docs/watched-folders/USER_GUIDE.md](docs/watched-folders/USER_GUIDE.md)。

> **注意**：watcher 默认**不随启动自动全量扫描**。如果希望启动即扫，
> 在 `resources\.env` 里设 `WATCHER_AUTOSTART=true`。

---

## 5. 接入 MCP（Trae / Claude / Cursor）

### 5.1 先拿项目 ID

在 Web UI 里打开你的项目，界面上会显示当前项目 ID（UUID，形如 `3e2c108f-0ace-4251-aa07-6af291268015`）。

### 5.2 写 MCP 配置

打开 Trae → 设置 → 搜索 "MCP" → 找到 **Edit in settings.json**，贴入：

```json
{
  "mcpServers": {
    "sag": {
      "command": "D:\\sag\\resources\\SAG-mcp.exe",
      "args": [],
      "env": {
        "DATABASE_FILE": "D:\\sag\\resources\\data\\sag.db",
        "DEFAULT_TENANT_ID": "default",
        "LOG_LEVEL": "warn"
      }
    }
  }
}
```

**三个必须注意的点：**

1. **路径里的 `\\` 是 JSON 转义**，必须写双反斜杠。
2. **路径指向 `resources\` 里面。** MCP exe 和后端 exe 在同一个目录（`resources/`），
   数据库也在 `resources/data/sag.db`。写错会导致 MCP 连到一个空的、甚至新建的数据库。
   > 不写 `DATABASE_FILE` 时 MCP 会自动推断成 `<exe所在目录>\data\sag.db`，
   > 在标准布局下正好就是 `resources\data\sag.db`。但**显式写上更保险** ——
   > 连接池初始化早于这个自动推断，显式指定可以避免任何路径歧义。
3. **改完必须完全退出 Trae 再重开**，reload 工作区不会重扫 MCP 配置。

### 5.3 绑定到单个项目（scoped 模式）

只允许 MCP 操作某一个项目时，加上 `SAG_MCP_SOURCE_ID`：

```json
"env": {
  "DATABASE_FILE": "D:\\sag\\resources\\data\\sag.db",
  "SAG_MCP_SOURCE_ID": "3e2c108f-0ace-4251-aa07-6af291268015"
}
```

效果：

- `sag_list_projects` 只返回这一个项目
- `sag_search` / `sag_ingest_document` 强制只能对它操作
- `sag_create_project` / `sag_archive_project` / `sag_delete_project` 被拒绝

> 如果 UUID 填错（指向不存在的项目），`SAG-mcp.exe` **启动时就会报错退出**，
> 并在错误信息里列出当前可用的项目 ID —— 不会静默跑空。

不设 `SAG_MCP_SOURCE_ID` 也可以，此时 MCP 对整个租户（默认 `default`）生效，
但 `sag_search` 等工具需要在自己的参数里传 `sourceIds`。

### 5.4 可用工具

实测共 **15 个**（`tools/list` 返回）：

**检索与文档**

| 工具 | 作用 |
|---|---|
| `sag_search` | 在项目上跑 multi-route 召回，返回结果 + 检索 trace |
| `sag_ingest_document` | 导入文档：切片 + 事件抽取 + 实体抽取 + 向量化 |
| `sag_explain_search` | 返回当前检索 pipeline 的解释和 trace |
| `sag_get_event` | 按 event ID 查询事件详情 |

**项目管理**

| 工具 | 作用 |
|---|---|
| `sag_list_projects` | 列出项目 |
| `sag_create_project` | 新建项目 |
| `sag_archive_project` | 归档项目 |
| `sag_delete_project` | 删除项目 |
| `sag_project_stats` | 项目统计信息 |

**文件夹挂载**

| 工具 | 作用 |
|---|---|
| `add_watched_folder` | 添加一个被监听的文件夹并启动 watcher |
| `list_watched_folders` | 列出所有被监听的文件夹及其状态 |
| `trigger_sync` | 手动触发一次同步 |
| `retry_failed_file` | 重试单个失败的摄入 |
| `retry_failed_files` | 重试所有失败的摄入 |
| `remove_watched_folder` | 移除监听（已摄入的文档会保留） |

### 5.5 验证连上了

Trae 重开后看 MCP 面板，`sag` 应显示 **connected**，并列出上面这些工具。

> 更详细的 MCP 说明（HTTP 远程模式、bearer 鉴权、防火墙配置）见 [docs/MCP.md](docs/MCP.md)。

---

## 6. 日常使用

### 6.1 在 Trae / Claude 里直接问

不用记命令，正常提问即可：

> 找出审计报告里所有提到"动环系统"的内容

Agent 会自己调用 `sag_search` 并整理结果。

### 6.2 在桌面版里检索

"检索"页直接提问，支持两种模式：

| 模式 | 特点 | 什么时候用 |
|---|---|---|
| **极速（fast）** | BM25 + 多跳召回 + rerank，**不调 LLM 抽查询实体** | 日常、追求快 |
| **标准（standard）** | 先用 LLM 抽查询实体，再多路召回 + LLM rerank | 精度优先，可以慢一点 |

### 6.3 query 怎么写

自然语言短语，不是 SQL。

**好的写法：**
- `质量事件`
- `联想电脑质量事件的发现过程`
- `动环系统相关的设备`

**避免：**
- `联想 AND 质量` —— 会被当成普通字符串
- 整段粘贴的长文 —— 会被截断

### 6.4 直接调 HTTP API

```powershell
$body = @{
  query       = "质量事件"
  sourceIds   = @("3e2c108f-0ace-4251-aa07-6af291268015")
  topK        = 5
  searchMode  = "fast"
  returnTrace = $true
} | ConvertTo-Json

Invoke-RestMethod -Method Post `
  -Uri "http://localhost:4173/api/search" `
  -Body $body -ContentType "application/json"
```

> `sourceIds` **是必填的**，必须是项目 UUID 数组。
> `searchMode` 可选 `fast` / `standard`（默认 `fast`），
> `strategy` 可选 `multi` / `vector`（默认 `multi`）。

---

## 7. 配置项

桌面版读环境变量。要改配置，在**启动前**设置同名环境变量，或复制
`resources\.env.example` 为 `resources\.env` 后编辑。

> 后端进程的 cwd 就是 `resources\`，所以 `.env` 必须放在 `resources\` 下才生效
> （`dotenv/config` 只读当前工作目录）。放在解压根目录是不管用的。

### 常用

| 变量 | 默认 | 说明 |
|---|---|---|
| `HTTP_PORT` | `4173` | 后端端口。被占用时自动顺延到 4183 |
| `DATABASE_FILE` | `<exeDir>/data/sag.db` | 数据库位置 |
| `SAG_DATA_DIR` | 未设 | 把整个数据树挪到别处，见 [第 8 节](#8-数据与备份) |
| `DEFAULT_TENANT_ID` | `default` | 租户 ID |
| `SAG_MCP_SOURCE_ID` | 未设 | 锁定单个项目，见 [5.3](#53-绑定到单个项目scoped-模式) |
| `WATCHER_AUTOSTART` | `false` | 启动即扫描已挂载文件夹 |
| `ALLOW_PROD_WATCHER` | `false` | 生产环境挂载文件夹的总开关 |

### Embedding（决定检索质量）

| 变量 | 说明 |
|---|---|
| `EMBEDDING_PROVIDER` | `api`（云端 OpenAI 兼容 API，默认）/ `local-bge`（本地 ONNX 模型，离线） |
| `EMBEDDING_BASE_URL` | 云端 API 地址，OpenAI 兼容 |
| `EMBEDDING_API_KEY` | 云端 API key |
| `EMBEDDING_MODEL` | 如 `text-embedding-3-large` |
| `EMBEDDING_DIMENSIONS` | `1024`（默认）或 `4096` |
| `EMBEDDING_LOCAL_MODEL_PATH` | `local-bge` 模式下的模型目录 |

> ⚠️ **维度只能选 1024 或 4096**，且必须和已建库时一致。
> 换了维度不匹配的模型，检索会静默返回错误结果。

> ⚠️ **只有 `api` 和 `local-bge` 两个合法值。** 早期的 `local`（SHA256 伪向量，
> 仅供测试用）已于 2026-10-13 移除。`.env` 里残留 `EMBEDDING_PROVIDER=local`
> 会导致启动时 zod 校验直接报错退出 —— 改成 `api` 或 `local-bge`。

> ⚠️ **不配置任何 key 时没有"占位"模式可用。** 要么配云端 API，
> 要么配 `local-bge` 并把模型放到 `EMBEDDING_LOCAL_MODEL_PATH` 指向的目录。

---

## 8. 数据与备份

### 数据在哪

```
resources\data\sag.db          ← 主数据库
resources\data\sag.db-shm      ← WAL
resources\data\sag.db-wal      ← WAL
```

> 用 SQLite 不用 PostgreSQL 的好处就在这里：**整个知识库就是一个文件，备份 = 拷贝。**

### 备份

关掉程序后，直接拷 `resources\data\` 整个目录即可。

### 迁移到别的盘（C 盘满了）

在启动前设置：

```
SAG_DATA_DIR=D:\sag-data
```

数据会落到 `D:\sag-data\data\sag.db`。
> **必须在首次启动前设置**，否则 native-cache 已经按旧位置解压了。

### 重置

删掉 `resources\data\` 整个目录，下次启动会自动重建（**丢失所有已摄入的文档**）。

---

## 9. 故障排查

### 9.1 双击没反应 / 一闪而过

按顺序排查：

1. **系统缺 `vcruntime140_1.dll`。** 这是最常见的原因，而且**会同时导致本机所有 Electron 应用打不开**（VSCode、微信开发者工具等）。
   解决：装微软 VC++ 2015-2022 可再发行组件包（x64）。
   > 注意：这种情况跟 SAG 本身无关，别误判成程序问题。

2. **SmartScreen 没点放行。** 点"更多信息 → 仍要运行"。

3. **被杀毒软件 / DLP 拦截。** 把整个解压目录加白名单。

4. **解压路径带空格或中文。** 挪到 `D:\sag\` 这类干净路径。

### 9.2 窗口空白 / 一直转圈 / 双击后立刻消失

**双击后立刻消失、什么都没有** —— 先看 [单实例锁](#31-桌面模式推荐给日常使用)：
本机已经有另一个 SAG 桌面版在跑（包括**另一个目录下的**）时，新实例会直接退出。
这不是崩溃。

**窗口空白、一直转圈** —— 首次启动要解压 300 MB 原生依赖，实测 **20–60 秒**。
超过 120 秒报 `backend failed to become ready within 120000ms` 才是真问题。

看日志：`<解压目录>\resources\logs\desktop-<时间戳>.log`

> 日志为空 = 进程在 Electron 初始化之前就退出了，优先查单实例锁和缺 DLL。

### 9.3 端口被占用

```powershell
netstat -ano | findstr :4173
taskkill /F /PID <pid>
```

### 9.4 MCP 连不上

1. 完全退出 Trae 再重开（reload 工作区不够）
2. 检查 `command` 路径 —— 反斜杠必须是 `\\`，且路径要指到 `resources\SAG-mcp.exe`
3. 检查 `DATABASE_FILE` 是否指向 `resources\data\sag.db`
4. 看 Trae 输出面板选 "MCP" / "Trae MCP" 找具体报错
5. 把解压目录加 DLP / 杀软白名单

### 9.5 MCP 连上了但搜不到东西

大概率是 `SAG_MCP_SOURCE_ID` 指向的项目不对，或者 MCP 连到了另一个数据库。
两个 exe 必须指向**同一个 `sag.db`**。

### 9.6 日志里这些报错可以忽略

| 日志片段 | 说明 |
|---|---|
| `Cannot load "@napi-rs/canvas"` | 无害。图像相关的可选依赖，功能不受影响 |
| `embedding worker terminated: Cannot find module '@xenova/transformers'` | 回退到进程内 embedding，`embedding.loaded: true` 仍然正常 |
| `[sag-mcp] migration warning: No such built-in module: better-sqlite3` | 无害。启动器里那次预迁移没跑成，但真正的迁移由 MCP 服务本体完成 —— 表结构齐全，工具照常可用 |

### 9.7 想看实时日志

```powershell
cd D:\sag
.\resources\SAG-backend.exe 2>&1 | Tee-Object -FilePath sag.log
```

桌面版自身的日志在 `resources\logs\desktop-*.log`。

---

## 10. 已知限制

- **未签名 binary** —— 首次启动有 SmartScreen 提示
- **exe 名必须保留中文 `桌面版`** —— 改成纯 ASCII 会启动失败
- **Embedding 维度锁死 1024 / 4096** —— 换模型必须维度一致
- **本地 ONNX 模型需自备** —— 用 `local-bge` 要先把 BGE 模型放到
  `resources\models\bge-large-zh-v1.5\`，并在 Web UI 的「AI Provider」里把
  Local model path 指到该目录
- **sqlite-vec 仅 Windows x64 有预编译包** —— macOS / Linux 需要从源码编译
- **解压目录不要放同步盘 / 桌面** —— 文件锁会导致 SQLite 异常
- **MCP exe 名字变了** —— 旧版本是 `本地知识检索-mcp.exe`，现在是 `SAG-mcp.exe`，
  老配置里的路径需要手动改

---

## 相关文档

| 文档 | 内容 |
|---|---|
| [README.md](README.md) | 项目总览、源码开发流程 |
| [BUILD_ON_WINDOWS.md](BUILD_ON_WINDOWS.md) | Windows 从源码编译 |
| [DISTRIBUTION.md](DISTRIBUTION.md) | 分发包交付清单 |
| [docs/MCP.md](docs/MCP.md) | MCP 集成详解（含 HTTP 模式） |
| [docs/watched-folders/USER_GUIDE.md](docs/watched-folders/USER_GUIDE.md) | 文件夹挂载用户指南 |
| [docs/watched-folders/TROUBLESHOOTING.md](docs/watched-folders/TROUBLESHOOTING.md) | watcher 故障排查 |
