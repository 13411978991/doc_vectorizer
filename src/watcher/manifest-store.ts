import path from "node:path";
import { pool } from "../db/pool.js";
import { parseSqliteTimestamp, toLocalISO } from "../db/row-helpers.js";
import { createSource, getSource } from "../db/repositories.js";
import { logger } from "../observability/logger.js";
import type { FiletypeFilter, FileManifestRecord, ManifestStatus, SyncRunRecord, SyncRunStatus, SyncRunTrigger, WatchedFolderRecord } from "./types.js";

function parseJsonArray<T>(value: unknown): T[] | undefined {
  if (value == null) return undefined;
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : undefined;
  } catch {
    return undefined;
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Map the in-memory `FiletypeFilter` (whitelist/blacklist/maxBytes) to/from
 * the SQLite-native columns `file_extensions_filter` + `ignore_patterns` +
 * `metadata.maxBytes`. The in-memory shape is preserved so callers and
 * tests do not need to change.
 */
function folderFiletypeFilterFromRow(row: Record<string, unknown>): FiletypeFilter {
  const fileExtensions = parseJsonArray<string>(row.file_extensions_filter);
  const ignorePatterns = parseJsonArray<string>(row.ignore_patterns);
  const metadata = parseJsonObject(row.metadata) ?? {};
  const maxBytesRaw = (row as Record<string, unknown>).max_bytes ?? metadata.maxBytes;
  const out: FiletypeFilter = {};
  if (fileExtensions && fileExtensions.length > 0) out.whitelist = fileExtensions;
  if (ignorePatterns && ignorePatterns.length > 0) out.blacklist = ignorePatterns;
  if (typeof maxBytesRaw === "number" && Number.isFinite(maxBytesRaw)) {
    out.maxBytes = Math.trunc(maxBytesRaw);
  }
  return out;
}

function folderFromRow(row: Record<string, unknown>): WatchedFolderRecord {
  const metadata = (parseJsonObject(row.metadata) ?? {}) as Record<string, unknown>;
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    path: String(row.path),
    displayName: String(row.display_name),
    sourceId: String(row.source_id),
    enabled: Boolean(row.enabled),
    recursive: Boolean(row.recursive),
    filetypeFilter: folderFiletypeFilterFromRow(row),
    metadata,
    lastScanAt: row.last_scan_at == null ? null : toLocalISO(parseSqliteTimestamp(String(row.last_scan_at))),
    lastError:
      row.last_scan_error == null
        ? row.last_error == null
          ? null
          : String(row.last_error)
        : String(row.last_scan_error),
    createdAt: row.created_at == null ? undefined : toLocalISO(parseSqliteTimestamp(String(row.created_at))),
    updatedAt: row.updated_at == null ? undefined : toLocalISO(parseSqliteTimestamp(String(row.updated_at)))
  };
}

function parseManifestEvent(row: Record<string, unknown>): ManifestStatus {
  const evt = row.last_event;
  if (typeof evt !== "string") return "pending";
  const allowed: ManifestStatus[] = ["pending", "syncing", "synced", "partial", "failed", "deleted"];
  return (allowed as string[]).includes(evt) ? (evt as ManifestStatus) : "pending";
}

function manifestFromRow(row: Record<string, unknown>): FileManifestRecord {
  // SQLite schema (watched_folder_manifests) is intentionally simple:
  // folder_id + rel_path (composite PK), document_id, last_seen_at,
  // last_event, size, hash, last_error, last_sync_started_at,
  // last_sync_duration_ms. Fields the PG schema had (mtimeMs, inode,
  // status, lastSyncedAt, lastError, createdAt, updatedAt) are derived
  // or null in the in-memory shape so callers don't have to change.
  const lastSeen = row.last_seen_at;
  const lastSeenIso = lastSeen == null ? null : toLocalISO(parseSqliteTimestamp(String(lastSeen)));
  // last_sync_started_at is a SQLite TIMESTAMP (no timezone). Coerce
  // to ISO on the way out so the UI gets a stable string shape.
  // `last_sync_duration_ms` is wall-clock duration and is independent
  // of the timestamp.
  const lastSyncStartedRaw = row.last_sync_started_at;
  const lastSyncStartedIso =
    lastSyncStartedRaw == null ? null : toLocalISO(parseSqliteTimestamp(String(lastSyncStartedRaw)));
  const lastSyncDurationRaw = row.last_sync_duration_ms;
  const lastSyncDurationMs =
    lastSyncDurationRaw == null || lastSyncDurationRaw === ""
      ? null
      : Number(lastSyncDurationRaw);
  return {
    id: `${row.folder_id}::${row.rel_path}`,
    folderId: String(row.folder_id),
    relPath: String(row.rel_path),
    mtimeMs: null,
    inode: null,
    sizeBytes: row.size == null ? null : Number(row.size),
    sha1: row.hash == null ? null : String(row.hash),
    status: parseManifestEvent(row),
    documentId: row.document_id == null ? null : String(row.document_id),
    lastSyncedAt: lastSeenIso,
    lastError: row.last_error == null ? null : String(row.last_error),
    lastSyncStartedAt: lastSyncStartedIso,
    lastSyncDurationMs: lastSyncDurationMs == null ? null : lastSyncDurationMs,
    createdAt: lastSeenIso ?? undefined,
    updatedAt: lastSeenIso ?? undefined
  };
}

function syncRunFromRow(row: Record<string, unknown>): SyncRunRecord {
  // SQLite schema (watched_folder_runs) has columns id, folder_id,
  // tenant_id, trigger, status, started_at, completed_at, stats_added,
  // stats_updated, stats_deleted, stats_failed, error. Maps to the
  // SyncRunRecord shape; metadata is empty since the new schema omits it.
  return {
    id: String(row.id),
    folderId: String(row.folder_id),
    startedAt: row.started_at == null ? toLocalISO() : toLocalISO(parseSqliteTimestamp(String(row.started_at))),
    finishedAt: row.completed_at == null ? null : toLocalISO(parseSqliteTimestamp(String(row.completed_at))),
    status: String(row.status) as SyncRunStatus,
    trigger: String(row.trigger) as SyncRunTrigger,
    filesAdded: Number(row.stats_added ?? 0),
    filesUpdated: Number(row.stats_updated ?? 0),
    filesDeleted: Number(row.stats_deleted ?? 0),
    filesFailed: Number(row.stats_failed ?? 0),
    errorMessage: row.error == null ? null : String(row.error),
    metadata: {}
  };
}

