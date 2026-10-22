# SAG 分发包使用说明

> 受众：在自己电脑上拿到分发包的同事 / 测试人员。
> 这份文档覆盖：(1) 包内文件清单 (2) 启动方式 (3) MCP 配置 (4) 常见问题。

> 📌 **端到端的操作手册见 [OPERATIONS.md](OPERATIONS.md)** —— 解压、启动、挂文件夹、
> 接 MCP、数据备份都在那里，且与当前桌面版布局一致。
> 本文件侧重**包内有什么、怎么交付**。

## 1. 包内文件清单

### 1.1 桌面便携版（当前版本）

`SAG-桌面版-portable.zip` 解压后是这些文件（同一个目录、必须放一起、不要拆）：

```text
SAG-桌面版-portable\
├─ SAG-桌面版.exe              ← 桌面外壳（Electron），双击启动
├─ resources\
│  ├─ SAG-backend.exe          ← 后端服务（HTTP API + Web UI，端口 4173）
│  ├─ SAG-mcp.exe              ← stdio MCP 入口，给 Trae / Claude / Cursor
│  ├─ SAG-ingest-worker.exe    ← 文档摄入 worker
│  ├─ native-cache\            ← 首次启动时在此解压原生依赖
│  ├─ sag-readers\             ← 文档读取脚本
│  ├─ models\                  ← local-bge 模型（如有）
│  ├─ migrations\              ← 数据库迁移 SQL
│  ├─ data\                    ← 数据库（首次启动后生成）
│  ├─ logs\                    ← 运行日志
│  └─ .env.example             ← 环境变量样例
├─ locales\                    ← Electron 语言包
└─ *.dll / *.pak / *.bin        ← Electron 运行时，别删
```

| 文件 | 大小 | 说明 |
|------|------|------|
| `SAG-桌面版.exe` | ~180 MB | 桌面外壳。双击启动后端并开内嵌窗口 |
| `resources\SAG-backend.exe` | ~87 MB | Fastify 后端，端口 4173 |
| `resources\SAG-mcp.exe` | ~87 MB | stdio MCP 入口 |
| `resources\SAG-ingest-worker.exe` | ~87 MB | 摄入 worker 子进程 |
| `resources\native-cache\` | ~300 MB | 原生依赖，首次启动时解压 |
| `resources\.env.example` | < 1 KB | 环境变量样例，**复制一份改名为 `.env`** 即可 |

> **解压完先做这两件事**：
> 1. `Copy-Item resources\.env.example resources\.env`，然后填 LLM/Embedding 配置
> 2. 把整包放到一个**不带空格、不带中文**的路径下（如 `D:\sag\`）。**不要放在桌面**——OneDrive/同步盘会锁文件。

> **exe 名注意**：桌面外壳必须叫 `SAG-桌面版.exe`（含中文）。Electron 33 对纯 ASCII 的
> exe 名会回退到 `default_app.asar`，导致启动失败。**不要改名。**

### 1.2 旧版 CLI 分发包（历史，已不推荐）

早期版本是一个扁平的 zip，没有 Electron 外壳：

| 文件 | 大小 | 说明 |
|------|------|------|
| `SAG.exe` | ~87 MB | 主程序，提供 HTTP API + Web UI（端口 4173） |
| `SAG-mcp.exe` | ~87 MB | stdio MCP 入口，给 Trae / Claude / Cursor 用 |
| `SAG-backend.native-map.json` | ~130 MB | SAG-backend.exe 启动时读，离它最近的那个必须存在 |
| `SAG-backend.migrations.json` | ~40 KB | SAG-backend.exe 启动时读，schema 迁移文件 |
| `SAG-mcp.native-map.json` | ~130 MB | SAG-mcp.exe 启动时读 |
| `SAG-mcp.migrations.json` | ~40 KB | SAG-mcp.exe 启动时读 |
| `.env.example` | < 1 KB | 环境变量样例，**复制一份改名为 `.env`** 即可 |
| `mcp-config.json` | < 1 KB | Trae HTTP 模式配置片段 |
| `mcp-config-stdio.json` | < 1 KB | Trae stdio 模式配置片段（推荐） |
| `README.md` | < 1 KB | 简短提示 |

> ⚠️ 本节描述的是**旧布局**。当前发布的是 1.1 的桌面便携版。
> 下文 2.x / 3.x 的命令把 `SAG.exe` 换成 `resources\SAG-backend.exe`、
> `SAG-mcp.exe` 换成 `resources\SAG-mcp.exe` 即可，`.env` 也要放到 `resources\` 下
> （后端进程的 cwd 是 `resources\`）。
>
> **exe 名变更提醒**：更早的版本里 MCP 叫 `本地知识检索-mcp.exe`，
> 现在是 `SAG-mcp.exe`，用户旧配置里的路径需要手动改。

## 2. 启动方式（三选一）

### 2.1 stdio 模式（推荐给 Trae 用户）

Trae 启动时会**自动**spawn `SAG-mcp.exe`，你不用手动跑。第一次用 MCP 工具时才需要启动。

**优势**：
- 最简单，**用户啥都不用做**
- 不占端口（走 stdin/stdout）
- 一个 Trae 一个进程，多个 Trae 互不影响

**何时手动启动**：测试 MCP 是否正常时，双击 `SAG-mcp.exe`，看到命令行窗口**不输出内容、不关闭**就是正常的（它在等 stdin 数据；一旦有 client 连上来就开始处理）。

### 2.1.1 关于 watcher（监听文件夹）

`SAG.exe` 默认**不会**在启动时自动扫描 watched folder。启动后用户可以从 Web UI（数据源 → 添加 → 触发同步）按需启动 watcher。

启动后的 watcher **自动监听**文件系统变化：新建 / 修改 / 删除任何 watched folder 里的文件，chokidar 都会触发事件 → ingest-queue 入队 → 调用 embedding API → 更新 `chunks` / `events` / `entities` 表 → sqlite-vec 向量库同步。整个链路是 fire-and-forget，主线程不被阻塞，HTTP / Web UI 仍然秒级响应。

如果想恢复"启动即全量扫描"行为，在 `resources\.env` 设 `WATCHER_AUTOSTART=true`。

### 2.2 HTTP 模式（要同时跑 Web UI）

**两种场景**：
- 用浏览器打开 `http://localhost:4173` 看 Web UI
- 让同事从另一台电脑访问

