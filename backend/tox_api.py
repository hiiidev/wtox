"""Authenticated friend, message and websocket APIs for native Tox sessions."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from . import access, store
from .session_manager import manager
from .tox_runtime import ToxActionError

router = APIRouter()

def require_user(request: Request) -> str:
    uid = store.session_user(request.cookies.get("wtox_session"))
    if not uid:
        raise HTTPException(401, "请先登录个人账号")
    return uid

def check_origin(request: Request):
    origin = request.headers.get("origin")
    if origin and origin.rstrip("/") != str(request.base_url).rstrip("/"):
        raise HTTPException(403, "跨站请求被拒绝")

def session(uid: str):
    try:
        return manager.get(uid)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    except (ToxActionError, OSError, RuntimeError) as exc:
        raise HTTPException(503, "Tox 会话不可用，请查看服务器日志") from exc

class FriendAdd(BaseModel):
    address: str = Field(min_length=76, max_length=76)
    message: str = Field(default="你好，我想添加你为 Tox 好友", min_length=1, max_length=256)

class FriendAccept(BaseModel):
    public_key: str = Field(min_length=64, max_length=64)

class SendMessage(BaseModel):
    public_key: str = Field(min_length=64, max_length=64)
    text: str = Field(min_length=1, max_length=1000)

class Acknowledge(BaseModel):
    ids: list[str] = Field(max_length=100)

@router.get("/api/network")
def network(uid: str = Depends(require_user)):
    s = session(uid)
    return {"status": s.last_connection}  # 0 offline, 1 TCP, 2 UDP

@router.get("/api/friends")
def friends(uid: str = Depends(require_user)):
    try:
        return {"friends": session(uid).friends()}
    except (ValueError, ToxActionError) as exc:
        raise HTTPException(409, str(exc)) from exc

@router.post("/api/friends")
def add_friend(body: FriendAdd, request: Request, uid: str = Depends(require_user)):
    check_origin(request)
    try:
        key = session(uid).add_friend(body.address, body.message)
        return {"public_key": key, "ok": True}
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except ToxActionError as exc:
        raise HTTPException(409, str(exc)) from exc

@router.delete("/api/friends/{public_key}")
def delete_friend(public_key: str, request: Request, uid: str = Depends(require_user)):
    check_origin(request)
    try:
        session(uid).delete_friend(public_key)
        return {"ok": True}
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except ToxActionError as exc:
        raise HTTPException(409, str(exc)) from exc

@router.post("/api/friends/accept")
def accept_friend(body: FriendAccept, request: Request, uid: str = Depends(require_user)):
    check_origin(request)
    try:
        key = session(uid).accept_friend(body.public_key)
        return {"public_key": key, "ok": True}
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except ToxActionError as exc:
        raise HTTPException(409, str(exc)) from exc

@router.post("/api/messages")
def send_message(body: SendMessage, request: Request, uid: str = Depends(require_user)):
    check_origin(request)
    try:
        message_id = session(uid).send_message(body.public_key, body.text)
        return {"ok": True, "message_id": message_id, "public_key": body.public_key.upper()}
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except ToxActionError as exc:
        raise HTTPException(409, str(exc)) from exc

@router.get("/api/pending")
def pending(uid: str = Depends(require_user)):
    return {"pending": store.get_pending(uid)}

@router.post("/api/ack")
def acknowledge(body: Acknowledge, request: Request, uid: str = Depends(require_user)):
    check_origin(request)
    if any(len(item) != 32 or any(c not in "0123456789abcdef" for c in item) for item in body.ids):
        raise HTTPException(400, "invalid event id")
    store.ack_pending(uid, body.ids)
    return {"ok": True}

@router.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    # HTTP access middleware doesn't guard WebSocket upgrades, so check both
    # entrance gate and personal session cookies independently.
    if not access.gate_valid(ws.cookies.get(access.COOKIE_NAME)):
        await ws.close(code=1008)
        return
    uid = store.session_user(ws.cookies.get("wtox_session"))
    if not uid:
        await ws.close(code=1008)
        return
    origin = ws.headers.get("origin")
    scheme = "http" if not access.secure_cookies() else "https"
    expected = f"{scheme}://{ws.headers.get('host', '')}"
    if not origin or origin.rstrip("/") != expected:
        await ws.close(code=1008)
        return
    await ws.accept()
    manager.attach(uid, ws)
    try:
        for record in store.get_pending(uid):
            await ws.send_json({**record["event"], "id": record["id"],
                                "created": record["created"]})
        while True:
            payload = await ws.receive_json()
            if not isinstance(payload, dict):
                await ws.close(code=1003)
                return
            if payload.get("type") == "ping":
                await ws.send_json({"type":"pong"})
            elif payload.get("type") == "ack":
                ids = payload.get("ids")
                if (not isinstance(ids,list) or len(ids)>100 or
                    any(not isinstance(i,str) or len(i)!=32 or
                        any(ch not in "0123456789abcdef" for ch in i) for i in ids)):
                    await ws.close(code=1008)
                    return
                store.ack_pending(uid, ids)
            else:
                await ws.close(code=1008)
                return
    except (WebSocketDisconnect, RuntimeError, ValueError):
        pass
    finally:
        manager.detach(uid, ws)
