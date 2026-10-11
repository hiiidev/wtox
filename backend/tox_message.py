"""Decode interoperable Tox text, including Antidote/TRIfA MessageV3 trailers.

MessageV3 appends: two NUL separator bytes, 32-byte message ID, four-byte
timestamp. This metadata is not display text and should never be decoded as
UTF-8. The core callback still receives the full buffer unmodified.
"""
METADATA_SIZE = 2 + 32 + 4


def decode_tox_message(payload: bytes, kind: int = 0) -> str | None:
    """Return visible text, or None for a metadata-only high-level ACK.

    Ordinary Tox text and action messages are preserved exactly as sent.
    """
    if kind == 3:  # Fork-specific TOX_MESSAGE_TYPE_HIGH_LEVEL_ACK
        return None
    if len(payload) > METADATA_SIZE and payload[-METADATA_SIZE:-36] == b"\x00\x00":
        body = payload[:-METADATA_SIZE]
        if body and b"\x00" not in body:
            try:
                return body.decode("utf-8", "strict")
            except UnicodeDecodeError:
                pass
    return payload.decode("utf-8", "replace")
