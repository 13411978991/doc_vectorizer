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

> ⚠️ **不要同时跑两份 SAG。** 换版本（比如从 v2 目录换到 v3 目录）前，
> 先把旧版**完全退出**（托盘图标右键退出；不放心就在任务管理器里确认没有
> `SAG-桌面版.exe` / `SAG-backend.exe` 残留）。两个后端同时入库会把 CPU
> 打满，旧版还会占用 4173 端口，让新版的窗口加载失败。万一遇到
> 「进程在跑但窗口不出来」，先到任务管理器结束所有 `SAG*.exe` 再重新双击。

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

> **注意**：watcher 默认**不随启动自动全量扫描**。如果希望启动即扫，
> 在 `resources\.env` 里设 `WATCHER_AUTOSTART=true`。

> 详细的场景配置（Obsidian 库、团队共享盘、项目归档等）、过滤规则优先级、
> 以及 watcher 的完整行为，见 [docs/watched-folders/USER_GUIDE.md](docs/watched-folders/USER_GUIDE.md)。

### 4.1 可以挂整个盘根目录

比如 `E:\`。这是支持的，但要知道它会做什么：

**扫描阶段**（实测 E 盘 752,470 个文件 / 97,755 个目录）：

- 只走**白名单里的扩展名**，其他文件**根本不 stat、不哈希** —— 实测只收集
  6,870 个文件（占 0.9%），内存占用降 99%
- 自动**跳过 541 个目录**：系统目录（`$RECYCLE.BIN`、`System Volume Information`）、
  依赖树（`node_modules`、`.git`、`pnpm-store`、`.npm`）、备份残留（`$baksd`、`$LBak`）
- 整个扫描 **约 40 秒**完成

**摄入阶段**（这才是耗时的大头）：

- 每个 Office 文件要走 COM / Python 转换 + 本地 ONNX embedding
- 实测约 **3 个文件/分钟**（部分大文件单个要几分钟）
- 6,864 个文件 ≈ **38 小时**。这是正常速度，不是卡住了 —— 看 `resources/logs/sag-*.log`
  里 `watcher: file ingested` 一行行在加就说明还在跑

> ⚠️ **挂盘根前先配好 Embedding。** watcher 启动前会做 preflight 检查，
> 没配 embedding 会直接拒绝启动：
> `watcher: preflight failed, refusing to start`
> 在 Web UI「AI Provider」里配 `local-bge`（本地模型，离线）或云端 API。

### 4.2 排除你自己的噪音目录

内置排除列表已经覆盖系统目录和常见依赖树。如果还有自己不想索引的目录
（比如 `我的备份`、`临时`、`归档`），在 `resources\.env` 里加：

```env
SAG_WATCHER_EXCLUDE_DIRS=我的备份,临时,归档
```

逗号分隔，按**整个目录名**匹配（大小写不敏感）。所以 `我的备份` 会排除，
但 `我的备份2` 不会 —— 不会误伤。

### 4.3 被排除目录里的文件会怎样

已经索引过的文件，如果它所在的目录**后来**被排除规则命中，
它的 manifest 记录会**保留**，不会被当成"已删除"而连带删掉文档。
同理，改了白名单之后不再匹配的文件也不会被误删。

（这条是刻意的：扫不到 ≠ 文件没了。误删会连带硬删除已摄入的文档。）

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

### 性能 / 并发

| 变量 | 默认 | 说明 |
|---|---|---|
| `INGEST_CONCURRENCY` | `4` | 单文件夹内并行处理的文件数；同时是 LLM 事件抽取的并发上限（`min(该值, 4)`） |
| `EMBEDDING_BATCH_CONCURRENCY` | `5` | 单文件内向量化的并行子批数 |
| `EMBEDDING_WORKER_REQUEST_BATCH` | `16` | 一次发给向量 worker 的文本条数上限。大文件切片会按此拆批，避免单请求跑几十分钟后超时；调小可以让小文件更快插队 |
| `EMBEDDING_WORKER_TIMEOUT_MS` | `1800000` | 单个向量 worker 请求的超时（30 分钟安全网） |
| `SAG_WATCHER_RESCAN_INTERVAL_S` | `300` | 监听器的周期性全量重扫间隔（秒）。挂整盘时用来发现「被裁剪目录里新建的带 Office 文件的目录」；设成 `0` 可关闭 |
| `SAG_WATCHER_EXCLUDE_DIRS` | 空 | 追加要排除的目录名（逗号分隔，按目录名匹配），额外加到内置排除清单后面 |

> 2026-10-28 起，**LLM 事件抽取与向量化是并行执行的**（抽取只需要切片文本，不需要向量）。
> 大文件入库时 LLM 接口在几秒内就能看到流量，而不是等向量化全部跑完；
> 总耗时从「向量化 + 抽取」变成「两者取大」。

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

**窗口空白、一直转圈** —— 首次启动要在后台解压约 600 MB 原生依赖。
界面本身 **几秒内就能打开**（服务器先起来，解包在后台跑）；本地嵌入模型
在解包完一小批关键依赖后才可用，实测 **30 秒内**就绪；全部依赖解完约 **1–3 分钟**
（期间界面照常可用，只是本地 embedding 的检索/同步会等它）。

判断进度：看 `resources\native-cache\<12位哈希>\` 目录下的两个标记文件 ——

| 标记文件 | 含义 |
|---|---|
| `.sag-unpack-embedding-ready` | 嵌入相关的依赖已就绪（检索/同步可以跑了） |
| `.sag-unpack-complete` | 全部依赖解包完成 |

超过 120 秒报 `backend failed to become ready within 120000ms`才是真问题。

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
| `[sag-mcp] migration warning: No such built-in module: better-sqlite3` | 无害。启动器里那次预迁移没跑成，但真正的迁移由 MCP 服务本体完成 —— 表结构齐全，工具照常可用 |
| `embedding worker terminated: Cannot find module ...` | **不可忽略**（2026-10-27 之前的文档说无害是错的）。说明嵌入 worker 没能加载依赖，本地嵌入会停摆。先完全退出再启动一次；仍复现就看 `resources\native-cache\<哈希>\` 下有没有 `.sag-unpack-complete`，没有就把解压目录加杀软白名单后重启 |

### 9.7 想看实时日志

```powershell
cd D:\sag
.\resources\SAG-backend.exe 2>&1 | Tee-Object -FilePath sag.log
```

桌面版自身的日志在 `resources\logs\desktop-*.log`。

### 9.8 日志里出现 `watcher: preflight failed, refusing to start`

watcher 启动前会先探测 embedding 能不能用。**没配 embedding 就直接拒绝启动**
（这是刻意的：避免扫完几千个文件才发现一个都嵌入不了）。

```
{"probe":{"ok":false,"provider":"api","baseUrl":"(empty)","error":"embedding base URL is not configured"}}
```

解决：Web UI →「AI Provider」，二选一：

- **本地离线**：Embedding provider 选 `local-bge`，Local model path 填
  `models/bge-large-zh-v1.5`（包里已自带）
- **云端 API**：填 Base URL / API key / Model，维度选 `1024`

配好后到「数据源」页点 **重新触发同步**。

> ⚠️ 出现这个错误时，文件夹记录**已经建在数据库里了**，只是 watcher 没起来。
> 所以不用重新添加文件夹，配好 embedding 后直接重触发同步即可。

### 9.9 重启后能登录但「同步情况」一直转圈（2026-10-27 已修复）

旧版本在重启后有个竞态：后台解包没跑完，挂载点遗留的待同步文件就立刻开始嵌入，
把主线程卡死，界面所有页面都加载不出来。当前版本已修：

- 原生依赖解包改成**纯后台异步**，HTTP 服务秒级就绪；
- 嵌入会**等解包的关键依赖就绪**才开始（最多等 15 分钟，超时也会放行）；
- 嵌入 worker 文件固定从按内容哈希的目录加载，不再误用包内自带的那份
  （那份旁边没有 node_modules，一加载就崩）。

如果你仍在旧版本上遇到这个现象：完全退出 SAG（包括托盘），重新启动，
等 1–3 分钟让后台解包跑完即可。升级到新包可根治。

### 9.10 入库时 LLM 一直没流量 / 「测试连接」要点几十秒（2026-10-28 已修复）

旧版本在大文件入库时有两个叠加的问题：

1. 全部切片一次性发给向量 worker（一个 2,295 切片的表格就是一条请求）。
   worker 在 CPU 上每片约 2.5 秒，整条请求要 ~97 分钟，远超客户端 10 分钟超时；
   超时后调用方**回退到主线程内嵌 ONNX**，把 HTTP 层整个卡死
   （健康检查 1.2–7 秒，「测试连接」探测 12 秒以上）。
2. LLM 事件抽取排在向量化**之后**串行执行，于是大文件入库期间
   LLM 接口一个多小时没有任何流量，看起来"像死了"。

当前版本已修：

- 发给 worker 的请求按 `EMBEDDING_WORKER_REQUEST_BATCH`（默认 64）拆批，
  每批几分钟内返回，不再触发主线程回退；
- LLM 事件抽取与向量化**并行**执行（它只需要切片文本），
  入库开始几秒内 LLM 接口即有流量；
- `INGEST_CONCURRENCY` 默认从 1 提到 4。

升级新包即可根治，无需改配置。

### 9.11 进程在跑但窗口死活不出来（2026-10-28 已修复）

典型现场：任务管理器里能看到好几个 `SAG-桌面版.exe`，但双击多少次都没窗口。
旧版本有三个叠加的问题：

1. 启动时只探测一次 4173 端口（2 秒超时）。如果此时有一个旧后端正在大批量
   入库、机器满载，探测会超时，外壳误判「端口空闲」→ **再启动一个后端**，
   新后端顺延到 4174，两份 ONNX 入库任务把 CPU 打满。
2. 外壳加载窗口只有**一次机会**。机器满载的冷启动窗口期里 Chromium 首次
   导航可能失败（ERR_FAILED），一旦失败窗口永远不出来。
3. 失败后进程**不退出**，占着单实例锁——之后每次双击都只是「唤醒」这个
   没有窗口的僵尸，表现就是"怎么点都没反应"。

当前版本已修：

- 端口探测改为 3 次重试，并区分「真空着（ECONNREFUSED）→ 直接启动」与
  「有进程霸占但不响应 → 提示你结束残留进程，绝不重复启动后端」；
- 窗口加载失败自动重试 5 次（每次间隔 10 秒），挺过冷启动拥挤期；
- 彻底失败时弹窗说明并**退出程序**，不再留僵尸占用单实例锁。

如果你正在旧版本上：任务管理器结束所有 `SAG-桌面版.exe` 和
`SAG-backend.exe`，重新双击即可；升级新包可根治。

### 9.12 启动后一直「扫描文件系统」，界面跟着卡（2026-10-28 已修复）

挂整盘（如 `E:\`）时，旧版本每次启动的扫描有个隐藏开销：manifest 表
**没有持久化文件的 mtime**，所以判断"文件变没变"只能把盘上每个 Office
文件**完整读一遍算 SHA-1**——几千个文件、几十 GB 的读取，扫描 30-40
分钟起步，期间健康检查都超时不应，界面看起来就是永远停在
「扫描文件系统」。

当前版本已修：

- manifest 新增 `mtime_ms` 列（迁移 021）：size+mtime 都没变的文件直接
  跳过重读，扫描从「全量读哈希」降为「遍历 + stat」，整盘扫描降到分钟级；
- 老数据第一次升级扫描会**最后一次**全量读哈希，同时把 mtime 回填进
  manifest，之后每次扫描都走快路径；
- 扫描遍历每 2000 个文件打一条进度日志（`watcher: scan walking…`），
  「卡住」和「在跑」一眼可辨；
- 顺带加了 **LLM 熔断器**：远程 LLM 连续失败 3 次后熔断 5 分钟，期间
  切片直接走正则兜底，不再每个切片白等 180 秒超时（LLM 接口抖动时
  一个 2,295 切片的大文件能把入库拖上几十个小时）。

> 💡 长期建议：挂**具体子目录**而不是整盘根目录（§4.1），扫描和内存
> 开销都小一个量级；整盘挂载留给确实需要的场景。

### 9.13 入库很慢（一小时才几个文件）（2026-10-29 已修复）

现象：文件夹开着，界面一直"同步中"，但入库速度只有每小时几个文件。

2026-10-29 在 E:\ 实测到的三个叠加原因：

1. **事件/实体/关系向量是一条一条算的**。每个事件 2 条文本、每个实体 1 条、
   每条关系 1 条，各自发一次独立请求。一份 9 事件 + 6 实体 + 6 关系的文档
   要发 21 次请求，而向量 worker 是串行的（一次只处理一个任务），
   每次都得排在别人的大批次后面 → 实测一份 3 切片的文档光 eventPrep 就
   花了 17 分钟。现在改成**每组一次批量请求、三组并发发出**，
   21 次请求变成 1~3 次。
2. **一个大文件霸占向量 worker**。worker 按 FIFO 串行处理，一个 64 条文本的
   请求要跑 ~2 分钟，这期间所有别的文件的请求全部排队等着（队头阻塞）。
   现在默认批量降到 **16 条**（`EMBEDDING_WORKER_REQUEST_BATCH`），
   大文件总耗时不变，但小文件最多等 ~20 秒就能插进来。
3. **批量写库没在工作**。打包版里 db-write-worker 的入口找不到
   （只会去找开发模式的 `.ts` 源文件），于是每份文档的批量写入都退回主线程，
   日志里每份文档一条 "db-write-worker entry not found"。现在该 worker 会被
   正确打包并随包释放。

修完之后实测：多个文件同时推进（不再是单文件霸占），单个文档的
eventPrep 从 17 分钟降到分钟级。

> 💡 另外要知道上限：本地 BGE-large 在 CPU 上每个长文本约 1.9 秒
> （平均 724 汉字 ≈ 510 token，正好顶到模型上限）。整盘 6,700+ 个 Office
> 文件的完整入库本来就是几十小时的量级，不是故障。

> ⚠️ 打包版里的 **db-write worker 现在跑在 worker_thread 里**，不是子进程。
> 原因：SEA 宿主没有独立的 node.exe，`process.execPath` 就是
> `SAG-backend.exe`，用子进程方式启动会**再起一个完整后端**而不是
> worker，于是每批写入都等满 60 秒超时（表现为上传接口 500：
> `db-write-worker: op=batch timed out after 60000ms`）。
> 2026-10-29 已改为 worker_thread（与向量 worker 一致）。

### 9.14 挂整盘后监听永远起不来 / 后端内存爆掉（2026-10-30 已修复）

现象：挂 `E:\` 后界面一直停在「扫描文件系统」，几十分钟没动静；
过一会儿后端直接消失（任务管理器里进程没了）。

2026-10-30 在 v4 上定位到的根因：**chokidar 监听了整棵目录树**。

chokidar 在 Windows 上会给它遍历到的**每一个目录**开一个
`ReadDirectoryChangesW` 句柄。旧版本的 `ignored` 回调只按**目录名**
排除噪音目录（`node_modules`、`$RECYCLE.BIN` 等），并不限制普通文件，
于是 E:\ 上的情况是：

| 项目 | 数量 |
|---|---|
| 目录总数 | 41,353 |
| 其中**含有可入库文件**的目录 | **1,443**（3.5%） |
| 非 Office 文件 | ~305,000 |

也就是说，96.5% 的目录句柄是白开的。实测（E:\ 真机）：

- chokidar 600 秒里调了 178,030 次 `ignored`，**一个 `add` 事件都没发**，
  **`ready` 永远不来**；
- 后端句柄以 **79 个/秒** 泄漏，40 分钟后 117,043 个；
- 内存从 1.6 GB 涨到 5.5 GB，最后
  `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`；
- 启动扫描因为和 chokidar 抢目录句柄，**一次都没跑完**。

当前版本已修，四处：

1. **扩展名闸门** —— `ignored` 回调现在也会按白名单扩展名过滤文件，
   只有那 ~6,900 个 Office 文件会被跟踪；
2. **目录裁剪** —— 启动前先跑一遍快速遍历（和扫描同一套逻辑，E:\ 约 11-26 秒），
   算出「哪些目录真的含有可入库文件」，chokidar 只监听这 1,443 个目录
   加上它们的祖先，共 **1,685 个**，句柄降到原来的 1/25；
3. **ready 超时** —— 以前 `awaiting chokidar ready` 是无限等待，
   会把「启动监听」这个 HTTP 请求挂死、连 `/health` 都不应答；
   现在最多等 120 秒，超时就先往下走，chokidar 继续在后台跑；
4. **周期性重扫**（`SAG_WATCHER_RESCAN_INTERVAL_S`，默认 300 秒）——
   被裁掉的目录里如果后来新建了带 Office 文件的目录，chokidar 不会发事件，
   所以定时重扫会重走一遍树、把新目录补进监听集合并交给 chokidar，
   同时把 manifest 里没有的文件补进队列。

另外还加了**按文件夹的扫描锁**：启动同步、手动同步、定时重扫、
chokidar 事件触发的差异扫描，之前会同时开好几个全盘扫描
（实测同时 4 个，每个 122-392 秒，磁盘 I/O 翻四倍）；现在后到的直接
复用前一个扫描的结果（日志里会看到 `watcher: scan already in progress,
reusing its result`）。

修复后在 E:\ 实测：

| 指标 | 修复前 | 修复后 |
|---|---|---|
| chokidar `ready` | 从不触发（600 秒超时） | **22 秒** |
| 监听到的文件事件 | 0 | 6,831 |
| 进程句柄 | 117,043 → 内存爆掉 | **9,272，稳定** |
| 内存 | 1.6 → 5.5 GB → 进程死亡 | **1.0 GB，稳定** |

> 💡 长期建议还是一样：**挂具体子目录**而不是整盘根目录（§4.1）。
> 整盘挂载现在能跑起来了，但第一次扫描仍要把整棵树走一遍
> （E:\ 约 11-26 秒），而且首次入库要处理 6,900+ 个文件。

### 9.15 刚更新完版本，第一次启动卡住、界面转圈（2026-10-30）

现象：换了新版本第一次启动，界面一直转圈，接口全部超时；日志里
最后一行停在 native-cache 解包中途（如
`native-cache: 287 copied, 0 skipped (at buffer)`）。

原因：**每次版本更新都会换 native-cache 的指纹目录**
（`resources/native-cache/<12位哈希>/`），新目录必须从零把 294 个包
（约 5,000-6,800 个文件、400 MB）复制一遍。这个复制在后台进行，
**和启动时立刻恢复的入库队列抢磁盘和文件句柄**，偶尔会把两边一起卡死
（实测：进程还在、CPU 为 0、接口不响应）。

**处理办法：直接关掉再打开一次。** 复制是从断点继续的，第二次启动通常
80 秒内就解包完成（会看到 `native-cache background unpack done`），
之后每次启动都是秒开。

> 💡 避免办法：更新后**先别急着开监听**，等日志里出现
> `native-cache background unpack done` 再开；或者更新前先把旧版本
> 的 `resources/native-cache/<旧指纹>/` 目录留着不动，等新版本第一次
> 启动成功后再删。

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
