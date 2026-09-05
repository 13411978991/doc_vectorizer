-- 011_manifest_sync_duration.sql — persist per-file sync timing on manifest.
--
-- Goal: when a single file takes 30s to vectorize, the user has no way to see
-- that from the watched-folder UI today — only the overall `sync_run` row has
-- a duration. Adding per-file `last_sync_started_at` + `last_sync_duration_ms`
-- makes the manifest table the natural place to surface "this .pptx file took
-- 18s while this .docx took 1s" so the user can spot which file types are slow.
--
-- The columns are nullable: rows that haven't been ingested since this
-- migration deployed simply read null and the UI shows "—". No backfill —
-- historical data doesn't have timing, and backfilling would be misleading.

alter table watched_folder_manifests add column last_sync_started_at text;
alter table watched_folder_manifests add column last_sync_duration_ms integer;