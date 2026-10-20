"""Claude plans the cut from the transcripts, contact sheets of the footage and the product, under Charly's rules.

The plan names moments by clip, approximate times and their first/last words; the times are then snapped to
the word timestamps (gen_orig.py) and pauses inside spoken moments are cut out.
"""
import base64
import io
import json
import re
from dataclasses import dataclass

import anthropic
from PIL import Image, ImageDraw

from .text import font, norm

MODEL = "claude-opus-5-5"
VERTICAL = (30.0, 37.0)
HORIZONTAL = (60.0, 120.0)
GAP = {"vertical": 0.6, "horizontal": 0.9}    # pauses longer than this inside a spoken moment are cut
PAD_IN, PAD_OUT = 0.12, 0.22                   # around the first and last word (gen_orig.py)

SYSTEM = """You are the video editor for Charly (AfrikanerinAmerika), an Amazon Influencer and TikTok Shop creator. \
Charly films product reviews on an iPhone, often with their daughter Zanje on camera. You plan two cuts of the raw \
clips of one product; a program renders exactly what you plan, so every moment must exist in the clips.

Charly's rules, which always hold:
- Original audio only: Charly's and Zanje's real voices. Never plan voice-over or music.
- Captions are what is actually said. The transcript comes from speech recognition and mishears brand and product \
words; list each misheard word or phrase with its correction in caption_fixes (only words that are really wrong).
- The strongest line goes first. A cut opens on the most surprising, specific or emotional real moment, not on \
"hi guys" or an unboxing preamble.
- The vertical cut (TikTok Shop, Reels) is 30-37 seconds in total, never mentions Amazon (no moment where anyone \
says Amazon, no text saying it), and ends on a moment where the product is named or clearly shown; the product's \
on-screen name appears over the last moment.
- The horizontal cut is the Amazon review video: 60-120 seconds (less only if the footage is shorter), the clearest \
demonstration of the product working, what it is, how it is used, and an honest verdict. Amazon does not allow \
prices, discounts, shipping talk, links or other stores in review videos, so leave out moments about those.
- Leave out fumbles, false starts, repeated takes (use the best take), dead air and moments where the camera is \
pointed at nothing.

How to name a moment: the clip id, start and end in seconds on that clip's own timeline, and for spoken moments \
the first and last 2-4 words exactly as they appear in the transcript (used to snap to word timings). A spoken \
moment ("talk") starts at the beginning of a sentence or clause and ends at the end of one; pauses inside it are \
trimmed automatically. A "show" moment is visual (a demonstration, a reveal, a before/after) and may have no \
speech; give it a few seconds at most and leave first_words and last_words empty when nothing is said. Moments \
play in the order you list them and may jump between clips and back and forth in time. Every moment is at \
least 1 second.

Charly and Zanje sometimes film the same take with two phones at once, one upright and one sideways; their transcripts then match with a time offset. Pick, moment by moment, the angle that shows the person \
talking and the product best; you may switch angles between moments. A landscape clip in the vertical cut is \
shown slightly zoomed over a blurred copy of itself, which works when the subject is near the centre; a face \
and the product in hand usually beat an overhead shot of a table. A vertical cut whose picture barely changes \
(one static shot under all the talking) cannot be posted; when the upright clip is static, use the landscape \
angle of the person instead.

The contact sheets show frames from each clip with their time in seconds, as they will appear. If a clip is \
filmed sideways (people or text lying on their side), set rotate on its moments ("left" turns it 90 degrees \
counter-clockwise, "right" clockwise). Label a moment "Mom" or "Daughter" only when the cut compares Charly and \
Zanje and a viewer would otherwise not know who is speaking; otherwise leave label empty.

Hook: a short on-screen line (at most 7 words, no emoji, no hashtags) shown over the first 2.6 seconds of the \
vertical cut; it adds curiosity to the first moment rather than repeating it. Key words: 3-8 single words that \
are shown in yellow in captions and text (product features, results, surprises).

Thumbnail: pick one real frame (clip and time) where the product and, ideally, a face are clear and the image \
is sharp, and a 2-5 word phrase for it. Never invent people or scenes; the thumbnail is always a real frame."""

