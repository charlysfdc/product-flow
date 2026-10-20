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

from . import ffx, plan as planner, thumb, voice, voiceplan
from .render import Overlay, Piece, render, text_overlay
from .text import apply_fixes, chunks, norm, text_png, words_of

V = (1080, 1920)
HZ = (1920, 1080)
HOOK_S = 2.6
SPEAKERS = {"mom", "daughter", "charly", "zanje"}


class IO(Protocol):
    def download(self, clip: dict, dest: Path) -> str: ...
    def download_music(self, track: dict, dest: Path) -> str: ...
    def transcribe(self, wavs: dict[str, bytes], hint: str = "") -> dict[str, list[dict]]: ...
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


def face_centre(c: planner.Clip, t: float, work: Path) -> float | None:
    """Where across the frame (0-1) the person is at time t: the biggest face, or the middle of two that fit
    in one 9:16 window. None when no face is found (the moment is then fitted over a blur instead)."""
    from PIL import Image
    out = work / f"face_{c.id}_{t:.1f}.jpg"
    try:
        ffx.frame(c.path, t, str(out), c.probe.hdr, width=960)
        im = Image.open(out)
    except Exception:
        return None
    boxes = sorted(thumb.faces(im), key=lambda b: -b[2] * b[3])
    if not boxes:
        return None
    W = im.width
    window = im.height * 9 / 16
    x, _, w, _ = boxes[0]
    left, right = x, x + w
    for bx, _, bw, _ in boxes[1:3]:   # keep a second face in the frame when both fit
        if max(right, bx + bw) - min(left, bx) <= window * 0.9:
            left, right = min(left, bx), max(right, bx + bw)
    return round(((left + right) / 2) / W, 4)


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
            if vertical and not portrait and seg["rotate"] == "none":
                p.cx = face_centre(c, (a + b) / 2, work)
            full = portrait or p.cx is not None   # the frame is filled: text sits as on upright footage
            tag = f"{which[0]}{n:02d}_{k:02d}"
            if vertical or plan.get("horizontal_captions", True):
                for j, (ws, cs, ce) in enumerate(chunks(fixed[c.id], keys, a, b, 0.0)):
                    if vertical:
                        p.overlays.append(text_overlay(ws, work / f"{tag}_c{j:02d}.png", W, H, 84, 0.72 if full else 0.78, cs, ce, 920))
                    else:
                        p.overlays.append(text_overlay(ws, work / f"{tag}_c{j:02d}.png", W, H, 60, 0.88, cs, ce, 1500))
            if seg.get("label", "").strip().lower() in SPEAKERS:   # who is talking, never the product name
                y = (0.085 if full else 0.29) if vertical else 0.08
                p.overlays.append(text_overlay([(seg["label"].upper(), True)], work / f"{tag}_l.png", W, H, 62 if vertical else 48, y, 0, p.dur))
            if vertical and t_out == 0.0 and plan.get("hook"):
                p.overlays.append(text_overlay(words_of(plan["hook"], keys), work / "hook.png", W, H, 96, 0.17, 0, min(HOOK_S, p.dur), 940))
            if vertical and n == last_moment and plan.get("product_label"):
                p.overlays.append(text_overlay(words_of(plan["product_label"], keys | {norm(w) for w in plan["product_label"].split()}),
                                               work / f"{tag}_name.png", W, H, 80, 0.30 if full else 0.22, 0, p.dur, 900))
            if not vertical and t_out == 0.0 and plan.get("product_label"):
                p.overlays.append(text_overlay(words_of(plan["product_label"], set()), work / "h_name.png", W, H, 76, 0.12, 0, min(3.5, p.dur), 1600))
            out.append(p)
            t_out += p.dur
    return out


def safe_name(s: str) -> str:
    return "".join(ch if ch not in '/\\:*?"<>|' else "-" for ch in s).strip()[:90]


SILENT_WORDS, SILENT_SHARE = 15, 0.10    # fewer words than this, or speech in less than this share of the footage


def is_silent(clips: list[planner.Clip]) -> tuple[bool, dict]:
    n = sum(len(c.words) for c in clips)
    spoken = sum(w["e"] - w["s"] for c in clips for w in c.words)
    total = sum(c.probe.duration for c in clips) or 1.0
    return n < SILENT_WORDS or spoken / total < SILENT_SHARE, {"words": n, "spoken_s": round(spoken, 1), "footage_s": round(total, 1)}


