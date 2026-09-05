# SAG MCP Server

> Last verified: 2026-07-29 · Model Context Protocol v2025-03-26

The SAG project ships an [MCP](https://modelcontextprotocol.io) server
that exposes the full knowledge-base surface — search, ingest, graph
traversal, watched-folder management, live progress — to any MCP-aware
LLM client (Claude Desktop, Cursor, Trae, Cline, Continue, claude.ai,
etc.).

This document is the authoritative reference. If code disagrees with
this file, the code is right and this file is wrong; please update it
in the same PR.

---

## Choosing how to run SAG MCP

There are **two supported deployment shapes**. Pick the one that fits
your audience:

| Path | Who it is for | What you ship | What the user does |
|---|---|---|---|
| **A. Zero-config `.exe` (auto-launch via Trae)** | End users on Windows 10/11 with no Node.js | `sag.exe` + `sag-mcp.exe` + an `mcp-config.json` snippet | Unzip, paste the snippet, **Trae spawns `sag-mcp.exe` itself** — no double-clicking |
| **B. Zero-config `.exe` (manual HTTP)** | Same end users, but they want the Web UI too | Same `sag.exe` | Double-click `sag.exe`, then point MCP client at `http://127.0.0.1:4174/mcp` |
| **C. Source checkout** | Developers / contributors | This git repo | `npm install && npm run db:setup && npm run mcp` |

All three expose the **exact same 8 tools / 5 resources / 5 prompts**.
The only difference is how the process is started.

---

## A. Zero-config `.exe` — Trae auto-launch (recommended for end users)

### What the end user receives

```
sag-package/
├── sag.exe              ← ~170 MB — Web UI + HTTP MCP (optional, for path B)
├── sag-mcp.exe          ← ~70 MB — stdio MCP server, **this is what Trae spawns**
├── .env.example         ← optional config (copy to .env to customize)
├── mcp-config.json      ← HTTP-mode snippet (path B)
└── mcp-config-stdio.json← stdio-mode snippet for Trae (path A)
```

Both `.exe` are produced by `npm run build:windows-all` (see
[BUILD-WINDOWS.md](./BUILD-WINDOWS.md)). `sag-mcp.exe` is a *separate*
process: it contains only the MCP stdio server (no Web UI, no HTTP
listener, no watcher) so Trae can spawn it instantly on demand.

### End-user setup — 3 steps

1. **Unzip** `sag-package.zip` into any folder (e.g. `D:\sag`).

2. **Create a project.** Run `sag.exe` once, open
   <http://localhost:4173>, click "新建项目". Copy the project UUID
   from the URL (`/projects/<uuid>`). Close `sag.exe` — you don't need
   it running for the stdio path.

3. **Paste the snippet into Trae.** Open Trae → MCP servers → edit
   config, paste `mcp-config-stdio.json`, **replace `INSTALL_DIR` with
   the folder from step 1** (e.g. `D:\\sag`). Save. Trae will spawn
   `sag-mcp.exe` automatically the first time you use any SAG tool in
   chat.

### Client snippets (path A — stdio, Trae auto-launch)

These tell the MCP client to spawn `sag-mcp.exe` directly. The end
user only edits `INSTALL_DIR` (or the equivalent `command` path) —
no port, no auth, no `SAG-MCP-Source-Id` header required.

> The user can run `sag_search { sourceIds: ["<uuid>", ...] }` to
> scope per call, or run `sag_list_projects` to discover UUIDs.
> Omitting the scope searches across **every project in the tenant**.

#### Trae (`%APPDATA%\Trae CN\User\mcp.json`)

```jsonc
{
  "mcpServers": {
    "sag": {
      "command": "INSTALL_DIR\\sag-mcp.exe",
      "args": [],
      "env": {
        "DEFAULT_TENANT_ID": "default"
      }
    }
  }
}
```

> Trae spawns `sag-mcp.exe` the first time you call any `sag_*` tool
> in chat. The process exits when Trae quits. No double-clicking.

#### Claude Desktop (`claude_desktop_config.json`)

```jsonc
{
  "mcpServers": {
    "sag": {
      "command": "INSTALL_DIR/sag-mcp.exe",
      "args": []
    }
  }
}
```

#### Cursor (`~/.cursor/mcp.json`)

```jsonc
{
  "mcpServers": {
    "sag": {
      "command": "INSTALL_DIR/sag-mcp.exe",
      "args": []
    }
  }
}
```

---

## B. Zero-config `.exe` — manual HTTP (for users who want the Web UI)

If the end user also wants the Web UI at <http://localhost:4173> (to
upload documents, browse the graph, manage watcher folders), they
double-click `sag.exe` first, then point the MCP client at the HTTP
endpoint. The two can coexist — both `.exe` read the same SQLite file
under `INSTALL_DIR\data\sag.db`, so projects created in the Web UI are
immediately visible to the MCP server and vice versa.

