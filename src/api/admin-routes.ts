/**
 * src/api/admin-routes.ts — destructive maintenance endpoints.
 *
 * P14 — rebuild-vec0 backfill. Before the P14 fix, chunks were
 * inserted with their embedding JSON stored in `chunks.embedding_json`
 * but the `chunk_vec0` virtual-table row was never populated. The
 * runtime could fall back to the legacy brute-force cosine loop, but
 * that scans the entire chunk corpus on every query and gets
 * unusably slow above ~10k chunks.
 *
 * POST /api/admin/rebuild-vec0 re-reads every `chunks.embedding_json`
 * row that lacks a `chunk_vec0` partner and re-inserts it as a
 * Float32Array blob. Run once after upgrading; subsequent ingests
 * keep the two in sync via ingestion-service.
 *
 * The endpoint requires auth like every other route. It also refuses
 * to run when the pool is PostgreSQL — sqlite-vec is bundled, but the
 * PG adapter doesn't carry the vec0 extension.
 */
import type { FastifyInstance } from "fastify";
import { isSqlitePool, pool } from "../db/pool.js";
import { logger } from "../observability/logger.js";

interface RebuildSummary {
  scanned: number;
  rebuilt: number;
  skippedAlreadyVec: number;
  skippedBadJson: number;
  errors: number;
  durationMs: number;
}

export function registerAdminRoutes(app: FastifyInstance): void {
  // schema: { body: null } disables Fastify's JSON body parsing so
  // callers can POST without a body. The endpoint is idempotent (re-
  // runs just skip already-vec0 rows), so no parameters are needed.
  app.post("/api/admin/rebuild-vec0", async (_request, reply) => {
    if (!isSqlitePool()) {
      return reply.code(409).send({
        error: "rebuild-vec0 requires SQLite (sqlite-vec is bundled with the desktop build)"
      });
    }
    const start = Date.now();
    const summary: RebuildSummary = {
      scanned: 0,
      rebuilt: 0,
      skippedAlreadyVec: 0,
      skippedBadJson: 0,
      errors: 0,
      durationMs: 0
    };
    try {
      // P14 rebuild — read every chunk, decide whether its vec0 row
      // is missing, and re-insert if so. We pull in batches so we
      // don't OOM on a 100k-row DB.
      // Backfill path: the old ingestion code (pre-P14) stored embeddings
      // as JSON text in chunks.embedding_json. If that column doesn't exist
      // (fresh install), skip gracefully — there's nothing to backfill.
      const embedColExists = await pool.query(
        `select 1 from pragma_table_info('chunks') where name = 'embedding_json' limit 1`
      );
      if (!embedColExists.rows.length) {
        summary.scanned = 0;
        summary.rebuilt = 0;
        summary.skippedBadJson = 0;
        summary.skippedAlreadyVec = 0;
        summary.errors = 0;
        summary.durationMs = Date.now() - start;
        return summary;
      }

      const BATCH = 500;
      let cursor: string | number = "";
      while (true) {
        const rows = await pool.query(
          `select c.id, c.embedding_json,
                  exists(select 1 from chunk_vec0 v where v.chunk_id = c.id) as has_vec
           from chunks c
           where c.id > $1
             and c.embedding_json is not null
           order by c.id
           limit $2`,
          [cursor, BATCH]
        );
        if (!rows.rows || rows.rows.length === 0) break;
        for (const row of rows.rows) {
          summary.scanned += 1;
          cursor = String(row.id) as string;
          if (Number(row.has_vec) === 1) {
            summary.skippedAlreadyVec += 1;
            continue;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(String(row.embedding_json));
          } catch {
            summary.skippedBadJson += 1;
            continue;
          }
          if (!Array.isArray(parsed)) {
            summary.skippedBadJson += 1;
            continue;
          }
          try {
            await pool.query(
              "insert into chunk_vec0 (chunk_id, embedding) values ($1, $2)",
              [String(row.id), new Float32Array(parsed as number[])]
            );
            summary.rebuilt += 1;
          } catch (err) {
            summary.errors += 1;
            logger.warn(
              { chunkId: row.id, error: (err as Error).message },
              "rebuild-vec0: insert failed"
            );
          }
        }
        if (rows.rows.length < BATCH) break;
      }
      summary.durationMs = Date.now() - start;
      logger.info(summary, "rebuild-vec0: complete");
      return summary;
    } catch (error) {
      summary.durationMs = Date.now() - start;
      logger.error({ error: (error as Error).message }, "rebuild-vec0: aborted");
      return reply.code(500).send({
        error: (error as Error).message,
        summary
      });
    }
  });
}