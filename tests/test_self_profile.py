"""Self-profile setters use real Tox ABI bounds and trigger savedata persist."""
import ctypes as C
import threading
import unittest
from unittest.mock import Mock

from backend.tox_runtime import ToxSession


class SelfProfileTests(unittest.TestCase):
    def setUp(self):
        self.s=object.__new__(ToxSession)
        self.s.lock=threading.RLock()
        self.s.tox=object()
        self.s._require_live=lambda:None
        self.s._save=Mock()
        self.state={"name":b"Initial","status_message":b"Ready","user_status":0}

        self.s.get_name_size=lambda tox:len(self.state["name"])
        self.s.get_status_message_size=lambda tox:len(self.state["status_message"])

        def copy_text(field,buf):
            data=self.state[field]
            for i,value in enumerate(data):
                buf[i]=value
        self.s.get_name=lambda tox,buf:copy_text("name",buf)
        self.s.get_status_message=lambda tox,buf:copy_text("status_message",buf)
        self.s.get_user_status=lambda tox:self.state["user_status"]

        def change(field,ptr,length,err):
            self.state[field]=C.string_at(ptr,length)
            C.cast(err,C.POINTER(C.c_int)).contents.value=0
            return True
        self.s.set_name_native=lambda tox,ptr,length,err:change("name",ptr,length,err)
        self.s.set_status_message_native=lambda tox,ptr,length,err:change(
            "status_message",ptr,length,err)
        self.s.set_user_status_native=lambda tox,value:self.state.__setitem__(
            "user_status",value)

    def test_read_existing_tox_identity_profile(self):
        self.assertEqual(self.s.self_profile(),{
            "name":"Initial","status_message":"Ready","user_status":0})

    def test_save_utf8_tox_profile(self):
        result=self.s.update_self_profile("小明","正在忙碌",2)
        self.assertEqual(result,{"name":"小明","status_message":"正在忙碌",
                                "user_status":2})
        self.s._save.assert_called_once()

    def test_status_bounds(self):
        for number in (-1,3):
            with self.assertRaises(ValueError):
                self.s.update_self_profile("User","status",number)
        self.s._save.assert_not_called()

    def test_utf8_byte_bounds(self):
        with self.assertRaises(ValueError):
            self.s.update_self_profile("你"*43,"",0)  # 129 bytes, not chars
        with self.assertRaises(ValueError):
            self.s.update_self_profile("Me","x"*1008,0)
        self.s._save.assert_not_called()


if __name__=="__main__":
    unittest.main()