### End-user setup — 3 steps

1. **Run the server.** Double-click `sag.exe`. Wait for the console
   line `server: listening on http://0.0.0.0:4173`. Open
   <http://localhost:4173> in a browser to confirm the UI loads.

2. **Create or pick a project.** In the Web UI click "新建项目", give
   it a name, save. The project UUID appears in the project URL
   (`http://localhost:4173/projects/<uuid>`) and in
   **设置 → 项目 → 复制项目 ID**.

3. **Point your MCP client at the running SAG.** Use the HTTP
   transport — no `SAG_MCP_SOURCE_ID`, no `tsx`, no source code
   needed. See the client-specific snippets below.

### HTTP transport on the `.exe` — defaults

| Setting | Default | Where to change |
|---|---|---|
| Listen host | `127.0.0.1` | `.env` next to `sag.exe`, key `MCP_HTTP_HOST` |
| Listen port | `4174` | `MCP_HTTP_PORT` |
| Path | `/mcp` | `MCP_HTTP_PATH` |
| Auth mode | `none` (open) | `MCP_AUTH_MODE` (`none` / `bearer` / `api_key`) |
| Rate limit | 120 req/min per (identity, IP) | `MCP_RATE_LIMIT_RPM` |

To enable auth on the `.exe`, drop a `.env` file next to it:

```ini
MCP_TRANSPORT=http
MCP_AUTH_MODE=bearer
MCP_AUTH_TOKEN=<long-random-string>
```

Then add the matching header to the MCP client config:

```jsonc
"headers": {
  "Authorization": "Bearer <long-random-string>",
  "SAG-MCP-Source-Id": "<paste-project-uuid-here>"
}
```

---

## C. Source checkout (developers)

For contributors or anyone who wants to hack on SAG itself.

```bash
git clone https://github.com/Zleap-AI/SAG.git
cd SAG
npm install
cp .env.example .env         # fill in your LLM / Embedding keys
npm run db:setup             # apply SQLite migrations + seed entity types
```

### B.1 stdio (most common for development)

```bash
SAG_MCP_SOURCE_ID=<project-uuid> npm run mcp
```

The MCP client spawns SAG as a child process and exchanges JSON-RPC
frames over stdin/stdout. The client controls process lifecycle; SAG
exits when stdin closes.

**Required env var:** `SAG_MCP_SOURCE_ID` (or legacy alias
`SAG_MCP_PROJECT_ID`) — the four search / ingest tools reject calls
without it. Watcher tools (`add_watched_folder` etc.) don't need it.
**New in this build:** if you omit `SAG_MCP_SOURCE_ID`, the server
still starts; `sag_search` / `sag_explain_search` will fan out across
**all non-archived projects** in the default tenant. Pass an explicit
`sourceIds` array per-call to scope, or set `SAG_MCP_SOURCE_ID` to pin.

#### Minimal client config (stdio)

Claude Desktop `claude_desktop_config.json`:

```jsonc
{
  "mcpServers": {
    "sag": {
      "command": "npx",
      "args": ["tsx", "src/mcp/server.ts"],
      "env": {
        "SAG_MCP_SOURCE_ID": "<project-uuid>",
        "DATABASE_URL": "postgres://sag_lite:sag_lite_pass@localhost:5432/sag_lite"
      }
    }
  }
}
```

Trae `%APPDATA%\Trae CN\User\mcp.json` — same shape:

```jsonc
{
  "mcpServers": {
    "sag": {
      "command": "npx",
      "args": ["tsx", "src/mcp/server.ts"],
      "env": {
        "SAG_MCP_SOURCE_ID": "<project-uuid>",
        "DATABASE_URL": "postgres://sag_lite:sag_lite_pass@localhost:5432/sag_lite"
      }
    }
  }
}
```

> Paths in `args` are resolved relative to the **client's working
> directory**, not the SAG repo. For Trae on Windows that usually
> means you want an absolute path:
>
> ```jsonc
> "args": ["tsx", "D:\\code\\SAG\\src\\mcp\\server.ts"]
> ```

