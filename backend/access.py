"""Shared site-entry password; independent from personal Tox accounts."""
from __future__ import annotations
import base64
import binascii
import hashlib
import hmac
import os
import secrets
import time

COOKIE_NAME = "wtox_gate"
SESSION_AGE = 7 * 86400

def validate_settings():
    secret = os.environ.get("WTOX_ACCESS_PASSWORD", "")
    if len(secret) < 6 or secret == "REPLACE_WITH_STRONG_RANDOM_PASSWORD":
        raise RuntimeError("Set WTOX_ACCESS_PASSWORD to a real password of at least 6 characters")

def signature(message: bytes) -> bytes:
    # Rotating the entrance password revokes issued entrance cookies.
    key = hashlib.sha256(bytes.fromhex(os.environ["WTOX_MASTER_KEY"]) +
                         os.environ["WTOX_ACCESS_PASSWORD"].encode()).digest()
    return hmac.new(key, message, hashlib.sha256).digest()

def encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")

def decode(data: str) -> bytes:
    if not data.isascii() or not data or len(data) > 160:
        raise ValueError("invalid base64")
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))

def issue_gate_cookie() -> str:
    payload = f"{int(time.time()) + SESSION_AGE}:{secrets.token_hex(12)}".encode()
    return encode(payload) + "." + encode(signature(payload))

def gate_valid(cookie: str | None) -> bool:
    if not cookie or len(cookie) > 256: return False
    try:
        encoded_payload, encoded_mac = cookie.split(".")
        payload, mac = decode(encoded_payload), decode(encoded_mac)
        expires = int(payload.split(b":", 1)[0])
        now = int(time.time())
        return now < expires <= now + SESSION_AGE and hmac.compare_digest(mac, signature(payload))
    except (ValueError, TypeError, IndexError, binascii.Error):
        return False

def access_password_ok(password: str) -> bool:
    expected = os.environ["WTOX_ACCESS_PASSWORD"]
    return hmac.compare_digest(hashlib.sha256(password.encode()).digest(),
                               hashlib.sha256(expected.encode()).digest())

def secure_cookies() -> bool:
    return os.environ.get("WTOX_INSECURE_HTTP") != "1"
