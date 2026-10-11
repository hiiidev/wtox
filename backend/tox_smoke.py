"""Offline native c-toxcore smoke test, run inside the Docker image build.

Covers Tox ID creation/restore, callbacks, iteration, friend-list access,
and durable savedata. This does not prove internet interoperability.
"""
from __future__ import annotations

import os
import time

from .tox_identity import ToxCore
from .tox_runtime import ToxSession


def main():
    original_bootstrap = os.environ.get("WTOX_BOOTSTRAP")
    os.environ["WTOX_BOOTSTRAP"] = ""  # deterministic test: no external network required
    try:
        core = ToxCore()
        created = core.identity(nickname="wtox smoke test")
        assert len(created.address) == 76
        assert core.identity(created.savedata).address == created.address

        saved = []
        events = []
        session = ToxSession(created.savedata, events.append, saved.append)
        try:
            session.start()
            time.sleep(0.5)
            assert session.thread is not None and session.thread.is_alive(), "native loop exited"
            assert session.friends() == [], "new identity unexpectedly has friends"
            assert session.last_connection in (0, 1, 2), "invalid network status"
        finally:
            session.close()
        assert saved, "session did not flush savedata at shutdown"
        assert core.identity(saved[-1]).address == created.address
        print("wtox native smoke PASS: savedata + event loop + friends API")
    finally:
        if original_bootstrap is None:
            os.environ.pop("WTOX_BOOTSTRAP", None)
        else:
            os.environ["WTOX_BOOTSTRAP"] = original_bootstrap


if __name__ == "__main__":
    main()
