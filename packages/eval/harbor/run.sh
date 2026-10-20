#!/bin/bash
# Runs the Terminal-Bench tasks of tasks.txt (or $TASKS) through Harbor and prints the report.
# Usage: JOB=name [AGENT=claude-code] [MODEL=anthropic/claude-haiku-5-5] [N=2] [K=1] [TASKS="a b"] \
#        [DATASET=path/to/terminal-bench] [JOBS=dir] bash run.sh
# Agency needs the Linux binaries in dist (bun scripts/build.ts --targets bun-linux-x64,bun-linux-x64-musl).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
: "${JOB:?JOB names the job}"
jobs=${JOBS:-$HOME/tb-jobs}
include=()
for task in ${TASKS:-$(cat "$here/tasks.txt")}; do include+=(-i "$task"); done
export PYTHONPATH="$here${PYTHONPATH:+:$PYTHONPATH}" PYTHONDONTWRITEBYTECODE=1
source=(-d terminal-bench@2.0)
[ -n "${DATASET:-}" ] && source=(-p "$DATASET")
harbor run "${source[@]}" "${include[@]}" \
  -a "${AGENT:-agency_agent:Agency}" -m "${MODEL:-anthropic/claude-haiku-5-5}" -n "${N:-2}" -k "${K:-1}" \
  --agent-setup-timeout-multiplier 4 --job-name "$JOB" -o "$jobs" -y \
  -r 2 --retry-include RuntimeError --retry-include NetworkConnectionError --retry-include AgentSetupTimeoutError
python3 "$here/report.py" "$jobs/$JOB"
