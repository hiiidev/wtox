"""Authenticated disk-backed file API: bounded upload and identity-scoped download."""
import os
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend import store, profile_api
from backend.attachment_disk import DiskAttachmentStore
from backend.main import app
from backend.session_manager import manager


class DiskAttachmentAPITests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.env=patch.dict(os.environ,{
            "WTOX_DATA_DIR":self.tmp.name,
            "WTOX_MASTER_KEY":"ef"*32,
            "WTOX_ACCESS_PASSWORD":"123456",
            "WTOX_INSECURE_HTTP":"1"
        })
        self.env.start()
        store.init()
        self.uid=store.create_tox_identity(SimpleNamespace(
            address="A"*76,secret_proof=b"a"*32,savedata=b"native-a"))
        self.other=store.create_tox_identity(SimpleNamespace(
            address="B"*76,secret_proof=b"b"*32,savedata=b"native-b"))
        self.disk=DiskAttachmentStore()
        self.previous=manager.disk
        manager.disk=self.disk
        self.client=TestClient(app)
        self.assertEqual(self.client.post("/api/gate/login",
            json={"password":"123456"}).status_code,200)
        self.client.cookies.set(profile_api.COOKIE_NAME,
                                store.create_tox_session(self.uid))

    def tearDown(self):
        self.client.close()
        manager.disk=self.previous
        self.env.stop()
        self.tmp.cleanup()

    def test_download_identity_scope_and_expired_archive(self):
        doc=self.disk.begin(self.uid,"report.txt",expected=8)
        doc.write(b"secure!!")
        doc.finish()
        url="/api/files/"+doc.id+"/download"
        response=self.client.get(url)
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(response.content,b"secure!!")
        self.assertIn("report.txt",response.headers["content-disposition"])
        self.client.cookies.set(profile_api.COOKIE_NAME,
                                store.create_tox_session(self.other))
        self.assertEqual(self.client.get(url).status_code,404)
        self.client.cookies.set(profile_api.COOKIE_NAME,
                                store.create_tox_session(self.uid))
        with store.db() as db:
            db.execute("UPDATE disk_attachments SET expires=? WHERE id=?",
                       (int(time.time())-1,doc.id))
        self.assertEqual(self.client.get(url).status_code,404)

    def test_upload_written_encrypted_before_native_send(self):
        def send(peer,name,document):
            self.assertTrue(document.complete)
            self.assertEqual(document.read(0,document.size),b"payload")
            self.assertEqual(name,"name.txt")
            self.assertEqual(peer,"A"*64)
            return {"id":document.id,"state":"waiting"}
        fake=SimpleNamespace(files=SimpleNamespace(send=send))
        with patch("backend.tox_api.session",return_value=fake):
            response=self.client.post(
                "/api/files/send?peer="+("A"*64)+"&name=name.txt",
                content=b"payload",headers={"Content-Type":"application/octet-stream"})
        self.assertEqual(response.status_code,200,response.text)
        ident=response.json()["id"]
        path=self.disk.folder(self.uid,ident)/"00000000.bin"
        self.assertTrue(path.exists())
        self.assertNotIn(b"payload",path.read_bytes())

    def test_native_send_error_discards_uploaded_disk_file(self):
        def send(*_):
            raise ValueError("好友离线")
        fake=SimpleNamespace(files=SimpleNamespace(send=send))
        with patch("backend.tox_api.session",return_value=fake):
            response=self.client.post(
                "/api/files/send?peer="+("A"*64)+"&name=name.txt",
                content=b"payload")
        self.assertEqual(response.status_code,409,response.text)
        with store.db() as db:
            self.assertEqual(db.execute(
                "SELECT COUNT(*) FROM disk_attachments").fetchone()[0],0)
        self.assertEqual(list((self.disk.root/self.uid).iterdir()),[])


if __name__=="__main__":
    unittest.main()
