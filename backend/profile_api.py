"""Raw native Tox savedata is the login credential; no web username/password."""
from __future__ import annotations

from collections import defaultdict, deque
import time
from threading import Lock

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from . import access, store
from .tox_identity import MAX_SAVEDATA, ToxCore, ToxIdentityError
from .session_manager import manager

router = APIRouter()
COOKIE_NAME = "wtox_tox_session"
_LOCK = Lock()
_ATTEMPTS = defaultdict(deque)


def rate_check(request: Request):
    # Authentication involves native savedata parsing; limit per-IP abuse.
    ip = request.client.host if request.client else "unknown"
    now = time.monotonic()
    with _LOCK:
        q = _ATTEMPTS[ip]
        while q and now - q[0] > 900:
            q.popleft()
        if len(q) >= 12:
            raise HTTPException(429, "尝试过于频繁，请稍后再试")
        q.append(now)


def owner(request: Request):
    uid = store.tox_session_user(request.cookies.get(COOKIE_NAME))
    if not uid:
        raise HTTPException(401, "请使用 Tox 配置文件登录")
    return uid


def core():
    try:
        return ToxCore()
    except (OSError, AttributeError) as exc:
        raise HTTPException(503, "服务器缺少兼容的原生 Toxcore 库") from exc


def require_same_origin(request: Request):
    origin = request.headers.get("origin")
    if origin and origin.rstrip("/") != str(request.base_url).rstrip("/"):
        raise HTTPException(403, "不允许跨站请求")


def issue_session(response: Response, uid: str):
    response.set_cookie(
        COOKIE_NAME, store.create_tox_session(uid),
        httponly=True, secure=access.secure_cookies(),
        samesite="strict", max_age=7*86400, path="/"
    )


def activate(uid: str) -> bool:
    try:
        manager.get(uid)
        return True
    except Exception as exc:
        # Identity and its private key have already been safely persisted.
        print("Tox session start failed:", type(exc).__name__, flush=True)
        return False


@router.get("/api/profile/status")
def status(uid: str = Depends(owner)):
    info = store.tox_identity_info(uid)
    return {"has_profile": True, **info}


@router.post("/api/tox/create")
def create_identity(request: Request):
    """Generate and IMMEDIATELY download a raw .tox backup, while signing in."""
    require_same_origin(request)
    rate_check(request)
    identity = core().identity()
    try:
        uid = store.create_tox_identity(identity)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    started = activate(uid)
    response = Response(identity.savedata, media_type="application/octet-stream",
                        headers={
                            "Content-Disposition": 'attachment; filename="wtox-new-identity.tox"',
                            "Cache-Control": "no-store",
                            "X-Content-Type-Options": "nosniff",
                            "X-Tox-ID": identity.address,
                            "X-Tox-Session-Started": str(started).lower()
                        })
    issue_session(response, uid)
    return response


@router.post("/api/tox/login")
async def login_with_savedata(request: Request, response: Response):
    """Login with raw .tox; on first encounter import it as a new Tox identity."""
    require_same_origin(request)
    rate_check(request)
    length = request.headers.get("content-length")
    if length:
        try:
            if int(length) > MAX_SAVEDATA:
                raise HTTPException(413, "配置文件超过 8 MiB")
        except ValueError as exc:
            raise HTTPException(400, "Content-Length 无效") from exc
    parts = []
    size = 0
    async for part in request.stream():
        size += len(part)
        if size > MAX_SAVEDATA:
            raise HTTPException(413, "配置文件超过 8 MiB")
        parts.append(part)
    try:
        native = core()
        identity = native.identity(b"".join(parts))
        uid, is_new = store.login_or_import_tox(identity, native)
    except ToxIdentityError as exc:
        raise HTTPException(400, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(403, str(exc)) from exc
    issue_session(response, uid)
    started = activate(uid)
    info = store.tox_identity_info(uid)
    return {"ok": True, "imported": is_new, "tox_id": info["tox_id"],
            "session_started": started}


@router.get("/api/profile/export")
def export_profile(uid: str = Depends(owner)):
    saved = store.read_profile(uid)
    if saved is None:
        raise HTTPException(404, "没有此 Tox 身份")
    return Response(
        saved, media_type="application/octet-stream",
        headers={"Content-Disposition":'attachment; filename="wtox-profile.tox"',
                 "Cache-Control": "no-store",
                 "X-Content-Type-Options": "nosniff"}
    )