**启动**（桌面便携版）：
```powershell
cd <解压目录>
.\resources\SAG-backend.exe
```
或者：
```powershell
.\resources\SAG-backend.exe
```
看到 `server: listening on http://0.0.0.0:4173` 就起来了。

> 端口被占用时会自动顺延到 4174 … 4183，注意看实际绑定的端口。

第一次会有 Windows SmartScreen 警告（**unsigned binary**）：点 **More info → Run anyway**。

**Web UI**：浏览器打开 `http://localhost:4173`，默认账号（`.env` 里 `AUTH_MODE=none`）可以直接进。

> 💡 大多数用户不需要手动跑这个 —— 直接双击 `SAG-桌面版.exe` 即可，
> 外壳会自动拉起后端并开内嵌窗口。手动跑后端适合"只用浏览器访问"或
> "让同事从另一台电脑访问"的场景。

### 2.3 HTTP 模式 + 远程 MCP（给远程客户端）

如果想让同事的 Trae 连你这台电脑上的 SAG：

1. `.env` 里改：
   ```
   MCP_TRANSPORT=http
   MCP_HTTP_PORT=4174
   MCP_AUTH_MODE=bearer
   MCP_AUTH_TOKEN=一串随机token
   ```
2. 启动 SAG.exe
3. 防火墙放行 4174 端口
4. 同事那边 Trae MCP 配置：
   ```json
   {
     "mcpServers": {
       "sag": {
         "url": "http://你的IP:4174/mcp",
         "headers": {
           "Authorization": "Bearer 上面那个token"
         }
       }
     }
   }
   ```

## 3. Trae MCP 配置（最常见）

打开 Trae → **Settings → 搜索 "MCP" → 找到 "Edit in settings.json"** 或 **"Configure MCP Servers"**，把下面这份贴进去：

### stdio（推荐）

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

