#!/usr/bin/env python3
"""Voice mode (SHRI-13): always-listening front-end for the fleet.

Wake word ("jarvis" stock, or a custom "varius" .ppn) -> record until silence
-> transcribe locally (faster-whisper) -> route to an agent's Slack channel
-> the existing bridge/runner answer -> reply is read aloud.

The bridge stays the hub: this script only posts a Slack message and reads
the threaded reply back. No new execution path (architecture.md invariant 2).

Nothing leaves the machine before the wake word fires; transcription is local.

Debug modes (no mic, no Picovoice key needed):
  jarvis.py --list-agents
  jarvis.py --text "research what changed in node 22" [--no-tts]

Live modes (need PICOVOICE_ACCESS_KEY in .env, mic permission):
  jarvis.py            # listen forever
  jarvis.py --once     # one wake cycle, then exit
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AGENTS_DIR = ROOT / "agents"

# Capture tuning (16 kHz mono int16 throughout).
SAMPLE_RATE = 16_000
MAX_UTTERANCE_SEC = 15.0
SILENCE_END_SEC = 1.0       # this much trailing non-speech ends the utterance
MIN_SPEECH_SEC = 0.3        # ignore wake-ups with no real speech after them
SPEAK_CHAR_CAP = 700        # long digests: speak a prefix, point at Slack

REPLY_POLL_SEC = 2.0
REPLY_SETTLE_SEC = 4.0      # after the first reply, wait for trailing chunks


def log(msg: str) -> None:
    print(f"jarvis: {msg}", file=sys.stderr, flush=True)


def load_dotenv(path: Path) -> None:
    """Minimal .env loader; never overrides variables already set."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key, val = key.strip(), val.strip().strip("'\"")
        if key and key not in os.environ:
            os.environ[key] = val


def load_agents() -> dict[str, dict]:
    """Scan agents/*/agent.json exactly like the registry does (id -> manifest).

    Only interactive agents are routable; _examples and dotdirs are skipped.
    """
    agents: dict[str, dict] = {}
    if not AGENTS_DIR.is_dir():
        return agents
    for entry in sorted(AGENTS_DIR.iterdir()):
        if not entry.is_dir() or entry.name.startswith(("_", ".")):
            continue
        manifest_path = entry / "agent.json"
        if not manifest_path.exists():
            continue
        try:
            manifest = json.loads(manifest_path.read_text())
        except json.JSONDecodeError as e:
            log(f"skipping {entry.name}: unparseable agent.json ({e})")
            continue
        if manifest.get("interactive") and str(manifest.get("channel", "")).startswith("C"):
            agents[manifest["id"]] = manifest
    return agents


def route(transcript: str, agents: dict[str, dict], default_agent: str) -> tuple[str, str]:
    """Pick (agent_id, message) from a transcript.

    "research, what's new in node" -> ("research", "what's new in node")
    "ask guru about chapter 3"     -> ("guru", "about chapter 3")
    No agent named -> (default_agent, full transcript).
    """
    text = transcript.strip()
    words = re.sub(r"[^\w\s-]", " ", text.lower()).split()
    candidates = list(words[:3])
    for i, word in enumerate(candidates):
        if word in agents:
            # Drop everything through the agent name plus filler lead-ins.
            pattern = re.compile(
                r"^\W*(?:hey\s+|ask\s+|tell\s+)?" + re.escape(word) + r"\b[\s,:-]*",
                re.IGNORECASE,
            )
            stripped = pattern.sub("", text, count=1).strip()
            if stripped or i == 0:
                return word, stripped or text
    return default_agent, text


def strip_mrkdwn(text: str) -> str:
    """Make Slack mrkdwn speakable."""
    out = re.sub(r"```[\s\S]*?```", " code block omitted. ", text)
    out = re.sub(r"<(https?://[^|>]+)\|([^>]+)>", r"\2", out)
    out = re.sub(r"<https?://[^>]+>", "link", out)
    out = re.sub(r"[*_`~]", "", out)
    out = re.sub(r"^\s*•\s*", "", out, flags=re.MULTILINE)
    return re.sub(r"\s+", " ", out).strip()


