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

/**
 * P0 — verify the DETAIL_KEYWORDS name-based filter was removed from
 * the Node fallback xlsx reader. Before 2026-10-15, files matching
 * 明细/台账/报表/记录/流水/汇总/汇总表 (or English variants) were
 * silently dropped to a placeholder chunk + 1 hallucinated event
 * regardless of size. Audit scenarios like 2019年信息安全审查问题
 * 汇总表2.xlsx / MES系统测试发现问题汇总表-最新版.xlsx were the
 * primary false-positive. The cost-control goal is preserved by the
 * row/col shape gate; the keyword filter was redundant and harmful.
 */
describe("convertFile — keyword filter removal", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sag-conv-keyword-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("no longer exports the DETAIL_KEYWORDS constant", async () => {
    const mod = await import("../file-converter.js");
    // Symbols starting with 'isDetail' or 'DETAIL_KEYWORDS' should
    // not be exported. We only assert the public surface; the
    // internal removal is verified by the absence of any name-based
    // skip in the markdown output below.
    const exportNames = Object.keys(mod);
    expect(exportNames).not.toContain("DETAIL_KEYWORDS");
    expect(exportNames).not.toContain("isDetailReportName");
  });

  it("does not skip a small xlsx whose name contains a former-keyword substring (e.g. 问题汇总表)", async () => {
    // A 3-row sheet (well under the default 200-row cap) named
    // "2019年信息安全审查问题汇总表" must NOT be replaced with the
    // placeholder chunk. The previous filter would emit
    // *(sheet skipped: detail-report keyword '汇总表' matched in
    // '2019年信息安全审查问题汇总表' — treated as detail data, not
    // vectorized)* regardless of how small the sheet was.
    const XLSXMod = await import("xlsx");
    const wsData: string[][] = [
      ["序号", "问题描述", "整改措施"],
      ["1", "MES 接口幂等性缺失", "增加 idempotency-key"],
      ["2", "审计日志未签名", "接入 HSM"],
      ["3", "权限复核缺失", "季度权限复核"]
    ];
    const ws = XLSXMod.utils.aoa_to_sheet(wsData);
    const wb = XLSXMod.utils.book_new();
    XLSXMod.utils.book_append_sheet(wb, ws, "2019年信息安全审查问题汇总表");
    const inputPath = join(dir, "MES系统测试发现问题汇总表-最新版.xlsx");
    const outputPath = join(dir, "out.md");
    XLSXMod.writeFile(wb, inputPath);

    const content = await convertFile(inputPath, outputPath);
    // The placeholder used to live in the markdown body. If the
    // keyword filter were still wired up, the content would be a
    // single line starting with "*(sheet skipped: detail-report".
    expect(content).not.toMatch(/detail-report keyword/);
    expect(content).not.toMatch(/sheet skipped.*treated as detail/);
    // The real cell data must survive the conversion.
    expect(content).toContain("MES 接口幂等性缺失");
    expect(content).toContain("审计日志未签名");
    expect(content).toContain("权限复核缺失");
  });
});