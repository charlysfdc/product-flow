"""Charly's cloned voice (ElevenLabs) for footage filmed without talking, and the timeline it drives.

Same call as ~/meta-api/lion.py tts: POST /v1/text-to-speech/{voice}/with-timestamps returns the audio plus
per-character timings; words, line boundaries and captions all come from those timings.
"""
import base64
from dataclasses import dataclass
from pathlib import Path

import requests

from .ffx import duration, ff

VOICE_ID = "96Sqoi9Yf75d9Lu4UGvK"          # "Charly South African"
VOICE_NAME = "Charly South African"
MODEL = "eleven_v3"
TAIL = 0.6                                   # picture after the last word


@dataclass
class Voiced:
    wav: str
    duration: float            # of the (sped-up) voice
    words: list[dict]          # {"w","s","e"} on the voice timeline
    line_spans: list[tuple[float, float]]   # where each script line starts and ends
    characters: int            # billed by ElevenLabs
    speed: float


def tts(api_key: str, text: str, out_mp3: Path) -> dict:
    r = requests.post(
        f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}/with-timestamps",
        headers={"xi-api-key": api_key, "Content-Type": "application/json"},
        json={"text": text, "model_id": MODEL,
              "voice_settings": {"stability": 0.5, "similarity_boost": 0.75, "style": 0.0, "use_speaker_boost": True}},
        timeout=300,
    )
    if r.status_code >= 400:
        raise RuntimeError(f"ElevenLabs answered {r.status_code}: {r.text[:300]}")
    d = r.json()
    out_mp3.write_bytes(base64.b64decode(d["audio_base64"]))
    return d["alignment"]


def _words(al: dict, sp: float) -> list[dict]:
    words, cur, ws, pe = [], "", None, 0.0
    for c, s, e in zip(al["characters"], al["character_start_times_seconds"], al["character_end_times_seconds"]):
        s, e = s / sp, e / sp
        if c.isspace():
            if cur:
                words.append({"w": cur, "s": round(ws, 3), "e": round(pe, 3)})
            cur, ws = "", None
        else:
            if not cur:
                ws = s
            cur += c
            pe = e
    if cur:
        words.append({"w": cur, "s": round(ws, 3), "e": round(pe, 3)})
    return words


def speak(api_key: str, lines: list[str], work: Path, max_s: float) -> Voiced:
    """Reads the script lines in one take; speeds it up a little (at most 1.2x) when it runs past max_s."""
    work.mkdir(parents=True, exist_ok=True)
    text = " ".join(l.strip() for l in lines if l.strip())
    al = tts(api_key, text, work / "voice.mp3")
    raw = duration(str(work / "voice.mp3"))
    sp = round(min(1.2, max(1.0, raw / max_s)), 3)
    wav = work / "voice.wav"
    ff("-i", str(work / "voice.mp3"), "-filter:a", f"atempo={sp}", "-ar", "48000", "-ac", "2", str(wav))
    dur = duration(str(wav))
    words = _words(al, sp)
    # each line's span from its word count; cut points halfway into the pauses between lines (lion.py)
    counts = [len(l.split()) for l in lines if l.strip()]
    bounds, i = [], 0
    for n in counts:
        if not words:
            break
        a = words[min(i, len(words) - 1)]["s"]
        b = words[min(i + n, len(words)) - 1]["e"]
        bounds.append((a, b))
        i += n
    spans = []
    for k, (a, b) in enumerate(bounds):
        start = 0.0 if k == 0 else round((bounds[k - 1][1] + a) / 2, 3)
        end = round(dur + TAIL, 3) if k == len(bounds) - 1 else round((b + bounds[k + 1][0]) / 2, 3)
        spans.append((start, max(end, start + 0.8)))
    return Voiced(str(wav), dur, words, spans, len(text), sp)
