#!/usr/bin/env bash
# Weekly cost/run summary from runs.jsonl (architecture.md §8).
# cost_usd is a notional API-equivalent figure on a subscription — a relative
# signal for which agent is heaviest, not an accounting number.
set -euo pipefail

log="$(cd "$(dirname "$0")/.." && pwd)/runs.jsonl"
[[ -f "$log" ]] || { echo "no runs.jsonl yet" >&2; exit 0; }

jq -s 'group_by(.agent) | map({
  agent: .[0].agent,
  runs: length,
  errors: map(select(.status == "error")) | length,
  cost: (map(.cost_usd // 0) | add)
})' "$log"
