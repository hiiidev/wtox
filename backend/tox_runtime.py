"""Live one-Tox-instance-per-profile adapter.

All native calls for each session are protected by the same RLock; callbacks
never reach user-owned browser code directly. Compatible with c-toxcore's
non-experimental callback API. Real network interoperability requires VPS test.
"""
from __future__ import annotations

import ctypes as C
import os
import threading
import time
import uuid
from typing import Callable

from .tox_identity import ToxCore, ToxIdentityError
from .file_transfer import FileTransfers
from .tox_message import decode_tox_message

U8 = C.c_uint8
U32 = C.c_uint32
P = C.c_void_p
IP = C.POINTER(U8)
ERR = C.POINTER(C.c_int)

FriendRequestCB = C.CFUNCTYPE(None, P, IP, IP, C.c_size_t, P)
FriendMessageCB = C.CFUNCTYPE(None, P, U32, C.c_int, IP, C.c_size_t, P)
FriendStatusCB = C.CFUNCTYPE(None, P, U32, C.c_int, P)
SelfStatusCB = C.CFUNCTYPE(None, P, C.c_int, P)
FriendReceiptCB = C.CFUNCTYPE(None, P, U32, U32, P)


class ToxActionError(Exception):
    pass


class FriendOfflineError(ToxActionError):
    """Tox error 3: friend is offline or not yet mutually connected."""
    pass


def hex_bytes(value: str, expected: int, label: str) -> bytes:
    if len(value) != expected * 2:
        raise ValueError(f"{label}必须为 {expected * 2} 个十六进制字符")
    try:
        data = bytes.fromhex(value)
    except ValueError as exc:
        raise ValueError(f"{label}不是有效的十六进制") from exc
    if len(data) != expected:
        raise ValueError(f"{label}长度错误")
    return data


def uint8_array(data: bytes):
    return (U8 * len(data)).from_buffer_copy(data)


