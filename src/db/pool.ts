import type { SqlitePool } from "./sqlite-driver.js";
import type { PgPool } from "./pg-driver.js";

// Singleton pool. Resolves to PgPool when DATABASE_URL is set (production
// / PG-backed tests) and SqlitePool otherwise (dev / SQLite-backed tests).
// The pool is created lazily on first use (or by an explicit initPool()
// call from the entry point) so this module can avoid top-level await
// and remain CJS-compatible under esbuild's `format: "cjs"`. Callers
// must `await initPool()` before issuing any query; in practice the main
// entry does this once during boot, and tests call it from globalSetup.
type AnyPool = SqlitePool | PgPool;

let _pool: AnyPool | null = null;

async function buildPoolAsync(): Promise<AnyPool> {
  if (process.env.DATABASE_URL) {
    const { getPgPool } = await import("./pg-driver.js");
    return getPgPool();
  }
  const { getPool } = await import("./sqlite-driver.js");
  return getPool();
}

export async function initPool(): Promise<void> {
  if (_pool) return;
  _pool = await buildPoolAsync();
}

// Lazy proxy: throws if used before initPool() resolves. This is the
// public `pool` exported to the rest of the codebase; existing call sites
// keep doing `pool.query(...)` unchanged.
export const pool: AnyPool = new Proxy({} as AnyPool, {
  get(_target, prop) {
    if (!_pool) {
      throw new Error(
        `db.pool accessed before initPool() resolved (prop=${String(prop)}). ` +
          `Call await initPool() during boot before using pool.`
      );
    }
    const value = (_pool as unknown as Record<string | symbol, unknown>)[prop];
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(_pool) : value;
  }
}) as AnyPool;

export async function closePool(): Promise<void> {
  if (!_pool) return;
  if (process.env.DATABASE_URL) {
    const { closePgPool } = await import("./pg-driver.js");
    await closePgPool();
  } else {
    const { closePool: closeSqlite } = await import("./sqlite-driver.js");
    await closeSqlite();
  }
  _pool = null;
}

/**
 * True when the active pool is a SQLite pool — needed by code
 * paths that touch sqlite-vec-only constructs (chunk_vec0 /
 * entity_vec0 / event_*_vec0 virtual tables). PG doesn't ship
 * those tables; running the INSERT against PG would throw an
 * "undefined table" error and abort the ingest.
 *
 * Callers MUST have called `await initPool()` first; before that
 * we fall back to the same env-var heuristic the pool builder
 * uses, which is good enough for the SQLite-only bundle path.
 */
export function isSqlitePool(): boolean {
  if (_pool) {
    // SqlitePool exposes a typed `.driver` marker; PgPool does not.
    const marker = (_pool as unknown as { driver?: string }).driver;
    if (marker === "sqlite") return true;
    if (marker === "pg") return false;
  }
  return !process.env.DATABASE_URL;
}

// Force the pool to re-open its connections. Needed after a migration that
// rebuilds a table (SQLite prepared-statement caches hold stale schema).
export async function resetPool(): Promise<void> {
  await closePool();
  await initPool();
}
