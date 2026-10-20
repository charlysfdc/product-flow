"""Claude plans a cut for footage without talking: script lines in Charly's own words, each with the shots
shown while it is read (povcut.py's lines + shots). With music instead of a voice the lines are on-screen text.
"""
import base64
import json

import anthropic

from .plan import MODEL, Clip, Usage, _clip_header, transcript_lines

VERTICAL_WORDS = (65, 95)       # about 30-35 s read aloud
HORIZONTAL_WORDS = (150, 290)   # about 60-120 s

SYSTEM = """You are the video editor and script writer for Charly (AfrikanerinAmerika), an Amazon Influencer and \
TikTok Shop creator. This product was filmed without talking (or the sound is unusable), so the video is carried \
by a voice-over that Charly's own cloned voice will read, over the real footage. You plan two cuts: a vertical one \
(TikTok Shop, Reels) and a horizontal Amazon review. A program renders exactly what you plan.

The script, in Charly's voice:
- First person, warm and plain, like Charly talking to a friend: short sentences, everyday words, a little humour \
when it fits. Charly is South African, living in America, and films with their daughter Zanje.
- Say only what the footage, the product details and common sense support. Never invent results, numbers, health \
claims or experiences that the footage does not show; when unsure, describe what is visible.
- Vertical: 65-95 words in total (30-35 seconds read aloud). The first line is the hook: the most surprising or \
useful thing, never "hi guys". Name the product near the end. Never mention Amazon.
- Horizontal (Amazon review): 150-290 words (60-120 seconds). What it is, the clearest demonstration of it working, \
how it is used, and an honest verdict. Amazon does not allow prices, discounts, shipping talk, links or other stores.
- Write numbers and units the way they are said ("two hours", not "2h"). No emoji, hashtags or stage directions.

Lines and shots: split each script into lines of one or two sentences. Give each line one to three shots: the clip \
id and the second on that clip's own timeline where the shot starts, so the picture matches what the line says. A \
line takes about one second per 2.6 words, shared evenly by its shots, so start each shot where enough footage \
follows. Use the contact sheets to pick moments where the product is clearly visible and something happens; vary \
the shots, and leave out moments where the camera points at nothing. A landscape clip in the vertical cut is \
reframed on the action automatically. If a clip is filmed sideways, set rotate ("left" turns it 90 degrees \
counter-clockwise, "right" clockwise).

Hook: a short on-screen line (at most 7 words) shown over the first 2.6 seconds of the vertical cut. Key words: 3-8 \
single words shown in yellow in the captions. Thumbnail: one real frame (clip and time) where the product is clear \
and sharp, and a 2-5 word phrase. Never invent people or scenes."""

MUSIC_RULES = """

This time there is NO voice-over: Charly chose captions and music only. Each line's "say" is on-screen text (at \
most 8 words, plain and readable at a glance), and "seconds" is how long it stays up (2-5 seconds). The vertical \
cut is 30-35 seconds in total, the horizontal 45-90 seconds. Pick one music track from the list that suits the \
product and put its file name in "music"."""

SHOT = {
    "type": "object",
    "properties": {"clip": {"type": "string"}, "start": {"type": "number"},
                   "rotate": {"type": "string", "enum": ["none", "left", "right", "flip"]}},
    "required": ["clip", "start", "rotate"], "additionalProperties": False,
}
LINE = {
    "type": "object",
    "properties": {"say": {"type": "string"}, "seconds": {"type": "number"},
                   "shots": {"type": "array", "items": SHOT}},
    "required": ["say", "seconds", "shots"], "additionalProperties": False,
}
SCHEMA = {
    "type": "object",
    "properties": {
        "footage": {"type": "string", "description": "two sentences: what the clips show and how usable they are"},
        "product_label": {"type": "string", "description": "short on-screen product name, 2-5 words"},
        "hook": {"type": "string"},
        "keys": {"type": "array", "items": {"type": "string"}},
        "vertical": {"type": "array", "items": LINE},
        "horizontal": {"type": "array", "items": LINE},
        "music": {"type": "string", "description": "music file name (captions-and-music cuts only), else empty"},
        "thumbnail": {
            "type": "object",
            "properties": {"clip": {"type": "string"}, "time": {"type": "number"}, "text": {"type": "string"},
                           "text_position": {"type": "string", "enum": ["top", "bottom"]}},
            "required": ["clip", "time", "text", "text_position"], "additionalProperties": False,
        },
        "concerns": {"type": "string", "description": "anything weak or missing in the footage; empty if none"},
    },
    "required": ["footage", "product_label", "hook", "keys", "vertical", "horizontal", "music", "thumbnail", "concerns"],
    "additionalProperties": False,
}


def words_in(lines: list[dict]) -> int:
    return sum(len(l["say"].split()) for l in lines)


