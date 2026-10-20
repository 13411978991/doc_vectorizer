<p align="center">
  <img src="docs/assets/logo.svg" alt="Logo" width="96" />
</p>

# 本地文件夹知识库

**Language**: 简体中文 | [English](README-EN.md)

> 把任意本地文件夹向量化，变成可以对话、检索、可视化的私人知识库。

把本地一个或多个文件夹交给它，自动完成切片、向量化、事项提取、实体提取和关系整理；之后你可以用自然语言提问、查看检索过程、浏览知识图谱，也能把整个知识库作为 MCP 服务暴露给外部 Agent。

> 本项目 fork 自 [Zleap-AI/SAG](https://github.com/Zleap-AI/SAG)，核心检索结构（chunk → event → entities 的多跳召回）来自上游；本仓库在此基础上做了本地化与离线化，详见[与上游的差异](#与上游的差异)。

![工作台预览](docs/assets/documents-overview.png)

---

## 它能做什么

把一个普通的文件夹变成可以聊天的知识库。具体场景：

- **个人资料库**：把笔记、剪藏、Markdown 文档丢进一个文件夹，就能搜索和提问
- **团队文档检索**：把项目文档目录挂上，多人共用一个检索服务
- **RAG / Agent 原型**：自带 MCP Server，外部 Agent 一行配置即可调用当前知识库
- **检索过程调试**：右栏能看到每一跳召回和打分，便于调优

---

## 核心特性

- **本地文件夹即数据源**：指定一个目录（支持白名单过滤文件类型），自动监听新增 / 修改 / 删除，增量同步
- **多数据源汇聚**：一个项目可挂多个本地文件夹作为"自动数据源"，新增 / 修改的文档按文件 / 目录归属关系自动汇入对应项目，跨目录的检索结果在同一个项目下统一呈现
- **知识结构化**：每个 chunk 提取一个完整事项 (event) + 多个实体 (entities)；事件保留语义，实体负责索引和关系扩展
- **多跳召回**：检索从事件出发，可以沿着实体关系继续跳，避免重型知识图谱的重建成本
- **多种检索策略**：BM25 / 向量 / multi-route（事件 + 实体多路召回 + LLM rerank）可切换
- **本地 Embedding**：开箱即用 `Xenova/bge-large-zh-v1.5`（int8 量化，~312 MB，1024 维），不依赖任何 API key
- **云端 Embedding**：也支持任意 OpenAI 兼容 Embedding API
- **MCP 集成**：每个项目有自己的 MCP 配置，外部 Agent 可直接调用 `sag_search` / `sag_ingest_document` 等工具
- **可视化**：右栏检索 trace + 知识图谱（事件 / 实体节点，可拖拽缩放）
- **本地优先**：SQLite + sqlite-vec，整套部署就是一个 `.db` 文件 + 几个脚本，备份即拷贝

---

## 工作台预览

### 项目文档 / 概览

新建项目并挂载本地文件夹后，进入项目即可看到文档 / 切片 / 事件 / 实体计数，以及每个文档的处理状态与 embedding 样本（前 8 维，便于确认向量真实写入）。

![Documents overview](docs/assets/documents-overview.png)

### 事件与实体

进入单个文档的"事件"页，可见结构化抽取结果：事件标题、关联实体 tag、标题 embedding、内容 embedding（默认 1024 维）的样本值。

![Event detail](docs/assets/event-detail.png)

### 对话式检索

"检索"页直接对当前项目提问，支持极速 / 标准两种模式。结果区显示命中段、命中分数与匹配类型，下方实时返回检索链路 trace（queryEntities / expandedEventIds / coarseRankedEvents 等），便于调试。

![Search results](docs/assets/search-results.png)

---

## 快速开始

### 1. 环境要求

- Node.js 20+
- npm

> 不再需要 PostgreSQL / pgvector — 本项目默认使用 SQLite + sqlite-vec。

### 2. 克隆与配置

```bash
git clone https://github.com/13411978991/doc_vectorizer.git
cd doc_vectorizer
cp .env.example .env
```

`.env.example` 内已带默认值；要使用本地 Embedding 无需改任何东西；要走云端模型则填 `EMBEDDING_API_KEY` / `LLM_API_KEY`。

### 3. 安装依赖

```bash
npm install
```

> vitest 在某些 Windows 环境缺 `@embedded-postgres/windows-x64`，如需跑测试需单独安装；只跑主程序可忽略。

### 4. 启动

```bash
# 开发模式（前端 dev server + 后端 watch）
npm run dev

# 生产模式
npm run build
npm start
```

默认端口：

- WebUI：<http://localhost:5173>
- HTTP API：<http://localhost:4173>

### 5. 第一次使用

1. 打开 WebUI
2. 左栏点 "New Project" 创建项目
3. 进入 Documents 面板，添加一个本地文件夹作为数据源（可指定白名单 / 黑名单 / 递归）
4. 系统自动监听、同步、向量化
5. 切换到 Chat 面板，向知识库提问
6. 右栏 trace 面板查看每一跳召回与延迟

### 6. 一键启动脚本（Windows / macOS / Linux）

仓库根目录提供：

- `start.bat`（Windows）
- `start.ps1`（Windows PowerShell）
- `start.sh`（macOS / Linux）

双击或运行后自动 build + 启动，控制台窗口不阻塞。

---

## 接入 Embedding 模型

三种方式，按推荐顺序：

### 方式 1：本地 BGE（推荐，零配置）

下载脚本会从 ModelScope 拉取 `Xenova/bge-large-zh-v1.5`（int8 量化、1024 维，~312 MB）到 `./models/bge-large-zh-v1.5`：

```bash
./scripts/download-bge-model.sh
```

启动后在 WebUI 设置 → AI Provider：

- Embedding provider 选 **`local-bge`**
- Local model path 填脚本打印的目录

首次切换会加载 ONNX pipeline（约几秒），之后每个文本只是 forward pass，约 30–150 ms / 文本。

> DB schema 锁定 1024 维，**只能选 `hidden_size = 1024` 的模型**。社区可选：`Xenova/bge-large-zh-v1.5`、`Xenova/bge-m3`。模型目录里必须有一个 `onnx/model_int8.onnx`（或 `model.onnx`）。
>
> HuggingFace 直连在某些网络环境不可达，请用 ModelScope 镜像。

### 方式 2：OpenAI 兼容云端 API

在 `.env` 填：

```env
EMBEDDING_BASE_URL=https://api.your-provider.com/v1
EMBEDDING_MODEL=text-embedding-3-large
EMBEDDING_DIMENSIONS=1024
EMBEDDING_API_KEY=your_key
```

WebUI 设置面板会显示「已配置 / 未配置」二值，不回显明文 key。

### 方式 3：完全无 key 的本地 fallback

不配置任何 key 时，系统用本地确定性 fallback。**仅供 UI 走通流程**，检索质量不可用——真实场景请用方式 1 或方式 2。

---

## MCP 集成

每项目独立的 MCP 配置，外部 Agent 一行接进来：

```json
{
  "mcpServers": {
    "doc_vectorizer": {
      "command": "npm",
      "args": ["run", "mcp"],
      "env": {
        "SAG_MCP_SOURCE_ID": "current_project_id"
      }
    }
  }
}
```

内置工具：

| 工具 | 作用 |
|---|---|
| `sag_ingest_document` | 导入文档：切片 + 事件抽取 + 实体抽取 + 向量化 |
| `sag_search` | 在当前项目上跑 multi-route 召回，返回结果 + 内部 trace |
| `sag_explain_search` | 返回当前项目的检索 pipeline 解释和 trace |
| `sag_get_event` | 按 event ID 查询事件详情 |

---

## 检索策略

两条 pipeline 可切：

- **Fast mode**：BM25 / 全文 + SAG 多跳召回 + `qwen3-rerank` 选 top-K。**不调用 LLM 抽取查询实体**，速度快
- **Standard mode**：LLM 抽查询实体 → SAG 多路召回 → LLM rerank。精度更高，可与 fast 对比

两条都比单纯向量搜索准，因为都用上了事件 / 实体索引和 SQL 多跳扩展。

请求示例：

```bash
curl -X POST http://localhost:4173/api/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"供应商评分","sourceIds":["<project_id>"],"strategy":"multi","searchMode":"fast","topK":5,"returnTrace":true}'
```

流式 trace：

```bash
curl -N -X POST http://localhost:4173/api/search/stream \
  -H 'Content-Type: application/json' \
  -d '{"query":"..."}],"sourceIds":["<project_id>"],"strategy":"multi","returnTrace":true}'
```

---

## 项目结构

```text
src/
  ai/                 Embedding / LLM / Rerank 客户端
  api/                HTTP API 路由
  config/             环境变量配置
  db/                 SQLite 连接、migrations、repositories、sqlite-vec
  mcp/                MCP Server
  observability/      日志、模型调用记录
  services/           文档处理、检索、图谱、WebUI 服务
  watcher/            文件夹监听 / 同步 / manifest
  audit/              （可选）过程档案能力，详见 docs/audit-task-redesign/

web/
  src/                React WebUI（Vite + Tailwind）

docs/
  assets/             README 截图与示意图
  audit-task-redesign/  （可选）过程档案方案文档
```

---

## 常用命令

```bash
npm run typecheck     # 类型检查
npm run lint          # 静态检查（仅阻塞 error；warning 可保留）
npm run build         # 产出 dist/
npm start             # 跑生产包
npm run dev           # 开发模式
npm run mcp           # 跑 MCP stdio server
```

---

## 与上游的差异

本项目 fork 自 [Zleap-AI/SAG](https://github.com/Zleap-AI/SAG)。核心差异（方便 cherry-pick / diff）：

- **存储**：用 SQLite + sqlite-vec 替换 PostgreSQL + pgvector — 整库一个 `.db` 文件可拷贝
- **Embedding**：内置 `local-bge` provider，可直接挂本地 ONNX 模型；不再强制远程 API
- **数据源**：文件夹监听、增量同步、manifest、文件类型白 / 黑名单等均在上游基础上增强
- **运行模型**：上游默认 PG + 云端 LLM；本仓库默认 SQLite + 离线 Embedding，单机即跑
- **可选能力**：在 `src/audit/` 与 `docs/audit-task-redesign/` 里保留了面向"过程档案"的扩展（共享文件夹扫描器、AI 抽程序、Timeline 记录、内联 SVG 流程图等），这些区域与上游可清晰隔离，需要时可整体丢弃回退到纯 SAG

冲突面集中在 `src/audit/` 与 `docs/audit-task-redesign/`，其他目录基本与上游同步演进。

---

## FAQ

### 端口被占用

修改 `.env`：

```env
HTTP_PORT=4173
```

5173 是 Vite 的开发端口，被占会自动换。

### 首次加载 Embedding 很慢

正常 — `local-bge` 第一次切换会加载 ONNX pipeline（~2 GB 临时内存）。之后每次只是 forward pass。

### 文档处理慢

取决于文件数、切片数、Embedding 调用延迟。可调 `.env`：

```env
INGEST_CONCURRENCY=5
```

### vec0 表查不到行 / 向量召回返回 0

当前 chunk 的 embedding 写在 `chunk_embeddings.embedding_json`（TEXT），`chunk_vec0` 虚拟表的写入通道尚未实现，所以 KNN 索引是空的。**召回实际走的是 BM25 / 全文匹配 + JS 端余弦回退**，仍可命中但不是 vec0 KNN。详见 `src/db/repositories.ts` 的注释。

### MCP 工具没有出现

打开项目内的 MCP 面板，确认配置已生成；外部 Agent 用 stdio 接入时务必设置 `SAG_MCP_SOURCE_ID` 为当前项目 ID。

---

## License

MIT License. See [LICENSE](LICENSE).
