"""Account-owned raw Tox identity endpoints. Never accept plaintext exports without auth."""
from __future__ import annotations
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from . import store
from .tox_identity import MAX_SAVEDATA, ToxCore, ToxIdentityError
from .session_manager import manager
from .tox_runtime import ToxActionError

router = APIRouter()

def owner(request: Request):
    uid = store.session_user(request.cookies.get("wtox_session"))
    if not uid:
        raise HTTPException(401, "请先登录个人账号")
    return uid

def core():
    try:
        return ToxCore()
    except (OSError, AttributeError) as exc:
        raise HTTPException(503, "服务器缺少兼容的原生 Toxcore 库") from exc

def require_same_origin(request: Request):
    # Defend cookie-authenticated POST endpoints against cross-origin submission.
    origin = request.headers.get("origin")
    if origin and origin != str(request.base_url).rstrip("/"):
        raise HTTPException(403, "不允许跨站请求")

def save_new_profile(uid: str, identity):
    try:
        store.claim_profile(uid, identity.savedata, identity.address)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    try:
        manager.get(uid)
        started = True
    except (ValueError, RuntimeError, OSError, AttributeError, ToxActionError) as exc:
        print("New Tox identity saved but session not started:", type(exc).__name__, flush=True)
        started = False
    return {"has_profile": True, "tox_id": identity.address, "session_started": started}

@router.get("/api/profile/status")
def status(uid: str = Depends(owner)):
    try:
        core()
        native_available = True
    except HTTPException:
        native_available = False
    return {"has_profile": store.has_profile(uid),
            "tox_id": store.profile_address(uid),
            "native_tox_available": native_available}

@router.post("/api/profile/create")
def create_profile(request: Request, uid: str = Depends(owner)):
    require_same_origin(request)
    if store.has_profile(uid):
        raise HTTPException(409, "已有身份，请不要重复创建")
    info = store.user_info(uid)
    identity = core().identity(nickname=info["username"])
    return save_new_profile(uid, identity)

@router.post("/api/profile/import")
async def import_profile(request: Request, uid: str = Depends(owner)):
    require_same_origin(request)
    if store.has_profile(uid):
        raise HTTPException(409, "已有身份，不能直接覆盖")
    length = request.headers.get("content-length")
    if length:
        try:
            if int(length) > MAX_SAVEDATA: raise HTTPException(413, "配置文件超过 8 MiB")
        except ValueError:
            raise HTTPException(400, "Content-Length 无效")
    parts = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_SAVEDATA:
            raise HTTPException(413, "配置文件超过 8 MiB")
        parts.append(chunk)
    raw = b"".join(parts)
    try:
        identity = core().identity(raw)
    except ToxIdentityError as exc:
        raise HTTPException(400, str(exc)) from exc
    return save_new_profile(uid, identity)

@router.get("/api/profile/export")
def export_profile(uid: str = Depends(owner)):
    saved = store.read_profile(uid)
    if saved is None:
        raise HTTPException(404, "尚未创建或导入 Tox 身份")
    return Response(saved, media_type="application/octet-stream",
                    headers={"Content-Disposition":'attachment; filename="wtox-profile.tox"',
                             "Cache-Control":"no-store",
                             "X-Content-Type-Options":"nosniff"})
