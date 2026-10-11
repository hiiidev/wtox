"""Small verified ctypes adapter for raw Tox savedata (not an online Tox client).

The native library generates/validates identity data; no reimplementation of crypto.
ABI references: TokTok/c-toxcore toxcore/tox.h and tox_options.h.
"""
from __future__ import annotations

import ctypes as C
import ctypes.util
import hashlib
import os
from dataclasses import dataclass

MAX_SAVEDATA = 8 * 1024 * 1024
ADDRESS_BYTES = 38
TOX_SAVEDATA_TYPE_TOX_SAVE = 1

class ToxIdentityError(ValueError):
    pass

@dataclass(frozen=True)
class Identity:
    address: str
    savedata: bytes
    secret_proof: bytes  # SHA-256 commitment to native Tox secret key, never raw secret

class ToxCore:
    def __init__(self, library=None):
        if library is None:
            name = os.environ.get("WTOX_TOXCORE_LIBRARY") or ctypes.util.find_library("toxcore") or "libtoxcore.so"
            library = C.CDLL(name)
        self.lib = library
        ptr = C.c_void_p
        err = C.POINTER(C.c_int)
        buf = C.POINTER(C.c_uint8)
        self.options_new = self._fn("tox_options_new", ptr, err)
        self.options_free = self._fn("tox_options_free", None, ptr)
        self.set_savedata_type = self._fn("tox_options_set_savedata_type", None, ptr, C.c_int)
        # Important: this setter returns bool (not void) on current c-toxcore.
        self.set_savedata_data = self._fn("tox_options_set_savedata_data", C.c_bool, ptr, buf, C.c_size_t)
        self.new = self._fn("tox_new", ptr, ptr, err)
        self.kill = self._fn("tox_kill", None, ptr)
        self.address = self._fn("tox_self_get_address", None, ptr, buf)
        self.secret_key = self._fn("tox_self_get_secret_key", None, ptr, buf)
        self.savedata_size = self._fn("tox_get_savedata_size", C.c_size_t, ptr)
        self.savedata_write = self._fn("tox_get_savedata", None, ptr, buf)
        self.set_name = self._fn("tox_self_set_name", C.c_bool, ptr, buf, C.c_size_t, err)
        self.set_status_message = self._fn("tox_self_set_status_message", C.c_bool,
                                           ptr, buf, C.c_size_t, err)

    def _fn(self, name, result, *args):
        fn = getattr(self.lib, name)
        fn.restype = result
        fn.argtypes = list(args)
        return fn

    def identity(self, savedata: bytes | None = None, nickname: str | None = None,
                 status_message: str | None = None) -> Identity:
        if savedata is not None and not (1 <= len(savedata) <= MAX_SAVEDATA):
            raise ToxIdentityError("配置文件为空或超过 8 MiB")
        error = C.c_int()
        opts = self.options_new(C.byref(error))
        if not opts or error.value:
            raise RuntimeError(f"tox_options_new failed: {error.value}")
        tox = None
        try:
            if savedata is not None:
                # Keep the buffer alive until tox_new has consumed the options.
                in_buffer = (C.c_uint8 * len(savedata)).from_buffer_copy(savedata)
                self.set_savedata_type(opts, TOX_SAVEDATA_TYPE_TOX_SAVE)
                if not self.set_savedata_data(opts, in_buffer, len(savedata)):
                    raise ToxIdentityError("无法设置 Tox 配置数据")
            error.value = 0
            tox = self.new(opts, C.byref(error))
            if not tox or error.value:
                if savedata is not None:
                    raise ToxIdentityError(f"配置不是有效的原始 Tox Savedata（错误码 {error.value}）")
                raise RuntimeError(f"tox_new failed: {error.value}")
            if savedata is None and nickname:
                encoded_name = nickname.encode("utf-8")
                if len(encoded_name) > 128:
                    raise ToxIdentityError("昵称过长")
                name_buf = (C.c_uint8 * len(encoded_name)).from_buffer_copy(encoded_name)
                error.value = 0
                if not self.set_name(tox, name_buf, len(encoded_name), C.byref(error)):
                    raise ToxIdentityError(f"设置 Tox 昵称失败 ({error.value})")
            if savedata is None and status_message is not None:
                encoded_status = status_message.encode("utf-8")
                if len(encoded_status) > 1007:
                    raise ToxIdentityError("状态消息超过 Tox 限制（1007 字节）")
                status_buffer = (C.c_uint8 * len(encoded_status)).from_buffer_copy(encoded_status)
                error.value = 0
                if not self.set_status_message(tox, status_buffer, len(encoded_status), C.byref(error)):
                    raise ToxIdentityError(f"设置 Tox 状态消息失败 ({error.value})")
            address_buf = (C.c_uint8 * ADDRESS_BYTES)()
            self.address(tox, address_buf)
            address = bytes(address_buf).hex().upper()
            size = self.savedata_size(tox)
            if not 1 <= size <= MAX_SAVEDATA:
                raise ToxIdentityError("生成的 Tox 配置大小无效")
            out_buffer = (C.c_uint8 * size)()
            self.savedata_write(tox, out_buffer)
            secret = (C.c_uint8 * 32)()
            self.secret_key(tox, secret)
            proof = hashlib.sha256(b"wtox-tox-identity-secret-v1:" + bytes(secret)).digest()
            return Identity(address=address, savedata=bytes(out_buffer), secret_proof=proof)
        finally:
            if tox:
                self.kill(tox)
            self.options_free(opts)

def smoke_test():
    core = ToxCore()
    first = core.identity()
    second = core.identity(first.savedata)
    assert len(first.address) == 76
    assert first.address == second.address
    assert len(second.savedata) > 0
    print("native c-toxcore identity create/restore smoke test OK")

if __name__ == "__main__":
    smoke_test()
