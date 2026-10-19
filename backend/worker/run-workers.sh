#!/usr/bin/env bash
# Starts one worker per GPU on this machine and points them all at your API.
# Each worker claims jobs over HTTPS, grinds with `vanity`, and reports the sealed key back.
# No inbound ports are needed on this box, so it works on any rented Vast.ai machine.
#
# Splitting a box across lanes (optional):
#   COIN_GPUS=4   -> the first 4 GPUs take coin jobs only (LANE=coin)
#                    the rest take vanity wallet jobs only (LANE=wallet)
# Leave COIN_GPUS unset and every GPU serves whatever LANE says in worker.env
# (default 'any'), which is what you want on a single-purpose box.
set -euo pipefail
cd "$(dirname "$0")"
set -a; source ./worker.env; set +a

GPUS=$(nvidia-smi --query-gpu=index --format=csv,noheader | wc -l)
COIN_GPUS="${COIN_GPUS:-}"

if [ -n "$COIN_GPUS" ]; then
  echo "found $GPUS GPU(s); GPUs 0-$((COIN_GPUS - 1)) -> coin lane, the rest -> wallet lane"
else
  echo "found $GPUS GPU(s); all on lane ${LANE:-any}"
fi

mkdir -p logs
for i in $(seq 0 $((GPUS - 1))); do
  if [ -n "$COIN_GPUS" ]; then
    if [ "$i" -lt "$COIN_GPUS" ]; then GPU_LANE=coin; else GPU_LANE=wallet; fi
  else
    GPU_LANE="${LANE:-any}"
  fi
  GPU_ID=$i LANE=$GPU_LANE WORKER_ID="$(hostname)-gpu$i" \
    nohup node dist/worker.js >> "logs/gpu$i.log" 2>&1 &
  echo "  worker on GPU $i (lane: $GPU_LANE, log: logs/gpu$i.log)"
done

echo
echo "all workers started. watch them with:  tail -f logs/gpu*.log"
echo "stop them with:  pkill -f dist/worker.js"
