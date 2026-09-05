/**
 * src/workers/child-process-manager.ts — DEPRECATED stub.
 *
 * 2026-08-10: the 黑洞-ingest-worker.exe child process design from
 * 失败原因/2026-08-10-sag-分阶段双进程并行方案.md was rolled back.
 * Real-world wall-clock savings on local ONNX were only a few
 * percent (because both processes end up on the same single
 * ONNX runtime instance, so the parent still stalls), and shipping
 * a second 87 MB exe was more friction than it was worth.
 *
 * The in-process embedding loop (src/workers/embedding-worker.ts,
 * started from src/index.ts) still runs and still gives us crash
 * recovery — which is the one piece of the spec that actually
 * measured 5x in real testing.
 *
 * The full plan and the worker exe can be re-introduced later
 * when per-stage work moves off the main thread (e.g. xlsx parser
 * into worker_threads). Until then, this file is a no-op so the
 * import in callers doesn't break.
 */

export function startChildIngestWorker(): () => void {
  // No-op. The parent process runs the embedding-worker loop itself
  // via startEmbeddingWorkerLoop() in src/index.ts.
  return () => {};
}

export function stopChild(): void {
  // No-op.
}