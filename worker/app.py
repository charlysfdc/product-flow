"""Product Flow edit worker on Modal.

  POST https://<workspace>--product-flow-edit.modal.run  {"job_id": "..."}   (Authorization: Bearer <WORKER_SECRET>)

The endpoint answers at once and starts `edit_job` in the background. The job asks the Supabase `worker`
function for everything it needs (product, raw clips, a Drive token, the finished folder, the Claude key),
downloads the clips, has a T4 transcribe them with faster-whisper, plans with Claude, renders both cuts and
the thumbnail, uploads them to Products/<product>/finished and reports back. Modal holds one secret,
WORKER_SECRET; Google and Anthropic credentials stay in Supabase.

Deployed by .github/workflows/deploy-worker.yml on every push to main that touches worker/.
"""
import json
import os
import time
import traceback
from pathlib import Path

import modal

HERE = Path(__file__).resolve().parent
SUPABASE_URL = "https://cjtiiufrtmwdqgikpcxi.supabase.co"
WHISPER_MODEL = "large-v3-turbo"
EDIT_CPU, EDIT_MEMORY_GB = 8.0, 16

app = modal.App("product-flow")
secret = modal.Secret.from_name("product-flow-worker", required_keys=["WORKER_SECRET"])

edit_image = (
    modal.Image.debian_slim(python_version="3.12")
    .uv_pip_install("imageio-ffmpeg==0.6.0", "pillow==13.0.0", "numpy==2.5.4", "opencv-python-headless==5.0.0.93", "anthropic==1.15.0", "requests==2.34.2", "fastapi[standard]==0.146.0")
    # the static ffmpeg must have what the recipe uses: x264, zscale (HDR) and tonemap
    .run_commands("python -c \"import imageio_ffmpeg,subprocess;f=imageio_ffmpeg.get_ffmpeg_exe();"
                  "o=subprocess.run([f,'-hide_banner','-filters'],capture_output=True,text=True).stdout+subprocess.run([f,'-hide_banner','-encoders'],capture_output=True,text=True).stdout;"
                  "assert all(k in o for k in ('zscale','tonemap','libx264')), 'ffmpeg lacks zscale/tonemap/libx264'\"")
    .add_local_dir(HERE / "assets", "/root/assets")
    .add_local_python_source("pf")
)

with edit_image.imports():
    import fastapi  # noqa: F401  (the endpoint's Request type)

whisper_image = (
    modal.Image.from_registry("nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04", add_python="3.12")
    .uv_pip_install("faster-whisper==1.2.1", "numpy==2.5.4")
    .env({"HF_HUB_CACHE": "/models"})
    .run_commands(f"python -c \"from faster_whisper.utils import download_model; download_model('{WHISPER_MODEL}')\"")
)


# ---------------------------------------------------------------- transcription (GPU)

# condition_on_previous_text=False: a window without punctuation (it happens on long clips) must not teach the
# next window to drop it too; the prompt shows the style and the product's own words.
WHISPER_OPTIONS = dict(language="en", word_timestamps=True, vad_filter=True, beam_size=5, condition_on_previous_text=False)


def prompt(hint: str) -> str:
    return (f"A product review of the {hint}. " if hint else "A product review. ") + "Hi guys! So, this is what I think of it: I love it."


@app.cls(image=whisper_image, gpu="T4", timeout=1200, scaledown_window=60)
class Transcriber:
    @modal.enter()
    def load(self):
        from faster_whisper import WhisperModel
        self.model = WhisperModel(WHISPER_MODEL, device="cuda", compute_type="float16")

    @modal.method()
    def transcribe(self, wavs: dict[str, bytes], hint: str = "") -> dict:
        import io
        import wave

        import numpy as np
        t0 = time.time()
        out = {}
        for cid, data in wavs.items():
            with wave.open(io.BytesIO(data)) as w:
                audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
            segs, _ = self.model.transcribe(audio, **WHISPER_OPTIONS, initial_prompt=prompt(hint), hotwords=hint or None)
            out[cid] = [{"w": w.word.strip(), "s": round(w.start, 2), "e": round(w.end, 2)} for s in segs for w in s.words]
        return {"words": out, "seconds": round(time.time() - t0, 1)}