### B.2 HTTP (Streamable HTTP) — same as path A

```bash
MCP_TRANSPORT=http MCP_AUTH_MODE=bearer MCP_AUTH_TOKEN=secret npm start
```

Boots a stand-alone Node `http` server on `MCP_HTTP_HOST`:`MCP_HTTP_PORT`
(default `127.0.0.1:4174`) at `MCP_HTTP_PATH` (default `/mcp`). See
§ 1.2 for the verbs and the probe script.

---

## 1. Transports (technical detail)

### 1.1 stdio

The MCP client launches SAG as a child process and exchanges JSON-RPC
frames over stdin/stdout. The client controls process lifecycle; SAG
exits when stdin closes.

### 1.2 HTTP (Streamable HTTP)

Three verbs per the MCP spec:

| Verb | Purpose |
|---|---|
| `POST /mcp` | `initialize` / `tools/call` / `resources/read` / `prompts/get` |
| `GET /mcp`  | Open an SSE stream for server-initiated notifications |
| `DELETE /mcp` | Terminate the session bound to `mcp-session-id` |
| `OPTIONS` | Pre-flight; permissive CORS for browser clients |

Sessions are **stateful** by default: every `initialize` request
creates a fresh `StreamableHTTPServerTransport` and stores it in an
in-process `Map<sessionId, …>`. Subsequent requests reuse the same
transport via the `mcp-session-id` header. Sessions auto-clean on
`transport.onclose`. Server-initiated events (progress, audit)
deliver via SSE.

```bash
# Probe the HTTP transport with the official SDK.
cat <<'JS' > /tmp/mcp-probe.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "probe", version: "0" }, { capabilities: {} });
const transport = new StreamableHTTPClientTransport(
  new URL("http://127.0.0.1:4174/mcp")
);
await client.connect(transport);

console.log("tools:    ", (await client.listTools()).tools.map(t => t.name).join(", "));
console.log("resources:", (await client.listResources()).resources.map(r => r.uri).join(", "));
console.log("prompts:  ", (await client.listPrompts()).prompts.map(p => p.name).join(", "));

const { contents } = await client.readResource({ uri: "sag://config" });
console.log("config:\n", contents[0].text.slice(0, 200));

await client.close();
JS
MCP_AUTH_TOKEN=secret SAG_MCP_SOURCE_ID=$(uuidgen) npx tsx /tmp/mcp-probe.mjs
```

---

## 2. Authentication (HTTP only)

Stdin's transport inherits the OS-level process boundary, so auth
doesn't apply. The HTTP transport supports three modes selected by
`MCP_AUTH_MODE`:

| Mode | Header / value | Verification |
|---|---|---|
| `none` (default) | — | All callers admitted. **Dev/local only.** |
| `bearer` | `Authorization: Bearer <token>` | Token must match `MCP_AUTH_TOKEN`. Constant-time compare. |
| `api_key` (csv) | `X-MCP-Key: <key>` | Key must appear in comma-separated `MCP_API_KEYS`. |
| `api_key` (db)   | `X-MCP-Key: <key>` | Looked up in `mcp_api_keys` table; SHA-256 hash compare. See § 6. |

### Rate limiting

- `MCP_RATE_LIMIT_RPM` (default **120**) is a per-`(identity, IP)`
  in-memory token bucket, reset at the top of each minute.
- Set `MCP_RATE_LIMIT_RPM=0` to disable.
- Excess callers receive `429 RATE_LIMITED`; auth-denied callers
  receive `401 UNAUTHORIZED`. Both are JSON
  `{"error":{"code":"…","message":"…"}}`.
- Denials and 429s land in the audit log (`http_auth_denied`,
  `http_rate_limited` actions).

### Setup recipes

```bash
# (1) Dev — no auth.
MCP_TRANSPORT=http npm start

# (2) Single team — bearer.
TOKEN=$(openssl rand -hex 32)
MCP_TRANSPORT=http MCP_AUTH_MODE=bearer MCP_AUTH_TOKEN=$TOKEN npm start

# (3) Multiple teams — CSV api keys.
MCP_TRANSPORT=http \
MCP_AUTH_MODE=api_key \
MCP_API_KEYS="key-finance,key-legal,key-product" \
npm start

# (4) Multi-team production — DB-backed api keys (recommended).
#     See § 6 for the full CRUD + rotate workflow.
MCP_TRANSPORT=http MCP_AUTH_MODE=api_key MCP_API_KEY_BACKEND=db npm start
```