// ─── Folders ─────────────────────────────────────────────────────────────────

export async function listFolders(tenantId: string): Promise<WatchedFolderRecord[]> {
  const result = await pool.query(
    "select * from watched_folders where tenant_id = $1 order by created_at, id",
    [tenantId]
  );
  return result.rows.map(folderFromRow);
}

export async function getFolder(folderId: string, tenantId: string): Promise<WatchedFolderRecord | null> {
  const result = await pool.query(
    "select * from watched_folders where id = $1 and tenant_id = $2",
    [folderId, tenantId]
  );
  return result.rows[0] ? folderFromRow(result.rows[0]) : null;
}

export async function getFolderByPath(path: string, tenantId: string): Promise<WatchedFolderRecord | null> {
  const result = await pool.query(
    "select * from watched_folders where path = $1 and tenant_id = $2",
    [path, tenantId]
  );
  return result.rows[0] ? folderFromRow(result.rows[0]) : null;
}

export interface CreateFolderInput {
  tenantId: string;
  path: string;
  displayName?: string;
  enabled?: boolean;
  recursive?: boolean;
  filetypeFilter?: FiletypeFilter;
  metadata?: Record<string, unknown>;
  /** If provided, the watched folder is bound to this existing project (source)
   *  instead of auto-creating a new one. Use this to "mount" a folder under an
   *  existing project in the Web UI. */
  sourceId?: string;
}

/**
 * Create a folder record and the associated Source.
 *
 * The Source auto-creation matches the design: every watched folder gets a
 * dedicated Source so its documents live in their own project.
 */
export async function createFolder(input: CreateFolderInput): Promise<WatchedFolderRecord> {
  const folderName = basename(input.path);
  const displayName = input.displayName?.trim() || folderName;
  const callerMetadata = (input.metadata ?? {}) as Record<string, unknown>;
  const filetypeFilter = input.filetypeFilter ?? {};
  // SQLite-native columns: file_extensions_filter + ignore_patterns +
  // metadata.maxBytes. We also embed maxBytes into the JSON metadata column
  // so round-trip reads back the same FiletypeFilter shape.
  const fileExtensionsFilter = JSON.stringify(filetypeFilter.whitelist ?? []);
  const ignorePatterns = JSON.stringify(filetypeFilter.blacklist ?? []);
  const metadata: Record<string, unknown> = { ...callerMetadata };
  if (typeof filetypeFilter.maxBytes === "number") {
    metadata.maxBytes = filetypeFilter.maxBytes;
  }
  const metadataJson = JSON.stringify(metadata);

  // When the caller provides a sourceId, bind the folder to that existing
  // project. Otherwise auto-create a new Source (the legacy default).
  let sourceId: string;
  if (input.sourceId) {
    // Validate the source exists and belongs to the same tenant.
    const existing = await getSource(input.sourceId, input.tenantId);
    if (!existing) {
      throw new Error(
        `sourceId=${input.sourceId} not found in tenant '${input.tenantId}'`
      );
    }
    sourceId = existing.id;
    // Update the source metadata to reflect this watched folder.
    const existingMeta = (existing.metadata ?? {}) as Record<string, unknown>;
    existingMeta.watchedFolderPath = input.path;
    existingMeta.semanticType = "watched_folder";
    await pool.query(
      "update sources set metadata = $1, updated_at = datetime('now') where id = $2",
      [JSON.stringify(existingMeta), sourceId]
    );
  } else {
    // Create the Source first so we can attach its id to the folder row.
    // Name it after the folder's display name (user-provided or path basename)
    // so the "auto data sources" rail shows a recognizable label.
    const source = await createSource({
      tenantId: input.tenantId,
      name: displayName,
      description: "Auto-created from watched folder",
      metadata: {
        createdVia: "watcher",
        semanticType: "watched_folder",
        watchedFolderPath: input.path
      }
    });
    sourceId = source.id;
  }

  try {
    const result = await pool.query(
      `
        insert into watched_folders (
          tenant_id, path, display_name, source_id, enabled, recursive,
          file_extensions_filter, ignore_patterns, metadata
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, json_set($9, '$.formerSourceId', $4))
        returning *
      `,
      [
        input.tenantId,
        input.path,
        displayName,
        sourceId,
        input.enabled ?? true,
        input.recursive ?? true,
        fileExtensionsFilter,
        ignorePatterns,
        metadataJson
      ]
    );
    return folderFromRow(result.rows[0]);
  } catch (error) {
    // If the folder row insert fails and we auto-created a new Source,
    // drop the orphan so we don't leak. When sourceId was provided by
    // the caller, we must NOT delete the existing project.
    if (!input.sourceId) {
      try {
        await pool.query("delete from sources where id = $1", [sourceId]);
      } catch (cleanupError) {
        logger.warn(
          { sourceId, error: (cleanupError as Error).message },
          "watcher: failed to clean up orphan source after folder create failure"
        );
      }
    }
    throw error;
  }
}

/**
 * Attach one or more existing watched folders to a project. This only rewrites
 * `watched_folders.source_id` to point at the target project — it does NOT
 * migrate documents/chunks/events/entities, those stay on the original
 * source. The project_stats / search endpoints already aggregate via
 * the join in repositories.ts (watched_folders → source_id → documents).
 *
 * Returns the number of folders that were actually re-bound (folders that
 * already belong to the target project are skipped).
 */
export async function attachFoldersToProject(input: {
  projectId: string;
  folderIds: string[];
  tenantId: string;
}): Promise<{ attached: number }> {
  if (input.folderIds.length === 0) {
    return { attached: 0 };
  }

  // Verify the target project exists in the same tenant.
  const projCheck = await pool.query(
    "select id from sources where id = $1 and tenant_id = $2",
    [input.projectId, input.tenantId]
  );
  if (projCheck.rowCount === 0) {
    throw new Error(`project ${input.projectId} not found in tenant '${input.tenantId}'`);
  }

  // Stamp the project binding onto each folder's metadata only. We deliberately
  // do NOT rewrite watched_folders.source_id — the folder's auto-source stays
  // the authoritative owner of its documents/chunks/events/entities, so the
  // auto-source's overview never empties out when the folder is mounted into
  // a project. Project-level queries expand across attached folders via
  // metadata.attachedProjectId (see repositories.ts).
  const result = await pool.query(
    `
      update watched_folders
         set updated_at = now(),
             metadata = json_set(
               coalesce(metadata, '{}'),
               '$.attachedProjectId',
               $1
             )
       where id in (
         select value from json_each($2)
       )
         and tenant_id = $3
    `,
    [input.projectId, JSON.stringify(input.folderIds), input.tenantId]
  );

  // Attach is a metadata-only operation: the folder's auto-source keeps its
  // documents, and the project expands across attached folders via
  // metadata.attachedProjectId. No data is rewritten, so the auto-source's
  // overview stays intact.

  return { attached: result.rowCount ?? 0 };
}

