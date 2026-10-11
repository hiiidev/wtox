"""SQLite accounts, sessions and encrypted Tox identity storage."""
from __future__ import annotations

import hashlib
import os
import secrets
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from argon2 import PasswordHasher
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

_LOCK = threading.RLock()
_HASHER = PasswordHasher()

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
        c.execute("CREATE UNIQUE INDEX IF NOT EXISTS ix_unique_tox_address ON accounts(tox_address)")

def add_account(username: str, password: str) -> str:
    if not (3 <= len(username) <= 40 and username.isascii()
            and all(c.isalnum() or c in "_-" for c in username)):
        raise ValueError("账号名应为 3–40 位英文字母、数字、- 或 _")
    if not 12 <= len(password) <= 256:
        raise ValueError("账号密码应为 12–256 个字符")
    hashed = _HASHER.hash(password)
    uid = uuid.uuid4().hex
    try:
        with db() as c:
            c.execute("INSERT INTO accounts(id,username,password_hash) VALUES(?,?,?)", (uid,username,hashed))
    except sqlite3.IntegrityError as exc:
        raise ValueError("账号名已存在") from exc
    return uid

def verify_account(username: str, password: str) -> str | None:
    with db() as c:
        row = c.execute("SELECT id,password_hash FROM accounts WHERE username=?", (username,)).fetchone()
    if row is None: return None
    try:
        return row[0] if _HASHER.verify(row[1],password) else None
    except Exception:
        return None

def create_session(uid: str) -> str:
    token = secrets.token_urlsafe(48)
    with db() as c:
        c.execute("INSERT INTO sessions(token_hash,account_id,expires) VALUES(?,?,?)",
                  (hashlib.sha256(token.encode()).hexdigest(),uid,int(time.time())+7*86400))
    return token

def session_user(token: str | None) -> str | None:
    if not token: return None
    key = hashlib.sha256(token.encode()).hexdigest()
    with db() as c:
        row = c.execute("SELECT account_id FROM sessions WHERE token_hash=? AND expires>?",
                        (key,int(time.time()))).fetchone()
    return row[0] if row else None

def revoke_session(token: str | None):
    if not token: return
    with db() as c:
        c.execute("DELETE FROM sessions WHERE token_hash=?",
                  (hashlib.sha256(token.encode()).hexdigest(),))

def user_info(uid: str):
    with db() as c:
        row = c.execute("SELECT username,profile IS NOT NULL FROM accounts WHERE id=?",(uid,)).fetchone()
    return {"username":row[0],"has_profile":bool(row[1])} if row else None

def profile_address(uid: str) -> str | None:
    with db() as c:
        row = c.execute("SELECT tox_address FROM accounts WHERE id=?", (uid,)).fetchone()
    return row[0] if row else None

def claim_profile(uid: str, savedata: bytes, address: str) -> None:
    """First creation/import only: atomically prevent overwrite and ID duplicates."""
    if not isinstance(savedata, bytes) or not 1 <= len(savedata) <= 8 * 1024 * 1024:
        raise ValueError("Tox 配置大小无效")
    if not isinstance(address, str) or len(address) != 76 or any(ch not in "0123456789ABCDEF" for ch in address):
        raise ValueError("Tox ID 无效")
    ciphertext = encrypt(savedata)
    try:
        with db() as c:
            result = c.execute(
                "UPDATE accounts SET profile=?,tox_address=? WHERE id=? AND profile IS NULL",
                (ciphertext, address, uid))
            if result.rowcount != 1:
                raise ValueError("该账号已有 Tox 身份，不能覆盖；请先导出备份")
    except sqlite3.IntegrityError as exc:
        raise ValueError("这个 Tox 身份已经导入其他网站账号") from exc

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

def has_profile(uid: str) -> bool:
    return user_info(uid)["has_profile"]

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
