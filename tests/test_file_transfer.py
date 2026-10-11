"""File transfer validation and native callback lifecycle unit tests."""
import ctypes as C
import os
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from backend import store
from backend.attachment_disk import DiskAttachmentStore
from backend.file_transfer import FileTransfers, MAX_FILE, U8, safe_filename


class FileTransferTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.env=patch.dict(os.environ,{"WTOX_DATA_DIR":self.temp.name,
                                        "WTOX_MASTER_KEY":"42"*32})
        self.env.start()
        store.init()
        self.uid=store.create_tox_identity(SimpleNamespace(
            address="A"*76,secret_proof=b"a"*32,savedata=b"native-test-data"))
        self.disk=DiskAttachmentStore()
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
        self.transfers.disk=self.disk
        self.transfers.uid=self.uid
        self.transfers.should_auto_accept=lambda:False
        self.controls=[]
        def control(_tox,friend,file_number,command,error):
            self.controls.append((friend,file_number,command))
            C.cast(error,C.POINTER(C.c_int)).contents.value=0
            return True
        self.transfers.control_native=control

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

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
        self.assertIsNone(item.document)
        self.transfers.control(item.id,True)
        self.assertEqual(self.controls,[(7,5,0)])
        chunk=(U8*4).from_buffer_copy(b"test")
        self.transfers._on_receive_chunk(None,7,5,0,chunk,4,None)
        self.transfers._on_receive_chunk(None,7,5,4,None,0,None)
        self.assertEqual(self.transfers.download(item.id),("file.bin",b"test"))
        self.assertTrue(any(e["state"]=="completed" for e in self.events))

    def test_offline_browser_auto_receives_and_persists_in_inbox(self):
        self.transfers.should_auto_accept=lambda:True
        raw=b"offline-photo.jpg"
        name=(U8*len(raw)).from_buffer_copy(raw)
        self.transfers._on_receive(None,7,6,0,5,name,len(raw),None)
        item=next(iter(self.transfers.items.values()))
        self.assertEqual(item.state,"receiving")
        self.assertEqual(self.controls,[(7,6,0)])
        payload=(U8*5).from_buffer_copy(b"photo")
        self.transfers._on_receive_chunk(None,7,6,0,payload,5,None)
        self.transfers._on_receive_chunk(None,7,6,5,None,0,None)
        self.assertEqual(item.state,"completed")
        # The browser can reopen after the in-memory Tox transfer is gone.
        self.transfers.items.clear()
        listing=self.transfers.list()
        self.assertEqual(len(listing),1)
        self.assertEqual(listing[0]["id"],item.id)
        self.assertEqual(listing[0]["public_key"],"AB"*32)
        self.assertEqual(listing[0]["state"],"completed")
        self.assertEqual(listing[0]["progress"],5)
        self.assertEqual(self.disk.download(self.uid,item.id)[1],5)

    def test_auto_receive_rejects_unavailable_disk(self):
        self.transfers.should_auto_accept=lambda:True
        self.transfers.disk=None
        raw=b"missing.bin"
        name=(U8*len(raw)).from_buffer_copy(raw)
        self.transfers._on_receive(None,7,8,0,4,name,len(raw),None)
        self.assertEqual(self.transfers.items,{})
        self.assertEqual(self.controls,[(7,8,2)])

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
        self.assertIsNone(item.document)
        self.assertEqual(item.state,"cancelled")
        with self.assertRaises(ValueError):
            self.transfers.download(item.id)

    def test_offline_send_refuses_native_transfer(self):
        with self.assertRaises(ValueError):
            self.transfers.send("AB"*32,"hello.bin",b"x")


if __name__=="__main__":
    unittest.main()
