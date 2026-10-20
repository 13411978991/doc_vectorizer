import { describe, expect, it } from "vitest";
import { getExtension, shouldIncludeFile } from "../filetype-filter.js";

describe("getExtension", () => {
  it("returns lowercase extension with dot for normal files", () => {
    expect(getExtension("foo/bar/baz.PDF")).toBe(".pdf");
    expect(getExtension("a/b/c.MD")).toBe(".md");
  });

  it("returns empty string for files with no extension", () => {
    expect(getExtension("README")).toBe("");
    expect(getExtension("a/b/Makefile")).toBe("");
  });

  it("treats dotfiles as having no extension", () => {
    expect(getExtension(".gitignore")).toBe("");
    expect(getExtension("/tmp/.env")).toBe("");
  });

  it("uses the last dot for files with multiple dots", () => {
    expect(getExtension("archive.tar.gz")).toBe(".gz");
    expect(getExtension("/tmp/foo.bar.baz")).toBe(".baz");
  });

  it("handles windows-style separators", () => {
    expect(getExtension("C:\\Users\\me\\file.DOCX")).toBe(".docx");
  });

  it("returns empty string for empty input", () => {
    expect(getExtension("")).toBe("");
  });
});

describe("shouldIncludeFile — whitelist behavior", () => {
  it("includes when extension is in whitelist", () => {
    expect(shouldIncludeFile("a.md", { whitelist: [".md", ".txt"] }).include).toBe(true);
    expect(shouldIncludeFile("a.md", { whitelist: [".MD"] }).include).toBe(true);
  });

  it("excludes when extension is not in whitelist", () => {
    const result = shouldIncludeFile("image.png", { whitelist: [".md", ".txt"] });
    expect(result.include).toBe(false);
    expect(result.reason).toMatch(/not in whitelist/i);
  });

  it("excludes files without an extension when whitelist is set", () => {
    const result = shouldIncludeFile("README", { whitelist: [".md"] });
    expect(result.include).toBe(false);
  });
});

describe("shouldIncludeFile — no whitelist", () => {
  it("includes everything when no filter is configured", () => {
    expect(shouldIncludeFile("a.pdf", {}).include).toBe(true);
    expect(shouldIncludeFile("README", {}).include).toBe(true);
  });

  it("includes everything when only an empty whitelist is set", () => {
    expect(shouldIncludeFile("a.pdf", { whitelist: [] }).include).toBe(true);
  });
});

describe("shouldIncludeFile — extension normalization", () => {
  it("accepts whitelist entries without leading dot", () => {
    expect(shouldIncludeFile("a.md", { whitelist: ["md"] }).include).toBe(true);
  });
});

describe("shouldIncludeFile — office document whitelist (default)", () => {
  // The watcher ships with a six-format default whitelist (xls/xlsx/
  // doc/docx/ppt/pptx). These cases guard that decision — adding a
  // non-office type to the whitelist should be a deliberate operator
  // action via the watched-folder UI.
  const defaultWhitelist = [".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx"];

  it("accepts all six office formats", () => {
    expect(shouldIncludeFile("a.DOC", { whitelist: defaultWhitelist }).include).toBe(true);
    expect(shouldIncludeFile("a.DOCX", { whitelist: defaultWhitelist }).include).toBe(true);
    expect(shouldIncludeFile("a.PPT", { whitelist: defaultWhitelist }).include).toBe(true);
    expect(shouldIncludeFile("a.PPTX", { whitelist: defaultWhitelist }).include).toBe(true);
    expect(shouldIncludeFile("a.XLS", { whitelist: defaultWhitelist }).include).toBe(true);
    expect(shouldIncludeFile("a.XLSX", { whitelist: defaultWhitelist }).include).toBe(true);
  });

  it("rejects markdown / pdf / txt / csv by default", () => {
    expect(shouldIncludeFile("a.md", { whitelist: defaultWhitelist }).include).toBe(false);
    expect(shouldIncludeFile("a.pdf", { whitelist: defaultWhitelist }).include).toBe(false);
    expect(shouldIncludeFile("a.txt", { whitelist: defaultWhitelist }).include).toBe(false);
    expect(shouldIncludeFile("a.csv", { whitelist: defaultWhitelist }).include).toBe(false);
  });
});

describe("shouldIncludeFile — lockfile-style names", () => {
  it("rejects Office temp files (basename starts with ~)", () => {
    const result = shouldIncludeFile("/tmp/~$报告.docx", { whitelist: [".docx"] });
    expect(result.include).toBe(false);
    expect(result.reason).toMatch(/lock file/i);
  });

  it("rejects lockfiles regardless of whitelist contents", () => {
    expect(shouldIncludeFile("~$audit.xlsx", {}).include).toBe(false);
  });

  it("does not reject a folder name starting with ~", () => {
    // The tilde rule only applies to the basename; a folder called
    // "~backup/report.docx" should still be ingested.
    const result = shouldIncludeFile("/home/u/~backup/report.docx", { whitelist: [".docx"] });
    expect(result.include).toBe(true);
  });
});
