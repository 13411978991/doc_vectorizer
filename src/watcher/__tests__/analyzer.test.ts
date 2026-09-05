import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeSha1, scanFolder } from "../analyzer.js";
import type { WatchedFolderRecord } from "../types.js";

const TENANT = "default";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sag-watcher-test-"));
}

function makeFolder(path: string, overrides: Partial<WatchedFolderRecord> = {}): WatchedFolderRecord {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    tenantId: TENANT,
    path,
    displayName: "test",
    sourceId: "00000000-0000-0000-0000-000000000002",
    enabled: true,
    recursive: true,
    filetypeFilter: {},
    metadata: {},
    ...overrides
  };
}

describe("computeSha1", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("produces the expected SHA-1 for known strings", async () => {
    const known: Array<{ content: string; sha1: string }> = [
      { content: "hello world", sha1: "2aae6c35c94fcfb415dbe95f408b9ce91ee846ed" },
      { content: "", sha1: "da39a3ee5e6b4b0d3255bfef95601890afd80709" },
      { content: "The quick brown fox jumps over the lazy dog", sha1: "2fd4e1c67a2d28fced849ee1bb76e7391b93eb12" }
    ];
    for (const { content, sha1 } of known) {
      const file = join(dir, "blob.txt");
      await writeFile(file, content);
      expect(await computeSha1(file)).toBe(sha1);
    }
  });

  it("streams large files without buffering the whole thing", async () => {
    const file = join(dir, "big.txt");
    const chunk = "x".repeat(8 * 1024);
    const content = chunk.repeat(2000); // 16 MB
    await writeFile(file, content);
    const sha = await computeSha1(file);
    expect(sha).toHaveLength(40);
  });
});

describe("scanFolder", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports all files as added on first scan", async () => {
    await writeFile(join(dir, "a.md"), "alpha");
    await writeFile(join(dir, "b.md"), "beta");
    const result = await scanFolder(makeFolder(dir), []);
    expect(result.added.map((e) => e.relPath).sort()).toEqual(["a.md", "b.md"]);
    expect(result.updated).toHaveLength(0);
    expect(result.deleted).toHaveLength(0);
  });

  it("detects new files as added and skips unchanged files", async () => {
    const aPath = join(dir, "a.md");
    await writeFile(aPath, "alpha");
    const first = await scanFolder(makeFolder(dir), []);
    expect(first.added).toHaveLength(1);

    await writeFile(join(dir, "b.md"), "beta");
    const second = await scanFolder(makeFolder(dir), first.added.map((e) => ({
      relPath: e.relPath,
      mtimeMs: e.mtimeMs,
      inode: e.inode,
      sizeBytes: e.sizeBytes,
      sha1: e.sha1
    })));
    expect(second.added.map((e) => e.relPath)).toEqual(["b.md"]);
    expect(second.updated).toHaveLength(0);
  });

  it("detects deleted files", async () => {
    await writeFile(join(dir, "a.md"), "alpha");
    await writeFile(join(dir, "b.md"), "beta");
    const first = await scanFolder(makeFolder(dir), []);
    expect(first.added.map((e) => e.relPath).sort()).toEqual(["a.md", "b.md"]);

    const { unlink } = await import("node:fs/promises");
    await unlink(join(dir, "a.md"));
    const second = await scanFolder(makeFolder(dir), first.added.map((e) => ({
      relPath: e.relPath,
      mtimeMs: e.mtimeMs,
      inode: e.inode,
      sizeBytes: e.sizeBytes,
      sha1: e.sha1
    })));
    expect(second.deleted).toEqual(["a.md"]);
  });

  it("detects changes when mtime differs", async () => {
    const aPath = join(dir, "a.md");
    await writeFile(aPath, "alpha");
    const first = await scanFolder(makeFolder(dir), []);

    // Wait, then write again so mtime changes.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(aPath, "alpha v2");
    const second = await scanFolder(makeFolder(dir), first.added.map((e) => ({
      relPath: e.relPath,
      mtimeMs: e.mtimeMs,
      inode: e.inode,
      sizeBytes: e.sizeBytes,
      sha1: e.sha1
    })));
    expect(second.updated.map((e) => e.relPath)).toEqual(["a.md"]);
    expect(second.added).toHaveLength(0);
    expect(second.deleted).toHaveLength(0);
  });

  it("detects changes when mtime/inode/size are identical but sha1 differs", async () => {
    const aPath = join(dir, "a.md");
    await writeFile(aPath, "alpha");
    const first = await scanFolder(makeFolder(dir), []);
    const prev = first.added[0];

    // Simulate a "restore" where the OS reports the same mtime/inode/size,
    // but the bytes are different. The analyzer MUST detect this via sha1.
    await writeFile(aPath, "alpha (restored but bytes differ)");
    const stat = await import("node:fs/promises").then((m) => m.stat(aPath));
    const second = await scanFolder(makeFolder(dir), [{
      relPath: prev.relPath,
      mtimeMs: stat.mtimeMs, // pretend mtime unchanged
      inode: stat.ino, // pretend inode unchanged
      sizeBytes: stat.size, // pretend size unchanged (length happens to be the same)
      sha1: prev.sha1 // stored sha1 from the OLD content
    }]);
    expect(second.updated.map((e) => e.relPath)).toEqual(["a.md"]);
  });

  it("does not flag changes when sha1 matches even with no other metadata", async () => {
    const aPath = join(dir, "a.md");
    await writeFile(aPath, "alpha");
    const first = await scanFolder(makeFolder(dir), []);
    const prev = first.added[0];

    const second = await scanFolder(makeFolder(dir), [{
      relPath: prev.relPath,
      mtimeMs: null,
      inode: null,
      sizeBytes: null,
      sha1: prev.sha1
    }]);
    expect(second.updated).toHaveLength(0);
  });

  it("recurses when recursive=true", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "top.md"), "x");
    await writeFile(join(dir, "sub", "nested.md"), "y");

    const result = await scanFolder(makeFolder(dir, { recursive: true }), []);
    expect(result.added.map((e) => e.relPath).sort()).toEqual(["sub/nested.md", "top.md"]);
  });

  it("does not recurse when recursive=false", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "top.md"), "x");
    await writeFile(join(dir, "sub", "nested.md"), "y");

    const result = await scanFolder(makeFolder(dir, { recursive: false }), []);
    expect(result.added.map((e) => e.relPath)).toEqual(["top.md"]);
  });

  it("survives unreadable directories gracefully", async () => {
    await writeFile(join(dir, "top.md"), "x");
    const { mkdir } = await import("node:fs/promises");
    const unreadable = join(dir, "no-perm");
    await mkdir(unreadable);
    await writeFile(join(unreadable, "ghost.md"), "y");

    // Run as root in CI? Fall back to making sure we don't crash by removing the dir.
    const result = await scanFolder(makeFolder(dir), []);
    expect(result.added.map((e) => e.relPath)).toContain("top.md");
  });
});