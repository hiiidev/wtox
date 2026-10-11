"""Authenticated friend, message and websocket APIs for native Tox sessions."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import access, store
from .profile_api import COOKIE_NAME as TOX_SESSION_COOKIE
from .session_manager import manager
from .tox_runtime import ToxActionError, FriendOfflineError
from .file_transfer import MAX_FILE, safe_filename

router = APIRouter()

def require_user(request: Request) -> str:
    uid = store.tox_session_user(request.cookies.get(TOX_SESSION_COOKIE))
    if not uid:
        raise HTTPException(401, "请上传 .tox 身份文件登录")
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
    client_id: str | None = Field(default=None, min_length=32, max_length=32)

class OwnProfile(BaseModel):
    name: str = Field(max_length=128)
    status_message: str = Field(max_length=1007)
    user_status: int = Field(ge=0,le=2)

class Acknowledge(BaseModel):
    ids: list[str] = Field(max_length=100)

@router.get("/api/network")
def network(uid: str = Depends(require_user)):
    """VPS Tox connectivity, independent from the browser WebSocket.

    Connection 0 means the VPS Tox network is offline; even if the HTML page
    loads, native Tox peers cannot deliver their messages to this identity.
    """
    s = session(uid)
    friends = s.friends()
    counts = store.outbox_counts(uid)
    thread = getattr(s,"thread",None)
    return {
        "status":s.last_connection,  # 0 offline, 1 TCP, 2 UDP
        "tox_running": bool(thread and thread.is_alive()),
        "online_friends":sum(friend.get("status") in (1,2) for friend in friends),
        "total_friends":len(friends),
        **counts
    }

@router.get("/api/friends")
def friends(uid: str = Depends(require_user)):
    try:
        addresses = store.friend_tox_ids(uid)
        result = session(uid).friends()
        # Only the original complete 76-hex Tox ID may be displayed as a
        # Tox ID. Native toxcore can supply the 64-hex public key only.
        for friend in result:
            friend["tox_id"] = addresses.get(friend["public_key"])
        return {"friends": result}
    except (ValueError, ToxActionError) as exc:
        raise HTTPException(409, str(exc)) from exc

@router.post("/api/friends")
def add_friend(body: FriendAdd, request: Request, uid: str = Depends(require_user)):
    check_origin(request)
    try:
        key = session(uid).add_friend(body.address, body.message)
        store.remember_friend_tox_id(uid, key, body.address)
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
        store.forget_friend_tox_id(uid,public_key)
        return {"ok": True}
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except ToxActionError as exc:
        raise HTTPException(409, str(exc)) from exc

@router.get("/api/friend-requests")
def friend_requests(uid: str = Depends(require_user)):
    """Multiple independent native Tox requests retained for seven days."""
    return {"requests": [
        {"id":row["id"],"public_key":row["event"]["public_key"],
         "text":row["event"].get("text",""),"created":row["created"]}
        for row in store.get_pending(uid)
        if row["event"].get("type") == "friend_request"
        and isinstance(row["event"].get("public_key"),str)
    ]}


@router.post("/api/friend-requests/{request_id}/accept")
def accept_pending_request(request_id: str, request: Request,
                           uid: str = Depends(require_user)):
    check_origin(request)
    row = next((item for item in store.get_pending(uid)
                if item["id"] == request_id and
                item["event"].get("type") == "friend_request"), None)
    if row is None:
        raise HTTPException(404,"好友请求不存在或已过期")
    try:
        key = session(uid).accept_friend(row["event"]["public_key"])
    except ValueError as exc:
        raise HTTPException(400,str(exc)) from exc
    except ToxActionError as exc:
        raise HTTPException(409,str(exc)) from exc
    store.ack_pending(uid,[request_id])
    return {"ok": True, "public_key":key}


@router.delete("/api/friend-requests/{request_id}")
def reject_pending_request(request_id: str, request: Request,
                           uid: str = Depends(require_user)):
    check_origin(request)
    if not any(item["id"]==request_id and
               item["event"].get("type")=="friend_request"
               for item in store.get_pending(uid)):
        raise HTTPException(404,"好友请求不存在或已过期")
    store.ack_pending(uid,[request_id])
    return {"ok": True}


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
        tox_session = session(uid)
        public_key = body.public_key.upper()
        import uuid
        # Every message enters the same durable encrypted VPS queue. This
        # works whether the recipient is online or not and survives browser
        # suspension. Never send directly from this endpoint.
        if not any(f["public_key"]==public_key for f in tox_session.friends()):
            raise ValueError("好友不在列表中")
        client_id=body.client_id or uuid.uuid4().hex
        entry=store.enqueue_outbox(uid,public_key,body.text,client_id)
        return {"ok":True,**entry}
    except ValueError as exc:
        raise HTTPException(400,str(exc)) from exc
    except ToxActionError as exc:
        raise HTTPException(409,str(exc)) from exc

@router.get("/api/settings")
def message_settings(uid: str = Depends(require_user)):
    return {"offline_queue":True,"friend_refresh_seconds":12,"pending_poll_seconds":8}

@router.get("/api/profile/self")
def self_profile(uid: str = Depends(require_user)):
    return session(uid).self_profile()

@router.put("/api/profile/self")
def update_self_profile(body: OwnProfile, request: Request,
                        uid: str = Depends(require_user)):
    check_origin(request)
    try:
        return session(uid).update_self_profile(
            body.name,body.status_message,body.user_status)
    except ValueError as exc:
        raise HTTPException(400,str(exc)) from exc
    except ToxActionError as exc:
        raise HTTPException(409,str(exc)) from exc

@router.get("/api/outbox")
def outbox(uid: str = Depends(require_user)):
    return {"messages":store.outbox_status(uid)}

@router.get("/api/files")
def list_files(uid: str = Depends(require_user)):
    return {"files": session(uid).files.list()}

@router.post("/api/files/send")
async def send_file(request: Request, peer: str, name: str, uid: str = Depends(require_user)):
    """Spool HTTPS uploads as encrypted blocks; Tox reads blocks on demand."""
    check_origin(request)
    length = request.headers.get("content-length")
    if length:
        try:
            declared = int(length)
        except ValueError as exc:
            raise HTTPException(400, "Content-Length 错误") from exc
        if declared > MAX_FILE:
            raise HTTPException(413, "附件不能超过 5 MiB")
    if manager.disk is None:
        raise HTTPException(503, "附件磁盘存储未就绪")
    try:
        filename = safe_filename(name)
        document = manager.disk.begin(uid, filename, direction="outgoing")
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except OSError as exc:
        raise HTTPException(503, "附件磁盘不可写") from exc
    try:
        async for chunk in request.stream():
            document.write(chunk)
        document.finish()
    except (ValueError, OSError) as exc:
        document.abort()
        raise HTTPException(413 if "超过" in str(exc) else
                            503 if isinstance(exc,OSError) else 400, str(exc)) from exc
    except BaseException:
        # ClientDisconnect / task cancellation must not leave a partial spool.
        document.abort()
        raise
    try:
        return session(uid).files.send(peer.strip().upper(), filename, document)
    except (ValueError, OSError) as exc:
        document.abort()
        raise HTTPException(409, str(exc)) from exc


@router.post("/api/files/{transfer_id}/accept")
def accept_file(transfer_id: str, request: Request, uid: str = Depends(require_user)):
    check_origin(request)
    try:
        return session(uid).files.control(transfer_id,True)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc

@router.post("/api/files/{transfer_id}/reject")
def reject_file(transfer_id: str, request: Request, uid: str = Depends(require_user)):
    check_origin(request)
    try:
        return session(uid).files.control(transfer_id,False)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc

@router.get("/api/files/{transfer_id}/download")
def download_file(transfer_id: str, uid: str = Depends(require_user)):
    """Serve only the authenticated user's completed, unexpired disk blocks."""
    from urllib.parse import quote
    if manager.disk is None:
        raise HTTPException(503, "附件磁盘存储未就绪")
    try:
        name, size, chunks = manager.disk.download(uid, transfer_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    safe = quote(name, safe="")
    return StreamingResponse(chunks, media_type="application/octet-stream", headers={
        "Content-Disposition": "attachment; filename=\"attachment.bin\"; filename*=UTF-8''"+safe,
        "Content-Length": str(size),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
    })


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
    # WebSocket must validate the personal Tox session explicitly.
    uid = store.tox_session_user(ws.cookies.get(TOX_SESSION_COOKIE))
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
