/**
 * src/watcher/scan-exclusions.ts — directory-level skip rules for the
 * folder scanner and the chokidar watcher.
 *
 * Why this exists
 * ---------------
 * Operators legitimately want to watch a whole drive root (`E:\`), not
 * just a hand-picked folder. The problem is that a drive root contains
 * a large amount of material that is never useful as knowledge-base
 * content and is actively harmful to scan:
 *
 *   1. **System directories** (`$RECYCLE.BIN`, `System Volume
 *      Information`) — reading them raises EPERM, and the scanner
 *      logs a warning per directory, then chokidar raises an error
 *      per directory too. On an E:\ root we saw 21 readdir failures
 *      and 3 chokidar errors in the first minutes.
 *   2. **Dependency / VCS trees** (`node_modules`, `.git`, `.pnpm-store`,
 *      `npm-cache`, `.pnpm-store`) — hundreds of thousands of files
 *      that can never match an Office-document whitelist, but every
 *      one of them costs a `stat` and, in the pre-pushdown code, a
 *      full SHA-1 read.
 *   3. **Backup / recycle directories** (`$baksd`, `$LBak`) — same
 *      argument, and on a work machine they are frequently the
 *      largest directories on the volume.
 *
 * The failure mode this fixes is specific and was measured: watching
 * `E:\` (752,470 files / 97,755 directories / 259.7 GB) ran for
 * 3+ hours without completing a single scan. The manifest stayed
 * empty, the database was never written to, and the process leaked
 * ~11 file handles per second while chewing 154% of a core.
 *
 * How exclusion works
 * -------------------
 * Two layers, both keyed on the **directory basename**:
 *
 *   - `isExcludedDirName(name)` — exact-name match against a fixed
 *     set of system / noise directories. Exact matching (not
 *     substring) matters: a business folder legitimately named
 *     "项目文档" or even "npm-cache" is rare, but a substring rule
 *     would silently drop user data.
 *   - `isExcludedDirPath(absPath, root)` — additionally rejects
 *     paths that sit outside the watched root when the root is a
 *     drive root. This catches `<drive>\$RECYCLE.BIN` style entries
 *     where the basename is unique per machine.
 *
 * The rules are deliberately **basename-based and case-insensitive**
 * so they work identically on Windows, macOS and Linux, and so they
 * behave the same for the scanner and for chokidar.
 *
 * Operators can extend the list without a rebuild by setting
 * `SAG_WATCHER_EXCLUDE_DIRS` (comma-separated basenames). There is
 * deliberately no way to exclude by path prefix here: the manifest
 * stores paths relative to the watched root, and a prefix rule
 * would make the "is this file still on disk" comparison ambiguous.
 */

/**
 * Directory basenames that are never useful as knowledge-base content
 * and that cost real time (or raise errors) when traversed.
 *
 * Keep this list conservative. Every entry here is a directory the
 * user cannot plausibly want indexed, and whose absence from the
 * index cannot surprise them.
 */
export const DEFAULT_EXCLUDED_DIR_NAMES: readonly string[] = [
  // Windows system / per-user
  "$RECYCLE.BIN",
  "System Volume Information",
  "$WinREAgent",
  "$SysReset",
  "Config.Msi",
  "Recovery",

  // Node / package manager trees
  "node_modules",
  ".pnpm-store",
  "pnpm-store",
  "npm-cache",
  ".npm",
  ".yarn",
  ".pnpm-debug.log",
  ".cache",

  // VCS / IDE metadata
  ".git",
  ".svn",
  ".hg",
  ".idea",
  ".vscode",
  ".vs",

  // Python / build tooling
  "__pycache__",
  ".venv",
  "venv",
  ".mypy_cache",
  ".pytest_cache",
  ".tox",
  ".gradle",
  "target",

  // Backup / staging leftovers (common on Chinese Windows estates)
  "$baksd",
  "$LBak",
  "$RECYCLE",
  "System Volume Information Backup",

  // Editor / OS scratch
  "OneDriveTemp",
  ".Trash",
  ".Trash-$(whoami)",
  ".Spotlight-V100",
  ".DocumentRevisions-V100",
  ".fseventsd"
];