def check(plan: dict, clips: dict[str, Clip], music: bool, tracks: list[str]) -> list[str]:
    problems = []
    for which in ("vertical", "horizontal"):
        for n, line in enumerate(plan[which]):
            if not line["shots"]:
                problems.append(f"{which} line {n + 1} has no shots.")
            for s in line["shots"]:
                c = clips.get(s["clip"])
                if not c:
                    problems.append(f"{which} line {n + 1} names clip {s['clip']}, which does not exist.")
                elif not 0 <= s["start"] < c.probe.duration:
                    problems.append(f"{which} line {n + 1}: {s['clip']} is {c.probe.duration:.1f} s long; {s['start']} is outside it.")
            if "amazon" in line["say"].lower() and which == "vertical":
                problems.append(f"vertical line {n + 1} mentions Amazon.")
    if music:
        v = sum(l["seconds"] for l in plan["vertical"])
        if not 28 <= v <= 37:
            problems.append(f"The vertical captions last {v:.0f} s in total; make it 30-35 s.")
        if tracks and plan["music"] not in tracks:
            problems.append(f"Pick the music from the list: {', '.join(tracks)}.")
    else:
        v, h = words_in(plan["vertical"]), words_in(plan["horizontal"])
        if not VERTICAL_WORDS[0] <= v <= VERTICAL_WORDS[1]:
            problems.append(f"The vertical script is {v} words; it must be {VERTICAL_WORDS[0]}-{VERTICAL_WORDS[1]}.")
        if not HORIZONTAL_WORDS[0] <= h <= HORIZONTAL_WORDS[1]:
            problems.append(f"The horizontal script is {h} words; it must be {HORIZONTAL_WORDS[0]}-{HORIZONTAL_WORDS[1]}.")
    for t in (plan["hook"], plan["product_label"]):
        if "amazon" in t.lower():
            problems.append(f"On-screen text must not say Amazon: \"{t}\".")
    return problems


def build_request(product: dict, clips: list[Clip], note: str | None, previous: dict | None, music: bool, tracks: list[str]) -> list[dict]:
    facts = {k: product.get(k) for k in ("name", "brand", "variant", "notes", "listing_title", "deal_title") if product.get(k)}
    if product.get("platforms"):
        facts["planned platforms"] = ", ".join(product["platforms"])
    content: list[dict] = [{"type": "text", "text": "Product:\n" + json.dumps(facts, indent=1, ensure_ascii=False)}]
    for c in clips:
        if c.sheet:
            content.append({"type": "text", "text": f"Contact sheet for clip {c.id}:"})
            content.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                                        "data": base64.standard_b64encode(c.sheet).decode()}})
    for c in clips:
        lines = transcript_lines(c.words)
        content.append({"type": "text", "text": _clip_header(c) + "\nWhat is said (often nothing):\n" + ("\n".join(lines) if lines else "(no speech)")})
    if tracks:
        content.append({"type": "text", "text": "Music tracks: " + ", ".join(tracks)})
    ask = "Plan both cuts with " + ("on-screen captions and music." if music else "a voice-over script.")
    if previous:
        ask = ("Charly read the previous script and asked for changes. The previous plan:\n" + json.dumps(previous, ensure_ascii=False) +
               "\n\nCharly's note: " + (note or "(no note)") + "\n\nRewrite it to address the note; keep what the note does not criticise.")
    elif note:
        ask += "\n\nCharly's note: " + note
    content.append({"type": "text", "text": ask})
    return [{"role": "user", "content": content}]


def _ask(client: anthropic.Anthropic, system: str, messages: list[dict], usage: Usage):
    with client.beta.messages.stream(
        model=MODEL, max_tokens=32000, system=system, messages=messages,
        thinking={"type": "adaptive"},
        output_config={"effort": "high", "format": {"type": "json_schema", "schema": SCHEMA}},
        betas=["server-side-fallback-2026-07-01"], fallbacks="default",
    ) as stream:
        msg = stream.get_final_message()
    usage.add(msg.usage)
    if msg.stop_reason == "refusal":
        raise RuntimeError("Claude declined to write this script.")
    if msg.stop_reason == "max_tokens":
        raise RuntimeError("Claude's script was cut off (max_tokens).")
    return msg, json.loads(next(b.text for b in msg.content if b.type == "text"))


def make_plan(client: anthropic.Anthropic, product: dict, clips: list[Clip], note: str | None, previous: dict | None,
              music: bool = False, tracks: list[str] | None = None, log=print) -> tuple[dict, list[str], Usage]:
    usage = Usage()
    tracks = tracks or []
    system = SYSTEM + (MUSIC_RULES if music else "")
    by_id = {c.id: c for c in clips}
    messages = build_request(product, clips, note, previous, music, tracks)
    msg, plan = _ask(client, system, messages, usage)
    problems = check(plan, by_id, music, tracks)
    if problems:
        log("Script needs a revision: " + " | ".join(problems))
        messages = messages + [{"role": "assistant", "content": msg.content},
                               {"role": "user", "content": "Fix these and return the whole plan again:\n- " + "\n- ".join(problems)}]
        msg, plan = _ask(client, system, messages, usage)
        problems = check(plan, by_id, music, tracks)
    return plan, problems, usage
