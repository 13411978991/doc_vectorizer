# Watched Folders — Administrator Guide

> Version: Sprint 4 · Audience: ops / SRE / DevOps · Time to read: ~15 minutes

This guide covers deploying, configuring, and tuning SAG's watched folders
feature in production. It assumes you've already read
[`USER_GUIDE.md`](./USER_GUIDE.md) and understand what the feature does.

---

## Table of contents

1. [Architecture overview](#1-architecture-overview)
2. [Environment configuration](#2-environment-configuration)
3. [Database schema](#3-database-schema)
4. [Production deployment](#4-production-deployment)
5. [Performance tuning](#5-performance-tuning)
6. [Operational metrics](#6-operational-metrics)
7. [Backup and restore](#7-backup-and-restore)
8. [Security considerations](#8-security-considerations)
9. [Upgrading and migrations](#9-upgrading-and-migrations)
10. [Known limitations (Sprint 2 P0 fix and beyond)](#10-known-limitations)

---

## 1. Architecture overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│ SAG server (Node.js)                                                     │
│                                                                          │
│  ┌────────────────────────┐      ┌─────────────────────────────────┐     │
│  │  WatcherManager        │      │  Postgres                       │     │
│  │  (one chokidar watcher │      │  - watched_folders              │     │
│  │   per folder)          │      │  - file_manifest                │     │
│  │                        │      │  - sync_runs                    │     │
│  │  debounce: 1s per      │      │  - sources (auto-created)       │     │
│  │  folder                │      │  - documents (per file)         │     │
│  └──────────┬─────────────┘      └──────────────▲──────────────────┘     │
│             │                                │                          │
│             ▼                                │                          │
│  ┌────────────────────────┐                  │                          │
│  │  syncFolder()          │  reads/writes ────┘                          │
│  │  (orchestrator)        │                                             │
│  └──────────┬─────────────┘                                             │
│             │                                                           │
│             ▼                                                           │
│  ┌────────────────────────┐                                             │
│  │  ingestionService      │  ──▶ embeddings API + LLM extraction        │
│  │  .ingestDocument       │                                             │
│  └────────────────────────┘                                             │
│                                                                          │
│  HTTP API: /api/watched-folders/* (Sprint 2)                             │
│  MCP tools: add/list/trigger/remove_watched_folder (Sprint 2)            │
│  Web UI: /watched-folders (Sprint 3)                                     │
└──────────────────────────────────────────────────────────────────────────┘
```

Key processes:

- **`bootWatchedFolders()`** runs once at server startup. It queries
  `watched_folders` for all enabled folders, attaches chokidar to each, and
  runs a startup scan (trigger=`startup`) before listening for events.
- **Chokidar watchers** (one per folder) listen for add / change / unlink
  events with a 1-second debounce.
- **syncFolder()** does the actual work: scan → ingest diffs → delete
  removed → record run stats.

---

## 2. Environment configuration

| Env var                | Default | Purpose                                                                       |
|------------------------|---------|-------------------------------------------------------------------------------|
| `NODE_ENV`             | `development` | Controls the production gate (see below).                                |
| `ALLOW_PROD_WATCHER`   | `false` | **Required** in production: must be `true` to enable the watcher.             |
| `DATABASE_URL`         | `postgres://...` | Postgres connection string. Used for watched_folders, file_manifest, sync_runs, sources, documents. |
| `DEFAULT_TENANT_ID`    | `default` | Tenant id used when no `?tenantId=` is supplied to the API.                |
| `INGEST_CONCURRENCY`   | `5`      | Max concurrent event-extraction calls during ingest. Watcher ingest is sequential per sync, but embedding + extraction are parallel. |
| `EMBEDDING_*`          | (varies) | Embedding provider settings. The watcher uses the same ingestion pipeline as uploads, so it inherits the embedding config. |
| `LLM_*`                | (varies) | LLM provider settings for event extraction. Set `metadata.skipExtraction: true` on a folder to skip LLM calls entirely. |
| `LOG_LEVEL`            | `info`   | Set to `debug` to see per-event sync logs (chokidar events, scan results). |

### The production gate (ALLOW_PROD_WATCHER)

```ts
// src/watcher/index.ts
assertEnvironment(): void {
  if (config.NODE_ENV === "production" && !config.ALLOW_PROD_WATCHER) {
    throw new Error(
      "watcher: refusing to start in production without ALLOW_PROD_WATCHER=true"
    );
  }
}
```

This is a **safety mechanism**, not a feature. In production:

- Set `ALLOW_PROD_WATCHER=true` only on instances that should run the watcher.
- API-only instances (no watcher) don't need it set.
- Worker instances that should also do ingestion need it set.

The gate is checked on every `startAll` / `startOne` call. If you toggle
`NODE_ENV` at runtime, the watcher will refuse new attachments but existing
ones keep running.

### Boolean parsing for ALLOW_PROD_WATCHER

`ALLOW_PROD_WATCHER` accepts: `true`, `1`, `yes`, `on` (case-insensitive) as
truthy, and `false`, `0`, `no`, `off`, empty string as falsy. Anything else
is treated as truthy to fail safe.

---

## 3. Database schema

Three new tables were added in migration `008_add_watched_folders.sql`:

### `watched_folders`

```sql
create table watched_folders (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  path text not null,
  display_name text not null,
  source_id uuid not null references sources(id) on delete cascade,
  enabled boolean not null default true,
  recursive boolean not null default true,
  filetype_filter jsonb not null default '{}',
  metadata jsonb not null default '{}',
  last_scan_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, path)
);
```

### `file_manifest`

```sql
create table file_manifest (
  id uuid primary key default gen_random_uuid(),
  folder_id uuid not null references watched_folders(id) on delete cascade,
  rel_path text not null,
  mtime_ms bigint,
  inode bigint,
  size_bytes bigint,
  sha1 text,
  status text not null default 'pending'
    check (status in ('pending', 'syncing', 'synced', 'failed', 'deleted')),
  document_id uuid references documents(id) on delete set null,
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (folder_id, rel_path)
);
```

### `sync_runs`

```sql
create table sync_runs (
  id uuid primary key default gen_random_uuid(),
  folder_id uuid not null references watched_folders(id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed')),
  trigger text not null check (trigger in ('manual', 'scan', 'event', 'startup')),
  files_added int not null default 0,
  files_updated int not null default 0,
  files_deleted int not null default 0,
  files_failed int not null default 0,
  error_message text,
  metadata jsonb not null default '{}'
);
```

### Cascade behavior

- `watched_folders` row deleted → `file_manifest` + `sync_runs` cascade-delete,
  and the `sources` row is explicitly deleted (drops `documents` via the
  sources FK).
- `documents` row deleted → `file_manifest.document_id` is set to NULL (no
  orphan manifest rows).
- `sources` row deleted → `documents` cascade-deletes (chunks and entities
  cascade-delete via their own FKs).

### Indexes

The migration adds `watched_folders_tenant_idx` on `(tenant_id)` and
`file_manifest_folder_status_idx` on `(folder_id, status)`. Add more if you
query by other paths (e.g. `(folder_id, last_synced_at desc)` for "recently
synced files").

---

## 4. Production deployment

### Process topology

Recommended deployment:

```
┌─────────────────────────────────────────┐
│  SAG API instance(s)                     │
│  - serves HTTP API + web UI              │
│  - typically NO watcher (use ALLOW_PROD_ │
│    WATCHER=false)                        │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│  SAG Watcher instance(s)                 │
│  - dedicated worker process              │
│  - ALLOW_PROD_WATCHER=true               │
│  - reads from shared Postgres            │
│  - attaches chokidar to watched folders  │
│  - one per host (don't run multiple      │
│    watchers on the same folder — the     │
│    manifest CAS lock protects you, but   │
│    you'll waste work)                    │
└─────────────────────────────────────────┘
```

The HTTP API and the watcher can be on the same machine, but only one
process per machine should be the watcher for a given folder. The
manifest-level CAS lock (status column) prevents duplicate ingests, but
multiple workers waste CPU on the same scan.

### systemd unit example

```ini
# /etc/systemd/system/sag-watcher.service
[Unit]
Description=SAG Watched Folders Worker
After=network.target postgresql.service

[Service]
Type=simple
User=sag
EnvironmentFile=/etc/sag/watcher.env
ExecStart=/usr/bin/node /opt/sag/dist/src/index.js
Restart=on-failure
RestartSec=5s
# Resource limits
MemoryMax=2G
TasksMax=512

[Install]
WantedBy=multi-user.target
```

`/etc/sag/watcher.env`:

```
NODE_ENV=production
ALLOW_PROD_WATCHER=true
DATABASE_URL=postgres://sag:sag@db.internal:5432/sag
LOG_LEVEL=info
```

### Docker / Kubernetes

If running in containers, mount the folders you want to watch as volumes:

```yaml
# docker-compose.yml
services:
  sag-watcher:
    image: sag:latest
    environment:
      NODE_ENV: production
      ALLOW_PROD_WATCHER: "true"
      DATABASE_URL: postgres://...
    volumes:
      - /srv/team-docs:/srv/team-docs:ro
      - /var/sag/releases:/var/sag/releases:ro
```

For Kubernetes, use a `DaemonSet` if you want one watcher per node, or a
`StatefulSet` with a `PersistentVolumeClaim` per pod if the folders are
per-pod. Use a `Recreate` strategy (not `RollingUpdate`) to avoid two pods
watching the same folder during a rollout.

### Boot order

The watcher attaches chokidar AFTER running a startup scan. If the
filesystem is huge (10k+ files), the startup scan can take a while. Plan
your liveness probe accordingly:

```yaml
livenessProbe:
  httpGet:
    path: /api/health
    port: 4173
  initialDelaySeconds: 30
  periodSeconds: 30
```

The HTTP server starts immediately; the watcher attaches asynchronously.
The liveness probe checks `/api/health`, which is independent of watcher
state.

---

## 5. Performance tuning

### Ingestion throughput

The watcher does ingest serially within a single sync run (one file at a
time, see `INGEST_CONCURRENCY` for the embedding/extract parallelism).
Per-file cost is dominated by the embedding API call (~100-500 ms each).

**Rule of thumb**: a folder with N files takes ~N × 500 ms to ingest on a
first sync. A 1000-file folder = ~8 minutes. The debounce is 1 second, so
bursts are batched into single sync runs.

### chokidar limits

On Linux, chokidar uses inotify. The default `fs.inotify.max_user_watches`
is often 8192, which limits how many files you can watch in a single
folder. For folders with many files:

```bash
# /etc/sysctl.d/99-sag.conf
fs.inotify.max_user_watches = 524288
fs.inotify.max_user_instances = 512
```

Apply with `sudo sysctl --system`.

### Embedding / extraction API rate limits

If your embedding provider has rate limits, large bursts can hit them. The
ingestion service respects `LLM_MAX_RETRIES` (default 2) but doesn't
implement token-bucket rate limiting. Consider:

- Set `metadata.skipExtraction: true` on folders where you don't need event
  extraction (huge win — skips the LLM call entirely, only embeds chunks).
- Stagger folder creation in deploy scripts (don't create 10 folders at
  once if each has 1000 files).

### Memory

Each chokidar watcher keeps an open file handle per directory it watches.
For a deeply recursive folder, this can add up. `NODE_OPTIONS=--max-old-space-size=4096`
is a good starting point for production watcher instances.

### Disk

- The `.tmp/watcher/` directory holds transient copies of binary files
  during conversion. Clean it up periodically (it's `gitignored`).
- `sync_runs` accumulates forever. Add a retention job (Sprint 2+ backlog).

---

## 6. Operational metrics

The watcher emits pino structured logs at every key event:

```json
{"level":"info","folderId":"...","runId":"...","trigger":"event","path":"/srv/team-docs","msg":"watcher: sync started"}
{"level":"info","folderId":"...","runId":"...","added":5,"updated":2,"deleted":1,"msg":"watcher: scan complete"}
{"level":"info","folderId":"...","relPath":"...","documentId":"...","kind":"added","msg":"watcher: file ingested"}
{"level":"info","folderId":"...","runId":"...","status":"completed","stats":{...},"msg":"watcher: sync finished"}
{"level":"error","folderId":"...","error":"...","msg":"watcher: chokidar error"}
{"level":"error","folderId":"...","runId":"...","error":"...","msg":"watcher: sync failed"}
```

### Key metrics to track

- **Sync duration**: `sync_runs.finished_at - sync_runs.started_at` per run.
  Alert if a run takes > 10× the median for that folder.
- **Failure rate**: `count(*) where status='failed'` over the last 24 h,
  divided by total runs. Alert if > 5%.
- **Queue depth**: `count(*) from file_manifest where status='pending' or status='syncing'`
  for any folder. If non-zero for > 5 minutes, something is stuck.
- **Manifest size**: `count(*) from file_manifest where folder_id = ?`.
  If growing unboundedly, check for "deleted" status rows (kept forever
  by design — Sprint 2+ backlog is a retention job).

### Sample Prometheus exporter

```sql
-- Sync runs in the last hour, by status
select status, count(*) as n, avg(extract(epoch from finished_at - started_at)) as avg_duration_s
from sync_runs
where started_at > now() - interval '1 hour'
group by status;
```

---

## 7. Backup and restore

### What's in Postgres

The watcher state lives entirely in three tables: `watched_folders`,
`file_manifest`, `sync_runs`. Plus the auto-created `sources` rows.

If you back up Postgres (which you should), the watcher state is included.
The actual watched files are NOT in Postgres — they're on the filesystem
you pointed SAG at.

### Restore procedure

1. Restore Postgres from backup.
2. Restart SAG (it will re-run `bootWatchedFolders()`).
3. For each enabled folder, the startup scan re-indexes whatever is on
   disk. Files that match the manifest (by `rel_path` + `sha1`) are
   detected as unchanged and skipped. Files that don't match are
   re-ingested.

### What if files moved?

If a watched folder's path changes (e.g. `/srv/old-team-docs` →
`/srv/new-team-docs`):

1. Update the folder record via the API: `PATCH /api/watched-folders/:id`
   with the new path. (Sprint 2 supports this — the watcher will
   stop and restart with the new path.)
2. The manifest's `rel_path` is unchanged, so existing files are
   recognized.
3. New files (if any) are picked up on the next sync.

---

## 8. Security considerations

### Path traversal

The API validates that the path exists and is a directory before creating
a folder row. There's no path-traversal protection beyond that — the API
trusts the caller to know what they're doing. **Never expose the watched
folders API to untrusted clients.**

### Tenant isolation

The unique constraint `(tenant_id, path)` prevents cross-tenant folder
collision. All queries scope by `tenant_id`. The cascade on
`sources.id → documents.id` doesn't enforce tenant isolation directly —
be careful when joining.

### Reading sensitive files

The watcher will happily ingest any file that passes the filter. If a user
points the watcher at `/etc/`, they'll ingest every readable config file
into the knowledge base. **This is by design** — the watcher is opt-in
and the user has filesystem access.

Mitigations:

- Set a strict whitelist (e.g. only `.md`).
- Set a low maxBytes cap.
- Run the watcher as a dedicated user with restricted filesystem access
  (e.g. read-only on `/srv/sag-watchable/`).

### Python converter

Binary file conversion goes through `scripts/file-converter.py` (spawned
via Python 3). MarkItDown is the underlying library. The subprocess has
the same filesystem access as the SAG process. **Don't run the watcher as
root** unless you trust the watched folders absolutely.

---

## 9. Upgrading and migrations

### Sprint 1 → Sprint 2

Sprint 2 added the HTTP API, MCP tools, web UI, and the production gate.
The DB schema didn't change. To upgrade:

1. Pull the new code.
2. Rebuild (`npm run build`).
3. Restart SAG.
4. Set `ALLOW_PROD_WATCHER=true` in production if you want the watcher
   to auto-start.

### Sprint 2 → Sprint 3

Sprint 3 added the web UI. No DB changes. No env var changes. Just
restart.

### Adding new columns

If you need to add a column to `watched_folders` or `file_manifest`, write
a new migration file (`migrations/009_*.sql`) and run it. The schema uses
`create table if not exists` style, so the watcher code handles missing
columns via TypeScript optional fields.

---

## 10. Known limitations (Sprint 2 P0 fix and beyond)

The current Sprints 1-4 cover the core flow. Phase 2 backlog items:

- **Sync runs accumulate forever.** Add a retention job (`delete from
  sync_runs where started_at < now() - interval '30 days'`).
- **No chunk-level concurrency within a sync.** Per-file ingest is
  serial. Adding chunk-level parallelism would speed up first sync for
  large folders but requires concurrency-safe manifest updates.
- **Single-host watcher.** Don't run two SAG processes with
  `ALLOW_PROD_WATCHER=true` against the same folder. The manifest CAS
  lock prevents data corruption but wastes CPU.
- **No symlink following.** By design. `scanFolder()` skips symlinks to
  avoid cycles.
- **Sprint 2 P0 fix:** re-ingesting a changed file now deletes the old
  document before creating the new one. **Before the fix**, an orphan
  document was left in `documents` whenever a file changed. If you have
  legacy data with orphans, you can find them with:
  ```sql
  select fm.folder_id, fm.rel_path, d.id
  from file_manifest fm
  join documents d on d.id = fm.document_id
  where fm.status = 'synced'
    and d.metadata->>'watchedFolderId' = fm.folder_id::text
  group by fm.folder_id, fm.rel_path, d.id, d.created_at
  having count(*) over (partition by fm.folder_id, fm.rel_path) > 1;
  ```
  This finds `rel_path` entries with multiple documents — the orphans
  from before the fix. You can clean them up with a one-off script.

For anything else, see [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md).