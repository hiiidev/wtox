"""HTTP cookie options and an optional environment-configured site password.

A signed HttpOnly cookie remembers an authorized browser across restarts.
The token has no built-in 30-day deadline and does not store the password.
Browser cookie lifetimes may be capped; the status request renews the cookie
when the site is opened. Changing the env password invalidates all old tokens.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets

COOKIE_NAME = "wtox_site_access"
# Browser-enforced cookie expiry can be shorter (e.g. ~400 days). Renew on
# every normal site launch instead of requiring repeated password entry.
REMEMBER_SECONDS = 10 * 365 * 86400


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
    secret = os.environ.get("WTOX_MASTER_KEY", "")
    return hashlib.sha256(
        b"wtox-site-access-cookie-v2\0" + secret.encode("utf-8")
        + b"\0" + password.encode("utf-8")
    ).digest()


def issue_access_cookie(password: str) -> str:
    nonce = base64.urlsafe_b64encode(secrets.token_bytes(24)).decode("ascii").rstrip("=")
    payload = f"v2.{nonce}"
    mac = hmac.new(_signing_key(password), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}.{mac}"


def gate_authorized(cookie: str | None) -> bool:
    password = site_password()
    if password is None:
        return True
    if not cookie or len(cookie) > 220:
        return False
    parts = cookie.split(".")
    if len(parts) != 3 or parts[0] != "v2" or len(parts[1]) != 32:
        return False
    payload = ".".join(parts[:2])
    expected = hmac.new(_signing_key(password), payload.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts[2])


def password_matches(value: str) -> bool:
    actual = site_password()
    return actual is not None and hmac.compare_digest(
        hashlib.sha256(value.encode("utf-8")).digest(),
        hashlib.sha256(actual.encode("utf-8")).digest(),
    )