def speak(text: str, no_tts: bool) -> None:
    clean = strip_mrkdwn(text)
    if len(clean) > SPEAK_CHAR_CAP:
        clean = clean[:SPEAK_CHAR_CAP].rsplit(" ", 1)[0] + " … full reply is in Slack."
    if no_tts:
        print(f"[tts] {clean}")
        return
    subprocess.run(["say", clean], check=False)  # blocks until spoken


class SlackFleet:
    def __init__(self, bot_token: str):
        from slack_sdk import WebClient  # lazy: --list-agents needs no slack

        self.client = WebClient(token=bot_token)

    def post(self, channel: str, text: str) -> str:
        # The metadata tag is what lets the bridge accept this bot-authored
        # message (it drops all other bot messages as its loop guard).
        res = self.client.chat_postMessage(
            channel=channel,
            text=text,
            metadata={"event_type": "varius_voice", "event_payload": {"source": "jarvis"}},
        )
        return res["ts"]

    def wait_for_reply(self, channel: str, ts: str, timeout_sec: float) -> str | None:
        """Poll the thread for bot replies; return them joined, or None."""
        deadline = time.monotonic() + timeout_sec
        replies: list[str] = []
        last_new = 0.0
        while time.monotonic() < deadline:
            time.sleep(REPLY_POLL_SEC)
            try:
                res = self.client.conversations_replies(channel=channel, ts=ts, limit=20)
            except Exception as e:  # transient rate limits etc.
                log(f"poll error (retrying): {e}")
                continue
            msgs = res.get("messages", [])
            bot_texts = [
                m.get("text", "")
                for m in msgs[1:]
                if m.get("bot_id") and m.get("text", "").strip()
            ]
            if len(bot_texts) > len(replies):
                replies = bot_texts
                last_new = time.monotonic()
            # First reply seen and no new chunks arriving -> done.
            if replies and time.monotonic() - last_new > REPLY_SETTLE_SEC:
                break
        return "\n".join(replies) if replies else None


def dispatch(transcript: str, agents: dict[str, dict], fleet: SlackFleet,
             default_agent: str, no_tts: bool) -> None:
    agent_id, message = route(transcript, agents, default_agent)
    manifest = agents.get(agent_id)
    if manifest is None:
        log(f"no routable agent '{agent_id}' (have: {', '.join(agents) or 'none'})")
        speak(f"I don't have an agent called {agent_id}.", no_tts)
        return
    channel = manifest["channel"]
    log(f"→ #{agent_id}: {message}")
    ts = fleet.post(channel, message)
    # Reply latency is bounded by the agent's own run timeout, unless overridden.
    timeout = float(os.environ.get("JARVIS_REPLY_TIMEOUT", 0)) \
        or float(manifest.get("timeoutSec", 900)) + 30
    reply = fleet.wait_for_reply(channel, ts, timeout)
    if reply is None:
        log("no reply before timeout (is the bridge running?)")
        speak(f"{agent_id} didn't answer. Check that the bridge is running.", no_tts)
        return
    log(f"← #{agent_id}: {reply[:120]}…" if len(reply) > 120 else f"← #{agent_id}: {reply}")
    speak(reply, no_tts)


# ---------------------------------------------------------------------------
# Audio path — imported lazily so --text/--list-agents work without any of
# pvporcupine / pvrecorder / faster-whisper installed.
# ---------------------------------------------------------------------------

