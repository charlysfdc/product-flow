# Edit worker (Phase 3)

Cuts a product's raw clips into a vertical video (TikTok Shop, Reels), a horizontal Amazon review and a
thumbnail, and puts them in `Content Library/Products/<product>/finished`. Runs on [Modal](https://modal.com),
scales to zero between edits, and never needs the Mac.

## How an edit runs

1. Charly taps **Edit** on a filmed product. The `edit` function inserts a `jobs` row (type `edit`, status
   `queued`, input: the picked clips and an optional note), sets the product to Editing and POSTs the job id
   to the Modal endpoint with `WORKER_SECRET`.
2. `app.py` `start` answers at once and spawns `edit_job` (8 CPUs, 16 GB).
3. `edit_job` claims the job through the `worker` function, which hands back the product, the clip list, the
   plan to redo (if any), a Drive access token, the `finished` folder id and the Claude key.
4. `pf/pipeline.py`: download the clips from Drive; skip duplicate takes (same length, keeps the higher
   bitrate); read size, rotation and HDR; contact sheets of frames; 16 kHz audio to a T4 running
   faster-whisper `large-v3-turbo` for word timestamps; Claude (`claude-opus-5-5`, structured output) plans
   both cuts from the transcripts, the contact sheets, the product and Charly's rules; the plan is checked
   (30-37 s vertical, no Amazon in the vertical, 60-120 s horizontal) and sent back once for a fix if needed;
   moments are snapped to word timings and pauses over 0.6 s (vertical) / 0.9 s (horizontal) are cut;
   ffmpeg renders each piece (HDR tone-mapped, fitted over a blurred copy, captions 2-3 words at a time with
   key words yellow, hook for 2.6 s, product name on the last moment), joins them and normalises loudness to
   -14 LUFS; the thumbnail is a real frame plus a short phrase in Stilu.
5. The files go to `finished/` as `<product> - vertical (auto vN).mp4`, `- horizontal (auto vN).mp4`,
   `- thumbnail (auto vN).jpg`; `worker` `finish` adds the media rows and sets the job to `needs_review`.
   Progress goes to `jobs.output.progress` on the way, which the phone sees live (realtime on `jobs`).
6. Review screen: **Approve** sets the product to Ready ("Edited, not posted"). **Redo** moves this cut to
   `finished/Earlier drafts`, and a new job gets the note plus the previous plan so Claude adjusts it.
   The review screen and Save video play the finished files from the Modal `media` endpoint (`pf/media.py`,
   a small CPU container), with links signed by Supabase; video bytes no longer pass through Supabase, whose
   Free plan allows only 5 GB of egress a month (Modal's Starter plan includes 1 TiB).

## Voice-over (footage without talking)

- After transcription, footage with under 15 words or under 10% speech stops at once; otherwise the planner also
  says whether Charly or Zanje talk about the product (`spoken_review`), so a pilot announcement or a TV does not
  count. Either way the job goes to `needs_review` with `output.stage = 'ask_voiceover'` and the question
  "No talking found in these clips. Create a voice-over?" (Create voice-over · Captions & music only · Cancel).
- Create voice-over, or the "Add a voice-over" switch on the Edit sheet: `input.voiceover = 'script'`. Claude
  (`pf/voiceplan.py`) writes both scripts as lines, each with the shots it plays over; the job stops at
  `stage = 'script'` and the phone's Voice-over script screen lets Charly edit each line, approve it, or have it
  written again with a note. Nothing is spoken before approval.
- Approve script: `input.voiceover = 'render'` with the edited lines in `input.vo_plan`. `pf/voice.py` reads each
  script in one ElevenLabs call (voice "Charly South African", `eleven_v3`, with timestamps), sped up at most
  1.2x if it runs long; captions come from the timestamps; the clips' own sound is lowered 18 dB under the voice.
  ElevenLabs characters are recorded in `jobs.output.elevenlabs`.
- Captions & music only: `input.voiceover = 'music'`; on-screen lines over a track from `Content Library/Music`
  in Drive (found, never created; without it the cut keeps only the clips' sound).
- A Redo of a voiced cut goes back to the script with the note. The ElevenLabs key is the Supabase secret
  `ELEVENLABS_API_KEY`, handed to the worker by `worker` `claim` only for the reading step.

## Why the secrets are where they are

Modal holds one secret, `WORKER_SECRET`. Google (the Drive refresh token, client id and secret) and
Anthropic credentials stay in Supabase, where they already were for Phases 1-2. The worker asks the
`worker` function for a one-hour Drive token and the Claude key at the start of each job, authenticated with
`WORKER_SECRET`, and reports progress and results the same way, so it never holds the Supabase secret key
and can only touch what the `worker` function exposes. `WORKER_SECRET` lives in the GitHub repository
secrets; the deploy workflows copy it into Modal and Supabase, so nobody pastes it anywhere. Rotate it by
setting a new value in GitHub and re-running both deploy workflows.

| Where | Secrets |
|---|---|
| GitHub repository | `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET` (Charly), `WORKER_SECRET` (generated), `SUPABASE_ACCESS_TOKEN` (Phase 1) |
| Modal secret `product-flow-worker` | `WORKER_SECRET` (set by `deploy-worker.yml`) |
| Supabase function secrets | `WORKER_SECRET`, `MODAL_EDIT_URL`, `MODAL_MEDIA_URL` (set by the workflows), plus the existing `ANTHROPIC_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |

## Deploy

`.github/workflows/deploy-worker.yml` runs on every push to `main` that touches `worker/`: it stores
`WORKER_SECRET` in Modal, runs `modal deploy app.py`, reads the endpoint URLs and saves them in Supabase as
`MODAL_EDIT_URL` and `MODAL_MEDIA_URL`. The Supabase functions (`edit`, `worker`, `media`) deploy with the others from
`deploy-functions.yml`.

## Cost per edit

Each finished job records its own cost in `jobs.output.cost` (shown at the bottom of the review screen):
CPU seconds × 8 cores, T4 seconds for transcription, and Claude tokens at Opus 5.5 prices ($4 / $20 per
million input / output tokens). Modal list prices used: CPU $0.0000131 per core-second, memory $0.00000222
per GiB-second, T4 $0.000164 per second. The T4 also bills its start-up and 60 s of idle before it stops.

## Try it on the Mac (development only)

```bash
uv venv --python 3.12 worker/.venv && uv pip install --python worker/.venv/bin/python modal==1.6.2 anthropic==1.15.0 pillow==13.0.0 faster-whisper==1.2.1 imageio-ffmpeg==0.6.0 numpy requests "fastapi[standard]"
worker/.venv/bin/python worker/local_run.py "Castor Oil" --out /tmp/castor
```

`local_run.py` reads the clips from the Google Drive for desktop mount, transcribes on the CPU, needs
`ANTHROPIC_API_KEY` for the plan (or `--plan <earlier plan.json>` to skip Claude) and leaves the results in
`--out`; it uploads nothing and touches no job.

The caption and thumbnail font is Stilu SemiBold by Genilson Lima Santos, SIL Open Font License 1.1
(`assets/OFL.txt`).
