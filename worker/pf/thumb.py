"""Thumbnail: one real frame from the footage plus a short phrase in the house font.

Same rule as the July engine (thumbnail_utils.py): the people in a thumbnail are always the real people
from the video. Nothing here generates or alters faces; it crops, lifts colour and adds text.
"""
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

from .text import font, norm, YELLOW

W, H = 1280, 720


def _base(frame: Image.Image) -> Image.Image:
    """16:9 from the frame: a landscape frame is cover-cropped; a portrait one sits over a blurred copy."""
    f = frame.convert("RGB")
    if f.width / f.height >= 1.3:
        s = max(W / f.width, H / f.height)
        f = f.resize((round(f.width * s), round(f.height * s)), Image.LANCZOS)
        x, y = (f.width - W) // 2, (f.height - H) // 2
        img = f.crop((x, y, x + W, y + H))
    else:
        s = max(W / f.width, H / f.height)
        bg = f.resize((round(f.width * s), round(f.height * s)), Image.LANCZOS)
        bx, by = (bg.width - W) // 2, (bg.height - H) // 2
        bg = bg.crop((bx, by, bx + W, by + H)).filter(ImageFilter.GaussianBlur(28))
        bg = ImageEnhance.Brightness(bg).enhance(0.8)
        fg = f.resize((round(f.width * H / f.height), H), Image.LANCZOS)
        bg.paste(fg, ((W - fg.width) // 2, 0))
        img = bg
    img = ImageEnhance.Color(img).enhance(1.15)
    img = ImageEnhance.Contrast(img).enhance(1.08)
    return ImageEnhance.Sharpness(img).enhance(1.2)


def make(frame_path: str, text: str, keys: set[str], position: str, out: str) -> None:
    img = _base(Image.open(frame_path)).convert("RGBA")
    words = text.upper().split()
    px = 104 if len(text) <= 18 else 88 if len(text) <= 30 else 74
    fnt = font(px)
    d = ImageDraw.Draw(img)
    rows, row = [], []
    for w in words:
        if row and d.textlength(" ".join(row + [w]), font=fnt) > W * 0.86:
            rows.append(row)
            row = []
        row.append(w)
    if row:
        rows.append(row)
    lh = int(px * 1.1)
    block = len(rows) * lh
    top = 40 if position == "top" else H - 48 - block
    # a soft dark band behind the words so they read on any frame
    shade = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shade)
    y0, y1 = (0, top + block + 70) if position == "top" else (top - 70, H)
    for y in range(max(0, y0), min(H, y1)):
        k = (y - y0) / max(1, y1 - y0)
        alpha = int(150 * ((1 - k) if position == "top" else k))
        sd.line([(0, y), (W, y)], fill=(0, 0, 0, alpha))
    img = Image.alpha_composite(img, shade)
    d = ImageDraw.Draw(img)
    y = top
    for r in rows:
        x = (W - d.textlength(" ".join(r), font=fnt)) / 2
        for w in r:
            d.text((x + 4, y + 5), w, font=fnt, fill=(0, 0, 0, 160))
            d.text((x, y), w, font=fnt, fill=YELLOW if norm(w) in keys else (255, 255, 255), stroke_width=7, stroke_fill=(0, 0, 0))
            x += d.textlength(w + " ", font=fnt)
        y += lh
    img.convert("RGB").save(out, "JPEG", quality=92)
