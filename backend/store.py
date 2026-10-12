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

# Active Tox identity sessions are renewable indefinitely, with an inactivity
# timeout. Renewal is throttled to avoid writes on each polling request.
TOX_SESSION_IDLE_SECONDS = 180 * 86400
TOX_SESSION_RENEW_BEFORE_SECONDS = 90 * 86400

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
        if "offline_queue" not in columns:
            c.execute("ALTER TABLE accounts ADD COLUMN offline_queue INTEGER NOT NULL DEFAULT 1")
        if "queue_mode_version" not in columns:
            c.execute("ALTER TABLE accounts ADD COLUMN queue_mode_version INTEGER NOT NULL DEFAULT 3")
        # All identities now use the encrypted VPS outbox. Preserve old
        # pending rows rather than dropping them; no per-account switch.
        c.execute("UPDATE accounts SET offline_queue=1,queue_mode_version=3 "
                  "WHERE offline_queue!=1 OR queue_mode_version!=3")
        c.execute("""CREATE TABLE IF NOT EXISTS outbox (
            id TEXT PRIMARY KEY,
            account_id TEXT NOT NULL REFERENCES accounts(id),
            peer TEXT NOT NULL,
            data BLOB,
            status TEXT NOT NULL,
            created INTEGER NOT NULL,
            updated INTEGER NOT NULL,
            session_id TEXT,
            message_id INTEGER,
            error TEXT
        )""")
        c.execute("""CREATE TABLE IF NOT EXISTS archived_attachments (
            id TEXT PRIMARY KEY,
            account_id TEXT NOT NULL REFERENCES accounts(id),
            filename BLOB NOT NULL,
            size INTEGER NOT NULL,
            created INTEGER NOT NULL,
            expires INTEGER NOT NULL
        )""")
        c.execute("CREATE INDEX IF NOT EXISTS ix_archived_attachment_expiry ON archived_attachments(expires)")
        c.execute("""CREATE TABLE IF NOT EXISTS disk_attachments (
            id TEXT PRIMARY KEY,
            account_id TEXT NOT NULL REFERENCES accounts(id),
            filename BLOB NOT NULL,
            size INTEGER NOT NULL,
            created INTEGER NOT NULL,
            expires INTEGER NOT NULL,
            direction TEXT NOT NULL,
            public_key BLOB
        )""")
        attachment_columns = {r[1] for r in c.execute("PRAGMA table_info(disk_attachments)")}
        if "public_key" not in attachment_columns:
            c.execute("ALTER TABLE disk_attachments ADD COLUMN public_key BLOB")
        c.execute("CREATE INDEX IF NOT EXISTS ix_disk_attachment_expiry ON disk_attachments(expires)")
        c.execute("""CREATE TABLE IF NOT EXISTS friend_addresses (
            account_id TEXT NOT NULL REFERENCES accounts(id),
            public_key TEXT NOT NULL,
            tox_address BLOB NOT NULL,
            PRIMARY KEY(account_id,public_key)
        )""")
        c.execute("CREATE INDEX IF NOT EXISTS ix_outbox_user ON outbox(account_id,status,created)")
        # Native Tox send may have succeeded immediately before a crash.
        # NEVER blindly replay a dispatch that was in-flight on restart:
        # doing so can duplicate messages. Surface an uncertain state.
        c.execute("UPDATE outbox SET status='uncertain',error='服务器中断，无法确定是否已发送' WHERE status='dispatching'")
        c.execute("""CREATE TABLE IF NOT EXISTS tox_sessions (
            token_hash TEXT PRIMARY KEY,
            account_id TEXT NOT NULL REFERENCES accounts(id),
            expires INTEGER NOT NULL
        )""")
        c.execute("CREATE INDEX IF NOT EXISTS ix_tox_sessions_expires ON tox_sessions(expires)")

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



