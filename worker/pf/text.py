"""On-screen text: word-by-word caption chunks (origcut.py) and transparent PNGs in the house font (lion.text_png)."""
import re
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

FONT = str(Path(__file__).resolve().parent.parent / "assets" / "Stilu-SemiBold.otf")
YELLOW = (255, 214, 0)


@lru_cache(maxsize=32)
def font(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT, size)


def norm(w: str) -> str:
    return re.sub(r"[^a-z0-9']", "", w.lower())


def fix_word(w: str, fix: dict[str, str]) -> str:
    """Apply the caption fix map ({heard: correct}, lower-case keys) to one word, keeping its punctuation."""
    if w.lower() in fix:
        return fix[w.lower()]
    core = w.strip(".,!?\"'")
    rep = fix.get(core.lower())
    return w.replace(core, rep) if rep is not None and core else w


def apply_fixes(words: list[dict], fixes: dict[str, str]) -> list[dict]:
    """Fixes may be several words ("nano type" -> "nano tape"): match runs of words, then single words."""
    fx = {k.lower().strip(): v for k, v in fixes.items() if k.strip()}
    multi = {tuple(norm(x) for x in k.split()): v for k, v in fx.items() if len(k.split()) > 1}
    single = {k: v for k, v in fx.items() if len(k.split()) == 1}
    out, i = [], 0
    while i < len(words):
        hit = None
        for key, rep in multi.items():
            n = len(key)
            if tuple(norm(w["w"]) for w in words[i:i + n]) == key:
                hit = (n, rep)
                break
        if hit:
            n, rep = hit
            tail = words[i + n - 1]["w"][-1] if words[i + n - 1]["w"][-1:] in ".,!?" else ""
            out.append({"w": rep + tail, "s": words[i]["s"], "e": words[i + n - 1]["e"]})
            i += n
            continue
        w = dict(words[i], w=fix_word(words[i]["w"], single))
        if re.fullmatch(r"i('(m|ve|ll|d))?[.,!?]?", w["w"]):   # speech recognition sometimes writes "i'm"
            w["w"] = "I" + w["w"][1:]
        if w["w"]:
            out.append(w)
        i += 1
    return out


def chunks(words: list[dict], keys: set[str], a: float, b: float, t0: float) -> list[tuple[list[tuple[str, bool]], float, float]]:
    """Group the words spoken inside [a, b] into 2-3 word caption chunks, timed from t0 on the output timeline."""
    ws = [w for w in words if w["s"] >= a - 0.05 and w["e"] <= b + 0.1 and w["w"]]
    groups, cur = [], []
    for w in ws:
        cur.append(w)
        end_punct = w["w"][-1] in ".,!?"
        if len(cur) == 3 or (len(cur) >= 2 and end_punct) or (end_punct and len(cur) == 1 and len(w["w"]) > 6):
            groups.append(cur)
            cur = []
    if cur:
        groups.append(cur)
    res = []
    for i, c in enumerate(groups):
        s = max(c[0]["s"], a) - a + t0
        e = (groups[i + 1][0]["s"] - a + t0) if i + 1 < len(groups) else min(c[-1]["e"] + 0.35, b) - a + t0
        res.append(([(w["w"], norm(w["w"]) in keys) for w in c], s, max(e, s + 0.3)))
    return res


def words_of(text: str, keys: set[str]) -> list[tuple[str, bool]]:
    return [(w, norm(w) in keys) for w in text.split()]


def text_png(words: list[tuple[str, bool]], path: str, size: tuple[int, int], px: int, center_y: int,
             maxw: int, stroke: int | None = None) -> None:
    """Wrapped, centred text with a black outline and soft shadow on a transparent canvas; key words yellow."""
    W, H = size
    fnt = font(px)
    stroke = stroke if stroke is not None else max(3, px // 14)
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    rows, row = [], []
    for w, key in words:
        trial = " ".join(x for x, _ in row + [(w, key)])
        if row and d.textlength(trial, font=fnt) > maxw:
            rows.append(row)
            row = []
        row.append((w, key))
    if row:
        rows.append(row)
    lh = int(px * 1.18)
    y = center_y - len(rows) * lh // 2
    for r in rows:
        line = " ".join(w for w, _ in r)
        x = (W - d.textlength(line, font=fnt)) / 2
        for w, key in r:
            d.text((x + 3, y + 4), w, font=fnt, fill=(0, 0, 0, 140))
            d.text((x, y), w, font=fnt, fill=YELLOW if key else (255, 255, 255), stroke_width=stroke, stroke_fill=(0, 0, 0))
            x += d.textlength(w + " ", font=fnt)
        y += lh
    im.save(path)
