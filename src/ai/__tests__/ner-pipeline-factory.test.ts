/**
 * Plan B (2026-09-19): tests for the NER pipeline factory.
 *
 * Strategy: don't actually load an ONNX model (each test would
 * spend 5-15s and 100MB of memory). Instead, mock
 * `_transformers.pipeline` and verify the factory wires the right
 * arguments (model_file_name, local_files_only, etc.) and behaves
 * correctly on cache hit / dispose / model-path error.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the @xenova/transformers module so we don't have to ship a
// real ONNX model just for unit tests.
const mockPipelineFn = vi.fn();
vi.mock("@xenova/transformers", () => ({
  pipeline: (...args: unknown[]) => {
    mockPipelineFn(...args);
    return Promise.resolve(vi.fn());
  },
  env: {
    allowRemoteModels: false,
    allowLocalModels: false,
    localModelPath: ""
  }
}));

import {
  getLocalNerPipeline,
  disposeNerPipeline,
  getLoadedNerInfo
} from "../ner-pipeline-factory.js";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "ner-factory-test-"));
  // Create a minimal model directory with tokenizer.json + onnx/.
  // The factory needs to find these to resolve the path.
  const modelDir = path.join(workDir, "models", "fake-ner");
  mkdirSync(path.join(modelDir, "onnx"), { recursive: true });
  writeFileSync(path.join(modelDir, "tokenizer.json"), "{}");
  writeFileSync(path.join(modelDir, "onnx", "model_int8.onnx"), "fake weights");
  disposeNerPipeline();
  mockPipelineFn.mockClear();
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("getLocalNerPipeline", () => {
  it("A: returns the same pipeline on repeated calls (cached)", async () => {
    const modelPath = path.join(workDir, "models", "fake-ner");
    const first = await getLocalNerPipeline({ modelPath, maxTokens: 512 });
    const second = await getLocalNerPipeline({ modelPath, maxTokens: 512 });
    expect(first).toBe(second);
    // The underlying pipeline() factory should have been called
    // exactly once across both getLocalNerPipeline() invocations.
    expect(mockPipelineFn).toHaveBeenCalledTimes(1);
  });

  it("B: rebuilds the pipeline after disposeNerPipeline()", async () => {
    const modelPath = path.join(workDir, "models", "fake-ner");
    await getLocalNerPipeline({ modelPath, maxTokens: 512 });
    await disposeNerPipeline();
    await getLocalNerPipeline({ modelPath, maxTokens: 512 });
    expect(mockPipelineFn).toHaveBeenCalledTimes(2);
  });

  it("C: throws a clear error when the model path doesn't exist", async () => {
    await expect(
      getLocalNerPipeline({ modelPath: "/nonexistent/path/model" })
    ).rejects.toThrow(/local model directory not found/);
  });

  it("D: passes model_file_name=model_int8 when that variant exists", async () => {
    const modelPath = path.join(workDir, "models", "fake-ner");
    await getLocalNerPipeline({ modelPath, maxTokens: 512 });
    const opts = mockPipelineFn.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(opts.model_file_name).toBe("model_int8");
    expect(opts.local_files_only).toBe(true);
  });

  it("E: picks the better-scored onnx file when multiple are present", async () => {
    const modelDir = path.join(workDir, "models", "multi-onnx");
    mkdirSync(path.join(modelDir, "onnx"), { recursive: true });
    writeFileSync(path.join(modelDir, "tokenizer.json"), "{}");
    // Both fp32 and int8 are present — int8 should win.
    writeFileSync(path.join(modelDir, "onnx", "model_fp32.onnx"), "x");
    writeFileSync(path.join(modelDir, "onnx", "model_int8.onnx"), "x");
    await getLocalNerPipeline({ modelPath: modelDir, maxTokens: 512 });
    const opts = mockPipelineFn.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(opts.model_file_name).toBe("model_int8");
  });
});

describe("getLoadedNerInfo", () => {
  it("A: returns null when nothing is loaded yet", () => {
    disposeNerPipeline();
    expect(getLoadedNerInfo()).toBeNull();
  });

  it("B: returns the live model path + config after a successful load", async () => {
    const modelPath = path.join(workDir, "models", "fake-ner");
    await getLocalNerPipeline({ modelPath, maxTokens: 256 });
    const info = getLoadedNerInfo();
    expect(info).not.toBeNull();
    expect(info?.modelPath).toBe(modelPath);
    expect(info?.maxTokens).toBe(256);
    expect(info?.aggregationStrategy).toBe("simple");
  });
});