def delete_tox_identity(uid: str) -> None:
    """Permanently purge exactly one Tox account and all referencing rows.

    No ON DELETE CASCADE exists in the legacy schema. Explicit child deletes
    prevent foreign-key errors and cross-identity data loss. The calling
    SessionManager must stop the native Tox instance and disk transfers first.
    """
    if not isinstance(uid, str) or not __import__("re").fullmatch(r"[0-9a-f]{32}", uid):
        raise ValueError("无效身份标识")
    with db() as c:
        if c.execute("SELECT 1 FROM accounts WHERE id=?", (uid,)).fetchone() is None:
            raise ValueError("当前 Tox 身份已不存在")
        children = ("tox_sessions", "sessions", "pending", "outbox",
                    "archived_attachments", "disk_attachments",
                    "friend_addresses", "push_subscriptions")
        for table in children:
            exists = c.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
                (table,)).fetchone()
            if exists:
                c.execute(f"DELETE FROM {table} WHERE account_id=?", (uid,))
        c.execute("DELETE FROM accounts WHERE id=?", (uid,))


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
        # bounded queue protects VPS disk; it does not cap Tox identity creation
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
            try:
                original = decrypt(encrypted)
                identity = toxcore.identity(original)
                _check_identity(identity)
                c.execute(
                    "UPDATE accounts SET tox_address=?,tox_pubkey=?,tox_secret_hash=? WHERE id=?",
                    (identity.address, identity.address[:64], identity.secret_proof, uid)
                )
            except Exception as exc:
                # Preserve the encrypted legacy row; do not block other users
                # from starting if one old profile is invalid/corrupted.
                print("Legacy Tox profile migration skipped:",
                      uid[:8], type(exc).__name__, flush=True)


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
    now = int(time.time())
    with db() as c:
        # Expired tokens cannot authenticate; prune them when issuing sessions.
        c.execute("DELETE FROM tox_sessions WHERE expires<=?", (now,))
        c.execute(
            "INSERT INTO tox_sessions(token_hash,account_id,expires) VALUES(?,?,?)",
            (hashlib.sha256(token.encode()).hexdigest(), uid, now + TOX_SESSION_IDLE_SECONDS)
        )
    return token


def renew_tox_session_if_needed(token: str | None) -> bool:
    """Extend a still-valid Tox session only as its idle deadline approaches.

    Does not recreate expired or revoked sessions, and does not put an absolute
    lifetime cap on sessions which continue to be used.
    """
    if not token or len(token) > 512:
        return False
    now = int(time.time())
    with db() as c:
        changed = c.execute(
            "UPDATE tox_sessions SET expires=? "
            "WHERE token_hash=? AND expires>? AND expires<=? "
            "AND EXISTS (SELECT 1 FROM accounts WHERE id=tox_sessions.account_id "
            "AND profile IS NOT NULL)",
            (now + TOX_SESSION_IDLE_SECONDS,
             hashlib.sha256(token.encode()).hexdigest(),
             now, now + TOX_SESSION_RENEW_BEFORE_SECONDS),
        )
        return changed.rowcount == 1


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


OUTBOX_TTL = 7 * 86400
OUTBOX_LIMIT = 250

def offline_queue_enabled(uid: str) -> bool:
    """Compatibility for callers that still inspect the setting."""
    with db() as c:
        exists=c.execute("SELECT 1 FROM accounts WHERE id=?",(uid,)).fetchone()
    if not exists: raise ValueError("Tox 身份不存在")
    return True

def enqueue_outbox(uid: str, peer: str, text: str, client_id: str) -> dict:
    """Encrypt a pending outgoing text, one idempotent browser-generated ID.

    Up to 250 undelivered messages per identity; queued only 7 days.
    """
    if len(peer)!=64 or any(ch not in "0123456789ABCDEF" for ch in peer):
        raise ValueError("好友公钥无效")
    if len(client_id)!=32 or any(ch not in "0123456789abcdef" for ch in client_id):
        raise ValueError("消息 ID 无效")
    if not 1<=len(text.encode("utf-8"))<=1000:
        raise ValueError("消息长度必须为 1–1000 字节")
    now=int(time.time())
    with db() as c:
        c.execute("DELETE FROM outbox WHERE created<?",(now-OUTBOX_TTL*2,))
        c.execute("UPDATE outbox SET status='expired', data=NULL, updated=? "
                  "WHERE status='queued' AND created<?", (now,now-OUTBOX_TTL))
        prior=c.execute("SELECT account_id,peer,status,created,session_id,message_id,error "
                        "FROM outbox WHERE id=?", (client_id,)).fetchone()
        if prior:
            if prior[0]!=uid or prior[1]!=peer: raise ValueError("消息 ID 冲突")
            return {"id":client_id,"public_key":prior[1],"status":prior[2],
                    "created":prior[3],"session_id":prior[4],
                    "message_id":prior[5],"error":prior[6]}
        active=c.execute(
            "SELECT COUNT(*) FROM outbox WHERE account_id=? "
            "AND status IN ('queued','dispatching')", (uid,)
        ).fetchone()[0]
        if active>=OUTBOX_LIMIT: raise ValueError("待发送队列已满（250 条）")
        c.execute(
            "INSERT INTO outbox(id,account_id,peer,data,status,created,updated)"
            " VALUES(?,?,?,?,?,?,?)",
            (client_id,uid,peer,encrypt(text.encode("utf-8")),"queued",now,now)
        )
    return {"id":client_id,"public_key":peer,"status":"queued",
            "created":now,"session_id":None,"message_id":None,"error":None}

