# Watched folders (`src/watcher/`)

Sprint 4 of the "watched folders" feature. The module lets a tenant point SAG
at a local folder; every change inside that folder (add / change / unlink) is
turned into a sync event that ingests / re-ingests / deletes files from the
SAG knowledge base. Sprints 2 and 3 added HTTP API, MCP tools, and a web UI.

## What it does

- **Detects changes** via a full scan on startup and incremental chokidar
  events afterwards. Changes are debounced 1 s so a single `git pull` doesn't
  fire 30 ingests.
- **Auto-creates a Source** for every watched folder. Ingested documents live
  under that source so they're easy to scope at search time.
- **Hard-deletes documents** when the file disappears — the
  `webuiService.deleteDocument()` endpoint handles the cascading entity cleanup.
- **Deduplicates concurrent ingests** with a manifest-level CAS lock
  (`status` column). Two workers can't ingest the same file at the same time.
- **Honors a production gate** — refuses to start in `NODE_ENV=production`
  unless `ALLOW_PROD_WATCHER=true`. This is the single biggest reason
  deployed environments don't accidentally start watching `/tmp`.
- **Re-ingestion replaces documents atomically (Sprint 2 P0 fix)** — when a
  file's content changes, the old document is hard-deleted before the new
  one is created. Before this fix, the old document was left as an orphan.

## Module layout

```
src/watcher/
├── README.md               ← you are here
├── types.ts                ← public types (WatchedFolderRecord, etc.)
├── manifest-store.ts       ← CRUD for the 3 new tables + Row → Record mapping
├── filetype-filter.ts      ← pure-function whitelist / blacklist
├── analyzer.ts             ← scanFolder() + computeSha1() + getInode()
├── file-converter.ts       ← in-process Node converter (PDF/DOCX/PPTX/XLSX/CSV/HTML → MD)
├── sync-orchestrator.ts    ← syncFolder() — the end-to-end pipeline (P0 fix in Sprint 2)
├── index.ts                ← WatcherManager — chokidar lifecycle + debounce
└── __tests__/
    ├── analyzer.test.ts
    ├── file-converter.test.ts
    ├── filetype-filter.test.ts
    ├── integration.test.ts           ← real SQLite
    ├── manifest-store.test.ts        ← real SQLite
    ├── production-gate.test.ts
    ├── race-condition.test.ts        ← manifest CAS in action
    ├── sync-orchestrator.test.ts
    └── e2e.test.ts                   ← Sprint 4: real WatcherManager + real chokidar
```

## Sync flow

```
┌──────────────────┐
│  chokidar event  │
│ (add/change/unlk)│
└────────┬─────────┘
         │ debounce 1s
         ▼
┌──────────────────┐
│ WatcherManager   │──── syncFolder(folderId, "event", tenantId)
└──────────────────┘
         │
         ▼
┌──────────────────┐
│ createSyncRun    │ ── row inserted in sync_runs
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ scanFolder       │ ── mtime/inode/size/sha1 vs manifest
└────────┬─────────┘
         │ added[] updated[] deleted[]
         ▼
┌──────────────────┐    ┌──────────────────────────┐
│ for each added / │──▶ │ shouldIncludeFile()      │
│ updated entry    │    │ maxBytes check           │
└────────┬─────────┘    │ manifest status CAS      │
         │              └──────────────────────────┘
         ▼
┌──────────────────┐
│ ingestionService │ ── ingestDocument({ sourceId, title, content, metadata })
│ .ingestDocument  │    metadata: { watchedFolderId, relPath, sourcePath, ... }
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ upsertManifest   │ ── status='synced', document_id=new.id
└──────────────────┘
         │
         │ (for deleted entries)
         ▼
┌──────────────────┐
│ webuiService     │ ── deleteDocument(documentId) → HARD delete
│ .deleteDocument  │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ finishSyncRun    │ ── status='completed', stats{added,updated,deleted,failed}
└──────────────────┘
```

