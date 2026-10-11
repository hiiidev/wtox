"""Optional seven-day WebDAV store for AES-GCM encrypted Tox attachments.

Archive is isolated per Tox account, requires a configured HTTPS DAV URL,
does not expose WebDAV credentials or private filenames to the remote host,
and never follows redirects to attacker-controlled hosts.
"""
from __future__ import annotations

import base64
import os
import time
import urllib.error
import urllib.parse
import urllib.request

from . import store

TTL_SECONDS = 7 * 86400
MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_ENCRYPTED_BYTES = MAX_FILE_BYTES + 128
TIMEOUT_SECONDS = 12


class WebDavArchive:
    def __init__(self):
        uri = os.environ.get("WTOX_WEBDAV_URL", "").strip()
        self.enabled = bool(uri)
        if not self.enabled:
            self.root = ""
            self.auth = ""
            return
        parsed = urllib.parse.urlsplit(uri)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username or
                parsed.password or parsed.query or parsed.fragment):
            raise ValueError("WTOX_WEBDAV_URL 必须使用 HTTPS，且不得包含认证或查询参数")
        user = os.environ.get("WTOX_WEBDAV_USERNAME", "")
        password = os.environ.get("WTOX_WEBDAV_PASSWORD", "")
        if not user or not password or ":" in user:
            raise ValueError("WebDAV 已启用，请设置有效的用户名和密码")
        self.root = uri.rstrip("/") + "/"
        self.auth = "Basic " + base64.b64encode((user+":"+password).encode()).decode()
        self.opener = urllib.request.build_opener(_RejectRedirects)

    def _url(self, uid: str, transfer_id: str):
        if not (len(uid) == 32 and len(transfer_id) == 32 and
                all(ch in "0123456789abcdef" for ch in uid+transfer_id)):
            raise ValueError("WebDAV 附件标识无效")
        return self.root + uid + "-" + transfer_id + ".bin"

    def _request(self, method, url, data=None, max_bytes=None):
        req = urllib.request.Request(url, method=method, data=data, headers={
            "Authorization":self.auth,
            "Cache-Control":"no-store",
            "Content-Type":"application/octet-stream",
        })
        with self.opener.open(req, timeout=TIMEOUT_SECONDS) as response:
            if max_bytes is None:
                return b""
            result=response.read(max_bytes+1)
            if len(result)>max_bytes:
                raise ValueError("远程附件超过服务器允许大小")
            return result

    def put(self, uid: str, ident: str, name: str, data: bytes):
        if not self.enabled:
            return False
        if not isinstance(data,bytes) or not (1 <= len(data) <= MAX_FILE_BYTES):
            raise ValueError("附件不能超过 5 MiB")
        if not name or len(name.encode("utf-8")) > 220:
            raise ValueError("附件名称不合法")
        encrypted = store.encrypt(data)
        # The DAV server only receives an opaque random ID and ciphertext.
        self._request("PUT", self._url(uid, ident), encrypted)
        now=int(time.time())
        with store.db() as connection:
            connection.execute(
                "INSERT OR REPLACE INTO archived_attachments "
                "(id,account_id,filename,size,created,expires) VALUES(?,?,?,?,?,?)",
                (ident,uid,store.encrypt(name.encode("utf-8")),len(data),
                 now,now+TTL_SECONDS)
            )
        return True

    def get(self, uid: str, ident: str):
        if not self.enabled:
            return None
        with store.db() as connection:
            item=connection.execute(
                "SELECT filename,size,expires FROM archived_attachments "
                "WHERE account_id=? AND id=?", (uid,ident)
            ).fetchone()
        if not item:
            return None
        filename,size,expires=item
        if expires<=time.time():
            # Refuse an expired download even if WebDAV DELETE is temporarily down.
            return None
        ciphertext=self._request("GET",self._url(uid,ident),max_bytes=MAX_ENCRYPTED_BYTES)
        decoded=store.decrypt(ciphertext)
        if len(decoded)!=size:
            raise ValueError("附件完整性或长度验证失败")
        return store.decrypt(filename).decode("utf-8"),decoded

    def expire(self):
        """Delete expired ciphertext from DAV; retry failures at next sweep."""
        if not self.enabled:
            return 0
        with store.db() as connection:
            rows=connection.execute(
                "SELECT account_id,id FROM archived_attachments WHERE expires<=?",
                (int(time.time()),)
            ).fetchall()
        deleted=0
        for uid,ident in rows:
            try:
                self._request("DELETE", self._url(uid,ident))
            except urllib.error.HTTPError as error:
                if error.code!=404:
                    continue
            except (OSError,ValueError):
                continue
            with store.db() as connection:
                connection.execute(
                    "DELETE FROM archived_attachments WHERE id=? AND account_id=?",
                    (ident,uid)
                )
            deleted+=1
        return deleted


class _RejectRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None