/**
 * Reverse of attachFoldersToProject: rebind the listed folders back to
 * their original sources (recorded at attach time in `metadata.formerSourceId`)
 * so they stop being aggregated under the target project.
 *
 * Mirrors attach semantics:
 *   - Folders whose source_id is not currently the target project are skipped.
 *   - The former source id must be a real source row in the same tenant
 *     (otherwise we leave the folder bound to the project rather than orphan
 *     its documents).
 *
 * Returns the number of folders that were actually detached.
 */
/**
 * Reverse of attachFoldersToProject: clear `metadata.attachedProjectId` on
 * each folder so it stops being aggregated under the target project. The
 * folder's auto-source and its documents are left untouched, so the
 * auto-source's overview stays intact.
 */
export async function detachFoldersFromProject(input: {
  projectId: string;
  folderIds: string[];
  tenantId: string;
}): Promise<{ detached: number }> {
  if (input.folderIds.length === 0) {
    return { detached: 0 };
  }

  // Verify target project exists in the tenant.
  const projCheck = await pool.query(
    "select id from sources where id = $1 and tenant_id = $2",
    [input.projectId, input.tenantId]
  );
  if (projCheck.rowCount === 0) {
    throw new Error(`project ${input.projectId} not found in tenant '${input.tenantId}'`);
  }

  // Clear metadata.attachedProjectId on each folder. We only touch folders
  // currently bound to this project.
  const result = await pool.query(
    `
      update watched_folders
         set updated_at = now(),
             metadata = json_remove(
               coalesce(metadata, '{}'),
               '$.attachedProjectId'
             )
       where id in (
         select value from json_each($1)
       )
          and tenant_id = $2
          and json_extract(metadata, '$.attachedProjectId') = $3
    `,
    [
      JSON.stringify(input.folderIds),
      input.tenantId,
      input.projectId
    ]
  );

  return { detached: result.rowCount ?? 0 };
}

export async function updateFolder(
  folderId: string,
  input: {
    displayName?: string;
    enabled?: boolean;
    recursive?: boolean;
    filetypeFilter?: FiletypeFilter;
    metadata?: Record<string, unknown>;
  }
): Promise<WatchedFolderRecord | null> {
  // When filetypeFilter is provided, map its three sub-fields onto the SQLite
  // columns. When metadata is provided, deep-merge (last-wins) so we don't
  // clobber maxBytes stored from a previous filetypeFilter update. SQLite has
  // no JSON || operator, so we read-modify-write when either is being updated.
  const newFileExtensions =
    input.filetypeFilter !== undefined
      ? JSON.stringify(input.filetypeFilter.whitelist ?? [])
      : null;
  const newIgnorePatterns =
    input.filetypeFilter !== undefined
      ? JSON.stringify(input.filetypeFilter.blacklist ?? [])
      : null;
  const newMaxBytes =
    input.filetypeFilter !== undefined && typeof input.filetypeFilter.maxBytes === "number"
      ? input.filetypeFilter.maxBytes
      : null;
  const hasFilterUpdate = input.filetypeFilter !== undefined;
  const hasMetadataUpdate = input.metadata !== undefined;

  let mergedMetadata: Record<string, unknown> | undefined;
  if (hasMetadataUpdate || hasFilterUpdate) {
    // Read existing metadata so we can deep-merge (SQLite has no JSON ||  op).
    const raw = await pool.query(
      "select metadata from watched_folders where id = $1",
      [folderId]
    );
    const baseMeta =
      raw.rows[0] && parseJsonObject(raw.rows[0].metadata)
        ? (parseJsonObject(raw.rows[0].metadata) as Record<string, unknown>)
        : {};
    mergedMetadata = { ...baseMeta, ...(input.metadata ?? {}) };
    if (newMaxBytes !== null) {
      mergedMetadata.maxBytes = newMaxBytes;
    } else if (
      hasFilterUpdate &&
      input.filetypeFilter &&
      input.filetypeFilter.maxBytes == null &&
      "maxBytes" in mergedMetadata
    ) {
      // Explicitly clearing maxBytes when filter is provided without one.
      delete mergedMetadata.maxBytes;
    }
  }

  const result = await pool.query(
    `
      update watched_folders
      set
        display_name = coalesce($2, display_name),
        enabled = coalesce($3, enabled),
        recursive = coalesce($4, recursive),
        file_extensions_filter = case
          when $5::boolean then $6 else file_extensions_filter
        end,
        ignore_patterns = case
          when $5::boolean then $7 else ignore_patterns
        end,
        metadata = case
          when $8::boolean then $9
          when $5::boolean then $10
          else metadata
        end,
        updated_at = now()
      where id = $1
      returning *
    `,
    [
      folderId,
      input.displayName?.trim() ?? null,
      input.enabled ?? null,
      input.recursive ?? null,
      hasFilterUpdate,
      newFileExtensions,
      newIgnorePatterns,
      hasMetadataUpdate,
      hasMetadataUpdate ? JSON.stringify(mergedMetadata ?? input.metadata ?? {}) : null,
      hasFilterUpdate ? JSON.stringify(mergedMetadata ?? {}) : null
    ]
  );
  return result.rows[0] ? folderFromRow(result.rows[0]) : null;
}

