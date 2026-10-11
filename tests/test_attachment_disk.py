"""Encrypted local disk attachment storage and 7-day expiry tests."""
import os
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from backend import store
from backend.attachment_disk import DiskAttachmentStore, BLOCK, MAX_FILE, TTL


class DiskAttachmentTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.environment=patch.dict(os.environ,{
            "WTOX_DATA_DIR":self.tmp.name,"WTOX_MASTER_KEY":"cd"*32,
        })
        self.environment.start()
        store.init()
        self.uid=store.create_tox_identity(SimpleNamespace(
            address="A"*76,secret_proof=b"a"*32,savedata=b"identity-a"))
        self.other=store.create_tox_identity(SimpleNamespace(
            address="B"*76,secret_proof=b"b"*32,savedata=b"identity-b"))
        self.disk=DiskAttachmentStore()

    def tearDown(self):
        self.environment.stop()
        self.tmp.cleanup()

    def test_encrypted_chunks_random_access_and_restart(self):
        content=(b"private-attachment-payload"*9000)[:BLOCK*2+337]
        writer=self.disk.begin(self.uid,"photo.png",expected=len(content),
                               direction="incoming")
        for index in range(0,len(content),531):
            writer.write(content[index:index+531])
        writer.finish()
        self.assertTrue(writer.complete)
        filenames=list(writer.folder.glob("*.bin"))
        self.assertEqual(len(filenames),3)
        for path in filenames:
            self.assertNotIn(b"private-attachment",path.read_bytes())
        with store.db() as db:
            encoded=db.execute("SELECT filename FROM disk_attachments WHERE id=?",
                               (writer.id,)).fetchone()[0]
        self.assertNotIn(b"photo.png",encoded)
        self.assertEqual(writer.read(BLOCK-20,48),content[BLOCK-20:BLOCK+28])
        fresh=DiskAttachmentStore()
        name,size,chunks=fresh.download(self.uid,writer.id)
        self.assertEqual(name,"photo.png")
        self.assertEqual(size,len(content))
        self.assertEqual(b"".join(chunks),content)
        with self.assertRaises(ValueError):
            fresh.download(self.other,writer.id)

    def test_persistent_inbox_scoped_to_identity_and_expiry(self):
        peer="CD"*32
        incoming=self.disk.begin(self.uid,"背景图.png",expected=3,
                                 direction="incoming",public_key=peer)
        incoming.write(b"hey")
        incoming.finish()
        disk_after_restart=DiskAttachmentStore()
        received=disk_after_restart.list_received(self.uid)
        self.assertEqual(len(received),1)
        self.assertEqual(received[0]["public_key"],peer)
        self.assertEqual(received[0]["created"],incoming.created)
        self.assertEqual(received[0]["name"],"背景图.png")
        self.assertEqual(disk_after_restart.list_received(self.other),[])
        with store.db() as db:
            stored_key=db.execute("SELECT public_key FROM disk_attachments WHERE id=?",
                                  (incoming.id,)).fetchone()[0]
        self.assertNotIn(peer.encode("ascii"),stored_key)
        with store.db() as db:
            db.execute("UPDATE disk_attachments SET expires=? WHERE id=?",
                       (int(time.time())-1,incoming.id))
        self.assertEqual(disk_after_restart.list_received(self.uid),[])

    def test_expiry_rejects_before_hourly_cleanup(self):
        writer=self.disk.begin(self.uid,"expired.txt",expected=3)
        writer.write(b"abc")
        writer.finish()
        with store.db() as db:
            db.execute("UPDATE disk_attachments SET expires=? WHERE id=?",
                       (int(time.time())-1,writer.id))
        with self.assertRaises(ValueError):
            self.disk.download(self.uid,writer.id)
        self.assertEqual(self.disk.expire(),1)
        self.assertFalse(writer.folder.exists())
        with store.db() as db:
            self.assertIsNone(db.execute(
                "SELECT 1 FROM disk_attachments WHERE id=?",(writer.id,)).fetchone())

    def test_incomplete_disk_spool_is_private_and_aborted(self):
        writer=self.disk.begin(self.uid,"incoming.dat",expected=BLOCK+5)
        writer.write(b"x"*BLOCK)
        self.assertEqual(len(list(writer.folder.glob("*.bin"))),1)
        with self.assertRaises(ValueError):
            writer.finish()
        with self.assertRaises(ValueError):
            self.disk.download(self.uid,writer.id)
        writer.abort()
        self.assertFalse(writer.folder.exists())

    def test_upload_bounds_and_complete_only_download(self):
        writer=self.disk.begin(self.uid,"out.bin",direction="outgoing")
        with self.assertRaises(ValueError):
            writer.write(b"x"*(MAX_FILE+1))
        writer.write(b"abc")
        writer.finish()
        with self.assertRaises(ValueError):
            self.disk.download(self.uid,writer.id)
        with self.assertRaises(ValueError):
            writer.read(2,2)

    def test_account_disk_quota(self):
        writer=self.disk.begin(self.uid,"small.bin",expected=4)
        writer.write(b"1234")
        writer.finish()
        with patch("backend.attachment_disk.MAX_ACCOUNT_BYTES",6):
            with self.assertRaisesRegex(ValueError,"容量上限"):
                self.disk.begin(self.uid,"next.bin",expected=3)

    def test_abandoned_upload_cleaned_after_seven_days(self):
        writer=self.disk.begin(self.uid,"abandoned.bin")
        writer.write(b"hello")
        old=time.time()-TTL-60
        os.utime(writer.folder,(old,old))
        self.disk.expire()
        self.assertFalse(writer.folder.exists())


if __name__=="__main__":
    unittest.main()
