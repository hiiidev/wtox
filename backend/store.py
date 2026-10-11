"""Encrypted Tox identities, temporary messages and Tox-backed sessions.

Legacy account tables remain only to preserve previous identities and allow a
one-way profile export from still-valid pre-upgrade sessions.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

_LOCK = threading.RLock()

def data_root() -> Path:
    root = Path(os.environ.get("WTOX_DATA_DIR", "/data"))
    root.mkdir(parents=True, exist_ok=True)
    return root

def master_key() -> bytes:
    try:
        key = bytes.fromhex(os.environ["WTOX_MASTER_KEY"])
    except (ValueError, KeyError) as exc:
        raise RuntimeError("WTOX_MASTER_KEY must be 64 hex characters") from exc
    if len(key) != 32:
        raise RuntimeError("WTOX_MASTER_KEY must be 32 bytes")
    return key

def encrypt(clear: bytes) -> bytes:
    nonce = os.urandom(12)
    return nonce + AESGCM(master_key()).encrypt(nonce, clear, b"wtox-v1")

def decrypt(cipher: bytes) -> bytes:
    if len(cipher) < 29:
        raise ValueError("invalid ciphertext")
    return AESGCM(master_key()).decrypt(cipher[:12], cipher[12:], b"wtox-v1")

@contextmanager
def db():
    with _LOCK:
        conn = sqlite3.connect(str(data_root() / "wtox.sqlite3"), timeout=20)
        try:
            conn.execute("PRAGMA foreign_keys=ON")
            yield conn
            conn.commit()
        finally:
            conn.close()

def init():
    master_key()
    with db() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS accounts (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            profile BLOB
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            account_id TEXT NOT NULL REFERENCES accounts(id),
            expires INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS pending (
            id TEXT PRIMARY KEY,
            account_id TEXT NOT NULL REFERENCES accounts(id),
            data BLOB NOT NULL,
            created INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_pending_user ON pending(account_id,created);
        """)
        columns = {r[1] for r in c.execute("PRAGMA table_info(accounts)")}
        if "tox_address" not in columns:
            c.execute("ALTER TABLE accounts ADD COLUMN tox_address TEXT")
        if "tox_pubkey" not in columns:
            c.execute("ALTER TABLE accounts ADD COLUMN tox_pubkey TEXT")
        c.execute("UPDATE accounts SET tox_pubkey=SUBSTR(tox_address,1,64) WHERE tox_pubkey IS NULL AND tox_address IS NOT NULL")
        c.execute("CREATE UNIQUE INDEX IF NOT EXISTS ix_unique_tox_pubkey ON accounts(tox_pubkey)")
        if "tox_secret_hash" not in columns:
            c.execute("ALTER TABLE accounts ADD COLUMN tox_secret_hash BLOB")
        c.execute("""CREATE TABLE IF NOT EXISTS tox_sessions (
            token_hash TEXT PRIMARY KEY,
            account_id TEXT NOT NULL REFERENCES accounts(id),
            expires INTEGER NOT NULL
        )""")

def legacy_session_user(token: str | None) -> str | None:
    """Recognize only an already-issued OLD session, for one-way .tox export."""
    if not token or len(token) > 512:
        return None
    digest = hashlib.sha256(token.encode()).hexdigest()
    with db() as c:
        row = c.execute(
            "SELECT account_id FROM sessions WHERE token_hash=? AND expires>?",
            (digest, int(time.time()))
        ).fetchone()
    return row[0] if row else None


def active_profiles():
    with db() as c:
        return [r[0] for r in c.execute("SELECT id FROM accounts WHERE profile IS NOT NULL")]

def read_profile(uid: str) -> bytes | None:
    with db() as c:
        row = c.execute("SELECT profile FROM accounts WHERE id=?",(uid,)).fetchone()
    return decrypt(row[0]) if row and row[0] is not None else None

def write_profile(uid: str, savedata: bytes):
    if not savedata or len(savedata) > 8 * 1024 * 1024:
        raise ValueError("Tox 配置文件无效或超过 8 MiB")
    with db() as c:
        c.execute("UPDATE accounts SET profile=? WHERE id=?",(encrypt(savedata),uid))

def append_pending(uid: str, event: dict) -> str:
    import json
    payload = encrypt(json.dumps(event,ensure_ascii=False).encode())
    eid = uuid.uuid4().hex
    now = int(time.time())
    with db() as c:
        c.execute("DELETE FROM pending WHERE created<?",(now-7*86400,))
        # bounded queue to protect limited VPS disk, not a limit on account creation
        count = c.execute("SELECT COUNT(*) FROM pending WHERE account_id=?",(uid,)).fetchone()[0]
        if count >= 1000: raise RuntimeError("消息临时队列已满")
        c.execute("INSERT INTO pending VALUES(?,?,?,?)",(eid,uid,payload,now))
    return eid

def get_pending(uid: str):
    import json
    with db() as c:
        c.execute("DELETE FROM pending WHERE created<?",(int(time.time())-7*86400,))
        rows = c.execute("SELECT id,data,created FROM pending WHERE account_id=? ORDER BY created",(uid,)).fetchall()
    return [{"id":eid,"event":json.loads(decrypt(data)),"created":created} for eid,data,created in rows]

def ack_pending(uid: str, ids: list[str]):
    with db() as c:
        c.executemany("DELETE FROM pending WHERE account_id=? AND id=?",
                      [(uid,eid) for eid in ids[:100]])


