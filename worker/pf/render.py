"""Render a cut: real moments from the clips with their own sound, fitted to the frame over a blurred copy,
with word-by-word captions and text overlays burned in (origcut.py, generalised to 9:16 and 16:9).

Each piece is encoded on its own with only its own overlays (a 2-minute cut has a hundred caption chunks),
then the pieces are joined without re-encoding and the audio is loudness-normalised to -14 LUFS.
"""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

from .ffx import HDR, Probe, ff
from .text import text_png

FPS = 30
LANDSCAPE_ZOOM = 1.45      # landscape footage in a 9:16 frame: zoomed in a little over the blur (origcut)
ROTATE = {"none": "", "left": "transpose=2,", "right": "transpose=1,", "flip": "hflip,vflip,"}


@dataclass
class Overlay:
    png: str
    start: float           # seconds from the piece's start
    end: float


@dataclass
class Piece:
    src: str
    probe: Probe
    a: float               # in the clip
    b: float
    rotate: str = "none"
    overlays: list[Overlay] = field(default_factory=list)
    cx: float | None = None   # landscape in 9:16: crop a full-height window centred here (0-1 across), else fit over blur

    @property
    def dur(self) -> float:
        return round(self.b - self.a, 3)


def _video_chain(p: Piece, W: int, H: int) -> str:
    pr = p.probe
    portrait_src = pr.portrait != (p.rotate in ("left", "right"))
    # short side to 1080 first (4K HEVC decode is the slow part; everything after works on 1080p)
    pre = "scale='if(gt(iw,ih),-2,1080)':'if(gt(iw,ih),1080,-2)'," + (HDR + "," if pr.hdr else "") + ROTATE.get(p.rotate, "")
    vertical = H > W
    if vertical and not portrait_src and p.cx is not None:
        # reframe on the person: a full-height 9:16 window around their face, like a hand edit would
        return (f"[0:v]{pre}fps={FPS},setsar=1,crop=ih*9/16:ih:'max(0,min(iw-ih*9/16,{p.cx:.4f}*iw-ih*9/32))':0,"
                f"scale={W}:{H}:flags=lanczos,tpad=stop_mode=clone:stop_duration=1[v0]")
    z = LANDSCAPE_ZOOM if vertical and not portrait_src else 1.0
    fw, fh = int(W * z) // 2 * 2, int(H * z) // 2 * 2
    bw, bh = W // 4, H // 4
    return (
        f"[0:v]{pre}fps={FPS},setsar=1,split[a][b];"
        f"[a]scale={bw}:{bh}:force_original_aspect_ratio=increase,crop={bw}:{bh},boxblur=10:2,scale={W}:{H},eq=brightness=-0.08[bg];"
        f"[b]scale={fw}:{fh}:force_original_aspect_ratio=decrease,crop='min(iw,{W})':'min(ih,{H})'[fg];"
        f"[bg][fg]overlay=(W-w)/2:(H-h)/2,tpad=stop_mode=clone:stop_duration=1[v0]"
    )


def render_piece(p: Piece, out: str, W: int, H: int) -> None:
    d = p.dur
    inputs = ["-ss", f"{p.a:.3f}", "-t", f"{d:.3f}", "-i", p.src]
    fc = [_video_chain(p, W, H)]
    last = "[v0]"
    for i, o in enumerate(p.overlays, 1):
        inputs += ["-loop", "1", "-t", f"{d:.3f}", "-i", o.png]
        fc.append(f"{last}[{i}:v]overlay=0:0:enable='between(t,{o.start:.2f},{o.end:.2f})'[v{i}]")
        last = f"[v{i}]"
    n = len(p.overlays) + 1
    if p.probe.has_audio:
        fc.append(f"[0:a]aresample=48000,aformat=channel_layouts=stereo,afade=t=in:d=0.03,"
                  f"afade=t=out:st={max(d - 0.05, 0):.3f}:d=0.05,apad[aud]")
    else:
        inputs += ["-f", "lavfi", "-t", f"{d:.3f}", "-i", "anullsrc=r=48000:cl=stereo"]
        fc.append(f"[{n}:a]anull[aud]")
    ff(*inputs, "-filter_complex", ";".join(fc), "-map", last, "-map", "[aud]",
       "-c:v", "libx264", "-preset", "fast", "-crf", "19", "-pix_fmt", "yuv420p", "-r", str(FPS),
       "-c:a", "pcm_s16le", "-ar", "48000", "-t", f"{d:.3f}", out)


def render(pieces: list[Piece], out: str, W: int, H: int, work: Path, parallel: int = 2) -> float:
    """Encodes every piece, joins them and writes an mp4 ready to post. Returns the duration."""
    work.mkdir(parents=True, exist_ok=True)
    parts = [str(work / f"p{i:03d}.mov") for i in range(len(pieces))]
    with ThreadPoolExecutor(max_workers=parallel) as ex:
        list(ex.map(lambda ip: render_piece(ip[1], parts[ip[0]], W, H), enumerate(pieces)))
    lst = work / "list.txt"
    lst.write_text("".join(f"file '{p}'\n" for p in parts))
    joined = str(work / "joined.mov")
    ff("-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", joined)
    ff("-i", joined, "-c:v", "copy", "-af", "loudnorm=I=-14:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
       "-movflags", "+faststart", out)
    return round(sum(p.dur for p in pieces), 2)


def text_overlay(words, path: Path, W: int, H: int, px: int, y: float, start: float, end: float, maxw: int | None = None) -> Overlay:
    text_png(words, str(path), (W, H), px, int(H * y), maxw or int(W * 0.85))
    return Overlay(str(path), start, end)