class Listener:
    def __init__(self, access_key: str, keyword: str, keyword_path: str | None,
                 whisper_model: str):
        import pvporcupine
        from pvrecorder import PvRecorder

        if keyword_path:
            self.porcupine = pvporcupine.create(
                access_key=access_key, keyword_paths=[keyword_path])
            self.keyword_name = Path(keyword_path).stem
        else:
            self.porcupine = pvporcupine.create(
                access_key=access_key, keywords=[keyword])
            self.keyword_name = keyword
        assert self.porcupine.sample_rate == SAMPLE_RATE
        self.recorder = PvRecorder(
            frame_length=self.porcupine.frame_length, device_index=-1)
        self._vad = self._make_vad()
        self._whisper_model_name = whisper_model
        self._whisper = None  # loaded on first use (model download can be slow)

    @staticmethod
    def _make_vad():
        try:
            import webrtcvad

            return webrtcvad.Vad(2)
        except ImportError:
            log("webrtcvad unavailable — falling back to RMS silence detection")
            return None

    def _is_speech(self, samples: list[int]) -> bool:
        """samples: exactly 30 ms (480) of int16 PCM."""
        import struct

        if self._vad is not None:
            return self._vad.is_speech(
                struct.pack(f"<{len(samples)}h", *samples), SAMPLE_RATE)
        rms = (sum(s * s for s in samples) / len(samples)) ** 0.5
        return rms > 350  # close-mic speech comfortably clears this

    def _transcribe(self, pcm: list[int]) -> str:
        import numpy as np

        if self._whisper is None:
            from faster_whisper import WhisperModel

            log(f"loading whisper model '{self._whisper_model_name}' (first use)")
            self._whisper = WhisperModel(
                self._whisper_model_name, device="cpu", compute_type="int8")
        audio = np.asarray(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        segments, _info = self._whisper.transcribe(audio, language="en", beam_size=1)
        return " ".join(s.text.strip() for s in segments).strip()

    def _capture_utterance(self) -> list[int]:
        """Record after the wake word until trailing silence (or the cap)."""
        vad_frame = int(SAMPLE_RATE * 0.03)  # 480 samples / 30 ms
        buf: list[int] = []
        pending: list[int] = []
        speech_ms = 0
        silence_ms = 0
        start = time.monotonic()
        while time.monotonic() - start < MAX_UTTERANCE_SEC:
            pending.extend(self.recorder.read())
            while len(pending) >= vad_frame:
                frame, pending = pending[:vad_frame], pending[vad_frame:]
                buf.extend(frame)
                if self._is_speech(frame):
                    speech_ms += 30
                    silence_ms = 0
                else:
                    silence_ms += 30
                if (speech_ms >= MIN_SPEECH_SEC * 1000
                        and silence_ms >= SILENCE_END_SEC * 1000):
                    return buf
        return buf if speech_ms >= MIN_SPEECH_SEC * 1000 else []

    def run(self, on_transcript, once: bool, no_tts: bool) -> None:
        chime = "/System/Library/Sounds/Pop.aiff"
        self.recorder.start()
        log(f"listening for '{self.keyword_name}' (mic: {self.recorder.selected_device})")
        try:
            while True:
                if self.porcupine.process(self.recorder.read()) < 0:
                    continue
                log("wake word — capturing")
                subprocess.run(["afplay", chime], check=False)
                pcm = self._capture_utterance()
                if not pcm:
                    log("no speech captured")
                    continue
                transcript = self._transcribe(pcm)
                if not transcript:
                    log("empty transcript")
                    continue
                log(f"heard: {transcript}")
                on_transcript(transcript)
                if once:
                    return
        finally:
            self.recorder.stop()
            self.recorder.delete()
            self.porcupine.delete()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--text", help="skip audio; route this text as if spoken")
    parser.add_argument("--list-agents", action="store_true")
    parser.add_argument("--once", action="store_true", help="one wake cycle, then exit")
    parser.add_argument("--no-tts", action="store_true", help="print instead of speaking")
    args = parser.parse_args()

    load_dotenv(ROOT / ".env")
    agents = load_agents()

    if args.list_agents:
        for aid, m in agents.items():
            print(f"{aid}\t{m['channel']}\t{m.get('name', '')}")
        return 0

    default_agent = os.environ.get("JARVIS_DEFAULT_AGENT", "research")
    bot_token = os.environ.get("SLACK_BOT_TOKEN", "")
    if not bot_token:
        log("SLACK_BOT_TOKEN missing (set it in .env)")
        return 1
    fleet = SlackFleet(bot_token)

    if args.text:
        dispatch(args.text, agents, fleet, default_agent, args.no_tts)
        return 0

    access_key = os.environ.get("PICOVOICE_ACCESS_KEY", "")
    if not access_key:
        log("PICOVOICE_ACCESS_KEY missing — see docs/VOICE.md (free account at "
            "console.picovoice.ai). Meanwhile, --text works without it.")
        return 1
    listener = Listener(
        access_key=access_key,
        keyword=os.environ.get("JARVIS_KEYWORD", "jarvis"),
        keyword_path=os.environ.get("JARVIS_KEYWORD_PATH") or None,
        whisper_model=os.environ.get("JARVIS_WHISPER_MODEL", "base.en"),
    )
    listener.run(
        lambda t: dispatch(t, agents, fleet, default_agent, args.no_tts),
        once=args.once, no_tts=args.no_tts,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
