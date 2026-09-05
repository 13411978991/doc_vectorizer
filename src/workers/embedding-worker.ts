/**
 * src/workers/embedding-worker.ts — Background embedding sweep.
 *
 * 目的：ingestDocument 失败时，孤立的 pending chunks 仍然在 DB 里
 * 等着被 embedding。本 worker 周期性扫表，把任何 chunk_state='pending'
 * 且没被锁的 chunk 拿过来跑 ONNX forward，写回 chunk_embeddings，
 * 然后把 state 翻成 'embedded'。
 *
 * 这是"分阶段 + 双进程并行"方案的进程 B 角色。在我们当前实现里
 * ingest 已经在主进程同步跑完 embedding，**所以这个 worker 只在崩溃
 * 恢复场景下起作用**——但因为它跑在后台循环里，运行期间会把任何
 * 漏掉的 chunk 也补上。
 *
 * 锁机制：claim 时原子 UPDATE chunks SET locked_by / locked_at，
 * 跑完 embed 释放锁并 UPDATE state='embedded'。5 分钟锁超时，
 * 防止进程崩了之后没人释放。
 */

import { getPool } from "../db/sqlite-driver.js";
import { logger } from "../observability/logger.js";
import { embeddingClient } from "../ai/embedding-client.js";
import { capForEmbedding } from "../services/ingestion-service.js";
import { aiSettingsService } from "../services/ai-settings-service.js";

const WORKER_ID = "embedding-worker-" + process.pid;
const BATCH_SIZE = 32;
const LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 min
const POLL_INTERVAL_MS = 2000;
const LOOP_ENABLED = process.env.EMBEDDING_WORKER_DISABLED !== "1";

let loopRunning = false;

interface ClaimedChunk {
  id: string;
  document_id: string;
  heading: string;
  content: string;
  raw_content: string;
}

/**
 * Atomically claim up to BATCH_SIZE pending chunks. Uses a single
 * UPDATE ... RETURNING so SQLite's WAL handles the read+write race
 * correctly: two workers cannot claim the same row.
 */
async function claimPendingChunks(): Promise<ClaimedChunk[]> {
  const pool = getPool();
  // Compute the cutoff timestamp in the same format SQLite uses.
  // `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 minutes')` gives a
  // ISO 8601 string 5 min in the past, comparable to locked_at.
  const result = await pool.query<ClaimedChunk>(
    `
      update chunks
      set locked_by = $1, locked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      where id in (
        select id from chunks
        where chunk_state = 'pending'
          and (
            locked_at is null
            or locked_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 minutes')
          )
        order by rowid
        limit $2
      )
      returning id, document_id, heading, content, raw_content
    `,
    [WORKER_ID, BATCH_SIZE]
  );
  return result.rows;
}

async function releaseLock(chunkId: string): Promise<void> {
  await getPool().query(
    `update chunks set locked_by = null, locked_at = null where id = $1`,
    [chunkId]
  );
}

async function markFailed(chunkId: string): Promise<void> {
  await getPool().query(
    `update chunks set chunk_state = 'failed', locked_by = null, locked_at = null where id = $1`,
    [chunkId]
  );
}

async function embedClaimedBatch(claimed: ClaimedChunk[]): Promise<void> {
  if (claimed.length === 0) return;
  const pool = getPool();
  const settings = await aiSettingsService.getRuntimeSettings();
  const embeddingModelLabel =
    settings.embeddingProvider === "local-bge"
      ? `local-bge:${settings.embeddingLocalModelPath.split(/[/\\]/).pop()}`
      : settings.embeddingModel;

  // Build a stable text representation for embedding. The on-disk
  // `content` column is the post-chunking text (heading+content
  // already merged by the chunker); we use it directly.
  const texts = claimed.map((c) =>
    capForEmbedding(`${c.heading}\n${c.content}`)
  );

  let vectors: number[][];
  try {
    vectors = await embeddingClient.batchGenerate(texts);
  } catch (err) {
    // Whole batch failed. Mark every claimed chunk as failed and bail.
    for (const c of claimed) {
      await markFailed(c.id);
    }
    logger.error(
      { err: (err as Error).message, n: claimed.length },
      "embedding-worker: batch generate failed, marked failed"
    );
    return;
  }

  // Persist each embedding + flip state. Use one transaction so a
  // crash mid-write doesn't leave half-embedded chunks.
  await pool.query("begin");
  try {
    for (let i = 0; i < claimed.length; i++) {
      const c = claimed[i];
      const v = vectors[i];
      if (!v) {
        await markFailed(c.id);
        continue;
      }
      await pool.query(
        `
          insert into chunk_embeddings (chunk_id, model, embedding_json)
          values ($1, $2, $3)
          on conflict (chunk_id) do update set embedding_json = excluded.embedding_json
        `,
        [c.id, embeddingModelLabel, JSON.stringify(v)]
      );
      await pool.query(
        `update chunks set chunk_state = 'embedded', locked_by = null, locked_at = null where id = $1`,
        [c.id]
      );
    }
    await pool.query("commit");
  } catch (err) {
    await pool.query("rollback");
    // Release all claimed chunks back to pending so the next sweep retries.
    for (const c of claimed) {
      await releaseLock(c.id);
    }
    logger.error(
      { err: (err as Error).message, n: claimed.length },
      "embedding-worker: db write failed, released locks for retry"
    );
    return;
  }

  logger.info(
    { n: claimed.length, workerId: WORKER_ID },
    "embedding-worker: batch embedded"
  );
}

async function runOnce(): Promise<number> {
  const claimed = await claimPendingChunks();
  if (claimed.length === 0) return 0;
  await embedClaimedBatch(claimed);
  return claimed.length;
}

/**
 * Start the background loop. Returns a stop() handle the caller can
 * use during shutdown.
 */
export function startEmbeddingWorkerLoop(): () => void {
  if (!LOOP_ENABLED) {
    logger.info("embedding-worker: disabled via env (EMBEDDING_WORKER_DISABLED=1)");
    return () => {};
  }
  if (loopRunning) {
    return () => {};
  }
  loopRunning = true;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const n = await runOnce();
      if (n > 0) {
        // Found work — try again immediately. Don't pause; this
        // worker should drain any backlog ASAP.
        setImmediate(tick);
        return;
      }
    } catch (err) {
      logger.error(
        { err: (err as Error).message },
        "embedding-worker: tick error"
      );
    }
    if (stopped) return;
    setTimeout(tick, POLL_INTERVAL_MS);
  };

  // Kick off after a short delay so the boot phase can finish first.
  setTimeout(tick, 1000);
  logger.info({ workerId: WORKER_ID, batchSize: BATCH_SIZE }, "embedding-worker: loop started");

  return () => {
    stopped = true;
    loopRunning = false;
    logger.info("embedding-worker: loop stopped");
  };
}