export async function deleteFolder(folderId: string, tenantId: string): Promise<boolean> {
  // Cascade in the schema handles manifest + sync_runs; we also drop the
  // Source. The Source's documents / chunks / events / entities /
  // chunk_embeddings live under that Source's id (the folder's home
  // source, recorded as `metadata.formerSourceId` at folder-create time)
  // and aren't FK-cascaded, so we have to clean them up manually — same
  // semantic as `DELETE FROM sources WHERE id = ...` doing it for the
  // user.
  const folderResult = await pool.query(
    "delete from watched_folders where id = $1 and tenant_id = $2 returning source_id, json_extract(metadata, '$.formerSourceId') as former",
    [folderId, tenantId]
  );
  if (folderResult.rowCount === 0) {
    return false;
  }
  const row = folderResult.rows[0];
  // Both current source_id AND former source id could own docs:
  //   - currentSource is the project the folder is currently attached to
  //     (we've kept docs under that source historically; if a doc was
  //     bound this way we want it gone too)
  //   - formerSource is the folder's home source, where docs usually live
  // Any other source touched by this folder is reachable through the
  // watched_folder_manifests join. Either way, deleting by id is cheap
  // and the FK constraints handle the per-document cascade (chunks,
  // events, entities, chunk_embeddings all reference document_id).
  const sourcesToClean = new Set<string>();
  if (row.source_id) sourcesToClean.add(row.source_id);
  if (row.former) sourcesToClean.add(row.former);

  // Belt-and-braces: even after migration 014 adds the events FK back,
  // some legacy installations may still have events without FK. Wipe
  // events + entities explicitly so the deletion is guaranteed to
  // reclaim all related rows. event_entities cascades on both events
  // and entities via its FK; we don't need to touch it here.
  if (sourcesToClean.size > 0) {
    const sourceIds = [...sourcesToClean];
    const placeholders = sourceIds.map((_, i) => `$${i + 1}`).join(",");
    await pool.query(
      `delete from event_entities where event_id in (select id from events where source_id in (${placeholders}))`,
      sourceIds
    );
    await pool.query(
      `delete from events where source_id in (${placeholders})`,
      sourceIds
    );
    await pool.query(
      `delete from entities where source_id in (${placeholders})`,
      sourceIds
    );
  }

  // Collect doc ids for cleanup + reporting.
  const docResult = await pool.query<{ id: string }>(
    `select id from documents where source_id in (${[...sourcesToClean].map((_, i) => `$${i + 1}`).join(",") || "''"})`,
    [...sourcesToClean]
  );
  const docIds = docResult.rows.map((r) => r.id);

  if (docIds.length > 0) {
    // chunks/events/entities/chunk_embeddings all have FK
    // on delete cascade on document_id. vector rows are owned by chunks
    // and cleaned by their own cascade. documents.source_id is the
    // only row left to clean up explicitly.
    await pool.query(
      `delete from documents where id in (${docIds.map((_, i) => `$${i + 1}`).join(",")})`,
      docIds
    );
  }

  // Now the source rows themselves are safe to drop — nothing points at
  // them anymore.
  for (const src of sourcesToClean) {
    try {
      await pool.query("delete from sources where id = $1 and tenant_id = $2", [src, tenantId]);
    } catch (error) {
      logger.warn(
        { folderId, sourceId: src, error: (error as Error).message },
        "watcher: failed to delete source after folder delete"
      );
    }
  }
  logger.info(
    { folderId, cleanedSources: [...sourcesToClean], deletedDocuments: docIds.length },
    "watcher: deleted folder + documents + sources"
  );
  return true;
}

export async function markFolderScanned(folderId: string, error?: string | null): Promise<void> {
  await pool.query(
    `
      update watched_folders
      set
        last_scan_at = now(),
        last_scan_status = case when $2 is null then 'ok' else 'error' end,
        last_scan_error = $2,
        updated_at = now()
      where id = $1
    `,
    [folderId, error ?? null]
  );
}

// ─── Manifest ────────────────────────────────────────────────────────────────

export interface GetManifestOptions {
  // Filter by manifest status (e.g. "synced", "failed"). The DB column
  // is `last_event` (text), not `status`. Omit to return all rows.
  status?: ManifestStatus;
  // Default 50; capped at 500 to avoid accidental full-table loads.
  limit?: number;
  // Opaque token from a previous response's `nextCursor`. Pass
  // `undefined` for the first page.
  cursor?: string;
  // Numeric offset for "jump to page N" controls. When both `cursor`
  // and `offset` are set, `cursor` wins (it's the forward-only path).
  // `offset` is honoured only on the first page of a chain.
  offset?: number;
  // Sort order. "recent" (default) returns rows ordered by
  // (last_seen_at desc, rel_path desc); "path" uses alphabetic
  // (rel_path asc). Each sort key has a covering index, see
  // migration 009.
  sort?: "recent" | "path";
  // Whether to compute and return the `total` field (count of all
  // matching rows). Default true. Set false on subsequent pages
  // when the UI already knows the total from page 1, shaving one
  // COUNT(*) query per page.
  includeTotal?: boolean;
  // Whether to include rows whose file is no longer on disk
  // (last_event='deleted'). These are soft-delete tombstones — the
  // document row has already been removed from `chunks`/`events`/
  // `documents`, so showing them in the UI just confuses users.
  // Default false. Pass true if you actually want to see the
  // tombstones (e.g. for an audit/recovery view).
  includeDeleted?: boolean;
}

export interface ManifestPage {
  manifest: FileManifestRecord[];
  nextCursor: string | null;
  total: number;
}

// Legacy signature: returns the full manifest as a flat array. Used
// by sync-orchestrator internals that walk the whole table.
export async function getManifest(
  folderId: string,
  status?: ManifestStatus
): Promise<FileManifestRecord[]> {
  const result = await pool.query(
    "select * from watched_folder_manifests where folder_id = $1 order by rel_path",
    [folderId]
  );
  const rows = result.rows.map(manifestFromRow);
  return status ? rows.filter((r) => r.status === status) : rows;
}

