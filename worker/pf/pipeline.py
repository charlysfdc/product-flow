"""One edit, start to finish: clips -> transcripts -> Claude's plan -> vertical + horizontal cuts + thumbnail.

Everything that talks to the outside world (Drive, the GPU transcriber, Claude, job progress) comes in
through `io`, so the same steps run in the Modal container and in a local test on the Mac.
"""
import json
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Protocol

from . import ffx, plan as planner, thumb
from .render import Piece, render, text_overlay
from .text import apply_fixes, chunks, norm, words_of

V = (1080, 1920)
HZ = (1920, 1080)
HOOK_S = 2.6


class IO(Protocol):
    def download(self, clip: dict, dest: Path) -> str: ...
    def transcribe(self, wavs: dict[str, bytes]) -> dict[str, list[dict]]: ...
    def claude(self): ...
    def upload(self, path: str, name: str, mime: str) -> dict: ...
    def progress(self, step: str, pct: int, note: str = "") -> None: ...
    def log(self, line: str) -> None: ...


@dataclass
class Timer:
    t0: float = 0.0
    marks: dict | None = None

    def __post_init__(self):
        self.t0, self.marks = time.time(), {}

    def mark(self, name: str) -> None:
        now = time.time()
        self.marks[name] = round(now - self.t0, 1)
        self.t0 = now


def dedupe(clips: list[dict], probes: dict[str, ffx.Probe]) -> tuple[list[dict], list[str]]:
    """The same take uploaded twice (the original and a picker copy) counts once: the higher bitrate wins."""
    keep, dropped = [], []
    for c in sorted(clips, key=lambda c: -probes[c["id"]].bitrate):
        p = probes[c["id"]]
        twin = next((k for k in keep if abs(probes[k["id"]].duration - p.duration) < 0.25
                     and probes[k["id"]].portrait == p.portrait), None)
        if twin:
            dropped.append(f"{c['filename']} (same take as {twin['filename']})")
        else:
            keep.append(c)
    order = {c["id"]: i for i, c in enumerate(clips)}
    return sorted(keep, key=lambda c: order[c["id"]]), dropped


def sheet_frames(c: planner.Clip, work: Path) -> list[tuple[float, bytes]]:
    d = c.probe.duration
    n = max(6, min(24, round(d / 3)))
    times = [round((k + 0.5) * d / n, 1) for k in range(n)]

    def grab(t):
        out = work / f"{c.id}_{t:.1f}.jpg"
        ffx.frame(c.path, t, str(out), c.probe.hdr, width=384)
        return t, out.read_bytes()

    with ThreadPoolExecutor(max_workers=6) as ex:
        return list(ex.map(grab, times))


def pieces_for(which: str, resolved: list[dict], clips: dict[str, planner.Clip], fixed: dict[str, list[dict]],
               plan: dict, keys: set[str], work: Path, size: tuple[int, int]) -> list[Piece]:
    W, H = size
    work.mkdir(parents=True, exist_ok=True)
    vertical = which == "vertical"
    out: list[Piece] = []
    t_out = 0.0
    last_moment = len(resolved) - 1
    for n, seg in enumerate(resolved):
        c = clips[seg["clip"]]
        portrait = c.probe.portrait != (seg["rotate"] in ("left", "right"))
        for k, (a, b) in enumerate(seg["spans"]):
            p = Piece(src=c.path, probe=c.probe, a=a, b=b, rotate=seg["rotate"])
            tag = f"{which[0]}{n:02d}_{k:02d}"
            if vertical or plan.get("horizontal_captions", True):
                for j, (ws, cs, ce) in enumerate(chunks(fixed[c.id], keys, a, b, 0.0)):
                    if vertical:
                        p.overlays.append(text_overlay(ws, work / f"{tag}_c{j:02d}.png", W, H, 84, 0.72 if portrait else 0.78, cs, ce, 920))
                    else:
                        p.overlays.append(text_overlay(ws, work / f"{tag}_c{j:02d}.png", W, H, 60, 0.88, cs, ce, 1500))
            if seg.get("label"):
                y = (0.085 if portrait else 0.29) if vertical else 0.08
                p.overlays.append(text_overlay([(seg["label"].upper(), True)], work / f"{tag}_l.png", W, H, 62 if vertical else 48, y, 0, p.dur))
            if vertical and t_out == 0.0 and plan.get("hook"):
                p.overlays.append(text_overlay(words_of(plan["hook"], keys), work / "hook.png", W, H, 96, 0.17, 0, min(HOOK_S, p.dur), 940))
            if vertical and n == last_moment and plan.get("product_label"):
                p.overlays.append(text_overlay(words_of(plan["product_label"], keys | {norm(w) for w in plan["product_label"].split()}),
                                               work / f"{tag}_name.png", W, H, 80, 0.30 if portrait else 0.22, 0, p.dur, 900))
            if not vertical and t_out == 0.0 and plan.get("product_label"):
                p.overlays.append(text_overlay(words_of(plan["product_label"], set()), work / "h_name.png", W, H, 76, 0.12, 0, min(3.5, p.dur), 1600))
            out.append(p)
            t_out += p.dur
    return out


def safe_name(s: str) -> str:
    return "".join(ch if ch not in '/\\:*?"<>|' else "-" for ch in s).strip()[:90]


