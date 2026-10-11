"""HTTP cookie security options. Tox identity sessions provide authentication."""
from __future__ import annotations
import os


def secure_cookies() -> bool:
    return os.environ.get("WTOX_INSECURE_HTTP") != "1"
