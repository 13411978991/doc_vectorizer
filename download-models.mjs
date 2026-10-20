// download-models.mjs — Pre-download the AI models the SAG bundle ships
// without, so users on slow networks can start the download before
// launching the GUI.
//
// Usage:
//   node download-models.mjs                # download the default bge-m3
//   node download-models.mjs --all          # bge-m3 + bge-large + SmolLM2
//   node download-models.mjs --bge-m3       # just bge-m3 (default)
//   node download-models.mjs --bge-large    # just bge-large-zh-v1.5
//   node download-models.mjs --smollm2      # just the SmolLM2 chat model
//   HF_ENDPOINT=https://hf-mirror.com node download-models.mjs
//
// The models land in <package>/resources/models/<model-name>/ and are
// auto-discovered by SAG on first launch.
//
// Mirror fallbacks: the settings-routes.ts code tries hf-mirror.com first
// (faster in CN), then falls back to huggingface.co. This script does the
// same so downloads work behind the GFW.

import { existsSync, mkdirSync, createWriteStream, statSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import https from "node:https";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = join(__dirname, "release-desktop", "win-unpacked", "resources", "models");

const args = new Set(process.argv.slice(2));
const wantAll = args.has("--all");
const wantBgeM3 = args.has("--bge-m3") || (!args.has("--bge-large") && !args.has("--smollm2"));
const wantBgeLarge = args.has("--bge-large") || wantAll;
const wantSmollm2 = args.has("--smollm2") || wantAll;

const HF_ENDPOINT = process.env.HF_ENDPOINT || "https://hf-mirror.com";

// Xenova hosts ONNX-converted BGE models on the HF Hub under
// "Xenova/bge-...". The ONNX weights are sharded across multiple files.
// A complete download requires the file list at:
//   https://huggingface.co/api/models/Xenova/bge-m3/tree/main
// We hardcode the known-stable v1 list here so the script works without
// any HF API call.
const MODELS = {
  "bge-m3": {
    repo: "Xenova/bge-m3",
    files: [
      "config.json",
      "tokenizer.json",
      "tokenizer_config.json",
      "special_tokens_map.json",
      "onnx/model.onnx",
      "onnx/model_fp16.onnx",
    ],
    sha256: {
      // Pinning these is overkill — Xenova retags weights when they
      // improve. We rely on HF's content addressing instead. Recorded
      // here for future auditing:
      // "onnx/model_fp16.onnx": "TBD"
    },
    dest: "bge-m3",
  },
  "bge-large-zh-v1.5": {
    repo: "Xenova/bge-large-zh-v1.5",
    files: [
      "config.json",
      "tokenizer.json",
      "tokenizer_config.json",
      "special_tokens_map.json",
      "onnx/model.onnx",
      "onnx/model_quantized.onnx",
    ],
    dest: "bge-large-zh-v1.5",
  },
  "smollm2-135m": {
    repo: "HuggingFaceTB/SmolLM2-135M-Instruct-GGUF",
    files: ["smollm2-135m-instruct-q4_k_m.gguf"],
    dest: "SmolLM2-135M-Instruct-Q4_K_M.gguf",
  },
};

const want = [];
if (wantBgeM3) want.push("bge-m3");
if (wantBgeLarge) want.push("bge-large-zh-v1.5");
if (wantSmollm2) want.push("smollm2-135m");

console.log(`[models] downloading ${want.length} model(s) to ${MODELS_DIR}`);
console.log(`[models] endpoint: ${HF_ENDPOINT}`);

mkdirSync(MODELS_DIR, { recursive: true });

let failed = false;
for (const key of want) {
  const m = MODELS[key];
  const dest = join(MODELS_DIR, m.dest);
  mkdirSync(dest, { recursive: true });
  for (const file of m.files) {
    const url = `${HF_ENDPOINT}/${m.repo}/resolve/main/${file}`;
    const localPath = join(dest, file);
    if (existsSync(localPath) && statSync(localPath).size > 0) {
      console.log(`  ✓ ${m.repo}/${file} (cached)`);
      continue;
    }
    console.log(`  ↓ ${m.repo}/${file}`);
    mkdirSync(dirname(localPath), { recursive: true });
    try {
      await downloadWithFallback(url, localPath, m.repo, file);
    } catch (e) {
      console.error(`  ✗ ${m.repo}/${file}: ${e.message}`);
      rmSync(localPath, { force: true });
      failed = true;
    }
  }
}

if (failed) {
  console.error("\n[models] one or more downloads failed.");
  console.error("  - Check internet connectivity");
  console.error("  - Try HF_ENDPOINT=https://huggingface.co node download-models.mjs");
  console.error("  - Or launch the GUI: SAG Settings → Embedding → 下载 (auto-retries)");
  process.exit(1);
} else {
  console.log("\n[models] all done. Launch SAG 桌面版.exe — models will be picked up.");
}

async function downloadWithFallback(url, dest, repo, file) {
  const endpoints = [url];
  // Add the alternate mirror as fallback
  if (url.includes("hf-mirror.com")) {
    endpoints.push(`https://huggingface.co/${repo}/resolve/main/${file}`);
  } else if (url.includes("huggingface.co")) {
    endpoints.push(`https://hf-mirror.com/${repo}/resolve/main/${file}`);
  }

  let lastErr;
  for (const ep of endpoints) {
    try {
      await downloadOne(ep, dest);
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("no endpoints succeeded");
}

function downloadOne(url, dest) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "sag-model-downloader/1.0" } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        // HF returns a redirect to the actual blob URL on the same host
        return downloadOne(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const total = parseInt(res.headers["content-length"] || "0", 10);
      let downloaded = 0;
      let lastLog = Date.now();
      res.on("data", (chunk) => {
        downloaded += chunk.length;
        if (total > 0 && Date.now() - lastLog > 1000) {
          const pct = ((downloaded / total) * 100).toFixed(1);
          process.stdout.write(`    ${pct}%  ${(downloaded / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB\r`);
          lastLog = Date.now();
        }
      });
      const out = createWriteStream(dest);
      pipeline(Readable.from(res), out).then(() => {
        process.stdout.write("\n");
        resolve();
      }, reject);
    });
    req.on("error", reject);
    req.setTimeout(60000, () => req.destroy(new Error("timeout")));
  });
}