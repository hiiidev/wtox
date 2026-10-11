"""Own exactly one live toxcore instance per saved profile in this process.

No cross-process coordination is provided: uvicorn MUST run one worker.
"""
from __future__ import annotations

import asyncio
import threading

from . import store
from .tox_runtime import ToxSession, ToxActionError


class SessionManager:
    def __init__(self):
        self.sessions: dict[str, ToxSession] = {}
        self.sockets: dict[str, set] = {}
        self.lock = threading.RLock()
        self.loop: asyncio.AbstractEventLoop | None = None

    def start(self, loop: asyncio.AbstractEventLoop):
        self.loop = loop
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

    def on_event(self, uid: str, event: dict):
        payload = event.copy()
        if event.get("type") in ("message", "friend_request"):
            try:
                payload["id"] = store.append_pending(uid, event)
            except Exception as exc:
                print("Tox pending event not stored:", type(exc).__name__, flush=True)
                payload["id"] = None
        loop = self.loop
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

    async def shutdown(self):
        # Threads must persist final savedata before the event loop stops.
        with self.lock:
            sessions = list(self.sessions.values())
            self.sessions.clear()
        await asyncio.gather(*(asyncio.to_thread(s.close) for s in sessions), return_exceptions=True)
        self.sockets.clear()
        self.loop = None


manager = SessionManager()
