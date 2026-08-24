#!/usr/bin/env bash
# One-time setup for voice mode (scripts/jarvis.py). Creates a private venv,
# installs deps, and prefetches the whisper model so first wake isn't slow.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
venv="$root/scripts/.jarvis-venv"

python3 -m venv "$venv"
"$venv/bin/pip" install --quiet --upgrade pip
"$venv/bin/pip" install --quiet -r "$root/scripts/jarvis-requirements.txt"

model="${JARVIS_WHISPER_MODEL:-base.en}"
echo "prefetching whisper model '$model' (one-time download)…"
"$venv/bin/python" - "$model" <<'EOF'
import sys
from faster_whisper import WhisperModel
WhisperModel(sys.argv[1], device="cpu", compute_type="int8")
print("model cached.")
EOF

cat <<EOF

Setup done. Next:
  1. .env: set PICOVOICE_ACCESS_KEY (free key: console.picovoice.ai)
     Optional: JARVIS_KEYWORD_PATH=scripts/varius.ppn  JARVIS_DEFAULT_AGENT=research
  2. Smoke test without a mic:   scripts/jarvis.sh --text "research say hi" --no-tts
  3. Live:                       scripts/jarvis.sh          (grant mic access when asked)
  4. Always-on: see docs/VOICE.md for the launchd install.
EOF
