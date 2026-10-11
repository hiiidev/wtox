"""Antidote/TRIfA extended Tox MessageV3 compatibility."""
import ctypes as C
import unittest

from backend.tox_message import decode_tox_message
from backend.tox_runtime import ToxSession


class AntidoteMessageTests(unittest.TestCase):
    def test_plain_utf8_and_action_are_unchanged(self):
        raw="你好 🧪 Antidote".encode("utf-8")
        self.assertEqual(decode_tox_message(raw,0),"你好 🧪 Antidote")
        self.assertEqual(decode_tox_message(raw,1),"你好 🧪 Antidote")

    def test_message_v3_trailer_removed(self):
        body="发自 Antidote 🚀".encode("utf-8")
        wire=body+b"\x00\x00"+bytes(range(32))+(1723456789).to_bytes(4,"little")
        self.assertEqual(decode_tox_message(wire,0),"发自 Antidote 🚀")
        self.assertEqual(decode_tox_message(wire,1),"发自 Antidote 🚀")

    def test_no_metadata_does_not_truncate(self):
        wire=b"abc\x00\x00"+bytes(range(32))+b"other"  # 5 bytes, not a 4-byte ts
        self.assertEqual(decode_tox_message(wire),wire.decode("utf-8","replace"))
        self.assertEqual(decode_tox_message(b"abc\x00\x00"),"abc\x00\x00")

    def test_v3_ack_is_not_visible_chat(self):
        self.assertIsNone(decode_tox_message(b"_\x00\x00"+bytes(32)+bytes(4),3))

    def test_native_callback_shows_only_message_text(self):
        session=object.__new__(ToxSession)
        events=[]
        session._emit=events.append
        session._friend_key=lambda number:"AB"*32
        text="测试 Antidote ✨"
        raw=text.encode()+b"\x00\x00"+bytes(range(32))+bytes(4)
        buffer=C.create_string_buffer(raw)
        session._on_message(None,3,0,buffer,len(raw),None)
        self.assertEqual(events[0]["text"],text)
        self.assertEqual(events[0]["public_key"],"AB"*32)
        session._on_message(None,3,3,buffer,len(raw),None)
        self.assertEqual(len(events),1)


if __name__=="__main__":
    unittest.main()
