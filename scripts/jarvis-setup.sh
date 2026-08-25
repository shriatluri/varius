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
echo "prefetching whisper + wake-word models (one-time download)…"
"$venv/bin/python" - "$model" <<'EOF'
import sys
from faster_whisper import WhisperModel
WhisperModel(sys.argv[1], device="cpu", compute_type="int8")
import openwakeword.utils
openwakeword.utils.download_models()
print("models cached.")
EOF

cat <<EOF

Setup done — no accounts or keys needed. Next:
  1. Smoke test without a mic:   scripts/jarvis.sh --text "research say hi" --no-tts
  2. Live ("hey jarvis"):        scripts/jarvis.sh          (grant mic access when asked)
  3. Custom "varius" wake word:  train a .onnx (docs/VOICE.md), then
                                 JARVIS_WAKEWORD=scripts/varius.onnx in .env
  4. Always-on: see docs/VOICE.md for the launchd install.
EOF
