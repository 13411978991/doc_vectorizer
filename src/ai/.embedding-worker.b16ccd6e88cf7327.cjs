// dev-mode .ts resolution shim for the worker thread
const Module = require("node:module");
const path = require("node:path");
const fs = require("node:fs");
const origResolveFilename = Module._resolveFilename;
Module._resolveFilename = function patched(request, parent, ...rest) {
  try {
    return origResolveFilename.call(this, request, parent, ...rest);
  } catch (err) {
    if (request.startsWith(".") || request.startsWith("/")) {
      // Try .ts / .tsx / .mts / .cts siblings before propagating.
      const exts = [".ts", ".tsx", ".mts", ".cts"];
      for (const e of exts) {
        const tryPath = request.endsWith(".js") ? request.replace(/\.js$/, e) : request + e;
        try {
          return origResolveFilename.call(this, tryPath, parent, ...rest);
        } catch { /* keep going */ }
      }
    }
    throw err;
  }
};
// Auto-generated dev worker bundle — do not edit by hand.
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var stdin_exports = {};
module.exports = __toCommonJS(stdin_exports);
var import_node_worker_threads = require("node:worker_threads");
var import_node_path = __toESM(require("node:path"));
var import_node_fs = require("node:fs");
var transformers = __toESM(require("@xenova/transformers"));
var import_row_helpers = require("../db/row-helpers.js");
if (!import_node_worker_threads.parentPort) {
  throw new Error("embedding-worker must be spawned via worker_threads");
}
function log(level, msg, fields) {
  const ts = (0, import_row_helpers.toLocalISO)();
  const line = fields ? `${ts} [embedding-worker] ${level.toUpperCase()} ${msg} ${JSON.stringify(fields)}` : `${ts} [embedding-worker] ${level.toUpperCase()} ${msg}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
const env = transformers.env;
env.allowRemoteModels = false;
env.allowLocalModels = true;
let pipeline = null;
let tokenizer = null;
let currentModelPath = "";
async function loadModel(modelPath) {
  log("info", "loading model", { modelPath });
  let absoluteModelPath;
  if (import_node_path.default.isAbsolute(modelPath)) {
    absoluteModelPath = modelPath;
  } else {
    const exeDir = import_node_path.default.dirname(process.execPath);
    const candidates = [
      import_node_path.default.join(exeDir, "resources", modelPath),
      import_node_path.default.join(exeDir, modelPath),
      import_node_path.default.resolve(modelPath)
    ];
    const matched = candidates.find((c) => {
      try {
        return (0, import_node_fs.statSync)(c).isDirectory();
      } catch {
        return false;
      }
    });
    if (!matched) {
      throw new Error(
        `local BGE model directory not found. Tried:
` + candidates.map((c) => `  - ${c}`).join("\n") + `
Fix: re-download the model from Settings \u2192 Embedding \u2192 \u672C\u5730 BGE.`
      );
    }
    absoluteModelPath = matched;
    log("info", "resolved model path", { modelPath, absoluteModelPath });
  }
  const basename = import_node_path.default.basename(absoluteModelPath);
  const parentDir = import_node_path.default.dirname(absoluteModelPath);
  env.allowLocalModels = true;
  env.localModelPath = parentDir.replace(/\\/g, "/");
  const createPipeline = transformers.pipeline.bind(
    transformers
  );
  const fsPromises = await import("node:fs/promises");
  let onnxFileName;
  try {
    const onnxDir = import_node_path.default.join(parentDir, basename, "onnx");
    const files = await fsPromises.readdir(onnxDir);
    const candidates = ["model_int8", "model_uint8", "model_q4", "model_quantized"];
    onnxFileName = candidates.find((c) => files.includes(`${c}.onnx`));
  } catch {
  }
  pipeline = await createPipeline("feature-extraction", basename, {
    quantized: false,
    model_file_name: onnxFileName ?? "model_int8",
    local_files_only: true
  });
  const AutoTokenizer = transformers.AutoTokenizer;
  tokenizer = await AutoTokenizer.from_pretrained(basename, {
    quantized: false,
    local_files_only: true
  });
  currentModelPath = modelPath;
  log("info", "model loaded", { modelPath, dimHint: 1024 });
}
const BGE_MAX_TOKENS = 510;
async function truncateToTokenLimit(text) {
  if (!tokenizer) throw new Error("tokenizer not loaded");
  if (text.length <= 500) return text;
  const encodeOptions = { add_special_tokens: false };
  const ids = await tokenizer.encode(text, null, encodeOptions);
  if (ids.length <= BGE_MAX_TOKENS) return text;
  const ratio = text.length / ids.length;
  const upperChars = Math.min(text.length, Math.ceil(BGE_MAX_TOKENS * ratio * 0.9));
  let lo = 1;
  let hi = Math.max(1, upperChars);
  let best = "";
  let lastSlice = "";
  let lastTokens = Number.POSITIVE_INFINITY;
  while (lo <= hi) {
    const mid = lo + hi >> 1;
    let tokens;
    if (mid === lastSlice.length) {
      tokens = lastTokens;
    } else {
      lastSlice = text.slice(0, mid);
      const sliceIds = await tokenizer.encode(lastSlice, null, encodeOptions);
      lastTokens = sliceIds.length;
      tokens = lastTokens;
    }
    if (tokens <= BGE_MAX_TOKENS) {
      best = lastSlice;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best.trimEnd();
}
async function embedTexts(texts, dimensions) {
  if (texts.length === 0) return [];
  if (!pipeline) throw new Error("pipeline not loaded");
  const safeTexts = [];
  for (const text of texts) {
    safeTexts.push(await truncateToTokenLimit(text));
  }
  const results = [];
  try {
    const tensor = await pipeline(safeTexts, { pooling: "cls", normalize: true });
    const lastDim = tensor.dims[tensor.dims.length - 1] ?? 0;
    if (lastDim !== dimensions) {
      throw new Error(`local-bge output dim ${lastDim} != configured ${dimensions}`);
    }
    const flat = Array.from(tensor.data);
    for (let i = 0; i < safeTexts.length; i++) {
      const start = i * dimensions;
      results.push(flat.slice(start, start + dimensions));
    }
  } catch {
    for (const text of texts) {
      let tensor = null;
      try {
        tensor = await pipeline(await truncateToTokenLimit(text), {
          pooling: "cls",
          normalize: true
        });
      } catch {
        try {
          tensor = await pipeline(text.slice(0, 200), {
            pooling: "cls",
            normalize: true
          });
        } catch {
          results.push(new Array(dimensions).fill(0));
          continue;
        }
      }
      if (!tensor) {
        results.push(new Array(dimensions).fill(0));
        continue;
      }
      results.push(Array.from(tensor.data));
    }
  }
  return results;
}
import_node_worker_threads.parentPort.on("message", async (msg) => {
  try {
    if (msg.op === "load") {
      const t0 = Date.now();
      await loadModel(msg.modelPath);
      import_node_worker_threads.parentPort.postMessage({
        id: msg.id,
        op: msg.op,
        ok: true,
        loadMs: Date.now() - t0
      });
    } else if (msg.op === "embed") {
      if (!pipeline || currentModelPath !== msg.modelPath) {
        await loadModel(msg.modelPath);
      }
      const vectors = await embedTexts(msg.texts, msg.dimensions);
      import_node_worker_threads.parentPort.postMessage({ id: msg.id, op: msg.op, ok: true, vectors });
    } else if (msg.op === "ping") {
      import_node_worker_threads.parentPort.postMessage({ id: msg.id, op: msg.op, ok: true });
    }
  } catch (err) {
    log("error", "request failed", {
      op: msg.op,
      id: msg.id,
      err: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : void 0
    });
    import_node_worker_threads.parentPort.postMessage({
      id: msg.id,
      op: msg.op,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    });
  }
});
log("info", "worker booted, awaiting first 'load' command");
import_node_worker_threads.parentPort.postMessage({ op: "ready" });