// New paginated signature. The route layer calls this; consumers
// (UI, API clients) see a ManifestPage with `manifest`, `nextCursor`
// and `total` so they can render "showing 50 of 1247" widgets.
export async function getManifestPage(
  folderId: string,
  options: GetManifestOptions = {}
): Promise<ManifestPage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
  const sort = options.sort ?? "recent";
  const includeTotal = options.includeTotal !== false;
  // Hide soft-delete tombstones by default — they're stale UI noise.
  const includeDeleted = options.includeDeleted === true;
  // Decode the cursor (if any). For "recent" sort, the cursor key is
  // (last_seen_at, rel_path); for "path" sort, it's just rel_path.
  const decoded = options.cursor ? decodeManifestCursor(options.cursor) : null;
  const params: unknown[] = [folderId];
  let cursorSql = "";
  if (decoded) {
    if (sort === "recent" && decoded.lastSeenAt) {
      params.push(decoded.lastSeenAt, decoded.relPath);
      // (last_seen_at, rel_path) < (cursor.lastSeenAt, cursor.relPath)
      // in lex order. last_seen_at is the leading key.
      cursorSql = "and (last_seen_at, rel_path) < ($2, $3)";
    } else if (sort === "path") {
      params.push(decoded.relPath);
      cursorSql = "and rel_path > $2";
    }
  }
  let statusSql = "";
  if (options.status) {
    params.push(options.status);
    statusSql = `and last_event = $${params.length}`;
  } else if (!includeDeleted) {
    // Hide the soft-delete tombstones so the UI doesn't show ghost
    // rows for files the user already removed. The `failed` filter
    // above goes through the explicit status branch so callers
    // asking for failed still see their deletes — but in practice
    // deletes aren't `last_event='failed'` so this is moot.
    statusSql = "and last_event <> 'deleted'";
  }
  const orderBy =
    sort === "path"
      ? "order by rel_path asc"
      : "order by last_seen_at desc, rel_path desc";
  // Cursor mode → no offset (offset is baked into cursor's encoded
  // position for "previous" hops). Otherwise honour the explicit
  // offset param (used by "jump to page N" UI controls).
  const offset = decoded ? 0 : Math.max(0, options.offset ?? 0);
  params.push(limit, offset);
  const limitPlaceholder = `$${params.length - 1}`;
  const offsetPlaceholder = `$${params.length}`;
  const sql = `
    select * from watched_folder_manifests
    where folder_id = $1 ${statusSql} ${cursorSql}
    ${orderBy}
    limit ${limitPlaceholder} offset ${offsetPlaceholder}
  `;
  const result = await pool.query(sql, params);
  const rows = result.rows.map(manifestFromRow);
  // nextCursor: emit one only when we returned a full page AND the
  // page wasn't filtered by status (because the cursor key may not
  // be unique across status values). For simplicity we always emit
  // it on full pages — clients just stop when they see an empty
  // page. Use the *raw* DB row's last_seen_at (the literal SQLite
  // TEXT) so the next page's WHERE clause compares apples to apples.
  let nextCursor: string | null = null;
  if (rows.length === limit && rows.length > 0) {
    const lastRaw = result.rows[rows.length - 1];
    nextCursor = encodeManifestCursor({
      lastSeenAt: String(lastRaw.last_seen_at),
      relPath: String(lastRaw.rel_path)
    });
  }
  // Total count (best-effort; cheap because folder_id index makes
  // this a range scan). Use the same filters but no LIMIT, so the
  // UI can show "showing 50 of 1247". Skipped when the caller
  // already knows the total (typical for "next page" requests where
  // the first page's total is being reused).
  let total = 0;
  if (includeTotal) {
    const countParams: unknown[] = [folderId];
    let countStatusSql = "";
    if (options.status) {
      countParams.push(options.status);
      countStatusSql = `and last_event = $${countParams.length}`;
    } else if (!includeDeleted) {
      // Mirror the row filter so the total reflects the UI total,
      // not the underlying tombstone count.
      countStatusSql = "and last_event <> 'deleted'";
    }
    const countResult = await pool.query(
      `select count(*) as n from watched_folder_manifests where folder_id = $1 ${countStatusSql}`,
      countParams
    );
    total = Number(countResult.rows[0]?.n ?? 0);
  }
  return { manifest: rows, nextCursor, total };
}

// Cursor encoding/decoding for `getManifest`. Same shape as the
// document list cursor (base64url "keyA|keyB") so we can reuse
// helper-style code without coupling the two domains.
function encodeManifestCursor(key: { lastSeenAt: string; relPath: string }): string {
  return Buffer.from(`${key.lastSeenAt}|${key.relPath}`, "utf8").toString("base64url");
}

function decodeManifestCursor(token: string): { lastSeenAt: string; relPath: string } | null {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const idx = decoded.indexOf("|");
    if (idx <= 0) return null;
    const lastSeenAt = decoded.slice(0, idx);
    const relPath = decoded.slice(idx + 1);
    // lastSeenAt can be 'YYYY-MM-DD HH:MM:SS' (SQLite default) — accept
    // any string that parses to a Date.
    if (Number.isNaN(Date.parse(lastSeenAt))) return null;
    if (!relPath) return null;
    return { lastSeenAt, relPath };
  } catch {
    return null;
  }
}

// Single-row lookup used by sync-orchestrator instead of pulling
// the entire manifest and searching with Array.find(). O(1) via the
// composite primary key (folder_id, rel_path).
export async function getManifestEntry(
  folderId: string,
  relPath: string
): Promise<FileManifestRecord | null> {
  const result = await pool.query(
    "select * from watched_folder_manifests where folder_id = $1 and rel_path = $2 limit 1",
    [folderId, relPath]
  );
  return result.rows[0] ? manifestFromRow(result.rows[0]) : null;
}

export interface UpsertManifestInput {
  folderId: string;
  relPath: string;
  mtimeMs?: number | null;
  inode?: number | null;
  sizeBytes?: number | null;
  sha1?: string | null;
  status?: ManifestStatus;
  documentId?: string | null;
  lastError?: string | null;
  // Per-file ingest timing. Pass these when the call site knows the
  // wall-clock duration (typically sync-orchestrator, which records
  // a start timestamp before invoking `ingestionService.ingestDocument`
  // and computes the elapsed millis after it resolves). Both fields
  // are optional so existing callers don't need to change.
  lastSyncStartedAt?: string | Date | null;
  lastSyncDurationMs?: number | null;
}

/**
 * Insert or update a manifest entry. Keeps the existing `document_id` if the
 * caller doesn't pass a new one, so simple refreshes don't drop the pointer.
 *
 * `lastError` semantics: a non-undefined value is always persisted (the
 * column is overwritten). Passing `undefined` keeps the previous error
 * message intact — that's what we want for normal "synced" rows so a
 * one-time ingest failure isn't masked. Pass `null` explicitly to clear.
 */
