"""Persistent, account-scoped Web Push with a locally held VAPID key.

Notification payloads deliberately contain no Tox identity or message content.
"""
from __future__ import annotations

import base64
import json
import logging
import os
from pathlib import Path
from urllib.parse import urlparse

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from pywebpush import WebPushException, webpush

from . import store

LOG = logging.getLogger(__name__)


def _key_path() -> Path:
    return store.data_root() / "vapid-private.pem"


def _private_key() -> bytes:
    path = _key_path()
    if not path.exists():
        key = ec.generate_private_key(ec.SECP256R1())
        pem = key.private_bytes(serialization.Encoding.PEM,
                                serialization.PrivateFormat.PKCS8,
                                serialization.NoEncryption())
        # The app normally uses one process/worker and the persistent /data volume.
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(pem)
    return path.read_bytes()


def public_key() -> str:
    key = serialization.load_pem_private_key(_private_key(), password=None)
    point = key.public_key().public_bytes(serialization.Encoding.X962,
                                         serialization.PublicFormat.UncompressedPoint)
    return base64.urlsafe_b64encode(point).rstrip(b"=").decode("ascii")


def init() -> None:
    _private_key()
    with store.db() as c:
        c.execute("""CREATE TABLE IF NOT EXISTS push_subscriptions (
            account_id TEXT NOT NULL REFERENCES accounts(id),
            endpoint TEXT NOT NULL,
            data BLOB NOT NULL,
            PRIMARY KEY (account_id, endpoint)
        )""")


def validate_subscription(raw: object) -> dict:
    if not isinstance(raw, dict):
        raise ValueError("推送订阅格式无效")
    endpoint = raw.get("endpoint")
    keys = raw.get("keys")
    if not isinstance(endpoint, str) or len(endpoint) > 4096:
        raise ValueError("推送端点无效")
    parsed = urlparse(endpoint)
    host = (parsed.hostname or "").lower()
    allowed = (
        host == "fcm.googleapis.com"
        or host == "updates.push.services.mozilla.com"
        or host == "push.services.mozilla.com"
        or host == "web.push.apple.com"
        or host.endswith(".push.apple.com")
    )
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in (None, 443) or not allowed:
        raise ValueError("不受支持的推送端点")
    if not isinstance(keys, dict):
        raise ValueError("推送密钥无效")
    for name in ("p256dh", "auth"):
        value = keys.get(name)
        if not isinstance(value, str) or not 8 <= len(value) <= 256:
            raise ValueError("推送密钥无效")
    return {"endpoint": endpoint, "keys": {"p256dh": keys["p256dh"], "auth": keys["auth"]}}


def save_subscription(uid: str, subscription: dict) -> None:
    blob = store.encrypt(json.dumps(subscription).encode("utf-8"))
    with store.db() as c:
        # An endpoint can never retain an earlier owner's account association.
        c.execute("DELETE FROM push_subscriptions WHERE endpoint=?", (subscription["endpoint"],))
        c.execute("INSERT INTO push_subscriptions(account_id,endpoint,data) VALUES(?,?,?)",
                  (uid, subscription["endpoint"], blob))


def remove_subscription(uid: str, endpoint: str) -> None:
    with store.db() as c:
        c.execute("DELETE FROM push_subscriptions WHERE account_id=? AND endpoint=?", (uid, endpoint))


def send_to_user(uid: str, kind: str = "message") -> dict:
    with store.db() as c:
        rows = c.execute("SELECT endpoint,data FROM push_subscriptions WHERE account_id=?", (uid,)).fetchall()
    sent = 0
    failed = 0
    for endpoint, encrypted in rows:
        try:
            subscription = json.loads(store.decrypt(encrypted))
            webpush(subscription_info=subscription,
                    data=json.dumps({"kind": kind}),
                    vapid_private_key=str(_key_path()),
                    vapid_claims={"sub": os.environ.get("WTOX_VAPID_SUBJECT", "mailto:admin@example.com")},
                    ttl=300)
            sent += 1
        except WebPushException as exc:
            failed += 1
            if getattr(getattr(exc, "response", None), "status_code", None) in (404, 410):
                remove_subscription(uid, endpoint)
            LOG.warning("Web Push failed: %s", type(exc).__name__)
        except Exception as exc:
            failed += 1
            LOG.warning("Web Push unavailable: %s", type(exc).__name__)
    return {"sent": sent, "failed": failed}
