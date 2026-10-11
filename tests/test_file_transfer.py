"""File transfer validation and native callback lifecycle unit tests."""
import ctypes as C
import threading
import unittest
from types import SimpleNamespace

from backend.file_transfer import FileTransfers, MAX_FILE, U8, safe_filename


class FileTransferTests(unittest.TestCase):
    def setUp(self):
        events=[]
        tox=SimpleNamespace(
            lock=threading.RLock(), tox=object(), _require_live=lambda:None,
            _friend_key=lambda friend:"AB"*32,
            _emit=lambda e:events.append(e),
            friend_by_key=lambda *_: 7,
            friend_connection=lambda *_: 0
        )
        self.events=events
        self.transfers=object.__new__(FileTransfers)
        self.transfers.session=tox
        self.transfers.items={}
        self.controls=[]
        def control(_tox,friend,file_number,command,error):
            self.controls.append((friend,file_number,command))
            C.cast(error,C.POINTER(C.c_int)).contents.value=0
            return True
        self.transfers.control_native=control

    def test_sanitize_remote_filename(self):
        self.assertEqual(safe_filename("../../evil.txt"),"evil.txt")
        self.assertEqual(safe_filename("folder\\name.pdf"),"name.pdf")
        with self.assertRaises(ValueError):
            safe_filename("../")
        with self.assertRaises(ValueError):
            safe_filename("a"*250)

    def test_incoming_offer_consent_chunk_and_download(self):
        raw=b"file.bin"
        name=(U8*len(raw)).from_buffer_copy(raw)
        self.transfers._on_receive(None,7,5,0,4,name,len(raw),None)
        self.assertEqual(len(self.transfers.items),1)
        item=next(iter(self.transfers.items.values()))
        self.assertEqual(item.state,"offered")
        self.assertIsNone(item.payload)
        self.transfers.control(item.id,True)
        self.assertEqual(self.controls,[(7,5,0)])
        chunk=(U8*4).from_buffer_copy(b"test")
        self.transfers._on_receive_chunk(None,7,5,0,chunk,4,None)
        self.transfers._on_receive_chunk(None,7,5,4,None,0,None)
        self.assertEqual(self.transfers.download(item.id),("file.bin",b"test"))
        self.assertTrue(any(e["state"]=="completed" for e in self.events))

    def test_reject_oversize_and_filename(self):
        name=(U8*4).from_buffer_copy(b"file")
        self.transfers._on_receive(None,3,4,0,MAX_FILE+1,name,4,None)
        self.assertEqual(self.transfers.items,{})
        self.assertEqual(self.controls,[(3,4,2)])

    def test_reject_offer_does_not_allocate(self):
        raw=b"reject.txt"
        name=(U8*len(raw)).from_buffer_copy(raw)
        self.transfers._on_receive(None,7,5,0,1024,name,len(raw),None)
        item=next(iter(self.transfers.items.values()))
        self.transfers.control(item.id,False)
        self.assertIsNone(item.payload)
        self.assertEqual(item.state,"cancelled")
        with self.assertRaises(ValueError):
            self.transfers.download(item.id)

    def test_offline_send_refuses_native_transfer(self):
        with self.assertRaises(ValueError):
            self.transfers.send("AB"*32,"hello.bin",b"x")


if __name__=="__main__":
    unittest.main()