Logs identify api-key callers as `key:<label>:<first4chars>…` so an
audit can attribute calls without exposing the raw key.

---

## 3. Tools (8)

All tools return JSON-encoded text content. Errors share the shape
`{"error":{"code":"…","message":"…"}}`. Each tool is registered via
`server.tool(name, zodSchema, handler)` so argument shapes are
validated before the handler runs.

### 3.1 Core SAG (project-scoped)

#### `sag_ingest_document`

Indexes a single document; optionally extracts events / blocks until
done / streams progress.

| Argument | Type | Required | Notes |
|---|---|---|---|
| `title` | string | yes | Free-form title. |
| `content` | string | yes | UTF-8 text or markdown. |
| `sourceId` | uuid | **yes, unless** `SAG_MCP_SOURCE_ID` env is set | Project to ingest into. |
| `metadata` | object | no | Pass-through to the source row. |
| `extract` | boolean | no | Run event extraction in addition to chunking. |
| `waitForCompletion` | boolean | no | If true, block until ingest finishes. |
| `chunking.mode` | `"heading_strict" \| "token"` | no | Splitting strategy. |
| `chunking.maxTokens` | int 64..8192 | no | Per-chunk target. |
| `chunking.overlapTokens` | int 0..4096 | no | Adjacent-chunk overlap. |

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "sag_ingest_document",
    "arguments": {
      "title": "Q3 supply-contract review",
      "content": "## Background\n…",
      "sourceId": "59bfcc4d-…",
      "extract": true,
      "waitForCompletion": true,
      "chunking": { "mode": "token", "maxTokens": 512, "overlapTokens": 64 }
    }
  }
}
```

#### `sag_search`

Hybrid retrieval; returns ranked hits + a retrieval trace.

| Argument | Type | Default | Notes |
|---|---|---|---|
| `query` | string | — | required |
| `sourceIds` | uuid[] | `[]` = all non-archived projects | Empty array searches the whole tenant. |
| `strategy` | `"vector" \| "multi"` | `multi` | vector = single retriever; multi = vector + bm25 + rerank. |
| `searchMode` | `"standard" \| "fast"` | `standard` | fast skips the reranker. |
| `subStrategy` | `"multi" \| "multi1" \| "hopllm"` | `multi` | multi-strategy decomposition shape. |
| `topK` | int 1..50 | `10` | |
| `returnTrace` | boolean | `true` | When false, only hits are returned. |

#### `sag_explain_search`

Identical to `sag_search` but returns only the `trace` field — used
by the `audit-search-replay` prompt for "why was this ranked here"
walk-throughs.

#### `sag_get_event`

| Argument | Type |
|---|---|
| `eventId` | uuid |

Returns the event record, or `EVENT_NOT_FOUND`.

### 3.2 Tenant-wide tools (no source id required)

> New in this build. These let a stdio MCP client operate the whole
> SAG: list / create / archive / delete projects, inspect per-project
> stats. They intentionally bypass `SAG_MCP_SOURCE_ID` so a single
> client can drive multiple projects without restarting.

#### `sag_list_projects`

| Argument | Type | Default |
|---|---|---|
| `includeArchived` | boolean | `false` |
| `limit` | int 1..500 | `200` |

Returns `{projects: [{id, name, description, archivedAt, metadata, createdAt, updatedAt}], count}`.

#### `sag_create_project`

| Argument | Type | Required |
|---|---|---|
| `name` | string | yes |
| `description` | string | no |
| `metadata` | object | no |

Returns `{project: {id, name, …}}`. The new project is immediately
available for `sag_ingest_document` via its `id`.

#### `sag_archive_project` / `sag_restore_project`

| Argument | Type |
|---|---|
| `projectId` | uuid |
| `restore` | boolean (default `false`) |

Soft-delete / restore. Archived projects are excluded from
`sag_search` when no explicit `sourceIds` is given.

#### `sag_delete_project`

| Argument | Type | Notes |
|---|---|---|
| `projectId` | uuid | |
| `confirm` | `true` | **Required.** Refuses to run without explicit consent. |

Hard delete. Cascades to documents, chunks, events, entities, and
search traces. Cannot be undone.

#### `sag_project_stats`

| Argument | Type |
|---|---|
| `projectId` | uuid |

Returns `{documentsCount, eventsCount, entitiesCount, chunksCount, lastIngestAt}` for one project.

### 3.3 Watched folders (cross-cutting — no source id)

#### `add_watched_folder`

```jsonc
{
  "path": "D:/IT审计/site_map",
  "recursive": true,
  "filetypeFilter": {
    "whitelist": [".md", ".txt"],
    "blacklist": [".tmp"],
    "maxBytes": 52428800          // 50 MiB
  },
  "displayName": "site_map",
  "metadata": { "owner": "audit" }
}
```

Returns `{folderId, sourceId, path, displayName}`. Validates that
the path exists and is a directory before persisting; rejects
duplicates by absolute path within the same tenant.

#### `list_watched_folders`

Returns the full list of watched folders for the default tenant,
including last-scan timestamp and per-folder stats (added / updated /
deleted / failed counts).

#### `trigger_sync`

| Argument | Type |
|---|---|
| `folderId` | uuid |

Manually kicks off a sync run. The watcher discovers changes, enqueues
work, and the run row lands in the audit table (`sync_run` lifecycle
includes startup, manual, and event triggers).

#### `remove_watched_folder`

| Argument | Type |
|---|---|
| `folderId` | uuid |

Stops the chokidar watcher and deletes the folder row. Already
ingested documents are not deleted — call `sag_ingest_document` with
`metadata.archived_at` if you want them soft-archived.

### 3.4 Tool progress events

`tools/call` with `_meta.progressToken` forwards intermediate events
through the SSE stream:

- `sag_search_progress` — emitted by `sag_search` /
  `sag_explain_search` on each retrieval hop.
- `sag_model_call_log` — every LLM / embedding call: duration, token
  count, failure reason.

Claude Desktop surfaces these as spinner text; claude.ai uses them
for streaming status.

---

## 4. Resources (5)

Read-only snapshots. The SDK allows `resources/read` against a stable
URI; some clients also subscribe via `resources/subscribe` for
change notifications.

| URI | MIME | Payload |
|---|---|---|
| `sag://config` | `application/json` | Full runtime configuration: models, embedding dimensions, ports, enabled MCP transports. Use to prompt the LLM with "what tools are active". |
| `sag://stats` | `application/json` | Aggregate counts: watched folders + capture timestamp. Other counters (events, entities) added as services expose them. |
| `sag://events/recent` | `application/json` | Freshest events. Optional `?limit=N` (default 10, max 50). |
| `sag://folders` | `application/json` | Full manifest: id, path, recursive flag, file-type filter, last scan, enabled. |
| `sag://indexing/health` | `application/json` | Per-folder health: enabled / last-scan / never-scanned status — for ops dashboards spotting folders whose last scan fell off. |

