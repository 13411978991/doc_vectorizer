# Audit Task 重新设计方案

> 2026-07-05 与棉花大王对齐后确定的产品定义与实施计划。
>
> **核心转变**：Audit Task 从"SAG 内部的挂载文件夹"改为"**以共享文件夹为数据源的审计过程档案**"。SAG 不存数据，只做索引 + UI + 事件接收。

---

## 1. 业务背景

### 1.1 用户痛点（用户原话）

1. **触发门槛高**：现在要先有 Data Source（监听文件夹），再建 Audit Task、挂载 folder，多步操作让人放弃。
2. **脱离真实工作场景**：审计员第一步是"打开 SAG + 工作文件夹"，不是"SAG 里新建任务"。
3. **过程不存留**：问 AI、手工作业的过程没有记录，导致领导看不到、同事接不了手。
4. **经验难沉淀**：优秀审计员的方法论没有变成可复用资产。

### 1.2 设计目标

| 目标 | 含义 |
|------|------|
| **被动接收** | SAG 不主动发起审计任务，Audit Task 围绕"共享文件夹"展开 |
| **过程存留** | 所有操作（问 AI、上传、查文档）自动写 Timeline |
| **可视化** | Timeline 自动转流程图，方便领导/同事查看 |
| **可沉淀** | 完结后 AI 抽取步骤 → 形成可复用 Skill / 模板 |
| **共享靠文件夹** | 终端应用 + 多用户共享只能通过共享文件夹 |

---

## 2. 核心模型

### 2.1 触发模型

```
用户：打开共享文件夹（看到审计程序）     ← 触发点 1
   或
用户：在共享文件夹里创建审计程序         ← 触发点 2

SAG：扫描共享文件夹 → 发现审计程序 → 入库 SQLite 索引
用户：在 SAG UI 查看 / 接管 / 操作
```

### 2.2 存储模型（物理全在共享文件夹）

```
{共享根目录}/                              ← 用户在 SAG 设置一次
└─ audit_programs/
   ├─ 2025Q3采购审计/                      ← 一个审计程序
   │  ├─ program.json                     ← 程序定义（步骤、规则）
   │  ├─ materials/                       ← 审计材料
   │  │  ├─ 合同-供应商A.pdf
   │  │  └─ 银行流水.xlsx
   │  ├─ running/                         ← 进行中的 Task
   │  │  └─ task-20260705-001/
   │  │     ├─ timeline.jsonl             ← 过程事件流（每行一条）
   │  │     ├─ notes.md                   ← 用户批注
   │  │     └─ attachments/               ← 过程中的附件
   │  └─ completed/                       ← 已完结
   │     └─ task-20260530-002/
   │        ├─ timeline.jsonl
   │        ├─ notes.md
   │        ├─ report.html                 ← AI 生成的报告
   │        └─ flow.svg                    ← 流程图
   └─ 2025年报审计/
```

### 2.3 数据模型

#### AuditProgram（程序）
```ts
{
  id: string;                  // 文件夹名（slug）
  name: string;
  description?: string;
  steps: AuditStep[];          // {order, name, description}
  status: "draft" | "ready" | "running" | "completed" | "archived";
  projectId?: string;          // 关联到 SAG Project
  sharedRootPath: string;      // 所在共享文件夹
  programPath: string;         // program.json 绝对路径
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
```

#### AuditTask（过程档案）
```ts
{
  id: string;                  // task-YYYYMMDD-NNN
  programId: string;           // 关联的 AuditProgram
  programName: string;
  programPath: string;         // 父 program 路径
  taskPath: string;            // 当前 Task 目录路径
  status: "running" | "completed";
  startedAt: string;
  completedAt?: string;
  summary?: string;            // 完结时 AI 生成
  eventCount: number;
  assignee?: string;
}
```

#### AuditEvent（timeline.jsonl 单条）
```ts
{
  ts: string;                  // ISO 时间
  kind: "ask_ai" | "upload" | "view_doc" | "note" | "tool_call" | "conclusion";
  summary: string;             // 粗粒度描述
  detail?: string;             // 详细（可空）
  attachments?: string[];      // 相对路径
  source: "web" | "mcp" | "agent";  // 来源
}
```

