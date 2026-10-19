# Edge functions

Deno functions on Supabase, deployed by `.github/workflows/deploy-functions.yml`
on every push to `main` that touches this folder. Nothing runs on the Mac.

| Function | Does | Secrets it needs (Supabase > Edge Functions > Secrets) |
|---|---|---|
| `identify` | Barcode → UPC databases (upcitemdb, Open Products/Beauty Facts) and an Amazon search for the ASIN; photo → Claude (`claude-opus-5-5`) reads brand, product, variant off the box; link → Amazon or TikTok Shop page title, image, ASIN (port of `amazon_utils.py` with the r.jina.ai fallback, then a Claude web search as last resort). | `ANTHROPIC_API_KEY` (photos and the last-resort lookup; a key made inside a workspace, or add `ANTHROPIC_WORKSPACE_ID`); optional `JINA_API_KEY` |
| `edit` | Phase 3, the phone's side: `start` queues an edit job and wakes the Modal worker, `retry`, `approve` (product to Ready), `redo` (cut moves to `finished/Earlier drafts`, new job with the note), `review` (signed links for the review screen). | `WORKER_SECRET`, `MODAL_EDIT_URL` (both set by the deploy workflows) |
| `worker` | Called only by the Modal worker with `WORKER_SECRET`: `claim`, `progress`, `token`, `finish`, `fail`. Hands the worker a Drive token and the Claude key per job, so Modal stores neither. See `worker/README.md`. | `WORKER_SECRET`, plus `ANTHROPIC_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| `media` | GET only: streams a finished file from Drive (with Range, so Safari can seek) for a link signed by `edit` `review`. | `WORKER_SECRET` (signs the links) |
| `drive` | Keeps Charly's Google Drive refresh token (table `google_drive`, service role only), creates `Content Library/Products/<name>` with `raw` and `finished`, uploads the intake photo and records it in `media`. Clips: opens a resumable upload session in `raw` (with the phone's Origin so Google answers CORS) and hands the phone only the session URL; the phone PUTs 8 MiB chunks itself. `finish_upload` checks the size in Drive and records the clip; `sync` records files dropped into `raw`/`finished` by the Drive app or the Mac. | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (the same Google OAuth client used for sign-in) |

`identify`, `drive` and `edit` check the caller's Supabase sign-in and `allowed_emails` themselves; `worker`
checks `WORKER_SECRET` and `media` a signature. All are deployed with `--no-verify-jwt`.

Deploys need the repository secret `SUPABASE_ACCESS_TOKEN` (Supabase > Account >
Access Tokens). The table comes from `supabase/migrations/0005_google_drive.sql`.

Drive access is granted once from the app: Settings > Connect Google Drive signs in
again with the Drive scope and hands the refresh token to `drive` (`save_token`).

Clip uploads can be tried locally without Drive: `node web/scripts/fake-drive-upload.mjs`
(optionally `DROP=0.2` to cut chunks off, `SLOW=600` to slow it down), then `npm run dev`
and open `/?demo=1`.
