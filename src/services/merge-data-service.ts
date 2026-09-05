// src/services/merge-data-service.ts — Merge a stand-alone SAG SQLite dump
// (`黑洞.exe 同级/合并数据/data/sag.db`) into the running main database and
// register the folder as a watched folder.
//
// Behaviour:
//   1. Validate `<exeDir>/合并数据/data/sag.db` exists and is readable.
//   2. Read the watched_folder row in the merged DB whose path matches
//      `<exeDir>/合并数据/` (the source whose documents we are importing).
//   3. Create a fresh auto-source in the main DB and a watched_folder
//      pointing at the merged-data path.
//   4. Copy the data tables (documents / chunks / source_chunks /
//      chunk_embeddings / entities / events / event_entities) from the
//      merged DB into the main DB, rewriting source_id / document_id /
//      chunk_id / entity_id / event_id as needed.
//   5. Conflict policy on documents: keyed by (source_id, relPath). When
//      both sides have a row, the one with the newer `updated_at` wins.
//      On documents win, dependent rows (chunks, embeddings, events,
//      entities, event_entities) are re-inserted from the merged DB and
//      the previously-imported dependents of the same logical document
//      are removed first.
//   6. Return a summary (inserted / updated / skipped / failed counts) so
//      the Web UI can show what happened.
//
// This service deliberately skips infra tables (sources, watched_folders,
// watched_folder_manifests, watched_folder_runs, mcp_*, ai_provider_settings,
// audit_*, kb_*, shared_folder_config, audit_logs). The merged DB is data-only.
//
// Exposed via:
//   - POST /api/watched-folders/merge-data   (HTTP API)
//   - 黑 洞.exe 同级/合并数据/               (folder scanned at boot would be too
//                                          aggressive; user explicitly clicks the
//                                          button in the Web UI)

import { promises as fs } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { createSource } from "../db/repositories.js";
import { createFolder } from "../watcher/manifest-store.js";
import { watcherManager } from "../watcher/index.js";
import { logger } from "../observability/logger.js";

const MERGE_DIR_NAME = "合并数据";
const MERGE_DB_SUBDIR = "data";
const MERGE_DB_FILENAME = "sag.db";

// Tables whose rows belong to the user data. The PK column is `id` for
// each; `documents` is the canonical root. We rewrite source_id and the
// FKs that point into documents/chunks/events/entities.
const DATA_TABLES = [
  "documents",
  "chunks",
  "source_chunks",
  "chunk_embeddings",
  "events",
  "entities",
  "event_entities"
] as const;

type DataTable = (typeof DATA_TABLES)[number];

export interface MergeResult {
  folderId: string;
  newSourceId: string;
  mergedDbPath: string;
  documents: { inserted: number; updated: number; skipped: number };
  chunks: number;
  events: number;
  entities: number;
  eventEntities: number;
}

export function getMergedDataDbPath(exeDir: string = path.dirname(process.execPath)): string {
  return path.join(exeDir, MERGE_DIR_NAME, MERGE_DB_SUBDIR, MERGE_DB_FILENAME);
}

export function getMergedDataFolderPath(exeDir: string = path.dirname(process.execPath)): string {
  return path.join(exeDir, MERGE_DIR_NAME);
}

export async function mergedDataReady(
  exeDir: string = path.dirname(process.execPath)
): Promise<{ ready: boolean; dbPath: string; reason?: string }> {
  const dbPath = getMergedDataDbPath(exeDir);
  try {
    const stat = await fs.stat(dbPath);
    if (!stat.isFile()) {
      return { ready: false, dbPath, reason: "not a regular file" };
    }
    return { ready: true, dbPath };
  } catch (error) {
    return { ready: false, dbPath, reason: (error as Error).message };
  }
}

interface MergedFolderRow {
  id: string;
  source_id: string;
  display_name: string | null;
}

