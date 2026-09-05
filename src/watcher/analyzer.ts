import { createHash } from "node:crypto";
import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import pLimit from "p-limit";
import { logger } from "../observability/logger.js";
import { DEFAULT_SUPPORTED_EXTENSIONS, type WatchedFolderRecord } from "./types.js";
import { shouldIncludeFile } from "./filetype-filter.js";

/**
 * Cap concurrent SHA-1 hashes per scanFolder call. SHA-1 reads every file
 * end-to-end, so the wall-clock cost on a 27k-file folder used to be
 * 10–30 minutes when serialised. 8 is a sweet spot for SSD; the parallel
 * readdir above (DIR_CONCURRENCY=8) keeps the disk scheduler busy enough
 * that bumping the hash concurrency higher shows diminishing returns.
 */
const SCAN_CONCURRENCY = 8;

/**
 * A single file observed during a scan, including the metadata we need to
 * detect changes cheaply.
 */
export interface FileEntry {
  relPath: string;
  absPath: string;
  mtimeMs: number;
  inode: number;
  sizeBytes: number;
  sha1: string;
}

/**
 * Result of scanning a folder. Any relative path that was previously
 * indexed but is no longer present on disk lands in `deleted`.
 */
export interface ScanResult {
  added: FileEntry[];
  updated: FileEntry[];
  deleted: string[];
}

export interface ExistingManifestEntry {
  relPath: string;
  mtimeMs?: number | null;
  inode?: number | null;
  sizeBytes?: number | null;
  sha1?: string | null;
}

/**
 * Compute the SHA-1 hex digest of a file. We read once and stream the bytes
 * into the hash so large files don't blow up memory.
 */
export async function computeSha1(filePath: string): Promise<string> {
  const hash = createHash("sha1");
  const fh = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    while (true) {
      const { bytesRead } = await fh.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await fh.close();
  }
  return hash.digest("hex");
}

/**
 * Return the inode of a file. Wrapped so we can mock/stub it in tests,
 * and so we have a single place to deal with filesystems that don't expose
 * `ino` (e.g. Windows or some network mounts — we fall back to 0).
 */
export async function getInode(filePath: string): Promise<number> {
  const stat = await fs.stat(filePath);
  return Number.isFinite(stat.ino) ? Number(stat.ino) : 0;
}

/**
 * Recursively or non-recursively enumerate all files under `root`.
 * Returns absolute paths; the relative path is computed relative to `root`.
 *
 * Concurrency: directory listings are walked with bounded parallelism via
 * a work-queue. The old implementation was a serial DFS (`await visit(abs)`
 * for every subdirectory) — for a 27k-file repo spread across thousands of
 * directories, that linearised every readdir round-trip and made the scan
 * phase look "stuck". We now process directory nodes in parallel, bounded
 * to `DIR_CONCURRENCY` (8) so we don't fan out the disk scheduler on HDD.
 */
const DIR_CONCURRENCY = 8;

async function enumerateFiles(
  root: string,
  recursive: boolean
): Promise<{ absPath: string; relPath: string }[]> {
  const out: { absPath: string; relPath: string }[] = [];
  // Bounded queue: processDir keeps draining until there are no more
  // directories to visit. pLimit caps the in-flight directory reads.
  const limit = pLimit(DIR_CONCURRENCY);
  const queue: string[] = [root];
  const inFlight: Promise<void>[] = [];
  const seen = new Set<string>();

  const processDir = async (dir: string): Promise<void> => {
    if (seen.has(dir)) return;
    seen.add(dir);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      logger.warn({ dir, error: (error as Error).message }, "watcher: readdir failed, skipping directory");
      return;
    }
    // Pre-collect subdirs and files separately so we can queue subdirs
    // for parallel processing while files go straight into `out`.
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        continue; // don't follow symlinks — cycle risk
      } else if (entry.isDirectory()) {
        if (recursive) {
          queue.push(abs);
        }
      } else if (entry.isFile()) {
        out.push({
          absPath: abs,
          relPath: path.relative(root, abs).split(path.sep).join("/")
        });
      }
    }
  };

  // Drain the queue: pull the next dir off the queue, hand it to pLimit.
  // We don't await each processDir individually — instead we wait for the
  // queue to empty out by tracking in-flight work. The loop stops when
  // no tasks are scheduled and no directories remain.
  while (queue.length > 0 || inFlight.length > 0) {
    while (queue.length > 0 && inFlight.length < DIR_CONCURRENCY) {
      const next = queue.shift()!;
      const p = limit(() => processDir(next)).finally(() => {
        const idx = inFlight.indexOf(p);
        if (idx >= 0) inFlight.splice(idx, 1);
      });
      inFlight.push(p);
    }
    if (inFlight.length > 0) {
      // Wait for at least one in-flight task to finish so we can pull the
      // next directory off the queue. Promise.race is sufficient; we
      // don't need to await all of them.
      await Promise.race(inFlight);
    }
  }

  return out;
}

