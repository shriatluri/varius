# VOICE.md — voice mode ("Jarvis") for the fleet

Say the wake word, speak a command, and it lands in the right agent's Slack
channel; the reply is read aloud. The bridge stays the hub — voice is just a
third *input* that posts a Slack message (architecture.md invariant 2 holds).
Runs on the **local Mac** (the mic lives here), not the VPS. Tracking: SHRI-13.

```
mic → Porcupine wake word → VAD capture → faster-whisper (local)
    → post to #<agent> via bot token → bridge/runner answer → `say` reads it
```

Privacy: everything before the wake word stays on-device; transcription is
local. The only network traffic is the Slack message itself.

## Setup

```bash
scripts/jarvis-setup.sh          # venv + deps + whisper model prefetch
```

Then in `.env` (see `.env.example`):

| Var | What |
|---|---|
| `PICOVOICE_ACCESS_KEY` | free key from console.picovoice.ai — required for listening |
| `JARVIS_KEYWORD` | stock wake word (default `jarvis`) |
| `JARVIS_KEYWORD_PATH` | custom `.ppn` (e.g. `scripts/varius.ppn`) — overrides the stock word |
| `JARVIS_DEFAULT_AGENT` | where unrouted speech goes (default `research`) |
| `JARVIS_WHISPER_MODEL` | `base.en` default; `tiny.en` faster, `small.en` more accurate |

Custom "varius" wake word: train it at console.picovoice.ai (Porcupine →
"varius" → macOS arm64), download the `.ppn` **for pvporcupine's installed
major version (v4)**, drop it at `scripts/varius.ppn` (gitignored), set
`JARVIS_KEYWORD_PATH=scripts/varius.ppn`.

## Use

```bash
scripts/jarvis.sh --list-agents                        # what's routable
scripts/jarvis.sh --text "research say hi" --no-tts    # no mic/key smoke test
scripts/jarvis.sh --once                               # one wake cycle
scripts/jarvis.sh                                      # listen forever
```

Routing: first word (or "ask/tell &lt;agent&gt;") names the agent — "varius,
research what changed in node 22" → `#research`. No agent named → the default.
Agents are discovered from `agents/*/agent.json` (interactive only), same as
the registry — a new agent folder is voice-routable with zero code.

Always-on: `deploy/jarvis.launchd.plist` (install instructions inside it).

## Requirements & caveats

- **The bridge must be running** or nothing answers (same as typing in Slack).
- Mac awake + mic permission (macOS prompts on first live run).
- Long replies: speaks the first ~700 chars, then "full reply is in Slack".
- `webrtcvad-wheels` provides VAD; if absent, falls back to RMS silence
  detection (works, slightly worse in noisy rooms).
