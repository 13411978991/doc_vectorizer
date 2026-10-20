/**
 * Shared model-path resolver used by every local-model loader
 * (BGE embedding, GGUF LLM, ONNX NER). Extracted from
 * `embedding-client.ts:554 resolveLocalModelPath()` in Plan B so all
 * three loaders go through the same candidate order and produce the
 * same "model not found" error message.
 *
 * Why a shared helper:
 *   - the SEA build needs each loader to resolve `<exeDir>/resources/<path>`
 *     vs `<exeDir>/<path>` vs `<cwd>/<path>` consistently
 *   - the diagnostic message listing every tried path is identical for
 *     all three loaders, so users get the same shape of error no matter
 *     which pipeline failed
 *   - tests for the resolver cover all three loaders without each
 *     having to re-define the same fixture paths
 *
 * NOT a router: callers still call `_transformers.pipeline("task", ...)`
 * themselves. This helper just resolves the absolute path and tells
 * them which model-file variants exist.
 */
import { existsSync, statSync, readdirSync } from "node:fs";
import * as path from "node:path";

/**
 * Resolve a user-supplied model path to an absolute directory path.
 * Tries, in order:
 *   1. Absolute path (operator hand-edited a custom location) — must
 *      exist as a directory, otherwise falls through to the relative
 *      candidates so an operator who moved their model can still
 *      point at the old name.
 *   2. `<exeDir>/resources/<modelPath>` — the SEA production layout.
 *   3. `<exeDir>/<modelPath>` — dev / out-of-tree layout.
 *   4. `<cwd>/<modelPath>` — legacy fallback for `npm run` scripts
 *      and unit tests.
 *
 * The first candidate that exists AND is a directory wins. If none
 * match, throws with a clear "model not found" message listing every
 * path that was tried.
 */
export function resolveLocalModelPath(modelPath: string): string {
  const candidates: string[] = [];
  if (path.isAbsolute(modelPath)) {
    candidates.push(modelPath);
  }
  const exeDir = path.dirname(process.execPath);
  candidates.push(
    path.join(exeDir, "resources", modelPath),
    path.join(exeDir, modelPath),
    path.resolve(modelPath)
  );
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(
    `local model directory not found. Tried:\n` +
      candidates.map((c) => `  - ${c}`).join("\n") +
      `\nFix: re-download the model from Settings → Models.`
  );
}

/**
 * Score a candidate .onnx weight filename so the loader prefers the
 * variant most operators actually want to ship. Higher score wins.
 *
 * Preference order:
 *   1. quantised variants over fp32 (consumer-GPU friendly)
 *   2. shorter filenames over longer ones when both quantised
 *      variants exist (model_int8 over model_int8_optimized)
 *   3. fp16 / fp32 fall back as the last resort
 *
 * The score is purely advisory — any positive number works, so new
 * upstream filenames that don't match the heuristics still load, they
 * just sit at the bottom of the ranking.
 *
 * NER models (bert-base-chinese-ner, roberta-base-chinese-ner) ship
 * quantised variants too, so the same heuristic applies.
 */
export function scoreOnnxFile(filename: string): number {
  const stem = filename.replace(/\.onnx$/, "").toLowerCase();
  if (/(int8|uint8|q4|q8|quantized|quantised|quant)/.test(stem)) {
    // quantised variants — model_int8 (8 chars) beats
    // model_int8_optimized (19 chars) because we sort by score DESC
    // and shorter stems get a higher score.
    return 1000 - stem.length;
  }
  if (/(fp16|fp32|float)/.test(stem)) {
    return 100 - stem.length;
  }
  // Unrecognised filename (e.g. a new upstream rename): still
  // pickable, just lowest priority.
  return 1;
}

/**
 * Pick the best ONNX weight file for a model. Returns the bare stem
 * (no `.onnx`) so the caller can hand it to
 * `_transformers.pipeline(..., { model_file_name })`.
 *
 * Scans `<absoluteModelPath>/<basename>/onnx/*.onnx` and returns the
 * highest-scoring variant. If no .onnx files exist, returns
 * "model_int8" — the default @xenova/transformers name, which will
 * produce a standard error if the file isn't actually there.
 */
export function pickBestOnnxFile(absoluteModelPath: string): string {
  const basename = path.basename(absoluteModelPath);
  const parentDir = path.dirname(absoluteModelPath);
  let onnxFileName: string | undefined;
  try {
    const onnxDir = path.join(parentDir, basename, "onnx");
    const files = readdirSync(onnxDir);
    const onnxFiles = files.filter((f) => f.endsWith(".onnx"));
    if (onnxFiles.length > 0) {
      onnxFileName = onnxFiles.sort((a, b) => scoreOnnxFile(b) - scoreOnnxFile(a))[0]
        .replace(/\.onnx$/, "");
    }
  } catch {
    /* directory unreadable; let pipeline loader fail with the standard error */
  }
  return onnxFileName ?? "model_int8";
}

/**
 * Convenience: returns true when the resolved model path exists and
 * contains a `tokenizer.json` + an `onnx/` directory. The Web UI
 * uses this to tell "fully installed" from "half-downloaded" without
 * having to actually load the pipeline.
 */
export function isModelInstalled(modelPath: string): boolean {
  try {
    const absolute = resolveLocalModelPath(modelPath);
    const basename = path.basename(absolute);
    const tokenizerPath = path.join(absolute, "tokenizer.json");
    const onnxDir = path.join(absolute, "onnx");
    return (
      existsSync(tokenizerPath) &&
      existsSync(onnxDir) &&
      statSync(onnxDir).isDirectory()
    );
  } catch {
    return false;
  }
}