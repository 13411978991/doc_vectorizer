# Projects (KB) → Audit Programs 合并方案

> 2026-07-05 20:23  
> 目标：把 Projects 改成和 Audit Tasks / Data Sources 同样的格式（共享文件夹驱动）

---

## 🎯 目标

**把 3 个左侧栏区压缩为 1 个**：Audit Tasks 区统一承担所有职责。

```
现状                              改后
─────────────────────            ──────────────
Projects (KB)         ──┐
                        ├──→  Audit Tasks
Data Sources (📁)      ──┤
                        │
Audit Tasks (📋)       ──┘
```

---

## 📐 概念合并

| 老概念 | 新概念 | 解释 |
|--------|--------|------|
| **KB Project** | **Audit Program** | 一个审计工作目录 |
| **Data Source** | **Shared Folder** | 一个共享根目录（多个 program 可共用） |
| **Audit Task** | **Audit Task** | 不变（程序下的一次审计实例） |

**关系**：
```
Shared Folder（共享根）
  └─ audit_programs/
     ├─ 2025年Q3采购审计/        ← Audit Program 1
     │  ├─ program.json
     │  ├─ materials/
     │  ├─ running/task-20260705-001/
     │  └─ completed/task-20260630-002/
     └─ 2025年报审计/             ← Audit Program 2
        └─ ...
```

**一个 Program = 一个老的 KB Project。**

---

## 🔧 改动清单

### 数据层
- **删除** `kb_projects` 表（保留 `audit_programs`）
- **删除** `kb_sources` 表（不再需要——共享文件夹自动发现）
- **保留** `audit_projects` 表（旧 audit workflow 用），加 `programId` 字段关联到 `audit_programs`
- **保留** `kb_project_cached_counts` 不变

### 后端
- `src/api/kb-projects.ts` → deprecated，标记 `programId` 直接对应
- 新增 `/api/audit/programs` 已经存在（上一阶段做的），把 KB project 逻辑合并进来
- 程序 = Project

### Web
- `web/src/App.tsx`：删除 "Projects (KB)" 区，Audit Tasks 区改造为统一入口
- 左侧栏只保留两区：
  - **数据源**（共享文件夹配置）
  - **审计任务**（所有 program + task 列表）

### MCP
- 老的 `create_audit_project` / `list_audit_projects` → deprecated，指向新的 `create_audit_program` / `list_audit_programs`
- 删除 `clone_audit_project`（program 通过共享文件夹克隆）

---

## ⚠️ 兼容性考虑

### 现有数据
- **现有 5 个 KB Project**（演示-合同审计 等）→ 手动迁移到 `audit_programs/`
- **上传文件 / documents 关联** → 通过 `programId` 重新挂载

### API 兼容
- 保留旧的 KB project API 至少 1 个 sprint（标记 deprecated），让外部 agent 有时间切换
- 新代码统一走 audit_programs API

---

## 📅 实施顺序

1. **数据迁移脚本** — 把 kb_projects 数据写到 `audit_programs` 表 + 磁盘目录
2. **审计 API 合并** — kb-projects.ts 的逻辑并入 audit-program-task.ts
3. **Web UI 整合** — 左侧栏只显示 2 区
4. **MCP 工具更新** — 旧工具指向新工具
5. **文档更新** — CHANGELOG / USER_GUIDE
6. **清理** — 删除废弃代码 / 表

---

## 🎯 期望效果

**用户视角**：
- 打开 SAG → 看到 2 个区：数据源 + 审计任务
- 所有审计相关的东西都在"审计任务"区
- 共享文件夹 = 数据源 = 真相之源

**架构视角**：
- 1 个核心概念（Audit Program）
- 1 个数据源（Shared Folder）
- 1 个执行单位（Audit Task）
- 1 个 SQLite 索引层（programs/tasks）
- 0 个云端同步依赖

---

_开始实施时间：2026-07-05 20:24_