export async function upsertManifest(input: UpsertManifestInput): Promise<FileManifestRecord> {
  const lastEvent = input.status ?? "pending";
  // `lastError` semantics: a non-undefined value is always persisted (the
  // column is overwritten). Passing `undefined` keeps the previous error
  // message intact — that's what we want for normal "synced" rows so a
  // one-time ingest failure isn't masked. Pass `null` explicitly to clear.
  const errorProvided = input.lastError !== undefined;
  const errorValue = errorProvided
    ? (input.lastError === null ? null : String(input.lastError).slice(0, 1000))
    : null;
  // Timing semantics: same pattern as `lastError` — non-undefined values
  // overwrite the column; passing undefined leaves the previous value
  // intact. The orchestrator only passes these on the terminal
  // transition (syncing → synced or syncing → failed), so a missing
  // value here means "this update isn't carrying timing info".
  const timingProvided =
    input.lastSyncStartedAt !== undefined || input.lastSyncDurationMs !== undefined;
  const lastSyncStartedAtValue = timingProvided
    ? toSqliteTimestamp(input.lastSyncStartedAt ?? null)
    : null;
  const lastSyncDurationMsValue = timingProvided
    ? normalizeDurationMs(input.lastSyncDurationMs ?? null)
    : null;
  const result = await pool.query(
    `
      insert into watched_folder_manifests (
        folder_id, rel_path, document_id, last_seen_at, last_event, size, hash, last_error,
        last_sync_started_at, last_sync_duration_ms
      )
      values ($1, $2, $3, current_timestamp, $4, $5, $6, $7, $8, $9)
      on conflict (folder_id, rel_path) do update set
        document_id = coalesce(excluded.document_id, watched_folder_manifests.document_id),
        last_seen_at = current_timestamp,
        last_event = excluded.last_event,
        size = excluded.size,
        hash = excluded.hash,
        last_error = case
          when $10::boolean then $7
          else coalesce(watched_folder_manifests.last_error, $7)
        end,
        last_sync_started_at = case
          when $11::boolean then $8
          else watched_folder_manifests.last_sync_started_at
        end,
        last_sync_duration_ms = case
          when $11::boolean then $9
          else watched_folder_manifests.last_sync_duration_ms
        end
      returning *
    `,
    [
      input.folderId,
      input.relPath,
      input.documentId ?? null,
      lastEvent,
      input.sizeBytes ?? null,
      input.sha1 ?? null,
      errorValue,
      lastSyncStartedAtValue,
      lastSyncDurationMsValue,
      // $10 — flag controlling the last_error update branch above.
      errorProvided,
      // $11 — flag controlling the timing update branches above.
      timingProvided
    ]
  );
  return manifestFromRow(result.rows[0]);
}

/**
 * Atomically transition a manifest entry's status. Returns the updated row, or
 * `null` if the transition didn't happen.
 *
 * `patch.lastError` is persisted when explicitly provided (the call site is
 * saying "this transition carries a new error message" — e.g. syncing →
 * failed on a retry). Leaving it `undefined` keeps the previous message
 * intact, so a successful sync doesn't wipe a one-time failure.
 */
export async function transitionManifestStatus(
  folderId: string,
  relPath: string,
  fromStatuses: ManifestStatus[],
  toStatus: ManifestStatus,
  patch: { lastError?: string | null; documentId?: string | null; allowInsert?: boolean } = {}
): Promise<FileManifestRecord | null> {
  if (fromStatuses.length === 0 && !patch.allowInsert) {
    throw new Error("transitionManifestStatus requires at least one from-status");
  }
  // Use $N placeholders for every parameter so the driver's $N→?
  // translator handles ordering. Numbered beyond the fixed params:
  // $1..$6 are folderId, relPath, toStatus/documentId, errorFlag/errorValue
  // (see both branches below), so from-statuses start at $7.
  const fromPlaceholders = fromStatuses.map((_, i) => `$${7 + i}`).join(",");
  const fromArgs = [...fromStatuses];
  const errorFlag = patch.lastError !== undefined;
  const errorValue = errorFlag
    ? (patch.lastError === null ? null : String(patch.lastError).slice(0, 1000))
    : null;
  if (patch.allowInsert) {
    const sql = `
      insert into watched_folder_manifests (
        folder_id, rel_path, document_id, last_seen_at, last_event, last_error
      )
      values (
        $1, $2, $3, current_timestamp, $4, $5
      )
      on conflict (folder_id, rel_path) do update set
        last_event = excluded.last_event,
        last_seen_at = current_timestamp,
        document_id = coalesce(excluded.document_id, watched_folder_manifests.document_id),
        last_error = case
          when $6::boolean then $5
          else coalesce(watched_folder_manifests.last_error, $5)
        end
      where
        watched_folder_manifests.last_event is null
        or watched_folder_manifests.last_event in (${fromPlaceholders})
      returning *
    `;
    const args = [
      folderId,
      relPath,
      patch.documentId ?? null,
      toStatus,
      errorValue,
      errorFlag,
      ...fromArgs
    ];
    const result = await pool.query(sql, args);
    return result.rows[0] ? manifestFromRow(result.rows[0]) : null;
  }
  const result = await pool.query(
    `
      update watched_folder_manifests
      set
        last_event = $3,
        last_seen_at = current_timestamp,
        document_id = coalesce($4, document_id),
        last_error = case
          when $5::boolean then $6
          else coalesce(watched_folder_manifests.last_error, $6)
        end
      where folder_id = $1
        and rel_path = $2
        and (last_event in (${fromPlaceholders}) or last_event is null)
      returning *
    `,
    [
      folderId,
      relPath,
      toStatus,
      patch.documentId ?? null,
      errorFlag,
      errorValue,
      ...fromArgs
    ]
  );
  return result.rows[0] ? manifestFromRow(result.rows[0]) : null;
}

export async function markManifestStatus(
  folderId: string,
  relPath: string,
  status: ManifestStatus,
  error?: string | null
): Promise<FileManifestRecord | null> {
  // Persist `last_error` when the caller explicitly passes one (including
  // null to clear). Without this, a UI-driven status flip would silently
  // drop the failure message we want to show next to the red badge.
  const errorFlag = error !== undefined;
  const errorValue = errorFlag
    ? (error === null ? null : String(error).slice(0, 1000))
    : null;
  const result = await pool.query(
    `
      update watched_folder_manifests
      set
        last_event = $3,
        last_seen_at = current_timestamp,
        last_error = case
          when $4::boolean then $5
          else coalesce(watched_folder_manifests.last_error, $5)
        end
      where folder_id = $1 and rel_path = $2
      returning *
    `,
    [folderId, relPath, status, errorFlag, errorValue]
  );
  return result.rows[0] ? manifestFromRow(result.rows[0]) : null;
}

