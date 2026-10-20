# Watched Folders — User Guide

> Version: Sprint 4 · Audience: anyone who wants SAG to auto-sync a local folder
> into their knowledge base · Time to read: ~10 minutes

This guide shows you how to point SAG at a folder on your machine and have every
change in that folder (new files, edits, deletes) flow into your knowledge base
automatically. After the initial setup, you'll never have to manually upload
files again — the watcher handles it.

---

## Table of contents

1. [What is a watched folder?](#1-what-is-a-watched-folder)
2. [Quickstart: 60 seconds to your first watched folder](#2-quickstart-60-seconds-to-your-first-watched-folder)
3. [Four common scenarios](#3-four-common-scenarios)
   - Personal notes / Obsidian vault
   - Team documents / shared drive
   - Project archive / release snapshots
   - Real-time sync for downstream agents
4. [Using the web UI](#4-using-the-web-ui)
5. [Using the MCP tools](#5-using-the-mcp-tools)
6. [Filtering files (whitelist, blacklist, size cap)](#6-filtering-files-whitelist-blacklist-size-cap)
7. [What gets ingested and how](#7-what-gets-ingested-and-how)
8. [FAQ](#8-faq)
9. [Next steps](#9-next-steps)

---

## 1. What is a watched folder?

A **watched folder** is a directory on the SAG server's filesystem that the
watcher monitors. When a file is added, edited, or removed, the watcher:

1. Detects the change (via chokidar, with a 1-second debounce).
2. Runs a sync: scans the folder, computes what changed (mtime + SHA-1).
3. For added / changed files: ingests them into the SAG knowledge base.
4. For deleted files: hard-deletes the corresponding document.

Each watched folder becomes its own **Source** in SAG. Documents ingested from
that folder live under that source, so you can scope searches, audit
ingestion, and clean up just by deleting the folder.

---

## 2. Quickstart: 60 seconds to your first watched folder

1. Open SAG's web UI.
2. Click **Watched folders** in the left sidebar.
3. Click **New watcher**.
4. In the wizard:
   - **Path**: type the absolute path on the server, e.g. `/home/alice/notes`.
   - **Display name** (optional): a friendly name, e.g. "Alice's notes".
   - **Recursive**: leave checked to watch subdirectories.
5. Click **Next**, optionally set whitelist / blacklist / max size, then **Start watcher**.

Within a second the folder is being watched. Drop a `.txt` or `.pdf` into it
and watch it appear in your knowledge base within seconds.

---

## 3. Four common scenarios

### Scenario A: Personal notes / Obsidian vault

You keep your notes as Markdown in `~/Documents/notes`. You want every new
note and every edit to be searchable through SAG.

- **Path**: `/home/alice/Documents/notes`
- **Recursive**: ✅
- **Whitelist**: `.md, .txt`
- **Blacklist**: `.tmp` (so scratch files don't get indexed)
- **Max size**: empty (your notes are small)

The folder watcher creates one Source called `notes`. Every Markdown file in
that vault becomes a document you can search, ask questions about, or use as
context for SAG agents.

### Scenario B: Team documents / shared drive

Your team shares specs and design docs in `/srv/team-docs`. You want new
documents from your teammates to be picked up automatically.

- **Path**: `/srv/team-docs`
- **Recursive**: ✅
- **Whitelist**: `.pdf, .docx, .md, .txt`
- **Blacklist**: `.bak, .lock` (lock files from Office / LibreOffice)
- **Max size**: 50 MB (PDFs can be large but you don't want 500 MB tarballs)

When a teammate saves a new spec, it lands in your team's knowledge base
within a couple of seconds.

### Scenario C: Project archive / release snapshots

You generate release notes / changelogs as Markdown files in
`/var/sag/releases`. You want SAG to keep a snapshot history.

- **Path**: `/var/sag/releases`
- **Recursive**: ✅
- **Whitelist**: `.md`
- **Blacklist**: empty
- **Max size**: 5 MB

Each release note becomes a separate document. You can search "what changed
in v3.2?" and get the right doc.

### Scenario D: Real-time sync for downstream agents

You run an MCP-powered agent that needs to query the latest state of a folder
(e.g. config files, log digests). You want changes to be visible immediately.

- **Path**: `/etc/sag/agent-context`
- **Recursive**: ❌ (only top-level files)
- **Whitelist**: `.yaml, .json, .md`
- **Blacklist**: `.swp` (vim swap files)
- **Max size**: 1 MB

Every edit to a config file is detected in <2 seconds and the agent's
context is refreshed the next time it queries.

---

## 4. Using the web UI

### The list page

The list page shows every watched folder for the current tenant. Each row
displays:

- **Path** and **Display name**
- **Enabled / Paused** badge
- **Running / Stopped** badge (whether chokidar is attached)
- **Last sync result** (+added / ~updated / -deleted / ×failed)
- **Actions**: Details, Sync now, Pause / Resume, Delete

### The details page (3 tabs)

#### Overview tab

Shows folder metadata (path, display name, recursive, filter rules, last
scan, last error, last run stats).

#### File manifest tab

Lists every file the watcher has ever observed, with status:

- **Pending** — file is on disk but hasn't been ingested yet
- **Syncing** — currently being ingested
- **Synced** — successfully ingested (shows document id)
- **Failed** — last ingest attempt failed (shows error message)
- **Deleted** — file is gone (manifest row kept for history)

Click a status filter to narrow down. Useful for debugging "why isn't file X
showing up?".

#### Sync history tab

Shows the last N sync runs (default 50). Each run has a status badge
(running / completed / failed), trigger (manual / event / startup), and
stats. Useful for "when did this last work?" debugging.

### The wizard

The 4-step wizard walks you through:

1. **Path** — absolute path to the folder, plus display name and recursive flag
2. **Filter** — whitelist, blacklist, max size
3. **Confirm** — review the settings
4. **Submitting** — the server creates the row and starts chokidar

If the path doesn't exist or isn't a directory, the wizard shows a clear
error and stays on step 1.

---

## 5. Using the MCP tools

SAG exposes four MCP tools for managing watched folders. These work from any
MCP client (Claude Desktop, custom agents, etc.).

### `add_watched_folder`

Create a new watched folder and start the watcher.

```json
{
  "path": "/home/alice/notes",
  "recursive": true,
  "filetypeFilter": {
    "whitelist": [".md", ".txt"],
    "blacklist": [".tmp"],
    "maxBytes": 10485760
  },
  "displayName": "Alice's notes"
}
```

Returns the new folder's id, source id, path, and display name.

### `list_watched_folders`

List all watched folders for the current tenant.

```json
{}
```

Returns an array of folders with their current state (last scan, last run
stats, enabled flag).

### `trigger_sync`

Force a manual sync (useful for testing or after restoring a backup).

```json
{
  "folderId": "f3a1c2b4-5678-90ab-cdef-1234567890ab"
}
```

The sync runs in the background; poll `list_watched_folders` to see progress.

### `remove_watched_folder`

Stop the watcher and delete the folder record (cascade-deletes manifest +
sync history). Already-ingested documents are kept (you can delete them
through the documents API if needed).

```json
{
  "folderId": "f3a1c2b4-5678-90ab-cdef-1234567890ab"
}
```

Returns `{ deleted: true, folderId: ... }`.

---

## 6. Filtering files (whitelist, blacklist, size cap)

The watcher uses three filter dimensions, in priority order:

1. **Blacklist wins.** Any extension in the blacklist is skipped, even if it's
   in the whitelist. Use this for files you never want to ingest
   (`.tmp`, `.bak`, `.log`, swap files, etc.).
2. **Whitelist is opt-in.** If you set a whitelist, only files matching the
   whitelist are ingested. If you leave it empty, all supported extensions
   are accepted (see below).
3. **Max size cap.** Files larger than `maxBytes` are skipped. Useful to
   avoid ingesting 500 MB log dumps or huge PDFs.

Default supported extensions (when whitelist is empty): `.md`, `.txt`,
`.pdf`, `.docx`, `.xlsx`, `.xls`, `.csv`, `.png`, `.jpg`, `.jpeg`.

Examples:

| Goal                                 | Whitelist       | Blacklist       | Max bytes |
|--------------------------------------|-----------------|-----------------|-----------|
| Only markdown notes                  | `.md`           | (empty)         | (empty)   |
| All docs, no scratch files           | (empty)         | `.tmp, .bak`    | 50 MB     |
| Text and PDFs, skip large files      | `.md, .txt, .pdf` | (empty)       | 10 MB     |
| Everything except binaries           | (empty)         | `.zip, .tar.gz` | (empty)   |

---

## 7. What gets ingested and how

### Format support

- **`.txt` / `.md`** — passed through directly (no conversion needed)
- **`.pdf`, `.docx`, `.xlsx`, `.xls`, `.csv`, `.png`, `.jpg`, `.jpeg`** —
  routed through the Python converter (MarkItDown under the hood)
- **Other extensions** — skipped (manifest row marked as `synced` with a
  `skipped: extension not supported` reason)

### What happens on each event

| FS event   | Watcher action                                                                                    |
|------------|---------------------------------------------------------------------------------------------------|
| **add**    | Computes SHA-1; if the file isn't in the manifest, it's added to the queue for ingest            |
| **change** | Recomputes SHA-1; if it differs from the manifest's stored SHA-1, the old doc is deleted and the new file is re-ingested (P0 fix from Sprint 2: no orphan documents) |
| **unlink** | The corresponding document is hard-deleted (via `webuiService.deleteDocument`) and the manifest row is soft-deleted |

### The pipeline

```
chokidar event (debounced 1s)
       │
       ▼
syncFolder(folderId, "event", tenantId)
       │
       ▼
scanFolder (mtime + sha1 diff against manifest)
       │
       ├─ added[ ]  ──▶ ingestEntry ──▶ ingestionService.ingestDocument
       ├─ updated[] ──▶ ingestEntry (deletes old doc first) ──▶ ingestDocument
       └─ deleted[] ──▶ removeEntry (hard-deletes document)
       │
       ▼
finishSyncRun (records stats in sync_runs)
```

### Debounce

Burst writes are debounced 1 second. If you `git pull` and 30 files change
in 200 ms, you'll see one sync run with `added: 30` instead of 30 separate
runs.

### Failure modes

A failed ingest does **not** stop the rest of the run. The failing file's
manifest row is marked `failed` with the error message, and the other files
proceed. Check the **File manifest** tab to see what failed and why.

---

## 8. FAQ

**Q: Can I watch a folder on a different machine than the SAG server?**
A: No. The watcher uses chokidar (inotify on Linux), so the folder must be
on the same machine as the SAG server. For remote folders, mount them via
NFS / SMB first.

**Q: What happens if the SAG server restarts?**
A: On startup, `bootWatchedFolders()` re-attaches chokidar to every enabled
folder and runs a startup scan (trigger=`startup`). Files added while the
server was down are caught up.

**Q: Can two tenants watch the same folder?**
A: No. The unique constraint is `(tenant_id, path)`. If you need shared
ingestion across tenants, mount the folder under a tenant-specific path.

**Q: Does deleting a folder also delete the documents?**
A: No — deleting a folder stops the watcher, drops the manifest + sync
history, and drops the Source. Already-ingested documents are kept. To
delete them, use the documents API or the web UI's project view.

**Q: Will a sync run block the server?**
A: No. Syncs run in the background; the HTTP server stays responsive. A
sync can take a few seconds for a folder with thousands of files.

**Q: Can I trust the production gate?**
A: Yes. In `NODE_ENV=production`, the watcher refuses to start unless
`ALLOW_PROD_WATCHER=true`. This prevents deployed environments from
accidentally watching `/tmp` or `/var/log`.

**Q: What about files I'm currently writing?**
A: chokidar's `awaitWriteFinish` (400 ms stability threshold) waits for the
file size to stabilize before firing the event. A file that's being slowly
written (e.g. a 500 MB log dump) won't be ingested until it's done.

---

## 9. Next steps

- For deployment, performance tuning, and production gates, see
  [`ADMIN_GUIDE.md`](./ADMIN_GUIDE.md).
- For "why isn't this working?" debugging, see
  [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md).
- For the technical internals (data flow, schema, lifecycle), see
  [`src/watcher/README.md`](../../src/watcher/README.md).