# 黑洞 (SAG) 分发包使用说明

> 受众：在自己电脑上拿到 `sag-package.zip` 的同事 / 测试人员。
> 这份文档覆盖：(1) 解压与首次运行 (2) MCP 配置 (3) 使用方法 (4) 常见问题。

## 1. 包内文件清单

`SAG 安装包.zip` 解压后是这些文件（同一个目录、必须放一起、不要拆）：

| 文件 | 大小 | 说明 |
|------|------|------|
| `黑洞.exe` | ~87 MB | 主程序，提供 HTTP API + Web UI（端口 4173） |
| `黑洞-mcp.exe` | ~87 MB | stdio MCP 入口，给 Trae / Claude / Cursor 用 |
| `黑洞.native-map.json` | ~130 MB | 黑洞.exe 启动时读，离它最近的那个必须存在 |
| `黑洞.migrations.json` | ~40 KB | 黑洞.exe 启动时读，schema 迁移文件 |
| `黑洞-mcp.native-map.json` | ~130 MB | 黑洞-mcp.exe 启动时读 |
| `黑洞-mcp.migrations.json` | ~40 KB | 黑洞-mcp.exe 启动时读 |
| `.env.example` | < 1 KB | 环境变量样例，**复制一份改名为 `.env`** 即可 |
| `mcp-config.json` | < 1 KB | Trae HTTP 模式配置片段 |
| `mcp-config-stdio.json` | < 1 KB | Trae stdio 模式配置片段（推荐） |
| `README.md` | < 1 KB | 简短提示 |

> **解压完先做这两件事**：
> 1. `Copy-Item .env.example .env`，然后用编辑器打开 `.env` 填 LLM/Embedding API key
> 2. 把整包放到一个**不带空格、不带中文**的路径下（如 `D:\sag\`）。**不要放在桌面**——OneDrive/同步盘会锁文件。

> **exe 名注意**：两个可执行文件名是中文（`黑洞.exe` / `黑洞-mcp.exe`），左上的图标也是黑洞；运行时窗口标题因为 Node.js 进程 hardcode，仍然会显示 "Node.js"，这是已知限制。

## 2. 启动方式（三选一）

### 2.1 stdio 模式（推荐给 Trae 用户）

Trae 启动时会**自动**spawn `黑洞-mcp.exe`，你不用手动跑。第一次用 MCP 工具时才需要启动。

**优势**：
- 最简单，**用户啥都不用做**
- 不占端口（走 stdin/stdout）
- 一个 Trae 一个进程，多个 Trae 互不影响

**何时手动启动**：测试 MCP 是否正常时，双击 `黑洞-mcp.exe`，看到命令行窗口**不输出内容、不关闭**就是正常的（它在等 stdin 数据；一旦有 client 连上来就开始处理）。

### 2.1.1 关于 watcher（监听文件夹）

`黑洞.exe` 默认**不会**在启动时自动扫描 watched folder。启动后用户可以从 Web UI（数据源 → 添加 → 触发同步）按需启动 watcher。

启动后的 watcher **自动监听**文件系统变化：新建 / 修改 / 删除任何 watched folder 里的文件，chokidar 都会触发事件 → ingest-queue 入队 → 调用 embedding API → 更新 `chunks` / `events` / `entities` 表 → sqlite-vec 向量库同步。整个链路是 fire-and-forget，主线程不被阻塞，HTTP / Web UI 仍然秒级响应。

如果想恢复"启动即全量扫描"行为，在 `.env` 设 `WATCHER_AUTOSTART=true`。

### 2.2 HTTP 模式（要同时跑 Web UI）

**两种场景**：
- 用浏览器打开 `http://localhost:4173` 看 Web UI
- 让同事从另一台电脑访问

**启动**：
```powershell
cd <解压目录>
.\黑洞.exe
```
或者：
```powershell
.\黑洞.exe
```
看到 `server: listening on http://0.0.0.0:4173` 就起来了。

