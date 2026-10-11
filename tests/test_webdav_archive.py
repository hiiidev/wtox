"""WebDAV archive must upload only ciphertext and expire files after 7 days."""
import io
import os
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from backend import store
from backend.webdav_archive import WebDavArchive


class FakeDAV:
    def __init__(self):
        self.objects={}
        self.requests=[]

    def open(self, req, timeout=None):
        method=req.get_method()
        url=req.full_url
        self.requests.append((method,url,req.data))
        if method=="PUT":
            self.objects[url]=req.data
            return io.BytesIO(b"")
        if method=="GET":
            return io.BytesIO(self.objects[url])
        if method=="DELETE":
            del self.objects[url]
            return io.BytesIO(b"")
        raise AssertionError("unsupported method "+method)


class WebDavArchiveTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.env=patch.dict(os.environ,{
            "WTOX_DATA_DIR":self.tmp.name,
            "WTOX_MASTER_KEY":"ac"*32,
            "WTOX_WEBDAV_URL":"https://dav.example.test/wtox-folder/",
            "WTOX_WEBDAV_USERNAME":"test-user",
            "WTOX_WEBDAV_PASSWORD":"test-password",
        })
        self.env.start()
        store.init()
        self.uid=store.create_tox_identity(SimpleNamespace(
            address="A"*76,secret_proof=b"A"*32,savedata=b"native-tox-data"))
        self.other=store.create_tox_identity(SimpleNamespace(
            address="B"*76,secret_proof=b"B"*32,savedata=b"other-tox-data"))
        self.dav=FakeDAV()
        self.archive=WebDavArchive()
        self.archive.opener=self.dav
        self.ident="f"*32

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def test_encrypted_upload_and_identity_scoped_download(self):
        raw=b"PRIVATE Tox attachment bytes"
        self.assertTrue(self.archive.put(self.uid,self.ident,"photo.png",raw))
        stored=next(iter(self.dav.objects.values()))
        self.assertNotIn(raw,stored)
        self.assertNotIn(b"photo.png",stored)
        self.assertEqual(self.archive.get(self.uid,self.ident),("photo.png",raw))
        self.assertIsNone(self.archive.get(self.other,self.ident))
        with store.db() as connection:
            metadata=connection.execute(
                "SELECT filename FROM archived_attachments WHERE id=?",
                (self.ident,)
            ).fetchone()[0]
        self.assertNotIn(b"photo.png",metadata)

    def test_expired_remote_object_deleted_and_no_longer_downloadable(self):
        self.archive.put(self.uid,self.ident,"x.bin",b"abc")
        with store.db() as connection:
            connection.execute(
                "UPDATE archived_attachments SET expires=? WHERE id=?",
                (int(time.time())-1,self.ident))
        self.assertIsNone(self.archive.get(self.uid,self.ident))
        self.assertEqual(self.archive.expire(),1)
        self.assertEqual(self.dav.objects,{})
        self.assertIsNone(self.archive.get(self.uid,self.ident))

    def test_absent_configuration_disables_archive(self):
        with patch.dict(os.environ,{"WTOX_WEBDAV_URL":""}):
            archive=WebDavArchive()
        self.assertFalse(archive.enabled)
        self.assertIsNone(archive.get(self.uid,self.ident))

    def test_reject_non_https_and_embedded_credentials(self):
        for value in ("http://dav.example.test/folder",
                      "https://user:pw@dav.example.test/folder",
                      "https://dav.example.test/folder?token=abc"):
            with self.subTest(uri=value):
                with patch.dict(os.environ,{"WTOX_WEBDAV_URL":value}):
                    with self.assertRaises(ValueError):
                        WebDavArchive()

    def test_limit_enforced_before_upload(self):
        with self.assertRaises(ValueError):
            self.archive.put(self.uid,self.ident,"x.bin",b"x"*(5*1024*1024+1))
        self.assertFalse(self.dav.requests)


if __name__=="__main__":
    unittest.main()
