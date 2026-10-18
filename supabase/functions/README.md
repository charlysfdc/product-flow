# Edge functions

Two Deno functions on Supabase, deployed by `.github/workflows/deploy-functions.yml`
on every push to `main` that touches this folder. Nothing runs on the Mac.

| Function | Does | Secrets it needs (Supabase > Edge Functions > Secrets) |
|---|---|---|
| `identify` | Barcode → UPC databases (upcitemdb, Open Products/Beauty Facts) and an Amazon search for the ASIN; photo → Claude (`claude-opus-5-5`) reads brand, product, variant off the box; link → Amazon or TikTok Shop page title, image, ASIN (port of `amazon_utils.py` with the r.jina.ai fallback, then a Claude web search as last resort). | `ANTHROPIC_API_KEY` (photos and the last-resort lookup; a key made inside a workspace, or add `ANTHROPIC_WORKSPACE_ID`); optional `JINA_API_KEY` |
| `drive` | Keeps Charly's Google Drive refresh token (table `google_drive`, service role only), creates `Content Library/Products/<name>` with `raw` and `finished`, uploads the intake photo and records it in `media`. Clips: opens a resumable upload session in `raw` (with the phone's Origin so Google answers CORS) and hands the phone only the session URL; the phone PUTs 8 MiB chunks itself. `finish_upload` checks the size in Drive and records the clip; `sync` records files dropped into `raw`/`finished` by the Drive app or the Mac. | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (the same Google OAuth client used for sign-in) |

Both check the caller's Supabase sign-in and `allowed_emails` themselves, so they are
deployed with `--no-verify-jwt`.

Deploys need the repository secret `SUPABASE_ACCESS_TOKEN` (Supabase > Account >
Access Tokens). The table comes from `supabase/migrations/0005_google_drive.sql`.

Drive access is granted once from the app: Settings > Connect Google Drive signs in
again with the Drive scope and hands the refresh token to `drive` (`save_token`).

Clip uploads can be tried locally without Drive: `node web/scripts/fake-drive-upload.mjs`
(optionally `DROP=0.2` to cut chunks off, `SLOW=600` to slow it down), then `npm run dev`
and open `/?demo=1`.
