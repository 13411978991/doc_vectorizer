# Audit Task Redesign — 实施报告

> 完成时间: 2026-07-05 19:22  
> 方案文档: [`PROPOSAL.md`](./PROPOSAL.md)

## ✅ 完成情况

| 任务 | 状态 | 备注 |
|------|------|------|
| #1 共享文件夹配置 | ✅ | `PUT/GET/DELETE /api/audit/config/shared-folder` + 创建子目录 |
| #2 扫描器 | ✅ | 5min/次，定期 + 手动触发 |
| #3 入库 | ✅ | SQLite 索引表 `audit_programs` + `audit_tasks` |
| #4 左侧栏 API | ✅ | `GET /api/audit/programs` 含 `taskStats` |
| #5 Task 详情页 API | ✅ | `GET /api/audit/tasks/:id` 含 timeline + notes |
| #6 Timeline 记录 | ✅ | append-only `timeline.jsonl` + 进程内锁 |
| #7 MCP 工具 | ✅ | 13 个新 MCP 工具 + 13 个 Trae JSON 文件 |
| #8 AI 抽程序 | ✅ | LLM + heuristic 双路径，LLM 失败时自动回退 |
| #9 流程图 | ✅ | 内联 SVG，无外部依赖 |
| #10 导出 | ✅ | HTML（必选）+ Markdown（可选） |

---

## 📁 新增文件

### 后端核心模块
```
src/audit/
├── audit-program-store.ts              SQLite 程序索引 + 读写 program.json
├── audit-program-task-mcp-service.ts   MCP service 层
├── audit-task-store.ts                 SQLite Task 索引 + 归档
├── flow-renderer.ts                    程序 → SVG
├── program-extractor.ts                AI 抽步骤（LLM + heuristic fallback）
├── shared-folder-config-store.ts       共享文件夹配置
├── shared-folder-scanner.ts            扫描器 + 程序/任务目录创建
├── task-exporter.ts                    HTML / Markdown 导出
└── timeline-writer.ts                  append-only 事件流 + 笔记
```

### API + 路由
```
src/api/audit-program-task.ts           22 个 REST 端点
```

### Migration
```
migrations/019_audit_programs_tasks.sql 3 张新表（SQLite 索引）
```

### MCP 工具定义（Trae JSON）
```
~/.trae-cn/mcps/.../tools/
├── configure_shared_folder.json
├── scan_shared_folder.json
├── list_audit_programs.json
├── create_audit_program.json
├── get_audit_program.json
├── update_audit_program.json
├── start_audit_task.json
├── list_audit_tasks.json
├── get_audit_task.json
├── log_audit_task_event.json
├── add_audit_task_note.json
├── finish_audit_task.json
└── export_audit_task.json
```

### 修改文件
- `src/index.ts` — 启动 `startSharedFolderScanner()`
- `src/api/server.ts` — 注册 `registerAuditProgramTaskRoutes`
- `src/mcp/server.ts` — 注册 13 个新 MCP 工具

---

## 🔍 E2E 验证

```
=== Configure shared folder ===
✅ OK

=== Create program (Chinese name) ===
✅ Program ID: 2025年Q3采购审计
✅ Path: /tmp/sag-shared-test2/audit_programs/2025年Q3采购审计/program.json

=== Start a task ===
✅ Task ID: task-20260705-001

=== Log 9 events ===
✅ ask_ai × 6, upload × 1, note × 1, tool_call × 1

=== Add note ===
✅ "这条流水跟合同金额对不上，建议深入查一下"

=== Finish task ===
✅ Status: completed
✅ AI extracted 4 steps (heuristic fallback — LLM API anthropic protocol mismatch)
✅ Flow SVG generated
✅ HTML report exported

=== Files on disk ===
✅ program.json / timeline.jsonl / notes.md / flow.svg / report.html
```

---

## 📊 测试

| 套件 | 通过 |
|------|------|
| 单元/集成 | 283/283 ✅ |
| E2E API | 手动验证通过 ✅ |

---

## ⚠️ 已知问题

### 1. LLM 抽程序走 heuristic fallback
- **原因**: `.env` 的 `LLM_BASE_URL=https://api.minimaxi.com/anthropic/v1` 是 anthropic 协议
- **影响**: 步骤抽取能用，但总结质量不高
- **修复方向**: 抽 `program-extractor.ts` 的 LLM 调用，换成对应协议，或换 URL

### 2. URL 编码中文 programId
- **现状**: Fastify 路由参数需要 URL 编码中文
- **影响**: 前端直接调 `encodeURIComponent()` 即可
- **修复方向**: 后续可以服务端转码

---

## 🎯 下一步建议

1. **Web UI**（左侧栏 + 详情页 + 流程图渲染）—— 当前只有 REST API，前端未集成
2. **LLM 修复**—— 修 `program-extractor.ts` 的 LLM 协议
3. **写入埋点**—— 在 Web UI 的"问 AI"、"上传文件"等操作里自动调 `POST /api/audit/tasks/:id/events`
4. **共享文件夹发现 UX**—— 加一个 onboarding wizard 引导用户配置
5. **导出优化**—— 加 PDF 导出 + 流程图嵌入

---

## 📌 给用户的提醒

刷新 `http://localhost:4173` 后：

1. 左侧栏 Audit Tasks 区域**暂时还是显示旧的"audit_projects"模式**
2. Web UI 改动未做（本次只做了后端 + MCP）
3. 通过 MCP 调用所有 13 个新工具已可用
4. 直接调 REST API 也可（用 Postman 或 curl）

---

_完成于 2026-07-05 19:22_