Error responses set `isError: true` and return a short text payload
so the LLM sees a narrative explanation rather than a stack trace.

Adding a new resource: drop a `server.resource(...)` block into
[src/mcp/resources.ts](../src/mcp/resources.ts). The pattern is
identical to the existing five.

---

## 5. Prompts (5)

Reusable, parameterised system prompts. An MCP client lists them,
previews the argument schema, and surfaces them as `/slash` commands
or pinned buttons.

| Prompt | Args | Workflow |
|---|---|---|
| `audit-search-replay` | `query`, `topK?` | Calls `sag_explain_search` and narrates why each candidate was promoted or dropped. |
| `contract-risk-scan` | `contract` (path/id) | Five-dimension risk score (payment-delay, scope-creep, indemnity-gap, term-mismatch, governing-law) with conservative defaults when data is missing. |
| `ingest-folder` | `folderId` (uuid) | Bulk-ingest workflow: `list_watched_folders` → `trigger_sync` → verify in index. |
| `bilingual-summary` | `documentId` | Retrieves the source and produces parallel English + Chinese 4-bullet summaries. |
| `glossary-builder` | `topic`, `maxTerms?` | Mines events for the topic and clusters them into a markdown glossary table. |

Adding a prompt: append a `server.prompt(...)` block in
[src/mcp/prompts.ts](../src/mcp/prompts.ts). Argument schemas use
Zod so type errors fail at registration time, not at request time.

---

## 6. DB-backed API key management

The CSV backend (`MCP_API_KEYS=...`) is fine for local dev. For
production deployments, switch to the DB backend and manage keys
through the REST API.