## Sprint 2 / Sprint 3 surfaces

### HTTP API (Sprint 2 — `src/api/watched-folders.ts`)

10 routes, all tenant-scoped via `?tenantId=` (defaults to
`config.DEFAULT_TENANT_ID`):

| Method | Path                                          | Purpose                                           |
|--------|-----------------------------------------------|---------------------------------------------------|
| POST   | `/api/watched-folders`                        | Create a folder + start watcher                   |
| GET    | `/api/watched-folders`                        | List folders (with last run stats + watcher state) |
| GET    | `/api/watched-folders/:id`                    | Get one folder + last 10 sync runs                |
| PATCH  | `/api/watched-folders/:id`                    | Update display / enabled / recursive / filter     |
| DELETE | `/api/watched-folders/:id`                    | Stop watcher + cascade-delete folder              |
| POST   | `/api/watched-folders/:id/sync`               | Trigger a manual sync (returns 202 + run starts)  |
| POST   | `/api/watched-folders/:id/pause`              | Set `enabled=false`, stop watcher                 |
| POST   | `/api/watched-folders/:id/resume`             | Set `enabled=true`, start watcher                 |
| GET    | `/api/watched-folders/:id/runs`               | List sync runs (paginated, default 50)            |
| GET    | `/api/watched-folders/:id/manifest`           | List manifest rows (optionally filter by status)  |

### MCP tools (Sprint 2 — `src/services/watcher-mcp-service.ts`)

4 tools registered in `src/mcp/server.ts`:

| Tool                     | Purpose                                            |
|--------------------------|----------------------------------------------------|
| `add_watched_folder`     | Create + start (same as POST `/api/watched-folders`) |
| `list_watched_folders`   | List with last-scan + last-run stats               |
| `trigger_sync`           | Fire-and-forget manual sync (like POST `/sync`)    |
| `remove_watched_folder`  | Stop + delete (like DELETE `/api/watched-folders/:id`) |

MCP tools are tenant-scoped to `config.DEFAULT_TENANT_ID` (the watcher is
not bound to a single source/project, unlike search/ingest).

### Web UI (Sprint 3 — `web/src/pages/WatchedFolders/index.tsx`)

A 3-view workspace mounted in the left sidebar:

1. **List** — every folder with status badges, last-sync stats, action buttons.
2. **Wizard** — 4-step new-folder creation flow (path → filter → confirm → submit).
3. **Details** — 3 tabs:
   - **Overview**: folder metadata + filter rules + recent runs.
   - **File manifest**: table of every observed file with status filter chips.
   - **Sync history**: list of all sync runs with stats + error messages.

The list and details views both poll every 5 s. The details view shares a
single 5 s poll interval across the three tabs (Sprint 4 refactor) and
dispatches to the relevant endpoint based on the active tab.

## Lifecycle / startup wire

```
src/index.ts (entry point)
  │
  ├── bootWatchedFolders()
  │     ├── listFolders(config.DEFAULT_TENANT_ID)
  │     ├── filter to enabled
  │     └── watcherManager.startAll(folders)
  │           ├── for each folder: syncFolder(folderId, "startup", tenantId)
  │           └── for each folder: chokidar.watch(folder.path, { ignoreInitial: true, awaitWriteFinish: {...} })
  │
  ├── installShutdownHandlers()
  │     ├── SIGINT / SIGTERM → watcherManager.stopAll() + closePool()
  │
  └── startHttpServer()
        └── registerWatchedFoldersRoutes(app)    ← +10 routes from src/api/watched-folders.ts
```

The watcher attaches AFTER running a startup scan, so any files added
while the server was down are caught up on the next boot.

## Configuration

| Env var              | Default | Purpose                                                                 |
|----------------------|---------|-------------------------------------------------------------------------|
| `ALLOW_PROD_WATCHER` | `false` | Must be set to `true` in production to let the watcher start.           |