**关键点**：
- `command` 路径里的 `\\` 是 JSON 转义后的双反斜杠，**必须**这么写
- **路径要指到 `resources\` 里面** —— MCP exe 和数据库都在那儿
- `DATABASE_FILE` 指向的目录不需要预先建，第一次启动时会自动 `mkdir -p`
- 不写 `DATABASE_FILE` 时 MCP 会自动推断成 `<exe目录>\data\sag.db`，标准布局下正好对上；
  但**显式写绝对路径更保险**（连接池初始化早于这个推断）
- 如果 `SAG-mcp.exe` 启动报"找不到 SAG-mcp.native-map.json"，说明 `.env` 没生效或 cwd 不对——把 `DATABASE_FILE` 写绝对路径即可
- 改完 **完全退出 Trae 再重开**才能生效（reload 工作区不够）

### HTTP 远程

```json
{
  "mcpServers": {
    "sag": {
      "url": "http://your-server:4174/mcp",
      "headers": {
        "Authorization": "Bearer your-token-here"
      }
    }
  }
}
```

### 验证 MCP 连上了

Trae 重启后，看 MCP 面板：
- ✅ `sag` 显示 **connected**（绿点）
- ✅ 列出 15 个工具：`sag_search` / `sag_ingest_document` / `sag_list_projects` 等

如果显示 **disconnected** 或列表里没 sag：
1. 看 Trae 日志（Output → "Trae MCP" 或 "MCP Servers"）
2. 通常是 `command` 路径错或反斜杠不对
3. 也可能是被 DLP / 杀软拦了 SAG-mcp.exe，把解压目录加白名单

## 4. SAG 使用方法（给最终用户）

### 4.1 三种使用方式

**A. 通过 Trae 对话（最常用）**

直接在 Trae 对话框打字问，不用记任何命令：

> 找出审计报告里所有提到"动环系统"的内容

LLM 看到 `sag_search` 工具，会自动调用并整理结果。

**B. Web UI**

`http://localhost:4173` 上的搜索框、文件管理、项目配置都在那。HTML 单页应用，左侧导航。

**C. 直接调 HTTP API**

```powershell
$body = @{ query = "质量事件"; topK = 5 } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://localhost:4173/search" -Body $body -ContentType "application/json"
```

### 4.2 query 怎么写

`query` 是自然语言短语（不是 SQL）。SAG 内部做这些事：
1. 把 query 转成 embedding 向量（调远程 embedding API）
2. 在 sqlite-vec 里找最相近的 chunks
3. 关键词命中加权
4. 实体扩展（如果 query 命中实体名，把对应事件拉进来）
5. 可选 LLM rerank

**好例子**：
- `"质量事件"` ✅ 简短关键词
- `"联想电脑质量事件的发现过程"` ✅ 自然语言短句
- `"动环系统相关的设备"` ✅ 复合语义

**避免**：
- `"联想 AND 质量"` ❌ 当成普通字符串
- 整段文档 ❌ 太长会被截断

### 4.3 检索参数

| 参数 | 默认 | 含义 |
|------|------|------|
| `query` | 必填 | 自然语言 |
| `topK` | 10 | 召回几条 |
| `searchMode` | `"fast"` | `fast` = 快（向量+关键词）；`standard` = 慢但准（再加 LLM rerank）|
| `sourceIds` | 全部 | 限定项目 UUID；scoped 模式下被强制单值 |

简单场景用 `fast` + `topK=5` 就够。

### 4.4 一次性绑定某个项目（scoped 模式）

如果只想让某台机器只能看一个项目（比如审计组的电脑只能看"5-审计报告"），在 env 里加：

```json
"SAG_MCP_SOURCE_ID": "3e2c108f-0ace-4251-aa07-6af291268015"
```

效果：
- `sag_list_projects` 只返回这一个
- `sag_search` / `sag_ingest_document` 强制只能对它操作
- `sag_create_project` / `sag_archive_project` / `sag_delete_project` 全部被拒绝

错误示范：UUID 写错（指向不存在的项目）→ 启动时直接报 `SAG_MCP_SOURCE_ID=xxx does not match any project`，不会静默跑空。

## 5. 常见问题

### Q1: 第一次启动弹 SmartScreen？
点 **More info → Run anyway**。这是因为 exe 没签名，不影响功能。

### Q2: 启动闪退 / 报错 `v8::ToLocalChecked Empty MaybeLocal`？
这是 DLP / 亿赛通管控环境下 Node SEA 的已知问题。**当前版本已修复**（入口模板里 polyfill 了 pdfjs 需要的 DOMMatrix/Path2D），如果你拿到的是 2026-07-29 之后打的包，应该不会遇到。

> 💡 桌面版双击后**立刻消失、什么也不显示**，绝大多数情况是**单实例锁**：
> 本机已经有另一个 SAG 桌面版在跑（包括另一个目录下的）时，新实例会直接退出。
> 不是崩溃。排查见 [OPERATIONS.md](OPERATIONS.md) 第 9.2 节。

