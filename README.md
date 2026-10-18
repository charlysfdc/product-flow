# Product Flow

A phone web app for Charly and Zanje that tracks every product from the box to
posted: Received → Filmed → Editing → Ready → Done. Footage stays in the Google
Drive Content Library; the database is Supabase; the app installs to the iPhone
home screen (no App Store).

Plan: https://claude.ai/code/artifact/73c6ab82-21f3-44be-939b-45d31d64e8b5

## What is here

| Folder | What |
|---|---|
| `supabase/migrations/` | Postgres schema: products, listings, media, posts, jobs, profiles, allowed_emails, row-level security |
| `seed/` | `apply_migrations.py` (runs the schema) and `seed_tracker.py` (one-time import of the Product Tracker) |
| `web/` | React + Vite + TypeScript PWA talking straight to Supabase |
| `.github/workflows/deploy.yml` | Builds and publishes `web/` to GitHub Pages on every push to `main` |

## One-time setup

Tools live under `~/.local` (no Homebrew needed): Node 24 in `~/.local/node`,
GitHub CLI in `~/.local/bin/gh`. `~/.zshrc` puts both on the PATH; open a new
terminal or run `source ~/.zshrc`.

### 1. Supabase project

Create a free project at https://supabase.com/dashboard and collect:

- Project URL and publishable key (`sb_publishable_...`) → `web/.env.local`
  and `web/.env.production` (both public by design)
- Secret key (`sb_secret_...`) → only for `seed_tracker.py`, never in the app
- Database connection string (Connect → Session pooler) → `apply_migrations.py`,
  or paste the migration into the dashboard's SQL editor instead

Current project: `cjtiiufrtmwdqgikpcxi` (created 18 Oct 2026, East US).

### 2. Schema

```bash
SUPABASE_DB_URL='postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres' seed/.venv/bin/python seed/apply_migrations.py
```

(`seed/.venv` is a Python virtualenv with `psycopg`; recreate it with
`python3 -m venv seed/.venv && seed/.venv/bin/pip install "psycopg[binary]"`.)

### 3. Google sign-in

Only the Google accounts in the `allowed_emails` table can sign in; Charly's
is seeded. Add Zanje in the Supabase SQL editor:

```sql
insert into allowed_emails (email, note) values ('her@gmail.com', 'Zanje');
```

Then in Google Cloud Console (same project as the Drive credentials is fine):
APIs & Services → Credentials → Create credentials → OAuth client ID → Web
application. Authorised redirect URI: `https://<ref>.supabase.co/auth/v1/callback`.
Copy the client ID and secret into Supabase → Authentication → Providers →
Google and enable it.

In Supabase → Authentication → URL Configuration set the Site URL to the
deployed app URL and add these Redirect URLs:

- `http://localhost:5173/**`
- `https://<your-pages-host>/product-flow/**`

### 4. Seed from the tracker (once)

```bash
SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SECRET_KEY='sb_secret_...' python3 seed/seed_tracker.py
```

Reads `~/meta-api/library/tracker/` (`folders.json`, `Product Tracker.csv`,
`amazon_videos.json`, `video_to_folder.json`) and creates products, listings
(Amazon ASINs, TikTok Shop checks) and posts (Amazon videos with views).
Status rules from `build.py`: Amazon video present → Done; raw clips but no
Amazon video → Filmed; finished video only → Ready; no footage → Received.
Re-running only adds rows that are missing. After this the spreadsheet is
retired; nothing reads or writes it. `--dry-run` shows the counts without
touching the database.

## Run locally

```bash
cd web
cp .env.example .env.local   # fill in the URL and anon key
npm install
npm run dev -- --host        # then open the printed LAN URL on the phone
```

## Deploy (GitHub Pages)

1. `gh auth login` once on the Mac, then `gh repo create product-flow --public --source . --push`
   (Pages is free on public repositories; the repo holds code only, no data or secrets).
2. Repository → Settings → Pages → Source: **GitHub Actions**.
3. Every push to `main` deploys to `https://<user>.github.io/product-flow/`.

## Install on the iPhone

Open the app URL in Safari, sign in with Google, tap Share → **Add to Home
Screen**. It opens full-screen like an app and stays signed in.

## Phases

- **0 Foundation** (this): schema, seed, sign-in, Home lists, read-only Product screen.
- 1 Intake: add product by barcode/photo/link, identify job.
- 2 Film: upload clips from the phone straight into Drive.
- 3 Edit: cloud worker cuts, captions and thumbnails.
- 4 Publish: per-platform checklist and Amazon views.
