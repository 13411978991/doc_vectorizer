-- 010_manifest_last_error.down.sql — reverse of 010_manifest_last_error.sql.
--
-- The up migration added a `last_error` text column to
-- `watched_folder_manifests` so the API could surface per-file
-- ingest error messages. This down script removes the column and
-- the corresponding row from `schema_migrations` so the up
-- migration can be re-applied cleanly.
--
-- IMPORTANT: this is a DESTRUCTIVE script. It drops the
-- `last_error` column and any error data it holds. Only run it on
-- a fresh install (no customer data in the column) or with
-- explicit operator approval. For a live database with non-empty
-- `last_error` values, prefer writing a new up migration that
-- supersedes the column rather than dropping it.
--
-- Requires SQLite 3.35.0+ (released 2021-03-12) for
-- `ALTER TABLE ... DROP COLUMN`. All current LTS Linux distros
-- (Ubuntu 22.04, Debian 12) and Windows builds of better-sqlite3
-- ship 3.40+. If the operator's environment predates 3.35, use
-- the 12-step table-rebuild recipe documented at
-- https://www.sqlite.org/lang_altertable.html#otheralter (not
-- shown here; we want this script readable).

begin transaction;

-- 1. Drop the column. SQLite 3.35+ supports DROP COLUMN for
--    columns that are not referenced by indexes, foreign keys,
--    generated columns, or CHECK constraints. `last_error` is
--    none of those, so this is a clean drop.
alter table watched_folder_manifests drop column last_error;

-- 2. Remove the schema_migrations row so a re-apply of the up
--    migration runs cleanly. MUST be the last statement so a
--    crash before this point leaves the schema_migrations row
--    in place (and the operator can retry from step 1).
delete from schema_migrations where name = '010_manifest_last_error.sql';

commit;
