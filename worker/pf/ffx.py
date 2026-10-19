"""ffmpeg helpers: the binary, a runner, and a probe that reads what the recipe needs from `ffmpeg -i`.

The same static ffmpeg (imageio-ffmpeg) runs on the Mac and in the Modal container, so a cut made
in a local test matches the cloud one. It has zscale + tonemap for the iPhone's HLG/HDR clips.
"""
import re
import subprocess
from dataclasses import dataclass

import imageio_ffmpeg

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()

# HDR (iPhone HLG, or PQ) to SDR bt709, from povcut.py.
HDR = "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p"


class FFError(RuntimeError):
    pass


def ff(*args: str, timeout: int = 1800) -> None:
    r = subprocess.run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", *args], capture_output=True, text=True, timeout=timeout)
    if r.returncode:
        raise FFError("ffmpeg failed: " + r.stderr[-1500:])


@dataclass
class Probe:
    duration: float
    width: int          # as displayed (rotation applied)
    height: int
    rotation: int       # the clip's display rotation, degrees
    fps: float
    codec: str
    hdr: bool
    has_audio: bool
    bitrate: int        # kb/s, whole file

    @property
    def portrait(self) -> bool:
        return self.height > self.width


def probe(path: str) -> Probe:
    err = subprocess.run([FFMPEG, "-hide_banner", "-i", path], capture_output=True, text=True).stderr
    m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", err)
    if not m:
        raise FFError(f"Not a video ffmpeg can read: {path}")
    duration = int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3])
    br = re.search(r"bitrate: (\d+) kb/s", err)
    v = re.search(r"Stream #\S+.*?Video: (\w+).*", err)
    if not v:
        raise FFError(f"No video stream in {path}")
    line = v[0]
    size = re.search(r", (\d{2,5})x(\d{2,5})", line)
    w, h = (int(size[1]), int(size[2])) if size else (0, 0)
    rot = re.search(r"rotation of (-?[\d.]+) degrees", err) or re.search(r"rotate\s*:\s*(-?\d+)", err)
    rotation = int(round(float(rot[1]))) % 360 if rot else 0
    if rotation in (90, 270):
        w, h = h, w
    fps = re.search(r"([\d.]+) fps", line)
    return Probe(
        duration=duration, width=w, height=h, rotation=rotation,
        fps=float(fps[1]) if fps else 30.0, codec=v[1],
        hdr=("arib-std-b67" in line) or ("smpte2084" in line),
        has_audio=bool(re.search(r"Stream #\S+.*?Audio:", err)),
        bitrate=int(br[1]) if br else 0,
    )


def extract_audio(src: str, out: str) -> None:
    """16 kHz mono WAV for Whisper."""
    ff("-i", src, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", out)


def frame(src: str, t: float, out: str, hdr: bool, width: int = 1280) -> None:
    """One frame as JPEG, tone-mapped when the clip is HDR (seeks to the nearest frame before t)."""
    import os
    pre = f"scale={width}:-2:flags=bicubic," if not hdr else f"scale={width}:-2,{HDR},"
    for at in (t, t - 0.5, t - 1.5):   # a seek right at the end of a clip, or a slow read, can yield no frame
        ff("-ss", f"{max(at, 0):.3f}", "-i", src, "-frames:v", "1", "-update", "1", "-vf", pre + "format=yuvj420p", "-q:v", "3", out, timeout=120)
        if os.path.exists(out) and os.path.getsize(out) > 0:
            return
    raise FFError(f"No frame at {t:.1f} s in {os.path.basename(src)}")


def wav_array(data: bytes):
    """16 kHz mono 16-bit WAV bytes -> float32 numpy array (what faster-whisper takes without PyAV)."""
    import io
    import wave

    import numpy as np
    with wave.open(io.BytesIO(data)) as w:
        pcm = w.readframes(w.getnframes())
    return np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
