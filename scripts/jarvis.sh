#!/usr/bin/env bash
# Run voice mode inside its venv. All args pass through to jarvis.py
# (e.g. --text "…", --once, --no-tts). jarvis.py loads .env itself.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
venv="$root/scripts/.jarvis-venv"
[[ -x "$venv/bin/python" ]] || { echo "run scripts/jarvis-setup.sh first" >&2; exit 1; }
exec "$venv/bin/python" "$root/scripts/jarvis.py" "$@"
