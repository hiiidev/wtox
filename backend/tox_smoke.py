"""Offline native c-toxcore smoke test, run inside the Docker image build.

Covers Tox ID creation/restore, callbacks, iteration, friend-list access,
and durable savedata. This does not prove internet interoperability.
"""
from __future__ import annotations

import os
import time

from .tox_identity import ToxCore
from .tox_backup import encrypt_savedata, decrypt_savedata, is_encrypted
from .tox_runtime import ToxSession


def main():
    original_bootstrap = os.environ.get("WTOX_BOOTSTRAP")
    os.environ["WTOX_BOOTSTRAP"] = ""  # deterministic test: no external network required
    try:
        core = ToxCore()
        created = core.identity(nickname="wtox smoke test")
        assert len(created.address) == 76
        encrypted = encrypt_savedata(created.savedata, "中文 aTox 🗝️")
        assert is_encrypted(encrypted) and encrypted.startswith(b"toxEsave")
        assert decrypt_savedata(encrypted, "中文 aTox 🗝️") == created.savedata
        try:
            decrypt_savedata(encrypted, "wrong-password")
        except Exception:
            pass
        else:
            raise AssertionError("Incorrect backup password was accepted")
        restored = core.identity(created.savedata)
        assert restored.address == created.address
        assert restored.secret_proof == created.secret_proof, "Tox private-key proof changed across restore"

        friend_identity = core.identity(nickname="wtox-friend-test")
        saved = []
        events = []
        session = ToxSession(created.savedata, events.append, saved.append)
        try:
            session.start()
            deadline = time.monotonic() + 5
            while session.last_connection == -1 and time.monotonic() < deadline:
                if session.thread is not None and not session.thread.is_alive():
                    break
                time.sleep(0.05)
            assert session.thread is not None and session.thread.is_alive(), "native loop exited"
            assert session.friends() == [], "new identity unexpectedly has friends"
            assert session.last_connection in (0, 1, 2), "invalid network status"
            friend_key = session.add_friend(friend_identity.address, "hello from wtox")
            assert friend_key == friend_identity.address[:64]
            assert len(session.friends()) == 1
            assert session.friends()[0]["public_key"] == friend_key
            assert session.friends()[0]["status"] == 0, "offline friend should be offline"
            updated = session.update_self_profile("wTox smoke", "aTox compatible status", 2)
            assert updated == {"name": "wTox smoke",
                               "status_message": "aTox compatible status",
                               "user_status": 2}, "native Tox profile write/read failed"
        finally:
            session.close()
        assert saved, "session did not flush savedata at shutdown"
        assert core.identity(saved[-1]).address == created.address
        reopened = ToxSession(saved[-1], events.append, saved.append)
        try:
            assert len(reopened.friends()) == 1, "friend was not retained in savedata"
            assert reopened.friends()[0]["public_key"] == friend_key
            assert reopened.self_profile() == {
                "name": "wTox smoke", "status_message": "aTox compatible status",
                "user_status": 2
            }, "nickname/status were not saved to native .tox profile"
            print("wtox native smoke PASS: friends persist across savedata reload")
        finally:
            # Close a session which hasn't started a thread, with explicit native cleanup.
            reopened._save()
            reopened.core.kill(reopened.tox)
            reopened.tox = None
        print("wtox native smoke PASS: savedata + event loop + friends API")
    finally:
        if original_bootstrap is None:
            os.environ.pop("WTOX_BOOTSTRAP", None)
        else:
            os.environ["WTOX_BOOTSTRAP"] = original_bootstrap


if __name__ == "__main__":
    main()
