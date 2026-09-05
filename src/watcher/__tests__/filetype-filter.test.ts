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

describe("shouldIncludeFile — blacklist priority", () => {
  it("excludes blacklisted extensions even if also in whitelist", () => {
    const result = shouldIncludeFile("foo.csv", {
      whitelist: [".csv", ".txt"],
      blacklist: [".csv"]
    });
    expect(result.include).toBe(false);
    expect(result.reason).toMatch(/blacklist/i);
  });

  it("matches blacklist case-insensitively", () => {
    const result = shouldIncludeFile("PHOTO.JPG", { blacklist: [".jpg"] });
    expect(result.include).toBe(false);
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

describe("shouldIncludeFile — no whitelist/blacklist", () => {
  it("includes everything when no filter is configured", () => {
    expect(shouldIncludeFile("a.pdf", {}).include).toBe(true);
    expect(shouldIncludeFile("README", {}).include).toBe(true);
  });

  it("includes everything when only an empty whitelist is set", () => {
    expect(shouldIncludeFile("a.pdf", { whitelist: [] }).include).toBe(true);
  });

  it("includes everything when only an empty blacklist is set", () => {
    expect(shouldIncludeFile("a.pdf", { blacklist: [] }).include).toBe(true);
  });
});

describe("shouldIncludeFile — extension normalization", () => {
  it("accepts whitelist entries without leading dot", () => {
    expect(shouldIncludeFile("a.md", { whitelist: ["md"] }).include).toBe(true);
  });

  it("accepts blacklist entries without leading dot", () => {
    expect(shouldIncludeFile("a.md", { blacklist: ["md"] }).include).toBe(false);
  });
});