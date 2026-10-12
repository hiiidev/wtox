"""Permanent per-identity server-data purge and native session teardown."""
import asyncio
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from backend import store, web_push
from backend.attachment_disk import DiskAttachmentStore
from backend.session_manager import SessionManager


class IdentityDeletionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {
            "WTOX_DATA_DIR": self.tmp.name,
            "WTOX_MASTER_KEY": "a7" * 32,
        })
        self.env.start()
        store.init()
        web_push.init()
        self.own = store.create_tox_identity(SimpleNamespace(
            address="A" * 76, secret_proof=b"a" * 32, savedata=b"test-own"
        ))
        self.other = store.create_tox_identity(SimpleNamespace(
            address="B" * 76, secret_proof=b"b" * 32, savedata=b"test-other"
        ))
        for uid in (self.own, self.other):
            with store.db() as c:
                c.execute("INSERT INTO tox_sessions VALUES(?,?,?)",
                          ("auth-" + uid, uid, 10000000000))
                c.execute("INSERT INTO sessions VALUES(?,?,?)",
                          ("old-" + uid, uid, 10000000000))
                c.execute("INSERT INTO pending VALUES(?,?,?,?)",
                          ("pending-" + uid, uid, store.encrypt(b"message"), 1))
                c.execute("INSERT INTO outbox"
                          "(id,account_id,peer,data,status,created,updated)"
                          " VALUES(?,?,?,?,?,?,?)",
                          ("outbox-" + uid, uid, "B" * 64,
                           store.encrypt(b"queued"), "queued", 1, 1))
                c.execute("INSERT INTO archived_attachments VALUES(?,?,?,?,?,?)",
                          ("archive-" + uid, uid, store.encrypt(b"archived"), 2, 1, 100))
                c.execute("INSERT INTO disk_attachments"
                          "(id,account_id,filename,size,created,expires,direction)"
                          " VALUES(?,?,?,?,?,?,?)",
                          ("disk-" + uid, uid, store.encrypt(b"photo.jpg"),
                           5, 1, 100, "incoming"))
                c.execute("INSERT INTO friend_addresses VALUES(?,?,?)",
                          (uid, "C" * 64, store.encrypt(b"C" * 76)))
                c.execute("INSERT INTO push_subscriptions VALUES(?,?,?)",
                          (uid, "https://web.push.apple.com/" + uid,
                           store.encrypt(b"subscription")))
        self.disk = DiskAttachmentStore()
        for uid in (self.own, self.other):
            folder = self.disk.root / uid / ("d" * 32)
            folder.mkdir(parents=True)
            (folder / "00000000.bin").write_bytes(b"encrypted-file-data")

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def test_scoped_permanent_purge_leaves_other_identity_intact(self):
        closed = []
        class FakeSession:
            def close(self):
                closed.append(self)
        class FakeSocket:
            def __init__(self):
                self.closed = False
            async def close(self, code):
                self.closed = True
                self.code = code

        manager = SessionManager()
        manager.disk = self.disk
        fake = FakeSession()
        socket = FakeSocket()
        manager.sessions[self.own] = fake
        manager.sockets[self.own] = {socket}
        asyncio.run(manager.remove_account(self.own))
        self.assertEqual(closed, [fake])
        self.assertTrue(socket.closed)
        self.assertEqual(socket.code, 1008)
        self.assertNotIn(self.own, manager.sessions)
        self.assertFalse((self.disk.root / self.own).exists())
        self.assertTrue((self.disk.root / self.other).exists())
        self.assertIsNone(store.read_profile(self.own))
        self.assertEqual(store.read_profile(self.other), b"test-other")
        for table in ("tox_sessions", "sessions", "pending", "outbox",
                      "archived_attachments", "disk_attachments",
                      "friend_addresses", "push_subscriptions"):
            with self.subTest(table=table):
                with store.db() as c:
                    own = c.execute(f"SELECT COUNT(*) FROM {table} WHERE account_id=?",
                                    (self.own,)).fetchone()[0]
                    other = c.execute(f"SELECT COUNT(*) FROM {table} WHERE account_id=?",
                                      (self.other,)).fetchone()[0]
                self.assertEqual(own, 0)
                self.assertEqual(other, 1)

    def test_native_shutdown_failure_keeps_persistent_identity(self):
        class BrokenSession:
            def close(self):
                raise RuntimeError("Tox thread could not stop")
        manager = SessionManager()
        manager.sessions[self.own] = BrokenSession()
        manager.disk = self.disk
        with self.assertRaisesRegex(RuntimeError, "could not stop"):
            manager._remove_account_sync(self.own)
        self.assertEqual(store.read_profile(self.own), b"test-own")
        self.assertTrue((self.disk.root / self.own).exists())

    def test_rejects_untrusted_account_id_without_deleting_files(self):
        with self.assertRaises(ValueError):
            store.delete_tox_identity("../other")
        with self.assertRaises(ValueError):
            self.disk.remove_account("../other")
        self.assertEqual(store.read_profile(self.own), b"test-own")
        self.assertTrue((self.disk.root / self.other).exists())


if __name__ == "__main__":
    unittest.main()
