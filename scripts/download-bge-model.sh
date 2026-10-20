#!/usr/bin/env bash
# Download Xenova/bge-large-zh-v1.5 ONNX model for SAG local-bge embedding.
#
# Usage:
#   ./scripts/download-bge-model.sh                  # downloads to ./models/bge-large-zh-v1.5
#   MODEL_DIR=/path/to/dir ./scripts/download-bge-model.sh
#   HF_ENDPOINT=https://hf-mirror.com ./scripts/download-bge-model.sh  # China mirror
#
# Picks the int8 quantised variant (matches the 1024-dim DB schema and is
# ~4x smaller / faster than fp32 with negligible accuracy loss).

set -euo pipefail

MODEL_REPO="Xenova/bge-large-zh-v1.5"
MODEL_DIR="${MODEL_DIR:-$(cd "$(dirname "$0")/.." && pwd)/models/bge-large-zh-v1.5}"
HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}"

if [ -d "${MODEL_DIR}/onnx" ] && [ -f "${MODEL_DIR}/onnx/model_int8.onnx" ]; then
  echo "Model already present at ${MODEL_DIR}"
  echo "  - onnx/model_int8.onnx  $(du -h "${MODEL_DIR}/onnx/model_int8.onnx" | cut -f1)"
  exit 0
fi

mkdir -p "${MODEL_DIR}/onnx"
BASE="${HF_ENDPOINT}/${MODEL_REPO}/resolve/main"

echo "==> Downloading BGE ONNX model from ${HF_ENDPOINT}"
echo "    target: ${MODEL_DIR}"

# small config / tokenizer files — fast, parallel
for f in config.json tokenizer.json tokenizer_config.json special_tokens_map.json vocab.txt; do
  ( curl -fSL -o "${MODEL_DIR}/${f}" "${BASE}/${f}" && echo "  ✓ ${f}" ) &
done

# ~312 MB onnx weight — wait for it
curl -fSL --progress-bar -o "${MODEL_DIR}/onnx/model_int8.onnx" \
  "${BASE}/onnx/model_int8.onnx"
echo "  ✓ onnx/model_int8.onnx  $(du -h "${MODEL_DIR}/onnx/model_int8.onnx" | cut -f1)"

wait  # settle parallel jobs

echo
echo "==> Done. Now in SAG Settings → AI Provider:"
echo "    Embedding provider  = local-bge"
echo "    Local model path    = ${MODEL_DIR}"
