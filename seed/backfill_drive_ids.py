#!/usr/bin/env python3
"""Fill products.drive_folder_id from the Google Drive for desktop mount.

Drive for desktop stores each item's Drive ID as an extended attribute
(com.google.drivefs.item-id#S) on the mounted folder. Reads it for every
product that has a drive_folder_name and no drive_folder_id, and writes the
ID back through the REST API. Run once on the Mac after seeding.

Usage:
  SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SECRET_KEY='sb_secret_...' \
  python3 seed/backfill_drive_ids.py [--products-dir "<Drive mount>/Content Library/Products"] [--dry-run]
"""
import argparse, json, os, subprocess, sys
from pathlib import Path
from urllib import request, parse, error

DEFAULT_DIR = Path.home() / "Library/CloudStorage/GoogleDrive-afrikanerinamerika@gmail.com/My Drive/Content Library/Products"
XATTR = "com.google.drivefs.item-id#S"


def req(base, key, method, path, body=None, query=None):
    q = ("?" + parse.urlencode(query)) if query else ""
    r = request.Request(base + "/rest/v1/" + path + q, method=method)
    for h, v in {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json", "Prefer": "return=minimal"}.items():
        r.add_header(h, v)
    try:
        with request.urlopen(r, data=json.dumps(body).encode() if body is not None else None, timeout=60) as resp:
            t = resp.read().decode()
            return json.loads(t) if t else None
    except error.HTTPError as e:
        sys.exit(f"{method} {path} failed: {e.code} {e.read().decode()[:300]}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--products-dir", default=str(DEFAULT_DIR))
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SECRET_KEY")
    if not (url and key):
        sys.exit("Set SUPABASE_URL and SUPABASE_SECRET_KEY.")
    root = Path(a.products_dir)
    if not root.is_dir():
        sys.exit(f"Drive mount not found: {root}")
    rows = req(url, key, "GET", "products", query={"select": "id,name,drive_folder_name,drive_folder_id", "limit": 5000})
    todo = [r for r in rows if r["drive_folder_name"] and not r["drive_folder_id"]]
    print(f"{len(rows)} products, {len(todo)} need a Drive folder id")
    found = missing = 0
    for r in todo:
        folder = root / r["drive_folder_name"]
        res = subprocess.run(["xattr", "-p", XATTR, str(folder)], capture_output=True, text=True)
        fid = res.stdout.strip()
        if res.returncode != 0 or not fid:
            print(f"  no id for '{r['drive_folder_name']}'")
            missing += 1
            continue
        found += 1
        if not a.dry_run:
            req(url, key, "PATCH", "products", body={"drive_folder_id": fid}, query={"id": "eq." + r["id"]})
    print(f"filled {found}, missing {missing}{' (dry run)' if a.dry_run else ''}")


if __name__ == "__main__":
    main()