# Tox identity is the only login credential for new installations.
# Legacy 'accounts' rows are retained as an internal storage/migration format
# so previously encrypted identities and pending messages are not discarded.
# The old username and password_hash fields are not accepted for authentication.

def _check_identity(identity):
    address = identity.address
    if (not isinstance(address, str) or len(address) != 76
            or any(ch not in "0123456789ABCDEF" for ch in address)):
        raise ValueError("Tox ID 格式无效")
    if (not isinstance(identity.savedata, bytes)
            or not 1 <= len(identity.savedata) <= 8 * 1024 * 1024):
        raise ValueError("Tox 配置大小无效")
    proof = identity.secret_proof
    if not isinstance(proof, bytes) or len(proof) != 32:
        raise ValueError("Tox 私钥校验失败")
    return address[:64]


def migrate_legacy_identities(toxcore):
    """Backfill ownership hashes; never delete pre-existing accounts/messages."""
    with db() as c:
        rows = c.execute(
            "SELECT id,profile FROM accounts "
            "WHERE profile IS NOT NULL AND (tox_secret_hash IS NULL OR tox_pubkey IS NULL)"
        ).fetchall()
        for uid, encrypted in rows:
            original = decrypt(encrypted)
            identity = toxcore.identity(original)
            _check_identity(identity)
            c.execute(
                "UPDATE accounts SET tox_address=?,tox_pubkey=?,tox_secret_hash=? WHERE id=?",
                (identity.address, identity.address[:64], identity.secret_proof, uid)
            )


def create_tox_identity(identity) -> str:
    """Add a newly generated native identity, with no username/password login."""
    pubkey = _check_identity(identity)
    uid = uuid.uuid4().hex
    with db() as c:
        try:
            c.execute(
                "INSERT INTO accounts(id,username,password_hash,profile,tox_address,tox_pubkey,tox_secret_hash)"
                " VALUES(?,?,?,?,?,?,?)",
                (uid, "tox-" + uid, "!disabled!", encrypt(identity.savedata),
                 identity.address, pubkey, identity.secret_proof)
            )
        except sqlite3.IntegrityError as exc:
            raise ValueError("这个 Tox 身份已存在") from exc
    return uid


def login_or_import_tox(identity, toxcore) -> tuple[str, bool]:
    """Validate *private-key ownership*, never trust an arbitrary public Tox ID.

    Existing profiles keep their authoritative VPS savedata, which may contain
    newer friends/nospam than the uploaded backup. Only a never-seen key is
    registered. The Tox private key is never returned to the browser as text.
    """
    pubkey = _check_identity(identity)
    with db() as c:
        row = c.execute(
            "SELECT id,profile,tox_secret_hash FROM accounts WHERE tox_pubkey=?",
            (pubkey,)
        ).fetchone()
        if row:
            uid, ciphertext, proof = row
            if ciphertext is None:
                raise ValueError("身份数据不存在")
            if proof is None:
                proof = toxcore.identity(decrypt(ciphertext)).secret_proof
            if not hmac.compare_digest(bytes(proof), identity.secret_proof):
                raise ValueError("Tox 配置私钥与服务器记录不匹配")
            c.execute("UPDATE accounts SET tox_secret_hash=? WHERE id=?", (proof, uid))
            return uid, False
        uid = uuid.uuid4().hex
        try:
            c.execute(
                "INSERT INTO accounts(id,username,password_hash,profile,tox_address,tox_pubkey,tox_secret_hash)"
                " VALUES(?,?,?,?,?,?,?)",
                (uid, "tox-" + uid, "!disabled!", encrypt(identity.savedata),
                 identity.address, pubkey, identity.secret_proof)
            )
        except sqlite3.IntegrityError as exc:
            raise ValueError("Tox 身份已存在，无法导入") from exc
        return uid, True


def create_tox_session(uid: str) -> str:
    token = secrets.token_urlsafe(48)
    with db() as c:
        c.execute(
            "INSERT INTO tox_sessions(token_hash,account_id,expires) VALUES(?,?,?)",
            (hashlib.sha256(token.encode()).hexdigest(), uid, int(time.time()) + 7*86400)
        )
    return token


def tox_session_user(token: str | None) -> str | None:
    if not token or len(token) > 512:
        return None
    with db() as c:
        row = c.execute(
            "SELECT s.account_id FROM tox_sessions AS s "
            "JOIN accounts AS a ON s.account_id=a.id "
            "WHERE s.token_hash=? AND s.expires>? AND a.profile IS NOT NULL",
            (hashlib.sha256(token.encode()).hexdigest(), int(time.time()))
        ).fetchone()
        return row[0] if row else None


def revoke_tox_session(token: str | None):
    if not token:
        return
    with db() as c:
        c.execute("DELETE FROM tox_sessions WHERE token_hash=?",
                  (hashlib.sha256(token.encode()).hexdigest(),))


def tox_identity_info(uid: str) -> dict | None:
    with db() as c:
        row = c.execute("SELECT tox_address,tox_pubkey FROM accounts "
                        "WHERE id=? AND profile IS NOT NULL", (uid,)).fetchone()
    if not row:
        return None
    return {"tox_id": row[0], "public_key": row[1]}


def needs_legacy_migration() -> bool:
    with db() as c:
        row = c.execute(
            "SELECT 1 FROM accounts WHERE profile IS NOT NULL "
            "AND (tox_secret_hash IS NULL OR tox_pubkey IS NULL) LIMIT 1"
        ).fetchone()
    return row is not None