interface MergedDocumentRow {
  id: string;
  source_id: string;
  title: string;
  file_name: string | null;
  content: string;
  parse_status: string;
  metadata: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function mergeAndRegisterMergedDataFolder(input: {
  tenantId: string;
  displayName?: string;
}): Promise<MergeResult> {
  const exeDir = path.dirname(process.execPath);
  const folderPath = getMergedDataFolderPath(exeDir);
  const dbPath = getMergedDataDbPath(exeDir);

  await fs.access(folderPath);
  await fs.access(dbPath);

  // Open the merged DB read-only so we never accidentally mutate it.
  const mergedDb = new Database(dbPath, { readonly: true, fileMustExist: true });

  try {
    const tables = mergedDb
      .prepare("select name from sqlite_master where type='table'")
      .all() as Array<{ name: string }>;
    const tableNames = new Set(tables.map((r) => r.name));
    for (const t of DATA_TABLES) {
      if (!tableNames.has(t)) {
        throw new Error(
          `merged database is missing required table '${t}'. ` +
            "Make sure it was produced by a real SAG database."
        );
      }
    }

    // The merged DB has its own watched_folder + source rows. Find the
    // watched_folder whose path points at the merge directory; its
    // source_id is the one whose documents we are about to copy.
    const folderRow = mergedDb
      .prepare("select id, source_id, display_name from watched_folders where path = ?")
      .get(folderPath) as MergedFolderRow | undefined;
    if (!folderRow) {
      throw new Error(
        `merged database has no watched_folder for path '${folderPath}'. ` +
          "The merged DB must be from a SAG installation that watched this folder."
      );
    }
    const mergedSourceId = folderRow.source_id;

    // Create the destination folder + auto-source in the main DB before
    // touching any rows. This means new IDs are minted now and the
    // remaining copy uses them.
    const displayName = input.displayName?.trim() || MERGE_DIR_NAME;
    const newSource = await createSource({
      tenantId: input.tenantId,
      name: displayName,
      description: `Merged from ${MERGE_DIR_NAME}/ on ${new Date().toISOString()}`,
      metadata: {
        createdVia: "merge-data",
        semanticType: "watched_folder",
        watchedFolderPath: folderPath
      }
    });
    const newSourceId = newSource.id;

    const newFolder = await createFolder({
      tenantId: input.tenantId,
      path: folderPath,
      displayName,
      recursive: true,
      filetypeFilter: {},
      metadata: {
        mergedFromPath: dbPath,
        mergedSourceId,
        mergedAt: new Date().toISOString()
      },
      enabled: true,
      sourceId: newSourceId
    });

    // All data mutations go through a single SQLite transaction on the
    // main pool so a mid-merge crash leaves no half-imported state.
    const client = await pool.connect();
    const summary: MergeResult = {
      folderId: newFolder.id,
      newSourceId,
      mergedDbPath: dbPath,
      documents: { inserted: 0, updated: 0, skipped: 0 },
      chunks: 0,
      events: 0,
      entities: 0,
      eventEntities: 0
    };
    const oldIdToNewId = new Map<string, string>();

    try {
      await client.query("begin");

      // ── documents (root table) ────────────────────────────────────────
      const mergedDocs = mergedDb
        .prepare(
          `select id, source_id, title, file_name, content, parse_status,
                  metadata, archived_at, created_at, updated_at
             from documents where source_id = ?`
        )
        .all(mergedSourceId) as MergedDocumentRow[];

      for (const doc of mergedDocs) {
        const relPath = extractRelPath(doc.metadata, doc.file_name);
        const existing = (await client.query(
          `select id, updated_at from documents
            where source_id = $1
              and json_extract(metadata, '$.relPath') = $2
              and (archived_at is null or archived_at = '')`,
          [newSourceId, relPath]
        )).rows[0] as { id: string; updated_at: string } | undefined;

        if (existing) {
          if (compareTimestamp(existing.updated_at, doc.updated_at) >= 0) {
            // Main DB is newer or equal; keep it but still record the
            // logical mapping so dependents of any future re-merge map
            // back to the same document id.
            oldIdToNewId.set(doc.id, existing.id);
            summary.documents.skipped += 1;
            continue;
          }
          // Merged version is newer. Delete the existing dependents and
          // the document itself so we can re-insert a fresh copy.
          await client.query(
            `delete from event_entities
              where event_id in (select id from events where document_id = $1)`,
            [existing.id]
          );
          await client.query(
            `delete from events where document_id = $1`,
            [existing.id]
          );
          await client.query(
            `delete from chunk_embeddings
              where chunk_id in (select id from chunks where document_id = $1)`,
            [existing.id]
          );
          await client.query(
            `delete from chunks where document_id = $1`,
            [existing.id]
          );
          await client.query(
            `delete from source_chunks where document_id = $1`,
            [existing.id]
          );
          await client.query(`delete from documents where id = $1`, [existing.id]);
          summary.documents.updated += 1;
        } else {
          summary.documents.inserted += 1;
        }

        const newDocId = randomUUID();
        oldIdToNewId.set(doc.id, newDocId);
        const newMetadata = rewriteSourcePath(doc.metadata, relPath);
        await client.query(
          `insert into documents
             (id, source_id, title, file_name, content, parse_status,
              metadata, archived_at, created_at, updated_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            newDocId,
            newSourceId,
            doc.title,
            doc.file_name,
            doc.content,
            doc.parse_status,
            newMetadata,
            doc.archived_at,
            doc.created_at,
            doc.updated_at
          ]
        );
      }

      // ── chunks ───────────────────────────────────────────────────────
      const mergedChunks = mergedDb
        .prepare(
          `select id, document_id, source_id, rank, heading, content,
                  raw_content, token_count, metadata
             from chunks where source_id = ?`
        )
        .all(mergedSourceId) as Array<{
          id: string;
          document_id: string;
          source_id: string;
          rank: number;
          heading: string | null;
          content: string;
          raw_content: string | null;
          token_count: number | null;
          metadata: string;
        }>;
      for (const ch of mergedChunks) {
        const newDocId = oldIdToNewId.get(ch.document_id);
        if (!newDocId) continue; // orphaned chunk; shouldn't happen
        // Chunk ids may collide if same chunk id was used in main DB
        // (extremely unlikely). Mint a fresh id for safety.
        const newChunkId = randomUUID();
        await client.query(
          `insert into chunks
             (id, document_id, source_id, rank, heading, content,
              raw_content, token_count, metadata)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            newChunkId,
            newDocId,
            newSourceId,
            ch.rank,
            ch.heading,
            ch.content,
            ch.raw_content,
            ch.token_count,
            ch.metadata
          ]
        );
        oldIdToNewId.set(ch.id, newChunkId);
        summary.chunks += 1;
      }

      // ── source_chunks (mirror table) ────────────────────────────────
      const mergedSourceChunks = mergedDb
        .prepare(
          `select id, document_id, source_id, source_type, heading,
                  content, raw_content, token_count, metadata,
                  chunk_id, embedding_json, embedding
             from source_chunks where source_id = ?`
        )
        .all(mergedSourceId) as Array<Record<string, unknown>>;
      for (const sc of mergedSourceChunks) {
        const newDocId = oldIdToNewId.get(String(sc.document_id));
        if (!newDocId) continue;
        const newChunkId = sc.chunk_id ? oldIdToNewId.get(String(sc.chunk_id)) ?? null : null;
        await client.query(
          `insert into source_chunks
             (id, document_id, source_id, source_type, heading, content,
              raw_content, token_count, metadata, chunk_id,
              embedding_json, embedding)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            randomUUID(),
            newDocId,
            newSourceId,
            sc.source_type ?? "document",
            sc.heading ?? null,
            sc.content ?? "",
            sc.raw_content ?? null,
            sc.token_count ?? null,
            sc.metadata ?? "{}",
            newChunkId,
            sc.embedding_json ?? null,
            sc.embedding ?? null
          ]
        );
      }

      // ── chunk_embeddings ────────────────────────────────────────────
      const mergedChunkEmbeddings = mergedDb
        .prepare(
          `select chunk_id, model, embedding_json, embedding, created_at
             from chunk_embeddings
             where chunk_id in (select id from chunks where source_id = ?)`
        )
        .all(mergedSourceId) as Array<{
          chunk_id: string;
          model: string;
          embedding_json: string;
          embedding: Buffer | null;
          created_at: string;
        }>;
      for (const ce of mergedChunkEmbeddings) {
        const newChunkId = oldIdToNewId.get(ce.chunk_id);
        if (!newChunkId) continue;
        await client.query(
          `insert into chunk_embeddings
             (chunk_id, model, embedding_json, embedding, created_at)
           values ($1,$2,$3,$4,$5)`,
          [
            newChunkId,
            ce.model,
            ce.embedding_json,
            ce.embedding,
            ce.created_at
          ]
        );
      }

      // ── entities ────────────────────────────────────────────────────
      // Entities are keyed by (source_id, name, type) — document_id is
      // optional and may change. We dedupe by that triplet.
      const mergedEntities = mergedDb
        .prepare(
          `select id, source_id, document_id, entity_type_id, name,
                  normalized_name, type, description, embedding_json,
                  embedding, metadata
             from entities where source_id = ?`
        )
        .all(mergedSourceId) as Array<{
          id: string;
          source_id: string;
          document_id: string | null;
          entity_type_id: string | null;
          name: string;
          normalized_name: string;
          type: string;
          description: string | null;
          embedding_json: string | null;
          embedding: Buffer | null;
          metadata: string;
        }>;
      for (const ent of mergedEntities) {
        const newDocId = ent.document_id ? oldIdToNewId.get(ent.document_id) ?? null : null;
        const existingEnt = (await client.query(
          `select id from entities
            where source_id = $1 and name = $2 and type = $3
            limit 1`,
          [newSourceId, ent.name, ent.type]
        )).rows[0] as { id: string } | undefined;
        if (existingEnt) {
          oldIdToNewId.set(ent.id, existingEnt.id);
          continue;
        }
        const newEntId = randomUUID();
        await client.query(
          `insert into entities
             (id, source_id, document_id, entity_type_id, name,
              normalized_name, type, description, embedding_json,
              embedding, metadata)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            newEntId,
            newSourceId,
            newDocId,
            ent.entity_type_id,
            ent.name,
            ent.normalized_name,
            ent.type,
            ent.description,
            ent.embedding_json,
            ent.embedding,
            ent.metadata
          ]
        );
        oldIdToNewId.set(ent.id, newEntId);
        summary.entities += 1;
      }

      // ── events ──────────────────────────────────────────────────────
      const mergedEvents = mergedDb
        .prepare(
          `select id, source_id, document_id, source_type, chunk_id,
                  title, content, summary, category, status, rank,
                  title_embedding_json, title_embedding, content_embedding_json,
                  content_embedding, deleted_at, created_at
             from events where source_id = ?`
        )
        .all(mergedSourceId) as Array<Record<string, unknown>>;
      for (const ev of mergedEvents) {
        const newDocId = ev.document_id ? oldIdToNewId.get(String(ev.document_id)) ?? null : null;
        const newChunkId = ev.chunk_id ? oldIdToNewId.get(String(ev.chunk_id)) ?? null : null;
        const newEventId = randomUUID();
        await client.query(
          `insert into events
             (id, source_id, document_id, source_type, chunk_id, title,
              content, summary, category, status, rank,
              title_embedding_json, title_embedding,
              content_embedding_json, content_embedding,
              deleted_at, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [
            newEventId,
            newSourceId,
            newDocId,
            ev.source_type ?? "document",
            newChunkId,
            ev.title,
            ev.content ?? "",
            ev.summary ?? null,
            ev.category ?? "fact",
            ev.status ?? "CONFIRMED",
            ev.rank ?? 0,
            ev.title_embedding_json ?? null,
            ev.title_embedding ?? null,
            ev.content_embedding_json ?? null,
            ev.content_embedding ?? null,
            ev.deleted_at ?? null,
            ev.created_at
          ]
        );
        oldIdToNewId.set(String(ev.id), newEventId);
        summary.events += 1;
      }

      // ── event_entities ─────────────────────────────────────────────
      const mergedEventEntities = mergedDb
        .prepare(
          `select id, event_id, entity_id
             from event_entities
             where event_id in (select id from events where source_id = ?)`
        )
        .all(mergedSourceId) as Array<{ id: string; event_id: string; entity_id: string }>;
      for (const ee of mergedEventEntities) {
        const newEventId = oldIdToNewId.get(ee.event_id);
        const newEntityId = oldIdToNewId.get(ee.entity_id);
        if (!newEventId || !newEntityId) continue;
        await client.query(
          `insert into event_entities (id, event_id, entity_id)
           values ($1, $2, $3)`,
          [randomUUID(), newEventId, newEntityId]
        );
        summary.eventEntities += 1;
      }

      await client.query("commit");
      logger.info(
        { ...summary, folderId: newFolder.id, newSourceId },
        "merge-data: merged SQLite dump into main database"
      );
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    // Best-effort: start watching the new folder. If it fails, the user
    // can retry by toggling enabled or restarting the server.
    try {
      await watcherManager.startOne(newFolder);
    } catch (error) {
      logger.error(
        { folderId: newFolder.id, error: (error as Error).message },
        "merge-data: failed to start watcher (folder is registered but not watching)"
      );
    }

    return summary;
  } finally {
    mergedDb.close();
  }
}

function extractRelPath(metadataJson: string, fileName: string | null): string {
  try {
    const parsed = JSON.parse(metadataJson) as { relPath?: unknown };
    if (typeof parsed.relPath === "string" && parsed.relPath.length > 0) {
      return parsed.relPath;
    }
  } catch {
    // fall through
  }
  return fileName ?? "";
}

function rewriteSourcePath(metadataJson: string, relPath: string): string {
  try {
    const parsed = JSON.parse(metadataJson) as Record<string, unknown>;
    if (typeof parsed.sourcePath === "string") {
      const sep = parsed.sourcePath.includes("\\") ? "\\" : "/";
      parsed.sourcePath = `${relPath ? relPath : ""}`.length > 0
        ? `${trimDirectory(parsed.sourcePath, sep)}${sep}${relPath}`
        : parsed.sourcePath;
    }
    return JSON.stringify(parsed);
  } catch {
    return JSON.stringify({ relPath });
  }
}

function trimDirectory(p: string, sep: string): string {
  const idx = p.lastIndexOf(sep);
  return idx >= 0 ? p.slice(0, idx) : p;
}

function compareTimestamp(a: string, b: string): number {
  if (a === b) return 0;
  return a > b ? 1 : -1;
}
