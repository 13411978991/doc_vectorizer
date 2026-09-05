import type { FiletypeFilter } from "./types.js";

/**
 * Return the lowercase extension of a file path (including the leading dot),
 * or an empty string if none is present.
 */
export function getExtension(filePath: string): string {
  if (!filePath) {
    return "";
  }
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const basename = slash >= 0 ? filePath.slice(slash + 1) : filePath;
  const dot = basename.lastIndexOf(".");
  if (dot <= 0) {
    // No dot, or dotfile (".gitignore") — treat as no extension.
    return "";
  }
  return basename.slice(dot).toLowerCase();
}

/**
 * Decide whether a file should be ingested based on its extension and the filter.
 *
 * Resolution order (highest priority first):
 *   0. Files whose basename starts with `~` are always excluded — those
 *      are typically Office/Excel temp/lock files (e.g. `~$报告.docx`,
 *      `~$审计底稿.xlsx`) created when the source app has the file open.
 *      Ingesting them produces ghost documents that disappear the moment
 *      the user closes the file, which confuses the manifest. The user
 *      can still see them in the file tree (just not ingested).
 *   1. Blacklist → exclude immediately (no other rule matters).
 *   2. Whitelist (if set) → must include; otherwise exclude.
 *   3. Otherwise → include (extension itself is not gated).
 *
 * Note: file size is NOT checked here — the caller can apply `filter.maxBytes`
 * before calling this or before ingest, because we don't want to stat every file
 * just to evaluate a filter.
 */
export function shouldIncludeFile(
  filePath: string,
  filter: FiletypeFilter
): { include: boolean; reason?: string } {
  // Step 0: drop lockfile-style names. We strip the directory and look
  // at the basename only so `~` inside a folder name (e.g.
  // `/home/user/~backup/report.docx`) is still ingested.
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const basename = slash >= 0 ? filePath.slice(slash + 1) : filePath;
  if (basename.startsWith("~")) {
    return { include: false, reason: "hidden/lock file (basename starts with ~)" };
  }

  const ext = getExtension(filePath);

  if (filter.blacklist && filter.blacklist.length > 0) {
    const bl = filter.blacklist.map((e) => normalizeExt(e));
    if (ext && bl.includes(ext)) {
      return { include: false, reason: `extension ${ext} is blacklisted` };
    }
  }

  if (filter.whitelist && filter.whitelist.length > 0) {
    const wl = filter.whitelist.map((e) => normalizeExt(e));
    if (!ext || !wl.includes(ext)) {
      return { include: false, reason: `extension ${ext || "(none)"} not in whitelist` };
    }
  }

  return { include: true };
}

function normalizeExt(ext: string): string {
  const trimmed = ext.trim().toLowerCase();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}