`ALLOW_PROD_WATCHER` accepts `true`, `1`, `yes`, `on` (case-insensitive) as
truthy and `false`, `0`, `no`, `off`, empty string as falsy.

## Folder metadata

The `watched_folders.metadata` JSONB column accepts arbitrary keys. Recognized keys:

| Key                  | Effect                                                              |
|----------------------|---------------------------------------------------------------------|
| `skipExtraction`     | When `true`, `ingestDocument` is called with `extract: false` so no  |
|                      | LLM calls happen. Use this on integrations where the LLM is offline. |

## Known limitations / Sprint 2+ backlog

- **Sprint 2 P0 fix**: re-ingestion of a changed file now hard-deletes
  the old document before creating the new one. Before the fix, the old
  document was left as an orphan. If you upgraded from a pre-Sprint-2
  SAG, see [`docs/watched-folders/TROUBLESHOOTING.md`](../../docs/watched-folders/TROUBLESHOOTING.md)
  for a SQL query to find pre-existing orphans.
- **Single-tenant per folder**: the unique constraint is `(tenant_id, path)`.
  Two tenants cannot share the same physical folder. This is intentional for
  Sprint 1 — a `shared_paths` table could be added in Phase 2.
- **Single-host watcher**: don't run two SAG processes with
  `ALLOW_PROD_WATCHER=true` against the same folder. The manifest CAS
  lock prevents data corruption but wastes CPU.
- **No quota / rate limiting**: each sync run ingests everything in one
  pass. Per-file ingest is serial; only embedding + extraction are
  parallel (`INGEST_CONCURRENCY`, default 5).
- **Sync runs are write-only**: `sync_runs` accumulates forever. Add a
  retention job in Phase 2 (e.g. `delete from sync_runs where started_at < now() - interval '30 days'`).
- **No symlink following**: by design — symlinks can create cycles.
- **No chunk-level concurrency within a sync**: per-file ingest is serial.
- **chokidar event timing**: chokidar's `awaitWriteFinish` waits 400 ms
  for the file size to stabilize before firing events. This is why
  burst-write tests need to keep writes within that window — the
  debounce then coalesces them into a single sync.

## Testing

```bash
# Pure unit tests
npx vitest run src/watcher/__tests__/filetype-filter.test.ts
npx vitest run src/watcher/__tests__/analyzer.test.ts
npx vitest run src/watcher/__tests__/file-converter.test.ts
npx vitest run src/watcher/__tests__/sync-orchestrator.test.ts
npx vitest run src/watcher/__tests__/race-condition.test.ts
npx vitest run src/watcher/__tests__/production-gate.test.ts

# Real-PG tests (Postgres must be running on localhost:5432)
npx vitest run src/watcher/__tests__/manifest-store.test.ts

# End-to-end (real PG + real Python)
npx vitest run src/watcher/__tests__/integration.test.ts

# Sprint 4: real WatcherManager + real chokidar + real PG
npx vitest run src/watcher/__tests__/e2e.test.ts

# Everything
npx vitest run src/watcher/__tests__/
```

The integration and e2e tests use `metadata.skipExtraction: true` to keep
them hermetic — they don't depend on the LLM endpoint. The e2e test still
hits the embedding API (since `extract=false` only skips event extraction,
not embedding).

## See also

- [`docs/watched-folders/USER_GUIDE.md`](../../docs/watched-folders/USER_GUIDE.md) —
  end-user guide with 4 common scenarios.
- [`docs/watched-folders/ADMIN_GUIDE.md`](../../docs/watched-folders/ADMIN_GUIDE.md) —
  ops / deployment / performance tuning.
- [`docs/watched-folders/TROUBLESHOOTING.md`](../../docs/watched-folders/TROUBLESHOOTING.md) —
  debugging the most common issues, error code reference, SQL queries.