class ToxSession:
    """A single native Tox identity. Do not instantiate twice per ID."""

    def __init__(self, savedata: bytes, on_event: Callable[[dict], None],
                 on_save: Callable[[bytes], None]):
        if not savedata:
            raise ValueError("missing Tox savedata")
        self.core = ToxCore()
        lib = self.core
        self._on_event = on_event
        self._on_save = on_save
        self.lock = threading.RLock()
        self.stop_event = threading.Event()
        self.thread = None
        self.tox = None
        # Message counters can restart with native session; receipt matching
        # must include this instance-specific ID.
        self.session_id = uuid.uuid4().hex
        self.last_connection = -1
        self._last_save = time.monotonic()
        self._last_bootstrap = 0.0
        self._dirty = False
        self._install_native_functions()

        error = C.c_int()
        opts = lib.options_new(C.byref(error))
        if not opts or error.value:
            raise ToxActionError(f"tox_options_new failed ({error.value})")
        try:
            save_buffer = uint8_array(savedata)
            lib.set_savedata_type(opts, 1)  # TOX_SAVEDATA_TYPE_TOX_SAVE
            if not lib.set_savedata_data(opts, save_buffer, len(savedata)):
                raise ToxActionError("tox_options_set_savedata_data failed")
            error.value = 0
            self.tox = lib.new(opts, C.byref(error))
            if not self.tox or error.value:
                raise ToxActionError(f"tox_new with savedata failed ({error.value})")
        finally:
            lib.options_free(opts)

        # Strong references: ctypes callbacks must not be garbage collected.
        self._request_cb = FriendRequestCB(self._on_request)
        self._message_cb = FriendMessageCB(self._on_message)
        self._friend_status_cb = FriendStatusCB(self._on_friend_status)
        self._self_status_cb = SelfStatusCB(self._on_self_status)
        self._receipt_cb = FriendReceiptCB(self._on_read_receipt)
        self.callback_request(self.tox, self._request_cb)
        self.callback_message(self.tox, self._message_cb)
        self.callback_friend_status(self.tox, self._friend_status_cb)
        self.callback_self_status(self.tox, self._self_status_cb)
        self.callback_read_receipt(self.tox, self._receipt_cb)
        self.files = FileTransfers(self)
        self.files.attach()

    def _install_native_functions(self):
        bind = self.core._fn
        self.iterate = bind("tox_iterate", None, P, P)
        self.interval = bind("tox_iteration_interval", U32, P)
        self.self_status = bind("tox_self_get_connection_status", C.c_int, P)
        self.bootstrap_native = bind("tox_bootstrap", C.c_bool, P, C.c_char_p, C.c_uint16, IP, ERR)
        self.relay_native = bind("tox_add_tcp_relay", C.c_bool, P, C.c_char_p, C.c_uint16, IP, ERR)
        self.callback_request = bind("tox_callback_friend_request", None, P, FriendRequestCB)
        self.callback_message = bind("tox_callback_friend_message", None, P, FriendMessageCB)
        self.callback_friend_status = bind("tox_callback_friend_connection_status", None, P, FriendStatusCB)
        self.callback_self_status = bind("tox_callback_self_connection_status", None, P, SelfStatusCB)
        self.callback_read_receipt = bind("tox_callback_friend_read_receipt", None, P, FriendReceiptCB)
        self.friend_add = bind("tox_friend_add", U32, P, IP, IP, C.c_size_t, ERR)
        self.friend_accept = bind("tox_friend_add_norequest", U32, P, IP, ERR)
        self.friend_by_key = bind("tox_friend_by_public_key", U32, P, IP, ERR)
        self.friend_delete_native = bind("tox_friend_delete", C.c_bool, P, U32, ERR)
        self.friend_send = bind("tox_friend_send_message", U32, P, U32, C.c_int, IP, C.c_size_t, ERR)
        self.friend_list_size = bind("tox_self_get_friend_list_size", C.c_size_t, P)
        self.friend_list = bind("tox_self_get_friend_list", None, P, C.POINTER(U32))
        self.friend_public_key = bind("tox_friend_get_public_key", C.c_bool, P, U32, IP, ERR)
        self.friend_connection = bind("tox_friend_get_connection_status", C.c_int, P, U32, ERR)
        self.friend_name_size = bind("tox_friend_get_name_size", C.c_size_t, P, U32, ERR)
        self.friend_name = bind("tox_friend_get_name", C.c_bool, P, U32, IP, ERR)
        self.friend_status_message_size = bind("tox_friend_get_status_message_size",
                                               C.c_size_t, P, U32, ERR)
        self.friend_status_message = bind("tox_friend_get_status_message",
                                          C.c_bool, P, U32, IP, ERR)
        self.friend_user_status = bind("tox_friend_get_status", C.c_int, P, U32, ERR)
        self.get_name_size = bind("tox_self_get_name_size", C.c_size_t, P)
        self.get_name = bind("tox_self_get_name", None, P, IP)
        self.set_name_native = bind("tox_self_set_name", C.c_bool, P, IP, C.c_size_t, ERR)
        self.get_status_message_size = bind("tox_self_get_status_message_size", C.c_size_t, P)
        self.get_status_message = bind("tox_self_get_status_message", None, P, IP)
        self.set_status_message_native = bind("tox_self_set_status_message", C.c_bool, P, IP, C.c_size_t, ERR)
        self.get_user_status = bind("tox_self_get_status", C.c_int, P)
        self.set_user_status_native = bind("tox_self_set_status", None, P, C.c_int)

    def _emit(self, event: dict):
        try:
            self._on_event(event)
        except Exception as exc:
            # Never let Python exceptions escape a native callback.
            print("Tox event persistence/delivery failed:", type(exc).__name__, flush=True)

    def _friend_key(self, friend: int) -> str:
        key = (U8 * 32)()
        error = C.c_int()
        ok = self.friend_public_key(self.tox, friend, key, C.byref(error))
        if not ok or error.value:
            raise ToxActionError(f"Cannot read friend public key ({error.value})")
        return bytes(key).hex().upper()

    def _on_request(self, _tox, pubkey, message, length, _user):
        self._emit({"type": "friend_request",
                    "public_key": C.string_at(pubkey, 32).hex().upper(),
                    "text": C.string_at(message, length).decode("utf-8", "replace")})

    def _on_message(self, _tox, friend, kind, data, length, _user):
        try:
            public_key = self._friend_key(friend)
            text = decode_tox_message(C.string_at(data, length), int(kind))
            if text is not None:
                self._emit({"type": "message", "public_key": public_key,
                            "text": text, "kind": int(kind)})
        except Exception as exc:
            print("Tox message callback failed:", type(exc).__name__, flush=True)

    def _on_read_receipt(self, _tox, friend, message_id, _user):
        """Tox read-receipt callback: peer client ack, not proven human read."""
        try:
            self._emit({
                "type": "message_receipt",
                "public_key": self._friend_key(friend),
                "session_id": self.session_id,
                "message_id": int(message_id),
                "status": "delivered",
            })
        except Exception as exc:
            print("Tox receipt callback failed:", type(exc).__name__, flush=True)

    def _on_friend_status(self, _tox, friend, status, _user):
        try:
            if int(status) == 0:
                self.files.friend_disconnected(int(friend))
            self._emit({"type": "friend_connection", "public_key": self._friend_key(friend),
                        "status": int(status)})
        except Exception:
            pass

    def _on_self_status(self, _tox, status, _user):
        self.last_connection = int(status)
        self._emit({"type": "connection", "status": int(status)})

    def _save_bytes(self) -> bytes:
        n = self.core.savedata_size(self.tox)
        if n < 1 or n > 8 * 1024 * 1024:
            raise ToxActionError("Invalid savedata size")
        out = (U8 * n)()
        self.core.savedata_write(self.tox, out)
        return bytes(out)

    def _save(self):
        self._on_save(self._save_bytes())
        self._last_save = time.monotonic()
        self._dirty = False

    def _bootstrap(self):
        count = 0
        for entry in os.environ.get("WTOX_BOOTSTRAP", "").split(","):
            parts = entry.strip().split(":")
            if len(parts) not in (3, 4):
                continue
            try:
                hostname, port = parts[0], int(parts[1])
                key = hex_bytes(parts[2], 32, "Bootstrap key")
                if not hostname or not 1 <= port <= 65535:
                    continue
                error = C.c_int()
                key_array = uint8_array(key)
                if self.bootstrap_native(self.tox, hostname.encode("ascii"), port,
                                         key_array, C.byref(error)):
                    count += 1
                if len(parts) == 4:
                    self.relay_native(self.tox, hostname.encode("ascii"), int(parts[3]),
                                      key_array, C.byref(error))
            except (ValueError, UnicodeError):
                continue
        self._last_bootstrap = time.monotonic()
        if count == 0:
            print("Tox bootstrap: no accepted nodes; check WTOX_BOOTSTRAP", flush=True)

    def start(self):
        if self.thread is not None:
            return
        self.thread = threading.Thread(target=self._run, name="wtox-toxcore", daemon=True)
        self.thread.start()

    def _run(self):
        try:
            while not self.stop_event.is_set():
                with self.lock:
                    if time.monotonic() - self._last_bootstrap > 120 and self.last_connection <= 0:
                        self._bootstrap()
                    self.iterate(self.tox, None)
                    current = int(self.self_status(self.tox))
                    if current != self.last_connection:
                        self.last_connection = current
                        self._emit({"type": "connection", "status": current})
                    if self._dirty or time.monotonic() - self._last_save > 60:
                        self._save()
                    delay = min(0.25, max(0.01, self.interval(self.tox) / 1000.0))
                self.stop_event.wait(delay)
        except Exception as exc:
            print("Tox session loop stopped unexpectedly:", type(exc).__name__, flush=True)
        finally:
            with self.lock:
                try:
                    self._save()
                finally:
                    if self.tox:
                        self.core.kill(self.tox)
                        self.tox = None

    def close(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=10)
            if self.thread.is_alive():
                raise RuntimeError("Tox session did not stop cleanly")

    def _require_live(self):
        if self.tox is None or self.stop_event.is_set():
            raise ToxActionError("Tox session not running")

    def friends(self) -> list[dict]:
        with self.lock:
            self._require_live()
            n = self.friend_list_size(self.tox)
            if n > 100000:
                raise ToxActionError("Unreasonable friend list size")
            arr = (U32 * n)()
            self.friend_list(self.tox, arr)
            friends = []
            for number in arr:
                error = C.c_int()
                key = self._friend_key(number)
                name_len = self.friend_name_size(self.tox, number, C.byref(error))
                name = ""
                if error.value == 0 and 0 < name_len < 2048:
                    name_buf = (U8 * name_len)()
                    if self.friend_name(self.tox, number, name_buf, C.byref(error)):
                        name = bytes(name_buf).decode("utf-8", "replace")
                error.value = 0
                status = int(self.friend_connection(self.tox, number, C.byref(error)))
                # Tox keeps the last known status message and user status for
                # each friend; these differ from TCP/UDP connection state.
                error.value = 0
                message_len = int(self.friend_status_message_size(
                    self.tox, number, C.byref(error)))
                status_message = ""
                if error.value == 0 and 0 < message_len <= 1007:
                    message_buf = (U8 * message_len)()
                    error.value = 0
                    if self.friend_status_message(self.tox, number,
                                                  message_buf, C.byref(error)):
                        if error.value == 0:
                            status_message = bytes(message_buf).decode("utf-8", "replace")
                error.value = 0
                user_status = int(self.friend_user_status(self.tox, number,
                                                          C.byref(error)))
                if error.value != 0 or user_status not in (0,1,2):
                    user_status = 0
                friends.append({"public_key": key, "name": name,
                                "status": status, "status_message": status_message,
                                "user_status": user_status})
            return friends

    def self_profile(self) -> dict:
        """Public Tox profile metadata, read from the authoritative native session."""
        with self.lock:
            self._require_live()
            name_size = int(self.get_name_size(self.tox))
            message_size = int(self.get_status_message_size(self.tox))
            if not 0 <= name_size <= 128 or not 0 <= message_size <= 1007:
                raise ToxActionError("无效的 Tox 个人信息长度")
            name_buffer = (U8 * max(1,name_size))()
            message_buffer = (U8 * max(1,message_size))()
            if name_size:
                self.get_name(self.tox, name_buffer)
            if message_size:
                self.get_status_message(self.tox, message_buffer)
            return {
                "name": bytes(name_buffer[:name_size]).decode("utf-8","replace"),
                "status_message": bytes(message_buffer[:message_size]).decode("utf-8","replace"),
                "user_status": int(self.get_user_status(self.tox)),
            }

    def update_self_profile(self, name: str, status_message: str, user_status: int) -> dict:
        """Apply and immediately persist Tox-native nickname, message and status."""
        name_data = name.encode("utf-8")
        message_data = status_message.encode("utf-8")
        if len(name_data) > 128:
            raise ValueError("昵称超过 Tox 限制（128 字节）")
        if len(message_data) > 1007:
            raise ValueError("状态消息超过 Tox 限制（1007 字节）")
        if user_status not in (0,1,2):
            raise ValueError("状态只能为在线、离开或忙碌")
        with self.lock:
            self._require_live()
            err = C.c_int()
            if not self.set_name_native(self.tox,uint8_array(name_data),
                                        len(name_data),C.byref(err)) or err.value:
                raise ToxActionError(f"设置 Tox 昵称失败（{err.value}）")
            err.value = 0
            if not self.set_status_message_native(self.tox,uint8_array(message_data),
                                                   len(message_data),C.byref(err)) or err.value:
                # Nickname is already changed; save it and report an error.
                self._save()
                raise ToxActionError(f"设置状态消息失败（{err.value}）")
            self.set_user_status_native(self.tox,user_status)
            self._dirty = True
            self._save()
            return self.self_profile()

    def add_friend(self, address: str, request_text: str) -> str:
        raw_address = hex_bytes(address.strip(), 38, "Tox ID")
        text = request_text.encode("utf-8")
        if not 1 <= len(text) <= 256:
            raise ValueError("好友请求内容需为 1–256 字节")
        with self.lock:
            self._require_live()
            error = C.c_int()
            number = self.friend_add(self.tox, uint8_array(raw_address),
                                     uint8_array(text), len(text), C.byref(error))
            if error.value:
                raise ToxActionError(f"tox_friend_add error {error.value}")
            self._dirty = True
            self._save()
            return self._friend_key(number)

    def accept_friend(self, key: str) -> str:
        pubkey = hex_bytes(key.strip(), 32, "好友公钥")
        with self.lock:
            self._require_live()
            error = C.c_int()
            number = self.friend_accept(self.tox, uint8_array(pubkey), C.byref(error))
            if error.value:
                raise ToxActionError(f"tox_friend_add_norequest error {error.value}")
            self._dirty = True
            self._save()
            return self._friend_key(number)

    def delete_friend(self, key: str) -> None:
        pubkey = hex_bytes(key.strip(), 32, "好友公钥")
        with self.lock:
            self._require_live()
            error = C.c_int()
            number = self.friend_by_key(self.tox, uint8_array(pubkey), C.byref(error))
            if error.value:
                raise ValueError("未找到该好友")
            error.value = 0
            if not self.friend_delete_native(self.tox, number, C.byref(error)) or error.value:
                raise ToxActionError(f"tox_friend_delete error {error.value}")
            self._dirty = True
            self._save()

    def send_message(self, key: str, text: str) -> int:
        pubkey = hex_bytes(key.strip(), 32, "好友公钥").hex().upper()
        encoded = text.encode("utf-8")
        if not 1 <= len(encoded) <= 1000:
            raise ValueError("文字消息需为 1–1000 字节")
        with self.lock:
            self._require_live()
            error = C.c_int()
            number = self.friend_by_key(self.tox, uint8_array(bytes.fromhex(pubkey)), C.byref(error))
            if error.value:
                raise ValueError("好友不在列表中")
            error.value = 0
            status = int(self.friend_connection(self.tox, number, C.byref(error)))
            if error.value:
                raise ToxActionError(f"读取好友状态失败（{error.value}）")
            if status == 0:
                raise FriendOfflineError("好友目前离线或尚未接受请求，Tox 只支持向已连接的好友即时发消息。请等待对方上线后再发送。")
            error.value = 0
            msg_id = self.friend_send(self.tox, number, 0, uint8_array(encoded),
                                      len(encoded), C.byref(error))
            if error.value == 3:
                # Race: friend disconnected between the status check and send.
                raise FriendOfflineError("好友刚刚断开连接，消息未发送。请等待好友重新上线后重试。")
            if error.value:
                explanations = {
                    2: "好友不存在",
                    4: "Tox 发送队列已满，请稍后重试",
                    5: "消息超过长度限制",
                    6: "消息不能为空",
                }
                raise ToxActionError(explanations.get(error.value, f"Tox 发送失败（错误码 {error.value}）"))
            return int(msg_id)
