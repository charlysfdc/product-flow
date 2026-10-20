"""Development only: run the edit on the Mac against a product folder in the Google Drive for desktop mount.

  worker/.venv/bin/python worker/local_run.py "Castor Oil" [--out DIR] [--plan plan.json] [--note "..."]

Clips are read from <Products>/<name>/raw, Whisper runs on the CPU (model "small"), Claude needs
ANTHROPIC_API_KEY (or --plan with a saved plan.json to skip Claude), and the results stay in --out;
nothing is uploaded and no job is touched. The cloud run (app.py) uses the same pf.pipeline.
"""
import argparse
import json
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pf import pipeline, plan as planner  # noqa: E402

PRODUCTS = Path.home() / "Library/CloudStorage/GoogleDrive-afrikanerinamerika@gmail.com/My Drive/Content Library/Products"
VIDEO = {".mov", ".mp4", ".m4v"}


class LocalIO:
    def __init__(self, out: Path, saved_plan: Path | None):
        self.out, self.saved_plan = out, saved_plan
        self._whisper = None

    def download(self, clip, dest):
        return clip["local_path"]   # read in place from the Drive mount

    def download_music(self, track, dest):
        return str(Path.home() / "meta-api/music" / track["name"])

    def transcribe(self, wavs, hint=""):
        cache = self.out / "_words.json"
        if cache.exists():
            return json.loads(cache.read_text())
        from faster_whisper import WhisperModel
        from pf.ffx import wav_array
        if self._whisper is None:
            self._whisper = WhisperModel("small", device="cpu", compute_type="int8")
        out = {}
        for cid, data in wavs.items():
            segs, _ = self._whisper.transcribe(wav_array(data), language="en", word_timestamps=True, vad_filter=True, condition_on_previous_text=False,
                                               initial_prompt=f"A product review of the {hint}. Hi guys! So, this is what I think of it: I love it.")
            out[cid] = [{"w": w.word.strip(), "s": round(w.start, 2), "e": round(w.end, 2)} for s in segs for w in s.words]
            print(cid, len(out[cid]), "words", flush=True)
        cache.write_text(json.dumps(out))
        return out

    def claude(self):
        if self.saved_plan:
            return _SavedPlan(json.loads(self.saved_plan.read_text()))
        import anthropic
        return anthropic.Anthropic()

    def upload(self, path, name, mime):
        dest = self.out / name
        if Path(path).resolve() != dest.resolve():
            shutil.copy(path, dest)
        return {"drive_file_id": None, "filename": name, "size_bytes": dest.stat().st_size}

    def progress(self, step, pct, note=""):
        print(f"[{pct:3d}%] {step} {note}", flush=True)

    def log(self, line):
        print("   ", line, flush=True)


class _SavedPlan:
    """Stands in for the Anthropic client: answers every planning call with a saved plan."""
    def __init__(self, plan):
        self.plan = plan

    @property
    def beta(self):
        return self

    @property
    def messages(self):
        return self

    def stream(self, **kw):
        plan = self.plan

        class _S:
            def __enter__(s):
                return s

            def __exit__(s, *a):
                return False

            def get_final_message(s):
                class U: input_tokens = output_tokens = cache_read_input_tokens = cache_creation_input_tokens = 0
                class B: type = "text"; text = json.dumps(plan)
                class M: stop_reason = "end_turn"; stop_details = None; usage = U(); content = [B()]
                return M()
        return _S()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("product")
    ap.add_argument("--out", type=Path)
    ap.add_argument("--plan", type=Path, help="a plan.json from an earlier run (skips Claude)")
    ap.add_argument("--note")
    ap.add_argument("--only", nargs="*", help="raw file names to use")
    a = ap.parse_args()
    folder = PRODUCTS / a.product / "raw"
    files = sorted(p for p in folder.iterdir() if p.suffix.lower() in VIDEO and (not a.only or p.name in a.only))
    out = a.out or Path(tempfile.mkdtemp(prefix="pf-edit-"))
    out.mkdir(parents=True, exist_ok=True)
    saved = None
    if a.plan:
        saved = out / "_saved_plan.json"
        d = json.loads(a.plan.read_text())
        saved.write_text(json.dumps(d.get("plan", d)))
    ctx = {
        "job": {"id": "local"},
        "product": {"name": a.product, "platforms": ["Amazon US", "TikTok Shop"]},
        "clips": [{"filename": p.name, "local_path": str(p)} for p in files],
        "note": a.note, "previous_plan": None, "version": 1,
    }
    result = pipeline.run(ctx, LocalIO(out, saved), out / "work")
    (out / "result.json").write_text(json.dumps(result, indent=1))
    print("done:", out)
    print(json.dumps({k: result[k] for k in ("lengths", "timings", "claude", "problems", "skipped")}, indent=1))


if __name__ == "__main__":
    main()
