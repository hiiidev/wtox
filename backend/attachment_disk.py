"""Seven-day AES-GCM encrypted VPS disk spool for native Tox file transfers.

Only small (64 KiB) blocks are held in Python memory during upload/receive and
native Tox chunk requests. Files remain scoped to their Tox account in SQLite.
The VPS is still a Tox endpoint: this is not browser-to-browser E2E encryption.
"""
from __future__ import annotations

import os
import re
import shutil
import time
import uuid
from pathlib import Path

from . import store

BLOCK = 64 * 1024
MAX_FILE = 5 * 1024 * 1024
TTL = 7 * 86400
_HEX32 = re.compile(r"^[a-f0-9]{32}$")


def _identifier(value: str) -> str:
    if not isinstance(value, str) or not _HEX32.fullmatch(value):
        raise ValueError("无效附件或账户标识")
    return value


def _write_private(path: Path, contents: bytes) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, "wb") as file:
        file.write(contents)


class DiskAttachment:
    def __init__(self, storage, uid: str, ident: str, name: str,
                 expected: int | None, direction: str):
        self.storage = storage
        self.uid = _identifier(uid)
        self.id = _identifier(ident)
        self.name = name
        self.direction = direction
        self.expected = expected
        self.size = 0
        self._buffer = bytearray()
        self.complete = False
        self.created = int(time.time())
        self.folder = storage.folder(uid, ident)
        self.folder.mkdir(mode=0o700)
        if not name or len(name.encode("utf-8")) > 220:
            self.abort()
            raise ValueError("附件文件名无效")
        if expected is not None and not 1 <= expected <= MAX_FILE:
            self.abort()
            raise ValueError("附件大小不合法")

    def _flush(self):
        if not self._buffer:
            return
        index = (self.size - len(self._buffer)) // BLOCK
        _write_private(self.folder / f"{index:08x}.bin", store.encrypt(bytes(self._buffer)))
        self._buffer.clear()

    def write(self, data: bytes):
        if self.complete:
            raise ValueError("已完成的附件不可更改")
        if not data:
            return
        if self.size + len(data) > MAX_FILE or (
                self.expected is not None and self.size + len(data) > self.expected):
            raise ValueError("附件超过 5 MiB 或声明大小")
        offset = 0
        while offset < len(data):
            count = min(len(data) - offset, BLOCK - len(self._buffer))
            self._buffer.extend(data[offset:offset + count])
            self.size += count
            offset += count
            if len(self._buffer) == BLOCK:
                self._flush()

    def finish(self):
        if self.complete:
            return self
        if not 1 <= self.size <= MAX_FILE or (
                self.expected is not None and self.size != self.expected):
            raise ValueError("附件长度不完整")
        self._flush()
        expires = self.created + TTL
        with store.db() as db:
            db.execute(
                "INSERT INTO disk_attachments"
                "(id,account_id,filename,size,created,expires,direction)"
                " VALUES(?,?,?,?,?,?,?)",
                (self.id, self.uid, store.encrypt(self.name.encode("utf-8")),
                 self.size, self.created, expires, self.direction))
        self.complete = True
        return self

    def read(self, position: int, length: int) -> bytes:
        if not self.complete or position < 0 or length < 0 or position + length > self.size:
            raise ValueError("附件未完成或读取位置越界")
        if not length:
            return b""
        chunks = []
        end = position + length
        while position < end:
            index, inner = divmod(position, BLOCK)
            clear = store.decrypt((self.folder / f"{index:08x}.bin").read_bytes())
            actual = min(BLOCK, self.size - index * BLOCK)
            if len(clear) != actual:
                raise ValueError("附件磁盘块长度不符")
            part = min(end - position, actual - inner)
            chunks.append(clear[inner:inner + part])
            position += part
        return b"".join(chunks)

    def abort(self):
        self.storage.discard(self.uid, self.id)


class DiskAttachmentStore:
    def __init__(self):
        self.root = store.data_root() / "tox-attachments"
        self.root.mkdir(mode=0o700, exist_ok=True)
        os.chmod(self.root, 0o700)

    def folder(self, uid: str, ident: str) -> Path:
        return self.root / _identifier(uid) / _identifier(ident)

    def begin(self, uid: str, name: str, expected: int | None = None,
              direction: str = "incoming", ident: str | None = None) -> DiskAttachment:
        if direction not in ("incoming", "outgoing"):
            raise ValueError("未知附件方向")
        _identifier(uid)
        ident = _identifier(ident or uuid.uuid4().hex)
        parent = self.root / uid
        parent.mkdir(mode=0o700, exist_ok=True)
        return DiskAttachment(self, uid, ident, name, expected, direction)

    def discard(self, uid: str, ident: str) -> None:
        path = self.folder(uid, ident)
        if path.exists():
            shutil.rmtree(path)
        with store.db() as db:
            db.execute("DELETE FROM disk_attachments WHERE id=? AND account_id=?", (ident, uid))

    def download(self, uid: str, ident: str):
        uid, ident = _identifier(uid), _identifier(ident)
        now = int(time.time())
        with store.db() as db:
            row = db.execute(
                "SELECT filename,size,created,expires,direction"
                " FROM disk_attachments WHERE id=? AND account_id=?",
                (ident, uid)).fetchone()
        if not row or row[3] <= now or row[4] != "incoming":
            raise ValueError("附件不存在或已超过 7 天")
        name = store.decrypt(row[0]).decode("utf-8")
        size = row[1]
        if not 1 <= size <= MAX_FILE:
            raise ValueError("附件大小无效")

        def chunks():
            path = self.folder(uid, ident)
            for index in range((size + BLOCK - 1) // BLOCK):
                clear = store.decrypt((path / f"{index:08x}.bin").read_bytes())
                expected = min(BLOCK, size - index * BLOCK)
                if len(clear) != expected:
                    raise ValueError("附件分块损坏")
                yield clear

        return name, size, chunks()

    def expire(self):
        now = int(time.time())
        with store.db() as db:
            expired = db.execute(
                "SELECT account_id,id FROM disk_attachments WHERE expires<=?", (now,)
            ).fetchall()
        deleted = 0
        for uid, ident in expired:
            try:
                self.discard(uid, ident)
                deleted += 1
            except OSError:
                # If filesystem deletion fails, keep the database row for retry.
                continue
        # Clean abandoned uploads and interrupted transfers without an index.
        # Do not delete any newly created/active transfer folder.
        threshold = now - TTL
        for account in self.root.iterdir():
            if not account.is_dir() or not _HEX32.fullmatch(account.name):
                continue
            for folder in account.iterdir():
                if not folder.is_dir() or not _HEX32.fullmatch(folder.name):
                    continue
                try:
                    if folder.stat().st_mtime < threshold:
                        with store.db() as db:
                            row = db.execute(
                                "SELECT expires FROM disk_attachments"
                                " WHERE id=? AND account_id=?",
                                (folder.name, account.name)).fetchone()
                        if row is None or row[0] <= now:
                            self.discard(account.name, folder.name)
                except OSError:
                    continue
        return deleted
