# Watched Folders — Troubleshooting

> Version: Sprint 4 · Audience: anyone debugging a watcher issue · Time to read: ~10 minutes

This guide helps you diagnose and fix the most common issues with watched
folders. Start with the [Quick diagnostic checklist](#quick-diagnostic-checklist),
then drill down by symptom.

---

## Table of contents

1. [Quick diagnostic checklist](#quick-diagnostic-checklist)
2. [Error code reference](#error-code-reference)
3. [Symptoms](#symptoms)
   - "My file isn't getting ingested"
   - "The watcher isn't running in production"
   - "Sync keeps failing"
   - "Orphan documents (old data from before Sprint 2 fix)"
   - "Race conditions / duplicate ingests"
   - "Files are being skipped"
   - "Watcher crashed at startup"
   - "Syncs are slow"
4. [Debugging tools](#debugging-tools)
5. [Common root causes](#common-root-causes)
6. [Getting help](#getting-help)

---

## Quick diagnostic checklist

Run through these in order — 90% of issues are caught here:

- [ ] **Is the folder `enabled`?** Check the **Enabled** badge in the list
      page. A `false` value means no events will fire.
- [ ] **Is the chokidar watcher actually running?** Look for the
      **Running** badge. If it's `Stopped`, the watcher isn't attached.
- [ ] **Does the path exist?** Run `ls -la <path>` on the server. If the
      path doesn't exist, every sync will fail with `path not accessible`.
- [ ] **Is `NODE_ENV=production` + `ALLOW_PROD_WATCHER=false`?** Check
      the server's env. In production the watcher refuses to start
      without the gate. Either set `ALLOW_PROD_WATCHER=true` or move
      the watcher to a non-production instance.
- [ ] **Is the file passing the filter?** Check the manifest — if the
      file's status is `synced` with a `skipped: ...` error message, the
      filter excluded it.
- [ ] **Is the file extension supported?** Default whitelist is `.md,
      .txt, .pdf, .docx, .xlsx, .xls, .csv, .png, .jpg, .jpeg`. Anything
      else is skipped.
- [ ] **Does the file exceed `maxBytes`?** Files larger than the cap are
      silently skipped.
- [ ] **Are you looking at the right tenant?** Multi-tenant deployments
      partition folders by tenant id. Cross-tenant paths are 404s.
- [ ] **Are there recent errors in the log?** Search for
      `level:50` (error level) entries mentioning `folderId:` matching
      your folder.

---

## Error code reference

The HTTP API uses `{ error: { code, message } }` for all 4xx/5xx
responses. Here are the codes you'll see, in the order you're likely to
hit them:

| HTTP | Code                              | Meaning                                                                  | What to do                                                                                  |
|------|-----------------------------------|--------------------------------------------------------------------------|---------------------------------------------------------------------------------------------|
| 400  | `FOLDER_PATH_NOT_FOUND`           | The path doesn't exist or isn't accessible to the SAG process.            | Verify the path on the server: `ls -la /path`. Fix typos. Check filesystem permissions.    |
| 400  | `FOLDER_PATH_NOT_DIRECTORY`       | The path exists but is a file, not a directory.                          | Point the watcher at a directory, not a single file.                                        |
| 400  | `BAD_REQUEST`                     | The folder id is missing or malformed.                                   | Check the URL — folder ids are UUIDs.                                                       |
| 404  | `FOLDER_NOT_FOUND`                | No folder with that id (in this tenant).                                 | List folders and verify the id. Check `tenantId=`.                                          |
| 409  | `FOLDER_PATH_ALREADY_EXISTS`      | Another folder with the same path already exists for this tenant.        | Use the existing folder or delete it first. The unique constraint is `(tenant_id, path)`.   |
| 409  | `SYNC_ALREADY_RUNNING`            | A sync is already in progress for this folder.                           | Wait for the previous sync to finish, or check the previous run's error.                    |

The MCP service throws plain `Error`s with descriptive messages. Map
them to the HTTP codes above for the same meaning.

The watcher also logs errors with these messages:

| Log message                                        | Cause                                                                 |
|----------------------------------------------------|-----------------------------------------------------------------------|
| `watcher: refusing to start in production`         | `NODE_ENV=production` and `ALLOW_PROD_WATCHER` is not `true`.          |
| `watcher: chokidar error`                          | chokidar hit an FS error (watch limit, permission denied, etc.).       |
| `watcher: sync failed`                             | syncFolder threw (path not accessible, DB error, etc.).                |
| `watcher: ingest failed`                           | ingestionService.ingestDocument threw (embedding API down, etc.).      |
| `watcher: failed to delete old document`           | webuiService.deleteDocument threw (other than "not found").           |
| `watcher: remove failed`                           | Sync's deletion phase failed.                                          |
| `watcher: failed to mark manifest failed`          | Couldn't write `status='failed'` to the manifest row.                  |
| `watcher: startup scan failed`                     | The startup scan (on watcher attach) threw. The chokidar watcher is still attached. |

---

## Symptoms

### "My file isn't getting ingested"

1. **Check the manifest**: open the folder's **File manifest** tab and
   search for your file's name. The status tells you:
   - **No row**: chokidar hasn't seen the file yet. Wait for the 1 s
     debounce. If still nothing, check if the watcher is running.
   - **`pending`**: a sync is queued but hasn't run yet.
   - **`syncing`**: a sync is in progress.
   - **`synced` with `skipped:` error**: the filter excluded it. Check
     whitelist / blacklist / maxBytes.
   - **`failed` with error message**: read the error. Common causes:
     embedding API timeout, LLM API down, file too big.

2. **Force a manual sync**: click **Sync now** in the details page.
   This bypasses chokidar and runs `syncFolder` directly. If the file
   still doesn't ingest, the issue is in the pipeline (not chokidar).

3. **Check the server logs**:
   ```bash
   # Tail the watcher logs
   tail -f sag.log | jq 'select(.folderId == "<your-folder-id>")'
   ```
   Look for `watcher: sync started`, `watcher: scan complete`, and
   `watcher: file ingested` events.

4. **Verify chokidar is firing events**: temporarily run a quick test:
   ```bash
   # In the watched folder, touch a file
   touch /path/to/folder/test.txt
   # Within 2 seconds you should see "watcher: sync started" in the logs
   ```

### "The watcher isn't running in production"

Check the server's environment:

```bash
# On the SAG server
echo $NODE_ENV $ALLOW_PROD_WATCHER
# If NODE_ENV=production and ALLOW_PROD_WATCHER is empty/false, the watcher refuses to start.
```

Fix: either:
- Set `ALLOW_PROD_WATCHER=true` in the env and restart, or
- Run the watcher on a dedicated instance with `ALLOW_PROD_WATCHER=true`
  while the API instances have it set to `false`.

The error message in the startup log will say
`watcher: refusing to start in production without ALLOW_PROD_WATCHER=true`.

### "Sync keeps failing"

The sync run status is `failed` with an error message. Common causes:

| Error pattern                                  | Cause                                                                | Fix                                                                                       |
|------------------------------------------------|----------------------------------------------------------------------|-------------------------------------------------------------------------------------------|
| `path not accessible: ENOENT: ...`             | The path was deleted or moved.                                       | Restore the path or update the folder record via `PATCH /api/watched-folders/:id`.        |
| `path is not a directory`                      | The path is now a regular file (someone replaced it).                | Restore as a directory or remove the folder.                                              |
| `permission denied`                            | The SAG process can't read the folder.                               | `chmod` / `chown` so the SAG user can read. Don't run as root if you don't have to.      |
| Embedding API timeout                          | The embedding endpoint is slow / down.                               | Check the embedding provider's status. The watcher retries `LLM_MAX_RETRIES` times.       |
| `relation "documents" does not exist`          | Migrations weren't applied to this DB.                               | Run `npm run db:migrate`.                                                                 |
| Connection refused to Postgres                 | DATABASE_URL is wrong or DB is down.                                 | Check `psql $DATABASE_URL` from the server.                                              |
| `chunkMarkdown failed: ...`                    | Content is malformed (very rare for .txt/.md).                       | Try ingesting the file manually via the upload API.                                       |

### "Orphan documents (old data from before Sprint 2 fix)"

If you upgraded from a pre-Sprint-2 SAG, you might have documents that
were never cleaned up when files changed. The Sprint 2 P0 fix only
applies to changes from that point forward.

To find orphans:

```sql
-- For each (folder_id, rel_path) with multiple documents, the older ones are orphans.
select
  fm.folder_id,
  fm.rel_path,
  d.id as orphan_document_id,
  d.created_at
from file_manifest fm
join documents d on d.id = fm.document_id
where fm.status = 'synced'
  and exists (
    select 1 from file_manifest fm2
    where fm2.folder_id = fm.folder_id
      and fm2.rel_path = fm.rel_path
      and fm2.document_id is not null
      and fm2.document_id <> fm.document_id
  )
order by fm.folder_id, fm.rel_path, d.created_at;
```

To clean up orphans, run a one-off script that:
1. For each orphan `document_id`, calls `webuiService.deleteDocument()`.
2. Records the cleanup in a `cleanup_orphans` log table.

Don't delete the documents directly via SQL — the deletion should go
through the application layer to clean up chunks and entities.

### "Race conditions / duplicate ingests"

The watcher is designed to handle concurrent events safely via the
manifest CAS lock. But there are some edge cases:

- **Two sync runs overlap**: blocked by the per-folder
  `activeSyncs` map in the API. The API returns 409 if you try to
  trigger a sync while one is running.
- **Chokidar fires `change` for the same file twice in <1 s**:
  debounced into one sync run. The orchestrator's
  `transitionManifestStatus(... 'syncing')` ensures only one
  worker ingests a file at a time. If two sync runs DO end up
  ingesting the same file concurrently, the second will lose the
  CAS and skip — the manifest keeps the first document id.

If you see duplicate documents (same content, same folder, same
rel_path, different document_ids), something is broken. Report it
with the sync_runs rows for that folder — the trigger field will
show whether it's an event vs manual race.

### "Files are being skipped"

The manifest row shows `synced` but `lastError` starts with `skipped:`:

| `lastError` value                       | Cause                                                  | Fix                                                                  |
|-----------------------------------------|--------------------------------------------------------|----------------------------------------------------------------------|
| `skipped: extension not supported`      | File extension isn't in the whitelist or supported list. | Add it to the whitelist or use the default set (no whitelist).      |
| `skipped: extension .X is blacklisted`  | Extension is in the blacklist.                         | Remove it from the blacklist, or whitelist it (blacklist always wins). |
| `skipped: exceeds maxBytes`             | File is larger than `filetypeFilter.maxBytes`.         | Increase the cap or split the file.                                  |

The blacklist ALWAYS wins, even if you also whitelist the same extension.
This is intentional — it's a safety override for files you never want.

### "Watcher crashed at startup"

If `bootWatchedFolders()` throws (e.g. production gate violation), the
HTTP server still starts (so `/api/health` works), but the watcher
doesn't attach. Look in the logs for the error message:

```
watcher: refusing to start in production without ALLOW_PROD_WATCHER=true
```

or

```
watcher: failed to start watchers at startup
  error: <whatever the underlying error was>
```

The HTTP API endpoints (POST /api/watched-folders, etc.) also call
`watcherManager.startOne` which has the same gate. So creating a
folder in production without `ALLOW_PROD_WATCHER=true` will create
the DB row but NOT start the watcher. The folder will be in
"Stopped" state until you fix the env and restart.

### "Syncs are slow"

Sync duration is dominated by the embedding API. To diagnose:

1. Check `sync_runs.finished_at - sync_runs.started_at` for recent runs.
2. Compare to `count(*) from file_manifest where folder_id = ?` (files in
   the folder).
3. Per-file cost should be ~100-500 ms (most of which is the embedding
   API).

If per-file cost is > 1 second:
- Check the embedding provider's latency (e.g. open their dashboard).
- Reduce `INGEST_CONCURRENCY` if you suspect rate limiting.
- Set `metadata.skipExtraction: true` on the folder to skip LLM calls
  (huge speedup if you don't need event extraction).
- Run a network test from the SAG host to the embedding endpoint.

For a one-time big ingest, the simplest fix is to set
`metadata.skipExtraction: true`, let the folder ingest, then unset it
for incremental updates.

---

## Debugging tools

### Database queries

```sql
-- Show all watched folders for a tenant
select id, path, enabled, recursive, last_scan_at, last_error
from watched_folders
where tenant_id = 'default'
order by created_at;

-- Show pending / syncing files (queue depth)
select count(*), folder_id, status
from file_manifest
where status in ('pending', 'syncing')
group by folder_id, status;

-- Show recent sync runs with stats
select id, started_at, finished_at, status, trigger,
       files_added, files_updated, files_deleted, files_failed,
       error_message
from sync_runs
where folder_id = '<folder-uuid>'
order by started_at desc
limit 20;

-- Show failed manifest entries (with error messages)
select rel_path, last_error, last_synced_at
from file_manifest
where folder_id = '<folder-uuid>'
  and status = 'failed'
order by updated_at desc;
```

### Log filters

```bash
# All errors for a specific folder
grep '"folderId":"<folder-uuid>"' sag.log | grep '"level":50'

# Sync lifecycle for a folder
grep '"folderId":"<folder-uuid>"' sag.log | grep -E 'sync (started|finished|failed)|file ingested|file removed|chokidar error'

# Production gate violations (should never happen if ALLOW_PROD_WATCHER is set)
grep 'refusing to start in production' sag.log
```

### Manual sync trigger (bypasses chokidar)

Useful when chokidar events aren't firing but you want to test the
pipeline:

```bash
curl -X POST "http://localhost:4173/api/watched-folders/<folder-uuid>/sync"
```

This calls `syncFolder` directly. If a manual sync works but chokidar
events don't, the issue is in chokidar (not the pipeline).

### Manual cleanup

If the manifest is in a weird state:

```sql
-- Mark all pending/syncing as failed (forces retry on next sync)
update file_manifest
set status = 'pending', last_error = 'manually reset'
where folder_id = '<folder-uuid>'
  and status in ('syncing');

-- Or: hard-delete a folder and start over
delete from watched_folders where id = '<folder-uuid>';
-- (cascades to file_manifest + sync_runs; you may also need to delete the source's documents manually)
```

---

## Common root causes

### "It worked yesterday, what changed?"

- **Disk full**: the watcher tries to write to `.tmp/watcher/` for
  binary conversion. If `/var` is full, every sync fails for binary
  files.
- **Postgres connection pool exhausted**: if many things are hitting
  the DB, the watcher can wait for a connection. Increase `max` in
  `src/db/pool.ts` (default 20).
- **Embedding API outage**: transient failures here look like "ingest
  failed" in the logs. The watcher retries `LLM_MAX_RETRIES` times.
- **NFS / SMB mount went away**: if the watched folder is on a network
  mount and the mount drops, every sync fails with `ENOENT`.

### "It works for some files but not others"

- **Filter mismatch**: the file's extension isn't whitelisted. Check
  the manifest for the `skipped:` reason.
- **Size cap**: the file is over `maxBytes`.
- **Encoding**: the converter expects UTF-8 (or text-ish for .txt). A
  weird encoding might cause parse errors.
- **Symlink**: symlinks are skipped by design.

### "It worked locally but not in production"

- **`ALLOW_PROD_WATCHER` not set**.
- **Filesystem permissions**: the production process runs as a different
  user. The folder must be readable by the SAG user.
- **Different DB**: production DB might be a read replica, missing
  writes. Make sure the watcher points at the primary.

---

## Getting help

If you're stuck:

1. Gather the diagnostic info:
   - Folder id (from the URL of the details page)
   - Last 50 lines of sag.log mentioning that folder id
   - Output of the database queries above
   - What `NODE_ENV` and `ALLOW_PROD_WATCHER` are set to

2. Try to reproduce: does the same issue happen with a fresh folder on a
   simple test path (e.g. `/tmp/test-watch`)?

3. File an issue with the above info.

For a quick self-check, run the integration test against your setup:

```bash
npx vitest run src/watcher/__tests__/e2e.test.ts
```

All 6 tests should pass in ~7 seconds. If they don't, your environment
has an issue (no Postgres, no Python, etc.).