第一次会有 Windows SmartScreen 警告（**unsigned binary**）：点 **More info → Run anyway**。

**Web UI**：浏览器打开 `http://localhost:4173`，默认账号（`.env` 里 `AUTH_MODE=none`）可以直接进。

### 2.3 HTTP 模式 + 远程 MCP（给远程客户端）

如果想让同事的 Trae 连你这台电脑上的 黑洞：

1. `.env` 里改：
   ```
   MCP_TRANSPORT=http
   MCP_HTTP_PORT=4174
   MCP_AUTH_MODE=bearer
   MCP_AUTH_TOKEN=一串随机token
   ```
2. 启动 黑洞.exe
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
      "command": "D:\\sag\\黑洞-mcp.exe",
      "args": [],
      "env": {
        "DATABASE_FILE": "D:\\sag\\data\\sag.db",
        "DEFAULT_TENANT_ID": "default",
        "LOG_LEVEL": "warn"
      }
    }
  }
}
```

**关键点**：
- `command` 路径里的 `\\` 是 JSON 转义后的双反斜杠，**必须**这么写
- `DATABASE_FILE` 指向的目录不需要预先建，第一次启动时会自动 `mkdir -p`
- 如果 `D:\sag\黑洞-mcp.exe` 启动报"找不到 黑洞-mcp.native-map.json"，说明 `.env` 没生效或 cwd 不对——把 `DATABASE_FILE` 写绝对路径即可
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
3. 也可能是被 DLP / 杀软拦了 黑洞-mcp.exe，把解压目录加白名单

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

### Q1: 第一次启动 黑洞.exe 弹 SmartScreen？
点 **More info → Run anyway**。这是因为 exe 没签名，不影响功能。

### Q2: 启动 黑洞.exe 闪退 / 报错 `v8::ToLocalChecked Empty MaybeLocal`？
这是 DLP / 亿赛通管控环境下 Node SEA 的已知问题。**当前版本已修复**（入口模板里 polyfill 了 pdfjs 需要的 DOMMatrix/Path2D），如果你拿到的是 2026-07-29 之后打的包，应该不会遇到。

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

### Q5: `黑洞-mcp.exe` 启动后命令行窗口什么都不显示？
正常。stdio MCP server **不会**写任何东西到 stdout（那会污染 JSON-RPC 协议）。要看日志，stderr 是 logger 输出但需要别的进程连上去才有响应。

### Q6: 数据库文件放哪？
默认在 exe 同目录的 `data/sag.db`。`黑洞.exe` 和 `黑洞-mcp.exe` 共享同一份数据库（通过 `DATABASE_FILE` env 或默认 fallback）。

### Q7: 怎么重置数据库？
直接删除 `data/sag.db`（和 `-shm` / `-wal`），下次启动 黑洞.exe 会自动跑迁移重建。**会丢失所有已摄入的文档和事件**。

### Q8: 黑洞.exe 占多少端口？
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
黑洞.exe 在 stdout 打 pino JSON 日志，重定向到文件即可：
```powershell
.\黑洞.exe 2>&1 | Tee-Object -FilePath sag.log
```

## 6. 已知限制

- **未签名 binary**：第一次启动有 SmartScreen 警告
- **运行时窗口标题**：Node.js 进程 hardcode console 标题为 "Node.js"，rcedit 改不进去。Explorer / 文件管理器里看到的是黑洞图标 + 黑洞.exe 文件名，进程窗口标题仍是 Node.js
- **本地 ONNX 模型需自备**：`EMBEDDING_PROVIDER=local-bge` 要先下 BGE 模型
- **PDF 渲染依赖 polyfill**：黑洞.exe 入口有 ~25 行 DOMMatrix stub；不影响 PDF 文本提取
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
2. `黑洞.exe` 的 stdout（HTTP 模式 / Web UI）
3. `data/sag.db` 是否被 SQLite 锁（一个进程写、多个进程读不会出问题）
4. `.env` 的 LLM/Embedding API key 是否填了