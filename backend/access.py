"""Shared site-entry password; separate from per-user account authentication."""
from __future__ import annotations
import base64
import hashlib
import hmac
import os
import secrets
import time

COOKIE_NAME = "wtox_gate"
SESSION_AGE = 7 * 86400

def validate_settings():
    secret = os.environ.get("WTOX_ACCESS_PASSWORD","")
    if len(secret) < 16 or secret == "REPLACE_WITH_STRONG_RANDOM_PASSWORD":
        raise RuntimeError("Set WTOX_ACCESS_PASSWORD to a real password of at least 16 characters")

def signature(message: bytes) -> bytes:
    # Changing the access password invalidates previously issued entrance cookies.
    key = hashlib.sha256(bytes.fromhex(os.environ["WTOX_MASTER_KEY"]) +
                         os.environ["WTOX_ACCESS_PASSWORD"].encode()).digest()
    return hmac.new(key,message,hashlib.sha256).digest()

def issue_gate_cookie():
    payload = f"{int(time.time()) + SESSION_AGE}:{secrets.token_hex(12)}".encode()
    return base64.urlsafe_b64encode(payload + b"." + signature(payload)).decode()

def gate_valid(cookie: str | None) -> bool:
    if not cookie or len(cookie)>256: return False
    try:
        raw=base64.urlsafe_b64decode(cookie.encode())
        payload,mac=raw.rsplit(b".",1)
        expires=int(payload.split(b":",1)[0])
        return int(time.time()) < expires <= int(time.time())+SESSION_AGE and hmac.compare_digest(mac,signature(payload))
    except (ValueError,TypeError,IndexError):
        return False

def access_password_ok(password: str) -> bool:
    expected=os.environ["WTOX_ACCESS_PASSWORD"]
    # use digest comparison to avoid leaking prefix/timing information
    return hmac.compare_digest(hashlib.sha256(password.encode()).digest(),
                               hashlib.sha256(expected.encode()).digest())

def secure_cookies() -> bool:
    return os.environ.get("WTOX_INSECURE_HTTP") != "1"