def run(ctx: dict, io: IO, work: Path) -> dict:
    """ctx: {job, product, clips, previous_plan, note, version}. Returns the job output (files, plan, timings, usage)."""
    timer = Timer()
    product, job = ctx["product"], ctx["job"]
    work.mkdir(parents=True, exist_ok=True)

    # 1. clips from Drive
    io.progress("Getting the clips from Drive", 3, f"{len(ctx['clips'])} clip{'s' if len(ctx['clips']) != 1 else ''}")
    raw = [dict(c, id=f"c{i + 1}") for i, c in enumerate(ctx["clips"])]
    with ThreadPoolExecutor(max_workers=3) as ex:
        paths = list(ex.map(lambda c: io.download(c, work / "raw"), raw))
    for c, p in zip(raw, paths):
        c["path"] = p
    timer.mark("download")

    # 2. look at them
    io.progress("Looking at the footage", 20)
    probes = {c["id"]: ffx.probe(c["path"]) for c in raw}
    kept, dropped = dedupe(raw, probes)
    for d in dropped:
        io.log(f"Skipped a duplicate: {d}")
    clips = [planner.Clip(id=c["id"], filename=c["filename"], path=c["path"], probe=probes[c["id"]], words=[], shot_on=c.get("shot_on")) for c in kept]
    (work / "frames").mkdir(exist_ok=True)
    (work / "audio").mkdir(exist_ok=True)
    wavs = {}
    for c in clips:
        if c.probe.has_audio:
            wav = work / "audio" / f"{c.id}.wav"
            ffx.extract_audio(c.path, str(wav))
            wavs[c.id] = wav.read_bytes()
    for c in clips:
        c.sheet = planner.contact_sheet(sheet_frames(c, work / "frames"), c.id)
    timer.mark("look")

    # 3. words
    io.progress("Transcribing what is said", 30, f"{sum(c.probe.duration for c in clips) / 60:.1f} min of footage")
    words = io.transcribe(wavs) if wavs else {}
    for c in clips:
        c.words = words.get(c.id, [])
    timer.mark("transcribe")

    # 4. the plan
    io.progress("Claude is planning the cut", 45)
    plan, resolved, usage = planner.make_plan(io.claude(), product, clips, ctx.get("note"), ctx.get("previous_plan"), log=io.log)
    by_id = {c.id: c for c in clips}
    # last line of defence for the TikTok rule: a vertical moment that still says Amazon is dropped
    vert = [s for s in resolved["vertical"] if not planner.AMAZON.search(s["said"])]
    if len(vert) < len(resolved["vertical"]):
        io.log(f"Dropped {len(resolved['vertical']) - len(vert)} vertical moment(s) that mention Amazon.")
    keys = {norm(k) for k in plan["keys"]}
    fixes = {f["heard"]: f["correct"] for f in plan["caption_fixes"]}
    fixed = {c.id: apply_fixes(c.words, fixes) for c in clips}
    (work / "plan.json").write_text(json.dumps({"plan": plan, "resolved": resolved}, indent=1))
    timer.mark("plan")

    # 5-6. render
    stem = safe_name(product["name"])
    v_tag = f"auto v{ctx.get('version', 1)}"
    files = {}
    io.progress("Rendering the vertical cut", 60, f"{sum(s['length'] for s in vert):.0f} s")
    vp = pieces_for("vertical", vert, by_id, fixed, plan, keys, work / "v", V)
    v_out = str(work / f"{stem} - vertical ({v_tag}).mp4")
    v_len = render(vp, v_out, *V, work / "v")
    timer.mark("render_vertical")

    io.progress("Rendering the horizontal cut", 75, f"{resolved['horizontal_s']:.0f} s")
    hp = pieces_for("horizontal", resolved["horizontal"], by_id, fixed, plan, keys, work / "h", HZ)
    h_out = str(work / f"{stem} - horizontal ({v_tag}).mp4")
    h_len = render(hp, h_out, *HZ, work / "h")
    timer.mark("render_horizontal")

    # 7. thumbnail
    io.progress("Making the thumbnail", 88)
    t = plan["thumbnail"]
    tc = by_id.get(t["clip"]) or clips[0]
    tframe = work / "thumb_frame.jpg"
    ffx.frame(tc.path, min(float(t["time"]), tc.probe.duration - 0.1), str(tframe), tc.probe.hdr, width=1920)
    t_out = str(work / f"{stem} - thumbnail ({v_tag}).jpg")
    placed = thumb.make(str(tframe), t["text"], keys, t["text_position"], t_out)
    if placed != t["text_position"]:
        io.log(f"Thumbnail words moved to the {placed} so they don't cover a face.")
    timer.mark("thumbnail")

    # 8. into finished/
    io.progress("Saving to Drive (finished)", 92)
    files["finished_vertical"] = {**io.upload(v_out, Path(v_out).name, "video/mp4"), "duration_s": v_len, "width": V[0], "height": V[1]}
    files["finished_horizontal"] = {**io.upload(h_out, Path(h_out).name, "video/mp4"), "duration_s": h_len, "width": HZ[0], "height": HZ[1]}
    files["thumbnail"] = {**io.upload(t_out, Path(t_out).name, "image/jpeg"), "width": thumb.W, "height": thumb.H}
    timer.mark("upload")

    return {
        "plan": plan,
        "cuts": {
            "vertical": [{k: s[k] for k in ("clip", "a", "b", "kind", "why", "said", "length")} for s in vert],
            "horizontal": [{k: s[k] for k in ("clip", "a", "b", "kind", "why", "said", "length")} for s in resolved["horizontal"]],
        },
        "clips": {c.id: c.filename for c in clips},
        "skipped": dropped,
        "problems": resolved["problems"],
        "files": files,
        "lengths": {"vertical": v_len, "horizontal": h_len},
        "timings": timer.marks,
        "claude": {"model": planner.MODEL, "calls": usage.calls, "input_tokens": usage.input_tokens,
                   "output_tokens": usage.output_tokens, "cache_read": usage.cache_read, "usd": usage.usd},
    }
