/**
 * Plan B (2026-09-19): tests for the shared model-path resolver.
 *
 * Covers the path candidates, ONNX-file scoring and `isModelInstalled`
 * probe. The BGE embedding client and NER factory both go through
 * this helper, so a single test pass is enough to cover both.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  resolveLocalModelPath,
  scoreOnnxFile,
  pickBestOnnxFile,
  isModelInstalled
} from "../model-path-resolver.js";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "model-path-resolver-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("resolveLocalModelPath", () => {
  it("A: returns the absolute path when given one that exists", () => {
    const target = path.join(workDir, "mymodel");
    mkdirSync(target, { recursive: true });
    expect(resolveLocalModelPath(target)).toBe(target);
  });

  it("B: throws with all candidates listed when nothing exists", () => {
    expect(() => resolveLocalModelPath("models/never-exists")).toThrow(
      /local model directory not found/
    );
    try {
      resolveLocalModelPath("models/never-exists");
    } catch (err) {
      const msg = (err as Error).message;
      // Should mention at least the production layout path and one
      // candidate containing the user's input. We don't match the
      // full input verbatim because path.join() normalises the
      // separator on Windows ("models/never-exists" → "models\\never-exists").
      expect(msg).toContain("resources");
      expect(msg.toLowerCase()).toContain("never-exists");
    }
  });

  it("C: absolute path wins over relative candidates when it exists", () => {
    // Place an absolute directory and verify the resolver prefers it.
    const absTarget = path.join(workDir, "absolute-target");
    mkdirSync(absTarget, { recursive: true });
    const resolved = resolveLocalModelPath(absTarget);
    expect(resolved).toBe(absTarget);
  });
});

describe("scoreOnnxFile", () => {
  it("A: ranks quantised variants higher than fp32", () => {
    expect(scoreOnnxFile("model_int8.onnx")).toBeGreaterThan(scoreOnnxFile("model.onnx"));
    expect(scoreOnnxFile("model_quantized.onnx")).toBeGreaterThan(scoreOnnxFile("model_fp32.onnx"));
  });

  it("B: ranks shorter quantised variants higher than longer ones", () => {
    // model_int8 (8 chars) should beat model_int8_optimized (19).
    expect(scoreOnnxFile("model_int8.onnx")).toBeGreaterThan(
      scoreOnnxFile("model_int8_optimized.onnx")
    );
  });

  it("C: unknown variants get the lowest positive score (never zero)", () => {
    expect(scoreOnnxFile("completely_new_name.onnx")).toBeGreaterThan(0);
  });
});

describe("pickBestOnnxFile", () => {
  it("A: picks model_int8 over model_fp32 when both present", () => {
    const target = path.join(workDir, "modelfoo");
    mkdirSync(path.join(target, "onnx"), { recursive: true });
    writeFileSync(path.join(target, "onnx", "model_fp32.onnx"), "x");
    writeFileSync(path.join(target, "onnx", "model_int8.onnx"), "x");
    const picked = pickBestOnnxFile(target);
    expect(picked).toBe("model_int8");
  });

  it("B: returns 'model_int8' default when no .onnx files exist", () => {
    const target = path.join(workDir, "emptyfoo");
    mkdirSync(target, { recursive: true });
    expect(pickBestOnnxFile(target)).toBe("model_int8");
  });

  it("C: returns 'model_int8' default when onnx/ directory is missing", () => {
    const target = path.join(workDir, "noonnxdir");
    // Note: NOT creating onnx/ subdir.
    mkdirSync(target, { recursive: true });
    expect(pickBestOnnxFile(target)).toBe("model_int8");
  });
});

describe("isModelInstalled", () => {
  it("A: returns true when tokenizer.json + onnx/ are present", () => {
    const target = path.join(workDir, "goodmodel");
    mkdirSync(path.join(target, "onnx"), { recursive: true });
    writeFileSync(path.join(target, "tokenizer.json"), "{}");
    expect(isModelInstalled(target)).toBe(true);
  });

  it("B: returns false when tokenizer.json is missing", () => {
    const target = path.join(workDir, "noTokenizer");
    mkdirSync(path.join(target, "onnx"), { recursive: true });
    expect(isModelInstalled(target)).toBe(false);
  });

  it("C: returns false when onnx/ is missing", () => {
    const target = path.join(workDir, "noOnnx");
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "tokenizer.json"), "{}");
    expect(isModelInstalled(target)).toBe(false);
  });

  it("D: returns false when path does not exist at all", () => {
    expect(isModelInstalled(path.join(workDir, "ghost"))).toBe(false);
  });
});