import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convertFile } from "../file-converter.js";

/**
 * The watcher converter is now in-process (no Python spawn). These tests
 * exercise the happy path for each supported extension plus a couple of
 * failure modes (missing input file, unsupported extension).
 */
describe("convertFile", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sag-conv-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("converts plain text with normalised line endings", async () => {
    const inputPath = join(dir, "in.txt");
    const outputPath = join(dir, "out.md");
    await writeFile(inputPath, "\uFEFFhello\r\nworld\r\n");

    const content = await convertFile(inputPath, outputPath);
    expect(content.trimEnd()).toBe("hello\nworld");
  });

  it("rejects when the input file does not exist", async () => {
    const inputPath = join(dir, "missing.txt");
    const outputPath = join(dir, "out.md");

    await expect(convertFile(inputPath, outputPath)).rejects.toThrow();
  });

  it("rejects unsupported extensions with a clear message", async () => {
    const inputPath = join(dir, "in.png");
    const outputPath = join(dir, "out.md");
    await writeFile(inputPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    await expect(convertFile(inputPath, outputPath)).rejects.toThrow(
      /OCR is intentionally not supported/
    );
  });

  it("parses a simple markdown table from CSV", async () => {
    const inputPath = join(dir, "in.csv");
    const outputPath = join(dir, "out.md");
    await writeFile(inputPath, "a,b,c\n1,2,3\n");

    const content = await convertFile(inputPath, outputPath);
    expect(content).toContain("| a | b | c |");
    expect(content).toContain("| --- | --- | --- |");
    expect(content).toContain("| 1 | 2 | 3 |");
  });

  it("writes the converted markdown to the output path", async () => {
    const inputPath = join(dir, "in.txt");
    const outputPath = join(dir, "out.md");
    await writeFile(inputPath, "hello");

    await convertFile(inputPath, outputPath);
    const { readFile } = await import("node:fs/promises");
    const written = await readFile(outputPath, "utf8");
    expect(written.trimEnd()).toBe("hello");
  });
});