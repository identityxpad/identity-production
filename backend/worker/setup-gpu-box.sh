#!/usr/bin/env bash
# One-time setup on a rented GPU machine (Ubuntu image with the CUDA toolkit, e.g. a Vast.ai
# "nvidia/cuda:12.x-devel" template). Run from the worker/ folder:  bash setup-gpu-box.sh
set -euo pipefail

echo "== GPUs =="
nvidia-smi --query-gpu=index,name,memory.total --format=csv

echo "== Rust + vanity (GPU build) =="
[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"
if ! command -v cargo >/dev/null; then
  # -4: many rented boxes have broken IPv6, which makes these downloads hang
  curl -4 --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  source "$HOME/.cargo/env"
fi
command -v nvcc >/dev/null || { echo "nvcc not found: pick an image with the CUDA *devel* toolkit"; exit 1; }
command -v vanity >/dev/null || cargo install vanity --features=gpu

echo "== Node 20 =="
if ! command -v node >/dev/null; then
  curl -4 -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "== Worker =="
npm install
npm run build

echo "== Quick benchmark: 6-letter pattern on GPU 0 (case-insensitive) =="
# Real keypair grinding runs ~300-400M attempts/sec per RTX 5090. Put the number you see
# into GPU_RATE in the API's env so the live ETAs are accurate.
CUDA_VISIBLE_DEVICES=0 vanity grind-keypair --pattern doginu --case-insensitive --num-gpus 1 | grep -E "attempts|match" || true

echo
echo "Done. Fill in worker.env, then start both GPUs with:  bash run-workers.sh"