def outbox_queued(uid: str):
    now=int(time.time())
    with db() as c:
        c.execute("DELETE FROM outbox WHERE created<?",(now-OUTBOX_TTL*2,))
        c.execute("UPDATE outbox SET status='expired',data=NULL,updated=? "
                  "WHERE status='queued' AND created<?",(now,now-OUTBOX_TTL))
        rows=c.execute(
            "SELECT id,peer,data FROM outbox WHERE account_id=? AND status='queued' "
            "ORDER BY created,id LIMIT 20", (uid,)
        ).fetchall()
    return [(eid,peer,decrypt(data).decode("utf-8")) for eid,peer,data in rows]

def outbox_claim(uid: str, eid: str) -> bool:
    with db() as c:
        cur=c.execute(
            "UPDATE outbox SET status='dispatching',updated=? "
            "WHERE id=? AND account_id=? AND status='queued'",
            (int(time.time()),eid,uid)
        )
        return cur.rowcount==1

def outbox_finish(uid: str, eid: str, status: str, session_id=None, message_id=None, error=None):
    if status not in ("sent","queued","failed","uncertain"): raise ValueError("bad outbox status")
    with db() as c:
        c.execute(
            "UPDATE outbox SET status=?,data=CASE WHEN ?='queued' THEN data ELSE NULL END,"
            "updated=?,session_id=?,message_id=?,error=? "
            "WHERE id=? AND account_id=? AND status='dispatching'",
            (status,status,int(time.time()),session_id,message_id,error,eid,uid)
        )

def outbox_counts(uid: str) -> dict[str,int]:
    """Authenticated status summary: no message text or peer IDs returned."""
    with db() as c:
        rows = c.execute(
            "SELECT status,COUNT(*) FROM outbox "
            "WHERE account_id=? AND created>=? "
            "AND status IN ('queued','dispatching','uncertain') GROUP BY status",
            (uid, int(time.time())-OUTBOX_TTL)
        ).fetchall()
    result = {"queued":0,"dispatching":0,"uncertain":0}
    for status,count in rows:
        result[status] = count
    return result


def outbox_status(uid: str):
    with db() as c:
        rows=c.execute(
            "SELECT id,peer,status,created,session_id,message_id,error FROM outbox "
            "WHERE account_id=? AND created>=? ORDER BY created DESC LIMIT 250",
            (uid,int(time.time())-OUTBOX_TTL*2)
        ).fetchall()
    return [{"id":eid,"public_key":peer,"status":status,"created":created,
             "session_id":session_id,"message_id":msg_id,"error":error}
            for eid,peer,status,created,session_id,msg_id,error in rows]


def remember_friend_tox_id(uid: str, public_key: str, tox_id: str) -> None:
    """Keep the *original* 76-character Tox address when the sender knows it.

    A friend public key is only 64 hex characters, and cannot be expanded to
    the complete address (nospam + checksum) without an original address.
    """
    pk=public_key.strip().upper()
    address=tox_id.strip().upper()
    if (len(pk)!=64 or len(address)!=76 or
            not all(ch in "0123456789ABCDEF" for ch in address) or
            not address.startswith(pk)):
        raise ValueError("好友 Tox ID 与公钥不匹配")
    with db() as connection:
        connection.execute(
            "INSERT INTO friend_addresses(account_id,public_key,tox_address) "
            "VALUES(?,?,?) ON CONFLICT(account_id,public_key) "
            "DO UPDATE SET tox_address=excluded.tox_address",
            (uid,pk,encrypt(address.encode("ascii")))
        )


def friend_tox_ids(uid: str) -> dict[str,str]:
    with db() as connection:
        rows=connection.execute(
            "SELECT public_key,tox_address FROM friend_addresses WHERE account_id=?",
            (uid,)
        ).fetchall()
    return {pubkey:decrypt(address).decode("ascii") for pubkey,address in rows}


def forget_friend_tox_id(uid: str, public_key: str) -> None:
    with db() as connection:
        connection.execute("DELETE FROM friend_addresses WHERE account_id=? "
                           "AND public_key=?",(uid,public_key.upper()))
