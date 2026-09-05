/**
 * row-helpers.ts — Shared row→record conversion utilities.
 *
 * PG returns Date objects for timestamp columns; SQLite returns strings. We
 * normalize here so callers can use the same code path regardless of backend.
 */

/**
 * Parse a SQLite timestamp string (from `current_timestamp` or a TIMESTAMP
 * column) as a UTC Date. `new Date('YYYY-MM-DD HH:MM:SS')` without a
 * timezone is interpreted as LOCAL time, but SQLite's `current_timestamp`
 * returns UTC, which would shift the displayed time by the server's
 * timezone offset. Appending "Z" forces UTC parsing.
 */
export function parseSqliteTimestamp(v: string): Date {
  // SQLite `current_timestamp` returns 'YYYY-MM-DD HH:MM:SS' in UTC.
  // Some columns (e.g. last_sync_started_at) are written from JS as full
  // ISO 8601 with timezone offset; pass those through unchanged.
  if (v.includes("T") || /[zZ]|[+-]\d{2}:?\d{2}$/.test(v)) {
    return new Date(v);
  }
  return new Date(v.replace(" ", "T") + "Z");
}

/**
 * Format a Date as an ISO 8601 string in local time (UTC+8).
 * Unlike `Date.toISOString()` which always returns UTC with a "Z" suffix,
 * this returns the local time with a "+08:00" offset.
 */
export function toLocalISO(d: Date = new Date()): string {
  // Compute offset in minutes (UTC+8 = 480)
  const offsetMin = -d.getTimezoneOffset();
  const offH = String(Math.floor(Math.abs(offsetMin) / 60)).padStart(2, "0");
  const offM = String(Math.abs(offsetMin) % 60).padStart(2, "0");
  const sign = offsetMin >= 0 ? "+" : "-";
  const Y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, "0");
  const D = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${Y}-${M}-${D}T${h}:${m}:${s}.${ms}${sign}${offH}:${offM}`;
}

export function toIsoString(v: Date | string | number | null | undefined): string {
  if (v === null || v === undefined) return toLocalISO(new Date(0));
  if (v instanceof Date) return toLocalISO(v);
  if (typeof v === "string") return v.includes("T") ? v : v; // assume already ISO-ish
  // SQLite can return numbers for unix timestamps.
  return toLocalISO(new Date(v));
}

export function toIsoStringOrNull(v: Date | string | number | null | undefined): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return toLocalISO(v);
  return String(v);
}

export function parseJsonArray<T>(v: unknown): T[] {
  if (!v) return [];
  if (Array.isArray(v)) return v as T[];
  if (typeof v === "string") {
    try { return JSON.parse(v) as T[]; } catch { return []; }
  }
  return [];
}

export function parseJsonObject(v: unknown): Record<string, unknown> {
  if (!v) return {};
  if (typeof v === "object" && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch { /* fallthrough */ }
  }
  return {};
}