export async function findManifestByDocumentId(documentId: string): Promise<FileManifestRecord | null> {
  const result = await pool.query(
    "select * from watched_folder_manifests where document_id = $1 limit 1",
    [documentId]
  );
  return result.rows[0] ? manifestFromRow(result.rows[0]) : null;
}

/**
 * "Delete" the manifest entry — actually marks it `deleted` so we keep history.
 * The associated document is removed separately via webuiService.deleteDocument.
 */
export async function deleteManifest(folderId: string, relPath: string): Promise<FileManifestRecord | null> {
  const result = await pool.query(
    `
      update watched_folder_manifests
      set last_event = 'deleted', last_seen_at = current_timestamp
      where folder_id = $1 and rel_path = $2
      returning *
    `,
    [folderId, relPath]
  );
  return result.rows[0] ? manifestFromRow(result.rows[0]) : null;
}

/**
 * Physically purge all manifest tombstones (`last_event = 'deleted'`)
 * whose `last_seen_at` is older than the supplied cutoff.
 *
 * Returns the number of rows removed. The associated `document_id`s
 * have already been cleared from Postgres `chunks` / `events` /
 * `documents` by the original removal path, so this is a pure DB-row
 * cleanup — no embedding or vector table is touched.
 *
 * Used by:
 *   1. The scheduled "tombstone sweep" so the manifest table doesn't
 *      grow unbounded over months of file churn.
 *   2. The manual `POST /api/watched-folders/:id/purge-tombstones`
 *      admin endpoint for operators who want immediate cleanup.
 */
export async function purgeDeletedManifests(
  folderId: string | null,
  olderThanIso: string
): Promise<{ folderId: string | null; removed: number }> {
  const params: unknown[] = [olderThanIso];
  let folderSql = "";
  if (folderId) {
    params.push(folderId);
    folderSql = `and folder_id = $${params.length}`;
  }
  const result = await pool.query(
    `
      delete from watched_folder_manifests
      where last_event = 'deleted'
      and last_seen_at < $1
      ${folderSql}
    `,
    params
  );
  return { folderId, removed: result.rowCount ?? 0 };
}

/**
 * Reset a `failed` (or `synced`) manifest row back to `pending` so the
 * next sync / manual retry re-runs the ingest path. We deliberately wipe
 * `document_id` so the upcoming ingest creates a fresh document instead
 * of overwriting the orphan from a previous failed attempt.
 *
 * Returns the rows that were transitioned, or [] if none matched.
 * Callers should pass a `relPaths` list to keep the operation atomic
 * per-row (no full-table scan) — the orchestrator re-enqueues each
 * returned row into the ingest queue.
 */
export async function resetManifestForRetry(
  folderId: string,
  relPaths: string[]
): Promise<FileManifestRecord[]> {
  if (relPaths.length === 0) {
    return [];
  }
  const placeholders = relPaths.map((_, i) => `$${i + 2}`).join(",");
  const result = await pool.query(
    `
      update watched_folder_manifests
      set
        last_event = 'pending',
        document_id = null,
        last_seen_at = current_timestamp,
        last_error = null
      where folder_id = $1
        and rel_path in (${placeholders})
        and last_event in ('failed', 'synced', 'partial')
      returning *
    `,
    [folderId, ...relPaths]
  );
  return result.rows.map(manifestFromRow);
}

/**
 * Convenience wrapper: reset a single manifest row to `pending`.
 * Returns the updated row, or null if the row doesn't exist (or is in
 * a state we won't retry from, e.g. `syncing`).
 */
export async function resetManifestEntryForRetry(
  folderId: string,
  relPath: string
): Promise<FileManifestRecord | null> {
  const rows = await resetManifestForRetry(folderId, [relPath]);
  return rows[0] ?? null;
}

/**
 * Return all manifest rows currently in `failed` state for a folder.
 * Used by the bulk-retry entry point so we don't have to do a separate
 * "list failed" + "list every page" round-trip from the caller. The
 * caller is responsible for chunking if the list is huge.
 */
export async function listFailedManifestEntries(folderId: string): Promise<FileManifestRecord[]> {
  const result = await pool.query(
    "select * from watched_folder_manifests where folder_id = $1 and last_event = 'failed' order by rel_path",
    [folderId]
  );
  return result.rows.map(manifestFromRow);
}

// ─── Sync runs ───────────────────────────────────────────────────────────────

export async function createSyncRun(folderId: string, trigger: SyncRunTrigger): Promise<SyncRunRecord> {
  // SQLite schema: watched_folder_runs(id, folder_id, tenant_id, trigger,
  // status, started_at, completed_at, stats_added, ...). Look up the
  // tenant_id from the watched_folders row so we always have it. Use
  // strftime with %f for subsecond precision so list/order operations can
  // distinguish runs created milliseconds apart.
  const result = await pool.query(
    `
      insert into watched_folder_runs (
        folder_id, tenant_id, trigger, status, started_at
      )
      values (
        $1,
        coalesce((select tenant_id from watched_folders where id = $1), 'unknown'),
        $2,
        'running',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      )
      returning *
    `,
    [folderId, trigger]
  );
  return syncRunFromRow(result.rows[0]);
}

export async function finishSyncRun(
  runId: string,
  status: SyncRunStatus,
  stats: { filesAdded: number; filesUpdated: number; filesDeleted: number; filesFailed: number },
  errorMessage?: string | null
): Promise<SyncRunRecord | null> {
  const result = await pool.query(
    `
      update watched_folder_runs
      set
        status = $2,
        completed_at = current_timestamp,
        stats_added = $3,
        stats_updated = $4,
        stats_deleted = $5,
        stats_failed = $6,
        error = $7
      where id = $1
      returning *
    `,
    [
      runId,
      status,
      stats.filesAdded,
      stats.filesUpdated,
      stats.filesDeleted,
      stats.filesFailed,
      errorMessage ?? null
    ]
  );
  return result.rows[0] ? syncRunFromRow(result.rows[0]) : null;
}