# ---------------------------------------------------------------- talking to Supabase and Drive

class WorkerAPI:
    def __init__(self):
        import requests
        self.s = requests.Session()
        self.s.headers["Authorization"] = f"Bearer {os.environ['WORKER_SECRET']}"

    def call(self, action: str, **body):
        r = self.s.post(f"{SUPABASE_URL}/functions/v1/worker", json={"action": action, **body}, timeout=60)
        j = r.json() if r.headers.get("content-type", "").startswith("application/json") else {"error": r.text[:300]}
        if r.status_code >= 400:
            raise RuntimeError(j.get("error") or f"worker function answered {r.status_code}")
        return j


class ModalIO:
    """pf.pipeline's window on the world when running on Modal."""
    def __init__(self, api: WorkerAPI, ctx: dict, job_id: str):
        import requests
        self.api, self.ctx, self.job_id = api, ctx, job_id
        self.http = requests.Session()
        self.token = ctx["drive"]["access_token"]
        self.token_until = time.time() + ctx["drive"]["expires_in"] - 120
        self.pending: list[str] = []
        self.last_progress = 0.0
        self.gpu_seconds = 0.0

    def _auth(self) -> dict:
        if time.time() > self.token_until:
            t = self.api.call("token")
            self.token, self.token_until = t["access_token"], time.time() + t["expires_in"] - 120
        return {"Authorization": f"Bearer {self.token}"}

    def download(self, clip: dict, dest: Path) -> str:
        dest.mkdir(parents=True, exist_ok=True)
        out = dest / f"{clip['id']}_{clip['filename']}".replace("/", "-")
        url = f"https://www.googleapis.com/drive/v3/files/{clip['drive_file_id']}?alt=media&supportsAllDrives=true"
        for attempt in range(4):
            have = out.stat().st_size if out.exists() else 0
            headers = {**self._auth(), **({"Range": f"bytes={have}-"} if have else {})}
            try:
                with self.http.get(url, headers=headers, stream=True, timeout=(15, 120)) as r:
                    if r.status_code == 416:
                        return str(out)
                    r.raise_for_status()
                    with open(out, "ab" if r.status_code == 206 else "wb") as f:
                        for chunk in r.iter_content(8 << 20):
                            f.write(chunk)
                size = clip.get("size_bytes")
                if not size or out.stat().st_size >= int(size):
                    return str(out)
            except Exception as e:  # dropped connection: resume from what arrived
                self.log(f"Download of {clip['filename']} interrupted ({e}); resuming.")
        raise RuntimeError(f"Could not download {clip['filename']} from Drive.")

    def download_music(self, track: dict, dest: Path) -> str:
        return self.download({"id": "music", "filename": track["name"], "drive_file_id": track["id"], "size_bytes": track.get("size")}, dest)

    def transcribe(self, wavs: dict[str, bytes], hint: str = "") -> dict:
        # a GPU that can't be had right now, or a dropped connection to it, is retried rather than failing the edit
        for attempt in range(1, 4):
            try:
                r = Transcriber().transcribe.remote(wavs, hint)
                self.gpu_seconds += r["seconds"]
                return r["words"]
            except Exception as e:
                if attempt == 3:
                    raise RuntimeError(f"Transcription failed three times: {e}") from e
                self.log(f"Transcription attempt {attempt} failed ({e.__class__.__name__}: {e}); trying again.")
                self.progress("Transcribing what is said", 30, f"trying again ({attempt + 1} of 3)")
                time.sleep(10 * attempt)

    def claude(self):
        import anthropic
        a = self.ctx["anthropic"]
        headers = {"anthropic-workspace-id": a["workspace_id"]} if a.get("workspace_id") else None
        return anthropic.Anthropic(api_key=a["api_key"], default_headers=headers, timeout=900)

    def upload(self, path: str, name: str, mime: str) -> dict:
        size = os.path.getsize(path)
        meta = {"name": name, "parents": [self.ctx["drive"]["finished_folder_id"]]}
        r = self.http.post("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,size",
                           headers={**self._auth(), "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": mime,
                                    "X-Upload-Content-Length": str(size)}, data=json.dumps(meta), timeout=60)
        r.raise_for_status()
        session = r.headers["Location"]
        chunk, sent = 32 << 20, 0
        with open(path, "rb") as f:
            while sent < size:
                f.seek(sent)
                data = f.read(chunk)
                end = sent + len(data) - 1
                resp = self.http.put(session, data=data, headers={"Content-Range": f"bytes {sent}-{end}/{size}"}, timeout=300)
                if resp.status_code in (200, 201):
                    j = resp.json()
                    return {"drive_file_id": j["id"], "filename": j["name"], "size_bytes": int(j.get("size") or size)}
                if resp.status_code == 308:
                    rng = resp.headers.get("Range")
                    sent = int(rng.split("-")[1]) + 1 if rng else 0
                    continue
                raise RuntimeError(f"Drive upload of {name} failed: {resp.status_code} {resp.text[:200]}")
        raise RuntimeError(f"Drive upload of {name} did not finish.")

    def progress(self, step: str, pct: int, note: str = "") -> None:
        try:
            self.api.call("progress", job_id=self.job_id, step=step, pct=pct, note=note, log=self.pending + [f"{step} {note}".strip()])
            self.pending = []
        except Exception as e:  # progress is nice to have; never fail the edit over it
            print("progress failed:", e)

    def log(self, line: str) -> None:
        print(line)
        self.pending.append(line)


