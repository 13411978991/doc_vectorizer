-- Sprint N+: the watched-folder manifest page returns a single
-- `select * from watched_folder_manifests where folder_id = ?`
-- rowset to the UI, which the previous schema indexed only by primary
-- key `(folder_id, rel_path)`. With folders containing thousands of
-- files (e.g. site_map scanning an unpacked numpy distribution) the
-- initial load was slow and the cursor-based pagination we just added
-- can't reuse the PK as a sort key.
--
-- This migration adds two covering indexes that match the new query
-- shape:
--
--   1. (folder_id, last_seen_at desc, rel_path desc) — supports the
--      default "most-recently-seen first" listing AND the cursor
--      predicate `(last_seen_at, rel_path) < (?, ?)`.
--   2. (folder_id, last_event, last_seen_at desc, rel_path desc) —
--      supports the `status` filter ("pending/syncing/synced/failed/
--      deleted") which is the common UI filter chip.
--
-- Both are non-unique; the existing primary key still guarantees
-- uniqueness on `(folder_id, rel_path)`.

create index if not exists watched_folder_manifests_seen_idx
  on watched_folder_manifests(folder_id, last_seen_at desc, rel_path desc);

create index if not exists watched_folder_manifests_status_seen_idx
  on watched_folder_manifests(folder_id, last_event, last_seen_at desc, rel_path desc);