---

## 3. 产品决策（已确认）

| 决策点 | 选择 | 含义 |
|--------|------|------|
| **Q5 触发粒度** | A | 每次审计工作一批 = 一个 Task |
| **Q6 自动记录粒度** | A | 全开：问 AI / 上传 / 查文档 / 笔记都记 |
| **Q7 Timeline 边界** | OK | 用户主动操作全记，UI 交互（切 tab/滚动）不记 |
| **Q8 流程图生成** | OK | AI 抽取 + 用户确认（完结时触发） |
| **Q9 导出格式** | 可选 Markdown | 必出 HTML，自选 Markdown |
| **Q10 程序抽取触发** | B | 完结时 + 手动触发 |
| **Q11 通知** | 不做 | 触发点是共享文件夹，不需要通知 |
| **Q12 触发入口** | C | 手动建文件夹 + SAG 按钮，两种都行 |
| **Q13 执行方式** | C | 用户手动 + Agent 都能记录 |
| **Q14 数据存储** | A | 全在共享文件夹，SAG 只做索引 |
| **Q15 配置方式** | A | 全局共享文件夹根目录 |
| **Q16 实施范围** | A+B 一起 | Phase A 架子 + Phase B 完整功能，~17h 一起做 |

---

## 4. 实施任务清单

| # | 模块 | 内容 | 估时 |
|---|------|------|------|
| 1 | **共享文件夹配置** | 设置页：配置全局共享文件夹根路径 | 1h |
| 2 | **扫描器** | 后台定期扫描 audit_programs/ | 2h |
| 3 | **入库** | 扫描到新程序 → 写 SQLite 索引表 | 1h |
| 4 | **左侧栏展示** | Audit Tasks 列表（按 sharedRoot 分组） | 1h |
| 5 | **Task 详情页** | Timeline + 流程图 + 注释 + 导出 | 3h |
| 6 | **Timeline 记录** | Web UI 操作 → 写 timeline.jsonl | 2h |
| 7 | **MCP 工具** | start/log/finish/get/list/export Task | 2h |
| 8 | **AI 抽程序** | 完结时从 Timeline 抽步骤 → 更新 program.json | 2h |
| 9 | **流程图可视化** | program.json → SVG 流程图 | 2h |
| 10 | **导出** | HTML / Markdown → completed/ | 1h |
| **总计** | | | **~17h** |

---

## 5. 架构

```
┌─────────────────────────────────────────────────────────────┐
│                    SAG Web UI (React)                        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐  │
│  │ Settings │ │ Sidebar  │ │ Task List│ │  Task Detail │  │
│  │ (配置    │ │ Audit    │ │ (按共享  │ │ (Timeline +  │  │
│  │ 共享根)  │ │ Tasks    │ │  分组)   │ │  流程图)     │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────┘  │
└─────────────────────────────────────────────────────────────┘
                            │ HTTP
┌─────────────────────────────────────────────────────────────┐
│                  SAG Backend (TS / Fastify)                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐  │
│  │ Audit    │ │ Shared   │ │ Timeline │ │  Program     │  │
│  │ API      │ │ Scanner  │ │ Writer   │ │  Extractor   │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────┘  │
│         │              │             │              │      │
│         └──────────────┴─────────────┴──────────────┘      │
│                          │ SQLite 索引                       │
└─────────────────────────────────────────────────────────────┘
                            │
                  读写文件到 ↓
                            │
┌─────────────────────────────────────────────────────────────┐
│            Shared Folder (文件系统 / 网络共享)               │
│  audit_programs/                                            │
│    2025Q3采购审计/                                          │
│      program.json / materials/ / running/ / completed/      │
└─────────────────────────────────────────────────────────────┘
                            ↑
                            │ MCP
┌─────────────────────────────────────────────────────────────┐
│              Trae / Other AI Agents                          │
│  start_audit_task / log_audit_task_event / finish_audit_task│
└─────────────────────────────────────────────────────────────┘
```

