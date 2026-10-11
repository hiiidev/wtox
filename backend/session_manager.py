"""Own exactly one live toxcore instance per saved profile in this process.

No cross-process coordination is provided: uvicorn MUST run one worker.
"""
from __future__ import annotations

import asyncio
import threading
from .tox_runtime import FriendOfflineError

from . import store
from .tox_runtime import ToxSession, ToxActionError
from .webdav_archive import WebDavArchive


class SessionManager:
    def __init__(self):
        self.sessions: dict[str, ToxSession] = {}
        self.sockets: dict[str, set] = {}
        self.lock = threading.RLock()
        self.loop: asyncio.AbstractEventLoop | None = None
        self.outbox_task: asyncio.Task | None = None
        self.archive_task: asyncio.Task | None = None
        self.archive = None

    def start(self, loop: asyncio.AbstractEventLoop):
        self.loop = loop
        self.archive = WebDavArchive()
        self.outbox_task = loop.create_task(self._outbox_loop())
        if self.archive.enabled:
            self.archive_task=loop.create_task(self._archive_expiry_loop())
        # Restore identities from encrypted savedata. Do not generate fresh IDs.
        for uid in store.active_profiles():
            try:
                self.get(uid)
            except Exception as exc:
                print(f"Tox session restore failed for account {uid[:8]}: {type(exc).__name__}", flush=True)

    def get(self, uid: str) -> ToxSession:
        with self.lock:
            session = self.sessions.get(uid)
            if session is not None:
                if session.thread is not None and not session.thread.is_alive():
                    raise ToxActionError("该用户 Tox 会话已停止，请检查服务器日志")
                return session
            savedata = store.read_profile(uid)
            if savedata is None:
                raise ValueError("请先创建或导入 Tox 身份")
            session = ToxSession(
                savedata=savedata,
                on_event=lambda event: self.on_event(uid, event),
                on_save=lambda data: store.write_profile(uid, data),
            )
            self.sessions[uid] = session
            session.start()
            return session

    def dispatch_outbox(self, uid: str):
        """One round of encrypted offline queue draining on a worker thread.

        The DB claim is durable BEFORE any native send. A crash after claim
        leaves 'uncertain' (never an automatic duplicate on restart).
        """
        s=self.get(uid)
        for eid,peer,text in store.outbox_queued(uid):
            try:
                # Avoid consuming a job while the friend is offline. A race
                # immediately after this check re-queues on FriendOfflineError.
                current=next((x for x in s.friends() if x["public_key"]==peer),None)
                if not current or current["status"]==0:continue
                if not store.outbox_claim(uid,eid):continue
                try:
                    message_id=s.send_message(peer,text)
                except FriendOfflineError:
                    store.outbox_finish(uid,eid,"queued")
                    continue
                except (ValueError,ToxActionError) as exc:
                    store.outbox_finish(uid,eid,"failed",error=str(exc)[:160])
                else:
                    store.outbox_finish(uid,eid,"sent",session_id=s.session_id,
                                        message_id=message_id)
            except Exception as exc:
                print("Offline outbox dispatch error:",uid[:8],type(exc).__name__,flush=True)

    async def _outbox_loop(self):
        while True:
            try:
                # Outbox checks are independent from the browser and survive
                # browser disconnection. Native Tox sessions continue online.
                uids=await asyncio.to_thread(store.active_profiles)
                for uid in uids:
                    await asyncio.to_thread(self.dispatch_outbox,uid)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                print("Outbox worker failed:",type(exc).__name__,flush=True)
            await asyncio.sleep(3)

    async def _archive_one(self, uid: str, event: dict):
        """Transfer bytes after native receipt, off the Tox callback thread."""
        if not self.archive or not self.archive.enabled:
            return
        try:
            name,data=await asyncio.to_thread(self.get(uid).files.download,event["id"])
            await asyncio.to_thread(self.archive.put,uid,event["id"],name,data)
        except Exception as exc:
            print("WebDAV encrypted archive failed:",uid[:8],type(exc).__name__,flush=True)

    async def _archive_expiry_loop(self):
        while True:
            try:
                await asyncio.to_thread(self.archive.expire)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                print("WebDAV seven-day cleanup failed:",type(exc).__name__,flush=True)
            await asyncio.sleep(60*60)

    def on_event(self, uid: str, event: dict):
        payload = event.copy()
        if event.get("type") in ("message", "friend_request", "message_receipt"):
            try:
                payload["id"] = store.append_pending(uid, event)
            except Exception as exc:
                print("Tox pending event not stored:", type(exc).__name__, flush=True)
                payload["id"] = None
        loop = self.loop
        if loop and loop.is_running():
            loop.call_soon_threadsafe(lambda: asyncio.create_task(self.broadcast(uid, payload)))
            if (payload.get("type")=="file" and
                    payload.get("direction")=="incoming" and
                    payload.get("state")=="completed" and
                    self.archive and self.archive.enabled):
                loop.call_soon_threadsafe(
                    lambda: asyncio.create_task(self._archive_one(uid, payload)))

    async def broadcast(self, uid: str, event: dict):
        for ws in list(self.sockets.get(uid, ())):
            try:
                await ws.send_json(event)
            except Exception:
                self.sockets.get(uid, set()).discard(ws)

    def attach(self, uid, ws):
        self.sockets.setdefault(uid, set()).add(ws)

    def detach(self, uid, ws):
        self.sockets.get(uid, set()).discard(ws)

    async def shutdown(self):
        if self.archive_task:
            self.archive_task.cancel()
            await asyncio.gather(self.archive_task,return_exceptions=True)
            self.archive_task=None
        if self.outbox_task:
            self.outbox_task.cancel()
            await asyncio.gather(self.outbox_task,return_exceptions=True)
            self.outbox_task=None
        # Threads must persist final savedata before the event loop stops.
        with self.lock:
            sessions = list(self.sessions.values())
            self.sessions.clear()
        await asyncio.gather(*(asyncio.to_thread(s.close) for s in sessions), return_exceptions=True)
        self.sockets.clear()
        self.loop = None


manager = SessionManager()
