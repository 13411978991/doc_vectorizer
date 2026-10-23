import { describe, expect, it, afterEach } from "vitest";
import {
  DEFAULT_EXCLUDED_DIR_NAMES,
  isExcludedDirName,
  isExcludedDirPath,
  listExcludedDirNames,
  makeChokidarIgnoredPredicate
} from "../scan-exclusions.js";

const ORIGINAL_ENV = process.env.SAG_WATCHER_EXCLUDE_DIRS;

afterEach(() => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.SAG_WATCHER_EXCLUDE_DIRS;
  } else {
    process.env.SAG_WATCHER_EXCLUDE_DIRS = ORIGINAL_ENV;
  }
});

describe("scan-exclusions", () => {
  it("excludes the built-in system directories", () => {
    expect(isExcludedDirName("$RECYCLE.BIN")).toBe(true);
    expect(isExcludedDirName("System Volume Information")).toBe(true);
    expect(isExcludedDirName("node_modules")).toBe(true);
    expect(isExcludedDirName(".git")).toBe(true);
    expect(isExcludedDirName("$baksd")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isExcludedDirName("node_modules")).toBe(true);
    expect(isExcludedDirName("NODE_MODULES")).toBe(true);
    expect(isExcludedDirName("Node_Modules")).toBe(true);
    expect(isExcludedDirName("$recycle.bin")).toBe(true);
  });

  it("does not exclude ordinary business directories", () => {
    expect(isExcludedDirName("2026项目点")).toBe(false);
    expect(isExcludedDirName("工作记录")).toBe(false);
    expect(isExcludedDirName("Audit Reports")).toBe(false);
  });

  it("does not exclude on a substring match", () => {
    // "my-node_modules-backup" must NOT be excluded — only a whole
    // segment match counts, otherwise user data gets silently dropped.
    expect(isExcludedDirName("my-node_modules-backup")).toBe(false);
    expect(isExcludedDirName("node_modules_old")).toBe(false);
    expect(isExcludedDirName("git")).toBe(false);
    expect(isExcludedDirName("git_backup")).toBe(false);
  });

  it("checks the directory basename when given a directory path", () => {
    // isExcludedDirPath answers "is this directory itself excluded?",
    // so it inspects the last segment only. Segment-wide matching
    // lives in the chokidar predicate and relPathHasExcludedDir.
    expect(isExcludedDirPath("E:\\node_modules")).toBe(true);
    expect(isExcludedDirPath("E:\\a\\node_modules")).toBe(true);
    expect(isExcludedDirPath("E:\\my-node_modules")).toBe(false);
    expect(isExcludedDirPath("E:\\工作记录")).toBe(false);
  });

  it("honours operator additions via SAG_WATCHER_EXCLUDE_DIRS", () => {
    process.env.SAG_WATCHER_EXCLUDE_DIRS = "我的备份, Archive ";
    expect(isExcludedDirName("我的备份")).toBe(true);
    expect(isExcludedDirName("Archive")).toBe(true);
    // The built-ins still work.
    expect(isExcludedDirName("node_modules")).toBe(true);
  });

  it("ignores empty entries in SAG_WATCHER_EXCLUDE_DIRS", () => {
    process.env.SAG_WATCHER_EXCLUDE_DIRS = " , , ";
    expect(listExcludedDirNames().length).toBe(DEFAULT_EXCLUDED_DIR_NAMES.length);
  });

  describe("chokidar predicate", () => {
    it("matches excluded directories on a segment boundary", () => {
      const ignored = makeChokidarIgnoredPredicate();
      expect(ignored("E:\\node_modules")).toBe(true);
      expect(ignored("E:\\node_modules\\pkg\\index.js")).toBe(true);
      expect(ignored("E:\\a\\.git\\HEAD")).toBe(true);
      expect(ignored("E:\\$RECYCLE.BIN\\S-1-5-18")).toBe(true);
    });

    it("does not match excluded names embedded in a longer segment", () => {
      const ignored = makeChokidarIgnoredPredicate();
      expect(ignored("E:\\my-node_modules")).toBe(false);
      expect(ignored("E:\\node_modules_old")).toBe(false);
      expect(ignored("E:\\工作记录\\报告.docx")).toBe(false);
    });
  });
});
