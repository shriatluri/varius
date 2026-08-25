# VOICE.md — voice mode ("Jarvis") for the fleet

Say the wake word, speak a command, and it lands in the right agent's Slack
channel; the reply is read aloud. The bridge stays the hub — voice is just a
third *input* that posts a Slack message (architecture.md invariant 2 holds).
Runs on the **local Mac** (the mic lives here), not the VPS. Tracking: SHRI-13.

```
mic → openWakeWord (on-device) → VAD capture → faster-whisper (local)
    → post to #<agent> via bot token → bridge/runner answer → `say` reads it
```

No accounts or keys beyond the existing Slack bot token. Everything before
the Slack post runs on-device; the wake word is `hey jarvis` (pretrained)
until a custom `varius` model is dropped in.

## Setup

```bash
scripts/jarvis-setup.sh          # venv + deps + whisper/wake models prefetch
```

Optional `.env` overrides (see `.env.example`):

| Var | What |
|---|---|
| `JARVIS_WAKEWORD` | pretrained name (default `hey_jarvis`) or path to a custom `.onnx` |
| `JARVIS_WAKE_THRESHOLD` | 0–1 detection score (default `0.5`; raise if it false-triggers) |
| `JARVIS_DEFAULT_AGENT` | where unrouted speech goes (default `research`) |
| `JARVIS_WHISPER_MODEL` | `base.en` default; `tiny.en` faster, `small.en` more accurate |
| `JARVIS_REPLY_TIMEOUT` | cap reply wait in seconds (default: the agent's own timeout) |

Custom "varius" wake word: openWakeWord models are trained for free in their
Colab notebook (github.com/dscripka/openWakeWord → "training new models" —
synthetic speech, ~an hour, no account). Save the result as
`scripts/varius.onnx` (gitignored) and set `JARVIS_WAKEWORD=scripts/varius.onnx`.

## Use

```bash
scripts/jarvis.sh --list-agents                        # what's routable
scripts/jarvis.sh --text "research say hi" --no-tts    # mic-free smoke test
scripts/jarvis.sh --wake-test clip.wav                 # peak wake score for a wav
scripts/jarvis.sh --once                               # one wake cycle
scripts/jarvis.sh                                      # listen forever
```

Routing: first word (or "ask/tell &lt;agent&gt;") names the agent — "hey jarvis,
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
- The bridge accepts jarvis's bot-authored posts only via the `varius_voice`
  message-metadata tag (`ignoreSelf: false` in `src/bridge.ts`); agent replies
  carry no tag, so they can't loop.