export async function getLatestSyncRun(folderId: string): Promise<SyncRunRecord | null> {
  const result = await pool.query(
    "select * from watched_folder_runs where folder_id = $1 order by started_at desc, id desc limit 1",
    [folderId]
  );
  return result.rows[0] ? syncRunFromRow(result.rows[0]) : null;
}

export interface ListSyncRunsOptions {
  limit?: number;
  // Either provide a cursor (recommended for forward-only paging) OR
  // an offset (for "jump to page N" controls). When both are set,
  // cursor wins.
  cursor?: string;
  offset?: number;
  // Set false to skip the COUNT(*). Subsequent pages can omit it
  // since the UI already knows the total from the first page.
  includeTotal?: boolean;
}

export interface SyncRunPage {
  runs: SyncRunRecord[];
  nextCursor: string | null;
  /** offset to send for the previous page. null on page 1. The UI
   * can compute the previous page by calling ?offset=<prevOffset> on
   * the same endpoint. */
  prevOffset: number | null;
  total: number;
  limit: number;
  offset: number;
}

export async function listSyncRuns(
  folderId: string,
  limitOrOptions: number | ListSyncRunsOptions = 20
): Promise<SyncRunRecord[] | SyncRunPage> {
  // Legacy overload: `listSyncRuns(folderId, 20)` still returns a
  // plain array. The route layer (and tests) that pass a plain number
  // keep working unchanged.
  if (typeof limitOrOptions === "number") {
    const result = await pool.query(
      "select * from watched_folder_runs where folder_id = $1 order by started_at desc, id desc limit $2",
      [folderId, limitOrOptions]
    );
    return result.rows.map(syncRunFromRow);
  }

  const options = limitOrOptions;
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 200);
  // Cursor mode and offset mode are mutually exclusive. When a cursor
  // is given, we use the (started_at, id) tuple predicate for forward
  // navigation AND ignore the offset (it's encoded inside the cursor
  // for "prev" hops only).
  const decoded = options.cursor ? decodeSyncRunCursor(options.cursor) : null;
  const offset = decoded ? 0 : Math.max(0, options.offset ?? 0);

  const params: unknown[] = [folderId];
  let cursorSql = "";
  if (decoded) {
    // (started_at, id) < (cursor.startedAt, cursor.id) — primary
    // ordering is started_at desc, tie-break id desc.
    params.push(decoded.startedAt, decoded.id);
    cursorSql = "and (started_at, id) < ($2, $3)";
  }
  // Use SQLite's LIMIT/OFFSET for offset-based jumps ("jump to page
  // N"); the cursor mode uses the tuple predicate without OFFSET so
  // it stays index-friendly.
  params.push(limit, offset);
  const limitPlaceholder = `$${params.length - 1}`;
  const offsetPlaceholder = `$${params.length}`;
  const sql = `
    select * from watched_folder_runs
    where folder_id = $1 ${cursorSql}
    order by started_at desc, id desc
    limit ${limitPlaceholder} offset ${offsetPlaceholder}
  `;
  const result = await pool.query(sql, params);
  const runs = result.rows.map(syncRunFromRow);

  // Build nextCursor: encode the last row's (started_at, id) so the
  // next page uses the tuple predicate (O(1) seek via the index).
  let nextCursor: string | null = null;
  if (runs.length === limit && runs.length > 0) {
    const lastRaw = result.rows[result.rows.length - 1];
    nextCursor = encodeSyncRunCursor({
      startedAt: String(lastRaw.started_at),
      id: String(lastRaw.id),
      offset: 0
    });
  }
  // prevOffset: jump back by `limit` from the current offset. null
  // when we're already on page 1. The UI uses this for "previous
  // page" navigation; "jump to page N" can be computed as
  // (page-1)*limit directly.
  const prevOffset: number | null = offset >= limit ? offset - limit : null;

  let total = 0;
  if (options.includeTotal !== false) {
    const countResult = await pool.query(
      "select count(*) as n from watched_folder_runs where folder_id = $1",
      [folderId]
    );
    total = Number(countResult.rows[0]?.n ?? 0);
  }
  return { runs, nextCursor, prevOffset, total, limit, offset };
}

// Cursor encoding/decoding for `listSyncRuns`. Same shape as the
// manifest cursor: base64url "startedAt|id|offset".
function encodeSyncRunCursor(key: { startedAt: string; id: string; offset: number }): string {
  return Buffer.from(`${key.startedAt}|${key.id}|${key.offset}`, "utf8").toString("base64url");
}

function decodeSyncRunCursor(token: string): { startedAt: string; id: string; offset: number } | null {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const parts = decoded.split("|");
    if (parts.length !== 3) return null;
    const [startedAt, id, offsetStr] = parts;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    if (Number.isNaN(Date.parse(startedAt))) return null;
    const offset = Number(offsetStr);
    if (!Number.isFinite(offset) || offset < 0) return null;
    return { startedAt, id, offset };
  } catch {
    return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Normalize a Date/string/null into a SQLite TIMESTAMP literal
 * ('YYYY-MM-DD HH:MM:SS', UTC). The watched_folder_manifests table stores
 * `last_seen_at` / `last_sync_started_at` as SQLite TEXT with no timezone
 * offset; we mirror that shape on the way in so reads can `new Date(...)`
 * the same string back. ISO strings with a `T` separator or `Z` suffix
 * are accepted and converted.
 *
 * Returns null when the input is null. Returns null when the input is
 * unparseable rather than throwing — callers usually wrap this in a
 * best-effort timing capture and a parse failure shouldn't tank the
 * whole ingest.
 */
function toSqliteTimestamp(value: string | Date | null): string | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  // SQLite's strftime('%Y-%m-%dT%H:%M:%fZ') shape (the same one
  // createSyncRun uses) is also fine to read back with `new Date(...)`,
  // so we just hand back the ISO string. The 'Z' suffix tells the
  // UI the value is UTC.
  return toLocalISO(d);
}

/**
 * Coerce a user-provided duration into a non-negative integer
 * milliseconds, or null when the input is null/non-finite/negative.
 * Stored as INTEGER for cheap arithmetic in the UI (no parsing).
 */
function normalizeDurationMs(value: number | null): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

function basename(p: string): string {
  const trimmed = p.replace(/[\/\\]+$/, "");
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const name = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
  return name || trimmed || "watched-folder";
}