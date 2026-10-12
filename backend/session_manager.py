"""Own exactly one live toxcore instance per saved profile in this process.

No cross-process coordination is provided: uvicorn MUST run one worker.
"""
from __future__ import annotations

import asyncio
import threading
from .tox_runtime import FriendOfflineError

from . import store, web_push
from .tox_runtime import ToxSession, ToxActionError
from .attachment_disk import DiskAttachmentStore


class SessionManager:
    def __init__(self):
        self.sessions: dict[str, ToxSession] = {}
        self.sockets: dict[str, set] = {}
        self.lock = threading.RLock()
        self.loop: asyncio.AbstractEventLoop | None = None
        self.outbox_task: asyncio.Task | None = None
        self.disk_cleanup_task: asyncio.Task | None = None
        self.disk: DiskAttachmentStore | None = None

    def start(self, loop: asyncio.AbstractEventLoop):
        self.loop = loop
        self.disk = DiskAttachmentStore()
        # Expire old completed files and abandoned uploads even after a restart.
        self.disk.expire()
        self.outbox_task = loop.create_task(self._outbox_loop())
        self.disk_cleanup_task = loop.create_task(self._disk_expiry_loop())
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
                if session.thread is None or session.thread.is_alive():
                    return session
                # A stopped native Tox thread has completed its cleanup.
                # The VPS outbox worker must recover it without browser login.
                self.sessions.pop(uid, None)
                print("Recovering stopped Tox identity:", uid[:8], flush=True)
            savedata = store.read_profile(uid)
            if savedata is None:
                raise ValueError("请先创建或导入 Tox 身份")
            session = ToxSession(
                savedata=savedata,
                on_event=lambda event: self.on_event(uid, event),
                on_save=lambda data: store.write_profile(uid, data),
            )
            if self.disk is None:
                self.disk = DiskAttachmentStore()
            session.files.disk = self.disk
            session.files.uid = uid
            # No browser socket: receive native file offers on behalf of the
            # signed-in account. A connected browser retains manual Accept.
            session.files.should_auto_accept = lambda account=uid: not bool(self.sockets.get(account))
            self.sessions[uid] = session
            try:
                session.start()
            except Exception:
                self.sessions.pop(uid, None)
                raise
            return session

    def dispatch_outbox(self, uid: str):
        """One round of encrypted offline queue draining on a worker thread.

        The DB claim is durable BEFORE any native send. A crash after claim
        leaves 'uncertain' (never an automatic duplicate on restart).
        """
        # Serialize dispatch with account purges to prevent post-delete sends.
        with self.lock:
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

    async def _disk_expiry_loop(self):
        while True:
            try:
                if self.disk is not None:
                    await asyncio.to_thread(self.disk.expire)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                print("Local attachment expiry failed:",type(exc).__name__,flush=True)
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
        if loop and loop.is_running() and event.get("type") in ("message", "friend_request"):
            loop.call_soon_threadsafe(lambda: asyncio.create_task(
                asyncio.to_thread(web_push.send_to_user, uid, event["type"])))
        if loop and loop.is_running():
            loop.call_soon_threadsafe(lambda: asyncio.create_task(self.broadcast(uid, payload)))

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

    async def remove_account(self, uid: str) -> None:
        """Stop the live native Tox identity, erase its attachment spool and
        related persistent rows, then disconnect all browser sockets.

        Serialize with outbox dispatch and session restoration. Keep the
        database unchanged when shutting down the Tox thread fails.
        """
        await asyncio.to_thread(self._remove_account_sync, uid)
        sockets = list(self.sockets.pop(uid, ()))
        if sockets:
            await asyncio.gather(*(ws.close(code=1008) for ws in sockets),
                                 return_exceptions=True)

    def _remove_account_sync(self, uid: str) -> None:
        with self.lock:
            # Stop native callbacks (which can write savedata) before erasing
            # the profile. We must never let a stopped session restore itself.
            running = self.sessions.get(uid)
            if running is not None:
                running.close()
                self.sessions.pop(uid, None)
            if self.disk is None:
                self.disk = DiskAttachmentStore()
            # Remove disk before DB indexes: on failure the account remains
            # recoverable and cleanup can be retried.
            self.disk.remove_account(uid)
            store.delete_tox_identity(uid)

    async def shutdown(self):
        if self.disk_cleanup_task:
            self.disk_cleanup_task.cancel()
            await asyncio.gather(self.disk_cleanup_task,return_exceptions=True)
            self.disk_cleanup_task=None
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
