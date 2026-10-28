"""Plays finished videos (and shows thumbnails) from Drive on the phone, served by Modal instead of Supabase.

  GET/HEAD <media endpoint>?f=<drive file id>&e=<expiry>&m=<mime>&s=<signature>

The links are the ones Supabase signs in _shared/worker.ts signedMediaUrl (HMAC-SHA256 with "media:" + WORKER_SECRET
over "<f>.<e>.<m>"), so the phone never holds a Drive token. Range requests pass through to Drive so Safari can stream
and seek, and the Save video download fetches 8 MiB pieces. Video bytes used to flow through the Supabase `media`
function, which counted against the Free plan's 5 GB egress; Modal's Starter plan includes 1 TiB of egress.
"""
import base64
import hashlib
import hmac
import os
import time
from urllib.parse import quote
from typing import Awaitable, Callable

DRIVE = "https://www.googleapis.com/drive/v3"
PASS = ("content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified")
CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "range",
    "Access-Control-Expose-Headers": "content-length, content-range, accept-ranges",
}


def signature(secret: str, f: str, e: str, m: str) -> str:
    key = ("media:" + secret).encode()
    mac = hmac.new(key, f"{f}.{e}.{m}".encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(mac).decode().rstrip("=")


def signed_ok(secret: str, f: str, e: str, m: str, s: str) -> bool:
    if not (secret and f and e and s) or not e.isdigit() or int(e) < time.time():
        return False
    return hmac.compare_digest(signature(secret, f, e, m), s)


def make_app(secret: str, drive_token: Callable[[], Awaitable[str]], drive_url: str = DRIVE):
    """The FastAPI app; drive_token() returns a Drive access token (cached by the caller)."""
    import httpx
    from fastapi import FastAPI, Request
    from fastapi.responses import Response, StreamingResponse
    from starlette.background import BackgroundTask

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=120.0), follow_redirects=True)

    @app.options("/")
    async def preflight():
        return Response("ok", headers=CORS)

    @app.api_route("/", methods=["GET", "HEAD"])
    async def media(request: Request):
        q = request.query_params
        f, e, m, s = q.get("f", ""), q.get("e", ""), q.get("m", ""), q.get("s", "")
        if not signed_ok(secret, f, e, m, s):
            return Response("This link has expired. Go back and open the review again.", status_code=403, headers=CORS)
        headers = {"Authorization": f"Bearer {await drive_token()}"}
        if request.headers.get("range"):
            headers["Range"] = request.headers["range"]
        url = f"{drive_url}/files/{quote(f, safe='')}?alt=media&supportsAllDrives=true"
        try:
            upstream = await client.send(client.build_request(request.method, url, headers=headers), stream=True)
        except httpx.HTTPError as err:
            return Response(f"Drive did not answer ({err}).", status_code=502, headers=CORS)
        if upstream.status_code not in (200, 206):
            await upstream.aclose()
            return Response(f"Drive answered {upstream.status_code}.", status_code=404 if upstream.status_code == 404 else 502, headers=CORS)
        out = {**CORS, "Cache-Control": "private, max-age=3600", "Accept-Ranges": "bytes"}
        for h in PASS:
            if h in upstream.headers:
                out[h] = upstream.headers[h]
        if m:
            out["content-type"] = m
        if request.method == "HEAD":
            await upstream.aclose()
            return Response(status_code=upstream.status_code, headers=out)
        return StreamingResponse(upstream.aiter_raw(), status_code=upstream.status_code, headers=out, background=BackgroundTask(upstream.aclose))

    return app


def worker_token_source(supabase_url: str) -> Callable[[], Awaitable[str]]:
    """Drive access tokens from the Supabase `worker` function (action 'token'), reused until 5 minutes before expiry."""
    import httpx
    cached = {"token": "", "until": 0.0}

    async def token() -> str:
        if cached["token"] and cached["until"] - time.time() > 300:
            return cached["token"]
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.post(f"{supabase_url}/functions/v1/worker", json={"action": "token"},
                             headers={"Authorization": f"Bearer {os.environ['WORKER_SECRET']}"})
            r.raise_for_status()
            j = r.json()
        cached["token"], cached["until"] = j["access_token"], time.time() + float(j.get("expires_in") or 3600)
        return cached["token"]

    return token
