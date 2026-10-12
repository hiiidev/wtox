"""Optional site password with long-lived, revocable per-device cookies.

Only hashes of random browser credentials are persisted. Old unsigned or
stateless v2 cookies must reauthenticate after upgrading to this version.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import time

from . import store

COOKIE_NAME = "wtox_site_access"
# The expiry is sliding, not a hard cap on how many years a trusted browser
# can be remembered. An unused/stolen cookie expires in a year at most.
REMEMBER_SECONDS = 365 * 86400
_GRACE_SECONDS = 30


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
        b"wtox-site-access-cookie-v3\0" + secret.encode("utf-8")
        + b"\0" + password.encode("utf-8")
    ).digest()


def _valid_signature(cookie: str | None, password: str) -> bool:
    if not cookie or len(cookie) > 220:
        return False
    parts = cookie.split(".")
    if len(parts) != 3 or parts[0] != "v3" or len(parts[1]) != 32:
        return False
    payload = ".".join(parts[:2])
    expected = hmac.new(_signing_key(password), payload.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts[2])


def _digest(cookie: str) -> str:
    return hashlib.sha256(cookie.encode("ascii")).hexdigest()


def _ensure_table(conn):
    conn.execute("""CREATE TABLE IF NOT EXISTS site_access_devices (
        token_hash TEXT PRIMARY KEY,
        id TEXT NOT NULL,
        created INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        expires INTEGER NOT NULL
    )""")
    conn.execute("CREATE INDEX IF NOT EXISTS ix_site_device_id ON site_access_devices(id)")


def issue_access_cookie(password: str, *, device_id: str | None = None,
                        device_created: int | None = None) -> str:
    nonce = base64.urlsafe_b64encode(secrets.token_bytes(24)).decode("ascii").rstrip("=")
    payload = f"v3.{nonce}"
    mac = hmac.new(_signing_key(password), payload.encode(), hashlib.sha256).hexdigest()
    token = f"{payload}.{mac}"
    now = int(time.time())
    with store.db() as conn:
        _ensure_table(conn)
        conn.execute("DELETE FROM site_access_devices WHERE expires<=?", (now,))
        conn.execute("INSERT INTO site_access_devices VALUES (?,?,?,?,?)",
                     (_digest(token), device_id or secrets.token_hex(12),
                      device_created if device_created is not None else now,
                      now, now + REMEMBER_SECONDS))
    return token


def gate_authorized(cookie: str | None) -> bool:
    password = site_password()
    if password is None:
        return True
    if not _valid_signature(cookie, password):
        return False
    with store.db() as conn:
        _ensure_table(conn)
        return conn.execute(
            "SELECT 1 FROM site_access_devices WHERE token_hash=? AND expires>?",
            (_digest(cookie), int(time.time()))
        ).fetchone() is not None


def renew_access_cookie(cookie: str | None) -> str | None:
    """Rotate on site launch. Old token gets a brief overlap for other tabs."""
    password = site_password()
    if password is None or not _valid_signature(cookie, password):
        return None
    now = int(time.time())
    with store.db() as conn:
        _ensure_table(conn)
        row = conn.execute(
            "SELECT id,created FROM site_access_devices WHERE token_hash=? AND expires>?",
            (_digest(cookie), now)
        ).fetchone()
        if not row:
            return None
        # Old credential cannot be replayed indefinitely after rotation.
        conn.execute("UPDATE site_access_devices SET expires=MIN(expires,?) WHERE token_hash=?",
                     (now + _GRACE_SECONDS, _digest(cookie)))
    return issue_access_cookie(password, device_id=row[0], device_created=row[1])


def revoke_access_cookie(cookie: str | None):
    if not cookie or len(cookie) > 220:
        return
    with store.db() as conn:
        _ensure_table(conn)
        conn.execute(
            "DELETE FROM site_access_devices WHERE id IN "
            "(SELECT id FROM site_access_devices WHERE token_hash=?)",
            (_digest(cookie),)
        )


def access_devices(cookie: str | None) -> list[dict]:
    if not gate_authorized(cookie):
        return []
    with store.db() as conn:
        _ensure_table(conn)
        rows = conn.execute(
            "SELECT id, MIN(created), MAX(last_seen), "
            "MAX(CASE WHEN token_hash=? THEN 1 ELSE 0 END) "
            "FROM site_access_devices WHERE expires>? "
            "GROUP BY id ORDER BY MAX(last_seen) DESC LIMIT 100",
            (_digest(cookie), int(time.time()))
        ).fetchall()
    return [{"id": x[0], "current": bool(x[3]),
             "created": x[1], "last_seen": x[2]} for x in rows]


def revoke_device(device_id: str):
    if len(device_id) != 24 or not all(c in "0123456789abcdef" for c in device_id):
        raise ValueError("Invalid device ID")
    with store.db() as conn:
        _ensure_table(conn)
        conn.execute("DELETE FROM site_access_devices WHERE id=?", (device_id,))


def password_matches(value: str) -> bool:
    actual = site_password()
    return actual is not None and hmac.compare_digest(
        hashlib.sha256(value.encode("utf-8")).digest(),
        hashlib.sha256(actual.encode("utf-8")).digest(),
    )