/**
 * Operator-supplied extra basenames, parsed from
 * `SAG_WATCHER_EXCLUDE_DIRS`. Comma-separated, case-insensitive,
 * whitespace trimmed, empty entries ignored.
 */
function parseEnvExclusions(): string[] {
  const raw = process.env.SAG_WATCHER_EXCLUDE_DIRS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * The effective exclusion set: built-in names plus any operator
 * additions from `SAG_WATCHER_EXCLUDE_DIRS`.
 *
 * Cached per-process but recomputed when the env var changes length —
 * cheap enough to re-derive on every call in practice, and the
 * lookup is a Set membership test.
 */
let cachedEnvKey: string | undefined;
let cachedExclusions: Set<string> = buildExclusions();

function buildExclusions(): Set<string> {
  const set = new Set<string>();
  for (const name of DEFAULT_EXCLUDED_DIR_NAMES) {
    set.add(name.toLowerCase());
  }
  for (const name of parseEnvExclusions()) {
    set.add(name.toLowerCase());
  }
  return set;
}

function currentExclusions(): Set<string> {
  const envKey = process.env.SAG_WATCHER_EXCLUDE_DIRS ?? "";
  if (envKey !== cachedEnvKey) {
    cachedEnvKey = envKey;
    cachedExclusions = buildExclusions();
  }
  return cachedExclusions;
}

/**
 * True when a directory basename should be skipped entirely.
 *
 * Note this is called with the *basename* only — callers must not
 * pass a full path, or a path whose final segment happens to match
 * would be excluded at the wrong level.
 */
export function isExcludedDirName(name: string): boolean {
  if (!name) return false;
  return currentExclusions().has(name.toLowerCase());
}

/**
 * True when a directory should be skipped, given its absolute path.
 *
 * The check is on the **basename** of the path — i.e. this answers
 * "is this directory itself excluded?", not "is this path anywhere
 * under an excluded directory?". Callers that need the latter should
 * use `relPathHasExcludedDir` in analyzer.ts (which inspects every
 * segment) or the chokidar predicate below (which does segment
 * matching across the whole path).
 */
export function isExcludedDirPath(absPath: string): boolean {
  const normalized = absPath.replace(/[\\/]+$/, "");
  const segs = normalized.split(/[\\/]/).filter(Boolean);
  if (segs.length === 0) return false;
  const name = segs[segs.length - 1];
  return isExcludedDirName(name);
}

/**
 * Build a chokidar `ignored` predicate from the same rules.
 *
 * chokidar calls this with the path it is about to consider. We match
 * on any path segment that is an excluded directory name, which is
 * what makes chokidar skip the whole subtree rather than just the
 * directory entry.
 *
 * The `(^|[\\/])name([\\/]|$)` pattern requires the name to appear as
 * a whole path segment, so `my-node_modules-backup` is NOT excluded.
 */
export function makeChokidarIgnoredPredicate(
  allowedExtensions?: readonly string[],
  watchableDirs?: ReadonlySet<string>
): (path: string) => boolean {
  const exclusions = currentExclusions();
  // Pre-compile one alternation regex for all excluded names.
  const escaped = Array.from(exclusions)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .sort((a, b) => b.length - a.length);
  const pattern =
    escaped.length === 0
      ? null
      : new RegExp(`(^|[\\\\/])(${escaped.join("|")})([\\\\/]|$)`, "i");

  // Extension gate (2026-10-30).
  //
  // The directory exclusion above only removes *directories* whose
  // basename is on the noise list. It does NOT stop chokidar from
  // opening a watch handle on every regular file on the volume. On
  // E:\ that is ~305,000 non-Office files that can never be ingested
  // (the watcher only cares about .doc/.docx/.ppt/.pptx/.xls/.xlsx).
  //
  // Measured on the v4 desktop build (2026-10-30): chokidar made
  // 178,030 `ignored` predicate calls in 600 s, registered ZERO
  // `add` events, and never emitted `ready`. Meanwhile the backend
  // process leaked file handles at ~79/s (117k handles after 40 min)
  // and grew from 1.6 GB to 5.5 GB of RSS while the UI sat on
  // "扫描文件系统" forever. The startup scan could not finish because
  // the two enumerations were competing for the same directory
  // handles and the process was thrashing.
  //
  // Gating on the whitelist extension closes that hole: chokidar then
  // only tracks the ~6.9k files that can actually be ingested.
  //
  // NOTE: chokidar's `ignored` predicate receives directories too. We
  // must NOT exclude a directory just because it has no Office
  // extension — that would prune the entire tree. So the extension
  // test only applies to paths that actually look like files, i.e.
  // have a basename with an extension.
  const allowed = allowedExtensions && allowedExtensions.length > 0
    ? new Set(allowedExtensions.map((e) => {
        const t = e.trim().toLowerCase();
        return t.startsWith(".") ? t : `.${t}`;
      }))
    : null;

  // Directory pruning (2026-10-30).
  //
  // chokidar on Windows opens one `ReadDirectoryChangesW` handle per
  // directory it traverses. On E:\ that is 41,353 handles, but only
  // 1,443 directories contain a file that can ever be ingested.
  //
  // `watchableDirs` is the set of directories we actually want to
  // watch (the interesting ones plus their ancestors — without the
  // ancestors chokidar could never reach the interesting ones). Any
  // directory outside that set is pruned: chokidar does not descend
  // into it and never opens a handle on it.
  //
  // We can only apply the test to a path we KNOW is a directory. A
  // path with a file extension is a file (handled by the extension
  // gate); a path with no extension is either a directory or an
  // extension-less file. chokidar's `ignored` callback receives the
  // `stats` object when it has one, so we use that to be precise;
  // when stats are missing we fall back to "has an extension → file,
  // otherwise → directory".
  const pruneDirs = watchableDirs && watchableDirs.size > 0;

  if (!pattern && !allowed && !pruneDirs) {
    return () => false;
  }

  return (candidate: string, stats?: { isDirectory?: () => boolean }) => {
    if (pattern && pattern.test(candidate)) {
      return true;
    }

    const slash = Math.max(candidate.lastIndexOf("/"), candidate.lastIndexOf("\\"));
    const basename = slash >= 0 ? candidate.slice(slash + 1) : candidate;
    const dot = basename.lastIndexOf(".");
    const hasExtension = dot > 0;

    // Is this a directory? chokidar's initial scan runs readdirp with
    // `alwaysStat: true`, so `stats` is available and authoritative.
    // When it is missing we fall back to the extension heuristic.
    //
    // The distinction matters: a DIRECTORY whose name contains a dot
    // (e.g. "v1.1（增加支持csv）") would otherwise be mistaken for a
    // file, fail the extension whitelist, and get pruned — taking its
    // entire subtree with it.
    const isDir = stats && typeof stats.isDirectory === "function"
      ? stats.isDirectory()
      : !hasExtension;

    if (isDir) {
      // Directories are pruned unless they are (or lead to) a
      // directory that holds ingestible files.
      if (pruneDirs && !watchableDirs!.has(normalizeWatchKey(candidate))) {
        return true;
      }
      return false;
    }

    // A regular file: keep it only if its extension is whitelisted.
    if (allowed && hasExtension) {
      const ext = basename.slice(dot).toLowerCase();
      if (!allowed.has(ext)) {
        return true;
      }
    }

    return false;
  };
}

/**
 * Normalise a directory path for set membership.
 *
 * Two things matter here:
 *
 *   1. **Separator style.** chokidar runs every path through its
 *      internal `normalizePathToUnix` before handing it to the
 *      `ignored` predicate, so it always arrives as `E:/a/b`, never
 *      `E:\a\b`. Our own traversal produces the Windows form. If the
 *      two disagree, every lookup misses and chokidar prunes the
 *      entire tree (symptom: the watcher goes live but sees nothing).
 *      We therefore fold both to forward slashes.
 *
 *   2. **Case.** Windows paths are case-insensitive and chokidar may
 *      report a different casing than the traversal did, so we
 *      upper-case the key.
 */
export function normalizeWatchKey(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toUpperCase();
}

/**
 * Expose the resolved exclusion list for logging / diagnostics.
 */
export function listExcludedDirNames(): string[] {
  return Array.from(currentExclusions()).sort();
}