/**
 * Scan a folder and classify each file as added/updated/unchanged/deleted
 * against the manifest entries we already have on record.
 *
 * "Updated" includes the case where mtime/inode/size are unchanged but the
 * SHA-1 differs (e.g. a touched-up file or one where the OS rounded mtime).
 * This is the bug AnythingLLM hit in production — we explicitly re-check
 * SHA-1 even when mtime matches.
 */
export async function scanFolder(
  folder: WatchedFolderRecord,
  existing: ExistingManifestEntry[] = []
): Promise<ScanResult> {
  const root = folder.path;
  const onDisk = await enumerateFiles(root, folder.recursive);

  // Apply the same default-whitelist filter the ingest pipeline uses,
  // so we don't SHA-1 every game save and emoji file under a watched
  // folder that didn't set its own whitelist. Skipped files still
  // appear in `seenOnDisk` (so they don't get reported as deleted) but
  // they don't enter the `added`/`updated` buckets and don't waste a
  // hash read.
  const userFilter = folder.filetypeFilter ?? {};
  const effectiveFilter = userFilter.whitelist
    ? userFilter
    : { ...userFilter, whitelist: DEFAULT_SUPPORTED_EXTENSIONS };

  const existingByPath = new Map<string, ExistingManifestEntry>();
  for (const entry of existing) {
    existingByPath.set(entry.relPath, entry);
  }

  const seenOnDisk = new Set<string>();
  const result: ScanResult = { added: [], updated: [], deleted: [] };

  // Hash every file in parallel up to SCAN_CONCURRENCY at a time. We
  // materialise entries in the same order we received them so the
  // existing/added/updated partition is deterministic.
  const limit = pLimit(SCAN_CONCURRENCY);
  const resolved = await Promise.all(
    onDisk.map((file) =>
      limit(async () => {
        // Track as seen even if filtered, so it doesn't land in
        // `deleted` (we'd otherwise delete a perfectly valid game save
        // from the manifest every sync just to re-add it next time).
        seenOnDisk.add(file.relPath);
        const decision = shouldIncludeFile(file.relPath, effectiveFilter);
        if (!decision.include) {
          return { __skip: true as const, relPath: file.relPath };
        }
        let stat;
        try {
          stat = await fs.stat(file.absPath);
        } catch (error) {
          logger.warn({ file: file.absPath, error: (error as Error).message }, "watcher: stat failed, skipping");
          return null;
        }
        try {
          const sha1 = await computeSha1(file.absPath);
          const inode = Number.isFinite(stat.ino) ? Number(stat.ino) : 0;
          return {
            relPath: file.relPath,
            absPath: file.absPath,
            mtimeMs: Math.trunc(stat.mtimeMs),
            inode,
            sizeBytes: stat.size,
            sha1
          } as FileEntry;
        } catch (error) {
          logger.warn({ file: file.absPath, error: (error as Error).message }, "watcher: hash failed, skipping");
          return null;
        }
      })
    )
  );

  for (const entry of resolved) {
    if (!entry) continue;
    if ("__skip" in entry) continue;
    const prev = existingByPath.get(entry.relPath);
    if (!prev) {
      result.added.push(entry);
      continue;
    }
    if (hasChanged(prev, entry)) {
      result.updated.push(entry);
    }
  }

  // Anything that was in the manifest but not on disk has been deleted.
  for (const entry of existing) {
    if (!seenOnDisk.has(entry.relPath)) {
      result.deleted.push(entry.relPath);
    }
  }

  return result;
}

function hasChanged(prev: ExistingManifestEntry, next: FileEntry): boolean {
  // If we have a stored sha1, that's authoritative — compare it directly.
  // This catches the "restore" case where the OS reports the same mtime/inode/size
  // but the bytes actually differ (AnythingLLM hit this in production).
  if (prev.sha1 != null) {
    return prev.sha1 !== next.sha1;
  }
  // No sha1 on record (older manifest row or first-time sync) — fall back to
  // filesystem metadata. We can't detect content changes when all of these match.
  if (prev.mtimeMs != null && prev.mtimeMs !== next.mtimeMs) {
    return true;
  }
  if (prev.inode != null && prev.inode !== next.inode) {
    return true;
  }
  if (prev.sizeBytes != null && prev.sizeBytes !== next.sizeBytes) {
    return true;
  }
  // All three stored signals are absent. This is the "orphan" shape a
  // `markFailed` write leaves behind: size/sha1/mtime are all null
  // because markFailed only writes status + lastError. Without this
  // guard, scanFolder would never re-ingest such a row, so a one-time
  // failure would be silently permanent. Treat the row as stale and
  // force a re-ingest.
  if (prev.mtimeMs == null && prev.inode == null && prev.sizeBytes == null) {
    return true;
  }
  return false;
}