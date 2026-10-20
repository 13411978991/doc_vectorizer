-- 010_manifest_last_error.sql — persist per-file ingest error on manifest.
--
-- The previous SQLite schema only stored `last_event` (one of pending/
-- syncing/synced/failed/deleted) on `watched_folder_manifests`. When a
-- file failed to ingest, the error message was written into the
-- in-memory UpsertManifestInput but the SQLite column was missing, so
-- the API had no way to surface "why did this file fail" to the UI.
--
-- Add a nullable `last_error` column. The `upsertManifest` and
-- `transitionManifestStatus` writers now also persist the value, and
-- the manifest API returns it so the detail page can show a tooltip.

alter table watched_folder_manifests add column last_error text;