def prepare(ctx: dict, io: IO, work: Path, timer: Timer, transcribe: bool = True) -> tuple[list[planner.Clip], list[str]]:
    """Steps shared by every kind of edit: the clips from Drive, a look at them, and what is said in them."""
    product = ctx["product"]
    work.mkdir(parents=True, exist_ok=True)

    io.progress("Getting the clips from Drive", 3, f"{len(ctx['clips'])} clip{'s' if len(ctx['clips']) != 1 else ''}")
    raw = [dict(c, id=f"c{i + 1}") for i, c in enumerate(ctx["clips"])]
    with ThreadPoolExecutor(max_workers=3) as ex:
        paths = list(ex.map(lambda c: io.download(c, work / "raw"), raw))
    for c, p in zip(raw, paths):
        c["path"] = p
    timer.mark("download")

    io.progress("Looking at the footage", 20)
    probes = {c["id"]: ffx.probe(c["path"]) for c in raw}
    kept, dropped = dedupe(raw, probes)
    for d in dropped:
        io.log(f"Skipped a duplicate: {d}")
    # c1, c2, ... with no gaps, so the planner doesn't think clips are missing
    probes = {f"c{i + 1}": probes[c["id"]] for i, c in enumerate(kept)}
    kept = [dict(c, id=f"c{i + 1}") for i, c in enumerate(kept)]
    clips = [planner.Clip(id=c["id"], filename=c["filename"], path=c["path"], probe=probes[c["id"]], words=[], shot_on=c.get("shot_on")) for c in kept]
    (work / "frames").mkdir(exist_ok=True)
    (work / "audio").mkdir(exist_ok=True)
    wavs = {}
    if transcribe:
        for c in clips:
            if c.probe.has_audio:
                wav = work / "audio" / f"{c.id}.wav"
                ffx.extract_audio(c.path, str(wav))
                wavs[c.id] = wav.read_bytes()
    for c in clips:
        c.sheet = planner.contact_sheet(sheet_frames(c, work / "frames"), c.id)
    timer.mark("look")

    if transcribe:
        io.progress("Transcribing what is said", 30, f"{sum(c.probe.duration for c in clips) / 60:.1f} min of footage")
        brand = product.get("brand") or ""
        hint = product["name"] if brand.lower() in product["name"].lower() else f"{brand} {product['name']}".strip()
        words = io.transcribe(wavs, hint) if wavs else {}
        for c in clips:
            c.words = words.get(c.id, [])
        timer.mark("transcribe")
    return clips, dropped


def thumbnail(plan: dict, clips: list[planner.Clip], keys: set[str], work: Path, out: str, io: IO) -> None:
    by_id = {c.id: c for c in clips}
    t = plan["thumbnail"]
    tc = by_id.get(t["clip"]) or clips[0]
    tframe = work / "thumb_frame.jpg"
    ffx.frame(tc.path, max(0.0, min(float(t["time"]), tc.probe.duration - 0.1)), str(tframe), tc.probe.hdr, width=1920)
    placed = thumb.make(str(tframe), t["text"], keys, t["text_position"], out)
    if placed != t["text_position"]:
        io.log(f"Thumbnail words moved to the {placed} so they don't cover a face.")


def claude_cost(usage) -> dict:
    return {"model": planner.MODEL, "calls": usage.calls, "input_tokens": usage.input_tokens,
            "output_tokens": usage.output_tokens, "cache_read": usage.cache_read, "usd": usage.usd}


def upload_all(io: IO, v_out: str, v_len: float, h_out: str, h_len: float, t_out: str) -> dict:
    io.progress("Saving to Drive (finished)", 92)
    return {
        "finished_vertical": {**io.upload(v_out, Path(v_out).name, "video/mp4"), "duration_s": v_len, "width": V[0], "height": V[1]},
        "finished_horizontal": {**io.upload(h_out, Path(h_out).name, "video/mp4"), "duration_s": h_len, "width": HZ[0], "height": HZ[1]},
        "thumbnail": {**io.upload(t_out, Path(t_out).name, "image/jpeg"), "width": thumb.W, "height": thumb.H},
    }