---

## 6. 验收标准

### 6.1 必须满足

- [ ] 用户可在 SAG 设置页配置全局共享文件夹路径
- [ ] SAG 扫描器能自动发现共享文件夹里的 audit_programs/ 结构
- [ ] 左侧栏 Audit Tasks 列表按 sharedRoot 分组显示
- [ ] 用户可创建新程序（"在共享文件夹里创建 audit_programs/xxx/"）
- [ ] 用户可创建新 Task（"开始审计" → 生成 task-XXX 目录）
- [ ] 用户在 Web UI 的操作（问 AI、上传、查文档）自动写 timeline.jsonl
- [ ] Agent 通过 MCP 调用 start/log/finish/get/list/export Task 全部可用
- [ ] 完结时 AI 自动抽取步骤 → 更新 program.json
- [ ] 流程图自动可视化（SVG）
- [ ] 可导出 HTML（必选）+ Markdown（可选）到 completed/
- [ ] 共享文件夹离线也能在文件系统直接查看

### 6.2 数据兼容性

- 不破坏现有 Projects、Data Sources、Audit Skills 模块
- 新表 `audit_programs` 和 `audit_tasks` 是独立的 SQLite 表
- 现有 AuditProcedureRecord 可标记为 deprecated，逐步迁移到新模型

---

## 7. 风险与回退

| 风险 | 缓解策略 |
|------|----------|
| 扫描器太频繁影响文件系统性能 | 5 分钟一次，可配置；用 chokidar 监听更优 |
| timeline.jsonl 写并发冲突 | 每次写用 append + 文件锁；完结后归档 |
| 共享文件夹不可达 | SAG 离线时只读 SQLite 索引，标记"stale" |
| 用户配置路径错误 | 设置时立即校验 + 友好错误提示 |
| 程序格式不兼容 | 读取时 schema 校验，失败标记"invalid"并跳过 |

---

## 8. 开发顺序

按依赖关系排序：

1. #1 配置页面 + 后端配置 API
2. #2 扫描器 + #3 SQLite 索引表
3. #4 左侧栏列表
4. #5 Task 详情页骨架
5. #6 Timeline 写入（Web UI 操作埋点）
6. #7 MCP 工具（先 REST API，再 MCP 暴露）
7. #8 AI 抽程序 + #9 流程图
8. #10 导出

每完成一个任务，跑 typecheck + 至少一个手动测试。

---

## 9. 文件清单（计划新增）

### 后端
- `src/audit/audit-program-store.ts`     — 程序 CRUD（基于 SQLite 索引）
- `src/audit/audit-task-store.ts`        — Task CRUD
- `src/audit/shared-folder-scanner.ts`   — 扫描器
- `src/audit/timeline-writer.ts`         — 写 timeline.jsonl
- `src/audit/program-extractor.ts`       — AI 抽步骤
- `src/audit/flow-renderer.ts`           — SVG 流程图
- `src/audit/task-exporter.ts`           — HTML/Markdown 导出
- `src/api/audit-program.ts`             — REST API
- `src/api/audit-task.ts`                — REST API
- `src/api/shared-folder-config.ts`      — 配置 API
- `migrations/019_audit_programs_tasks.sql`

### Web
- `web/src/pages/Settings/SharedFolder.tsx`    — 配置页面
- `web/src/components/AuditTaskList.tsx`      — 列表
- `web/src/components/AuditTaskDetail.tsx`    — 详情
- `web/src/components/AuditTimeline.tsx`      — Timeline 展示
- `web/src/components/AuditFlowGraph.tsx`     — 流程图

### MCP
- `src/mcp/audit-task-tools.ts`         — 7 个工具（start/log/finish/get/list/note/export）
- `~/.trae-cn/mcps/.../tools/start_audit_task.json` 等

### 文档
- 本文档 `docs/audit-task-redesign/PROPOSAL.md`
- `docs/audit-task-redesign/USER_GUIDE.md` （实施时写）
- `docs/audit-task-redesign/CHANGELOG.md` （实施时写）

---

_记录完成于 2026-07-05 19:11_