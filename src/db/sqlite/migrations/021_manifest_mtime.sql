-- 021_manifest_mtime.sql — persist per-file mtime (ms since epoch) on the
-- watched-folder manifest.
--
-- Why: the SQLite manifest never stored mtime, so every startup scan had to
-- SHA-1-read EVERY whitelisted file to detect changes (the PG schema had
-- mtime_ms but the column was never migrated to SQLite). On a whole-drive
-- watch (E:\ ≈ 7k Office files after the extension whitelist) that meant
-- re-reading tens of GB per boot — 30-40+ minutes per scan, the event loop
-- starved, /health timed out, and the UI looked permanently "扫描文件系统"
-- (2026-10-28). With mtime_ms persisted, scanFolder compares size+mtime
-- first and only hashes files whose metadata changed; unchanged files cost
-- one stat() each.
--
-- Nullable: rows written before this migration read null and get hashed one
-- last time on the first scan after upgrade, which also backfills the column.

alter table watched_folder_manifests add column mtime_ms integer;
