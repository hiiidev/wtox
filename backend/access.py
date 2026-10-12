"""HTTP cookie options and optional env-configured site entrance password.

The entrance token is an HttpOnly, signed, expiring cookie. It does not contain
or store the password itself; changing WTOX_ACCESS_PASSWORD invalidates it.
This is independent of the per-identity .tox login cookie.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import time

COOKIE_NAME = "wtox_site_access"
REMEMBER_SECONDS = 30 * 86400


def secure_cookies() -> bool:
    return os.environ.get("WTOX_INSECURE_HTTP") != "1"


def site_password() -> str | None:
    value = os.environ.get("WTOX_ACCESS_PASSWORD", "")
    if not value:
        return None
    if len(value) < 6:
        raise ValueError("WTOX_ACCESS_PASSWORD must contain at least 6 characters")
    return value


def site_gate_enabled() -> bool:
    return site_password() is not None


def _signing_key(password: str) -> bytes:
    # Mix the site password with the independent server encryption secret
    # when available, so a leaked cookie can't be used to brute-force a
    # relatively weak entrance password without the server secret.
    secret = os.environ.get("WTOX_MASTER_KEY", "")
    return hashlib.sha256(
        b"wtox-site-access-cookie-v1\0" + secret.encode("utf-8")
        + b"\0" + password.encode("utf-8")
    ).digest()


def issue_access_cookie(password: str, now: int | None = None) -> str:
    expiry = int(now if now is not None else time.time()) + REMEMBER_SECONDS
    nonce = base64.urlsafe_b64encode(secrets.token_bytes(16)).decode("ascii").rstrip("=")
    payload = f"v1.{expiry}.{nonce}"
    signature = hmac.new(_signing_key(password), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}.{signature}"


def gate_authorized(cookie: str | None, now: int | None = None) -> bool:
    password = site_password()
    if password is None:
        return True
    if not cookie or len(cookie) > 220:
        return False
    parts = cookie.split(".")
    if len(parts) != 4 or parts[0] != "v1":
        return False
    try:
        expiry = int(parts[1])
        timestamp = int(now if now is not None else time.time())
        if expiry < timestamp or expiry > timestamp + REMEMBER_SECONDS:
            return False
    except ValueError:
        return False
    payload = ".".join(parts[:3])
    expected = hmac.new(_signing_key(password), payload.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts[3])


def password_matches(value: str) -> bool:
    actual = site_password()
    return actual is not None and hmac.compare_digest(
        hashlib.sha256(value.encode("utf-8")).digest(),
        hashlib.sha256(actual.encode("utf-8")).digest(),
    )
