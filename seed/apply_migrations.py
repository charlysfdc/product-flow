#!/usr/bin/env python3
"""Apply supabase/migrations/*.sql to the Product Flow database, in order, once each.

Usage:
  SUPABASE_DB_URL='postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres' \
  seed/.venv/bin/python seed/apply_migrations.py

Keeps a small table (public.schema_migrations) so re-running is safe.
A migration that was pasted into the dashboard SQL editor by hand is recorded
without running it with:  apply_migrations.py --mark 0001_init.sql
"""
import os, sys
from pathlib import Path
import psycopg

ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS = sorted((ROOT / "supabase" / "migrations").glob("*.sql"))

def main():
    mark = sys.argv[2] if len(sys.argv) > 2 and sys.argv[1] == "--mark" else None
    url = os.environ.get("SUPABASE_DB_URL")
    if not url:
        sys.exit("Set SUPABASE_DB_URL (Supabase > Connect > Session pooler connection string).")
    with psycopg.connect(url, autocommit=False) as conn:
        with conn.cursor() as cur:
            cur.execute("create table if not exists public.schema_migrations (name text primary key, applied_at timestamptz not null default now())")
            cur.execute("select name from public.schema_migrations")
            done = {r[0] for r in cur.fetchall()}
            if mark:
                cur.execute("insert into public.schema_migrations (name) values (%s) on conflict do nothing", (mark,))
                conn.commit()
                print(f"marked {mark} as applied")
                return
            for path in MIGRATIONS:
                if path.name in done:
                    print(f"skip  {path.name} (already applied)")
                    continue
                print(f"apply {path.name}")
                cur.execute(path.read_text())
                cur.execute("insert into public.schema_migrations (name) values (%s)", (path.name,))
                conn.commit()
    print("done")

if __name__ == "__main__":
    main()
