"""Peer Tox status message and available/away/busy are independent of connection."""
import ctypes as C
import threading
import unittest

from backend.tox_runtime import ToxSession


class NativeFriendMetadataTests(unittest.TestCase):
    def make_session(self):
        session=object.__new__(ToxSession)
        session.lock=threading.RLock()
        session.tox=object()
        session._require_live=lambda:None
        session.friend_list_size=lambda tox:1
        session.friend_list=lambda tox,array: array.__setitem__(0,7)
        session._friend_key=lambda number:"AB"*32
        session.friend_name_size=lambda tox,number,error:len("aTox 好友".encode("utf-8"))
        session.friend_status_message_size=lambda tox,number,error:len("正在路上".encode("utf-8"))
        session.friend_connection=lambda tox,number,error:2
        session.friend_user_status=lambda tox,number,error:1
        session.friend_last_online=lambda tox,number,error:1760000000

        def copy(data,buffer):
            for i,value in enumerate(data.encode("utf-8")):
                buffer[i]=value
            return True
        session.friend_name=lambda tox,number,buf,error:copy("aTox 好友",buf)
        session.friend_status_message=lambda tox,number,buf,error:copy("正在路上",buf)
        return session

    def test_nickname_message_and_status_from_native_friend(self):
        result=self.make_session().friends()
        self.assertEqual(result,[{
            "public_key":"AB"*32,
            "name":"aTox 好友",
            "status":2,
            "status_message":"正在路上",
            "user_status":1,
            "last_online":1760000000,
        }])

    def test_native_last_online_unavailable_is_not_fabricated(self):
        session=self.make_session()
        session.friend_last_online=lambda tox,number,error:0
        self.assertIsNone(session.friends()[0]["last_online"])

        def native_error(tox,number,error):
            C.cast(error,C.POINTER(C.c_int)).contents.value=1
            return 1760000000
        session.friend_last_online=native_error
        self.assertIsNone(session.friends()[0]["last_online"])

    def test_offline_connection_does_not_erase_cached_profile_status(self):
        session=self.make_session()
        session.friend_connection=lambda tox,number,error:0
        result=session.friends()[0]
        self.assertEqual(result["status"],0)
        self.assertEqual(result["status_message"],"正在路上")
        self.assertEqual(result["user_status"],1)


if __name__=="__main__":
    unittest.main()