```bash
# 1. Boot SAG with the db backend.
MCP_AUTH_MODE=api_key MCP_API_KEY_BACKEND=db npm start

# 2. Create a key. The plaintext is returned EXACTLY ONCE — store
#    it in a secret manager immediately.
curl -s -X POST http://127.0.0.1:4173/api/mcp/api-keys \
  -H "content-type: application/json" \
  -d '{"label":"Production CI","scopes":["tools:read","tools:call"],"rateLimitRpm":60}'
# { "key": { "id":"...","fingerprint":"abcd1234", "enabled":true, ... },
#   "plaintext":"abc...xyz" }

# 3. Use the plaintext with the MCP HTTP transport.
curl -s -X POST http://127.0.0.1:4174/mcp \
  -H "x-mcp-key: <plaintext from step 2>" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize",…}'
# identity in audit logs becomes: key:Production CI:abcd1234…

# 4. List / inspect keys (plaintext never returned).
curl http://127.0.0.1:4173/api/mcp/api-keys | jq
curl http://127.0.0.1:4173/api/mcp/api-keys/<id> | jq

# 5. Rotate: revoke the old one, issue a new one.
curl -X DELETE http://127.0.0.1:4173/api/mcp/api-keys/<id> \
  -H "content-type: application/json" \
  -d '{"revokedBy":"ops@2026-07-13"}'
```

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET`    | `/api/mcp/api-keys`         | List keys (tenant-scoped, no plaintext). |
| `POST`   | `/api/mcp/api-keys`         | Create key; returns `key` (no hash) + `plaintext`. |
| `GET`    | `/api/mcp/api-keys/:id`     | Read one key (still no plaintext). |
| `PATCH`  | `/api/mcp/api-keys/:id`     | Update label / scopes / enabled / rate-limit override. |
| `DELETE` | `/api/mcp/api-keys/:id`     | Soft-revoke (`revoked_at = current_timestamp`). |

### Security & lifecycle

- **Hash-only storage.** `mcp_api_keys.hash` holds SHA-256 of the
  plaintext; verification is constant-time at the service layer
  (`verifyHash`). Plaintext is never reissued.
- **Cache.** Per-tenant LRU (`MCP_API_KEY_CACHE_MAX`, default 256)
  caches `ApiKeyIdentity` lookups so the hot path doesn't hit SQLite
  on every request. Mutations (PATCH/DELETE) evict the cache entry.
- **Last-used telemetry.** Successful auth updates `last_used_at` /
  `last_used_ip` at most once per minute per row (throttled in the
  service). Crashes in this code path are silently dropped — audit
  integrity > telemetry completeness.
- **Audit trail.** `api_key_created / updated / revoked` events land
  in `audit_logs` with the actor recorded as `created_by` (or the
  `revokedBy` body field).
- **Tenant scoping.** All endpoints are tenant-scoped via the
  standard `DEFAULT_TENANT_ID` env or `?tenantId=…` query param.
  List / get / update / revoke all verify tenant ownership before
  mutation.
- **Backwards compat.** `MCP_API_KEY_BACKEND` defaults to `csv`; the
  same `MCP_AUTH_MODE=api_key` setting continues to read
  `MCP_API_KEYS` until you flip the mode.

---

## 7. Configuration reference

```envc
# Switch on
MCP_TRANSPORT=http                    # "stdio" (default) | "http"
MCP_HTTP_PATH=/mcp
MCP_HTTP_PORT=4174
MCP_HTTP_HOST=127.0.0.1

# Auth
MCP_AUTH_MODE=bearer                  # none | bearer | api_key
MCP_AUTH_TOKEN=…                      # bearer mode
MCP_API_KEYS=key-a,key-b              # api_key mode (CSV)
MCP_API_KEY_BACKEND=csv               # csv | db

# Limits
MCP_RATE_LIMIT_RPM=120                # 0 to disable
MCP_API_KEY_CACHE_MAX=256             # LRU size, db backend

# Source binding (sag_ingest_document requires one of these to be set;
# sag_search / sag_explain_search fall back to "all projects" if unset)
SAG_MCP_SOURCE_ID=<project uuid>
SAG_MCP_PROJECT_ID=…                  # legacy alias
MCP_REQUIRE_SOURCE_ID=true            # stdio default; set false to relax

