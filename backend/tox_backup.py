"""Portable encrypted .tox backups using the native ToxEncryptSave ABI."""
from __future__ import annotations

import ctypes as C
import ctypes.util
import os

from .tox_identity import MAX_SAVEDATA, ToxIdentityError

OVERHEAD = 80
MAGIC = b"toxEsave"


def _api():
    name = os.environ.get("WTOX_TOXCORE_LIBRARY") or ctypes.util.find_library("toxcore") or "libtoxcore.so"
    library = C.CDLL(name)
    pointer = C.POINTER(C.c_uint8)
    encrypt = library.tox_pass_encrypt
    encrypt.argtypes = [pointer, C.c_size_t, pointer, C.c_size_t, pointer, C.POINTER(C.c_int)]
    encrypt.restype = C.c_bool
    decrypt = library.tox_pass_decrypt
    decrypt.argtypes = [pointer, C.c_size_t, pointer, C.c_size_t, pointer, C.POINTER(C.c_int)]
    decrypt.restype = C.c_bool
    return encrypt, decrypt


def is_encrypted(data: bytes) -> bool:
    return len(data) >= OVERHEAD and data.startswith(MAGIC)


def _buffer(data: bytes):
    return (C.c_uint8 * len(data)).from_buffer_copy(data)


def encrypt_savedata(savedata: bytes, password: str) -> bytes:
    if not isinstance(password, str) or not password:
        raise ToxIdentityError("请设置备份密码")
    if not savedata or len(savedata) > MAX_SAVEDATA:
        raise ToxIdentityError("无效 Tox 配置大小")
    plain = _buffer(savedata)
    secret = password.encode("utf-8")
    phrase = _buffer(secret)
    output = (C.c_uint8 * (len(savedata) + OVERHEAD))()
    error = C.c_int()
    encrypt, _ = _api()
    if not encrypt(plain, len(savedata), phrase, len(secret), output, C.byref(error)):
        raise ToxIdentityError(f"ToxEncryptSave 加密失败（错误码 {error.value}）")
    return bytes(output)


def decrypt_savedata(savedata: bytes, password: str | None) -> bytes:
    if not is_encrypted(savedata):
        return savedata
    if not password:
        raise ToxIdentityError("这个 .tox 文件已加密，请填写备份密码")
    if len(savedata) <= OVERHEAD or len(savedata) > MAX_SAVEDATA + OVERHEAD:
        raise ToxIdentityError("加密 Tox 配置大小无效")
    ciphertext = _buffer(savedata)
    secret = password.encode("utf-8")
    phrase = _buffer(secret)
    output = (C.c_uint8 * (len(savedata) - OVERHEAD))()
    error = C.c_int()
    _, decrypt = _api()
    if not decrypt(ciphertext, len(savedata), phrase, len(secret), output, C.byref(error)):
        raise ToxIdentityError("解密失败：密码不正确或 .tox 文件已损坏")
    return bytes(output)