SEG = {
    "type": "object",
    "properties": {
        "clip": {"type": "string", "description": "clip id, e.g. c1"},
        "start": {"type": "number"},
        "end": {"type": "number"},
        "kind": {"type": "string", "enum": ["talk", "show"]},
        "first_words": {"type": "string"},
        "last_words": {"type": "string"},
        "rotate": {"type": "string", "enum": ["none", "left", "right", "flip"]},
        "label": {"type": "string"},
        "why": {"type": "string", "description": "one short reason this moment is in the cut"},
    },
    "required": ["clip", "start", "end", "kind", "first_words", "last_words", "rotate", "label", "why"],
    "additionalProperties": False,
}
SCHEMA = {
    "type": "object",
    "properties": {
        "footage": {"type": "string", "description": "two sentences: what the clips show and how usable they are"},
        "product_label": {"type": "string", "description": "short on-screen product name, 2-5 words"},
        "hook": {"type": "string"},
        "keys": {"type": "array", "items": {"type": "string"}},
        "caption_fixes": {
            "type": "array",
            "items": {"type": "object", "properties": {"heard": {"type": "string"}, "correct": {"type": "string"}},
                      "required": ["heard", "correct"], "additionalProperties": False},
        },
        "vertical": {"type": "array", "items": SEG},
        "horizontal": {"type": "array", "items": SEG},
        "horizontal_captions": {"type": "boolean", "description": "burn captions into the horizontal cut"},
        "thumbnail": {
            "type": "object",
            "properties": {"clip": {"type": "string"}, "time": {"type": "number"}, "text": {"type": "string"},
                           "text_position": {"type": "string", "enum": ["top", "bottom"]}},
            "required": ["clip", "time", "text", "text_position"], "additionalProperties": False,
        },
        "concerns": {"type": "string", "description": "anything weak or missing in the footage Charly should know; empty if none"},
        "spoken_review": {"type": "boolean", "description": "true if Charly or Zanje talk about the product somewhere in the "
                          "clips; false if nobody does (no speech, or only background speech such as announcements, TV or strangers)"},
    },
    "required": ["footage", "product_label", "hook", "keys", "caption_fixes", "vertical", "horizontal",
                 "horizontal_captions", "thumbnail", "concerns", "spoken_review"],
    "additionalProperties": False,
}


@dataclass
class Clip:
    id: str                 # c1, c2, ...
    filename: str
    path: str
    probe: object
    words: list[dict]       # [{"w","s","e"}]
    shot_on: str | None = None
    sheet: bytes | None = None   # contact sheet JPEG


def transcript_lines(words: list[dict], max_words: int = 14) -> list[str]:
    """Phrase-level lines '[12.34-15.80] text', broken at pauses, sentence ends and every few words."""
    lines, cur = [], []
    for i, w in enumerate(words):
        cur.append(w)
        nxt = words[i + 1] if i + 1 < len(words) else None
        if nxt is None or nxt["s"] - w["e"] > 0.6 or len(cur) >= max_words or (w["w"][-1:] in ".?!" and len(cur) >= 4):
            lines.append(f"[{cur[0]['s']:.2f}-{cur[-1]['e']:.2f}] " + " ".join(x["w"] for x in cur))
            cur = []
    return lines


def contact_sheet(frames: list[tuple[float, bytes]], clip_id: str, cols: int = 6, tw: int = 256) -> bytes:
    ims = [Image.open(io.BytesIO(b)).convert("RGB") for _, b in frames]
    th = int(tw * ims[0].height / ims[0].width) if ims else tw
    rows = (len(ims) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * tw, rows * (th + 26)), (20, 20, 24))
    d = ImageDraw.Draw(sheet)
    f = font(20)
    for k, ((t, _), im) in enumerate(zip(frames, ims)):
        x, y = (k % cols) * tw, (k // cols) * (th + 26)
        sheet.paste(im.resize((tw, th)), (x, y + 26))
        d.text((x + 6, y + 2), f"{clip_id} {t:.1f}s", font=f, fill=(255, 214, 0))
    buf = io.BytesIO()
    sheet.save(buf, "JPEG", quality=80)
    return buf.getvalue()


def _clip_header(c: Clip) -> str:
    p = c.probe
    bits = [f"{p.duration:.1f} s", "portrait" if p.portrait else "landscape", f"{p.width}x{p.height}"]
    if p.hdr:
        bits.append("HDR")
    if c.shot_on:
        bits.append(f"filmed on {c.shot_on}")
    return f"Clip {c.id} ({c.filename}): " + ", ".join(bits)


def build_request(product: dict, clips: list[Clip], note: str | None, previous: dict | None) -> list[dict]:
    content: list[dict] = []
    facts = {k: product.get(k) for k in ("name", "brand", "variant", "source", "notes") if product.get(k)}
    if product.get("platforms"):
        facts["planned platforms"] = ", ".join(product["platforms"])
    if product.get("duplicates_left_out"):
        facts["clips"] = (f"{len(clips)} clip(s) below; {product['duplicates_left_out']} duplicate copies of the same takes "
                          "(lower quality) were left out on purpose")
    content.append({"type": "text", "text": "Product:\n" + json.dumps(facts, indent=1, ensure_ascii=False)})
    for c in clips:
        if c.sheet:
            content.append({"type": "text", "text": f"Contact sheet for clip {c.id}:"})
            content.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                                        "data": base64.standard_b64encode(c.sheet).decode()}})
    for c in clips:
        lines = transcript_lines(c.words)
        content.append({"type": "text", "text": _clip_header(c) + "\nTranscript:\n" + ("\n".join(lines) if lines else "(no speech)")})
    ask = "Plan the vertical and the horizontal cut."
    if previous and note:
        ask = ("Charly reviewed the previous edit of this product and asked for changes. Here is the plan that "
               "edit was rendered from:\n" + json.dumps(previous, ensure_ascii=False) +
               "\n\nCharly's note: " + note +
               "\n\nAdjust that plan to address the note. Keep what the note does not criticise; change what it asks for.")
    elif previous:
        ask = ("Charly wants a new cut of an edit they had approved, without saying what to change. Here is the plan "
               "that edit was rendered from:\n" + json.dumps(previous, ensure_ascii=False) +
               "\n\nStart from that plan and make the cut better: keep its strongest moments, tighten the pacing, "
               "and fix anything that breaks the rules above.")
    elif note:
        ask += "\n\nCharly's note for this edit: " + note
    content.append({"type": "text", "text": ask})
    return [{"role": "user", "content": content}]


