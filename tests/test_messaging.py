"""Send error 3 means the peer is offline; never claim a message was sent."""
import ctypes as C
import threading
import unittest
from unittest.mock import Mock

from backend.tox_runtime import FriendOfflineError, ToxSession


class NativeMessagingTests(unittest.TestCase):
    def make_session(self, connection_status=0, send_error=0):
        s = object.__new__(ToxSession)
        s.lock = threading.RLock()
        s.tox = object()
        s.stop_event = threading.Event()
        s._require_live = lambda: None
        s.friend_by_key = lambda *_: 7
        s.friend_connection = lambda *_: connection_status

        def native_send(_tox, _number, _kind, _buf, _length, error):
            C.cast(error, C.POINTER(C.c_int)).contents.value = send_error
            return 99

        s.friend_send = Mock(side_effect=native_send)
        return s

    def test_offline_peer_is_not_sent_to(self):
        s = self.make_session(connection_status=0)
        with self.assertRaises(FriendOfflineError) as err:
            s.send_message("AB" * 32, "你好")
        self.assertIn("离线", str(err.exception))
        s.friend_send.assert_not_called()

    def test_online_friend_sends_message(self):
        s = self.make_session(connection_status=2)
        self.assertEqual(s.send_message("AB" * 32, "你好"), 99)
        s.friend_send.assert_called_once()

    def test_disconnect_race_maps_native_error_three(self):
        s = self.make_session(connection_status=1, send_error=3)
        with self.assertRaises(FriendOfflineError) as err:
            s.send_message("AB" * 32, "hello")
        self.assertIn("未发送", str(err.exception))

    def test_native_receipt_emits_read_with_matching_session(self):
        s = self.make_session(connection_status=1)
        events = []
        s._emit = events.append
        s._friend_key = lambda friend: "AB" * 32
        s.session_id = "cafe" * 8
        s._on_read_receipt(None, 7, 99, None)
        self.assertEqual(events, [{
            "type": "message_receipt",
            "public_key": "AB" * 32,
            "session_id": "cafe" * 8,
            "message_id": 99,
            "status": "read",
        }])

    def test_receipt_marks_protocol_read_but_not_human_read(self):
        s = self.make_session(connection_status=1)
        events = []
        s._emit = events.append
        s._friend_key = lambda friend: "AB" * 32
        s.session_id = "cafe" * 8
        s._on_read_receipt(None, 7, 101, None)
        self.assertEqual(events[0]["type"], "message_receipt")
        self.assertEqual(events[0]["status"], "read")
        self.assertNotIn("human_read", events[0])

    def test_text_limits_reject_before_native(self):
        s = self.make_session(connection_status=1)
        with self.assertRaises(ValueError):
            s.send_message("AB" * 32, "")
        with self.assertRaises(ValueError):
            s.send_message("AB" * 32, "字" * 400)
        s.friend_send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