### Q3: Trae 看不到 sag MCP？
1. 完全退出 Trae 重开（reload 工作区不会重扫 MCP 配置）
2. 检查 settings.json 里 command 路径，**反斜杠必须 `\\`**
3. 看 Trae 输出面板选 "MCP" / "Trae MCP" 找错误信息
4. 把解压目录加 DLP 白名单

### Q4: `sag_search` 报 "Request timed out"？
检索走的是远程 embedding API（默认 `https://api.302ai.cn/v1`），如果该 API 不通或网络受限会超时。`.env` 里换 key 或换 BASE_URL：
```
EMBEDDING_BASE_URL=https://api.openai.com/v1
EMBEDDING_API_KEY=sk-...
```

或者改用本地 ONNX 模型：
```
EMBEDDING_PROVIDER=local-bge
EMBEDDING_LOCAL_MODEL_PATH=models/bge-large-zh-v1.5
```
需要先下载 BGE 模型到那个路径。

### Q5: `SAG-mcp.exe` 启动后命令行窗口什么都不显示？
正常。stdio MCP server **不会**写任何东西到 stdout（那会污染 JSON-RPC 协议）。要看日志，stderr 是 logger 输出但需要别的进程连上去才有响应。

### Q6: 数据库文件放哪？
默认在 exe 同目录的 `data/sag.db`。桌面便携版里就是 `resources\data\sag.db` ——
`SAG-backend.exe` 和 `SAG-mcp.exe` 共享同一份数据库（通过 `DATABASE_FILE` env 或默认 fallback）。

### Q7: 怎么重置数据库？
直接删除 `data/sag.db`（和 `-shm` / `-wal`），下次启动会自动跑迁移重建。**会丢失所有已摄入的文档和事件**。

### Q8: 桌面版占多少端口？
- 4173 — HTTP API / Web UI（HTTP_PORT）
- 4174 — MCP HTTP 模式（MCP_HTTP_PORT，仅 `MCP_TRANSPORT=http` 时启用）

可改 `.env` 调整。

### Q9: 端口被占用？
```powershell
netstat -ano | findstr :4173
# 找到 PID 后
taskkill /F /PID <pid>
```

### Q10: 想看实时日志？
手动跑后端时，它在 stdout 打 pino JSON 日志，重定向到文件即可：
```powershell
.\resources\SAG-backend.exe 2>&1 | Tee-Object -FilePath sag.log
```

桌面版自身的日志在 `resources\logs\desktop-<时间戳>.log`，
后端日志在 `resources\logs\sag-<时间戳>.log`。

## 6. 已知限制

- **未签名 binary**：第一次启动有 SmartScreen 警告
- **桌面版是单实例的**：本机同时只能跑一个 SAG 桌面版（不区分安装目录）。
  重复启动只会聚焦已有窗口，不会开新窗口
- **exe 名必须含中文 `桌面版`**：Electron 33 对纯 ASCII 名会回退到 `default_app.asar`，导致启动失败
- **本地 ONNX 模型需自备**：`EMBEDDING_PROVIDER=local-bge` 要先下 BGE 模型
- **Embedding 维度锁死 1024 / 4096**：换模型必须维度一致
- **PDF 渲染依赖 polyfill**：入口有 ~25 行 DOMMatrix stub；不影响 PDF 文本提取
- **sqlite-vec Windows x64 only**：macOS / Linux 用户需要从源码编译 native 包

## 7. 给管理员的：换 SQLite → Postgres（可选）

`.env` 里 `DATABASE_URL` 默认是 postgres 占位。如果要换成真 Postgres 服务，需要：

1. 装 `pgvector` 扩展
2. 改 `src/config/env.ts` schema 让 `DATABASE_URL` 可被实际连接（当前是 `z.string().min(1)`，已经够）
3. 跑迁移：`npm run db:migrate`

Postgres 模式只在源码模式生效；exe 版硬编码 SQLite（`db/sqlite-driver.ts`），不能切换。

---

**出问题先看的东西**：
1. Trae 输出面板的 "MCP" 日志（stdio 模式）
2. `resources\logs\desktop-*.log` 和 `resources\logs\sag-*.log`
3. `resources\data\sag.db` 是否被 SQLite 锁（一个进程写、多个进程读不会出问题）
4. `resources\.env` 的 LLM/Embedding API key 是否填了