# ---------------------------------------------------------------- snapping and checks

def _find(words: list[dict], phrase: str, near: float, use_end: bool, window: float = 4.0) -> int | None:
    toks = [norm(x) for x in phrase.split() if norm(x)]
    if not toks:
        return None
    nw = [norm(w["w"]) for w in words]
    best, best_d = None, None
    for i in range(len(words) - len(toks) + 1):
        if nw[i:i + len(toks)] != toks:
            continue
        j = i + len(toks) - 1 if use_end else i
        t = words[j]["e"] if use_end else words[j]["s"]
        d = abs(t - near)
        if d <= window and (best_d is None or d < best_d):
            best, best_d = j, d
    return best


def snap(seg: dict, clip: Clip) -> tuple[float, float, str]:
    """Clip times for a planned moment: from its first/last words when they are found near the planned times."""
    dur = clip.probe.duration
    a, b = float(seg["start"]), float(seg["end"])
    note = ""
    ws = clip.words
    if seg["kind"] == "talk" and ws:
        i = _find(ws, seg.get("first_words", ""), a, use_end=False)
        j = _find(ws, seg.get("last_words", ""), b, use_end=True)
        if i is None:   # nearest word that starts around the planned start
            cand = [k for k, w in enumerate(ws) if w["s"] >= a - 0.4]
            i = cand[0] if cand else None
            note += " first words not found;"
        if j is None:
            cand = [k for k, w in enumerate(ws) if w["e"] <= b + 0.4]
            j = cand[-1] if cand else None
            note += " last words not found;"
        if i is not None and j is not None and j >= i:
            a, b = ws[i]["s"] - PAD_IN, ws[j]["e"] + PAD_OUT
    a, b = max(0.0, a), min(dur - 0.05, b)
    if b - a < 0.5:
        b = min(dur - 0.05, a + 1.0)
    return round(a, 2), round(b, 2), note.strip()


def split_pauses(a: float, b: float, words: list[dict], gap: float) -> list[tuple[float, float]]:
    """Cut silences longer than `gap` out of a spoken moment."""
    ws = [w for w in words if w["s"] >= a - 0.05 and w["e"] <= b + 0.1]
    if len(ws) < 2:
        return [(a, b)]
    out, start = [], a
    for w, nxt in zip(ws, ws[1:]):
        if nxt["s"] - w["e"] > gap:
            out.append((start, round(w["e"] + PAD_IN, 2)))
            start = round(nxt["s"] - PAD_IN, 2)
    out.append((start, b))
    return [(x, y) for x, y in out if y - x >= 0.25]


AMAZON = re.compile(r"amazon", re.I)


def resolve(plan: dict, clips: dict[str, Clip], which: str) -> tuple[list[dict], list[str]]:
    """The cut's pieces with snapped times and pauses removed, plus problems to send back to Claude."""
    out, problems = [], []
    for n, seg in enumerate(plan[which]):
        c = clips.get(seg["clip"])
        if not c:
            problems.append(f"{which} moment {n + 1}: there is no clip {seg['clip']}.")
            continue
        a, b, note = snap(seg, c)
        spans = split_pauses(a, b, c.words, GAP[which]) if seg["kind"] == "talk" else [(a, b)]
        said = " ".join(w["w"] for w in c.words if w["s"] >= a - 0.05 and w["e"] <= b + 0.1)
        if which == "vertical" and AMAZON.search(said):
            problems.append(f"vertical moment {n + 1} ({c.id} {a:.1f}-{b:.1f}) says Amazon: \"{said[:120]}\".")
        out.append({**seg, "a": a, "b": b, "spans": spans, "said": said, "snap_note": note,
                    "length": round(sum(y - x for x, y in spans), 2)})
    return out, problems