# Persistence: write MCP HTTP events into the SQLite audit_logs table
MCP_AUDIT_LOG_ENABLED=true            # false to no-op the inserts
```

All fields live in [src/config/env.ts](../src/config/env.ts) and are
validated by Zod, so a stray value fails fast at boot instead of
silently masking in production.

---

## 8. Operations & observability

### 8.1 Listening

| Setting | Default |
|---|---|
| Listen host | `MCP_HTTP_HOST` (`127.0.0.1`) |
| Listen port | `MCP_HTTP_PORT` (4174) |
| Path        | `MCP_HTTP_PATH` (`/mcp`) |

### 8.2 Sessions

In-memory `Map<sessionId, { transport, identity, createdAt }>`.
`httpMcpSessionStats()` (exported from [src/mcp/http-server.ts](../src/mcp/http-server.ts))
returns `{count, identities}` for tests and ops scripts. Sessions
auto-clean on `transport.onclose`.

### 8.3 Audit log

Every HTTP MCP event lands in the SQLite `audit_logs` table when
`MCP_AUDIT_LOG_ENABLED=true` (default):

| `action`              | When |
|-----------------------|------|
| `http_auth_success`   | Caller authenticated (after passing both auth and rate-limit). |
| `http_auth_denied`    | Bearer/api-key missing or wrong; includes the rejection reason in `payload`. |
| `http_rate_limited`   | Caller authenticated but the per-`(identity, IP)` bucket was empty. |
| `http_session_opened` | A new `mcp-session-id` was issued. |
| `http_session_closed` | A transport closed; `payload.lifetimeMs` is recorded. |
| `http_tool_call`      | A `tools/call` JSON-RPC method dispatched; `payload.tool`, `payload.argKeys`, `payload.durationMs`, `payload.jsonrpcId`. Logged regardless of outcome — audit, not just success. |
| `api_key_created`     | `POST /api/mcp/api-keys` succeeded. |
| `api_key_updated`     | `PATCH /api/mcp/api-keys/:id` changed label / scopes / enabled / rate-limit override. |
| `api_key_revoked`     | `DELETE /api/mcp/api-keys/:id` set `revoked_at`; subsequent auth is denied. |

Append-only. Inserts that fail are swallowed (`logger.warn`) so they
never crash the request. Read via:

```bash
curl -s 'http://127.0.0.1:4173/api/mcp/audit-log?entityType=mcp_http_session' | jq
curl -s 'http://127.0.0.1:4173/api/mcp/audit-log?action=http_auth_denied&limit=20' | jq
```

Query params: `entityType`, `entityId`, `action`, `actor`, `since`,
`until`, `limit` (1..1000, default 100). Authoritative schema and
filter logic in [src/services/audit-log-service.ts](../src/services/audit-log-service.ts);
routing in [src/api/mcp-audit.ts](../src/api/mcp-audit.ts).

### 8.4 Graceful shutdown

`handle.close()` (returned by `startMcpHttpServer()`) tears the HTTP
server down. The SIGINT/SIGTERM handlers in [src/index.ts](../src/index.ts)
already route through it.

---

## 9. Quick verification

```bash
# Boot the HTTP server with bearer auth.
MCP_TRANSPORT=http \
MCP_AUTH_MODE=bearer \
MCP_AUTH_TOKEN=secret \
SAG_MCP_SOURCE_ID=$(uuidgen) \
npm start &

# Initialize + list tools.
curl -s -X POST http://127.0.0.1:4174/mcp \
  -H 'authorization: Bearer secret' \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
  | head -c 400 ; echo

# After `initialize` returns `mcp-session-id`, reuse it for everything
# else. Replace `<sid>` with the value returned above.
SID=<sid>
curl -s -X POST http://127.0.0.1:4174/mcp \
  -H "authorization: Bearer secret" \
  -H "mcp-session-id: $SID" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | jq '.result.tools[].name'

curl -s -X POST http://127.0.0.1:4174/mcp \
  -H "authorization: Bearer secret" \
  -H "mcp-session-id: $SID" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_watched_folders","arguments":{}}}' | jq
```

---

## 10. Roadmap (deferred follow-ups)

Tracked separately, intentionally out of scope for the current
implementation:

- **Resource subscription** — wire up `resources/subscribe` +
  `resources/unsubscribe` so an LLM can stream file-system events
  instead of polling `sag://events/recent`.
- **OAuth 2.1 server** — add a `/oauth/authorize` + `/oauth/token`
  flow so non-technical teams can plug straight into claude.ai.