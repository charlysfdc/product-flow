#!/usr/bin/env python3
"""One-time import of the Product Tracker into Supabase.

Reads (never writes) the tracker build directory:
  folders.json          raw/finished counts per Content Library folder
  Product Tracker.csv   one row per product (folders + Amazon-only products)
  amazon_videos.json    ViralVue export of Amazon videos
  video_to_folder.json  video id -> folder name match

Writes products, listings and posts through the Supabase REST API with the
secret key (sb_secret_..., or the legacy service_role key). Safe to re-run: rows that already exist (by product name,
by listing platform+id, by post id) are left alone, so edits made in the app
are never overwritten. After this import the spreadsheet is retired.

Usage:
  SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SECRET_KEY=sb_secret_... \
  python3 seed/seed_tracker.py [--tracker-dir ~/meta-api/library/tracker] [--dry-run]
"""
import argparse, csv, json, os, sys, datetime
from collections import defaultdict
from pathlib import Path
from urllib import request, parse, error

DEFAULT_TRACKER = Path.home() / "meta-api" / "library" / "tracker"
TIKTOK_CHECKED_ON = "2026-10-17"   # date of the phone check recorded in build.py

# Brands that can be read straight off the folder name.
KNOWN_BRANDS = [
    "Wonderskin", "Kitsch", "Wolfbox", "Full Shine", "Alien Tape", "Bell+Howell", "Flashforge",
    "Koziful", "Eufy", "ThermPro", "iClimb", "Eru", "Colorsmile", "Creality", "Anker", "Ninja",
    "Dyson", "Shark", "Bissell", "Govee", "Blink", "Ring", "Keurig", "Instant Pot", "Stanley",
    "Owala", "Yeti", "Carhartt", "Levi's", "Olaplex", "CeraVe", "Neutrogena", "Maybelline",
]


class Api:
    def __init__(self, url, key, dry_run=False):
        self.base = url.rstrip("/") + "/rest/v1/"
        self.key = key
        self.dry_run = dry_run

    def _req(self, method, path, body=None, query=None, prefer=None):
        q = ("?" + parse.urlencode(query)) if query else ""
        req = request.Request(self.base + path + q, method=method)
        req.add_header("apikey", self.key)
        req.add_header("Authorization", f"Bearer {self.key}")
        req.add_header("Content-Type", "application/json")
        req.add_header("Prefer", prefer or "return=representation")
        data = json.dumps(body).encode() if body is not None else None
        try:
            with request.urlopen(req, data=data, timeout=60) as r:
                txt = r.read().decode()
                return json.loads(txt) if txt else None
        except error.HTTPError as e:
            sys.exit(f"{method} {path} failed: {e.code} {e.read().decode()[:500]}")

    def select_all(self, table, columns="*"):
        out, offset, page = [], 0, 1000
        while True:
            rows = self._req("GET", table, query={"select": columns, "offset": offset, "limit": page})
            out.extend(rows)
            if len(rows) < page:
                return out
            offset += page

    def insert(self, table, rows):
        if not rows:
            return []
        if self.dry_run:
            print(f"  [dry-run] would insert {len(rows)} into {table}")
            return [dict(r, id=f"dry-{i}") for i, r in enumerate(rows)]
        # PostgREST bulk inserts need identical keys on every row
        keys = sorted({k for r in rows for k in r})
        rows = [{k: r.get(k) for k in keys} for r in rows]
        out = []
        for i in range(0, len(rows), 200):
            out.extend(self._req("POST", table, rows[i:i + 200]))
        return out


def derive_brand(name):
    low = name.lower()
    for b in KNOWN_BRANDS:
        if low.startswith(b.lower() + " ") or f" {b.lower()} " in f" {low} ":
            return b
    return None


def status_for(raw, finished, amazon_videos):
    """The build.py rules, as app statuses."""
    if amazon_videos:
        return "done"        # on Amazon already
    if raw:
        return "filmed"      # footage waiting for an edit + upload
    if finished:
        return "ready"       # a finished video that was never posted
    return "received"        # no footage at all