def check(plan: dict, clips: dict[str, Clip]) -> tuple[dict, list[str]]:
    v, pv = resolve(plan, clips, "vertical")
    h, ph = resolve(plan, clips, "horizontal")
    problems = pv + ph
    total_footage = sum(c.probe.duration for c in clips.values())
    vl, hl = sum(x["length"] for x in v), sum(x["length"] for x in h)
    if not VERTICAL[0] - 1 <= vl <= VERTICAL[1] + 0.5:
        problems.append(f"The vertical cut is {vl:.1f} s after pauses are trimmed; it must be {VERTICAL[0]:.0f}-{VERTICAL[1]:.0f} s. "
                        f"Its moments last: " + ", ".join(f"{x['clip']} {x['a']:.1f}-{x['b']:.1f}: {x['length']:.1f} s" for x in v))
    if hl > HORIZONTAL[1] + 8 or (hl < HORIZONTAL[0] - 8 and total_footage > HORIZONTAL[0] * 1.5):
        problems.append(f"The horizontal cut is {hl:.1f} s after pauses are trimmed; it must be {HORIZONTAL[0]:.0f}-{HORIZONTAL[1]:.0f} s.")
    for t in (plan["hook"], plan["product_label"], plan["thumbnail"]["text"]):
        if AMAZON.search(t):
            problems.append(f"On-screen text must not say Amazon: \"{t}\".")
    if plan["thumbnail"]["clip"] not in clips:
        problems.append(f"The thumbnail names clip {plan['thumbnail']['clip']}, which does not exist.")
    return {"vertical": v, "horizontal": h, "vertical_s": round(vl, 1), "horizontal_s": round(hl, 1)}, problems


# ---------------------------------------------------------------- the call

@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read: int = 0
    cache_write: int = 0
    calls: int = 0

    def add(self, u) -> None:
        self.input_tokens += u.input_tokens or 0
        self.output_tokens += u.output_tokens or 0
        self.cache_read += getattr(u, "cache_read_input_tokens", 0) or 0
        self.cache_write += getattr(u, "cache_creation_input_tokens", 0) or 0
        self.calls += 1

    @property
    def usd(self) -> float:   # Claude Opus 5.5: $4 / $20 per MTok, cache reads $0.20, 5-minute cache writes 1.25x
        return round((self.input_tokens * 4 + self.output_tokens * 20 + self.cache_read * 0.2 + self.cache_write * 5) / 1e6, 4)


def _ask(client: anthropic.Anthropic, messages: list[dict], usage: Usage):
    with client.beta.messages.stream(
        model=MODEL,
        max_tokens=32000,
        system=SYSTEM,
        messages=messages,
        thinking={"type": "adaptive"},
        output_config={"effort": "high", "format": {"type": "json_schema", "schema": SCHEMA}},
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
    ) as stream:
        msg = stream.get_final_message()
    usage.add(msg.usage)
    if msg.stop_reason == "refusal":
        raise RuntimeError("Claude declined to plan this edit" + (f" ({msg.stop_details.category})" if msg.stop_details else "") + ".")
    if msg.stop_reason == "max_tokens":
        raise RuntimeError("Claude's plan was cut off (max_tokens).")
    text = next(b.text for b in msg.content if b.type == "text")
    return msg, json.loads(text)


def make_plan(client: anthropic.Anthropic, product: dict, clips: list[Clip], note: str | None,
              previous: dict | None, log=print) -> tuple[dict, dict, Usage]:
    """The plan, its resolved pieces, and token usage. One revision round when the plan breaks a rule.
    When nobody talks about the product (plan["spoken_review"] false) the plan is returned unchecked: the
    caller asks Charly about a voice-over instead of rendering it."""
    usage = Usage()
    by_id = {c.id: c for c in clips}
    messages = build_request(product, clips, note, previous)
    msg, plan = _ask(client, messages, usage)
    if not plan.get("spoken_review", True):
        return plan, {"vertical": [], "horizontal": [], "vertical_s": 0, "horizontal_s": 0, "problems": []}, usage
    resolved, problems = check(plan, by_id)
    if problems:
        log("Plan needs a revision: " + " | ".join(problems))
        messages = messages + [
            {"role": "assistant", "content": msg.content},
            {"role": "user", "content": "The plan breaks these rules once rendered:\n- " + "\n- ".join(problems) +
             "\n\nReturn the whole plan again with these fixed."},
        ]
        msg, plan = _ask(client, messages, usage)
        resolved, problems = check(plan, by_id)
        if problems:
            log("Still after revision: " + " | ".join(problems))
    resolved["problems"] = problems
    return plan, resolved, usage