def run(ctx: dict, io: IO, work: Path) -> dict:
    """ctx: {job, product, clips, previous_plan, note, version, voiceover, ...}. Returns the job output.

    voiceover None: Charly's own audio (the original recipe); footage without talking stops at a question.
    'script': Claude writes a voice-over script and the job stops for Charly to read it.
    'render': the approved script is read in Charly's cloned voice and both cuts are rendered.
    'music': on-screen captions over music, no voice."""
    mode = ctx.get("voiceover")
    if mode in ("render", "music"):
        return run_voiced(ctx, io, work, music=mode == "music")
    if mode == "script":
        return run_script(ctx, io, work)

    timer = Timer()
    product = ctx["product"]
    clips, dropped = prepare(ctx, io, work, timer)
    silent, speech = is_silent(clips)
    if silent:
        io.log(f"Almost nothing is said ({speech['words']} words, {speech['spoken_s']} s of speech in {speech['footage_s']} s).")
        return {"stage": "ask_voiceover", "speech": speech, "clips": {c.id: c.filename for c in clips}, "skipped": dropped, "timings": timer.marks}

    # 4. the plan
    io.progress("Claude is planning the cut", 45)
    product = {**product, "duplicates_left_out": len(dropped)} if dropped else product
    plan, resolved, usage = planner.make_plan(io.claude(), product, clips, ctx.get("note"), ctx.get("previous_plan"), log=io.log)
    if not plan.get("spoken_review", True):
        io.log("Nobody talks about the product in these clips (only background speech).")
        return {"stage": "ask_voiceover", "speech": {**speech, "background_only": True}, "footage": plan["footage"],
                "clips": {c.id: c.filename for c in clips}, "skipped": dropped, "timings": timer.marks, "claude": claude_cost(usage)}
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
    t_out = str(work / f"{stem} - thumbnail ({v_tag}).jpg")
    thumbnail(plan, clips, keys, work, t_out, io)
    timer.mark("thumbnail")

    # 8. into finished/
    files = upload_all(io, v_out, v_len, h_out, h_len, t_out)
    timer.mark("upload")

    return {
        "stage": "cut",
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
        "claude": claude_cost(usage),
    }


# ---------------------------------------------------------------- voice-over and captions-and-music cuts

def run_script(ctx: dict, io: IO, work: Path) -> dict:
    """Claude writes the voice-over (lines + shots); the job then waits for Charly to read and approve it."""
    timer = Timer()
    clips, dropped = prepare(ctx, io, work, timer)
    io.progress("Claude is writing the voice-over", 45)
    product = {**ctx["product"], "duplicates_left_out": len(dropped)} if dropped else ctx["product"]
    plan, problems, usage = voiceplan.make_plan(io.claude(), product, clips, ctx.get("script_note") or ctx.get("note"),
                                                ctx.get("previous_vo_plan"), log=io.log)
    timer.mark("plan")
    return {"stage": "script", "vo_plan": plan, "problems": problems, "clips": {c.id: c.filename for c in clips},
            "skipped": dropped, "timings": timer.marks, "claude": claude_cost(usage),
            "words": {"vertical": voiceplan.words_in(plan["vertical"]), "horizontal": voiceplan.words_in(plan["horizontal"])}}


def spread(overlays: list[tuple[str, float, float]], pieces: list[Piece]) -> None:
    """Hands overlays timed on the whole cut to the pieces they fall in, on each piece's own clock."""
    t0 = 0.0
    for p in pieces:
        t1 = t0 + p.dur + p.hold
        for png, s, e in overlays:
            if e > t0 and s < t1:
                p.overlays.append(Overlay(png, max(s, t0) - t0, min(e, t1) - t0))
        t0 = t1


def line_pieces(lines: list[dict], spans: list[tuple[float, float]], clips: dict[str, planner.Clip], vertical: bool,
                work: Path) -> list[tuple[int, Piece]]:
    """Each line's time shared evenly by its shots; a shot runs from its start on the clip (held on its last frame
    when the clip ends first)."""
    out = []
    for k, (line, (s0, s1)) in enumerate(zip(lines, spans)):
        shots = [sh for sh in line["shots"] if sh["clip"] in clips] or [{"clip": next(iter(clips)), "start": 0.0, "rotate": "none"}]
        d = (s1 - s0) / len(shots)
        for sh in shots:
            c = clips[sh["clip"]]
            avail = c.probe.duration - 0.05
            a = max(0.0, min(float(sh["start"]), avail - d))
            b = min(avail, a + d)
            p = Piece(src=c.path, probe=c.probe, a=round(a, 3), b=round(b, 3), rotate=sh.get("rotate", "none"), gain_db=-18.0)
            p.hold = round(max(0.0, d - (b - a)), 3)
            portrait = c.probe.portrait != (p.rotate in ("left", "right"))
            if vertical and not portrait and p.rotate == "none":
                p.cx = face_centre(c, (a + b) / 2, work)
            out.append((k, p))
    return out