def tiktok_availability(text):
    t = (text or "").strip().lower()
    if t.startswith("yes"):
        return "exact"
    if t.startswith("similar"):
        return "similar_only"
    if t.startswith("no"):
        return "not_listed"
    return "unchecked"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tracker-dir", default=str(DEFAULT_TRACKER))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SECRET_KEY") or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not args.dry_run and not (url and key):
        sys.exit("Set SUPABASE_URL and SUPABASE_SECRET_KEY (or use --dry-run).")
    api = Api(url or "https://dry.run", key or "", dry_run=args.dry_run)

    d = Path(args.tracker_dir).expanduser()
    folders = json.load(open(d / "folders.json"))
    vids = json.load(open(d / "amazon_videos.json"))
    v2f = json.load(open(d / "video_to_folder.json"))
    rows = list(csv.DictReader(open(d / "Product Tracker.csv", newline="")))
    export_date = datetime.date.fromtimestamp(os.path.getmtime(d / "amazon_videos.json")).isoformat()

    # videos per product (build.py: "NEW: X" means an Amazon-only product called X)
    amz = defaultdict(list)
    for v in vids:
        f = v2f.get(v["id"], {}).get("folder", "NEW: Unmatched")
        amz[f.replace("NEW: ", "")].append(v)

    # ---- products ------------------------------------------------------
    existing = {p["name"].lower(): p for p in (api.select_all("products", "id,name") if not args.dry_run else [])}
    new_products = []
    for r in rows:
        n = r["Product"]
        if n.lower() in existing:
            continue
        fo = folders.get(n)
        raw, fin = (fo["raw"], fo["finished"]) if fo else (0, 0)
        av = amz.get(n, [])
        notes = []
        if fo:
            notes.append(f"Library on {export_date}: {raw} raw clip(s), {fin} finished video(s).")
        else:
            notes.append("Footage not in the Content Library (only on Amazon).")
        if r.get("Social posts"):
            notes.append("Socials: " + r["Social posts"])
        if r.get("Next action"):
            notes.append("Tracker next action: " + r["Next action"])
        if r.get("Notes"):
            notes.append(r["Notes"])
        new_products.append({
            "name": n,
            "brand": derive_brand(n),
            "status": status_for(raw, fin, av),
            "source": "amazon_sample" if av else "unknown",
            "drive_folder_name": n if fo else None,
            "notes": "\n".join(notes),
        })
    print(f"products: {len(existing)} already there, inserting {len(new_products)}")
    inserted = api.insert("products", new_products)
    for p in inserted:
        existing[p["name"].lower()] = p
    pid = lambda name: existing[name.lower()]["id"]

    # ---- listings ------------------------------------------------------
    have = set()
    if not args.dry_run:
        for l in api.select_all("listings", "product_id,platform,external_id"):
            have.add((l["product_id"], l["platform"], l["external_id"] or ""))
    new_listings = []
    def add_listing(row):
        k = (row["product_id"], row["platform"], row.get("external_id") or "")
        if k not in have:
            have.add(k); new_listings.append(row)
    for r in rows:
        n = r["Product"]; p = pid(n)
        asins = []
        if r.get("ASIN"):
            asins.append(r["ASIN"])
        for v in amz.get(n, []):
            for a in v["asins"].split("_"):
                if a and a not in asins:
                    asins.append(a)
        for a in asins:
            add_listing({"product_id": p, "platform": "amazon_us", "external_id": a,
                         "url": f"https://www.amazon.com/dp/{a}", "availability": "exact",
                         "checked_at": export_date})
        tt = r.get("TikTok Shop", "")
        if tt and not tt.lower().startswith("not checked"):
            add_listing({"product_id": p, "platform": "tiktok_shop", "external_id": None,
                         "availability": tiktok_availability(tt), "availability_note": tt,
                         "commission": r.get("TikTok commission") or None, "checked_at": TIKTOK_CHECKED_ON})
    print(f"listings: inserting {len(new_listings)}")
    api.insert("listings", new_listings)

    # ---- posts ---------------------------------------------------------
    have_posts = set()
    if not args.dry_run:
        have_posts = {p["external_id"] for p in api.select_all("posts", "external_id") if p["external_id"]}
    new_posts = []
    for name, vs in amz.items():
        if name.lower() not in existing:
            print(f"  warning: videos for '{name}' have no product row, skipped")
            continue
        for v in vs:
            if v["id"] in have_posts:
                continue
            new_posts.append({
                "product_id": pid(name), "platform": "amazon_us", "status": "posted",
                "external_id": v["id"], "title": v["title"], "views": int(v["views"] or 0),
                "posted_at": v.get("uploaded") or None, "views_checked_at": export_date,
            })
    print(f"posts: inserting {len(new_posts)}")
    api.insert("posts", new_posts)
    print("import finished; the tracker spreadsheet is now retired.")


if __name__ == "__main__":
    main()