# ---------------------------------------------------------------- the job (CPU)

@app.function(image=edit_image, secrets=[secret], cpu=EDIT_CPU, memory=EDIT_MEMORY_GB * 1024, timeout=3600, retries=0)
def edit_job(job_id: str) -> dict:
    from pf import pipeline

    t0 = time.time()
    api = WorkerAPI()
    ctx = api.call("claim", job_id=job_id)
    if ctx.get("skip"):
        print("skip:", ctx["skip"])
        return {"skipped": ctx["skip"]}
    io = ModalIO(api, ctx, job_id)
    try:
        result = pipeline.run(ctx, io, Path("/tmp/edit"))
        wall = round(time.time() - t0, 1)
        # Modal list prices (Oct 2026): CPU $0.0000131/core/s, memory $0.00000222/GiB/s, T4 $0.000164/s
        cpu_usd = wall * (EDIT_CPU * 0.0000131 + EDIT_MEMORY_GB * 0.00000222)
        gpu_usd = io.gpu_seconds * 0.000164
        result["cost"] = {
            "cpu_seconds": wall, "cpu_cores": EDIT_CPU, "gpu_seconds": io.gpu_seconds,
            "modal_usd": round(cpu_usd + gpu_usd, 4), "claude_usd": result["claude"]["usd"],
            "total_usd": round(cpu_usd + gpu_usd + result["claude"]["usd"], 4),
            "note": "GPU seconds count transcription only; the T4 also bills its start-up and 60 s idle before it shuts down.",
        }
        api.call("finish", job_id=job_id, result=result, log=io.pending + [f"Done in {wall:.0f} s, about ${result['cost']['total_usd']:.2f}."])
        return {"ok": True, "cost": result["cost"]}
    except Exception as e:
        tb = traceback.format_exc()
        print(tb)
        api.call("fail", job_id=job_id, error=str(e) or e.__class__.__name__, log=io.pending + [tb[-1500:]])
        return {"ok": False, "error": str(e)}


# ---------------------------------------------------------------- the trigger

@app.function(image=edit_image, secrets=[secret], timeout=60)
@modal.fastapi_endpoint(method="POST", label="product-flow-edit")
def start(body: dict, request: "fastapi.Request"):  # noqa: F821
    import hmac

    from fastapi import HTTPException
    auth = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    if not hmac.compare_digest(auth.encode(), os.environ["WORKER_SECRET"].encode()):
        raise HTTPException(status_code=401, detail="Not allowed.")
    job_id = str(body.get("job_id") or "")
    if not job_id:
        raise HTTPException(status_code=400, detail="job_id is missing.")
    call = edit_job.spawn(job_id)
    return {"ok": True, "call_id": call.object_id}