def run_voiced(ctx: dict, io: IO, work: Path, music: bool) -> dict:
    """Renders an approved voice-over script (or captions over music) onto the real footage."""
    timer = Timer()
    product = ctx["product"]
    clips, dropped = prepare(ctx, io, work, timer, transcribe=False)
    by_id = {c.id: c for c in clips}
    usage = planner.Usage()
    tracks = ctx.get("music_tracks") or []
    plan = ctx.get("vo_plan")
    if not plan:   # captions and music: no script to approve, Claude plans it now
        io.progress("Claude is planning the captions", 40)
        plan, problems, usage = voiceplan.make_plan(io.claude(), product, clips, ctx.get("note"), None, music=True,
                                                    tracks=[t["name"] for t in tracks], log=io.log)
        timer.mark("plan")
    keys = {norm(k) for k in plan["keys"]}
    stem = safe_name(product["name"])
    v_tag = f"auto v{ctx.get('version', 1)}"
    chars = 0
    over, over_db, loop = None, 0.0, False
    if music:
        track = next((t for t in tracks if t["name"] == plan.get("music")), tracks[0] if tracks else None)
        if track:
            over, over_db, loop = io.download_music(track, work / "music"), -6.0, True
        else:
            io.log("No music found in Content Library/Music; the cut keeps only the clips' own sound.")

    lengths, outs = {}, {}
    for which, size, pct in (("vertical", V, 55), ("horizontal", HZ, 72)):
        vertical = which == "vertical"
        lines = [l for l in plan[which] if l["say"].strip()]
        cw = work / which[0]
        cw.mkdir(parents=True, exist_ok=True)
        W, H = size
        overlays: list[tuple[str, float, float]] = []
        if music:
            spans, t = [], 0.0
            for l in lines:
                d = max(1.5, float(l["seconds"]))
                spans.append((t, t + d))
                t += d
            for k, (l, (s0, s1)) in enumerate(zip(lines, spans)):
                png = cw / f"line{k:02d}.png"
                text_png(words_of(l["say"], keys), str(png), size, 84 if vertical else 64, int(H * (0.72 if vertical else 0.86)), int(W * 0.85))
                overlays.append((str(png), s0, s1))
            total = spans[-1][1] if spans else 0.0
            bed, bed_db = over, over_db
        else:
            io.progress(f"Charly's voice reads the {which} script", pct, f"{voiceplan.words_in(lines)} words")
            voiced = voice.speak(ctx["elevenlabs"]["api_key"], [l["say"] for l in lines], cw / "voice", max_s=36.0 if vertical else 120.0)
            chars += voiced.characters
            spans, total = voiced.line_spans, voiced.line_spans[-1][1]
            for j, (ws, cs, ce) in enumerate(chunks(voiced.words, keys, 0.0, total, 0.0)):
                png = cw / f"cap{j:03d}.png"
                if vertical:
                    text_png(ws, str(png), size, 84, int(H * 0.72), 920)
                else:
                    text_png(ws, str(png), size, 60, int(H * 0.88), 1500)
                overlays.append((str(png), cs, ce))
            bed, bed_db = voiced.wav, 0.0
        io.progress(f"Rendering the {which} cut", pct + 8, f"{total:.0f} s")
        lp = line_pieces(lines, spans, by_id, vertical, cw)
        pieces = [p for _, p in lp]
        if vertical and plan.get("hook"):
            png = cw / "hook.png"
            text_png(words_of(plan["hook"], keys), str(png), size, 96, int(H * 0.17), 940)
            overlays.append((str(png), 0.0, HOOK_S))
        if plan.get("product_label") and lines:
            png = cw / "name.png"
            if vertical:   # over the last line
                text_png(words_of(plan["product_label"], keys | {norm(w) for w in plan["product_label"].split()}), str(png), size, 80, int(H * 0.30), 900)
                overlays.append((str(png), spans[-1][0], total))
            else:
                text_png(words_of(plan["product_label"], set()), str(png), size, 76, int(H * 0.12), 1600)
                overlays.append((str(png), 0.0, min(3.5, total)))
        spread(overlays, pieces)
        out = str(work / f"{stem} - {which} ({v_tag}{', voice-over' if not music else ', music'}).mp4")
        lengths[which] = render(pieces, out, W, H, cw / "render", over=bed, over_db=bed_db, loop_over=music)
        outs[which] = out
        timer.mark(f"render_{which}")

    io.progress("Making the thumbnail", 88)
    t_out = str(work / f"{stem} - thumbnail ({v_tag}).jpg")
    thumbnail(plan, clips, keys, work, t_out, io)
    timer.mark("thumbnail")
    files = upload_all(io, outs["vertical"], lengths["vertical"], outs["horizontal"], lengths["horizontal"], t_out)
    timer.mark("upload")
    return {
        "stage": "cut",
        "voiceover": "music" if music else "voice",
        "vo_plan": plan,
        "plan": {"hook": plan["hook"], "product_label": plan["product_label"], "footage": plan["footage"],
                 "concerns": plan["concerns"], "keys": plan["keys"], "thumbnail": plan["thumbnail"]},
        "clips": {c.id: c.filename for c in clips},
        "skipped": dropped,
        "problems": [],
        "files": files,
        "lengths": lengths,
        "timings": timer.marks,
        "claude": claude_cost(usage),
        "elevenlabs": {"voice": voice.VOICE_NAME, "model": voice.MODEL, "characters": chars},
    }
