/**
 * Watched folders (Sprint 1) — public types
 *
 * A user configures a local folder. SAG keeps a Source associated with the folder
 * and a file_manifest row per observed file. On every detected change (or scheduled
 * scan) we re-ingest the file into the knowledge base.
 *
 * Deletion is HARD: deleting a file (or its folder) permanently removes its document
 * via `webuiService.deleteDocument()`.
 */

export type ManifestStatus = "pending" | "syncing" | "synced" | "partial" | "failed" | "deleted";
// `completed_with_errors` is the new "task ran end-to-end but at least one file
// failed to ingest" state. It lets the UI distinguish "the folder scan crashed"
// (`failed`, red badge, surfaces last_scan_error) from "we got through 99% of
// the files but a few threw" (`completed_with_errors`, green-ish badge with a
// small ×N counter and a retry entry point). Single-file failures should
// never poison the task-level status — they're surfaced through
// `filesFailed` + the manifest `status="failed"` rows.
export type SyncRunStatus = "running" | "completed" | "completed_with_errors" | "failed";
export type SyncRunTrigger = "manual" | "scan" | "event" | "startup";

export interface FiletypeFilter {
  /** Whitelist (lowercase, with leading dot). `undefined` = accept all supported types. */
  whitelist?: string[];
  /** Blacklist (lowercase, with leading dot). Always wins over whitelist. */
  blacklist?: string[];
  /** Maximum file size in bytes. Files larger than this are skipped. */
  maxBytes?: number;
}

export interface WatchedFolderRecord {
  id: string;
  tenantId: string;
  path: string;
  displayName: string;
  sourceId: string;
  enabled: boolean;
  recursive: boolean;
  filetypeFilter: FiletypeFilter;
  metadata: Record<string, unknown>;
  lastScanAt?: string | null;
  lastError?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface FileManifestRecord {
  id: string;
  folderId: string;
  relPath: string;
  mtimeMs?: number | null;
  inode?: number | null;
  sizeBytes?: number | null;
  sha1?: string | null;
  status: ManifestStatus;
  documentId?: string | null;
  lastSyncedAt?: string | null;
  lastError?: string | null;
  // Wall-clock timing for the most-recent sync attempt on this file.
  // Populated by sync-orchestrator after `ingestDocument` resolves
  // (success or failure). `lastSyncStartedAt` is an ISO string in UTC;
  // `lastSyncDurationMs` is the elapsed millis from "we started the
  // ingestion call" to "the call returned". Both are null until the
  // orchestrator writes them — the UI uses "—" for missing values.
  lastSyncStartedAt?: string | null;
  lastSyncDurationMs?: number | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface SyncRunRecord {
  id: string;
  folderId: string;
  startedAt: string;
  finishedAt?: string | null;
  status: SyncRunStatus;
  trigger: SyncRunTrigger;
  filesAdded: number;
  filesUpdated: number;
  filesDeleted: number;
  filesFailed: number;
  errorMessage?: string | null;
  metadata: Record<string, unknown>;
}

export interface SyncStats {
  added: number;
  updated: number;
  deleted: number;
  failed: number;
}

export interface CreateWatchedFolderInput {
  tenantId: string;
  path: string;
  displayName?: string;
  enabled?: boolean;
  recursive?: boolean;
  filetypeFilter?: FiletypeFilter;
  metadata?: Record<string, unknown>;
}

export interface UpdateWatchedFolderInput {
  displayName?: string;
  enabled?: boolean;
  recursive?: boolean;
  filetypeFilter?: FiletypeFilter;
  metadata?: Record<string, unknown>;
}

/**
 * Default set of extensions the watcher is allowed to ingest.
 * Mirrors the in-process Node converter's supported list. PNG/JPG are
 * intentionally absent — OCR is not bundled in the Node-only converter
 * (would require tesseract.js + a 30MB+ language pack).
 */
export const DEFAULT_SUPPORTED_EXTENSIONS: string[] = [
  ".md",
  ".txt",
  ".pdf",
  ".docx",
  ".doc",
  ".pptx",
  ".ppt",
  ".xlsx",
  ".xls",
  ".csv"
];